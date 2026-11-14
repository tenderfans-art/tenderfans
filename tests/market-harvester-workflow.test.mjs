import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../workflows/market-harvester.ts", import.meta.url),
  "utf8",
);

test("workflow and source execution use durable directives", () => {
  assert.match(source, /"use workflow"/);
  assert.match(source, /async function executeSource[\s\S]*?"use step"/);
  assert.match(source, /async function claimBatch[\s\S]*?"use step"/);
});

test("eight lanes independently refill numbered assignment slots", () => {
  assert.ok(source.includes("Math.min(8, maxSourcesPerRun)"));
  assert.ok(source.includes("Math.min(64, maxSourcesPerRun * 8)"));
  assert.ok(source.includes("slotNumber = laneIndex"));
  assert.ok(source.includes("slotNumber += sourceConcurrency"));
  assert.ok(source.includes("await claimReservedSource("));
  assert.ok(source.includes("await executeDetector("));
  assert.ok(source.includes("await executeSource(item)"));
  assert.ok(!source.includes("offset += sourceConcurrency"));
  assert.ok(source.includes(".select(\"status,reserved_at\")"));
  assert.ok(source.includes("priorAssignment"));
  assert.ok(source.includes("20 * 60_000"));
});

test("each claimed source executes through its own step", () => {
  assert.match(
    source,
    /await executeSource\(item\)/,
  );
});

test("parallel execution waits for every outcome in a group", () => {
  assert.match(source, /Promise\.allSettled\(/);
  assert.match(source, /outcome\.status === "rejected"/);
});

test("successful source outcomes are accumulated", () => {
  assert.match(source, /result\.completed \+= outcome\.value\.completed/);
  assert.match(source, /result\.failed \+= outcome\.value\.failed/);
  assert.match(source, /result\.deferred \+= outcome\.value\.deferred/);
});

test("unexpected errors propagate after all lanes settle", () => {
  assert.ok(source.includes("Promise.allSettled("));
  assert.ok(source.includes("executionError ??= outcome.reason"));
  assert.ok(source.includes("throw executionError;"));
  assert.ok(source.includes("originalFailure = cause"));
  assert.ok(source.includes("await finalizeReservedBatch(reservationId)"));
});

test("the workflow does not bypass the market claim RPC", () => {
  assert.match(source, /claimMarketHarvesterBatch\(supabase, marketId\)/);
});
