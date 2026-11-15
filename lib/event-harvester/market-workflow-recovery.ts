import type { SupabaseClient } from "@supabase/supabase-js";

/** Include closed reservations that still own expired, unacknowledged work. */
export async function loadSharedWorkflowReconciliationRuns(supabase: SupabaseClient) {
  const result = await supabase.rpc("list_shared_harvester_runs_to_reconcile", { p_limit: 32 });
  if (result.error && ["PGRST202", "42883"].includes(result.error.code)) {
    // Keep the existing dispatcher operational while migration 129 or its
    // PostgREST schema-cache refresh is still pending.
    return supabase.from("event_processing_dispatch_reservations")
      .select("id,workflow_run_id,reserved_at")
      .in("status", ["reserved", "claimed"])
      .not("workflow_run_id", "is", null)
      .order("reserved_at", { ascending: true }).limit(32);
  }
  return result;
}
