import { getWorkflowMetadata } from "workflow";

import type {
  ClaimedWork,
  MarketBatchResult,
} from "@/lib/event-harvester/market-batch-executor";

function makeResult(claimed: number): MarketBatchResult {
  return {
    claimed,
    completed: 0,
    failed: 0,
    deferred: 0,
  };
}

async function claimBatch(marketId: string): Promise<ClaimedWork[]> {
  "use step";

  const { createClient } = await import("@supabase/supabase-js");
  const { claimMarketHarvesterBatch } = await import(
    "@/lib/event-harvester/market-batch-executor"
  );

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url || !secret) {
    throw new Error("Missing Supabase service credentials");
  }

  const supabase = createClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return claimMarketHarvesterBatch(supabase, marketId);
}

async function claimReservedSource(
  reservationId: string,
  slotNumber: number,
): Promise<ClaimedWork | null> {
  "use step";

  const { createClient } = await import("@supabase/supabase-js");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url || !secret) {
    throw new Error("Missing Supabase service credentials");
  }

  const supabase = createClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });


  // Check immutable assignments first: replay must return the
  // original claim without being blocked by an admission cutoff.
  const { data: priorAssignment, error: priorError } =
    await supabase
      .from("shared_harvester_source_assignments")
      .select("work_id")
      .eq("reservation_id", reservationId)
      .eq("slot_number", slotNumber)
      .maybeSingle();

  if (priorError) {
    throw new Error(
      "Assignment replay check failed: " + priorError.message,
    );
  }

  if (!priorAssignment) {
    const { data: reservation, error: reservationError } =
      await supabase
        .from("event_processing_dispatch_reservations")
        .select("status,reserved_at")
        .eq("id", reservationId)
        .single();

    if (reservationError || !reservation) {
      throw new Error("Reservation deadline unavailable");
    }

    if (!["reserved", "claimed"].includes(reservation.status)) {
      return null;
    }

    // The dispatcher enforces a 30-minute ceiling measured from
    // reserved_at. expires_at is renewable and is NOT that ceiling.
    const admissionCutoff =
      Date.parse(reservation.reserved_at) +
      20 * 60_000;

    if (!Number.isFinite(admissionCutoff)) {
      throw new Error("Invalid reservation start time");
    }

    // Leave ten minutes before the dispatcher's cancellation
    // deadline for newly claimed executions.
    if (Date.now() >= admissionCutoff) {
      return null;
    }
  }

  const { data, error } = await supabase.rpc(
    "claim_shared_harvester_assignment",
    {
      p_reservation_id: reservationId,
      p_slot_number: slotNumber,
    },
  );

  if (error) {
    throw new Error(
      `Source assignment failed: ${error.message}`,
    );
  }

  const items = (data ?? []) as ClaimedWork[];

  if (items.length > 1) {
    throw new Error("Single-source claim returned multiple items");
  }

  return items[0] ?? null;
}

async function renewReservedBatch(
  reservationId: string,
): Promise<void> {
  "use step";

  const { createClient } = await import("@supabase/supabase-js");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url || !secret) {
    throw new Error("Missing Supabase service credentials");
  }

  const supabase = createClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data, error } = await supabase.rpc(
    "renew_shared_harvester_reservation",
    { p_reservation_id: reservationId },
  );

  if (error) {
    throw new Error(
      `Reservation renewal failed: ${error.message}`,
    );
  }

  if (data !== true) {
    throw new Error(
      "Reservation ownership expired or was closed",
    );
  }
}

async function finalizeReservedBatch(
  reservationId: string,
): Promise<void> {
  "use step";

  const { createClient } = await import("@supabase/supabase-js");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url || !secret) {
    throw new Error("Missing Supabase service credentials");
  }

  const supabase = createClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data, error } = await supabase.rpc(
    "finalize_shared_harvester_reservation",
    { p_reservation_id: reservationId },
  );

  if (error) {
    throw new Error(
      `Reservation finalization failed: ${error.message}`,
    );
  }

  if (data !== true) {
    throw new Error(
      "Reservation finalization was not acknowledged",
    );
  }
}



