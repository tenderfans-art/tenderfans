import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const source = readFileSync(
  "lib/event-harvester/first-party/facebook-events.ts",
  "utf8",
);

function extractSection(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);

  assert.ok(start >= 0, `Missing ${startMarker}`);
  assert.ok(end > start, `Missing ${endMarker}`);

  return source.slice(start, end);
}

const code = [
  extractSection(
    "function unixSecondsToIso(",
    "type FacebookEventPlace",
  ),
  extractSection(
    "function expandFacebookEventCandidates(",
    "export async function fetchFacebookEvents(",
  ),
  `
  globalThis.expand = expandFacebookEventCandidates;
  globalThis.append = appendEligibleFacebookEvents;
  `,
].join("\n");

const compiled = ts.transpileModule(code, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
  },
}).outputText;

const context = {
  Date: class extends Date {
    static now() {
      return Date.parse("2030-01-01T12:00:00Z");
    }
  },
};
vm.runInNewContext(compiled, context);

const { expand, append } = context;

const parentId = "123456789";
const stub = {
  id: parentId,
  url: `https://www.facebook.com/events/${parentId}/`,
  title: "Example Event",
};

const now = Date.parse("2030-01-01T12:00:00Z");

function seconds(value) {
  return Date.parse(value) / 1000;
}

function occurrence(id, start, end = null) {
  return {
    id,
    parentId,
    startTimestamp: seconds(start),
    endTimestamp: end ? seconds(end) : null,
  };
}

function event(occurrences = undefined) {
  return {
    externalEventId: `facebook:event:${parentId}`,
    sourceUrl: stub.url,
    title: "Example Event",
    description: "Description",
    startsAt: "2030-01-02T18:00:00.000Z",
    endsAt: "2030-01-02T20:00:00.000Z",
    allDay: false,
    flyerUrl: null,
    location: "Example location",
    venueName: "Example venue",
    venueAddress: "Example address",
    allowSourceDefaultAttribution: false,
    rawPayload: {
      platform: "facebook_events",
      verifiedOccurrences: occurrences,
    },
  };
}

test("publishes only the next eligible recurring occurrence", () => {
  const occurrences = [
    occurrence("111", "2030-01-02T18:00:00Z"),
    occurrence("222", "2030-01-09T18:00:00Z"),
    occurrence("333", "2030-01-16T18:00:00Z"),
  ];

  const candidates = expand(stub, event(occurrences));

  assert.equal(candidates.length, 1);
  assert.equal(
    candidates[0].externalEventId,
    `facebook:event:${parentId}:111`,
  );
  assert.equal(
    candidates[0].startsAt,
    "2030-01-02T18:00:00.000Z",
  );
});

test("preserves ordinary events", () => {
  const original = event();
  const candidates = expand(stub, original);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0], original);
  assert.equal(
    candidates[0].externalEventId,
    `facebook:event:${parentId}`,
  );
});

test("preserves source attribution and location metadata", () => {
  const candidates = expand(
    stub,
    event([
      occurrence("111", "2030-01-02T18:00:00Z"),
    ]),
  );

  assert.equal(candidates[0].allowSourceDefaultAttribution, false);
  assert.equal(candidates[0].location, "Example location");
  assert.equal(candidates[0].venueName, "Example venue");
  assert.equal(candidates[0].venueAddress, "Example address");
  assert.equal(candidates[0].endsAt, null);
});

test("keeps future and ongoing events, excludes completed history", () => {
  const candidates = expand(
    stub,
    event([
      occurrence(
        "111",
        "2029-12-31T18:00:00Z",
        "2029-12-31T20:00:00Z",
      ),
      occurrence(
        "222",
        "2030-01-01T10:00:00Z",
        "2030-01-01T14:00:00Z",
      ),
      occurrence(
        "333",
        "2030-01-02T18:00:00Z",
        "2030-01-02T20:00:00Z",
      ),
    ]),
  );

  const events = [];
  append(candidates, events, new Set(), now);

  assert.deepEqual(
    Array.from(events, (item) => item.rawPayload.occurrenceId),
    ["222"],
  );
});

test("excludes past events with no end timestamp", () => {
  const candidates = expand(
    stub,
    event([
      occurrence("111", "2029-12-31T18:00:00Z"),
    ]),
  );

  const events = [];
  append(candidates, events, new Set(), now);

  assert.equal(events.length, 0);
});

test("deduplicates events across repeated source records", () => {
  const candidates = expand(
    stub,
    event([
      occurrence("111", "2030-01-02T18:00:00Z"),
    ]),
  );

  const events = [];
  const seen = new Set();

  append(candidates, events, seen, now);
  append(candidates, events, seen, now);

  assert.equal(events.length, 1);
  assert.equal(seen.size, 1);
});
