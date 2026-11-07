import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  "supabase/migrations/111_market_source_capacity_baseline.sql",
  "utf8",
);

const routing = readFileSync(
  "supabase/migrations/110_approved_publisher_market_scheduling.sql",
  "utf8",
);

const workflow = readFileSync(
  "workflows/market-harvester.ts",
  "utf8",
);

test("new Markets default to 16 source slots", () => {
  assert.match(
    migration,
    /alter column max_concurrent_sources set default 16/i,
  );
});

test("existing original eight-slot Markets are upgraded", () => {
  assert.match(
    migration,
    /set\s+max_concurrent_sources\s*=\s*16/i,
  );
  assert.match(
    migration,
    /where max_concurrent_sources\s*=\s*8/i,
  );
});

test("Market-specific exceptions are not introduced", () => {
  assert.doesNotMatch(
    migration,
    /market_key\s*=/i,
  );
});

test("migration does not activate Markets or alter work", () => {
  assert.doesNotMatch(migration, /set\s+is_enabled/i);
  assert.doesNotMatch(
    migration,
    /(?:update|delete from|truncate)\s+public\.event_processing_work/i,
  );
  assert.doesNotMatch(
    migration,
    /(?:update|delete from|truncate)\s+public\.event_harvest_sources/i,
  );
});

test("existing global source admission remains authoritative", () => {
  assert.match(
    routing,
    /c\.max_concurrent_sources/,
  );
  assert.match(
    routing,
    /m\.max_concurrent_sources/,
  );
  assert.match(
    routing,
    /v_global_active >= v_global_limit/,
  );
  assert.match(
    routing,
    /v_market_active >= v_market_limit/,
  );
});

test("source execution still uses durable assignments", () => {
  assert.match(
    workflow,
    /claim_shared_harvester_assignment/,
  );
  assert.match(
    workflow,
    /finalizeReservedBatch\(reservationId\)/,
  );
});
