import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dispatch = readFileSync(
  "app/api/jobs/shared-market-dispatch/route.ts",
  "utf8",
);
const workflow = readFileSync(
  "workflows/market-harvester.ts",
  "utf8",
);

test("one dispatcher owns reservation admission", () => {
  assert.equal(
    (dispatch.match(/"reserve_shared_harvester_batch"/g) ?? []).length,
    1,
  );
  assert.equal(
    (dispatch.match(/"enqueue_due_market_processing"/g) ?? []).length,
    1,
  );
  assert.equal(
    (dispatch.match(/"reconcile_shared_harvester_reservations"/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(workflow, /reserve_shared_harvester_batch/);
  assert.doesNotMatch(workflow, /enqueue_due_market_processing/);
});

test("dispatcher fills multiple reservations but bounds starts", () => {
  assert.match(dispatch, /MAX_WORKFLOW_STARTS_PER_TICK = 16/);
  assert.match(dispatch, /attempt < MAX_WORKFLOW_STARTS_PER_TICK/);
  assert.match(dispatch, /if \(!reservation\) \{\s*break;/);
  assert.match(dispatch, /release_shared_harvester_reservation/);
  assert.match(dispatch, /accepted: runs/);
});

test("the Market batch limit is captured in Workflow arguments", () => {
  assert.match(
    dispatch,
    /\.select\("harvester_batch_size,detector_batch_size"\)/,
  );
  assert.match(
    dispatch,
    /reservedWork\.work_type === "detect_spot"/,
  );
  assert.match(
    dispatch,
    /mode === "detect"\s*\?\s*market\.detector_batch_size\s*:\s*market\.harvester_batch_size/,
  );
  assert.match(
    dispatch,
    /reservation\.reservation_id,\s*mode,\s*batchSize/,
  );
  assert.match(workflow, /configuredBatchSize = 10/);
  assert.match(workflow, /Math\.min\(10, configuredBatchSize\)/);
  assert.match(workflow, /Math\.min\(8, maxSourcesPerRun\)/);
});

test("original execution and reservation finalization remain", () => {
  assert.match(workflow, /claim_shared_harvester_assignment/);
  assert.match(workflow, /work\.map\(executeSource\)/);
  assert.match(workflow, /Promise\.allSettled/);
  assert.match(workflow, /await finalizeReservedBatch\(reservationId\)/);
});
