import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  eventFingerprint,
  normalizeTitle,
} from "@/lib/event-harvester/identity";
import { ingestFirstPartySource } from "@/lib/event-harvester/first-party/ingest";

type TicketmasterVenueRef = {
  venue_id: string;
  provider_place_id: string;
  metadata: Record<string, unknown> | null;
  venues:
    | {
        id: string;
        name: string;
        street_address: string | null;
        city: string;
        state_region: string;
        postal_code: string | null;
        status: string;
      }
    | null;
};

type TicketmasterEvent = {
  id?: string;
  name?: string;
  url?: string;
  info?: string;
  pleaseNote?: string;
  dates?: {
    start?: {
      localDate?: string;
      localTime?: string;
      dateTime?: string;
      dateTBD?: boolean;
      dateTBA?: boolean;
      timeTBA?: boolean;
      noSpecificTime?: boolean;
    };
    end?: {
      localDate?: string;
      localTime?: string;
      dateTime?: string;
    };
    timezone?: string;
    status?: {
      code?: string;
    };
  };
  _embedded?: {
    venues?: Array<{
      id?: string;
      name?: string;
      address?: {
        line1?: string;
      };
      city?: {
        name?: string;
      };
      state?: {
        stateCode?: string;
      };
      postalCode?: string;
      timezone?: string;
    }>;
  };
};

type TicketmasterResponse = {
  _embedded?: {
    events?: TicketmasterEvent[];
  };
  page?: {
    size?: number;
    totalElements?: number;
    totalPages?: number;
    number?: number;
  };
};

type TicketmasterVenue = {
  id?: string;
  name?: string;
  address?: {
    line1?: string;
  };
  city?: {
    name?: string;
  };
  state?: {
    name?: string;
    stateCode?: string;
  };
  postalCode?: string;
  location?: {
    latitude?: string;
    longitude?: string;
  };
};

type TicketmasterVenueResponse = {
  _embedded?: {
    venues?: TicketmasterVenue[];
  };
  page?: {
    size?: number;
    totalElements?: number;
    totalPages?: number;
    number?: number;
  };
};

