import { createClient } from "@supabase/supabase-js";
import { start } from "workflow/api";
import { marketHarvesterWorkflow } from "@/workflows/market-harvester";

export const runtime = "nodejs";

type Candidate = {
  market_id: string;
  market_key: string;
  available_batch_slots: number;
  ready_items: number;
  oldest_due_at: string;
};

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;

  if (
    !secret ||
    request.headers.get("authorization") !== `Bearer ${secret}`
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    return Response.json(
      { error: "Supabase service credentials unavailable" },
      { status: 503 },
    );
  }

  const supabase = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data, error } = await supabase.rpc(
    "list_shared_harvester_markets",
  );

  if (error) {
    console.error("Shared market discovery failed", error);
    return Response.json(
      { error: "Shared market discovery failed" },
      { status: 503 },
    );
  }

  const candidates = (data ?? []) as Candidate[];

  if (candidates.length === 0) {
    return Response.json({
      status: "idle",
      reason: "No enabled markets with eligible harvester work",
    });
  }

  // One dispatch per invocation.
  // Actual admission remains protected by the existing market
  // claim RPC. This is discovery, not a global capacity reservation.
  const selected = candidates[0];

  try {
    const run = await start(
      marketHarvesterWorkflow,
      [selected.market_id],
    );

    return Response.json(
      {
        status: "accepted",
        runId: run.runId,
        marketId: selected.market_id,
        marketKey: selected.market_key,
      },
      { status: 202 },
    );
  } catch (cause) {
    console.error("Shared market dispatch failed", cause);

    return Response.json(
      { error: "Shared market dispatch failed" },
      { status: 503 },
    );
  }
}
