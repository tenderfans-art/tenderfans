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
  configuredBatchSize = 10,
): Promise<MarketBatchResult> {
  "use workflow";

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

  // Shared dispatch: claim only when an execution slot is ready.
  // Each durable assignment slot has an immutable claim snapshot.
  const result = makeResult(0);
  // Market-configured batch size is captured at dispatch.
  // Eight simultaneous steps per Workflow can fill a
  // 16-source Market through two admitted Workflows.
  // Actual source admission remains database-controlled.
  const maxSourcesPerRun =
    Number.isSafeInteger(configuredBatchSize) &&
    configuredBatchSize > 0
      ? Math.min(10, configuredBatchSize)
      : 10;
  const sourceConcurrency = Math.min(8, maxSourcesPerRun);

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
        mode === "detect"
          ? work.map((item) =>
              executeDetector(
                item as import(
                  "@/lib/event-harvester/market-detector-executor"
                ).ClaimedDetectorWork,
              ),
            )
          : work.map(executeSource),
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

    return result;
  } finally {
    // Runs after success, claim failure, or execution failure.
    // The database RPC must still refuse release when a live
    // assignment retains its lease.
    await finalizeReservedBatch(reservationId);
  }
}
