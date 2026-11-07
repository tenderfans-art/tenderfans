import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync("supabase/migrations/110_approved_publisher_market_scheduling.sql", "utf8");
const workflow = readFileSync("workflows/market-harvester.ts", "utf8");
const dispatcher = readFileSync("app/api/jobs/shared-market-dispatch/route.ts", "utf8");

function body(name) {
  const start = sql.indexOf("create or replace function public." + name + "(");
  assert.ok(start >= 0, name + " exists");
  const next = sql.indexOf("create or replace function public.", start + 1);
  return sql.slice(start, next < 0 ? undefined : next);
}

test("registered and enabled sources remain the source harvesting gate", () => {
  const q = body("enqueue_due_market_processing");
  assert.match(q, /s\.provider = 'first_party'/);
  assert.match(q, /s\.is_enabled = true/);
  assert.doesNotMatch(q, /event_harvest_candidates|event_source_links/);
});

test("one eligibility predicate is used by all existing admission functions", () => {
  for (const name of [
    "enqueue_due_market_processing", "reserve_shared_harvester_batch",
    "claim_shared_harvester_source", "claim_event_processing_batch",
  ]) {
    assert.match(body(name), /public\.event_processing_source_in_market\(/);
  }
});

test("one-off backfill is fenced to confirmed existing approved cohort", () => {
  assert.match(sql, /v_facebook <> 102 or v_woocommerce <> 5/);
  assert.match(sql, /m\.market_key = 'pinellas-county'/);
  assert.match(sql, /source_id uuid primary key/);
  assert.match(sql, /revoke all on public\.event_processing_shared_source_markets/);
});

test("the original empty-inventory and attribution behavior is unchanged", () => {
  assert.doesNotMatch(sql, /update public\.event_harvest_sources/);
  assert.doesNotMatch(sql, /resolveFirstPartyAttribution/);
  assert.doesNotMatch(sql, /event_harvest_candidates/);
  assert.match(body("enqueue_due_market_processing"), /v\.status = 'active'/);
  assert.match(body("enqueue_due_market_processing"), /event_harvest_archive/);
});

test("shared Workflow never admits or reconciles the next batch", () => {
  assert.match(dispatcher, /reserve_shared_harvester_batch/);
  assert.match(workflow, /claim_shared_harvester_assignment/);
  assert.doesNotMatch(workflow, /reserve_shared_harvester_batch/);
  assert.doesNotMatch(workflow, /reconcile_shared_harvester_reservations/);
});
