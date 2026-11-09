import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  "supabase/migrations/119_terminal_workflow_settlement.sql",
  "utf8",
);
const workflow = readFileSync(
  "workflows/market-harvester.ts",
  "utf8",
);
const dispatcher = readFileSync(
  "app/api/jobs/shared-market-dispatch/route.ts",
  "utf8",
);

test("Workflow identity is durable and unique", () => {
  assert.match(
    sql,
    /create unique index[\s\S]*?on public\.event_processing_dispatch_reservations\(workflow_run_id\)/i,
  );
  assert.match(sql, /r\.workflow_run_id = p_run_id/);
  assert.match(sql, /r\.market_id = p_market_id/);
  assert.match(sql, /auth\.role\(\) <> 'service_role'/);
});

test("Workflow binds its run before admitting any work", () => {
  assert.match(workflow, /getWorkflowMetadata\(\)/);
  assert.match(
    workflow,
    /"bind_shared_harvester_workflow_run"/,
  );

  const bind = workflow.indexOf(
    "await bindReservedBatchRun("
  );
  const claim = workflow.indexOf(
    "await renewReservedBatch(reservationId)"
  );

  assert.ok(bind >= 0 && claim > bind);
});

test("only SDK-confirmed terminal runs are reconciled", () => {
  assert.match(dispatcher, /getRun\(runId\)\.status/);
  assert.match(
    dispatcher,
    /"settle_terminal_shared_harvester_run"/,
  );
  assert.match(dispatcher, /"completed"/);
  assert.match(dispatcher, /"failed"/);
  assert.match(dispatcher, /"cancelled"/);
  assert.doesNotMatch(
    dispatcher,
    /minutes_since_update|heartbeat_age|force_release/,
  );
});

test("settlement is fenced to original ownership", () => {
  assert.match(sql, /a\.reservation_id = v_reservation\.id/);
  assert.match(sql, /a\.work_id = w\.id/);
  assert.match(sql, /w\.status = 'leased'/);
  assert.match(sql, /w\.lease_token = a\.lease_token/);
  assert.match(sql, /r\.workflow_run_id = p_run_id/);
});

test("settlement retains original retry and failure policy", () => {
  assert.match(sql, /w\.attempts >= w\.max_attempts/);
  assert.match(sql, /then 'failed'/);
  assert.match(sql, /else 'retry'/);
  assert.match(sql, /power\(/);
  assert.match(sql, /lease_token = null/);
  assert.match(sql, /leased_until = null/);
  assert.match(sql, /last_finished_at = v_now/);
});

test("work settlement precedes reservation release", () => {
  const workUpdate = sql.indexOf(
    "update public.event_processing_work w"
  );
  const reservationRelease = sql.indexOf(
    "update public.event_processing_dispatch_reservations r",
    workUpdate
  );

  assert.ok(workUpdate >= 0);
  assert.ok(reservationRelease > workUpdate);
  assert.match(
    sql,
    /if v_reservation\.status in \('released', 'expired'\)/,
  );
});

test("existing source-lock recovery is reused", () => {
  assert.match(
    dispatcher,
    /postSettlementRecoveryError/,
  );
  assert.match(
    dispatcher,
    /"recover_expired_market_source_executions"/,
  );
  assert.doesNotMatch(
    sql,
    /delete from public\.first_party_source_executions/i,
  );
});

test("finalization preserves original execution failure", () => {
  assert.match(workflow, /originalFailure = cause/);
  assert.match(workflow, /throw cause/);
  assert.match(workflow, /if \(originalFailure !== null\)/);
  assert.match(
    workflow,
    /await finalizeReservedBatch\(reservationId\)/,
  );
});

test("migration retains existing scheduling and publication", () => {
  assert.doesNotMatch(
    sql,
    /update public\.event_processing_markets/i,
  );
  assert.doesNotMatch(
    sql,
    /update public\.event_harvest_sources/i,
  );
  assert.doesNotMatch(
    sql,
    /update public\.events\b/i,
  );
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
});
