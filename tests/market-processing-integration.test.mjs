import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

const sql = read(
  "supabase/migrations/109_market_processing_queue_integration.sql",
);

const detector = read(
  "lib/event-harvester/market-detector-executor.ts",
);

const workflow = read(
  "workflows/market-harvester.ts",
);

const dispatch = read(
  "app/api/jobs/market-detector-dispatch/route.ts",
);

const shared = read(
  "app/api/jobs/shared-market-dispatch/route.ts",
);

test("queue population requires enabled Markets", () => {
  assert.match(sql, /where is_enabled = true/);
  assert.match(sql, /for update/);
});

test("detector jobs require Market-assigned Spots", () => {
  assert.match(sql, /'detect_spot'/);
  assert.match(sql, /event_processing_market_venues/);
  assert.match(sql, /event_harvest_archive/);
});

test("source queue requires enabled first-party sources", () => {
  assert.match(sql, /'harvest_source'/);
  assert.match(sql, /s\.provider = 'first_party'/);
  assert.match(sql, /s\.is_enabled = true/);
});

test("configured intervals control replenishment", () => {
  assert.match(sql, /m\.detector_interval_minutes/);
  assert.match(sql, /m\.harvester_interval_minutes/);
  assert.match(sql, /on conflict do nothing/);
});

test("existing detector logic is reused", () => {
  assert.match(
    detector,
    /first-party-event-detector\/route/,
  );
  assert.match(detector, /GET\(request\)/);
  assert.match(detector, /withLeaseRenewal/);
});

test("detector completion and failure are lease-bound", () => {
  assert.match(
    detector,
    /complete_event_processing_work/,
  );
  assert.match(
    detector,
    /fail_event_processing_work/,
  );
});

test("existing Workflow has durable detector steps", () => {
  assert.match(workflow, /mode === "detect"/);
  assert.match(workflow, /"use workflow"/);
  assert.match(
    workflow,
    /work\.slice\(offset, offset \+ 2\)\.map\(executeDetector\)/,
  );
  assert.match(
    workflow,
    /async function executeDetector[\s\S]*?"use step"/,
  );
});

test("both dispatchers replenish due work", () => {
  assert.match(
    dispatch,
    /enqueue_due_market_processing/,
  );
  assert.match(
    shared,
    /enqueue_due_market_processing/,
  );
});

test("detector dispatcher starts existing Workflow", () => {
  assert.match(
    dispatch,
    /start\(\s*marketHarvesterWorkflow/,
  );
  assert.match(dispatch, /"detect"/);
});
