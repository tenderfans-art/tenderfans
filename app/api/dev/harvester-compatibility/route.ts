import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import {
  detectFirstPartySources,
  type SiteDetectionResult,
} from "@/lib/event-harvester/first-party/source-detector";

export const dynamic = "force-dynamic";

export async function GET() {
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

    const { data: venues, error } = await supabase
      .from("venues")
      .select("id,name,website_url")
      .eq("status", "active")
      .not("website_url", "is", null)
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) {
      throw new Error(
        `Could not load Spots: ${error.message}`
      );
    }

    const results: Array<
      SiteDetectionResult & {
        venueId: string;
        name: string;
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

      results.push({
        venueId: venue.id,
        name: venue.name,
        ...detection,
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
