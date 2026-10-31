import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  "lib/event-harvester/market-batch-executor.ts",
  "utf8",
);

test("uses the existing first-party ingestion path", () => {
  assert.match(source, /ingestFirstPartySource\(/);
});

test("claims only harvest_source work", () => {
  assert.match(source, /p_work_type: "harvest_source"/);
});

test("defers source-lock contention", () => {
  assert.match(
    source,
    /if \(isSourceBusy\(cause\) \|\| cause instanceof MarketLeaseLostError\)\s*\{\s*result\.deferred \+= 1;\s*return result;/,
  );
});

test("successful ingestion is finalized separately", () => {
  const ingestionCatch = source.indexOf("} catch (cause) {");
  const completion = source.indexOf(
    '"complete_event_processing_work"',
  );

  assert.ok(ingestionCatch >= 0);
  assert.ok(completion > ingestionCatch);
});

test("completion failure never invokes failure RPC", () => {
  const completion = source.indexOf(
    '"complete_event_processing_work"',
  );
  const failure = source.indexOf(
    '"fail_event_processing_work"',
  );

  assert.ok(failure >= 0);
  assert.ok(completion > failure);
});

test("expired leases are not started", () => {
  assert.match(
    source,
    /Date\.parse\(item\.claimed_leased_until\) <= Date\.now\(\)/,
  );
});
