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

test("source execution is bounded to two per group", () => {
  assert.match(source, /const sourceConcurrency = 2;/);
  assert.match(source, /offset \+= sourceConcurrency/);
  assert.match(source, /work\.slice\(offset, offset \+ sourceConcurrency\)/);
});

test("each claimed source executes through its own step", () => {
  assert.match(
    source,
    /group\.map\(\(item\) => executeSource\(item\)\)/,
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

test("unexpected step errors are propagated", () => {
  assert.match(source, /if \(groupError !== undefined\)/);
  assert.match(source, /throw groupError;/);
});

test("the workflow does not bypass the market claim RPC", () => {
  assert.match(source, /claimMarketHarvesterBatch\(supabase, marketId\)/);
});
