import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import {
  detectFirstPartySources,
} from "@/lib/event-harvester/first-party/source-detector";

import {
  ratifyDetectedSource,
} from "@/lib/event-harvester/first-party/ratify";

import {
  validateFirstPartySource,
} from "@/lib/event-harvester/first-party/validate";

import type {
  FirstPartySource,
} from "@/lib/event-harvester/first-party/preview";

export const dynamic = "force-dynamic";

const SPOT_LIMIT = 30;

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

export async function GET(
  request: Request
) {
  const expectedSecret =
    process.env.CRON_SECRET;

  if (!expectedSecret) {
    return NextResponse.json(
      {
        error:
          "Cron secret is not configured.",
      },
      { status: 500 }
    );
  }

  const auth =
    request.headers.get(
      "authorization"
    );

  if (
    auth !==
    `Bearer ${expectedSecret}`
  ) {
    return NextResponse.json(
      { error: "Unauthorized." },
      { status: 401 }
    );
  }

  const supabase =
    getAdminClient();

  const { data: venues, error } =
    await supabase
      .from("venues")
      .select(
        "id,name,website_url,street_address,city,state_region,postal_code,country_code,latitude,longitude"
      )
      .eq("status", "active")
      .not("website_url", "is", null)
      .order("created_at", {
        ascending: false,
      })
      .limit(SPOT_LIMIT);

  if (error) {
    return NextResponse.json(
      {
        error:
          `Could not load Spots: ${error.message}`,
      },
      { status: 500 }
    );
  }

  let detected = 0;
  let ratified = 0;
  let validated = 0;
  let registered = 0;
  let unsupported = 0;
  let failed = 0;

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

    try {
      const detection =
        await detectFirstPartySources(
          venue.website_url
        );

      /*
       * Transport findings are transient. Resolve the previous
       * transport state for this Spot first; if the current scan is
       * still blocked/failed, the upsert below immediately reactivates
       * the current finding and refreshes last_seen_at.
       */
      const {
        error: transportResolutionError,
      } = await supabase.rpc(
        "resolve_event_harvest_detector_findings",
        {
          p_venue_id: venue.id,
          p_category: "transport",
        }
      );

      if (transportResolutionError) {
        throw new Error(
          `Could not resolve previous transport findings: ${transportResolutionError.message}`
        );
      }

      if (
        detection.status ===
          "transport_blocked" ||
        detection.status ===
          "transport_failed"
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
            `Could not check browser-required findings: ${browserRequiredLookupError.message}`
          );
        }

        if ((browserRequiredFindings?.length ?? 0) === 0) {
          const {
            error: transportFindingError,
          } = await supabase.rpc(
            "upsert_event_harvest_detector_finding",
            {
              p_venue_id: venue.id,
              p_category: "transport",
              p_finding_key: "transport",
              p_detector_status:
                detection.status,
              p_source_type: null,
              p_website_url:
                detection.websiteUrl,
              p_source_url: null,
              p_fetched_url:
                detection.fetchedUrl,
              p_confidence: null,
              p_evidence: [],
              p_error: detection.error,
            }
          );

          if (transportFindingError) {
            throw new Error(
              `Could not persist transport finding: ${transportFindingError.message}`
            );
          }
        }
      }

      if (
        detection.status === "detected"
      ) {
        detected += 1;
      }

      for (
        const candidate
        of detection.detections
      ) {
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

        if (candidate.sourceType === "calendar_image") {
          /*
           * Calendar-image findings are an actionable adapter queue,
           * not detector history. If this Spot already has an enabled
           * structured first-party source, the image adapter is no
           * longer needed.
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
              `Could not check registered first-party sources: ${structuredSourceError.message}`,
            );
          }

          if ((structuredSources?.length ?? 0) > 0) {
            const { error: calendarResolutionError } = await supabase.rpc(
              "resolve_event_harvest_detector_findings",
              {
                p_venue_id: venue.id,
                p_category: "calendar_image",
              },
            );

            if (calendarResolutionError) {
              throw new Error(
                `Could not resolve calendar-image findings: ${calendarResolutionError.message}`,
              );
            }
          } else {
            const { error: calendarFindingError } = await supabase.rpc(
              "upsert_event_harvest_detector_finding",
              {
                p_venue_id: venue.id,
                p_category: "calendar_image",
                p_finding_key: `calendar_image:${candidate.url}`,
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

            if (calendarFindingError) {
              throw new Error(
                `Could not persist calendar-image finding: ${calendarFindingError.message}`,
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
            const { error: staleFacebookResolutionError } =
              await supabase.rpc(
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

        if (
          !candidate.adapterAvailable
        ) {
          unsupported += 1;
          continue;
        }

        try {
          const ratification =
            await ratifyDetectedSource(
              candidate,
              {
                name: venue.name,
                streetAddress:
                  venue.street_address,
                city: venue.city,
                region:
                  venue.state_region,
                postalCode:
                  venue.postal_code,
                country:
                  venue.country_code,
                latitude:
                  venue.latitude,
                longitude:
                  venue.longitude,
              }
            );

          if (
            ratification.status !==
              "ratified" ||
            !ratification.source
          ) {
            failed += 1;
            failures.push({
              venueId: venue.id,
              name: venue.name,
              stage: "ratification",
              error:
                ratification.error ??
                "Source was not ratified.",
            });
            continue;
          }

          ratified += 1;

          const source: FirstPartySource = {
            id: `probe:${venue.id}`,
            provider: "first_party",
            source_type:
              ratification.source
                .sourceType,
            name:
              `${venue.name} official events`,
            source_url:
              ratification.source
                .sourceUrl,
            external_source_id:
              ratification.source
                .externalSourceId,
            venue_id: venue.id,
            is_enabled: true,
            trust_level: "trusted",
            config:
              ratification.source.config,
            bootstrapped_at: null,
          };

          const validation =
            await validateFirstPartySource(
              source
            );

          if (
            validation.status !==
            "validated"
          ) {
            failed += 1;
            failures.push({
              venueId: venue.id,
              name: venue.name,
              stage: "validation",
              error:
                validation.error ??
                "Source validation failed.",
            });
            continue;
          }

          validated += 1;

          const registration =
            ratification.source.sourceType === "facebook_events"
              ? await supabase.rpc(
                  "upsert_global_first_party_event_source",
                  {
                    p_source_type:
                      ratification.source.sourceType,
                    p_name:
                      `${venue.name} Facebook events`,
                    p_source_url:
                      ratification.source.sourceUrl,
                    p_external_source_id:
                      ratification.source.externalSourceId,
                    p_config:
                      ratification.source.config,
                  },
                )
              : await supabase.rpc(
                  "upsert_first_party_event_source",
                  {
                    p_venue_id: venue.id,
                    p_source_type:
                      ratification.source.sourceType,
                    p_name:
                      `${venue.name} official events`,
                    p_source_url:
                      ratification.source.sourceUrl,
                    p_external_source_id:
                      ratification.source.externalSourceId,
                    p_config:
                      ratification.source.config,
                  },
                );

          const {
            data: sourceId,
            error: registrationError,
          } = registration;

          if (
            registrationError ||
            !sourceId
          ) {
            throw new Error(
              registrationError?.message ??
                "Source registration returned no source ID."
            );
          }

          registered += 1;

          /*
           * A successfully registered structured first-party source
           * makes any calendar-image adapter finding non-actionable.
           * Resolve it immediately so candidate ordering within this
           * detector run cannot leave a stale queue item behind.
           */
          const {
            error: calendarResolutionError,
          } = await supabase.rpc(
            "resolve_event_harvest_detector_findings",
            {
              p_venue_id: venue.id,
              p_category: "calendar_image",
            }
          );

          if (calendarResolutionError) {
            throw new Error(
              `Could not resolve calendar-image findings after source registration: ${calendarResolutionError.message}`
            );
          }

          /*
           * A successfully registered Facebook adapter is no longer
           * actionable discovery work. Resolve the Facebook finding
           * after registration succeeds.
           */
          if (candidate.sourceType === "facebook") {
            const {
              error: facebookResolutionError,
            } = await supabase.rpc(
              "resolve_event_harvest_detector_findings",
              {
                p_venue_id: venue.id,
                p_category: "facebook",
              }
            );

            if (facebookResolutionError) {
              throw new Error(
                `Could not resolve Facebook findings after source registration: ${facebookResolutionError.message}`
              );
            }
          }
        } catch (error) {
          failed += 1;
          failures.push({
            venueId: venue.id,
            name: venue.name,
            stage: "source",
            error:
              error instanceof Error
                ? error.message
                : String(error),
          });
        }
      }
    } catch (error) {
      failed += 1;
      failures.push({
        venueId: venue.id,
        name: venue.name,
        stage: "detection",
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  return NextResponse.json({
    spots: venues?.length ?? 0,
    detected,
    ratified,
    validated,
    registered,
    unsupported,
    failed,
    failures,
  });
}
