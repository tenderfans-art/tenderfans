import { venueIdentityMatch } from "@/lib/event-harvester/venue-identity";
import { runWithTransportRecovery } from "@/lib/event-harvester/transport-recovery-context";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import {
  detectFirstPartySources,
  runWithPreferredFirstPartyProxy,
  fetchHtml,
} from "@/lib/event-harvester/first-party/source-detector";

import { ratifyDetectedSource } from "@/lib/event-harvester/first-party/ratify";

import {
  searchGoogleVenue,
  recordGoogleSpotDiscovery,
  resolveReviewedGoogleSpot,
  registerHarvestGoogleSpot,
} from "@/lib/event-harvester/google-places";

import { validateFirstPartySource } from "@/lib/event-harvester/first-party/validate";

import type { FirstPartySource } from "@/lib/event-harvester/first-party/preview";


/*
 * Calendar-page identity discovery.
 *
 * Only the page's own title/heading may identify a business.
 * Navigation, footer links and the containing corporate domain
 * are not evidence of calendar ownership.
 *
 * This returns a candidate identity for Google qualification;
 * it does not itself approve a Spot or a source.
 */
function calendarPageBusinessName(html: string): string | null {
  const decode = (value: string) =>
    value
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#(?:0*39|x27);/gi, "'")
      .replace(/&(?:#8217|rsquo);/gi, "’")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const title = html.match(
    /<title\b[^>]*>([\s\S]*?)<\/title>/i,
  );

  const heading = html.match(
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
  );

  const candidates = [title?.[1], heading?.[1]]
    .filter((value): value is string => Boolean(value))
    .map(decode);

  for (const candidate of candidates) {
    // Remove a site-title suffix without interpreting it as ownership.
    const pageTitle = candidate
      .split(/\s+[-|–—]\s+/)[0]
      .trim();

    // Only a business-qualified calendar title is eligible.
    const match = pageTitle.match(
      /^(.{4,120}?)\s+(?:live\s+music|entertainment\s+(?:calendar|schedule)|live\s+music\s+calendar|event\s+calendar|music\s+calendar)$/i,
    );

    if (!match) continue;

    const name = match[1].trim();

    if (
      name.length >= 5 &&
      !/^(?:home|events?|calendar|live music|entertainment)$/i.test(name)
    ) {
      return name;
    }
  }

  return null;
}

export const dynamic = "force-dynamic";

const SPOT_LIMIT = 30;

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;

  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url || !secret) {
    throw new Error("Server Supabase credentials are not configured.");
  }

  return createClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export async function GET(request: Request) {
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret) {
    return NextResponse.json(
      {
        error: "Cron secret is not configured.",
      },
      { status: 500 },
    );
  }

  const auth = request.headers.get("authorization");

  if (auth !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const supabase = getAdminClient();

  const requestUrl = new URL(request.url);

  const venueId = requestUrl.searchParams.get("venue_id");
  const recoveryMode =
    requestUrl.searchParams.get("mode") === "transport-recovery";
  const fullScanMode =
    requestUrl.searchParams.get("mode") === "full-scan";

  const recoveryIdsParam = requestUrl.searchParams.get("venue_ids");

  if ((recoveryMode || fullScanMode) && venueId) {
    return NextResponse.json(
      { error: "Batch modes cannot be combined with venue_id." },
      { status: 400 },
    );
  }

  if (recoveryIdsParam !== null && !recoveryMode) {
    return NextResponse.json(
      { error: "venue_ids is only supported in transport-recovery mode." },
      { status: 400 },
    );
  }

  let venueQuery = supabase
    .from("venues")
    .select(
      "id,name,website_url,street_address,city,state_region,postal_code,country_code,latitude,longitude",
    )
    .eq("status", "active")
    .not("website_url", "is", null);

  if (recoveryMode) {
    const { data: findings, error: findingsError } = await supabase
      .from("event_harvest_detector_findings")
      .select("venue_id")
      .in("category", [
        "calendar_image",
        "facebook",
        "browser_required",
        "challenge_encountered",
        "transport",
        "no_source",
        "html_error",
      ])
      .eq("status", "active")
      .is("resolved_at", null);

    if (findingsError) {
      return NextResponse.json(
        { error: findingsError.message },
        { status: 500 },
      );
    }

    const eligibleIds = new Set(
      (findings ?? []).map((finding) => finding.venue_id),
    );

    let venueIds = [...eligibleIds];

    if (recoveryIdsParam !== null) {
      const requestedIds = [
        ...new Set(
          recoveryIdsParam
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
        ),
      ];

      if (
        requestedIds.length === 0 ||
        requestedIds.length > SPOT_LIMIT ||
        requestedIds.some(
          (id) =>
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
        )
      ) {
        return NextResponse.json(
          { error: "Recovery requires 1–30 valid venue IDs." },
          { status: 400 },
        );
      }

      const ineligibleIds = requestedIds.filter(
        (id) => !eligibleIds.has(id),
      );

      if (ineligibleIds.length > 0) {
        return NextResponse.json(
          {
            error: "Some Spots are no longer in the unresolved detector recovery queue.",
            ineligibleIds,
          },
          { status: 409 },
        );
      }

      venueIds = requestedIds;
    }

    if (venueIds.length === 0) {
      return NextResponse.json({
        spots: 0,
        mode: "transport-recovery",
        message: "No unresolved transport recovery Spots.",
      });
    }

    venueQuery = venueQuery.in("id", venueIds);
  } else if (fullScanMode) {
    const offsetParam = requestUrl.searchParams.get("offset") ?? "0";
    const limitParam = requestUrl.searchParams.get("limit") ?? "30";

    if (!/^\d+$/.test(offsetParam) || !/^\d+$/.test(limitParam)) {
      return NextResponse.json(
        { error: "Full-scan offset and limit must be nonnegative integers." },
        { status: 400 },
      );
    }

    const offset = Number(offsetParam);
    const limit = Number(limitParam);

    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 30
    ) {
      return NextResponse.json(
        { error: "Invalid full-scan batch parameters (limit: 1–30)." },
        { status: 400 },
      );
    }

    venueQuery = venueQuery
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);
  } else if (venueId) {
    venueQuery = venueQuery.eq("id", venueId);
  } else {
    venueQuery = venueQuery
      .order("created_at", {
        ascending: false,
      })
      .limit(SPOT_LIMIT);
  }

  const { data: venues, error } = await venueQuery;

  if (error) {
    return NextResponse.json(
      {
        error: `Could not load Spots: ${error.message}`,
      },
      { status: 500 },
    );
  }

  let processedSpots = 0;
  let detected = 0;
  let ratified = 0;
  let validated = 0;
  let registered = 0;
  let unsupported = 0;
  let failed = 0;

  const bucketCounts = {
    validated: 0,
    calendar_image: 0,
    facebook: 0,
    browser_required: 0,
    html_error: 0,
    challenge_encountered: 0,
    transport: 0,
    no_source: 0,
  };

  const failures: Array<{
    venueId: string;
    name: string;
    stage: string;
    error: string;
  }> = [];

  for (const venue of venues ?? []) {
    if (!venue.website_url) {
      continue;
    }

    const processVenue = async () => {
    processedSpots += 1;

    try {
      let successfullyRegisteredVenueSource = false;


      let hasPersistedBrowserRequired = false;

      /*
       * Final bucket classification must account for venue-scoped
       * first-party sources established before the current detector run.
       *
       * Registration occurs only after source validation succeeds.
       * Harvest lifecycle fields such as last_success_at describe later
       * ingestion health and do not determine detector validation state.
       */
      const {
        data: previouslyValidatedSources,
        error: previouslyValidatedSourceError,
      } = await supabase
        .from("event_harvest_sources")
        .select("id,source_type,external_source_id,config")
        .eq("venue_id", venue.id)
        .eq("provider", "first_party")
        .eq("is_enabled", true);

      if (previouslyValidatedSourceError) {
        throw new Error(
          `Could not check previously validated first-party sources: ${previouslyValidatedSourceError.message}`,
        );
      }

      const hasPreviouslyValidatedSource =
        (previouslyValidatedSources?.length ?? 0) > 0;

      const effectiveSourceConfig = (
        source: {
          sourceType: string;
          externalSourceId: string | null;
          config: Record<string, unknown>;
        },
      ): Record<string, unknown> => {
        const existing = (previouslyValidatedSources ?? []).find(
          (item) =>
            item.source_type === source.sourceType &&
            item.external_source_id === source.externalSourceId,
        );

        const savedConfig =
          existing?.config &&
          typeof existing.config === "object" &&
          !Array.isArray(existing.config)
            ? existing.config as Record<string, unknown>
            : {};

        return { ...savedConfig, ...source.config };
      };

      /*
       * Approved website redirects are venue-scoped identities.
       * Do not trust a shared domain or another Spot's approval.
       */
      const { data: approvedRedirectRefs, error: redirectRefsError } =
        await supabase
          .from("venue_external_refs")
          .select("provider_place_id")
          .eq("venue_id", venue.id)
          .eq("provider", "website_redirect");

      if (redirectRefsError) {
        throw new Error(
          `Could not load approved website redirects: ${redirectRefsError.message}`,
        );
      }

      const venueIdentity = {
        name: venue.name,
        streetAddress: venue.street_address,
        city: venue.city,
        region: venue.state_region,
        postalCode: venue.postal_code,
        country: venue.country_code,
        latitude: venue.latitude,
        longitude: venue.longitude,
      };

      const approvedRedirectUrls =
        (approvedRedirectRefs ?? []).map(
          (ref) => ref.provider_place_id,
        );

      const validatedProbes = new Map<
        string,
        {
          ratification: Awaited<ReturnType<typeof ratifyDetectedSource>>;
          validation: Awaited<ReturnType<typeof validateFirstPartySource>>;
        }
      >();

      const candidateKey = (sourceType: string, url: string) =>
        JSON.stringify([sourceType, url]);

      let detection = await detectFirstPartySources(
        venue.website_url,
        {
          name: venue.name,
          city: venue.city,
          stateRegion: venue.state_region,
          streetAddress: venue.street_address,
          postalCode: venue.postal_code,
        },
        (approvedRedirectRefs ?? []).map(
          (ref) => ref.provider_place_id,
        ),
      );

      /*
       * Complete direct source validation before writing findings.
       *
       * Only a genuinely validated, safely attributable source prevents
       * Vultr fallback. Empty event inventory still counts as validated.
       * No source is registered during this preliminary evaluation.
       */
      let directSourceValidated = false;

      if (detection.status !== "external_redirect") {
        for (const candidate of detection.detections) {
          if (
            !candidate.adapterAvailable ||
            candidate.sourceType === "calendar_image" ||
            candidate.sourceType === "html_error" ||
            candidate.sourceType === "browser_required"
          ) {
            continue;
          }

          try {
            const ratification = await ratifyDetectedSource(
              candidate,
              venueIdentity,
            );

            if (
              ratification.status !== "ratified" ||
              !ratification.source
            ) {
              continue;
            }

            /*
             * Preserve the existing cross-Spot UVTix ownership rule
             * before allowing a direct source to suppress recovery.
             */
            if (ratification.source.sourceType === "uvtix_events") {
              const { data: owners, error: ownerError } = await supabase
                .from("event_harvest_sources")
                .select("id")
                .eq("provider", "first_party")
                .eq(
                  "external_source_id",
                  ratification.source.externalSourceId,
                )
                .eq("is_enabled", true)
                .neq("venue_id", venue.id)
                .limit(1);

              if (ownerError) throw new Error(ownerError.message);
              if ((owners?.length ?? 0) > 0) continue;
            }

            const probe: FirstPartySource = {
              id: `probe:${venue.id}`,
              provider: "first_party",
              source_type: ratification.source.sourceType,
              name: `${venue.name} official events`,
              source_url: ratification.source.sourceUrl,
              external_source_id: ratification.source.externalSourceId,
              venue_id: venue.id,
              is_enabled: true,
              trust_level: "trusted",
              config: effectiveSourceConfig(ratification.source),
              bootstrapped_at: null,
            };

            const validation = await validateFirstPartySource(probe);

            validatedProbes.set(
              candidateKey(candidate.sourceType, candidate.url),
              { ratification, validation },
            );

            if (validation.status === "validated") {
              directSourceValidated = true;
            }
          } catch {
            // The normal source loop records candidate-level failures.
            // An unsuccessful direct probe must not suppress fallback.
          }
        }
      }

      /*
       * One immediate Vultr discovery attempt, within this Spot's
       * processing cycle. Never bypass unapproved redirect review.
       */
      if (
        !directSourceValidated &&
        detection.status !== "external_redirect"
      ) {
        const proxyUrl = process.env.TENDERFANS_TRANSPORT_PROXY_URL;

        if (proxyUrl) {
          const recovered = await runWithTransportRecovery(
            proxyUrl,
            () => runWithPreferredFirstPartyProxy(
              () => detectFirstPartySources(
                venue.website_url,
                {
                  name: venue.name,
                  city: venue.city,
                  stateRegion: venue.state_region,
                  streetAddress: venue.street_address,
                  postalCode: venue.postal_code,
                },
                approvedRedirectUrls,
              ),
            ),
          );

          /*
           * A newly observed unapproved redirect must still enter
           * the existing Venue Matches review workflow.
           */
          if (recovered.status === "external_redirect") {
            detection = recovered;
          } else {
            const original = detection;
            const merged = new Map(
              original.detections.map((candidate) => [
                candidateKey(candidate.sourceType, candidate.url),
                candidate,
              ]),
            );

            for (const candidate of recovered.detections) {
              merged.set(
                candidateKey(candidate.sourceType, candidate.url),
                candidate,
              );
            }

            const combined = [...merged.values()];
            const combinedChallengeEvidence = [
              ...new Set([
                ...(original.challengeEvidence ?? []),
                ...(recovered.challengeEvidence ?? []),
              ]),
            ];

            const preferred =
              (
                recovered.status === "detected" &&
                !(
                  original.status === "challenge_encountered" &&
                  recovered.detections.every(
                    (candidate) => candidate.sourceType === "facebook",
                  )
                )
              ) ||
              (
                original.status !== "detected" &&
                original.status !== "challenge_encountered" &&
                recovered.status === "no_event_source"
              )
                ? recovered
                : original;

            const selectedStatus =
              preferred.status === "challenge_encountered" &&
              combined.every(
                (candidate) => candidate.sourceType === "facebook",
              )
                ? "challenge_encountered"
                : combined.length > 0
                  ? "detected"
                  : preferred.status;

            const diagnosticErrors = [
              preferred.error,
              preferred === original
                ? recovered.error
                : original.error,
            ].filter(
              (error): error is string =>
                typeof error === "string" &&
                error.trim().length > 0,
            );

            detection = {
              ...preferred,
              detections: combined,
              challengeEvidence: combinedChallengeEvidence,
              status: selectedStatus,
              error:
                selectedStatus === "detected" ||
                selectedStatus === "no_event_source"
                  ? preferred.error
                  : [...new Set(diagnosticErrors)].join(
                      "; Recovery attempt: ",
                    ) || null,
            };
          }
        } else {
          failures.push({
            venueId: venue.id,
            name: venue.name,
            stage: "transport_recovery",
            error: "TENDERFANS_TRANSPORT_PROXY_URL is not configured.",
          });
        }
      }

      /*
       * An unverified cross-domain redirect is an identity question,
       * not evidence that the destination belongs to this Spot.
       *
       * Reuse the existing venue-match review queue and its durable
       * pending/approved/rejected lifecycle.
       */
      if (
        detection.status === "external_redirect" &&
        detection.fetchedUrl
      ) {
        const destination = new URL(detection.fetchedUrl);
        destination.hash = "";

        const identities = detection.redirectIdentities ?? [];

        const businessIdentities = identities.filter(
          (identity) => identity.source === "json_ld",
        );
        const brandIdentities = identities.filter(
          (identity) => identity.source === "website_json_ld",
        );

        const evaluated = identities.map((candidate) => ({
          candidate,
          match: venueIdentityMatch({
            spot: {
              name: venue.name,
              streetAddress: venue.street_address,
              city: venue.city,
              stateRegion: venue.state_region,
              postalCode: venue.postal_code,
            },
            candidate: {
              name: candidate.name,
              streetAddress: candidate.streetAddress,
              city: candidate.city,
              stateRegion: candidate.stateRegion,
              postalCode: candidate.postalCode,
            },
          }),
        }));

        evaluated.sort((a, b) => b.match.score - a.match.score);

        const best = evaluated[0] ?? null;

        // Ambiguous multi-location pages require human review.
        // Never infer the candidate's address from the Spot record.
        const canAutoApprove =
          businessIdentities.length === 1 &&
          best !== null &&
          best.candidate.source === "json_ld" &&
          best.match.autoAttach;

        const { data: existingMatch, error: existingMatchError } =
          await supabase
            .from("event_harvest_venue_matches")
            .select("id, status")
            .eq("venue_id", venue.id)
            .eq("provider", "website_redirect")
            .eq("provider_place_id", destination.href)
            .maybeSingle();

        if (existingMatchError) {
          throw new Error(
            `Could not inspect redirect review history: ${existingMatchError.message}`,
          );
        }

        const { data: matchId, error: redirectMatchError } =
          await supabase.rpc(
            "upsert_event_harvest_venue_match",
            {
              p_venue_id: venue.id,
              p_provider: "website_redirect",
              p_provider_place_id: destination.href,
              p_provider_venue_name:
                best?.candidate.name ?? destination.hostname,
              p_provider_address:
                best?.candidate.streetAddress ?? null,
              p_provider_city:
                best?.candidate.city ?? null,
              p_provider_state_region:
                best?.candidate.stateRegion ?? null,
              p_provider_postal_code:
                best?.candidate.postalCode ?? null,
              p_confidence_score:
                best?.match.score ?? 0,
              p_evidence: {
                reason: "cross_domain_redirect_identity",
                registered_website_url: detection.websiteUrl,
                redirected_destination_url: detection.fetchedUrl,
                detector_status: detection.status,
                detector_error: detection.error,
                identity_source: best?.candidate.source ?? null,
                match_evidence: best?.match.evidence ?? null,
                identity_count: identities.length,
                business_identity_count: businessIdentities.length,
                brand_identity_count: brandIdentities.length,
                brand_identity_only: businessIdentities.length === 0,
                brand_name_exact: evaluated.some(
                  (entry) =>
                    entry.candidate.source === "website_json_ld" &&
                    entry.match.evidence.nameExact,
                ),
                auto_attach_eligible: canAutoApprove,
                requires_admin_review:
                  !canAutoApprove ||
                  existingMatch?.status === "rejected",
              },
              p_raw_payload: {
                registered_website_url: detection.websiteUrl,
                fetched_url: detection.fetchedUrl,
                destination_identities: identities,
              },
            },
          );

        if (redirectMatchError) {
          throw new Error(
            `Could not persist website redirect Venue Match: ${redirectMatchError.message}`,
          );
        }

        /*
         * Cross-domain website redirects require explicit Admin approval
         * through the existing Venue Matches workflow.
         *
         * Do not auto-approve a redirect based on JSON-LD identity,
         * even when its venue identity is a strong match.
         *
         * Approved redirects are already loaded from venue_external_refs
         * and passed to detectFirstPartySources at the start of each scan.
         */
      }

      const calendarImageCandidate =
        detection.detections.find(
          (candidate) => candidate.sourceType === "calendar_image",
        ) ?? null;

      let calendarImageOwnershipConflict: {
        sourceUrl: string;
        ownerId: string;
        ownerName: string | null;
      } | null = null;

      const facebookCandidate =
        detection.detections.find(
          (candidate) => candidate.sourceType === "facebook",
        ) ?? null;

      let facebookExhausted = false;

      const browserRequiredCandidate =
        detection.detections.find(
          (candidate) => candidate.sourceType === "browser_required",
        ) ?? null;
      /*
       * Transport findings are transient. Resolve the previous
       * transport state for this Spot first; if the current scan is
       * still blocked/failed, the upsert below immediately reactivates
       * the current finding and refreshes last_seen_at.
       */
      if (!recoveryMode) {
        const { error: transportResolutionError } = await supabase.rpc(
          "resolve_event_harvest_detector_findings",
          {
            p_venue_id: venue.id,
            p_category: "transport",
          },
        );

        if (transportResolutionError) {
          throw new Error(
            `Could not resolve previous transport findings: ${transportResolutionError.message}`,
          );
        }
      }

      /*
       * No-source findings represent the current successful detector
       * conclusion for a Spot. Clear the previous state first; a clean
       * no_event_source result below immediately reactivates it.
       */
      const { error: noSourceResolutionError } = await supabase.rpc(
        "resolve_event_harvest_detector_findings",
        {
          p_venue_id: venue.id,
          p_category: "no_source",
        },
      );

      if (noSourceResolutionError) {
        throw new Error(
          `Could not resolve previous no-source finding: ${noSourceResolutionError.message}`,
        );
      }

      if (
        detection.status === "transport_blocked" ||
        detection.status === "transport_failed"
      ) {
        /*
         * A Spot that has already been verified as browser-required
         * should remain in that actionable queue rather than being
         * recreated as a generic Transport Error on every static scan.
         */
        const {
          data: browserRequiredFindings,
          error: browserRequiredLookupError,
        } = await supabase
          .from("event_harvest_detector_findings")
          .select("id")
          .eq("venue_id", venue.id)
          .eq("category", "browser_required")
          .eq("status", "active")
          .limit(1);

        if (browserRequiredLookupError) {
          throw new Error(
            `Could not check browser-required findings: ${browserRequiredLookupError.message}`,
          );
        }

        hasPersistedBrowserRequired =
          (browserRequiredFindings?.length ?? 0) > 0;

        if (!hasPersistedBrowserRequired) {
          const { error: transportFindingError } = await supabase.rpc(
            "upsert_event_harvest_detector_finding",
            {
              p_venue_id: venue.id,
              p_category: "transport",
              p_finding_key: "transport",
              p_detector_status: detection.status,
              p_source_type: null,
              p_website_url: detection.websiteUrl,
              p_source_url: null,
              p_fetched_url: detection.fetchedUrl,
              p_confidence: null,
              p_evidence: [],
              p_error: detection.error,
            },
          );

          if (transportFindingError) {
            throw new Error(
              `Could not persist transport finding: ${transportFindingError.message}`,
            );
          }
        }
      }

      if (detection.status === "detected") {
        detected += 1;
      }

      /*
       * Refresh HTML parsing exceptions on successful scans.
       * Current failures are reactivated in the loop below.
       */
      if (
        detection.status === "detected" ||
        detection.status === "no_event_source"
      ) {
        const { error: htmlResolutionError } = await supabase.rpc(
          "resolve_event_harvest_detector_findings",
          {
            p_venue_id: venue.id,
            p_category: "html_error",
          },
        );

        if (htmlResolutionError) {
          throw new Error(
            `Could not resolve previous HTML errors: ${htmlResolutionError.message}`,
          );
        }
      }

      for (const candidate of detection.detections) {
        if (candidate.sourceType === "browser_required") {
          /*
           * Browser-required findings are actionable discovery work.
           * They identify Spots where static HTTP discovery is
           * insufficient but do not claim the eventual source adapter.
           */
          const { data: structuredSources, error: structuredSourceError } =
            await supabase
              .from("event_harvest_sources")
              .select("id")
              .eq("venue_id", venue.id)
              .eq("provider", "first_party")
              .eq("is_enabled", true)
              .limit(1);

          if (structuredSourceError) {
            throw new Error(
              `Could not check registered first-party sources for browser-required finding: ${structuredSourceError.message}`,
            );
          }

          if ((structuredSources?.length ?? 0) > 0) {
            const { error: browserResolutionError } = await supabase.rpc(
              "resolve_event_harvest_detector_findings",
              {
                p_venue_id: venue.id,
                p_category: "browser_required",
              },
            );

            if (browserResolutionError) {
              throw new Error(
                `Could not resolve browser-required findings: ${browserResolutionError.message}`,
              );
            }
          } else {
            const { error: browserFindingError } = await supabase.rpc(
              "upsert_event_harvest_detector_finding",
              {
                p_venue_id: venue.id,
                p_category: "browser_required",
                p_finding_key: "browser_required",
                p_detector_status: detection.status,
                p_source_type: candidate.sourceType,
                p_website_url: detection.websiteUrl,
                p_source_url: candidate.url,
                p_fetched_url: detection.fetchedUrl,
                p_confidence: candidate.confidence,
                p_evidence: candidate.evidence,
                p_error: detection.error,
              },
            );

            if (browserFindingError) {
              throw new Error(
                `Could not persist browser-required finding: ${browserFindingError.message}`,
              );
            }

            const { error: transportResolutionError } = await supabase.rpc(
              "resolve_event_harvest_detector_findings",
              {
                p_venue_id: venue.id,
                p_category: "transport",
              },
            );

            if (transportResolutionError) {
              throw new Error(
                `Could not resolve superseded transport finding: ${transportResolutionError.message}`,
              );
            }
          }
        }

        if (candidate.sourceType === "html_error") {
          const { error: htmlFindingError } = await supabase.rpc(
            "upsert_event_harvest_detector_finding",
            {
              p_venue_id: venue.id,
              p_category: "html_error",
              p_finding_key: `html_error:${candidate.url}`,
              p_detector_status: detection.status,
              p_source_type: candidate.sourceType,
              p_website_url: detection.websiteUrl,
              p_source_url: candidate.url,
              p_fetched_url: detection.fetchedUrl,
              p_confidence: candidate.confidence,
              p_evidence: candidate.evidence,
              p_error: "HTML schedule detected but extraction failed",
            },
          );

          if (htmlFindingError) {
            throw new Error(
              `Could not persist HTML extraction error: ${htmlFindingError.message}`,
            );
          }

          // Review-only: never ratify an HTML error as a source.
          continue;
        }

        if (candidate.sourceType === "calendar_image") {

          /*
           * Calendar recognition is source review, not event extraction.
           * An already registered source must not reopen its approval.
           */
          const { data: registeredCalendars, error: registeredError } =
            await supabase
              .from("event_harvest_sources")
              .select("id")
              .eq("venue_id", venue.id)
              .eq("provider", "first_party")
              .eq("source_type", "calendar_image")
              .eq(
                "external_source_id",
                `first_party:calendar_image:${candidate.url}`,
              )
              .eq("is_enabled", true)
              .limit(1);

          if (registeredError) {
            throw new Error(registeredError.message);
          }

          if ((registeredCalendars?.length ?? 0) === 0) {
            /*
             * A calendar already registered to another Spot is off-limits.
             * Do not create a finding, register it, or ingest it here.
             */
            const { data: otherOwners, error: otherOwnersError } =
              await supabase
                .from("event_harvest_sources")
                .select("venue_id,name")
                .eq("provider", "first_party")
                .eq("source_type", "calendar_image")
                .eq(
                  "external_source_id",
                  `first_party:calendar_image:${candidate.url}`,
                )
                .eq("is_enabled", true)
                .neq("venue_id", venue.id)
                .limit(1);

            if (otherOwnersError) {
              throw new Error(
                `Could not check calendar ownership: ${otherOwnersError.message}`,
              );
            }

            const otherOwner = otherOwners?.[0];

            if (otherOwner) {
              // This source belongs to another Spot. Never reopen it.
              continue;
            }

          /*
           * Identify a business from the calendar page itself.
           * Never infer ownership from the corporate domain.
           */
          let calendarVenueId: string | null = null;
          let calendarBusinessName: string | null = null;

          try {
            const page = await fetchHtml(candidate.url);

            if (page.ok) {
              calendarBusinessName =
                calendarPageBusinessName(page.html);
            }

            if (calendarBusinessName) {
              const google = await searchGoogleVenue(
                {
                  name: calendarBusinessName,
                  streetAddress: null,
                  city: null,
                  stateRegion: null,
                  postalCode: null,
                },
                { allowReviewCandidate: true },
              );

              if (google) {
                const calendarGoogle = {
                  ...google,
                  evidence: {
                    ...google.evidence,
                    calendarPageUrl: candidate.url,
                    calendarBusinessName,
                  },
                };

                /*
                 * Honor existing admin decisions first.
                 * Review-only discoveries must not auto-register.
                 */
                calendarVenueId =
                  await resolveReviewedGoogleSpot(
                    supabase,
                    calendarGoogle,
                  );

                if (!calendarVenueId) {
                  const reviewStatus =
                    await recordGoogleSpotDiscovery(
                      supabase,
                      calendarGoogle,
                    );

                  if (
                    reviewStatus === "pending" &&
                    google.evidence.reviewOnly !== true
                  ) {
                    calendarVenueId =
                      await registerHarvestGoogleSpot(
                        supabase,
                        calendarGoogle,
                      );
                  }
                }
              }
            }
          } catch (calendarDiscoveryError) {
            /*
             * Google discovery must never destroy or suppress
             * an otherwise valid calendar-image finding.
             */
            console.error(
              "Calendar Spot discovery failed:",
              candidate.url,
              calendarDiscoveryError,
            );
          }


            const { error: calendarFindingError } = await supabase.rpc(
              "upsert_event_harvest_detector_finding",
              {
                p_venue_id: calendarVenueId ?? venue.id,
                p_category: "calendar_image",
                p_finding_key: `calendar_image:${candidate.url}`,
                p_detector_status: detection.status,
                p_source_type: candidate.sourceType,
                p_website_url: detection.websiteUrl,
                p_source_url: candidate.url,
                p_fetched_url: detection.fetchedUrl,
                p_confidence: candidate.confidence,
                p_evidence: [
                  ...candidate.evidence,
                  ...(calendarBusinessName
                    ? [`Calendar business: ${calendarBusinessName}`]
                    : []),
                  ...(calendarVenueId
                    ? [`Qualified Spot ID: ${calendarVenueId}`]
                    : []),
                ],
                p_error: detection.error,
              },
            );

            if (calendarFindingError) {
              throw new Error(
                `Could not persist calendar-image finding: ${calendarFindingError.message}`,
              );
            }
          }

          continue;
        }

        if (!candidate.adapterAvailable) {
          unsupported += 1;
          continue;
        }

        try {
          const cachedProbe = validatedProbes.get(
            candidateKey(candidate.sourceType, candidate.url),
          );

          const ratification = cachedProbe?.ratification ??
            await ratifyDetectedSource(candidate, {
            name: venue.name,
            streetAddress: venue.street_address,
            city: venue.city,
            region: venue.state_region,
            postalCode: venue.postal_code,
            country: venue.country_code,
            latitude: venue.latitude,
            longitude: venue.longitude,
          });

          if (ratification.status !== "ratified" || !ratification.source) {
            failed += 1;
            failures.push({
              venueId: venue.id,
              name: venue.name,
              stage: "ratification",
              error: ratification.error ?? "Source was not ratified.",
            });
            continue;
          }

          ratified += 1;

          /*
           * UVTix subdomains identify provider-side venue/account
           * inventories. A shared first-party website can link to more
           * than one UVTix account, so discovery from the current Spot's
           * web surface alone is not sufficient ownership evidence.
           *
           * Preserve venue-scoped source registration generally, but do
           * not automatically attach an already-owned UVTix identity to
           * a different TenderFans Spot.
           */
          if (
            ratification.source.sourceType === "uvtix_events" ||
            ratification.source.sourceType === "calendar_image"
          ) {
            const sourceType = ratification.source.sourceType;

            const { data: existingOwners, error: ownerError } =
              await supabase
                .from("event_harvest_sources")
                .select("id,venue_id,name")
                .eq("provider", "first_party")
                .eq(
                  "external_source_id",
                  ratification.source.externalSourceId,
                )
                .eq("is_enabled", true)
                .neq("venue_id", venue.id)
                .limit(1);

            if (ownerError) {
              throw new Error(
                `Could not verify ${sourceType} source ownership: ${ownerError.message}`,
              );
            }

            const existingOwner = existingOwners?.[0];

            if (existingOwner) {
              if (sourceType === "calendar_image") {
                calendarImageOwnershipConflict = {
                  sourceUrl: ratification.source.sourceUrl,
                  ownerId: existingOwner.venue_id ?? "",
                  ownerName: existingOwner.name ?? null,
                };
              } else {
                failed += 1;
                failures.push({
                  venueId: venue.id,
                  name: venue.name,
                  stage: "attribution",
                  error: `UVTix source ${ratification.source.sourceUrl} is already registered to another Spot (${existingOwner.name ?? existingOwner.venue_id}).`,
                });
              }

              // Never validate or register a source already owned
              // by another Spot.
              continue;
            }
          }

          /*
           * A validated HTML page may be a corporate event announcement,
           * not a source owned by every Spot linking to it.
           *
           * Preserve existing legitimate source registrations. A second
           * Spot claiming the same HTML source enters review rather than
           * acquiring trusted source ownership automatically.
           */
          const source: FirstPartySource = {
            id: `probe:${venue.id}`,
            provider: "first_party",
            source_type: ratification.source.sourceType,
            name: `${venue.name} official events`,
            source_url: ratification.source.sourceUrl,
            external_source_id: ratification.source.externalSourceId,
            venue_id: venue.id,
            is_enabled: true,
            trust_level: "trusted",
            config: effectiveSourceConfig(ratification.source),
            bootstrapped_at: null,
          };

          /*
           * Direct validation may have failed before Vultr discovery.
           * Retry failed probes and validate newly discovered sources
           * through the recovery transport within this same Spot cycle.
           * A successful direct probe is reused without another fetch.
           */
          const validation =
            cachedProbe?.validation.status === "validated"
              ? cachedProbe.validation
              : !directSourceValidated &&
                  detection.status !== "external_redirect" &&
                  process.env.TENDERFANS_TRANSPORT_PROXY_URL
                ? await runWithTransportRecovery(
                    process.env.TENDERFANS_TRANSPORT_PROXY_URL,
                    () => validateFirstPartySource(source),
                  )
                : cachedProbe?.validation ??
                  await validateFirstPartySource(source);

          if (validation.status !== "validated") {
            if (
              candidate.sourceType === "facebook" &&
              /Facebook Page is unofficial and has no supported event source|Facebook Page has no public Events surface|Facebook Events page is unavailable or access restricted/i.test(
                validation.error ?? "",
              )
            ) {
              facebookExhausted = true;
            }

            failed += 1;
            failures.push({
              venueId: venue.id,
              name: venue.name,
              stage: "validation",
              error: validation.error ?? "Source validation failed.",
            });
            continue;
          }

          validated += 1;

          if (ratification.source.sourceType === "html_events") {
            const alreadyRegisteredHere = (previouslyValidatedSources ?? []).some(
              (existing) =>
                existing.source_type === "html_events" &&
                existing.external_source_id === ratification.source.externalSourceId,
            );

            if (!alreadyRegisteredHere) {
            const { data: otherOwners, error: ownershipError } =
              await supabase
                .from("event_harvest_sources")
                .select("id,venue_id,name")
                .eq("provider", "first_party")
                .eq("external_source_id", ratification.source.externalSourceId)
                .eq("is_enabled", true)
                .neq("venue_id", venue.id)
                .limit(1);

            if (ownershipError) {
              throw new Error(
                `Could not inspect HTML source ownership: ${ownershipError.message}`,
              );
            }

            if ((otherOwners?.length ?? 0) > 0) {
              const { error: findingError } = await supabase.rpc(
                "upsert_event_harvest_detector_finding",
                {
                  p_venue_id: venue.id,
                  p_category: "source_ownership",
                  p_finding_key:
                    `source_ownership:${ratification.source.externalSourceId}`,
                  p_detector_status: detection.status,
                  p_source_type: ratification.source.sourceType,
                  p_website_url: detection.websiteUrl,
                  p_source_url: ratification.source.sourceUrl,
                  p_fetched_url: detection.fetchedUrl,
                  p_confidence: candidate.confidence,
                  p_evidence: [
                    ...candidate.evidence,
                    "HTML source is already registered to another Spot",
                    "Source validation succeeded",
                    `Existing source owner: ${otherOwners[0].name}`,
                  ],
                  p_error:
                    "Shared HTML event source requires ownership review",
                },
              );

              if (findingError) {
                throw new Error(
                  `Could not record HTML source ownership finding: ${findingError.message}`,
                );
              }

              continue;
            }

            const { data: sharedWebsite, error: sharedWebsiteError } =
              await supabase.rpc("first_party_html_source_requires_review", {
                p_venue_id: venue.id,
                p_source_url: ratification.source.sourceUrl,
              });

            if (sharedWebsiteError) {
              throw new Error(
                `Could not assess shared HTML website: ${sharedWebsiteError.message}`
              );
            }

            if (sharedWebsite) {
              const { error: findingError } = await supabase.rpc(
                "upsert_event_harvest_detector_finding",
                {
                  p_venue_id: venue.id,
                  p_category: "source_ownership",
                  p_finding_key:
                    `source_ownership:${ratification.source.externalSourceId}`,
                  p_detector_status: detection.status,
                  p_source_type: "html_events",
                  p_website_url: detection.websiteUrl,
                  p_source_url: ratification.source.sourceUrl,
                  p_fetched_url: detection.fetchedUrl,
                  p_confidence: candidate.confidence,
                  p_evidence: [
                    ...candidate.evidence,
                    "Source validation succeeded",
                    "Multiple active Spots share the same registered website identity",
                    "Explicit HTML source association review required",
                  ],
                  p_error:
                    "Shared website HTML publisher ownership requires review",
                },
              );

              if (findingError) {
                throw new Error(
                  `Could not record shared website review: ${findingError.message}`
                );
              }

              continue;
            }
            } // No existing approved/current registration for this Spot
          }


          const { data: sourceId, error: registrationError } =
            await supabase.rpc("upsert_first_party_event_source", {
              p_venue_id: venue.id,
              p_source_type: ratification.source.sourceType,
              p_name: `${venue.name} official events`,
              p_source_url: ratification.source.sourceUrl,
              p_external_source_id: ratification.source.externalSourceId,
              p_config: effectiveSourceConfig(ratification.source),
            });

          if (registrationError || !sourceId) {
            throw new Error(
              registrationError?.message ??
                "Source registration returned no source ID.",
            );
          }

          registered += 1;
          successfullyRegisteredVenueSource = true;

          /*
           * A successfully registered structured first-party source
           * also makes any browser-required discovery finding
           * non-actionable. Browser transport has completed its job
           * once it exposes a provider source that can be registered.
           */
          const { error: browserResolutionError } = await supabase.rpc(
            "resolve_event_harvest_detector_findings",
            {
              p_venue_id: venue.id,
              p_category: "browser_required",
            },
          );

          if (browserResolutionError) {
            throw new Error(
              `Could not resolve browser-required findings after source registration: ${browserResolutionError.message}`,
            );
          }

          /*
           * A successfully registered calendar-image adapter is no
           * longer actionable discovery work. The image remains an
           * independent first-party source even when the same Spot
           * also has structured event sources.
           */
          if (candidate.sourceType === "facebook") {
            const { error: facebookResolutionError } = await supabase.rpc(
              "resolve_event_harvest_detector_findings",
              {
                p_venue_id: venue.id,
                p_category: "facebook",
              },
            );

            if (facebookResolutionError) {
              throw new Error(
                `Could not resolve Facebook findings after source registration: ${facebookResolutionError.message}`,
              );
            }
          }
        } catch (error) {
          failed += 1;
          failures.push({
            venueId: venue.id,
            name: venue.name,
            stage: "source",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      /*
       * Final detector outcome routing.
       *
       * The detector, ratifier, validator, and registration paths above
       * keep their existing behavior. This block only reconciles the
       * completed Spot result into one mutually exclusive outcome.
       *
       * Precedence:
       * Validated -> Calendar Image -> Facebook ->
       * Browser Required -> Challenge Encountered -> Transport Error -> No Sources.
       */
      const actionableCategories = [
        "facebook",
        "browser_required",
        "challenge_encountered",
        "transport",
        "no_source",
      ] as const;

      for (const category of actionableCategories) {
        if (
          recoveryMode && category === "transport"
        ) {
          // Preserve the queued transport finding until the final
          // classification has been persisted successfully.
          continue;
        }

        if (
          category === "browser_required" &&
          hasPersistedBrowserRequired &&
          !browserRequiredCandidate
        ) {
          continue;
        }

        const { error: resolutionError } = await supabase.rpc(
          "resolve_event_harvest_detector_findings",
          {
            p_venue_id: venue.id,
            p_category: category,
          },
        );

        if (resolutionError) {
          throw new Error(
            `Could not reconcile ${category} detector finding: ${resolutionError.message}`,
          );
        }
      }

      const htmlErrorCandidate = detection.detections.find(
        (candidate) => candidate.sourceType === "html_error",
      );

      if (successfullyRegisteredVenueSource || hasPreviouslyValidatedSource) {
        bucketCounts.validated += 1;
      } else if (calendarImageCandidate) {
        bucketCounts.calendar_image += 1;
      } else if (facebookCandidate && !facebookExhausted) {
        const { error: findingError } = await supabase.rpc(
          "upsert_event_harvest_detector_finding",
          {
            p_venue_id: venue.id,
            p_category: "facebook",
            p_finding_key: `facebook:${facebookCandidate.url}`,
            p_detector_status: detection.status,
            p_source_type: facebookCandidate.sourceType,
            p_website_url: detection.websiteUrl,
            p_source_url: facebookCandidate.url,
            p_fetched_url: detection.fetchedUrl,
            p_confidence: facebookCandidate.confidence,
            p_evidence: facebookCandidate.evidence,
            p_error: detection.error,
          },
        );

        if (findingError) {
          throw new Error(
            `Could not persist final Facebook finding: ${findingError.message}`,
          );
        }

        bucketCounts.facebook += 1;
      } else if (browserRequiredCandidate || hasPersistedBrowserRequired) {
        if (browserRequiredCandidate) {
          const { error: findingError } = await supabase.rpc(
            "upsert_event_harvest_detector_finding",
            {
              p_venue_id: venue.id,
              p_category: "browser_required",
              p_finding_key: "browser_required",
              p_detector_status: detection.status,
              p_source_type: browserRequiredCandidate.sourceType,
              p_website_url: detection.websiteUrl,
              p_source_url: browserRequiredCandidate.url,
              p_fetched_url: detection.fetchedUrl,
              p_confidence: browserRequiredCandidate.confidence,
              p_evidence: browserRequiredCandidate.evidence,
              p_error: detection.error,
            },
          );

          if (findingError) {
            throw new Error(
              `Could not persist final browser-required finding: ${findingError.message}`,
            );
          }
        }

        bucketCounts.browser_required += 1;
      } else if (htmlErrorCandidate) {
        bucketCounts.html_error += 1;
      } else if ((detection.challengeEvidence?.length ?? 0) > 0) {
        const { error: findingError } = await supabase.rpc(
          "upsert_event_harvest_detector_finding",
          {
            p_venue_id: venue.id,
            p_category: "challenge_encountered",
            p_finding_key: "challenge_encountered",
            p_detector_status: "challenge_encountered",
            p_source_type: null,
            p_website_url: detection.websiteUrl,
            p_source_url: null,
            p_fetched_url: detection.fetchedUrl,
            p_confidence: "high",
            p_evidence: detection.challengeEvidence ?? [],
            p_error: detection.error,
          },
        );

        if (findingError) {
          throw new Error(
            `Could not persist challenge finding: ${findingError.message}`,
          );
        }

        bucketCounts.challenge_encountered += 1;
      } else if (
        detection.status === "transport_blocked" ||
        detection.status === "transport_failed"
      ) {
        const { error: findingError } = await supabase.rpc(
          "upsert_event_harvest_detector_finding",
          {
            p_venue_id: venue.id,
            p_category: "transport",
            p_finding_key: "transport",
            p_detector_status: detection.status,
            p_source_type: null,
            p_website_url: detection.websiteUrl,
            p_source_url: null,
            p_fetched_url: detection.fetchedUrl,
            p_confidence: null,
            p_evidence: [],
            p_error: detection.error,
          },
        );

        if (findingError) {
          throw new Error(
            `Could not persist final transport finding: ${findingError.message}`,
          );
        }

        bucketCounts.transport += 1;
      } else {
        const { error: findingError } = await supabase.rpc(
          "upsert_event_harvest_detector_finding",
          {
            p_venue_id: venue.id,
            p_category: "no_source",
            p_finding_key: "no_source",
            p_detector_status: detection.status,
            p_source_type: null,
            p_website_url: detection.websiteUrl,
            p_source_url: null,
            p_fetched_url: detection.fetchedUrl,
            p_confidence: null,
            p_evidence: [],
            p_error: detection.error,
          },
        );

        if (findingError) {
          throw new Error(
            `Could not persist final no-source finding: ${findingError.message}`,
          );
        }

        bucketCounts.no_source += 1;
      }

      /*
       * Admin buckets are mutually exclusive for primary triage.
       * Preserve source evidence, but resolve competing active
       * exception findings after final classification.
       */
      const primaryCategory =
        successfullyRegisteredVenueSource || hasPreviouslyValidatedSource
          ? null
          : calendarImageCandidate
            ? "calendar_image"
            : facebookCandidate && !facebookExhausted
              ? "facebook"
              : browserRequiredCandidate || hasPersistedBrowserRequired
                ? "browser_required"
                : htmlErrorCandidate
                  ? "html_error"
                  : (detection.challengeEvidence?.length ?? 0) > 0
                    ? "challenge_encountered"
                    : detection.status === "transport_blocked" ||
                        detection.status === "transport_failed"
                      ? "transport"
                      : "no_source";

      for (const category of [
        "facebook",
        "browser_required",
        "html_error",
        "challenge_encountered",
        "transport",
        "no_source",
      ]) {
        if (category === primaryCategory) continue;

        const { error: primaryResolutionError } = await supabase.rpc(
          "resolve_event_harvest_detector_findings",
          {
            p_venue_id: venue.id,
            p_category: category,
          },
        );

        if (primaryResolutionError) {
          throw new Error(
            `Could not resolve competing ${category} finding: ${primaryResolutionError.message}`,
          );
        }
      }

      if (
        recoveryMode &&
        (
          successfullyRegisteredVenueSource ||
          hasPreviouslyValidatedSource ||
          calendarImageCandidate ||
          (facebookCandidate && !facebookExhausted) ||
          browserRequiredCandidate ||
          hasPersistedBrowserRequired ||
          (
            detection.status !== "transport_blocked" &&
            detection.status !== "transport_failed"
          )
        )
      ) {
        const { error: recoveryResolutionError } = await supabase.rpc(
          "resolve_event_harvest_detector_findings",
          {
            p_venue_id: venue.id,
            p_category: "transport",
          },
        );

        if (recoveryResolutionError) {
          throw new Error(
            `Could not finalize transport recovery: ${recoveryResolutionError.message}`,
          );
        }
      }
    } catch (error) {
      failed += 1;
      failures.push({
        venueId: venue.id,
        name: venue.name,
        stage: "detection",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    };

    /*
     * Approved cross-domain redirects may require the existing
     * transport-recovery proxy on every scan, not only while a
     * transport finding remains unresolved.
     *
     * Preserve venue-scoped redirect approval and the existing
     * transport-recovery queue eligibility rules.
     */
    const { data: approvedTransportRedirects, error: approvedTransportError } =
      await supabase
        .from("venue_external_refs")
        .select("provider_place_id")
        .eq("venue_id", venue.id)
        .eq("provider", "website_redirect")
        .limit(1);

    if (approvedTransportError) {
      throw new Error(
        `Could not inspect approved website redirects: ${approvedTransportError.message}`,
      );
    }

    const needsRecoveryTransport =
      recoveryMode || (approvedTransportRedirects?.length ?? 0) > 0;

    const proxyUrl = process.env.TENDERFANS_TRANSPORT_PROXY_URL;

    if (needsRecoveryTransport && proxyUrl) {
      await runWithTransportRecovery(proxyUrl, processVenue);
    } else if (recoveryMode) {
      throw new Error("Transport recovery proxy is not configured.");
    } else {
      await processVenue();
    }
  }

  // Persist execution failures separately from source classification.
  // Only completed requests reach this reconciliation step.
  for (const venue of venues ?? []) {
    const executionErrors = failures.filter(
      (entry) =>
        entry.venueId === venue.id &&
        (entry.stage === "detection" || entry.stage === "source")
    );

    const { error: trackingError } = await supabase.rpc(
      "record_event_harvest_execution_result",
      {
        p_venue_id: venue.id,
        p_errors: executionErrors,
      }
    );

    if (trackingError) {
      throw new Error(
        `Could not record execution result for ${venue.id}: ${trackingError.message}`
      );
    }

  }

  const bucketTotal =
    bucketCounts.validated +
    bucketCounts.calendar_image +
    bucketCounts.facebook +
    bucketCounts.browser_required +
    bucketCounts.html_error +
    bucketCounts.challenge_encountered +
    bucketCounts.transport +
    bucketCounts.no_source;

  const bucketInvariantHolds = bucketTotal === processedSpots;

  return NextResponse.json({
    spots: processedSpots,
    bucketInvariantHolds,
    detected,
    ratified,
    validated,
    registered,
    unsupported,
    failed,
    buckets: {
      validated: bucketCounts.validated,
      calendarImage: bucketCounts.calendar_image,
      facebook: bucketCounts.facebook,
      browserRequired: bucketCounts.browser_required,
      htmlError: bucketCounts.html_error,
      challengeEncountered: bucketCounts.challenge_encountered,
      transportError: bucketCounts.transport,
      noSources: bucketCounts.no_source,
      total: bucketTotal,
    },
    failures,
  });
}
