import { createClient } from "@supabase/supabase-js";
import { start } from "workflow/api";
import { marketHarvesterWorkflow } from "@/workflows/market-harvester";

export const runtime = "nodejs";

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

  const { data, error } = await supabase.rpc(
    "reserve_shared_harvester_batch",
  );

  if (error) {
    console.error("Shared admission failed", error);
    return Response.json(
      { error: "Shared admission failed" },
      { status: 503 },
    );
  }

  const reservation = (data as Reservation[] | null)?.[0];

  if (!reservation) {
    return Response.json({
      status: "idle",
      reason: "No eligible market or available shared capacity",
    });
  }

  try {
    const run = await start(marketHarvesterWorkflow, [
      reservation.selected_market_id,
      reservation.reservation_id,
    ]);

    return Response.json(
      {
        status: "accepted",
        runId: run.runId,
        reservationId: reservation.reservation_id,
        marketId: reservation.selected_market_id,
        marketKey: reservation.selected_market_key,
      },
      { status: 202 },
    );
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
      { error: "Shared dispatch failed" },
      { status: 503 },
    );
  }
}

// Vercel scheduled requests use GET.
// Reuse the existing authorization and dispatch logic.
export async function GET(request: Request) {
  return POST(request);
}
