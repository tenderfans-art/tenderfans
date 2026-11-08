import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ClaimedWork,
  MarketBatchResult,
} from "./market-batch-executor";
import { withLeaseRenewal } from "./market-batch-executor";

type SupplementalMode = "provider" | "archive";

type SupplementalWork = ClaimedWork & {
  claimed_venue_id: string | null;
};

export async function executeMarketSupplementalWorkItem(
  supabase: SupabaseClient,
  marketId: string,
  mode: SupplementalMode,
  item: SupplementalWork,
): Promise<MarketBatchResult> {
  const result: MarketBatchResult = {
    claimed: 1,
    completed: 0,
    failed: 0,
    deferred: 0,
  };

  const leaseEnd = Date.parse(item.claimed_leased_until);

  if (!Number.isFinite(leaseEnd) || leaseEnd <= Date.now()) {
    result.deferred = 1;
    return result;
  }

  if (item.claimed_source_id !== null) {
    throw new Error("Supplemental work unexpectedly contains a source");
  }

  if (
    (mode === "archive" && !item.claimed_venue_id) ||
    (mode === "provider" && item.claimed_venue_id !== null)
  ) {
    throw new Error("Invalid supplemental work target");
  }

  let details: Record<string, unknown>;

  try {
    if (mode === "provider") {
      const secret = process.env.EVENT_HARVESTER_JOB_SECRET;
      if (!secret) {
        throw new Error("Ticketmaster job secret is missing");
      }

      const { NextRequest } = await import("next/server");
      const { POST } = await import(
        "@/app/api/jobs/event-harvester/route"
      );

      const request = new NextRequest(
        "https://tenderfans.internal/api/jobs/event-harvester",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            source: "ticketmaster",
            dryRun: false,
            marketId,
            marketWorkId: item.work_id,
            marketLeaseToken: item.claimed_lease_token,
          }),
        },
      );

      const response = await withLeaseRenewal(
        supabase,
        item.work_id,
        item.claimed_lease_token,
        () => POST(request),
      );

      const body = await response.json() as Record<string, unknown>;

      if (
        !response.ok ||
        body.ok !== true ||
        body.dryRun !== false ||
        body.marketId !== marketId
      ) {
        throw new Error(
          "Ticketmaster Market run failed: " +
          JSON.stringify(body).slice(0, 1200)
        );
      }

      details = {
        provider: "ticketmaster",
        spotsChecked: body.spotsChecked,
        eventsFound: body.eventsFound,
        directLifecycleChecked: body.directLifecycleChecked,
      };
    } else {
      const secret = process.env.CRON_SECRET;
      if (!secret) {
        throw new Error("Detector cron secret is missing");
      }

      const { GET } = await import(
        "@/app/api/jobs/first-party-event-detector/route"
      );

      const query = new URLSearchParams({
        mode: "archive-recheck",
        market_id: marketId,
        target_venue_id: item.claimed_venue_id!,
        market_work_id: item.work_id,
        market_lease_token: item.claimed_lease_token,
      });

      const request = new Request(
        "https://tenderfans.internal/api/jobs/" +
        "first-party-event-detector?" + query.toString(),
        {
          headers: { authorization: `Bearer ${secret}` },
        },
      );

      const response = await withLeaseRenewal(
        supabase,
        item.work_id,
        item.claimed_lease_token,
        () => GET(request),
      );

      const body = await response.json() as Record<string, unknown>;

      if (
        !response.ok ||
        body.spots !== 1 ||
        body.failed !== 0 ||
        body.bucketInvariantHolds !== true
      ) {
        throw new Error(
          "Archived Spot recheck failed: " +
          JSON.stringify(body).slice(0, 1200)
        );
      }

      details = {
        archiveVenueId: item.claimed_venue_id,
        detected: body.detected,
        validated: body.validated,
        registered: body.registered,
        buckets: body.buckets,
      };
    }
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : String(cause);

    const { data, error } = await supabase.rpc(
      "fail_event_processing_work",
      {
        p_work_id: item.work_id,
        p_lease_token: item.claimed_lease_token,
        p_error: message,
      },
    );

    if (error || data !== true) {
      throw new Error(
        "Supplemental execution failed and ownership could not " +
        "be updated: " + (error?.message ?? "Lease lost") +
        ". Original failure: " + message
      );
    }

    result.failed = 1;
    return result;
  }

  // The external operation succeeded. Do not mark it failed
  // merely because its completion acknowledgment fails.
  const { data: completed, error: completionError } =
    await supabase.rpc(
      "complete_event_processing_work",
      {
        p_work_id: item.work_id,
        p_lease_token: item.claimed_lease_token,
        p_result: details,
      },
    );

  if (completionError || completed !== true) {
    throw new Error(
      "Supplemental work completed but acknowledgment failed: " +
      (completionError?.message ?? "Lease lost")
    );
  }

  result.completed = 1;
  return result;
}
