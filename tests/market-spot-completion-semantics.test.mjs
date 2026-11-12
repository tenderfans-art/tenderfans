import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const executor = readFileSync(
  "lib/event-harvester/market-detector-executor.ts",
  "utf8",
);

const start = executor.indexOf(
  "export function isCompleteSpotHarvesterReport("
);
const end = executor.indexOf(
  "export async function claimMarketDetectorBatch("
);

assert.ok(start >= 0 && end > start);

const compiled = ts.transpileModule(
  executor.slice(start, end),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

const module = { exports: {} };

new Function("module", "exports", compiled)(
  module,
  module.exports,
);

const complete =
  module.exports.isCompleteSpotHarvesterReport;

const success = (id) => ({
  sourceId: id,
  ok: true,
  result: { discovered: 0 },
});

const failure = (
  id,
  error = "Adapter validation failed",
) => ({
  sourceId: id,
  ok: false,
  error,
});

const report = (results) => {
  const succeeded = results.filter(x => x.ok).length;
  const failed = results.length - succeeded;

  return {
    provider: "first_party",
    ok: failed === 0,
    sourcesChecked: results.length,
    succeeded,
    failed,
    results,
  };
};

test("zero sources is a completed harvest", () => {
  assert.equal(complete(true, report([])), true);
});

test("all successful sources complete", () => {
  assert.equal(
    complete(true, report([success("a"), success("b")])),
    true,
  );
});

test("individual source failures do not fail the Spot", () => {
  assert.equal(
    complete(true, report([
      success("a"),
      failure("b"),
      success("c"),
    ])),
    true,
  );
});

test("all sources can fail independently", () => {
  assert.equal(
    complete(true, report([
      failure("a"),
      failure("b"),
    ])),
    true,
  );
});

test("HTTP failure remains incomplete", () => {
  assert.equal(
    complete(false, report([success("a")])),
    false,
  );
});

test("missing source report remains incomplete", () => {
  const body = report([success("a")]);
  delete body.results;

  assert.equal(complete(true, body), false);
});

test("partial source execution remains incomplete", () => {
  const body = report([success("a")]);
  body.sourcesChecked = 2;

  assert.equal(complete(true, body), false);
});

test("invalid source counts remain incomplete", () => {
  const body = report([success("a")]);
  body.succeeded = 2;

  assert.equal(complete(true, body), false);
});

test("source-lock contention remains incomplete", () => {
  assert.equal(
    complete(true, report([
      failure(
        "a",
        "First-party source a is already being ingested.",
      ),
    ])),
    false,
  );
});

test("unrecorded source error remains incomplete", () => {
  assert.equal(
    complete(true, report([
      failure(
        "a",
        "Adapter failed (Could not record source failure: DB unavailable)",
      ),
    ])),
    false,
  );
});

test("detector adapter errors do not invalidate the cycle", () => {
  assert.doesNotMatch(
    executor,
    /body\.failed !== 0/,
  );

  assert.match(
    executor,
    /body\.bucketInvariantHolds !== true/,
  );
});

test("original detector and harvester still run in order", () => {
  const detector = executor.indexOf("await detect(request)");
  const harvester = executor.indexOf("await harvest(request)");

  assert.ok(detector >= 0);
  assert.ok(harvester > detector);

  assert.match(executor, /withLeaseRenewal/);
  assert.match(executor, /complete_event_processing_work/);
  assert.match(executor, /fail_event_processing_work/);
});

test("existing source and adapter error routes remain", () => {
  const detector = readFileSync(
    "app/api/jobs/first-party-event-detector/route.ts",
    "utf8",
  );

  const harvester = readFileSync(
    "app/api/jobs/first-party-event-harvester/route.ts",
    "utf8",
  );

  assert.match(
    detector,
    /upsert_event_harvest_detector_finding/,
  );

  assert.match(
    harvester,
    /recordFirstPartySourceFailure/,
  );

  assert.match(
    harvester,
    /runRegisteredFirstPartySource/,
  );
});
