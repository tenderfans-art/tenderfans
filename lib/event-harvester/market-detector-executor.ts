import type { SupabaseClient } from "@supabase/supabase-js";

import {
  withLeaseRenewal,
  type ClaimedWork,
  type MarketBatchResult,
} from "./market-batch-executor";

export type ClaimedDetectorWork = ClaimedWork & {
  claimed_venue_id: string | null;
};

export async function claimMarketDetectorBatch(
  supabase: SupabaseClient,
  marketId: string,
): Promise<ClaimedDetectorWork[]> {
  const { data, error } = await supabase.rpc(
    "claim_event_processing_batch",
    {
      p_market_id: marketId,
      p_work_type: "detect_spot",
      p_lease_minutes: 180,
    },
  );

  if (error) {
    throw new Error(
      `Market detector claim failed: ${error.message}`,
    );
  }

  return (data ?? []) as ClaimedDetectorWork[];
}

export async function executeMarketDetectorWorkItem(
  supabase: SupabaseClient,
  item: ClaimedDetectorWork,
): Promise<MarketBatchResult> {
  const result: MarketBatchResult = {
    claimed: 1,
    completed: 0,
    failed: 0,
    deferred: 0,
  };

  if (!item.claimed_venue_id) {
    throw new Error(
      `Detector work ${item.work_id} has no Spot ID`,
    );
  }

  const leaseEnd = Date.parse(
    item.claimed_leased_until,
  );

  if (
    !Number.isFinite(leaseEnd) ||
    leaseEnd <= Date.now()
  ) {
    result.deferred += 1;
    return result;
  }

  try {
    const secret = process.env.CRON_SECRET;

    if (!secret) {
      throw new Error(
        "CRON_SECRET is not configured",
      );
    }

    /*
     * Reuse the established detector implementation.
     * Invoke its route handler directly inside a Workflow step.
     * No new detector or network round trip.
     */
    const { GET } = await import(
      "@/app/api/jobs/first-party-event-detector/route"
    );

    const request = new Request(
      "https://tenderfans.internal/api/jobs/" +
        "first-party-event-detector?venue_id=" +
        encodeURIComponent(item.claimed_venue_id),
      {
        headers: {
          authorization: `Bearer ${secret}`,
        },
      },
    );

    const response = await withLeaseRenewal(
      supabase,
      item.work_id,
      item.claimed_lease_token,
      () => GET(request),
    );

    const body = await response.json() as {
      spots?: number;
      bucketInvariantHolds?: boolean;
      failed?: number;
      detected?: number;
      ratified?: number;
      validated?: number;
      registered?: number;
      buckets?: Record<string, number>;
    };

    if (
      !response.ok ||
      body.spots !== 1 ||
      body.bucketInvariantHolds !== true ||
      body.failed !== 0
    ) {
      throw new Error(
        "Detector returned unsuccessful result: " +
        JSON.stringify(body).slice(0, 1200),
      );
    }

    const { data: completed, error } =
      await supabase.rpc(
        "complete_event_processing_work",
        {
          p_work_id: item.work_id,
          p_lease_token: item.claimed_lease_token,
          p_result: {
            detected: body.detected,
            ratified: body.ratified,
            validated: body.validated,
            registered: body.registered,
            buckets: body.buckets,
          },
        },
      );

    if (error || completed !== true) {
      throw new Error(
        "Detector completion was not acknowledged: " +
        (error?.message ?? "Lease expired"),
      );
    }

    result.completed = 1;
    return result;

  } catch (cause) {
    const message =
      cause instanceof Error
        ? cause.message
        : String(cause);

    const { data: recorded, error } =
      await supabase.rpc(
        "fail_event_processing_work",
        {
          p_work_id: item.work_id,
          p_lease_token: item.claimed_lease_token,
          p_error: message,
        },
      );

    if (error || recorded !== true) {
      throw new Error(
        "Detector failed and work ownership could not " +
        "be updated: " +
        (error?.message ?? "Lease expired") +
        ". Original error: " + message,
      );
    }

    result.failed = 1;
    return result;
  }
}
