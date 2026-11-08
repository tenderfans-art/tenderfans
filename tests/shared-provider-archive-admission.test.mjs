import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8");

const sql = read(
  "supabase/migrations/115_shared_provider_archive_admission.sql",
);
const dispatcher = read(
  "app/api/jobs/shared-market-dispatch/route.ts",
);
const manual = read(
  "app/api/jobs/market-harvester-dispatch/route.ts",
);
const workflow = read("workflows/market-harvester.ts");
const executor = read(
  "lib/event-harvester/market-supplemental-executor.ts",
);
const detector = read(
  "app/api/jobs/first-party-event-detector/route.ts",
);
const ticket = read("app/api/jobs/event-harvester/route.ts");
const cron = JSON.parse(read("vercel.json"));

test("all four work types share reservation admission", () => {
  for (const type of [
    "harvest_source",
    "detect_spot",
    "archive_recheck",
    "harvest_provider",
  ]) {
    assert.ok(sql.includes(`'${type}'`), type);
    assert.ok(dispatcher.includes(`"${type}"`), type);
  }
  assert.match(sql, /reserve_shared_harvester_batch_scoped/);
  assert.match(sql, /reserve_shared_harvester_batch_for_market/);
  assert.match(sql, /claim_shared_harvester_assignment/);
  assert.match(sql, /shared_harvester_source_assignments/);
});

test("eligibility is centralized without another worker pool", () => {
  assert.match(sql, /shared_market_work_eligible/);
  assert.match(sql, /event_processing_source_in_market/);
  assert.match(sql, /first_party_source_executions/);
  assert.match(sql, /event_harvest_archive/);
  assert.match(sql, /market_shared_harvester_entitlement/);
  assert.doesNotMatch(sql, /create table public\.event_processing_pool_config/);
});

test("Ticketmaster is globally serialized", () => {
  assert.match(sql, /pr\.work_type = 'harvest_provider'/);
  assert.match(sql, /pr\.status in \('reserved', 'claimed'\)/);
  assert.match(sql, /pw\.work_type = 'harvest_provider'/);
  assert.match(sql, /p_slot_number <> 0/);
  assert.match(sql, /provider_work\.leased_until > v_now/);
  assert.match(executor, /EVENT_HARVESTER_JOB_SECRET/);
  assert.match(executor, /dryRun: false/);
  assert.match(executor, /marketId/);
  assert.match(ticket, /directLifecycleChecked/);
});

test("archive target claim requires the exact work lease", () => {
  assert.match(sql, /claim_market_event_harvest_archive_target/);
  assert.match(sql, /finish_market_event_harvest_archive_target/);
  assert.match(sql, /w\.lease_token = p_work_lease_token/);
  assert.match(sql, /w\.leased_until > clock_timestamp\(\)/);
  assert.match(sql, /archive_lease_token = gen_random_uuid\(\)/);
  assert.match(sql, /finish_event_harvest_archive_recheck/);
  assert.match(detector, /target_venue_id/);
  assert.match(detector, /market_work_id/);
  assert.match(detector, /market_lease_token/);
  assert.match(executor, /target_venue_id/);
});

test("supplemental execution uses existing fenced work lifecycle", () => {
  assert.match(executor, /withLeaseRenewal/);
  assert.match(executor, /fail_event_processing_work/);
  assert.match(executor, /complete_event_processing_work/);
  assert.match(executor, /first-party-event-detector\/route/);
  assert.match(executor, /event-harvester\/route/);
  assert.match(workflow, /executeSupplemental/);
  assert.match(workflow, /finalizeReservedBatch\(reservationId\)/);
});

test("manual Market endpoint cannot bypass shared admission", () => {
  assert.match(manual, /dispatchShared/);
  assert.match(manual, /marketId/);
  assert.doesNotMatch(manual, /start\(/);
  assert.match(dispatcher, /reserve_shared_harvester_batch_for_market/);
  assert.match(dispatcher, /release_shared_harvester_reservation/);
});

test("legacy crons and disabled-by-default Market policy remain", () => {
  assert.equal(cron.crons.filter(c => c.path !== "/api/jobs/shared-market-dispatch").length, 4);
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
  assert.doesNotMatch(sql, /set\s+is_enabled\s*=/i);
  assert.match(sql, /where is_enabled = true/);
});
