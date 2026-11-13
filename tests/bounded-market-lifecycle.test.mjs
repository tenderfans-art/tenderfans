import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  "supabase/migrations/122_bounded_market_execution_lifecycle.sql",
  "utf8",
);
const dispatch = readFileSync(
  "app/api/jobs/shared-market-dispatch/route.ts",
  "utf8",
);

test("work leases have a database-enforced 30-minute ceiling", () => {
  assert.match(sql, /new\.leased_until := least\(/);
  assert.match(sql, /new\.last_started_at \+ interval '30 minutes'/);
  assert.match(sql, /before insert or update\s+on public\.event_processing_work/i);
});

test("Workflow reservations have a 30-minute ceiling", () => {
  assert.match(sql, /new\.expires_at := least\(/);
  assert.match(sql, /new\.reserved_at \+ interval '30 minutes'/);
});

test("Workflow-bound reservations are protected until settlement", () => {
  assert.match(
    sql,
    /old\.workflow_run_id is not null[\s\S]*?new\.status = 'expired'[\s\S]*?return null/,
  );
});

test("expired source tokens cannot pass ownership checks", () => {
  assert.match(sql, /assert_first_party_execution_ownership/);
  assert.match(sql, /for update;[\s\S]*?30 minutes/);
  assert.match(sql, /execution deadline exceeded/);
});

test("standalone lock recovery preserves token ownership", () => {
  assert.match(sql, /recover_expired_standalone_source_executions/);
  assert.match(sql, /market_work_id is null/);
  assert.match(sql, /for update skip locked/);
  assert.match(sql, /execution_token = v_lock\.execution_token/);
  assert.match(sql, /first_party_execution_recoveries/);
});

test("obsolete queue cleanup preserves event inventory", () => {
  assert.match(sql, /w\.status in \('pending', 'retry'\)/);
  assert.match(sql, /s\.venue_id is not null/);
  assert.doesNotMatch(sql, /delete from public\.events/i);
  assert.doesNotMatch(sql, /delete from public\.event_harvest_sources/i);
});

test("overdue Workflows are cancelled before settlement", () => {
  assert.match(dispatch, /30 \* 60_000/);
  assert.match(dispatch, /await getRun\(runId\)\.cancel\(\)/);
  assert.ok(
    dispatch.indexOf("await getRun(runId).cancel()") <
    dispatch.indexOf('"settle_terminal_shared_harvester_run"'),
  );
});

test("terminal settlement precedes reservation reconciliation", () => {
  assert.ok(
    dispatch.indexOf('"settle_terminal_shared_harvester_run"') <
    dispatch.indexOf('"reconcile_shared_harvester_reservations"'),
  );
});

test("standalone source recovery is connected", () => {
  assert.match(
    dispatch,
    /"recover_expired_standalone_source_executions"/,
  );
});

test("migration is transactional", () => {
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
});
