import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  "supabase/migrations/112_market_elastic_overflow.sql",
  "utf8",
);

function functionBody(name, endMarker) {
  const marker = `create or replace function public.${name}(`;
  const start = sql.indexOf(marker);
  assert.ok(start >= 0, `${name} exists`);
  const end = sql.indexOf(endMarker, start);
  assert.ok(end > start);
  return sql.slice(start, end);
}

test("standard Market limit remains separate from borrowing", () => {
  assert.match(sql, /max_borrowed_sources integer not null/);
  assert.match(sql, /max_borrowed_workflows integer not null/);
  assert.match(sql, /overflow_queue_wait_minutes integer not null/);
  assert.doesNotMatch(sql, /set\s+max_concurrent_sources\s*=/i);
});

test("overflow requires saturation and aged eligible backlog", () => {
  assert.match(sql, /v_active_sources < allowed_sources/);
  assert.match(sql, /v_oldest_due is null/);
  assert.match(sql, /overflow_queue_wait_minutes/);
  assert.match(sql, /w\.attempts < w\.max_attempts/);
  assert.match(sql, /event_processing_source_in_market/);
});

test("other Markets get priority over borrowers", () => {
  assert.match(sql, /other_market\.id <> p_market_id/);
  assert.match(sql, /other_market\.is_enabled = true/);
  assert.match(
    sql,
    /\) < other_market\.max_concurrent_sources/,
  );
  assert.match(sql, /waiting\.status in \('pending', 'retry'\)/);
});

test("global source and Workflow ceilings remain authoritative", () => {
  assert.match(sql, /least\(\s*v_pool\.max_concurrent_sources/);
  assert.match(sql, /least\(\s*v_pool\.max_concurrent_batches/);
  assert.match(sql, /v_global_active >= v_global_limit/);
  assert.match(sql, /v_live_workflows >= v_workflow_limit/);
});

test("reservation and source claims share one entitlement", () => {
  const reserve = functionBody(
    "reserve_shared_harvester_batch",
    "$reserve_shared$;",
  );
  const claim = functionBody(
    "claim_shared_harvester_source",
    "$claim_source$;",
  );

  assert.match(reserve, /market_shared_harvester_entitlement/);
  assert.match(reserve, /entitlement\.allowed_sources/);
  assert.match(reserve, /entitlement\.allowed_workflows/);
  assert.match(claim, /market_shared_harvester_entitlement/);
  assert.match(claim, /v_market_active >= v_market_limit/);
});

test("original source attribution and source locks remain intact", () => {
  assert.match(sql, /first_party_source_executions/);
  assert.match(sql, /event_processing_source_in_market/);
  assert.doesNotMatch(sql, /update public\.event_harvest_sources/i);
  assert.doesNotMatch(sql, /event_harvest_candidates/);
  assert.doesNotMatch(sql, /set\s+is_enabled\s*=/i);
});

test("migration is transactional", () => {
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
});
