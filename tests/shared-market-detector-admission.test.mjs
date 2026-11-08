import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  "supabase/migrations/113_shared_market_detector_admission.sql",
  "utf8",
);
const workflow = readFileSync(
  "workflows/market-harvester.ts",
  "utf8",
);
const shared = readFileSync(
  "app/api/jobs/shared-market-dispatch/route.ts",
  "utf8",
);
const detector = readFileSync(
  "app/api/jobs/market-detector-dispatch/route.ts",
  "utf8",
);

function body(name, ending) {
  const marker = `public.${name}(`;
  const start = sql.indexOf(marker);
  assert.ok(start >= 0, `${name} exists`);
  const begin = sql.lastIndexOf("create or replace function", start);
  const end = sql.indexOf(ending, start);
  assert.ok(begin >= 0 && end > begin);
  return sql.slice(begin, end);
}

test("detector and sources use the same reservation table", () => {
  assert.match(sql, /work_type in \('harvest_source', 'detect_spot'\)/);
  assert.match(sql, /event_processing_dispatch_reservations/);
  assert.match(sql, /shared_harvester_source_assignments/);
  assert.doesNotMatch(sql, /create table public\.[a-z_]*detector/i);
});

test("global source budget includes both workloads", () => {
  for (const name of [
    "reserve_shared_harvester_batch",
    "claim_shared_harvester_source",
    "claim_shared_harvester_assignment",
    "claim_event_processing_batch",
  ]) {
    assert.match(
      body(name, name === "claim_shared_harvester_assignment"
        ? "$assignment$;"
        : name === "reserve_shared_harvester_batch"
          ? "$reserve_shared$;"
          : name === "claim_shared_harvester_source"
            ? "$claim_source$;"
            : "\n$$;"),
      /work_type in \('harvest_source', 'detect_spot'\)/,
    );
  }
});

test("detector assignments are replay-safe and claim one Spot", () => {
  const claim = body(
    "claim_shared_harvester_assignment",
    "$assignment$;",
  );
  assert.match(claim, /v_assignment\.work_id/);
  assert.match(claim, /v_reservation\.work_type = 'detect_spot'/);
  assert.match(claim, /limit 1\s+for update of w skip locked/i);
  assert.match(claim, /claimed_venue_id/);
  assert.match(claim, /claimed_lease_token/);
});

test("direct batch claims do not count each shared source as a batch", () => {
  const claim = body("claim_event_processing_batch", "\n$$;");
  assert.match(claim, /not exists \(\s+select 1\s+from public\.shared_harvester_source_assignments/);
  assert.match(claim, /v_reserved_batches/);
  assert.match(claim, /v_active_batches := v_active_batches \+ v_reserved_batches/);
});

test("Market eligibility and source execution locks are preserved", () => {
  assert.match(sql, /event_processing_source_in_market/);
  assert.match(sql, /first_party_source_executions/);
  assert.match(sql, /event_processing_market_venues/);
  assert.match(sql, /event_harvest_archive/);
  assert.match(sql, /market_shared_harvester_entitlement/);
});

test("shared dispatcher selects detector and harvest modes", () => {
  assert.match(shared, /reservedWork\.work_type === "detect_spot"/);
  assert.match(shared, /market\.detector_batch_size/);
  assert.match(shared, /market\.harvester_batch_size/);
  assert.match(shared, /release_shared_harvester_reservation/);
  assert.match(shared, /start\(marketHarvesterWorkflow/);
});

test("detector route is only an alias, never an independent scheduler", () => {
  assert.match(detector, /shared-market-dispatch\/route/);
  assert.doesNotMatch(detector, /list_due_market_detector_work/);
  assert.doesNotMatch(detector, /start\(/);
});

test("original detector engine and durable execution remain", () => {
  assert.match(workflow, /claim_shared_harvester_assignment/);
  assert.match(workflow, /work\.map\(\(item\) =>\s*executeDetector/);
  assert.match(workflow, /work\.slice\(offset, offset \+ 2\)\.map\(executeDetector\)/);
  assert.match(workflow, /finalizeReservedBatch\(reservationId\)/);

  const executor = readFileSync(
    "lib/event-harvester/market-detector-executor.ts",
    "utf8",
  );
  assert.match(executor, /first-party-event-detector\/route/);
  assert.match(executor, /withLeaseRenewal/);
  assert.match(executor, /complete_event_processing_work/);
});

test("detector writes use a top-level data-modifying CTE", () => {
  const claim = body(
    "claim_shared_harvester_assignment",
    "$assignment$;",
  );

  assert.match(claim, /with selected as materialized \(/);
  assert.match(claim, /into v_claim\s+from claimed c;/);
  assert.doesNotMatch(
    claim,
    /from \(\s*with selected as materialized \(/,
  );
});

test("migration is transactional and does not enable Markets", () => {
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
  assert.doesNotMatch(sql, /set\s+is_enabled\s*=/i);
});
