import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  "lib/event-harvester/market-batch-executor.ts",
  "utf8",
);

test("heartbeat supports cancellation", () => {
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /controller\.abort\(\)/);
});

test("heartbeat clears its timer", () => {
  assert.match(source, /clearTimeout\(timer\)/);
});

test("heartbeat awaits shutdown", () => {
  assert.match(source, /await heartbeatPromise/);
});

test("heartbeat awaits in-flight renewal", () => {
  assert.match(source, /if \(inFlight\)\s*\{\s*await inFlight;/);
});

test("heartbeat detects lost lease ownership", () => {
  assert.match(source, /error \|\| data !== true/);
});

test("heartbeat preserves ingestion errors", () => {
  assert.match(source, /if \(operationFailed\)\s*\{\s*throw operationError;/);
});

test("heartbeat propagates renewal failures", () => {
  assert.match(source, /if \(renewalFailure\)\s*\{\s*throw renewalFailure;/);
});

test("heartbeat retains lease renewal RPC", () => {
  assert.match(source, /"renew_event_processing_lease"/);
});
