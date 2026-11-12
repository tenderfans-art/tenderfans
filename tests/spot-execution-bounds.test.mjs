import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8");

const executor = read(
  "lib/event-harvester/market-detector-executor.ts",
);
const lease = read(
  "lib/event-harvester/market-batch-executor.ts",
);
const detector = read(
  "lib/event-harvester/first-party/source-detector.ts",
);
const ingest = read(
  "lib/event-harvester/first-party/ingest.ts",
);
const context = read(
  "lib/event-harvester/transport-capacity-context.ts",
);
const permits = read(
  "lib/event-harvester/transport-capacity-permits.ts",
);
const browser = read(
  "lib/event-harvester/first-party/browser-transport.ts",
);
const facebook = read(
  "lib/event-harvester/first-party/facebook-events.ts",
);
const harvester = read(
  "app/api/jobs/first-party-event-harvester/route.ts",
);

test("Spot execution has a ten-minute budget", () => {
  assert.match(executor, /10 \* 60_000/);
  assert.match(executor, /runWithSpotExecutionSignal/);
  assert.match(executor, /spotSignal\.throwIfAborted\(\)/);
  assert.match(lease, /MarketWorkDeadlineExceededError/);
  assert.match(lease, /executionController\.signal/);
});

test("shared-source work has a cancellable execution budget", () => {
  assert.match(lease, /runWithSpotExecutionSignal/);
  assert.match(lease, /10 \* 60_000/);
  assert.match(ingest, /getSpotExecutionSignal\(\)\?\.throwIfAborted\(\)/);
  assert.match(detector, /getSpotExecutionSignal\(\)\?\.throwIfAborted\(\)/);
});

test("Spot cancellation propagates through transport", () => {
  assert.match(context, /AsyncLocalStorage<AbortSignal>/);
  assert.match(context, /getSpotExecutionSignal/);
  assert.match(permits, /getSpotExecutionSignal\(\)/);
  assert.match(permits, /AbortSignal\.any/);
  assert.match(permits, /effectiveParent/);
});

test("browser operations have a three-minute deadline", () => {
  assert.match(permits, /BrowserOperationTimeoutError/);
  assert.match(permits, /3 \* 60_000/);
  assert.match(permits, /bounded\.abort/);
  assert.match(permits, /await operation\(bounded\.signal\)/);
});

test("permit release follows operation cleanup", () => {
  assert.ok(
    permits.indexOf("await runOperation(controller.signal)") <
    permits.indexOf("await releasePermit("),
  );
  assert.match(permits, /await renewalTask/);
  assert.match(browser, /await browser\.close\(\)/);
  assert.match(browser, /await instance\.close\(\)/);
  assert.match(facebook, /await closeBrowser\(\)/);
});

test("browser timeout does not trigger recovery retries", () => {
  assert.equal(
    browser.match(
      /error\.name === "BrowserOperationTimeoutError"/g,
    )?.length,
    2,
  );
});

test("Facebook browser startup is bounded", () => {
  assert.match(facebook, /timeout: 30000/);
  assert.match(facebook, /permitSignal\.throwIfAborted\(\)/);
});

test("Spot still uses the original two CRON handlers", () => {
  assert.match(executor, /await detect\(request\)/);
  assert.match(executor, /await harvest\(request\)/);
  assert.match(harvester, /runRegisteredFirstPartySource/);
  assert.ok(
    executor.indexOf("await detect(request)") <
    executor.indexOf("await harvest(request)"),
  );
});

test("no source or publication logic is reimplemented", () => {
  assert.doesNotMatch(executor, /ingestFirstPartySource\(/);
  assert.doesNotMatch(executor, /graduate_harvest_candidate/);
  assert.doesNotMatch(permits, /upsert_event_harvest_candidate/);
});
