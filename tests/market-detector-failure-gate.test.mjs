import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const source = readFileSync(
  "lib/event-harvester/market-detector-executor.ts",
  "utf8",
);

const start = source.indexOf(
  "export function isCompleteSpotDetectorReport("
);

const end = source.indexOf(
  "export function isCompleteSpotHarvesterReport(",
  start,
);

assert.ok(start >= 0 && end > start);

const compiled = ts.transpileModule(
  source.slice(start, end) +
    "\nglobalThis.checkDetector = isCompleteSpotDetectorReport;",
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  },
).outputText;

const context = { exports: {} };
vm.runInNewContext(compiled, context);

const check = (ok, body) =>
  context.checkDetector(ok, body);

const normal = {
  spots: 1,
  bucketInvariantHolds: true,
  failed: 0,
  failures: [],
};

test("valid detector result authorizes harvesting", () => {
  assert.equal(check(true, normal), true);
});

test("No Sources is a normal detector outcome", () => {
  assert.equal(check(true, {
    ...normal,
    detected: 0,
    buckets: {
      noSources: 1,
      total: 1,
    },
  }), true);
});

test("one failed adapter blocks harvesting", () => {
  assert.equal(check(true, {
    ...normal,
    failed: 1,
    failures: [{
      stage: "validation",
      error: "Adapter validation failed",
    }],
  }), false);
});

test("HTTP failure blocks harvesting", () => {
  assert.equal(check(false, normal), false);
});

test("bucket invariant failure blocks harvesting", () => {
  assert.equal(check(true, {
    ...normal,
    bucketInvariantHolds: false,
  }), false);
});

test("wrong Spot count blocks harvesting", () => {
  assert.equal(check(true, {
    ...normal,
    spots: 0,
  }), false);
});

test("missing detector failure accounting blocks harvesting", () => {
  assert.equal(check(true, {
    ...normal,
    failures: undefined,
  }), false);
});

test("inconsistent detector failure accounting blocks harvesting", () => {
  assert.equal(check(true, {
    ...normal,
    failures: [{
      stage: "detection",
      error: "Unexpected error",
    }],
  }), false);
});

test("noninteger failed count blocks harvesting", () => {
  assert.equal(check(true, {
    ...normal,
    failed: 0.5,
  }), false);
});

test("detector failure gate runs before harvester import", () => {
  const detectorCall = source.indexOf("await detect(request)");
  const gate = source.indexOf(
    "if (detectorError) {\n          throw new Error(detectorError);"
  );
  const harvesterImport = source.indexOf(
    'const { GET: harvest } = await import('
  );

  assert.ok(detectorCall >= 0);
  assert.ok(gate > detectorCall);
  assert.ok(harvesterImport > gate);
});
