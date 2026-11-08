import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  runRegisteredFirstPartySource,
  recordFirstPartySourceFailure,
} from "@/lib/event-harvester/first-party/registered-source-runner";

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
        const result = await runRegisteredFirstPartySource(
          supabase,
          source,
        );

        results.push({
          sourceId: source.id,
          sourceName: source.name,
          ok: true,
          result,
        });
      } catch (error) {
        // One broken feed must not stop remaining sources.
        const message = await recordFirstPartySourceFailure(
          supabase,
          source.id,
          error,
        );

        results.push({
          sourceId: source.id,
          sourceName: source.name,
          ok: false,
          error: message,
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
