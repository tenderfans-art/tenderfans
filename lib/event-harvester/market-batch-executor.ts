import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestFirstPartySource } from "./first-party/ingest";
import { runWithTransportRecovery } from "./transport-recovery-context";

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
      // Restore the established standalone harvester lifecycle metadata
      // and recovery context while using the SAME ingestion function and
      // the existing Market-bound source execution/lease fencing.
      const { data: source, error: sourceError } = await supabase
        .from("event_harvest_sources")
        .select("id,venue_id,source_type,source_url")
        .eq("id", item.claimed_source_id)
        .eq("provider", "first_party")
        .eq("is_enabled", true)
        .single();

      if (sourceError || !source) {
        throw new Error(
          "Could not load approved first-party source for Market work: " +
          (sourceError?.message ?? item.claimed_source_id),
        );
      }

      const checkedAt = new Date().toISOString();
      const { error: checkError } = await supabase
        .from("event_harvest_sources")
        .update({ last_checked_at: checkedAt, updated_at: checkedAt })
        .eq("id", source.id);

      if (checkError) {
        throw new Error(
          "Could not record first-party source check: " +
          checkError.message,
        );
      }

      const ingest = () => ingestFirstPartySource(
        supabase,
        item.claimed_source_id!,
        {
          dryRun: false,
          marketWork: {
            workId: item.work_id,
            leaseToken: item.claimed_lease_token,
          },
        },
      );

      const proxyUrl = process.env.TENDERFANS_TRANSPORT_PROXY_URL;

      try {
        ingested = await withLeaseRenewal(
          supabase,
          item.work_id,
          item.claimed_lease_token,
          () =>
            proxyUrl
              ? runWithTransportRecovery(proxyUrl, ingest)
              : ingest(),
        );
      } catch (ingestError) {
        const message =
          ingestError instanceof Error
            ? ingestError.message
            : String(ingestError);

        // Exact existing calendar-image adapter-error classification.
        const technicalCalendarFailure =
          /calendar.image page returned HTTP \\d+/i.test(message) ||
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
            },
          );

          if (findingError) {
            throw new Error(
              "Calendar-image Adapter Error persistence failed: " +
              findingError.message + "; original failure: " + message,
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
          },
        );

        if (resolutionError) {
          throw new Error(
            "Calendar-image Adapter Error resolution failed: " +
            resolutionError.message,
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
          "Could not record first-party source success: " +
          successError.message,
        );
      }
    } catch (cause) {
      if (isSourceBusy(cause) || cause instanceof MarketLeaseLostError) {
        result.deferred += 1;
        return result;
      }

      const message =
        cause instanceof Error ? cause.message : String(cause);

      const failedAt = new Date().toISOString();
      const { error: sourceFailureError } = await supabase
        .from("event_harvest_sources")
        .update({ last_error: message, updated_at: failedAt })
        .eq("id", item.claimed_source_id!);

      if (sourceFailureError) {
        console.error(
          "Could not record first-party source failure",
          item.claimed_source_id,
          sourceFailureError.message,
        );
      }

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
