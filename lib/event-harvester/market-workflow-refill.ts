import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClaimedWork } from "./market-batch-executor";

export type RefillWork = ClaimedWork & {
  claimed_work_type: "detect_spot" | "harvest_source" | "archive_recheck" | "harvest_provider";
  claimed_venue_id: string | null;
};
export type RefillInstruction =
  | { kind: "work"; item: RefillWork }
  | { kind: "wait"; delay_ms: number }
  | { kind: "stop" };

export function parseRefillInstruction(value: unknown): RefillInstruction {
  if (!value || typeof value !== "object") throw new Error("Invalid refill response");
  const instruction = value as Record<string, unknown>;
  if (instruction.kind === "stop") return { kind: "stop" };
  if (instruction.kind === "wait" && typeof instruction.delay_ms === "number" &&
      Number.isSafeInteger(instruction.delay_ms) && instruction.delay_ms >= 1000 && instruction.delay_ms <= 60_000) {
    return { kind: "wait", delay_ms: instruction.delay_ms };
  }
  if (instruction.kind === "work" && instruction.item && typeof instruction.item === "object") {
    const item = instruction.item as Record<string, unknown>;
    if (typeof item.work_id === "string" && typeof item.claimed_lease_token === "string" &&
        typeof item.claimed_leased_until === "string" && Number.isFinite(Date.parse(item.claimed_leased_until)) &&
        typeof item.claimed_work_type === "string" &&
        ["detect_spot", "harvest_source", "archive_recheck", "harvest_provider"].includes(item.claimed_work_type) &&
        (item.claimed_venue_id === null || typeof item.claimed_venue_id === "string") &&
        (item.claimed_source_id === null || typeof item.claimed_source_id === "string")) {
      return { kind: "work", item: {
        work_id: item.work_id,
        claimed_lease_token: item.claimed_lease_token,
        claimed_leased_until: item.claimed_leased_until,
        claimed_work_type: item.claimed_work_type as RefillWork["claimed_work_type"],
        claimed_venue_id: item.claimed_venue_id,
        claimed_source_id: item.claimed_source_id,
      } };
    }
  }
  throw new Error("Invalid refill response");
}

export async function prepareSharedMarketRefill(supabase: SupabaseClient, reservationId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("prepare_shared_market_refill", { p_reservation_id: reservationId });
  if (error && ["PGRST202", "42883"].includes(error.code)) return false;
  if (error || typeof data !== "boolean") throw new Error("Market refill preparation failed");
  return data;
}

export async function refillingMarketCancellationAt(
  supabase: SupabaseClient, reservationId: string, runId: string,
): Promise<number | null> {
  const { data, error } = await supabase.rpc("reconcile_shared_market_refill", {
    p_reservation_id: reservationId, p_run_id: runId,
  });
  if (error) throw new Error("Market refill recovery check failed");
  if (data === null) return null;
  if (typeof data !== "string" || !Number.isFinite(Date.parse(data))) {
    throw new Error("Invalid Market refill recovery deadline");
  }
  return Date.parse(data);
}
