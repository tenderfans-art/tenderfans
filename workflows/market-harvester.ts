import type {
  ClaimedWork,
  MarketBatchResult,
} from "@/lib/event-harvester/market-batch-executor";
import { start } from "workflow/api";

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


type NextSharedReservation = {
  reservation_id: string;
  selected_market_id: string;
};

async function reserveNextSharedBatch(): Promise<NextSharedReservation | null> {
  "use step";

  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error("Missing Supabase service credentials");
  }

  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error: recoveryError } = await db.rpc(
    "recover_expired_market_source_executions",
    { p_limit: 100 },
  );
  if (recoveryError) {
    throw new Error(`Shared recovery failed: ${recoveryError.message}`);
  }

  const { error: reconciliationError } = await db.rpc(
    "reconcile_shared_harvester_reservations",
  );
  if (reconciliationError) {
    throw new Error(
      `Shared reservation reconciliation failed: ${reconciliationError.message}`,
    );
  }

  const { data, error } = await db.rpc("reserve_shared_harvester_batch");
  if (error) {
    throw new Error(`Shared admission failed: ${error.message}`);
  }

  const reservation = (data as NextSharedReservation[] | null)?.[0];
  return reservation ?? null;
}

async function releaseUnstartedSharedBatch(reservationId: string): Promise<void> {
  "use step";

  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error("Missing Supabase service credentials");
  }
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await db.rpc(
    "release_shared_harvester_reservation",
    { p_reservation_id: reservationId },
  );
  if (error || data !== true) {
    throw new Error(
      `Could not release unstarted shared reservation: ${error?.message ?? "not reserved"}`,
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

export async function marketHarvesterWorkflow(
  marketId: string,
  reservationId?: string,
  mode: "harvest" | "detect" = "harvest",
): Promise<MarketBatchResult> {
  "use workflow";

  if (mode === "detect") {
    if (reservationId) {
      throw new Error(
        "Detector execution cannot use a source reservation",
      );
    }

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

    // Only continue when at least one item reached a terminal result.
    // A batch consisting entirely of deferred/expired leases must not
    // create an unbounded chain of otherwise identical Workflow runs.
    // The claim RPC enforces Market enablement and batch capacity.
    if (result.completed + result.failed > 0) {
      await start(marketHarvesterWorkflow, [marketId, "", "detect"]);
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

  // Shared dispatch: claim only when an execution slot is ready.
  // Each durable assignment slot has an immutable claim snapshot.
  const result = makeResult(0);
  const sourceConcurrency = 2;
  const maxSourcesPerRun = 10;

  try {
    for (
      let offset = 0;
      offset < maxSourcesPerRun;
      offset += sourceConcurrency
    ) {
      await renewReservedBatch(reservationId);

      const claims = await Promise.allSettled(
        Array.from(
          {
            length: Math.min(
              sourceConcurrency,
              maxSourcesPerRun - offset,
            ),
          },
          (_, index) =>
            claimReservedSource(reservationId, offset + index),
        ),
      );

      const work: ClaimedWork[] = [];
      let claimError: unknown;

      for (const claim of claims) {
        if (claim.status === "rejected") {
          claimError ??= claim.reason;
        } else if (claim.value) {
          work.push(claim.value);
        }
      }

      // Never abandon a successful claim just because another
      // claim in the same group failed.
      result.claimed += work.length;

      const outcomes = await Promise.allSettled(
        work.map(executeSource),
      );

      let executionError: unknown;

      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          executionError ??= outcome.reason;
        } else {
          result.completed += outcome.value.completed;
          result.failed += outcome.value.failed;
          result.deferred += outcome.value.deferred;
        }
      }

      if (claimError !== undefined) {
        throw claimError;
      }

      if (executionError !== undefined) {
        throw executionError;
      }

      if (work.length === 0) {
        break;
      }
    }

  } finally {
    // Runs after success, claim failure, or execution failure.
    // The database RPC must still refuse release when a live
    // assignment retains its lease.
    await finalizeReservedBatch(reservationId);
  }

  // A single reservation processes at most ten sources. On Hobby,
  // scheduled jobs run at most daily, so chain the remaining work
  // through newly admitted, independently fenced Workflow runs.
  // Never chain an all-deferred or empty batch.
  if (result.completed + result.failed > 0) {
    const next = await reserveNextSharedBatch();
    if (next) {
      try {
        await start(marketHarvesterWorkflow, [
          next.selected_market_id,
          next.reservation_id,
        ]);
      } catch (error) {
        await releaseUnstartedSharedBatch(next.reservation_id);
        throw error;
      }
    }
  }

  return result;
}
