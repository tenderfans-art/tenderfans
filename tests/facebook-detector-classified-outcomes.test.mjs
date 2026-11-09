import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const detector = readFileSync(
  "app/api/jobs/first-party-event-detector/route.ts",
  "utf8"
);

const validationStart = detector.indexOf(
  'if (validation.status !== "validated")'
);

const validationEnd = detector.indexOf(
  "validated += 1;",
  validationStart
);

assert.ok(validationStart >= 0);
assert.ok(validationEnd > validationStart);

const branch = detector.slice(
  validationStart,
  validationEnd
);

test("recognized Facebook outcomes retain existing classification", () => {
  assert.match(
    branch,
    /const facebookCompletedWithoutSupportedSource =/
  );

  assert.match(
    branch,
    /Facebook Page is unofficial and has no supported event source/
  );

  assert.match(
    branch,
    /Facebook Page has no public Events surface/
  );

  assert.match(
    branch,
    /Facebook Events page is unavailable or access restricted/
  );

  assert.match(
    branch,
    /facebookExhausted = true/
  );

  assert.match(
    branch,
    /facebookCompletedWithoutSupportedSource &&\s*!facebookAccessRestricted/
  );
});

test("access restriction persists a source-specific Adapter Error", () => {
  assert.match(
    branch,
    /const facebookAccessRestricted =/
  );

  const recording = branch.indexOf(
    "await recordAdapterError("
  );

  const classifiedExit = branch.indexOf(
    "if (facebookCompletedWithoutSupportedSource) {\n" +
    "              continue;\n" +
    "            }"
  );

  assert.ok(recording >= 0);
  assert.ok(classifiedExit > recording);

  assert.match(
    branch,
    /facebookAccessRestricted\)\s*\)\s*\{\s*await recordAdapterError/
  );
});

test("classified Facebook outcomes do not consume detector retries", () => {
  const classifiedExit = branch.indexOf(
    "if (facebookCompletedWithoutSupportedSource) {\n" +
    "              continue;\n" +
    "            }"
  );

  const failure = branch.indexOf(
    "failed += 1;",
    classifiedExit
  );

  assert.ok(classifiedExit >= 0);
  assert.ok(failure > classifiedExit);

  assert.match(
    branch.slice(classifiedExit, failure),
    /continue;/
  );

  assert.doesNotMatch(
    branch.slice(classifiedExit, failure),
    /registered \+= 1|validated \+= 1/
  );
});

test("unclassified validation failures remain genuine failures", () => {
  assert.match(
    branch,
    /failed \+= 1;\s*failures\.push\(\{/
  );

  assert.match(
    branch,
    /stage: "validation"/
  );
});

test("existing registered-source and primary-bucket rules remain", () => {
  assert.match(
    detector,
    /const hasPreviouslyValidatedSource =/
  );

  assert.match(
    detector,
    /successfullyRegisteredVenueSource \|\| hasPreviouslyValidatedSource/
  );

  assert.match(
    detector,
    /bucketCounts\.validated \+= 1/
  );
});

test("registered-source state is not modified by classified exit", () => {
  const start = branch.indexOf(
    "if (facebookCompletedWithoutSupportedSource) {\n" +
    "              continue;"
  );

  const end = branch.indexOf(
    "failed += 1;",
    start
  );

  assert.ok(start >= 0 && end > start);

  const classified = branch.slice(start, end);

  assert.doesNotMatch(
    classified,
    /\.from\("event_harvest_sources"\)/
  );

  assert.doesNotMatch(
    classified,
    /upsert_first_party_event_source/
  );

  assert.doesNotMatch(
    classified,
    /resolveAdapterError/
  );
});