async function bindReservedBatchRun(
  marketId: string,
  reservationId: string,
  runId: string,
): Promise<void> {
  "use step";

  const { createClient } = await import("@supabase/supabase-js");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url || !secret) {
    throw new Error("Missing Supabase service credentials");
  }

  const supabase = createClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data, error } = await supabase.rpc(
    "bind_shared_harvester_workflow_run",
    {
      p_market_id: marketId,
      p_reservation_id: reservationId,
      p_run_id: runId,
    },
  );

  if (error || data !== true) {
    throw new Error(
      "Workflow run binding failed: " +
      (error?.message ?? "Reservation ownership unavailable"),
    );
  }
}

async function claimDetectorBatch(
  marketId: string,
): Promise<import(
  "@/lib/event-harvester/market-detector-executor"
).ClaimedDetectorWork[]> {
  "use step";

  const { createClient } =
    await import("@supabase/supabase-js");

  const { claimMarketDetectorBatch } = await import(
    "@/lib/event-harvester/market-detector-executor"
  );

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error("Missing Supabase credentials");
  }

  const db = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return claimMarketDetectorBatch(db, marketId);
}

async function executeDetector(
  item: import(
    "@/lib/event-harvester/market-detector-executor"
  ).ClaimedDetectorWork,
): Promise<MarketBatchResult> {
  "use step";

  const { createClient } =
    await import("@supabase/supabase-js");

  const { executeMarketDetectorWorkItem } =
    await import(
      "@/lib/event-harvester/market-detector-executor"
    );

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error("Missing Supabase credentials");
  }

  const db = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return executeMarketDetectorWorkItem(db, item);
}

async function executeSource(
  item: ClaimedWork,
): Promise<MarketBatchResult> {
  "use step";

  const { createClient } = await import("@supabase/supabase-js");
  const { executeMarketHarvesterWorkItem } = await import(
    "@/lib/event-harvester/market-batch-executor"
  );

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url || !secret) {
    throw new Error("Missing Supabase service credentials");
  }

  const supabase = createClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return executeMarketHarvesterWorkItem(supabase, item);
}

async function executeSupplemental(
  item: ClaimedWork,
  marketId: string,
  mode: "provider" | "archive",
): Promise<MarketBatchResult> {
  "use step";

  const { createClient } = await import("@supabase/supabase-js");
  const { executeMarketSupplementalWorkItem } = await import(
    "@/lib/event-harvester/market-supplemental-executor"
  );

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url || !secret) {
    throw new Error("Missing Supabase service credentials");
  }

  const db = createClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return executeMarketSupplementalWorkItem(
    db,
    marketId,
    mode,
    item as ClaimedWork & { claimed_venue_id: string | null },
  );
}

