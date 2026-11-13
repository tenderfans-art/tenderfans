import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  "supabase/migrations/123_scheduled_market_cycle_foundation.sql",
  "utf8",
);

const previous = readFileSync(
  "supabase/migrations/121_spot_first_market_processing.sql",
  "utf8",
);

const dispatcher = readFileSync(
  "app/api/jobs/shared-market-dispatch/route.ts",
  "utf8",
);

test("foundation is one complete transaction", () => {
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
  assert.match(sql, /lock_timeout = '5s'/);
});

test("existing Markets are not automatically rescheduled", () => {
  assert.match(
    sql,
    /schedule_enabled boolean not null default false/,
  );

  assert.match(
    sql,
    /next_scheduled_at timestamptz/,
  );

  assert.doesNotMatch(
    sql,
    /set\s+is_enabled\s*=/i,
  );

  assert.doesNotMatch(
    sql,
    /set\s+schedule_enabled\s*=\s*true/i,
  );
});

test("per-Market schedule supports local times and time zones", () => {
  assert.match(sql, /schedule_timezone text/);
  assert.match(sql, /schedule_local_time time without time zone/);
  assert.match(sql, /event_processing_markets_schedule_due_idx/);
  assert.match(sql, /America\/New_York/);
  assert.match(sql, /09:30:00/);
});

test("scheduled occurrence cannot create duplicate cycles", () => {
  assert.match(sql, /unique \(market_id, scheduled_for\)/);
  assert.match(sql, /event_processing_one_running_cycle_idx/);
  assert.match(sql, /where status = 'running'/);
});

test("cycle work must match its owning Market", () => {
  assert.match(sql, /add column market_cycle_id uuid/);
  assert.match(sql, /foreign key \(market_cycle_id, market_id\)/);
  assert.match(sql, /references public\.event_processing_market_cycles\(id, market_id\)/);
  assert.match(sql, /event_processing_work_cycle_market_required/);
});

test("migration never changes existing work status or leases", () => {
  assert.doesNotMatch(
    sql,
    /update public\.event_processing_work/i,
  );

  assert.doesNotMatch(
    sql,
    /delete from public\.event_processing_work/i,
  );

  assert.doesNotMatch(
    sql,
    /truncate public\.event_processing_work/i,
  );
});

test("cycle tracking covers every Market work type", () => {
  for (const type of [
    "detect_spot",
    "harvest_source",
    "archive_recheck",
    "harvest_provider",
  ]) {
    assert.match(previous, new RegExp(type));
  }

  assert.match(sql, /expected_spots/);
  assert.match(sql, /expected_shared_sources/);
  assert.match(sql, /expected_archive_checks/);
  assert.match(sql, /expected_provider_jobs/);
});

test("run progress exposes duration and terminal outcomes", () => {
  assert.match(sql, /elapsed_seconds/);
  assert.match(sql, /completed_spots/);
  assert.match(sql, /failed_spots/);
  assert.match(sql, /harvest_skipped_spots/);
  assert.match(sql, /peak_active_sources/);
  assert.match(sql, /peak_active_workflows/);
});

test("source and event execution remain unchanged", () => {
  assert.doesNotMatch(
    sql,
    /create or replace function public\.(?:claim_|execute_|ingest_|sync_)/i,
  );

  assert.match(dispatcher, /reserve_shared_harvester_batch/);
  assert.match(dispatcher, /enqueue_due_market_processing/);
});

test("cycle records are not publicly readable", () => {
  assert.match(sql, /enable row level security/);
  assert.match(sql, /from public, anon, authenticated/);
  assert.match(sql, /to service_role/);
});
