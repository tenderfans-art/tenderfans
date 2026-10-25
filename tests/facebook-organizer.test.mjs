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
  "function extractFacebookOrganizerNames(",
);
const end = source.indexOf(
  "\nasync function fetchEventDetail(",
  start,
);

assert.ok(start >= 0 && end > start);

const compiled = ts.transpileModule(
  source.slice(start, end) +
    "\nglobalThis.extract = extractFacebookOrganizerNames;",
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  },
).outputText;

const context = {};
vm.runInNewContext(compiled, context);

const extract = (value) =>
  Array.from(context.extract(value));

const address =
  "3701 Gulf Blvd, Saint Pete Beach, FL, United States, Florida 33706";

for (const [date, title] of [
  ["October 26, 2026", "Rooftop Watch Party"],
  ["October 27, 2026", "Rooftop Watch Party"],
  ["October 30, 2026", "Murder Mystery Dinner"],
]) {
  test(`extracts organizer from flattened Facebook text: ${date}`, () => {
    const rendered = [
      `${date} ${title} ${address}`,
      `More About Discussion Invite Tickets`,
      `13 people responded Event by The Hotel Zamora ${address}`,
      `Free Public · Anyone on or off Facebook`,
      `St. Pete Beach, Florida Host The Hotel Zamora`,
      `Suggested events`,
    ].join(" ");

    assert.deepEqual(
      extract(rendered),
      ["The Hotel Zamora"],
    );
  });
}

test("supports original line-oriented organizer format", () => {
  assert.deepEqual(
    extract("Event by Example Brewing\n"),
    ["Example Brewing"],
  );
});

test("rejects conflicting Event by and Host identities", () => {
  assert.deepEqual(
    extract(
      "Event by Promoter One 123 Main St, Tampa, FL " +
      "Host Promoter Two Suggested events",
    ),
    [],
  );
});

test("does not infer organizer from physical location", () => {
  assert.deepEqual(
    extract(
      "Concert at Example Brewing 123 Main St, Tampa, FL",
    ),
    [],
  );
});

test("does not infer organizer from source or event title", () => {
  assert.deepEqual(
    extract("Example Brewing Facebook events — Live Music"),
    [],
  );
});