function normalizeMatchText(
  value: string | null | undefined
) {
  return (value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((token) => {
      const aliases: Record<string, string> = {
        street: "st",
        avenue: "ave",
        boulevard: "blvd",
        road: "rd",
        drive: "dr",
        lane: "ln",
        court: "ct",
        circle: "cir",
        highway: "hwy",
        parkway: "pkwy",
        place: "pl",
        terrace: "ter",
        trail: "trl",
        north: "n",
        south: "s",
        east: "e",
        west: "w",
        northeast: "ne",
        northwest: "nw",
        southeast: "se",
        southwest: "sw",
      };

      return aliases[token] ?? token;
    })
    .join(" ");
}

function normalizePostalCode(
  value: string | null | undefined
) {
  return (value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function tokenSimilarity(
  left: string | null | undefined,
  right: string | null | undefined
) {
  const a = new Set(
    normalizeMatchText(left)
      .split(" ")
      .filter(Boolean)
  );

  const b = new Set(
    normalizeMatchText(right)
      .split(" ")
      .filter(Boolean)
  );

  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let intersection = 0;

  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }

  const union = new Set([...a, ...b]).size;

  return union === 0
    ? 0
    : intersection / union;
}

function ticketmasterVenueMatch(input: {
  spot: {
    name: string;
    street_address: string | null;
    city: string;
    state_region: string;
    postal_code: string | null;
    latitude: number | null;
    longitude: number | null;
  };
  candidate: TicketmasterVenue;
}) {
  const candidate = input.candidate;

  const nameExact =
    normalizeMatchText(input.spot.name) !== "" &&
    normalizeMatchText(input.spot.name) ===
      normalizeMatchText(candidate.name);

  const nameSimilarity = tokenSimilarity(
    input.spot.name,
    candidate.name
  );

  const addressExact =
    normalizeMatchText(input.spot.street_address) !== "" &&
    normalizeMatchText(input.spot.street_address) ===
      normalizeMatchText(candidate.address?.line1);

  const cityExact =
    normalizeMatchText(input.spot.city) !== "" &&
    normalizeMatchText(input.spot.city) ===
      normalizeMatchText(candidate.city?.name);

  const stateExact =
    normalizeMatchText(input.spot.state_region) !== "" &&
    (
      normalizeMatchText(input.spot.state_region) ===
        normalizeMatchText(candidate.state?.stateCode) ||
      normalizeMatchText(input.spot.state_region) ===
        normalizeMatchText(candidate.state?.name)
    );

  const postalExact =
    normalizePostalCode(input.spot.postal_code) !== "" &&
    normalizePostalCode(input.spot.postal_code) ===
      normalizePostalCode(candidate.postalCode);

  /*
   * Identity evidence is intentionally conservative.
   *
   * Name is the strongest signal, but location evidence must
   * support it before we automatically attach an external ID.
   */
  let score = 0;

  score += nameExact
    ? 0.55
    : Math.min(nameSimilarity, 1) * 0.45;

  if (addressExact) score += 0.20;
  if (postalExact) score += 0.10;
  if (cityExact) score += 0.10;
  if (stateExact) score += 0.05;

  score = Math.min(1, Number(score.toFixed(4)));

  const autoAttach =
    score >= 0.9 &&
    (addressExact || postalExact) &&
    cityExact &&
    stateExact;

  const needsReview =
    !autoAttach &&
    score >= 0.65 &&
    nameSimilarity >= 0.5 &&
    cityExact &&
    stateExact;

  return {
    score,
    autoAttach,
    needsReview,
    evidence: {
      nameExact,
      nameSimilarity: Number(
        nameSimilarity.toFixed(4)
      ),
      addressExact,
      cityExact,
      stateExact,
      postalExact,
    },
  };
}

function getAdminClient() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const secret =
    process.env.SUPABASE_SECRET_KEY;

  if (!url || !secret) {
    throw new Error(
      "Server Supabase credentials are not configured."
    );
  }

  return createClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function safeError(error: unknown) {
  if (error instanceof Error) {
    return error.message.slice(0, 1000);
  }

  return "Unknown error.";
}

function ticketmasterFlyerUrl(event: any): string | null {
  const images = Array.isArray(event?.images)
    ? event.images
    : [];

  const usable = images.filter(
    (image: any) =>
      typeof image?.url === "string" &&
      image.url.trim().length > 0
  );

  if (usable.length === 0) return null;

  const score = (image: any) => {
    const nonFallbackBonus =
      image?.fallback === true ? 0 : 1_000_000_000;

    const ratioBonus =
      image?.ratio === "16_9" ? 100_000_000 : 0;

    const width =
      typeof image?.width === "number" ? image.width : 0;

    const height =
      typeof image?.height === "number" ? image.height : 0;

    return nonFallbackBonus + ratioBonus + width * height;
  };

  return [...usable]
    .sort((a: any, b: any) => score(b) - score(a))[0]
    ?.url?.trim() || null;
}

const TICKETMASTER_VENUE_REQUEST_DELAY_MS = 300;
const TICKETMASTER_VENUE_MAX_ATTEMPTS = 3;

function sleep(ms: number) {
  return new Promise<void>((resolve) =>
    setTimeout(resolve, ms)
  );
}

async function fetchTicketmasterVenueSearch(
  url: string
): Promise<Response | null> {
  for (
    let attempt = 1;
    attempt <= TICKETMASTER_VENUE_MAX_ATTEMPTS;
    attempt += 1
  ) {
    /*
     * Ticketmaster's default Discovery API rate limit is low enough
     * that an unrestricted Spot-matching loop can receive HTTP 429.
     * Keep venue discovery deliberately paced.
     */
    await sleep(
      TICKETMASTER_VENUE_REQUEST_DELAY_MS
    );

    const response = await fetch(url, {
      cache: "no-store",
    });

    if (response.ok) {
      return response;
    }

    if (response.status !== 429) {
      throw new Error(
        `Ticketmaster venue search failed: ${response.status}`
      );
    }

    if (
      attempt ===
      TICKETMASTER_VENUE_MAX_ATTEMPTS
    ) {
      return null;
    }

    const retryAfter =
      response.headers.get("retry-after");

    const retryAfterSeconds =
      retryAfter !== null
        ? Number(retryAfter)
        : NaN;

    const waitMs =
      Number.isFinite(retryAfterSeconds) &&
      retryAfterSeconds >= 0
        ? retryAfterSeconds * 1000
        : attempt * 1000;

    await sleep(waitMs);
  }

  return null;
}

export async function POST(
  request: NextRequest
) {
  const expectedSecret =
    process.env.EVENT_HARVESTER_JOB_SECRET;

  if (!expectedSecret) {
    return NextResponse.json(
      {
        error:
          "Event Harvester job secret is not configured.",
      },
      { status: 500 }
    );
  }

  const auth =
    request.headers.get("authorization");

  if (
    auth !==
    `Bearer ${expectedSecret}`
  ) {
    return NextResponse.json(
      { error: "Unauthorized." },
      { status: 401 }
    );
  }

  let dryRun = true;

  try {
    const body =
      await request.json().catch(() => ({}));

    if (
      body &&
      typeof body === "object" &&
      "dryRun" in body
    ) {
      dryRun = body.dryRun !== false;
    }

    const supabase = getAdminClient();

    const requestedSource =
      body &&
      typeof body === "object" &&
      "source" in body &&
      typeof body.source === "string"
        ? body.source.trim()
        : "ticketmaster";

    if (requestedSource === "first_party") {
      const sourceId =
        body &&
        typeof body === "object" &&
        "sourceId" in body &&
        typeof body.sourceId === "string"
          ? body.sourceId.trim()
          : "";

      if (!sourceId) {
        return NextResponse.json(
          {
            error:
              "sourceId is required for first-party ingestion.",
          },
          { status: 400 }
        );
      }

      const result = await ingestFirstPartySource(
        supabase,
        sourceId,
        { dryRun }
      );

      return NextResponse.json(result);
    }

    if (requestedSource !== "ticketmaster") {
      return NextResponse.json(
        { error: "Unsupported event harvest source." },
        { status: 400 }
      );
    }

    const ticketmasterKey =
      process.env.TICKETMASTER_API_KEY;

    if (!ticketmasterKey) {
      return NextResponse.json(
        {
          error:
            "Ticketmaster API key is not configured.",
        },
        { status: 500 }
      );
    }

    const requestedVenueId =
      body &&
      typeof body === "object" &&
      "venueId" in body &&
      typeof body.venueId === "string"
        ? body.venueId.trim()
        : "";

    /*
     * This first provider pass is deliberately read-only.
     * It only previews events for Ticketmaster identities
     * already attached to existing TenderFans Spots.
     */
    const { data: source, error: sourceError } =
      await supabase
        .from("event_harvest_sources")
        .select("id, provider, external_source_id, is_enabled")
        .eq("provider", "ticketmaster")
        .eq("external_source_id", "discovery-v2")
        .eq("is_enabled", true)
        .maybeSingle();

    if (sourceError) {
      throw new Error(
        `Could not load Ticketmaster harvest source: ${sourceError.message}`
      );
    }

    if (!source) {
      throw new Error(
        "Enabled Ticketmaster harvest source was not found."
      );
    }

    /*
     * VENUE MATCHER
     *
     * Spot-first discovery:
     *   existing active TenderFans Spot
     *   -> Ticketmaster venue search
     *   -> deterministic identity score
     *   -> auto-attach / Admin review / ignore
     *
     * This initial pass is observation-only. It does not write
     * mappings or review candidates yet.
     */
    let unmappedVenuesQuery = supabase
      .from("venues")
      .select(`
        id,
        name,
        street_address,
        city,
        state_region,
        postal_code,
        latitude,
        longitude
      `)
      .eq("status", "active");

    if (requestedVenueId) {
      unmappedVenuesQuery =
        unmappedVenuesQuery.eq(
          "id",
          requestedVenueId
        );
    }

    const {
      data: activeVenuesData,
      error: activeVenuesError,
    } = await unmappedVenuesQuery;

    if (activeVenuesError) {
      throw new Error(
        `Could not load active TenderFans Spots for venue matching: ${activeVenuesError.message}`
      );
    }

    const activeVenues =
      (activeVenuesData ?? []) as Array<{
        id: string;
        name: string;
        street_address: string | null;
        city: string;
        state_region: string;
        postal_code: string | null;
        latitude: number | null;
        longitude: number | null;
      }>;

    const activeVenueIds =
      activeVenues.map((venue) => venue.id);

    let mappedVenueIds = new Set<string>();

    if (activeVenueIds.length > 0) {
      const {
        data: mappedVenueData,
        error: mappedVenueError,
      } = await supabase
        .from("venue_external_refs")
        .select("venue_id")
        .eq("provider", "ticketmaster")
        .in("venue_id", activeVenueIds);

      if (mappedVenueError) {
        throw new Error(
          `Could not determine existing Ticketmaster venue mappings: ${mappedVenueError.message}`
        );
      }

      mappedVenueIds = new Set(
        (mappedVenueData ?? []).map(
          (row: { venue_id: string }) =>
            row.venue_id
        )
      );
    }

    const allUnmappedVenues =
      activeVenues.filter(
        (venue) =>
          !mappedVenueIds.has(venue.id)
      );

    /*
     * Venue discovery runs in bounded batches.
     *
     * Targeted venueId requests always check that Spot.
     * Normal runs prioritize never-scanned Spots, then the
     * least-recently scanned Spots.
     */
    let unmappedVenues = allUnmappedVenues;

    if (
      !requestedVenueId &&
      allUnmappedVenues.length > 0
    ) {
      const unmappedVenueIds =
        allUnmappedVenues.map(
          (venue) => venue.id
        );

      const {
        data: scanStateData,
        error: scanStateError,
      } = await supabase
        .from("event_harvest_venue_scan_state")
        .select(
          "venue_id,last_checked_at,last_result"
        )
        .eq("provider", "ticketmaster")
        .in("venue_id", unmappedVenueIds);

      if (scanStateError) {
        throw new Error(
          `Could not load venue matcher scan state: ${scanStateError.message}`
        );
      }

      const scanState = new Map<
        string,
        {
          last_checked_at: string;
          last_result: string;
        }
      >();

      for (const row of scanStateData ?? []) {
        scanState.set(row.venue_id, {
          last_checked_at:
            row.last_checked_at,
          last_result:
            row.last_result,
        });
      }

      unmappedVenues = [
        ...allUnmappedVenues,
      ]
        .sort((a, b) => {
          const aState =
            scanState.get(a.id);
          const bState =
            scanState.get(b.id);

          // Never scanned always comes first.
          if (!aState && bState) return -1;
          if (aState && !bState) return 1;

          // Stable ordering among never-scanned Spots.
          if (!aState && !bState) {
            return a.id.localeCompare(b.id);
          }

          // Oldest scan gets another turn first.
          const timeDifference =
            new Date(
              aState!.last_checked_at
            ).getTime() -
            new Date(
              bState!.last_checked_at
            ).getTime();

          if (timeDifference !== 0) {
            return timeDifference;
          }

          return a.id.localeCompare(b.id);
        })
        .slice(0, 20);
    }

    const venueMatchPreviews: Array<{
      tenderfansVenueId: string;
      tenderfansVenueName: string;
      result:
        | "auto_attach"
        | "needs_review"
        | "no_match";
      ticketmasterVenueId: string | null;
      ticketmasterVenueName: string | null;
      ticketmasterAddress: string | null;
      ticketmasterCity: string | null;
      ticketmasterState: string | null;
      ticketmasterPostalCode: string | null;
      confidenceScore: number | null;
      evidence: Record<string, unknown> | null;
    }> = [];

    for (const venue of unmappedVenues) {
      const venueUrl = new URL(
        "https://app.ticketmaster.com/discovery/v2/venues.json"
      );

      venueUrl.searchParams.set(
        "apikey",
        ticketmasterKey
      );

      venueUrl.searchParams.set(
        "keyword",
        venue.name
      );

      venueUrl.searchParams.set(
        "countryCode",
        "US"
      );

      if (venue.state_region) {
        venueUrl.searchParams.set(
          "stateCode",
          venue.state_region
        );
      }

      venueUrl.searchParams.set("size", "20");

      const venueResponse =
        await fetchTicketmasterVenueSearch(
          venueUrl.toString()
        );

      /*
       * Exhausted 429 retries should not abort harvesting for every
       * other TenderFans Spot. Skip this Spot and continue.
       */
      if (!venueResponse) {
        if (!dryRun) {
          const { error: scanError } =
            await supabase.rpc(
              "record_event_harvest_venue_scan",
              {
                p_venue_id: venue.id,
                p_provider: "ticketmaster",
                p_result: "rate_limited",
                p_error:
                  "Ticketmaster venue search exhausted 429 retries",
              }
            );

          if (scanError) {
            throw new Error(
              `Could not record venue scan state for ${venue.name}: ${scanError.message}`
            );
          }
        }

        venueMatchPreviews.push({
          tenderfansVenueId: venue.id,
          tenderfansVenueName: venue.name,
          result: "no_match",
          ticketmasterVenueId: null,
          ticketmasterVenueName: null,
          ticketmasterAddress: null,
          ticketmasterCity: null,
          ticketmasterState: null,
          ticketmasterPostalCode: null,
          confidenceScore: null,
          evidence: {
            skipped: true,
            reason: "ticketmaster_rate_limited",
          },
        });

        continue;
      }

      const venuePayload =
        (await venueResponse.json()) as
          TicketmasterVenueResponse;

      const candidates =
        venuePayload._embedded?.venues ?? [];

      const scored = candidates
        .filter(
          (candidate) =>
            typeof candidate.id === "string" &&
            candidate.id.trim() !== "" &&
            typeof candidate.name === "string" &&
            candidate.name.trim() !== ""
        )
        .map((candidate) => ({
          candidate,
          match: ticketmasterVenueMatch({
            spot: venue,
            candidate,
          }),
        }))
        .sort(
          (a, b) =>
            b.match.score - a.match.score
        );

      const best = scored[0];
      let blockedByRejection = false;

      /*
       * Persist only credible venue matches.
       *
       * Weak matches remain observation-only. Pending/rejected state is
       * durable in event_harvest_venue_matches, and a prior human
       * rejection must never be reversed by the automated matcher.
       */
      if (
        !dryRun &&
        best &&
        (best.match.autoAttach ||
          best.match.needsReview) &&
        best.candidate.id
      ) {
        const providerPlaceId =
          best.candidate.id.trim();

        const {
          data: existingMatch,
          error: existingMatchError,
        } = await supabase
          .from("event_harvest_venue_matches")
          .select("id,status")
          .eq("venue_id", venue.id)
          .eq("provider", "ticketmaster")
          .eq(
            "provider_place_id",
            providerPlaceId
          )
          .maybeSingle();

        if (existingMatchError) {
          throw new Error(
            `Could not inspect existing venue match for ${venue.name}: ${existingMatchError.message}`
          );
        }

        const wasRejected =
          existingMatch?.status === "rejected";

        blockedByRejection = wasRejected;

        const {
          data: matchId,
          error: upsertMatchError,
        } = await supabase.rpc(
          "upsert_event_harvest_venue_match",
          {
            p_venue_id: venue.id,
            p_provider: "ticketmaster",
            p_provider_place_id:
              providerPlaceId,
            p_provider_venue_name:
              best.candidate.name ?? "",
            p_provider_address:
              best.candidate.address?.line1 ??
              null,
            p_provider_city:
              best.candidate.city?.name ?? null,
            p_provider_state_region:
              best.candidate.state?.stateCode ??
              best.candidate.state?.name ??
              null,
            p_provider_postal_code:
              best.candidate.postalCode ?? null,
            p_confidence_score:
              best.match.score,
            p_evidence:
              best.match.evidence,
            p_raw_payload:
              best.candidate,
          }
        );

        if (upsertMatchError) {
          throw new Error(
            `Could not persist venue match for ${venue.name}: ${upsertMatchError.message}`
          );
        }

        if (
          best.match.autoAttach &&
          !wasRejected
        ) {
          const {
            error: approveMatchError,
          } = await supabase.rpc(
            "auto_approve_event_harvest_venue_match",
            {
              p_match_id: matchId,
            }
          );

          if (approveMatchError) {
            throw new Error(
              `Could not auto-approve Ticketmaster venue match for ${venue.name}: ${approveMatchError.message}`
            );
          }
        }
      }

      if (!best || best.match.score < 0.65) {
        if (!dryRun) {
          const { error: scanError } =
            await supabase.rpc(
              "record_event_harvest_venue_scan",
              {
                p_venue_id: venue.id,
                p_provider: "ticketmaster",
                p_result: "no_match",
                p_error: null,
              }
            );

          if (scanError) {
            throw new Error(
              `Could not record venue scan state for ${venue.name}: ${scanError.message}`
            );
          }
        }

        venueMatchPreviews.push({
          tenderfansVenueId: venue.id,
          tenderfansVenueName: venue.name,
          result: "no_match",
          ticketmasterVenueId:
            best?.candidate.id ?? null,
          ticketmasterVenueName:
            best?.candidate.name ?? null,
          ticketmasterAddress:
            best?.candidate.address?.line1 ?? null,
          ticketmasterCity:
            best?.candidate.city?.name ?? null,
          ticketmasterState:
            best?.candidate.state?.stateCode ??
            best?.candidate.state?.name ??
            null,
          ticketmasterPostalCode:
            best?.candidate.postalCode ?? null,
          confidenceScore:
            best?.match.score ?? null,
          evidence:
            best?.match.evidence ?? null,
        });

        continue;
      }

      const finalMatchResult =
        best.match.autoAttach &&
        !blockedByRejection
          ? "auto_attach"
          : best.match.needsReview ||
              blockedByRejection
            ? "needs_review"
            : "no_match";

      if (!dryRun) {
        const scanResult =
          finalMatchResult === "auto_attach"
            ? "auto_attached"
            : finalMatchResult === "needs_review"
              ? "needs_review"
              : "no_match";

        const { error: scanError } =
          await supabase.rpc(
            "record_event_harvest_venue_scan",
            {
              p_venue_id: venue.id,
              p_provider: "ticketmaster",
              p_result: scanResult,
              p_error: null,
            }
          );

        if (scanError) {
          throw new Error(
            `Could not record venue scan state for ${venue.name}: ${scanError.message}`
          );
        }
      }

      venueMatchPreviews.push({
        tenderfansVenueId: venue.id,
        tenderfansVenueName: venue.name,
        result: finalMatchResult,
        ticketmasterVenueId:
          best.candidate.id ?? null,
        ticketmasterVenueName:
          best.candidate.name ?? null,
        ticketmasterAddress:
          best.candidate.address?.line1 ?? null,
        ticketmasterCity:
          best.candidate.city?.name ?? null,
        ticketmasterState:
          best.candidate.state?.stateCode ??
          best.candidate.state?.name ??
          null,
        ticketmasterPostalCode:
          best.candidate.postalCode ?? null,
        confidenceScore: best.match.score,
        evidence: best.match.evidence,
      });
    }

    let refsQuery = supabase
      .from("venue_external_refs")
      .select(`
        venue_id,
        provider_place_id,
        metadata,
        venues!inner (
          id,
          name,
          street_address,
          city,
          state_region,
          postal_code,
          status
        )
      `)
      .eq("provider", "ticketmaster")
      .eq("venues.status", "active");

    if (requestedVenueId) {
      refsQuery = refsQuery.eq(
        "venue_id",
        requestedVenueId
      );
    }

    const { data: refsData, error: refsError } =
      await refsQuery;

    if (refsError) {
      throw new Error(
        `Could not load Ticketmaster venue mappings: ${refsError.message}`
      );
    }

    const refs =
      (refsData ?? []) as unknown as TicketmasterVenueRef[];

    const spotMap = new Map<
      string,
      {
        venue: NonNullable<TicketmasterVenueRef["venues"]>;
        ticketmasterVenueIds: string[];
      }
    >();

    for (const ref of refs) {
      if (!ref.venues) continue;

      const existing = spotMap.get(ref.venue_id);

      if (existing) {
        existing.ticketmasterVenueIds.push(
          ref.provider_place_id
        );
      } else {
        spotMap.set(ref.venue_id, {
          venue: ref.venues,
          ticketmasterVenueIds: [
            ref.provider_place_id,
          ],
        });
      }
    }

    const previews: Array<{
      tenderfansVenueId: string;
      tenderfansVenueName: string;
      ticketmasterVenueIds: string[];
      events: Array<{
        externalEventId: string;
        title: string;
        startsAt: string | null;
        sourceUrl: string | null;
        ticketmasterVenueId: string | null;
        ticketmasterVenueName: string | null;
        ticketmasterStatus: string | null;
        hasDefiniteStart: boolean;
        fingerprint: string | null;
        candidateId: string | null;
        canonicalEventId: string | null;
      }>;
    }> = [];

    /*
     * Ticketmaster events returned by venue discovery have already
     * been observed from the provider during this run. Pass 2 only
     * needs direct event-ID verification for known events that were
     * not returned by discovery.
     */
    const seenTicketmasterEventIds =
      new Set<string>();

    for (const [
      tenderfansVenueId,
      mapped,
    ] of spotMap) {
      const venueIds = [
        ...new Set(mapped.ticketmasterVenueIds),
      ];

      const url = new URL(
        "https://app.ticketmaster.com/discovery/v2/events.json"
      );

      url.searchParams.set(
        "apikey",
        ticketmasterKey
      );
      url.searchParams.set(
        "venueId",
        venueIds.join(",")
      );
      url.searchParams.set("size", "200");
      url.searchParams.set(
        "sort",
        "date,asc"
      );

      const events: TicketmasterEvent[] = [];
      const maxPages = 25;
      let pageNumber = 0;

      while (pageNumber < maxPages) {
        url.searchParams.set(
          "page",
          String(pageNumber)
        );

        const response = await fetch(url, {
          headers: {
            accept: "application/json",
          },
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(
            `Ticketmaster returned HTTP ${response.status} for ${mapped.venue.name} on page ${pageNumber}.`
          );
        }

        const payload =
          (await response.json()) as TicketmasterResponse;

        events.push(
          ...(payload._embedded?.events ?? [])
        );

        const totalPages =
          payload.page?.totalPages ?? 1;

        pageNumber += 1;

        if (pageNumber >= totalPages) {
          break;
        }
      }

      const deduped = new Map<
        string,
        {
          externalEventId: string;
          title: string;
          startsAt: string | null;
          sourceUrl: string | null;
          ticketmasterVenueId: string | null;
          ticketmasterVenueName: string | null;
          ticketmasterStatus: string | null;
          hasDefiniteStart: boolean;
          fingerprint: string | null;
          candidateId: string | null;
          canonicalEventId: string | null;
        }
      >();

      for (const event of events) {
        const externalEventId =
          event.id?.trim();
        const title = event.name?.trim();

        if (!externalEventId || !title) {
          continue;
        }

        const start = event.dates?.start;
        const startsAt =
          start?.dateTime?.trim() || null;

        const ticketmasterStatus =
          event.dates?.status?.code
            ?.trim()
            .toLowerCase() || null;

        const hasDefiniteStart =
          Boolean(startsAt) &&
          start?.dateTBD !== true &&
          start?.dateTBA !== true &&
          start?.timeTBA !== true &&
          start?.noSpecificTime !== true;

        /*
         * Spot-first safety check: explicitly find a returned
         * Ticketmaster venue whose provider identity is mapped
         * to this TenderFans Spot. Do not assume the first
         * embedded venue is necessarily the relevant one.
         */
        const tmVenue =
          event._embedded?.venues?.find(
            (venue) => {
              const id = venue.id?.trim();
              return (
                id !== undefined &&
                venueIds.includes(id)
              );
            }
          );

        const tmVenueId =
          tmVenue?.id?.trim() || null;

        if (!tmVenueId) {
          continue;
        }

        if (deduped.has(externalEventId)) {
          continue;
        }

        seenTicketmasterEventIds.add(
          externalEventId
        );

        const sourceUrl =
          event.url?.trim() || null;

        const rawAddress = [
          tmVenue?.address?.line1,
          tmVenue?.city?.name,
          tmVenue?.state?.stateCode,
          tmVenue?.postalCode,
        ]
          .filter(Boolean)
          .join(", ");

        const fingerprint =
          hasDefiniteStart && startsAt
            ? eventFingerprint({
                venueId: tenderfansVenueId,
                title,
                startsAt,
              })
            : null;

        let candidateId: string | null = null;
        let canonicalEventId: string | null = null;

        /*
         * Lifecycle authority requires us to recognize an existing
         * Ticketmaster event even when Ticketmaster temporarily
         * removes its definite start time.
         */
        const {
          data: existingCandidate,
          error: existingCandidateError,
        } = await supabase
          .from("event_harvest_candidates")
          .select("id, canonical_event_id")
          .eq("source_id", source.id)
          .eq("external_event_id", externalEventId)
          .maybeSingle();

        if (existingCandidateError) {
          throw new Error(
            `Could not inspect harvest candidate ${externalEventId}: ${existingCandidateError.message}`
          );
        }

        candidateId =
          existingCandidate?.id ?? null;

        canonicalEventId =
          existingCandidate?.canonical_event_id ?? null;

        if (!dryRun) {
          /*
           * Existing canonical Ticketmaster events always follow
           * Ticketmaster lifecycle authority, including cancellation,
           * postponement/TBA and rescheduling.
           */
          if (candidateId && canonicalEventId) {
            const {
              data: syncedEventId,
              error: syncError,
            } = await supabase.rpc(
              "sync_ticketmaster_event",
              {
                p_candidate_id: candidateId,
                p_source_url: sourceUrl,
                p_raw_title: title,
                p_raw_venue_name:
                  tmVenue?.name?.trim() || null,
                p_raw_address:
                  rawAddress || null,
                p_raw_starts_at:
                  startsAt,
                p_raw_ends_at:
                  event.dates?.end?.dateTime ??
                  null,
                p_normalized_title:
                  normalizeTitle(title),
                p_starts_at:
                  hasDefiniteStart
                    ? startsAt
                    : null,
                p_ends_at:
                  hasDefiniteStart
                    ? event.dates?.end?.dateTime ??
                      null
                    : null,
                p_event_fingerprint:
                  fingerprint,
                p_ticketmaster_status:
                  ticketmasterStatus,
                p_has_definite_start:
                  hasDefiniteStart,
                p_flyer_url: ticketmasterFlyerUrl(event),
                p_raw_payload: event,
              }
            );

            if (syncError) {
              throw new Error(
                `Could not sync Ticketmaster event ${externalEventId}: ${syncError.message}`
              );
            }

            canonicalEventId =
              typeof syncedEventId === "string"
                ? syncedEventId
                : canonicalEventId;
          } else if (
            hasDefiniteStart &&
            startsAt &&
            ticketmasterStatus !== "cancelled"
          ) {
            /*
             * A brand-new event must have a definite Ticketmaster
             * start instant before TenderFans will create it.
             */
            const { data, error } =
              await supabase.rpc(
                "upsert_event_harvest_candidate",
                {
                  p_source_id: source.id,
                  p_external_event_id:
                    externalEventId,
                  p_source_url:
                    sourceUrl,
                  p_raw_title: title,
                  p_raw_venue_name:
                    tmVenue?.name?.trim() || null,
                  p_raw_address:
                    rawAddress || null,
                  p_raw_description: null,
                  p_raw_starts_at:
                    startsAt,
                  p_raw_ends_at:
                    event.dates?.end?.dateTime ??
                    null,
                  p_normalized_title:
                    normalizeTitle(title),
                  p_starts_at:
                    startsAt,
                  p_ends_at:
                    event.dates?.end?.dateTime ??
                    null,
                  p_venue_id:
                    tenderfansVenueId,
                  p_confidence_score: 1,
                  p_event_fingerprint:
                    fingerprint,
                  p_raw_payload: event,
                }
              );

            if (error) {
              throw new Error(
                `Could not upsert harvest candidate ${externalEventId}: ${error.message}`
              );
            }

            candidateId =
              typeof data === "string"
                ? data
                : null;

            if (candidateId) {
              const {
                data: graduatedEventId,
                error: graduateError,
              } = await supabase.rpc(
                "graduate_harvest_candidate",
                {
                  p_candidate_id: candidateId,
                  p_reviewed_by: null,
                }
              );

              if (graduateError) {
                throw new Error(
                  `Could not graduate harvest candidate ${candidateId}: ${graduateError.message}`
                );
              }

              canonicalEventId =
                typeof graduatedEventId === "string"
                  ? graduatedEventId
                  : null;

              /*
               * Run the authoritative sync once after initial
               * graduation as well. This keeps the same lifecycle
               * contract for first publication and later harvests.
               */
              if (canonicalEventId) {
                const {
                  error: initialSyncError,
                } = await supabase.rpc(
                  "sync_ticketmaster_event",
                  {
                    p_candidate_id: candidateId,
                    p_source_url: sourceUrl,
                    p_raw_title: title,
                    p_raw_venue_name:
                      tmVenue?.name?.trim() || null,
                    p_raw_address:
                      rawAddress || null,
                    p_raw_starts_at:
                      startsAt,
                    p_raw_ends_at:
                      event.dates?.end?.dateTime ??
                      null,
                    p_normalized_title:
                      normalizeTitle(title),
                    p_starts_at:
                      startsAt,
                    p_ends_at:
                      event.dates?.end?.dateTime ??
                      null,
                    p_event_fingerprint:
                      fingerprint,
                    p_ticketmaster_status:
                      ticketmasterStatus,
                    p_has_definite_start: true,
                    p_flyer_url: ticketmasterFlyerUrl(event),
                    p_raw_payload: event,
                  }
                );

                if (initialSyncError) {
                  throw new Error(
                    `Could not initialize Ticketmaster lifecycle ${externalEventId}: ${initialSyncError.message}`
                  );
                }
              }
            }
          }
        }

        deduped.set(externalEventId, {
          externalEventId,
          title,
          startsAt,
          sourceUrl,
          ticketmasterVenueId: tmVenueId,
          ticketmasterVenueName:
            tmVenue?.name?.trim() || null,
          ticketmasterStatus,
          hasDefiniteStart,
          fingerprint,
          candidateId,
          canonicalEventId,
        });
      }

      previews.push({
        tenderfansVenueId,
        tenderfansVenueName:
          mapped.venue.name,
        ticketmasterVenueIds: venueIds,
        events: [...deduped.values()],
      });
    }

    /*
     * Pass 2 — lifecycle verification.
     *
     * Venue search discovers events. Once TenderFans has accepted a
     * Ticketmaster event, its Ticketmaster event ID becomes the
     * authoritative lifecycle lookup key. Verify those known events
     * directly rather than interpreting absence from venue search as
     * a cancellation or other state change.
     */
    const lifecycleResults: Array<{
      candidateId: string;
      canonicalEventId: string;
      externalEventId: string;
      tenderfansVenueId: string;
      ticketmasterStatus: string | null;
      hasDefiniteStart: boolean;
      startsAt: string | null;
      action: "verified" | "would_verify";
    }> = [];

    const scopedVenueIds = [...spotMap.keys()];

    if (scopedVenueIds.length > 0) {
      const {
        data: lifecycleCandidatesData,
        error: lifecycleCandidatesError,
      } = await supabase
        .from("event_harvest_candidates")
        .select(`
          id,
          canonical_event_id,
          external_event_id,
          venue_id,
          raw_title,
          event_fingerprint,
          status
        `)
        .eq("source_id", source.id)
        .in("venue_id", scopedVenueIds)
        .not("canonical_event_id", "is", null)
        .in("status", ["published", "stale"]);

      if (lifecycleCandidatesError) {
        throw new Error(
          `Could not load Ticketmaster lifecycle candidates: ${lifecycleCandidatesError.message}`
        );
      }

      for (const candidate of lifecycleCandidatesData ?? []) {
        const candidateId =
          typeof candidate.id === "string"
            ? candidate.id
            : null;

        const canonicalEventId =
          typeof candidate.canonical_event_id === "string"
            ? candidate.canonical_event_id
            : null;

        const externalEventId =
          typeof candidate.external_event_id === "string"
            ? candidate.external_event_id.trim()
            : "";

        const tenderfansVenueId =
          typeof candidate.venue_id === "string"
            ? candidate.venue_id
            : null;

        if (
          !candidateId ||
          !canonicalEventId ||
          !externalEventId ||
          !tenderfansVenueId
        ) {
          continue;
        }

        /*
         * Pass 1 already received current provider data for this
         * event, so do not immediately spend another Ticketmaster
         * request verifying the same ID.
         */
        if (
          seenTicketmasterEventIds.has(
            externalEventId
          )
        ) {
          continue;
        }

        const eventUrl = new URL(
          `https://app.ticketmaster.com/discovery/v2/events/${encodeURIComponent(
            externalEventId
          )}.json`
        );

        eventUrl.searchParams.set(
          "apikey",
          ticketmasterKey
        );

        const response = await fetch(eventUrl, {
          headers: {
            accept: "application/json",
          },
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(
            `Ticketmaster returned HTTP ${response.status} while verifying event ${externalEventId}.`
          );
        }

        const event =
          (await response.json()) as TicketmasterEvent;

        /*
         * The direct lookup must resolve to the same permanent
         * Ticketmaster event identity we requested.
         */
        if (event.id?.trim() !== externalEventId) {
          throw new Error(
            `Ticketmaster lifecycle identity mismatch for ${externalEventId}.`
          );
        }

        const start = event.dates?.start;
        const startsAt =
          start?.dateTime?.trim() || null;

        const ticketmasterStatus =
          event.dates?.status?.code
            ?.trim()
            .toLowerCase() || null;

        const hasDefiniteStart =
          Boolean(startsAt) &&
          start?.dateTBD !== true &&
          start?.dateTBA !== true &&
          start?.timeTBA !== true &&
          start?.noSpecificTime !== true;

        const title =
          event.name?.trim() ||
          (typeof candidate.raw_title === "string"
            ? candidate.raw_title.trim()
            : "");

        const tmVenue =
          event._embedded?.venues?.[0];

        const rawAddress = [
          tmVenue?.address?.line1,
          tmVenue?.city?.name,
          tmVenue?.state?.stateCode,
          tmVenue?.postalCode,
        ]
          .filter(Boolean)
          .join(", ");

        const fingerprint =
          hasDefiniteStart &&
          startsAt &&
          title
            ? eventFingerprint({
                venueId: tenderfansVenueId,
                title,
                startsAt,
              })
            : typeof candidate.event_fingerprint ===
                "string"
              ? candidate.event_fingerprint
              : null;

        if (!dryRun) {
          const {
            data: syncedEventId,
            error: syncError,
          } = await supabase.rpc(
            "sync_ticketmaster_event",
            {
              p_candidate_id: candidateId,
              p_source_url:
                event.url?.trim() || null,
              p_raw_title: title || null,
              p_raw_venue_name:
                tmVenue?.name?.trim() || null,
              p_raw_address:
                rawAddress || null,
              p_raw_starts_at: startsAt,
              p_raw_ends_at:
                event.dates?.end?.dateTime ??
                null,
              p_normalized_title:
                title
                  ? normalizeTitle(title)
                  : null,
              p_starts_at:
                hasDefiniteStart
                  ? startsAt
                  : null,
              p_ends_at:
                hasDefiniteStart
                  ? event.dates?.end?.dateTime ??
                    null
                  : null,
              p_event_fingerprint:
                fingerprint,
              p_ticketmaster_status:
                ticketmasterStatus,
              p_has_definite_start:
                hasDefiniteStart,
              p_flyer_url: ticketmasterFlyerUrl(event),
              p_raw_payload: event,
            }
          );

          if (syncError) {
            throw new Error(
              `Could not verify Ticketmaster event ${externalEventId}: ${syncError.message}`
            );
          }

          if (
            typeof syncedEventId === "string" &&
            syncedEventId !== canonicalEventId
          ) {
            throw new Error(
              `Ticketmaster lifecycle sync changed canonical identity for ${externalEventId}.`
            );
          }
        }

        lifecycleResults.push({
          candidateId,
          canonicalEventId,
          externalEventId,
          tenderfansVenueId,
          ticketmasterStatus,
          hasDefiniteStart,
          startsAt,
          action: dryRun
            ? "would_verify"
            : "verified",
        });
      }
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      provider: "ticketmaster",
      sourceId: source.id,
      venueMatcher: {
        spotsChecked: venueMatchPreviews.length,
        autoAttach: venueMatchPreviews.filter(
          (match) => match.result === "auto_attach"
        ).length,
        needsReview: venueMatchPreviews.filter(
          (match) => match.result === "needs_review"
        ).length,
        noMatch: venueMatchPreviews.filter(
          (match) => match.result === "no_match"
        ).length,
        matches: venueMatchPreviews,
      },
      spotsChecked: previews.length,
      eventsFound: previews.reduce(
        (sum, preview) =>
          sum + preview.events.length,
        0
      ),
      directLifecycleChecked:
        lifecycleResults.length,
      lifecycle: lifecycleResults,
      spots: previews,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: safeError(error),
      },
      { status: 500 }
    );
  }
}

/*
 * Vercel Cron entry point.
 *
 * Vercel invokes cron routes with GET and supplies CRON_SECRET as
 * Authorization: Bearer <CRON_SECRET>. After authenticating the cron
 * request, reuse the existing POST harvester so scheduled and manual
 * runs execute exactly the same harvesting logic.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return NextResponse.json(
      { error: "Cron is not configured." },
      { status: 500 }
    );
  }

  if (
    request.headers.get("authorization") !==
    `Bearer ${cronSecret}`
  ) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const scheduledRequest = new NextRequest(request.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${
        process.env.EVENT_HARVESTER_JOB_SECRET ?? ""
      }`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      dryRun: false,
      source: "ticketmaster",
    }),
  });

  return POST(scheduledRequest);
}
