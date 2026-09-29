import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ingestFirstPartySource } from "@/lib/event-harvester/first-party/ingest";

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

    const { data: sources, error: sourceError } =
      await supabase
        .from("event_harvest_sources")
        .select("id, name")
        .eq("provider", "first_party")
        .eq("is_enabled", true)
        .order("created_at", { ascending: true });

    if (sourceError) {
      throw new Error(
        `Could not load first-party harvest sources: ${sourceError.message}`
      );
    }

    const results = [];

    for (const source of sources ?? []) {
      try {
        const result = await ingestFirstPartySource(
          supabase,
          source.id,
          { dryRun: false }
        );

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
        results.push({
          sourceId: source.id,
          sourceName: source.name,
          ok: false,
          error: safeError(error),
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
