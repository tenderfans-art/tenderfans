import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8");

const migration = read(
  "supabase/migrations/121_spot_first_market_processing.sql",
);
const executor = read(
  "lib/event-harvester/market-detector-executor.ts",
);
const harvester = read(
  "app/api/jobs/first-party-event-harvester/route.ts",
);
const ingestion = read(
  "lib/event-harvester/first-party/ingest.ts",
);

function section(name) {
  const marker = `public.${name}(`;
  const i = migration.indexOf(marker);
  assert.ok(i >= 0, name);

  const start = migration.lastIndexOf(
    "create or replace function", i,
  );
  assert.ok(start >= 0);

  const rest = migration.slice(start);
  const delimiter = rest.match(/\bas (\$[a-z_]*\$)/i);
  assert.ok(delimiter);

  const end = rest.indexOf(
    "\n" + delimiter[1] + ";",
  );
  assert.ok(end > 0);

  return rest.slice(0, end);
}

test("one Spot cycle uses BOTH original routes", () => {
  assert.match(executor, /first-party-event-detector\/route/);
  assert.match(executor, /first-party-event-harvester\/route/);
  assert.match(executor, /await detect\(request\)/);
  assert.match(executor, /await harvest\(request\)/);
  assert.ok(
    executor.indexOf("await detect(request)") <
    executor.indexOf("await harvest(request)"),
  );
});

test("detection failure never skips existing approved sources", () => {
  assert.match(executor, /let detectorError/);
  assert.match(executor, /catch \(error\)/);
  assert.match(executor, /await harvest\(request\)/);
  assert.ok(
    executor.indexOf("if (cycle.detectorError") >
    executor.indexOf("await harvest(request)"),
  );
});

test("Spot ownership is held through harvesting", () => {
  assert.match(executor, /withLeaseRenewal\(/);
  assert.match(executor, /market_work_id: item\.work_id/);
  assert.match(executor, /market_lease_token: item\.claimed_lease_token/);
  assert.ok(
    executor.indexOf("complete_event_processing_work") >
    executor.indexOf("await harvest(request)"),
  );
});

test("existing harvester retains source selection and runner", () => {
  assert.match(harvester, /event_harvest_sources/);
  assert.match(harvester, /sourceQuery\.eq\("id", sourceId\)/);
  assert.match(harvester, /\.eq\("venue_id", venueId\)/);
  assert.match(harvester, /runRegisteredFirstPartySource\(/);
  assert.match(harvester, /recordFirstPartySourceFailure/);
  assert.doesNotMatch(harvester, /ingestFirstPartySource\(/);
});

test("Original harvester verifies Market Spot ownership", () => {
  assert.match(harvester, /"detect_spot"/);
  assert.match(harvester, /"leased"/);
  assert.match(harvester, /"lease_token"/);
  assert.match(harvester, /"leased_until"/);
  assert.match(harvester, /marketWork:/);
});

test("Spot processing includes approved sources without websites", () => {
  const queue = section("enqueue_due_market_processing");
  const eligible = section("shared_market_work_eligible");

  assert.match(queue, /nullif\(trim\(v\.website_url\)/);
  assert.match(queue, /approved\.venue_id = v\.id/);
  assert.match(eligible, /approved\.venue_id = v\.id/);
  assert.match(executor, /if \(spot\.website_url\?\.trim\(\)\)/);
});

test("only ownerless publishers remain independent source jobs", () => {
  for (const name of [
    "enqueue_due_market_processing",
    "shared_market_work_eligible",
    "claim_shared_harvester_source",
    "claim_event_processing_batch",
  ]) {
    const body = section(name);
    assert.match(
      body,
      /(?:s|src)\.venue_id is null/,
      name,
    );
  }
});

test("source claim retains exact Market and Spot ownership", () => {
  const claim = section(
    "claim_market_first_party_source_execution",
  );

  assert.match(claim, /v_work_type = 'detect_spot'/);
  assert.match(claim, /src\.venue_id = v_work_venue_id/);
  assert.match(claim, /src\.provider = 'first_party'/);
  assert.match(claim, /src\.is_enabled = true/);
  assert.match(claim, /event_processing_source_in_market/);
  assert.match(claim, /v_work_lease_token/);
  assert.match(claim, /on conflict \(source_id\) do nothing/);
});

test("event writes remain transactionally fenced", () => {
  const fence = section("execute_fenced_first_party_write");

  assert.match(fence, /for update/);
  assert.match(fence, /assert_first_party_execution_ownership/);
  assert.match(fence, /v_work\.work_type = 'detect_spot'/);
  assert.match(fence, /src\.venue_id = v_work\.venue_id/);
  assert.match(fence, /v_work\.lease_token/);
  assert.match(fence, /v_work\.leased_until/);

  assert.match(
    ingestion,
    /execute_fenced_first_party_write/,
  );
  assert.match(
    ingestion,
    /claim_market_first_party_source_execution/,
  );
});

test("recovery preserves valid Spot-bound source ownership", () => {
  const recovery = section(
    "recover_expired_market_source_executions",
  );

  assert.match(recovery, /v_work\.work_type = 'detect_spot'/);
  assert.match(recovery, /src\.venue_id = v_work\.venue_id/);
  assert.match(recovery, /v_work\.lease_token/);
  assert.match(recovery, /v_work\.leased_until/);
  assert.match(recovery, /for update skip locked/);
});

test("migration changes no review or publication functions", () => {
  const functions = [
    ...migration.matchAll(
      /create or replace function\s+public\.([a-z_][a-z0-9_]*)\s*\(/gi,
    ),
  ].map((match) => match[1]);

  assert.deepEqual(functions, [
    "enqueue_due_market_processing",
    "shared_market_work_eligible",
    "claim_shared_harvester_source",
    "claim_event_processing_batch",
    "claim_market_first_party_source_execution",
    "execute_fenced_first_party_write",
    "recover_expired_market_source_executions",
  ]);

  assert.match(migration, /^begin;/m);
  assert.match(migration, /^commit;/m);
  const outsideFunctions = migration.replace(
    /create or replace function[\s\S]*?\n(?:\$[a-z_]*\$|\$\$);/gi,
    "",
  );

  assert.doesNotMatch(
    outsideFunctions,
    /\b(?:insert\s+into|update|delete\s+from|truncate)\s+public\./i,
  );
});
