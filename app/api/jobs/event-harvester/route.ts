import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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

function normalizeTitle(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function eventFingerprint(input: {
  venueId: string;
  title: string;
  startsAt: string;
}) {
  return createHash("sha256")
    .update(
      [
        input.venueId,
        normalizeTitle(input.title),
        input.startsAt,
      ].join("|")
    )
    .digest("hex");
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