export async function marketHarvesterWorkflow(
  marketId: string,
  reservationId?: string,
  mode: "harvest" | "detect" | "provider" | "archive" = "harvest",
  configuredBatchSize = 10,
): Promise<MarketBatchResult> {
  "use workflow";

  // Bind the authoritative Workflow identity before any shared
  // source assignment can be claimed.
  if (reservationId) {
    const { workflowRunId } = getWorkflowMetadata();

    await bindReservedBatchRun(
      marketId,
      reservationId,
      workflowRunId,
    );
  }

  if (
    !reservationId &&
    (mode === "provider" || mode === "archive")
  ) {
    throw new Error("Supplemental work requires shared reservation");
  }

  if (mode === "detect" && !reservationId) {
    const work = await claimDetectorBatch(marketId);
    const result = makeResult(work.length);
    let firstError: unknown;

    for (let offset = 0; offset < work.length; offset += 2) {
      const outcomes = await Promise.allSettled(
        work.slice(offset, offset + 2).map(executeDetector),
      );

      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          firstError ??= outcome.reason;
        } else {
          result.completed += outcome.value.completed;
          result.failed += outcome.value.failed;
          result.deferred += outcome.value.deferred;
        }
      }
    }

    if (firstError !== undefined) {
      throw firstError;
    }

    return result;
  }

  // Legacy market-specific dispatch retains its original claim path.
  if (!reservationId) {
    const work = await claimBatch(marketId);
    const result = makeResult(work.length);
    let firstStepError: unknown;

    for (let offset = 0; offset < work.length; offset += 2) {
      const outcomes = await Promise.allSettled(
        work.slice(offset, offset + 2).map(executeSource),
      );

      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          firstStepError ??= outcome.reason;
        } else {
          result.completed += outcome.value.completed;
          result.failed += outcome.value.failed;
          result.deferred += outcome.value.deferred;
        }
      }
    }

    if (firstStepError !== undefined) {
      throw firstStepError;
    }

    return result;
  }


  // Continuous, independently refilling execution lanes.
  // Each lane owns deterministic, immutable assignment numbers.
  // No lane waits for another lane before claiming more work.
  const result = makeResult(0);

  const maxSourcesPerRun =
    Number.isSafeInteger(configuredBatchSize) &&
    configuredBatchSize > 0
      ? Math.min(10, configuredBatchSize)
      : 10;

  const sourceConcurrency = Math.min(8, maxSourcesPerRun);

  // Bound the event log and avoid endlessly retaining one
  // Workflow reservation. Provider work remains single-shot.
  const maxAssignmentsPerRun =
    mode === "provider"
      ? 1
      : Math.min(64, maxSourcesPerRun * 8);

  let originalFailure: unknown = null;

  try {
    const outcomes = await Promise.allSettled(
      Array.from(
        { length: sourceConcurrency },
        async (_, laneIndex): Promise<MarketBatchResult> => {
          const laneResult = makeResult(0);

          // Unique per-lane slot sequences:
          // lane 0: 0,8,16...
          // lane 1: 1,9,17...
          // Each successful execution immediately frees its lane.
          for (
            let slotNumber = laneIndex;
            slotNumber < maxAssignmentsPerRun;
            slotNumber += sourceConcurrency
          ) {
            await renewReservedBatch(reservationId);

            const item = await claimReservedSource(
              reservationId,
              slotNumber,
            );

            if (!item) {
              break;
            }

            laneResult.claimed += 1;

            // Existing executors retain ALL original detection,
            // harvesting, review and retry behavior.
            const execution =
              mode === "detect"
                ? await executeDetector(
                    item as import(
                      "@/lib/event-harvester/market-detector-executor"
                    ).ClaimedDetectorWork,
                  )
                : mode === "harvest"
                  ? await executeSource(item)
                  : await executeSupplemental(
                      item,
                      marketId,
                      mode,
                    );

            laneResult.completed += execution.completed;
            laneResult.failed += execution.failed;
            laneResult.deferred += execution.deferred;
          }

          return laneResult;
        },
      ),
    );

    let executionError: unknown;

    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        executionError ??= outcome.reason;
      } else {
        result.claimed += outcome.value.claimed;
        result.completed += outcome.value.completed;
        result.failed += outcome.value.failed;
        result.deferred += outcome.value.deferred;
      }
    }

    // Wait for EVERY lane before propagating unexpected errors.
    // No successful claim is abandoned by another lane failing.
    if (executionError !== undefined) {
      throw executionError;
    }

    return result;
  } catch (cause) {
    originalFailure = cause;
    throw cause;
  } finally {
    // Preserve the existing fenced reservation finalization.
    try {
      await finalizeReservedBatch(reservationId);
    } catch (finalizationError) {
      if (originalFailure !== null) {
        console.error(
          "Shared reservation finalization deferred after " +
          "the original execution failure:",
          finalizationError,
        );
      } else {
        throw finalizationError;
      }
    }
  }
}
