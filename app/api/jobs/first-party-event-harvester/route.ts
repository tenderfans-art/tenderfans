import { NextRequest, NextResponse } from "next/server";
import { getSpotExecutionSignal } from "@/lib/event-harvester/transport-capacity-context";
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

    const marketWorkId =
      request.nextUrl.searchParams.get("market_work_id");

    const marketLeaseToken =
      request.nextUrl.searchParams.get("market_lease_token");

    const hasMarketWork =
      marketWorkId !== null || marketLeaseToken !== null;

    if (hasMarketWork) {
      if (
        !venueId ||
        sourceId ||
        !marketWorkId ||
        !marketLeaseToken
      ) {
        return NextResponse.json(
          { error: "Invalid Spot Market execution identity" },
          { status: 400 },
        );
      }

      const { data: owned, error: ownershipError } =
        await supabase
          .from("event_processing_work")
          .select("id")
          .eq("id", marketWorkId)
          .eq("venue_id", venueId)
          .eq("work_type", "detect_spot")
          .eq("status", "leased")
          .eq("lease_token", marketLeaseToken)
          .gt("leased_until", new Date().toISOString())
          .maybeSingle();

      if (ownershipError || !owned) {
        return NextResponse.json(
          { error: "Spot Market work lease is not owned" },
          { status: 409 },
        );
      }
    }

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
      getSpotExecutionSignal()?.throwIfAborted();
      try {
        const result = await runRegisteredFirstPartySource(
          supabase,
          source,
          hasMarketWork
            ? {
                marketWork: {
                  workId: marketWorkId!,
                  leaseToken: marketLeaseToken!,
                },
              }
            : {},
        );

        results.push({
          sourceId: source.id,
          sourceName: source.name,
          ok: true,
          result,
        });
      } catch (error) {
        getSpotExecutionSignal()?.throwIfAborted();
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
