import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  "supabase/migrations/118_retire_history_free_detail_sources.sql",
  "utf8"
);

test("requires disabled Pinellas Market", () => {
  assert.match(sql, /market_key = 'pinellas-county'/);
  assert.match(sql, /AND is_enabled = false/);
});

test("requires same Spot and successful inventory", () => {
  assert.match(sql, /p\.venue_id = child\.venue_id/);
  assert.match(sql, /p\.host = child\.host/);
  assert.match(sql, /p\.last_success_at IS NOT NULL/);
  assert.match(sql, /c\.source_id = p\.id/);
});

test("protects history, reviews and leases", () => {
  for (const name of [
    "event_harvest_candidates",
    "event_source_links",
    "event_harvest_unresolved_venues",
    "event_harvest_suppressions",
    "first_party_source_executions",
  ]) {
    assert.match(sql, new RegExp(name));
  }
  assert.match(sql, /w\.status = 'leased'/);
});

test("disables without deleting and cancels only queued work", () => {
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+public\./i);
  assert.match(sql, /SET is_enabled = false/);
  assert.match(sql, /w\.status IN \('pending', 'retry'\)/);
  assert.match(sql, /event_harvest_source_retirements/);
});
