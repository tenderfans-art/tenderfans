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

      if (
        detection.status === "detected"
      ) {
        detected += 1;
      }

      for (
        const candidate
        of detection.detections
      ) {
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

          const {
            data: sourceId,
            error: registrationError,
          } = await supabase.rpc(
            "upsert_first_party_event_source",
            {
              p_venue_id:
                venue.id,
              p_source_type:
                ratification.source
                  .sourceType,
              p_name:
                `${venue.name} official events`,
              p_source_url:
                ratification.source
                  .sourceUrl,
              p_external_source_id:
                ratification.source
                  .externalSourceId,
              p_config:
                ratification.source
                  .config,
            }
          );

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
