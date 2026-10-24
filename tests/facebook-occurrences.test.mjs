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
  "function validFacebookTimestamp(",
);
const end = source.indexOf("const USER_AGENT", start);

assert.ok(start >= 0, "Timestamp validator must exist");
assert.ok(end > start, "Occurrence parser must exist");

const compiled = ts.transpileModule(
  source.slice(start, end) +
    "\nglobalThis.extract = extractFacebookOccurrences;",
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  },
).outputText;

const context = {};
vm.runInNewContext(compiled, context);

const extract = context.extract;

const parentId = "1067734085440915";

function occurrence(
  id,
  start,
  end,
  parent = parentId,
) {
  return {
    id,
    start_timestamp: start,
    end_timestamp: end,
    is_past: true,
    parent_event: {
      parent_id: parent,
      id: parent,
    },
  };
}

function html(records) {
  return (
    "<html><script>" +
    JSON.stringify({
      comet_neighboring_siblings: records,
    }) +
    "</script></html>"
  );
}

function normalize(results) {
  return JSON.parse(JSON.stringify(results));
}

test("extracts distinct recurring occurrences", () => {
  const records = [
    occurrence("1102466238634366", 1766098800, 1766119500),
    occurrence("1102466228634367", 1765494000, 1765514700),
    occurrence("1102466218634368", 1764889200, 1764909900),
  ];

  const results = normalize(extract(html(records), parentId));

  assert.equal(results.length, 3);

  assert.deepEqual(
    results.map((item) => [
      item.id,
      item.startTimestamp,
      item.endTimestamp,
    ]),
    [
      ["1102466238634366", 1766098800, 1766119500],
      ["1102466228634367", 1765494000, 1765514700],
      ["1102466218634368", 1764889200, 1764909900],
    ],
  );
});

test("deduplicates identical occurrence records", () => {
  const record = occurrence(
    "123456789",
    1893456000,
    1893463200,
  );

  const results = normalize(
    extract(html([record, record]), parentId),
  );

  assert.equal(results.length, 1);
});

test("rejects occurrences belonging to another parent", () => {
  const records = [
    occurrence(
      "123456789",
      1893456000,
      1893463200,
      "999999999",
    ),
  ];

  assert.equal(
    extract(html(records), parentId).length,
    0,
  );
});

test("rejects invalid timestamps and end-before-start", () => {
  const records = [
    occurrence("111", "invalid", 1893463200),
    occurrence("222", 1893456000, 1893450000),
    occurrence("333", 1893456000, "invalid"),
    occurrence("444", 1893456000, 1893463200),
  ];

  const results = normalize(
    extract(html(records), parentId),
  );

  assert.deepEqual(
    results.map((item) => item.id),
    ["444"],
  );
});

test("accepts an occurrence with no end timestamp", () => {
  const records = [
    occurrence("555", 1893456000, null),
  ];

  const results = normalize(
    extract(html(records), parentId),
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].id, "555");
  assert.equal(results[0].startTimestamp, 1893456000);
  assert.equal(results[0].endTimestamp, null);
});

test("permanently rejects conflicting occurrence dates", () => {
  const first = occurrence(
    "123456789",
    1893456000,
    1893463200,
  );

  const conflicting = occurrence(
    "123456789",
    1893542400,
    1893549600,
  );

  const results = normalize(
    extract(
      html([first, conflicting, first]),
      parentId,
    ),
  );

  assert.equal(results.length, 0);
});

test("returns no occurrences when recurrence data is absent", () => {
  assert.equal(
    extract("<html>No recurring events</html>", parentId).length,
    0,
  );
});
