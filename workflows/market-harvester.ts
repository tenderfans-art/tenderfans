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
): Promise<MarketBatchResult> {
  "use workflow";

  const work = await claimBatch(marketId);
  const result = makeResult(work.length);

  // Bound source concurrency independently of batch admission.
  // Each executeSource call is its own durable Workflow step.
  const sourceConcurrency = 2;

  for (let offset = 0; offset < work.length; offset += sourceConcurrency) {
    const group = work.slice(offset, offset + sourceConcurrency);

    const outcomes = await Promise.allSettled(
      group.map((item) => executeSource(item)),
    );

    let groupError: unknown;

    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        groupError ??= outcome.reason;
        continue;
      }

      result.completed += outcome.value.completed;
      result.failed += outcome.value.failed;
      result.deferred += outcome.value.deferred;
    }

    if (groupError !== undefined) {
      throw groupError;
    }
  }

  return result;
}
