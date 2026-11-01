import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestFirstPartySource } from "./first-party/ingest";

export interface MarketBatchResult {
  claimed: number;
  completed: number;
  failed: number;
  deferred: number;
}

export interface ClaimedWork {
  work_id: string;
  claimed_lease_token: string;
  claimed_source_id: string | null;
  claimed_leased_until: string;
}

type BatchDatabase = SupabaseClient;

function isSourceBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^First-party source .+ is already being ingested\.$/.test(
      error.message,
    )
  );
}

/**
 * Execute one already-configured market harvester batch.
 *
 * This function does not schedule itself, modify market
 * membership, or bypass the existing ingestion lifecycle.
 *
 * Source-lock contention is deferred: the work lease remains
 * in place and the claim RPC may reconsider it after expiry.
 */
/**
 * Renew an owned work lease while its ingestion is running.
 *
 * A failed renewal is recorded and propagated after ingestion.
 * This does not cancel ingestion or fence database writes.
 */
export class MarketLeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketLeaseLostError";
  }
}

export async function withLeaseRenewal<T>(
  supabase: BatchDatabase,
  workId: string,
  leaseToken: string,
  operation: () => Promise<T>,
  intervalMs = 60_000,
): Promise<T> {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Invalid lease renewal interval");
  }

  const controller = new AbortController();
  let renewalFailure: Error | null = null;
  let inFlight: Promise<void> | null = null;

  const renew = async (): Promise<void> => {
    try {
      const { data, error } = await supabase.rpc(
        "renew_event_processing_lease",
        {
          p_work_id: workId,
          p_lease_token: leaseToken,
          p_lease_minutes: 180,
        },
      );

      if (error || data !== true) {
        renewalFailure = new MarketLeaseLostError(
          `Lease renewal failed for work ${workId}: ${
            error?.message ?? "Lease ownership expired"
          }`,
        );
      }
    } catch (cause) {
      renewalFailure = new MarketLeaseLostError(
        `Lease renewal request failed for work ${workId}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  };

  const heartbeat = async (): Promise<void> => {
    while (!controller.signal.aborted && !renewalFailure) {
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve();
          }, intervalMs);

          const onAbort = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", onAbort);
            reject(new Error("Heartbeat stopped"));
          };

          controller.signal.addEventListener(
            "abort",
            onAbort,
            { once: true },
          );
        });
      } catch {
        break;
      }

      if (controller.signal.aborted || renewalFailure) {
        break;
      }

      inFlight = renew();
      await inFlight;
      inFlight = null;
    }
  };

  const heartbeatPromise = heartbeat();

  let value: T | undefined;
  let operationError: unknown;
  let operationFailed = false;

  try {
    value = await operation();
  } catch (cause) {
    operationFailed = true;
    operationError = cause;
  } finally {
    controller.abort();
    await heartbeatPromise;

    if (inFlight) {
      await inFlight;
    }
  }

  if (operationFailed) {
    throw operationError;
  }

  if (renewalFailure) {
    throw renewalFailure;
  }

  return value as T;
}

export async function claimMarketHarvesterBatch(
  supabase: BatchDatabase,
  marketId: string,
): Promise<ClaimedWork[]> {
  const { data, error } = await supabase.rpc(
    "claim_event_processing_batch",
    {
      p_market_id: marketId,
      p_work_type: "harvest_source",
      p_lease_minutes: 180,
    },
  );

  if (error) {
    throw new Error(
      `Could not claim market harvester batch: ${error.message}`,
    );
  }

  return (data ?? []) as ClaimedWork[];
}

export async function executeMarketHarvesterWorkItem(
  supabase: BatchDatabase,
  item: ClaimedWork,
): Promise<MarketBatchResult> {
  const result: MarketBatchResult = {
    claimed: 1,
    completed: 0,
    failed: 0,
    deferred: 0,
  };

    if (!item.claimed_source_id) {
      throw new Error(
        `Claimed harvester work ${item.work_id} has no source ID`,
      );
    }

    /*
     * Never start a source whose lease is already expired.
     * This is a preflight check, not a substitute for
     * transaction-level fencing of ingestion writes.
     */
    if (
      !Number.isFinite(Date.parse(item.claimed_leased_until)) ||
      Date.parse(item.claimed_leased_until) <= Date.now()
    ) {
      result.deferred += 1;
      return result;
    }

    let ingested;

    try {
      ingested = await withLeaseRenewal(
        supabase,
        item.work_id,
        item.claimed_lease_token,
        () =>
          ingestFirstPartySource(
            supabase,
            item.claimed_source_id!,
            {
              dryRun: false,
              marketWork: {
                workId: item.work_id,
                leaseToken: item.claimed_lease_token,
              },
            },
          ),
      );
    } catch (cause) {
      if (isSourceBusy(cause) || cause instanceof MarketLeaseLostError) {
        result.deferred += 1;
        return result;
      }

      const message =
        cause instanceof Error ? cause.message : String(cause);

      const { data: recorded, error: failureError } =
        await supabase.rpc("fail_event_processing_work", {
          p_work_id: item.work_id,
          p_lease_token: item.claimed_lease_token,
          p_error: message,
        });

      if (failureError || recorded !== true) {
        throw new Error(
          `Market work ${item.work_id} failed, but its failure ` +
          `could not be recorded: ${
            failureError?.message ?? "Lease ownership expired"
          }. Original error: ${message}`,
        );
      }

      result.failed += 1;
      return result;
    }

    // Ingestion succeeded. Never mark it failed merely because
    // recording completion fails.
    const { data: completed, error: completeError } =
      await supabase.rpc("complete_event_processing_work", {
        p_work_id: item.work_id,
        p_lease_token: item.claimed_lease_token,
        p_result: {
          discovered: ingested.discovered,
          processed: ingested.processed,
          linkedExisting: ingested.linkedExisting,
          graduated: ingested.graduated,
          synced: ingested.synced,
          needsReview: ingested.needsReview,
        },
      });

    if (completeError || completed !== true) {
      throw new Error(
        `Ingestion succeeded for market work ${item.work_id}, ` +
        `but completion could not be recorded: ${
          completeError?.message ?? "Lease ownership expired"
        }`,
      );
    }

    result.completed += 1;
  return result;
}

export async function executeMarketHarvesterBatch(
  supabase: BatchDatabase,
  marketId: string,
): Promise<MarketBatchResult> {
  const work = await claimMarketHarvesterBatch(supabase, marketId);

  const result: MarketBatchResult = {
    claimed: work.length,
    completed: 0,
    failed: 0,
    deferred: 0,
  };

  for (const item of work) {
    const outcome = await executeMarketHarvesterWorkItem(
      supabase,
      item,
    );

    result.completed += outcome.completed;
    result.failed += outcome.failed;
    result.deferred += outcome.deferred;
  }

  return result;
}
