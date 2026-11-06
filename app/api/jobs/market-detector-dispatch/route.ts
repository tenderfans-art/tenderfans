import { createClient } from "@supabase/supabase-js";
import { start } from "workflow/api";
import { marketHarvesterWorkflow } from "@/workflows/market-harvester";

export const runtime = "nodejs";

type DueMarket = {
  market_id: string;
  market_key: string;
};

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;

  if (
    !secret ||
    request.headers.get("authorization") !==
      `Bearer ${secret}`
  ) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    return Response.json(
      { error: "Supabase credentials unavailable" },
      { status: 503 },
    );
  }

  const db = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { error: queueError } = await db.rpc(
    "enqueue_due_market_processing",
  );

  if (queueError) {
    return Response.json(
      { error: queueError.message },
      { status: 503 },
    );
  }

  const { data, error } = await db.rpc(
    "list_due_market_detector_work",
  );

  if (error) {
    return Response.json(
      { error: error.message },
      { status: 503 },
    );
  }

  const runs = [];

  for (const market of (data ?? []) as DueMarket[]) {
    try {
      const run = await start(
        marketHarvesterWorkflow,
        [market.market_id, "", "detect"],
      );

      runs.push({
        market: market.market_key,
        runId: run.runId,
      });
    } catch (cause) {
      console.error(
        "Detector Workflow dispatch failed",
        market.market_key,
        cause,
      );

      return Response.json(
        {
          error: "Detector dispatch failed",
          accepted: runs,
        },
        { status: 503 },
      );
    }
  }

  return Response.json({
    status: runs.length ? "accepted" : "idle",
    runs,
  });
}

export async function POST(request: Request) {
  return GET(request);
}
