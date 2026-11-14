import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (p) => readFileSync(p, "utf8");
const policy = read("lib/event-harvester/market-workflow-policy.ts");
const exports = {};
new Function("exports", ts.transpileModule(policy, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(exports);
const { marketWorkflowTiming, MARKET_WORK_ITEM_BUDGET_MS: workBudget,
  MARKET_WORKFLOW_ADMISSION_MS: admission,
  MARKET_WORKFLOW_SETTLEMENT_MS: settlement,
  MARKET_WORKFLOW_LIFETIME_MS: lifetime } = exports;
const sql = read("supabase/migrations/126_align_market_workflow_deadlines.sql");
const workflow = read("workflows/market-harvester.ts");
const dispatch = read("app/api/jobs/shared-market-dispatch/route.ts");
const minute = 60_000;

test("every admissible claim has its full existing budget and settlement margin", () => {
  const reservedAt = "2026-11-14T21:55:00Z";
  const start = Date.parse(reservedAt);
  const timing = marketWorkflowTiming(reservedAt);
  assert.equal(admission, 20 * minute);
  assert.equal(workBudget, 30 * minute);
  assert.equal(settlement, 5 * minute);
  assert.equal(lifetime, 55 * minute);
  for (const age of [0, 1, 10, 19, 19.999999]) {
    const claimedAt = start + age * minute;
    assert.ok(claimedAt < timing.admissionClosesAt);
    assert.ok(claimedAt + workBudget + settlement <= timing.cancellationAt);
  }
  assert.equal(timing.admissionClosesAt, start + admission);
  assert.equal(timing.cancellationAt, start + lifetime);
});

test("observed cancelled attempts receive their full work window", () => {
  for (const [reservation, claim] of [
    ["2026-11-14T21:55:42.962Z", "2026-11-14T22:04:03.792Z"],
    ["2026-11-14T21:45:43.671Z", "2026-11-14T22:03:53.299Z"],
  ]) {
    const timing = marketWorkflowTiming(reservation);
    const claimedAt = Date.parse(claim);
    assert.ok(claimedAt < timing.admissionClosesAt);
    assert.ok(claimedAt + workBudget + settlement <= timing.cancellationAt);
    assert.ok(claimedAt + workBudget > Date.parse(reservation) + 30 * minute);
  }
});

test("invalid reservation timestamps cannot create an unbounded lifetime", () => {
  for (const value of ["", "invalid", "2026-99-99T00:00:00Z"]) {
    assert.throws(() => marketWorkflowTiming(value), /Invalid reservation start time/);
  }
});

test("caller and dispatcher use the shared policy while replay stays first", () => {
  assert.match(workflow, /marketWorkflowTiming\([\s\S]*?\)\.admissionClosesAt/);
  assert.match(dispatch, /marketWorkflowTiming\([\s\S]*?\)\.cancellationAt/);
  assert.ok(workflow.indexOf("if (!priorAssignment)") < workflow.indexOf(").admissionClosesAt"));
  assert.ok(dispatch.indexOf("await getRun(runId).cancel()") <
    dispatch.indexOf('"settle_terminal_shared_harvester_run"'));
});

test("SQL uses the same timing after ownership locks and immutable replay", () => {
  assert.equal(Number(sql.match(/reserved_at \+ interval '(\d+) minutes'/)[1]) * minute, lifetime);
  assert.match(sql, /v_reservation\.reserved_at \+ interval '20 minutes'/);
  const replay = sql.indexOf("-- Durable replay path.");
  const marketLock = sql.indexOf("-- Replays above remain immutable.");
  const cutoff = sql.indexOf("if clock_timestamp() >=");
  const claim = sql.indexOf("from public.claim_shared_harvester_source(");
  assert.ok(replay >= 0 && marketLock > replay && cutoff > marketLock && claim > cutoff);
  assert.match(sql, /or v_reservation\.expires_at <= clock_timestamp\(\)/);
  assert.match(sql, /old\.workflow_run_id is not null[\s\S]*?new\.status = 'expired'[\s\S]*?return null/);
  assert.match(sql, /from public,anon,authenticated/);
});

test("migration preserves per-item ceilings and does not rewrite existing ownership", () => {
  const beforeClaim = sql.slice(0, sql.indexOf("create or replace function public.claim_shared_harvester_assignment"));
  assert.doesNotMatch(beforeClaim, /^update\s+/mi);
  assert.doesNotMatch(sql, /update public\.(event_processing_markets|event_processing_pool_config)/i);
  assert.doesNotMatch(sql, /tf_cap_work_execution_deadline|delete from|truncate\s/i);
  for (const path of ["market-detector-executor.ts", "market-batch-executor.ts", "market-supplemental-executor.ts"]) {
    assert.match(read("lib/event-harvester/" + path), /30 \* 60_000/);
  }
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
});
