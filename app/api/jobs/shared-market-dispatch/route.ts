import { createClient } from "@supabase/supabase-js";
import { getRun, start } from "workflow/api";
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

  let requestedMarketId: string | null = null;

  if (request.method === "POST") {
    const raw = await request.text();

    if (raw.trim()) {
      let payload: unknown;

      try {
        payload = JSON.parse(raw);
      } catch {
        return Response.json(
          { error: "Invalid JSON" },
          { status: 400 },
        );
      }

      if (
        payload &&
        typeof payload === "object" &&
        "marketId" in payload
      ) {
        const marketId = payload.marketId;

        if (
          typeof marketId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            .test(marketId)
        ) {
          return Response.json(
            { error: "Invalid Market ID" },
            { status: 400 },
          );
        }

        requestedMarketId = marketId;
      }
    }
  }

  const supabase = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  if (requestedMarketId) {
    const { data: requestedMarket, error: requestedError } =
      await supabase
        .from("event_processing_markets")
        .select("id,is_enabled")
        .eq("id", requestedMarketId)
        .maybeSingle();

    if (requestedError) {
      return Response.json(
        { error: "Market lookup failed" },
        { status: 503 },
      );
    }

    if (!requestedMarket) {
      return Response.json(
        { error: "Market not found" },
        { status: 404 },
      );
    }

    if (!requestedMarket.is_enabled) {
      return Response.json(
        { error: "Market is disabled" },
        { status: 409 },
      );
    }
  }

  // Replenish due work for enabled Markets only.
  const { error: queueError } = await supabase.rpc(
    "enqueue_due_market_processing",
    requestedMarketId
      ? { p_market_id: requestedMarketId }
      : {},
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

  const { error: supplementalQueueError } =
    await supabase.rpc(
      "enqueue_due_market_supplemental_processing",
      requestedMarketId
        ? { p_market_id: requestedMarketId }
        : {},
    );

  if (supplementalQueueError) {
    return Response.json(
      { error: "Supplemental Market queue failed" },
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


  /*
   * Terminal Workflow recovery is part of the EXISTING
   * shared dispatcher. Never infer failure from elapsed time,
   * a quiet heartbeat, or a transport-permit expiry.
   *
   * Only the Workflow SDK's definitive terminal status
   * authorizes fenced settlement of the bound reservation.
   */
  const { data: liveRuns, error: liveRunsError } =
    await supabase
      .from("event_processing_dispatch_reservations")
      .select("id,workflow_run_id")
      .in("status", ["reserved", "claimed"])
      .not("workflow_run_id", "is", null)
      .order("reserved_at", { ascending: true })
      .limit(32);

  if (liveRunsError) {
    return Response.json(
      { error: "Workflow reconciliation lookup failed" },
      { status: 503 },
    );
  }

  let terminalRunsSettled = 0;

  for (const reservation of liveRuns ?? []) {
    const runId = reservation.workflow_run_id;

    if (typeof runId !== "string" || !runId) {
      continue;
    }

    let runStatus: string;

    try {
      runStatus = await getRun(runId).status;
    } catch (cause) {
      // An unavailable status is NOT evidence of termination.
      // Preserve ownership until status can be verified.
      console.error(
        "Could not verify shared Workflow status:",
        runId,
        cause,
      );
      continue;
    }

    if (
      ![
        "completed",
        "failed",
        "cancelled",
        "canceled",
      ].includes(runStatus)
    ) {
      continue;
    }

    const { data: settled, error: settlementError } =
      await supabase.rpc(
        "settle_terminal_shared_harvester_run",
        {
          p_reservation_id: reservation.id,
          p_run_id: runId,
          p_terminal_status: runStatus,
        },
      );

    if (
      settlementError ||
      typeof settled !== "number"
    ) {
      console.error(
        "Terminal Workflow settlement failed:",
        runId,
        settlementError,
      );

      return Response.json(
        { error: "Terminal Workflow settlement failed" },
        { status: 503 },
      );
    }

    terminalRunsSettled += 1;

    console.info(
      "[shared-market-terminal-settlement]",
      JSON.stringify({
        runId,
        reservationId: reservation.id,
        status: runStatus,
        unsettledAssignments: settled,
      }),
    );
  }

  if (terminalRunsSettled > 0) {
    // Reuse the existing fenced source-lock recovery RPC.
    // Once work ownership changes, old bound source executions
    // become invalid and may be recovered safely.
    const { error: postSettlementRecoveryError } =
      await supabase.rpc(
        "recover_expired_market_source_executions",
        { p_limit: 100 },
      );

    if (postSettlementRecoveryError) {
      console.error(
        "Post-settlement source recovery failed",
        postSettlementRecoveryError,
      );

      return Response.json(
        { error: "Post-settlement source recovery failed" },
        { status: 503 },
      );
    }
  }

  // One dispatcher invocation fills available reservations using
  // the existing atomic admission RPC. No Worker admits more work.
  const runs: Array<{
    runId: string;
    reservationId: string;
    marketId: string;
    marketKey: string;
    batchSize: number;
    mode: "harvest" | "detect" | "provider" | "archive";
  }> = [];

  for (
    let attempt = 0;
    attempt < MAX_WORKFLOW_STARTS_PER_TICK;
    attempt += 1
  ) {
    const { data, error } = requestedMarketId
      ? await supabase.rpc(
          "reserve_shared_harvester_batch_for_market",
          { p_market_id: requestedMarketId },
        )
      : await supabase.rpc(
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
        ![
          "harvest_source",
          "detect_spot",
          "archive_recheck",
          "harvest_provider",
        ].includes(
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
          : reservedWork.work_type === "archive_recheck"
            ? "archive"
            : reservedWork.work_type === "harvest_provider"
              ? "provider"
              : "harvest";

      const batchSize =
        mode === "provider"
          ? 1
          : mode === "archive"
            ? market.detector_batch_size
            : mode === "detect"
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
