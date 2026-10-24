import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  "app/api/jobs/first-party-event-detector/route.ts",
  "utf8",
);

test("homepage transport failure does not create an Adapter Error", () => {
  const start = source.indexOf(
    'if (\n        !unresolvedWebsiteDomain &&\n        (\n          detection.status === "transport_blocked"'
  );
  const end = source.indexOf(
    'if (detection.status === "detected")',
    start,
  );

  assert.ok(start >= 0, "Transport branch must exist");
  assert.ok(end > start, "Detection counter must follow transport branch");

  const block = source.slice(start, end);

  assert.doesNotMatch(
    block,
    /recordAdapterError\s*\(\s*["']transport["']/,
  );

  assert.match(
    block,
    /p_category:\s*["']transport["']/,
  );

  assert.match(
    block,
    /resolveAdapterError\s*\(\s*["']transport["']\s*,\s*detection\.websiteUrl/,
  );
});

test("genuine adapter validation errors remain recorded", () => {
  assert.match(
    source,
    /validation\.status === "validation_failed"[\s\S]*?await recordAdapterError\(\s*candidate\.sourceType/,
  );
});

test("Cloudflare challenge retains its dedicated classification", () => {
  assert.match(
    source,
    /detection\.challengeEvidence\?\.length[\s\S]*?p_category:\s*"challenge_encountered"/,
  );
});
