import { venueIdentityMatch } from "@/lib/event-harvester/venue-identity";
import { runWithTransportRecovery } from "@/lib/event-harvester/transport-recovery-context";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { detectFirstPartySources } from "@/lib/event-harvester/first-party/source-detector";

import { ratifyDetectedSource } from "@/lib/event-harvester/first-party/ratify";

import { validateFirstPartySource } from "@/lib/event-harvester/first-party/validate";

import type { FirstPartySource } from "@/lib/event-harvester/first-party/preview";

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
      .eq("category", "transport")
      .in("detector_status", ["transport_failed", "transport_blocked"])
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
            error: "Some Spots are no longer in the unresolved transport recovery queue.",
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
      let successfullyRegistered = false;
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
        .select("id")
        .eq("venue_id", venue.id)
        .eq("provider", "first_party")
        .eq("is_enabled", true)
        .limit(1);

      if (previouslyValidatedSourceError) {
        throw new Error(
          `Could not check previously validated first-party sources: ${previouslyValidatedSourceError.message}`,
        );
      }

      const hasPreviouslyValidatedSource =
        (previouslyValidatedSources?.length ?? 0) > 0;

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

        if (
          canAutoApprove &&
          existingMatch?.status !== "rejected"
        ) {
          const { error: approveError } = await supabase.rpc(
            "auto_approve_event_harvest_venue_match",
            { p_match_id: matchId },
          );

          if (approveError) {
            throw new Error(
              `Could not auto-approve website redirect: ${approveError.message}`,
            );
          }

          // Continue the same scan with the newly approved identity.
          detection = await detectFirstPartySources(
            venue.website_url,
            {
              name: venue.name,
              city: venue.city,
              stateRegion: venue.state_region,
              streetAddress: venue.street_address,
              postalCode: venue.postal_code,
            },
            [
              ...(approvedRedirectRefs ?? []).map(
                (ref) => ref.provider_place_id,
              ),
              destination.href,
            ],
          );
        }
      }

      const calendarImageCandidate =
        detection.detections.find(
          (candidate) => candidate.sourceType === "calendar_image",
        ) ?? null;

      const facebookCandidate =
        detection.detections.find(
          (candidate) => candidate.sourceType === "facebook",
        ) ?? null;

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

      if (detection.status === "no_event_source") {
        const { error: noSourceFindingError } = await supabase.rpc(
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
            p_error: null,
          },
        );

        if (noSourceFindingError) {
          throw new Error(
            `Could not persist no-source finding: ${noSourceFindingError.message}`,
          );
        }
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

        if (candidate.sourceType === "facebook") {
          /*
           * Facebook findings are an actionable future-adapter queue.
           * If this Spot already has an enabled structured first-party
           * source, Facebook is no longer needed as its event source.
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
              `Could not check registered first-party sources for Facebook finding: ${structuredSourceError.message}`,
            );
          }

          if ((structuredSources?.length ?? 0) > 0) {
            const { error: facebookResolutionError } = await supabase.rpc(
              "resolve_event_harvest_detector_findings",
              {
                p_venue_id: venue.id,
                p_category: "facebook",
              },
            );

            if (facebookResolutionError) {
              throw new Error(
                `Could not resolve Facebook findings: ${facebookResolutionError.message}`,
              );
            }
          } else {
            /*
             * Facebook findings represent the Spot's current actionable
             * source, not detection history. Resolve any older URL-based
             * finding before persisting the current candidate so redirects
             * or URL normalization cannot leave duplicate active rows.
             */
            const { error: staleFacebookResolutionError } = await supabase.rpc(
              "resolve_event_harvest_detector_findings",
              {
                p_venue_id: venue.id,
                p_category: "facebook",
              },
            );

            if (staleFacebookResolutionError) {
              throw new Error(
                `Could not resolve stale Facebook findings: ${staleFacebookResolutionError.message}`,
              );
            }

            const { error: facebookFindingError } = await supabase.rpc(
              "upsert_event_harvest_detector_finding",
              {
                p_venue_id: venue.id,
                p_category: "facebook",
                p_finding_key: `facebook:${candidate.url}`,
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

            if (facebookFindingError) {
              throw new Error(
                `Could not persist Facebook finding: ${facebookFindingError.message}`,
              );
            }
          }
        }

        if (!candidate.adapterAvailable) {
          unsupported += 1;
          continue;
        }

        try {
          const ratification = await ratifyDetectedSource(candidate, {
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
          if (ratification.source.sourceType === "uvtix_events") {
            const {
              data: existingUvTixOwners,
              error: existingUvTixOwnerError,
            } = await supabase
              .from("event_harvest_sources")
              .select("id,venue_id,name")
              .eq("provider", "first_party")
              .eq("external_source_id", ratification.source.externalSourceId)
              .eq("is_enabled", true)
              .neq("venue_id", venue.id)
              .limit(1);

            if (existingUvTixOwnerError) {
              throw new Error(
                `Could not verify UVTix source ownership: ${existingUvTixOwnerError.message}`,
              );
            }

            const existingUvTixOwner = existingUvTixOwners?.[0];

            if (existingUvTixOwner) {
              failed += 1;
              failures.push({
                venueId: venue.id,
                name: venue.name,
                stage: "attribution",
                error: `UVTix source ${ratification.source.sourceUrl} is already registered to another Spot (${existingUvTixOwner.name ?? existingUvTixOwner.venue_id}).`,
              });
              continue;
            }
          }

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
            config: ratification.source.config,
            bootstrapped_at: null,
          };

          const validation = await validateFirstPartySource(source);

          if (validation.status !== "validated") {
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

          const registration =
            ratification.source.sourceType === "facebook_events"
              ? await supabase.rpc("upsert_global_first_party_event_source", {
                  p_source_type: ratification.source.sourceType,
                  p_name: `${venue.name} Facebook events`,
                  p_source_url: ratification.source.sourceUrl,
                  p_external_source_id: ratification.source.externalSourceId,
                  p_config: ratification.source.config,
                })
              : await supabase.rpc("upsert_first_party_event_source", {
                  p_venue_id: venue.id,
                  p_source_type: ratification.source.sourceType,
                  p_name: `${venue.name} official events`,
                  p_source_url: ratification.source.sourceUrl,
                  p_external_source_id: ratification.source.externalSourceId,
                  p_config: ratification.source.config,
                });

          const { data: sourceId, error: registrationError } = registration;

          if (registrationError || !sourceId) {
            throw new Error(
              registrationError?.message ??
                "Source registration returned no source ID.",
            );
          }

          registered += 1;

          successfullyRegistered = true;
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
          if (candidate.sourceType === "calendar_image") {
            const { error: calendarImageResolutionError } = await supabase.rpc(
              "resolve_event_harvest_detector_findings",
              {
                p_venue_id: venue.id,
                p_category: "calendar_image",
              },
            );

            if (calendarImageResolutionError) {
              throw new Error(
                `Could not resolve calendar-image findings after source registration: ${calendarImageResolutionError.message}`,
              );
            }
          }

          /*
           * A successfully registered Facebook adapter is no longer
           * actionable discovery work. Resolve the Facebook finding
           * after registration succeeds.
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
       * Browser Required -> Transport Error -> No Sources.
       */
      const actionableCategories = [
        "calendar_image",
        "facebook",
        "browser_required",
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

      if (successfullyRegistered || hasPreviouslyValidatedSource) {
        bucketCounts.validated += 1;
      } else if (calendarImageCandidate) {
        const { error: findingError } = await supabase.rpc(
          "upsert_event_harvest_detector_finding",
          {
            p_venue_id: venue.id,
            p_category: "calendar_image",
            p_finding_key: "calendar_image",
            p_detector_status: detection.status,
            p_source_type: calendarImageCandidate.sourceType,
            p_website_url: detection.websiteUrl,
            p_source_url: calendarImageCandidate.url,
            p_fetched_url: detection.fetchedUrl,
            p_confidence: calendarImageCandidate.confidence,
            p_evidence: calendarImageCandidate.evidence,
            p_error: detection.error,
          },
        );

        if (findingError) {
          throw new Error(
            `Could not persist final calendar-image finding: ${findingError.message}`,
          );
        }

        bucketCounts.calendar_image += 1;
      } else if (facebookCandidate) {
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

      if (
        recoveryMode &&
        (
          successfullyRegistered ||
          hasPreviouslyValidatedSource ||
          calendarImageCandidate ||
          facebookCandidate ||
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

    if (recoveryMode) {
      const proxyUrl = process.env.TENDERFANS_TRANSPORT_PROXY_URL;

      if (!proxyUrl) {
        throw new Error("Transport recovery proxy is not configured.");
      }

      await runWithTransportRecovery(proxyUrl, processVenue);
    } else {
      await processVenue();
    }
  }

  const bucketTotal =
    bucketCounts.validated +
    bucketCounts.calendar_image +
    bucketCounts.facebook +
    bucketCounts.browser_required +
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
      transportError: bucketCounts.transport,
      noSources: bucketCounts.no_source,
      total: bucketTotal,
    },
    failures,
  });
}
