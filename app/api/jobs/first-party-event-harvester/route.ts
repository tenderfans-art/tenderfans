import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ingestFirstPartySource } from "@/lib/event-harvester/first-party/ingest";

export const maxDuration = 1800;

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Supabase admin environment variables are not configured."
    );
  }

  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function safeError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Unknown first-party harvester error.";
}

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

  try {
    const supabase = getAdminClient();

    const sourceId =
      request.nextUrl.searchParams.get(
        "source_id"
      );

    const venueId =
      request.nextUrl.searchParams.get(
        "venue_id"
      );

    let sourceQuery =
      supabase
        .from("event_harvest_sources")
        .select("id, name, venue_id, source_type, source_url")
        .eq("provider", "first_party")
        .eq("is_enabled", true);

    if (sourceId) {
      sourceQuery =
        sourceQuery.eq("id", sourceId);
    } else if (venueId) {
      sourceQuery =
        sourceQuery
          .eq("venue_id", venueId)
          .order(
            "created_at",
            { ascending: true }
          );
    } else {
      sourceQuery =
        sourceQuery.order(
          "created_at",
          { ascending: true }
        );
    }

    const { data: sources, error: sourceError } =
      await sourceQuery;

    if (sourceError) {
      throw new Error(
        `Could not load first-party harvest sources: ${sourceError.message}`
      );
    }

    const results = [];

    for (const source of sources ?? []) {
      try {
        const checkedAt = new Date().toISOString();

        const { error: checkedError } = await supabase
          .from("event_harvest_sources")
          .update({
            last_checked_at: checkedAt,
            updated_at: checkedAt,
          })
          .eq("id", source.id);

        if (checkedError) {
          throw new Error(
            `Could not record source check: ${checkedError.message}`
          );
        }

        let result: Awaited<ReturnType<typeof ingestFirstPartySource>>;

        try {
          result = await ingestFirstPartySource(
            supabase,
            source.id,
            { dryRun: false }
          );
        } catch (ingestError) {
          const message = safeError(ingestError);

          // Only technical calendar-image execution failures belong
          // in Adapter Errors. Content qualification stays in its
          // existing review/evaluation workflow.
          const technicalCalendarFailure =
            /calendar.image page returned HTTP \d+/i.test(message) ||
            /calendar image asset could not be fetched as a supported image/i.test(message);

          if (
            source.source_type === "calendar_image" &&
            source.venue_id &&
            source.source_url &&
            technicalCalendarFailure
          ) {
            const { error: findingError } = await supabase.rpc(
              "upsert_event_harvest_detector_finding",
              {
                p_venue_id: source.venue_id,
                p_category: "adapter_error",
                p_finding_key: `adapter_error:${JSON.stringify(["calendar_image", source.source_url])}`,
                p_detector_status: "adapter_failed",
                p_source_type: "calendar_image",
                p_website_url: source.source_url,
                p_source_url: source.source_url,
                p_fetched_url: null,
                p_confidence: null,
                p_evidence: [
                  "Registered calendar-image source failed during ingestion",
                ],
                p_error: message,
              }
            );

            if (findingError) {
              throw new Error(
                `Calendar-image Adapter Error persistence failed: ${findingError.message}; original failure: ${message}`
              );
            }
          }

          throw ingestError;
        }

        if (
          source.source_type === "calendar_image" &&
          source.venue_id &&
          source.source_url
        ) {
          const { error: resolutionError } = await supabase.rpc(
            "resolve_event_harvest_adapter_error",
            {
              p_venue_id: source.venue_id,
              p_finding_key: `adapter_error:${JSON.stringify(["calendar_image", source.source_url])}`,
            }
          );

          if (resolutionError) {
            throw new Error(
              `Calendar-image Adapter Error resolution failed: ${resolutionError.message}`
            );
          }
        }

        const succeededAt = new Date().toISOString();

        const { error: successError } = await supabase
          .from("event_harvest_sources")
          .update({
            last_success_at: succeededAt,
            last_error: null,
            updated_at: succeededAt,
          })
          .eq("id", source.id);

        if (successError) {
          throw new Error(
            `Could not record source success: ${successError.message}`
          );
        }

        results.push({
          sourceId: source.id,
          sourceName: source.name,
          ok: true,
          result,
        });
      } catch (error) {
        /*
         * One broken Spot feed must not prevent the remaining
         * first-party sources from being harvested.
         */
        const message = safeError(error);
        const failedAt = new Date().toISOString();

        const { error: failureRecordError } = await supabase
          .from("event_harvest_sources")
          .update({
            last_error: message,
            updated_at: failedAt,
          })
          .eq("id", source.id);

        results.push({
          sourceId: source.id,
          sourceName: source.name,
          ok: false,
          error: failureRecordError
            ? `${message} (Could not record source failure: ${failureRecordError.message})`
            : message,
        });
      }
    }

    return NextResponse.json({
      ok: results.every((result) => result.ok),
      provider: "first_party",
      sourcesChecked: results.length,
      succeeded: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      results,
    });
  } catch (error) {
    return NextResponse.json(
      { error: safeError(error) },
      { status: 500 }
    );
  }
}
