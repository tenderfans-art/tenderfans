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

const start = source.indexOf(
  "type FacebookOrganizerEvidence =",
);

const end = source.indexOf(
  "\nasync function fetchEventDetail(",
  start,
);

assert.ok(start >= 0 && end > start);

const compiled = ts.transpileModule(
  source.slice(start, end) +
    "\nglobalThis.extractEvidence = extractFacebookOrganizerEvidence;",
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  },
).outputText;

const context = {};
vm.runInNewContext(compiled, context);

function extract(text) {
  const evidence = context.extractEvidence(text);

  return {
    eventBy: evidence.eventBy,
    host: evidence.host,
    conflict: evidence.conflict,
    names: Array.from(evidence.names),
  };
}

/*
 * Real Facebook-rendered organizer patterns.
 * Preserve co-organizer ambiguity, but never include unrelated
 * duration, tickets, prices, or website metadata in names.
 */
const cases = [
  {
    name: "live performance",
    text:
      "290 people responded " +
      "Event by The Horny Toads and Twisted Tiki " +
      "Twisted Tiki Duration: 4 hr " +
      "Public · Anyone on or off Facebook " +
      "St. Pete Beach, Florida " +
      "Hosts The Horny Toads Twisted Tiki " +
      "Suggested events",
    eventBy:
      "The Horny Toads and Twisted Tiki Twisted Tiki",
    host:
      "The Horny Toads Twisted Tiki",
  },
  {
    name: "ticketed craft class",
    text:
      "59 people responded " +
      "Event by Creative Resin-ations and Twisted Tiki " +
      "Twisted Tiki Tickets · $53.07 " +
      "www.eventbrite.com/e/mosaic-tray-class " +
      "Public · Anyone on or off Facebook " +
      "St. Pete Beach, Florida " +
      "Hosts Creative Resin-ations Twisted Tiki " +
      "Suggested events",
    eventBy:
      "Creative Resin-ations and Twisted Tiki Twisted Tiki",
    host:
      "Creative Resin-ations Twisted Tiki",
  },
  {
    name: "recurring music bingo",
    text:
      "2 people responded " +
      "Event by The Original Bandingo Music Bingo " +
      "and Twisted Tiki Twisted Tiki " +
      "Duration: 2 hr " +
      "Public · Anyone on or off Facebook " +
      "St. Pete Beach, Florida " +
      "Hosts The Original Bandingo Music Bingo Twisted Tiki " +
      "Suggested events",
    eventBy:
      "The Original Bandingo Music Bingo " +
      "and Twisted Tiki Twisted Tiki",
    host:
      "The Original Bandingo Music Bingo Twisted Tiki",
  },
];

for (const sample of cases) {
  test(
    "removes Facebook metadata without falsely resolving " +
      sample.name,
    () => {
      const result = extract(sample.text);

      assert.equal(result.eventBy, sample.eventBy);
      assert.equal(result.host, sample.host);

      // Different organizer labels still require review.
      assert.equal(result.conflict, true);
      assert.deepEqual(result.names, []);
    },
  );
}

test("matching organizer labels remain valid after duration metadata", () => {
  const result = extract(
    "Event by Example Brewing Duration: 2 hr " +
    "Public · Anyone on or off Facebook " +
    "Hosts Example Brewing Suggested events",
  );

  assert.deepEqual(result, {
    eventBy: "Example Brewing",
    host: "Example Brewing",
    conflict: false,
    names: ["Example Brewing"],
  });
});

test("business names containing and remain intact", () => {
  const result = extract(
    "Event by Smith, Jones and Partners Suggested events",
  );

  assert.deepEqual(result, {
    eventBy: "Smith, Jones and Partners",
    host: null,
    conflict: false,
    names: ["Smith, Jones and Partners"],
  });
});

test("different organizers without metadata remain unresolved", () => {
  const result = extract(
    "Event by Promoter One " +
    "Hosts Promoter Two Suggested events",
  );

  assert.equal(result.conflict, true);
  assert.deepEqual(result.names, []);
});
