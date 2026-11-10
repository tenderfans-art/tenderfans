import type { SupabaseClient } from "@supabase/supabase-js";

import {
  withLeaseRenewal,
  type ClaimedWork,
  type MarketBatchResult,
} from "./market-batch-executor";
import {
  runWithSpotExecutionSignal,
} from "./transport-capacity-context";

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
      `Spot work ${item.work_id} has no Spot ID`,
    );
  }

  const leaseEnd = Date.parse(item.claimed_leased_until);

  if (!Number.isFinite(leaseEnd) || leaseEnd <= Date.now()) {
    result.deferred = 1;
    return result;
  }

  try {
    const secret = process.env.CRON_SECRET;

    if (!secret) {
      throw new Error("CRON_SECRET is not configured");
    }

    const spotId = item.claimed_venue_id;

    const { data: spot, error: spotError } =
      await supabase
        .from("venues")
        .select("website_url")
        .eq("id", spotId)
        .maybeSingle();

    if (spotError || !spot) {
      throw new Error(
        "Could not load Market Spot: " +
        (spotError?.message ?? spotId),
      );
    }

    /*
     * One Spot owns one Market work lease through BOTH original
     * execution stages. No additional work reservation is made.
     *
     * Each original route retains all existing adapters,
     * validations, source reviews, event reviews, and publishing.
     */
    const cycle = await withLeaseRenewal(
      supabase,
      item.work_id,
      item.claimed_lease_token,
      (spotSignal) => runWithSpotExecutionSignal(
        spotSignal,
        async () => {
        let detection: Record<string, unknown> | null = null;
        let detectorError: string | null = null;

        /*
         * The original detector requires a website.
         * Approved sources still harvest if a Spot has no website.
         */
        if (spot.website_url?.trim()) {
          try {
            const { GET: detect } = await import(
              "@/app/api/jobs/first-party-event-detector/route"
            );

            const request = new Request(
              "https://tenderfans.internal/api/jobs/" +
              "first-party-event-detector?venue_id=" +
              encodeURIComponent(spotId),
              {
                headers: {
                  authorization: `Bearer ${secret}`,
                },
              },
            );

            const response = await detect(request);
            const body = await response.json() as Record<
              string, unknown
            >;

            detection = body;

            if (
              !response.ok ||
              body.spots !== 1 ||
              body.bucketInvariantHolds !== true ||
              body.failed !== 0
            ) {
              detectorError =
                "Detector returned unsuccessful result: " +
                JSON.stringify(body).slice(0, 1200);
            }
          } catch (error) {
            detectorError =
              "Detector execution failed: " +
              (error instanceof Error
                ? error.message
                : String(error));
          }
        }

        /*
         * ALWAYS continue to harvesting, including when detection
         * failed. This preserves the original independent CRON
         * behavior for already-approved sources.
         *
         * Use the original venue_id harvester route, not a copy
         * of its source selection or ingestion logic.
         */
        // Do not start another stage after the Spot budget expires.
        spotSignal.throwIfAborted();

        const { GET: harvest } = await import(
          "@/app/api/jobs/first-party-event-harvester/route"
        );

        const { NextRequest } = await import("next/server");

        const query = new URLSearchParams({
          venue_id: spotId,
          market_work_id: item.work_id,
          market_lease_token: item.claimed_lease_token,
        });

        const request = new NextRequest(
          "https://tenderfans.internal/api/jobs/" +
          "first-party-event-harvester?" + query.toString(),
          {
            headers: {
              authorization: `Bearer ${secret}`,
            },
          },
        );

        const response = await harvest(request);

        const harvesting = await response.json() as Record<
          string, unknown
        >;

        const harvesterError =
          !response.ok ||
          harvesting.ok !== true ||
          typeof harvesting.sourcesChecked !== "number"
            ? "Harvester returned unsuccessful result: " +
              JSON.stringify(harvesting).slice(0, 1200)
            : null;

        return {
          detection,
          harvesting,
          detectorError,
          harvesterError,
        };
        },
      ),
      60_000,
      10 * 60_000,
    );

    if (cycle.detectorError || cycle.harvesterError) {
      throw new Error(
        [
          cycle.detectorError,
          cycle.harvesterError,
        ].filter(Boolean).join("; "),
      );
    }

    /*
     * Only now is the selected Spot cycle completed.
     * This is after the harvester has released every source lock.
     */
    const { data: completed, error } =
      await supabase.rpc("complete_event_processing_work", {
        p_work_id: item.work_id,
        p_lease_token: item.claimed_lease_token,
        p_result: {
          detected: cycle.detection?.detected ?? 0,
          ratified: cycle.detection?.ratified ?? 0,
          validated: cycle.detection?.validated ?? 0,
          registered: cycle.detection?.registered ?? 0,
          buckets: cycle.detection?.buckets ?? {},
          sourcesChecked: cycle.harvesting.sourcesChecked,
          sourcesSucceeded: cycle.harvesting.succeeded,
          sourcesFailed: cycle.harvesting.failed,
        },
      });

    if (error || completed !== true) {
      throw new Error(
        "Spot cycle completion was not acknowledged: " +
        (error?.message ?? "Lease expired"),
      );
    }

    result.completed = 1;
    return result;
  } catch (cause) {
    const message = cause instanceof Error
      ? cause.message
      : String(cause);

    const { data: recorded, error } =
      await supabase.rpc("fail_event_processing_work", {
        p_work_id: item.work_id,
        p_lease_token: item.claimed_lease_token,
        p_error: message,
      });

    if (error || recorded !== true) {
      throw new Error(
        "Spot cycle failed and ownership could not be updated: " +
        (error?.message ?? "Lease expired") +
        ". Original error: " + message,
      );
    }

    result.failed = 1;
    return result;
  }
}
