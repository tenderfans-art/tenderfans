import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(
  "lib/event-harvester/market-detector-executor.ts",
  "utf8",
);

const start = source.indexOf(
  "export function shouldHarvestAfterSpotDetection("
);

const end = source.indexOf(
  "export function isCompleteSpotHarvesterReport(",
  start,
);

assert.ok(start >= 0 && end > start);

const compiled = ts.transpileModule(
  source.slice(start, end) +
    "\nglobalThis.shouldHarvest = shouldHarvestAfterSpotDetection;",
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  },
).outputText;

const context = { exports: {} };
vm.runInNewContext(compiled, context);

const shouldHarvest = context.shouldHarvest;

const detection = (bucket) => ({
  spots: 1,
  failed: 0,
  failures: [],
  bucketInvariantHolds: true,
  buckets: {
    ...bucket,
    total: 1,
  },
});

test("No Sources skips Spot-owned harvesting", () => {
  assert.equal(
    shouldHarvest(detection({ noSources: 1 })),
    false,
  );
});

test("Facebook-only review skips Spot-owned harvesting", () => {
  assert.equal(
    shouldHarvest(detection({ facebook: 1 })),
    false,
  );
});

test("Calendar Image review skips harvesting", () => {
  assert.equal(
    shouldHarvest(detection({ calendarImage: 1 })),
    false,
  );
});

test("HTML Error skips harvesting without approval", () => {
  assert.equal(
    shouldHarvest(detection({ htmlError: 1 })),
    false,
  );
});

test("validated sources are harvested even with zero events", () => {
  assert.equal(
    shouldHarvest(detection({ validated: 1 })),
    true,
  );
});

test("Spot without website retains approved-source path", () => {
  assert.equal(shouldHarvest(null), true);
});

test("malformed detector buckets cannot authorize harvesting", () => {
  assert.equal(shouldHarvest({ buckets: null }), false);
  assert.equal(shouldHarvest({ buckets: [] }), false);
  assert.equal(shouldHarvest({ buckets: {} }), false);
});

test("detector failure gate precedes No Sources skip", () => {
  const detector = source.indexOf("await detect(request)");
  const errorGate = source.indexOf("if (detectorError) {");
  const skipGate = source.indexOf(
    "if (!shouldHarvestAfterSpotDetection(detection))"
  );
  const harvester = source.indexOf("await harvest(request)");

  assert.ok(detector >= 0);
  assert.ok(errorGate > detector);
  assert.ok(skipGate > errorGate);
  assert.ok(harvester > skipGate);
});

test("skipped harvesting still completes Market work", () => {
  assert.match(source, /harvestSkipped: cycle\.harvesting\.skipped === true/);
  assert.match(source, /sourcesChecked: 0/);
  assert.match(source, /succeeded: 0/);
  assert.match(source, /failed: 0/);
  assert.match(source, /complete_event_processing_work/);
  assert.match(source, /spotSignal\.throwIfAborted\(\)/);
});
