import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const runner = readFileSync(
  "lib/event-harvester/first-party/registered-source-runner.ts",
  "utf8",
);
const legacy = readFileSync(
  "app/api/jobs/first-party-event-harvester/route.ts",
  "utf8",
);
const market = readFileSync(
  "lib/event-harvester/market-batch-executor.ts",
  "utf8",
);

test("both paths use the same registered source runner", () => {
  assert.match(legacy, /runRegisteredFirstPartySource\(/);
  assert.match(market, /runRegisteredFirstPartySource\(/);
  assert.doesNotMatch(legacy, /ingestFirstPartySource\(/);
  assert.doesNotMatch(market, /ingestFirstPartySource\(/);
  assert.match(runner, /ingestFirstPartySource\(/);
});

test("existing recovery proxy is preserved for both paths", () => {
  assert.match(runner, /TENDERFANS_TRANSPORT_PROXY_URL/);
  assert.match(runner, /runWithTransportRecovery\(proxyUrl, ingest\)/);
});

test("existing source health fields are preserved", () => {
  for (const field of [
    "last_checked_at",
    "last_success_at",
    "last_error",
  ]) {
    assert.match(runner, new RegExp(field));
  }
  assert.match(legacy, /recordFirstPartySourceFailure/);
  assert.match(market, /recordFirstPartySourceFailure/);
});

test("calendar-image technical errors retain existing lifecycle", () => {
  assert.match(runner, /upsert_event_harvest_detector_finding/);
  assert.match(runner, /resolve_event_harvest_adapter_error/);
  assert.match(runner, /p_category: "adapter_error"/);
  assert.match(runner, /p_detector_status: "adapter_failed"/);
  assert.match(runner, /technicalCalendarFailure/);
});

test("Market-specific ingestion retains fenced work context", () => {
  assert.match(runner, /marketWork: options\.marketWork/);
  assert.match(market, /leaseToken: item\.claimed_lease_token/);
  assert.match(market, /withLeaseRenewal/);
  assert.match(market, /complete_event_processing_work/);
  assert.match(market, /fail_event_processing_work/);
});

test("content attribution and candidate processing remain original", () => {
  assert.doesNotMatch(runner, /resolveFirstPartyAttribution/);
  assert.doesNotMatch(runner, /event_harvest_candidates/);
  assert.doesNotMatch(runner, /create_shoutout/);
});
