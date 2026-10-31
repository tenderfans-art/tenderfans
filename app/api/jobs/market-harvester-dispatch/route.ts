import { createClient } from "@supabase/supabase-js";
import { start } from "workflow/api";
import { marketHarvesterWorkflow } from "@/workflows/market-harvester";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;

  if (
    !secret ||
    request.headers.get("authorization") !== `Bearer ${secret}`
  ) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;

  if (!url || !serviceKey) {
    return Response.json(
      { error: "Supabase service credentials unavailable" },
      { status: 503 },
    );
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON" },
      { status: 400 },
    );
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    !("marketId" in payload) ||
    typeof payload.marketId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      payload.marketId,
    )
  ) {
    return Response.json(
      { error: "A valid marketId UUID is required" },
      { status: 400 },
    );
  }

  const marketId = payload.marketId;

  const supabase = createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data: market, error } = await supabase
    .from("event_processing_markets")
    .select("id,is_enabled")
    .eq("id", marketId)
    .maybeSingle();

  if (error) {
    return Response.json(
      { error: "Market lookup failed" },
      { status: 503 },
    );
  }

  if (!market) {
    return Response.json(
      { error: "Market not found" },
      { status: 404 },
    );
  }

  if (!market.is_enabled) {
    return Response.json(
      { error: "Market is disabled" },
      { status: 409 },
    );
  }

  try {
    const run = await start(marketHarvesterWorkflow, [marketId]);

    return Response.json(
      {
        status: "accepted",
        runId: run.runId,
        marketId,
      },
      { status: 202 },
    );
  } catch (cause) {
    console.error("Market workflow dispatch failed", cause);

    return Response.json(
      { error: "Workflow dispatch failed" },
      { status: 503 },
    );
  }
}
