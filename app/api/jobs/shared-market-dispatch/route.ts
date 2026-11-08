import { createClient } from "@supabase/supabase-js";
import { start } from "workflow/api";
import { marketHarvesterWorkflow } from "@/workflows/market-harvester";

export const runtime = "nodejs";

// Bounds starts per HTTP request; database RPCs enforce actual capacity.
const MAX_WORKFLOW_STARTS_PER_TICK = 16;

type Reservation = {
  reservation_id: string;
  selected_market_id: string;
  selected_market_key: string;
  reservation_expires_at: string;
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

  // Replenish due work for enabled Markets only.
  const { error: queueError } = await supabase.rpc(
    "enqueue_due_market_processing",
  );

  if (queueError) {
    console.error(
      "Market queue reconciliation failed",
      queueError,
    );

    return Response.json(
      { error: "Market queue reconciliation failed" },
      { status: 503 },
    );
  }

  // Recovery is bounded and only affects expired market-bound
  // executions. Standalone source executions are never recovered.
  const { error: recoveryError } = await supabase.rpc(
    "recover_expired_market_source_executions",
    { p_limit: 100 },
  );

  if (recoveryError) {
    console.error("Shared source recovery failed", recoveryError);
    return Response.json(
      { error: "Shared source recovery failed" },
      { status: 503 },
    );
  }

  const { error: reconciliationError } = await supabase.rpc(
    "reconcile_shared_harvester_reservations",
  );

  if (reconciliationError) {
    console.error(
      "Shared reservation reconciliation failed",
      reconciliationError,
    );
    return Response.json(
      { error: "Shared reservation reconciliation failed" },
      { status: 503 },
    );
  }

  // One dispatcher invocation fills available reservations using
  // the existing atomic admission RPC. No Worker admits more work.
  const runs: Array<{
    runId: string;
    reservationId: string;
    marketId: string;
    marketKey: string;
    batchSize: number;
    mode: "harvest" | "detect";
  }> = [];

  for (
    let attempt = 0;
    attempt < MAX_WORKFLOW_STARTS_PER_TICK;
    attempt += 1
  ) {
    const { data, error } = await supabase.rpc(
      "reserve_shared_harvester_batch",
    );

    if (error) {
      console.error("Shared admission failed", error);
      return Response.json(
        { error: "Shared admission failed", accepted: runs },
        { status: 503 },
      );
    }

    const reservation = (data as Reservation[] | null)?.[0];

    if (!reservation) {
      break;
    }

    try {
      // Reservation identity and work type remain database-owned.
      const { data: reservedWork, error: reservedError } =
        await supabase
          .from("event_processing_dispatch_reservations")
          .select("work_type")
          .eq("id", reservation.reservation_id)
          .eq("market_id", reservation.selected_market_id)
          .single();

      if (
        reservedError ||
        !reservedWork ||
        !["harvest_source", "detect_spot"].includes(
          reservedWork.work_type,
        )
      ) {
        throw new Error("Shared reservation work type unavailable");
      }

      const { data: market, error: marketError } = await supabase
        .from("event_processing_markets")
        .select("harvester_batch_size,detector_batch_size")
        .eq("id", reservation.selected_market_id)
        .single();

      if (marketError || !market) {
        throw new Error("Market processing configuration unavailable");
      }

      const mode =
        reservedWork.work_type === "detect_spot"
          ? "detect"
          : "harvest";

      const batchSize =
        mode === "detect"
          ? market.detector_batch_size
          : market.harvester_batch_size;

      if (
        !Number.isSafeInteger(batchSize) ||
        batchSize < 1 ||
        batchSize > 100
      ) {
        throw new Error("Invalid Market batch configuration");
      }

      const run = await start(marketHarvesterWorkflow, [
        reservation.selected_market_id,
        reservation.reservation_id,
        mode,
        batchSize,
      ]);

      runs.push({
        runId: run.runId,
        reservationId: reservation.reservation_id,
        marketId: reservation.selected_market_id,
        marketKey: reservation.selected_market_key,
        batchSize,
        mode,
      });
    } catch (cause) {
      console.error("Shared dispatch failed", cause);

      const { error: releaseError } = await supabase.rpc(
        "release_shared_harvester_reservation",
        { p_reservation_id: reservation.reservation_id },
      );

      if (releaseError) {
        console.error("Reservation release failed", releaseError);
      }

      return Response.json(
        { error: "Shared dispatch failed", accepted: runs },
        { status: 503 },
      );
    }
  }

  // Preserve original single-run response fields for operators.
  const first = runs[0];

  return Response.json(
    {
      status: runs.length ? "accepted" : "idle",
      ...(first
        ? {
            runId: first.runId,
            reservationId: first.reservationId,
            marketId: first.marketId,
            marketKey: first.marketKey,
          }
        : {
            reason: "No eligible Market or available shared capacity",
          }),
      runs,
    },
    { status: runs.length ? 202 : 200 },
  );
}

// Vercel scheduled requests use GET.
// Reuse the existing authorization and dispatch logic.
export async function GET(request: Request) {
  return POST(request);
}
