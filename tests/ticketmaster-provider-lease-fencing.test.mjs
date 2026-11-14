import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

const sql = read(
  "supabase/migrations/116_ticketmaster_provider_lease_fencing.sql"
);
const route = read("app/api/jobs/event-harvester/route.ts");
const executor = read(
  "lib/event-harvester/market-supplemental-executor.ts"
);

test("provider acquisition validates Market ownership", () => {
  assert.match(sql, /p_market_id uuid default null/);
  assert.match(sql, /w\.market_id = p_market_id/);
  assert.match(sql, /w\.lease_token = p_market_lease_token/);
  assert.match(sql, /r\.work_type = 'harvest_provider'/);
  assert.match(sql, /ticketmaster_provider_run_lease/);
});

test("provider lease has acquisition, renewal and release", () => {
  for (const name of [
    "acquire_ticketmaster_provider_run",
    "renew_ticketmaster_provider_run",
    "release_ticketmaster_provider_run",
  ]) {
    assert.ok(sql.includes(name));
    assert.ok(route.includes(name));
  }
});

test("all Ticketmaster mutations use guarded operations", () => {
  assert.equal(
    (route.match(/await ticketmasterWrite\(/g) ?? []).length,
    11
  );

  for (const name of [
    "record_event_harvest_venue_scan",
    "upsert_event_harvest_venue_match",
    "auto_approve_event_harvest_venue_match",
    "upsert_event_harvest_candidate",
    "link_harvest_candidate_to_existing_event",
    "graduate_harvest_candidate",
    "sync_ticketmaster_event",
  ]) {
    assert.ok(sql.includes(`'${name}'`), name);
  }

  assert.match(sql, /execute_fenced_ticketmaster_operation/);
  assert.match(sql, /pg_catalog\.pg_proc/);
  assert.match(sql, /pg_catalog\.format_type/);
});

test("Market execution carries original work ownership", () => {
  assert.match(executor, /marketWorkId: item\.work_id/);
  assert.match(
    executor,
    /marketLeaseToken: item\.claimed_lease_token/
  );
  assert.match(route, /p_execution_token: acquired/);
});

test("lease loss interrupts HTTP requests", () => {
  assert.match(route, /renew_ticketmaster_provider_run/);
  assert.match(route, /providerAbort\.abort/);
  assert.match(route, /providerAbort\.signal\.throwIfAborted/);
  assert.match(route, /signal: providerAbort\.signal/);
  assert.match(route, /pacedFetch\(eventUrl/);
});

test("migration is complete without changing scheduling", () => {
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
  assert.doesNotMatch(sql, /set\s+is_enabled\s*=/i);
  assert.equal(JSON.parse(read("vercel.json")).crons.filter(c => c.path !== "/api/jobs/shared-market-dispatch").length, 0);
});
