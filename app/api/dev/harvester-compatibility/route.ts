import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import {
  detectFirstPartySources,
  type SiteDetectionResult,
} from "@/lib/event-harvester/first-party/source-detector";

import {
  ratifyDetectedSource,
  type SourceRatification,
} from "@/lib/event-harvester/first-party/ratify";

import {
  validateFirstPartySource,
  type FirstPartySourceValidation,
} from "@/lib/event-harvester/first-party/validate";

import type {
  FirstPartySource,
} from "@/lib/event-harvester/first-party/preview";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const venueId =
    searchParams.get("venueId")?.trim() || null;

  const detectOnly =
    searchParams.get("detectOnly") === "1";

  const start = Math.max(
    0,
    Number.parseInt(searchParams.get("start") ?? "0", 10) || 0
  );

  const requestedEnd =
    Number.parseInt(searchParams.get("end") ?? String(start + 29), 10) ||
    start + 29;

  const end = Math.max(
    start,
    Math.min(requestedEnd, start + 59)
  );
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", {
      status: 404,
    });
  }

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!
    );

    let venueQuery = supabase
      .from("venues")
      .select(
        "id,name,website_url,street_address,city,state_region,postal_code,country_code,latitude,longitude"
      )
      .eq("status", "active")
      .not("website_url", "is", null);

    if (venueId) {
      venueQuery = venueQuery.eq("id", venueId);
    } else {
      venueQuery = venueQuery
        .order("created_at", { ascending: false })
        .range(start, end);
    }

    const { data: venues, error } = await venueQuery;

    if (error) {
      throw new Error(
        `Could not load Spots: ${error.message}`
      );
    }

    type RatificationProbe = {
      detectedUrl: string;
      ratification: SourceRatification;
      validation: FirstPartySourceValidation | null;
    };

    const results: Array<
      SiteDetectionResult & {
        venueId: string;
        name: string;
        ratificationProbes: RatificationProbe[];
      }
    > = [];

    /*
     * Sequential on purpose for this first experiment.
     * We're probing third-party websites and don't need to
     * generate a 30-site request burst.
     */
    for (const venue of venues ?? []) {
      if (!venue.website_url) {
        continue;
      }

      const detection =
        await detectFirstPartySources(
          venue.website_url
        );

      const ratificationProbes: RatificationProbe[] = [];

      /*
       * Exercise every detected source for which TenderFans has
       * an implemented adapter.
       *
       * Provider-specific attribution remains inside the
       * ratifier. Eventbrite receives its stronger physical-venue
       * check there; ordinary first-party event surfaces can
       * proceed directly to adapter validation.
       */
      for (const candidate of detection.detections) {
        if (detectOnly || !candidate.adapterAvailable) {
          continue;
        }

        const ratification =
          await ratifyDetectedSource(
            candidate,
            {
              name: venue.name,
              streetAddress:
                venue.street_address,
              city: venue.city,
              region: venue.state_region,
              postalCode:
                venue.postal_code,
              country:
                venue.country_code,
              latitude: venue.latitude,
              longitude: venue.longitude,
            }
          );

        let validation:
          | FirstPartySourceValidation
          | null = null;

        if (
          ratification.status ===
          "ratified"
        ) {
          /*
           * Validation is deliberately read-only. Build the
           * transient source shape expected by the existing
           * preview adapter without registering anything in
           * event_harvest_sources.
           */
          const source: FirstPartySource = {
            id: `probe:${venue.id}`,
            provider: "first_party",
            source_type:
              ratification.source.sourceType,
            name:
              `${venue.name} compatibility probe`,
            source_url:
              ratification.source.sourceUrl,
            external_source_id:
              ratification.source.externalSourceId,
            venue_id: venue.id,
            is_enabled: true,
            trust_level: "trusted",
            config:
              ratification.source.config,
            bootstrapped_at: null,
          };

          validation =
            await validateFirstPartySource(
              source
            );
        }

        ratificationProbes.push({
          detectedUrl: candidate.url,
          ratification,
          validation,
        });
      }

      results.push({
        venueId: venue.id,
        name: venue.name,
        ...detection,
        ratificationProbes,
      });
    }

    const summarize = (
      rows: typeof results
    ) => ({
      spots: rows.length,
      detected: rows.filter(
        (r) => r.status === "detected"
      ).length,
      noEventSource: rows.filter(
        (r) => r.status === "no_event_source"
      ).length,
      transportBlocked: rows.filter(
        (r) => r.status === "transport_blocked"
      ).length,
      transportFailed: rows.filter(
        (r) => r.status === "transport_failed"
      ).length,
      externalRedirect: rows.filter(
        (r) => r.status === "external_redirect"
      ).length,
      supportedDetection: rows.filter(
        (r) =>
          r.detections.some(
            (d) => d.supported
          )
      ).length,
      unsupportedDetection: rows.filter(
        (r) =>
          r.detections.some(
            (d) => !d.supported
          )
      ).length,
      calendarImage: rows.filter(
        (r) =>
          r.detections.some(
            (d) => d.sourceType === "calendar_image"
          )
      ).length,
      spotHopper: rows.filter(
        (r) =>
          r.detections.some(
            (d) => d.sourceType === "spothopper_events"
          )
      ).length,
      sharedEventCalendar: rows.filter(
        (r) =>
          r.detections.some(
            (d) => d.sourceType === "shared_event_calendar"
          )
      ).length,
      ratified: rows.filter(
        (r) =>
          r.ratificationProbes.some(
            (probe) =>
              probe.ratification.status ===
              "ratified"
          )
      ).length,
      validated: rows.filter(
        (r) =>
          r.ratificationProbes.some(
            (probe) =>
              probe.validation?.status ===
              "validated"
          )
      ).length,
      validatedWithInventory: rows.filter(
        (r) =>
          r.ratificationProbes.some(
            (probe) =>
              probe.validation?.status ===
                "validated" &&
              probe.validation.inventory ===
                "available"
          )
      ).length,
    });

    return NextResponse.json({
      sample: summarize(results),
      results,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      { status: 500 }
    );
  }
}
