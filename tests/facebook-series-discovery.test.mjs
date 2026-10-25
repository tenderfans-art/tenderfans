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

function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);

  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}

const code = [
  section("type FacebookOccurrence =", "const USER_AGENT ="),
  section(
    "async function discoverFacebookSeriesOccurrences(",
    "/*\n * Convert a verified recurring series",
  ),
  `
  globalThis.extract = extractFacebookOccurrences;
  globalThis.discover = discoverFacebookSeriesOccurrences;
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
      return Date.parse("2030-01-01T00:00:00Z");
    }
  },
  Map,
  Set,
};

vm.runInNewContext(compiled, context);

const { discover } = context;
const parentId = "123456789";

function timestamp(day) {
  return Date.parse(`2030-01-${day}T18:00:00Z`) / 1000;
}

function occurrence(id, day) {
  return {
    id,
    parentId,
    startTimestamp: timestamp(day),
    endTimestamp: null,
  };
}

function html(items) {
  return (
    '<script>"comet_neighboring_siblings":' +
    JSON.stringify(items.map((item) => ({
      id: item.id,
      start_timestamp: item.startTimestamp,
      end_timestamp: item.endTimestamp,
      parent_event: {
        parent_id: item.parentId,
        id: item.parentId,
      },
    }))) +
    "</script>"
  );
}

test("walks forward through verified Facebook child windows", async () => {
  const a = occurrence("111", "02");
  const b = occurrence("222", "09");
  const c = occurrence("333", "16");
  const d = occurrence("444", "23");

  const pages = new Map([
    [b.id, html([a, b, c])],
    [c.id, html([b, c, d])],
    [d.id, html([c, d])],
  ]);

  let current = "";
  const visited = [];

  const page = {
    async goto(url) {
      const id = url.match(/\/(\d+)\/$/)?.[1];
      visited.push(id);
      current = pages.get(id) ?? html([]);
      return { ok: () => true };
    },
    async waitForTimeout() {},
    async content() {
      return current;
    },
  };

  const results = await discover(page, parentId, [a, b]);

  assert.deepEqual(
    Array.from(results, (item) => item.id),
    ["111", "222", "333", "444"],
  );

  assert.deepEqual(visited, ["222", "333", "444"]);
});

test("does not invent events when child pages add nothing", async () => {
  const a = occurrence("111", "02");
  const b = occurrence("222", "09");

  let visits = 0;

  const page = {
    async goto() {
      visits++;
      return { ok: () => true };
    },
    async waitForTimeout() {},
    async content() {
      return html([a, b]);
    },
  };

  const results = await discover(page, parentId, [a, b]);

  assert.equal(results.length, 2);
  assert.equal(visits, 1);
});

test("rejects child occurrences attributed to another parent", async () => {
  const a = occurrence("111", "02");
  const b = occurrence("222", "09");
  const foreign = {
    ...occurrence("333", "16"),
    parentId: "999999999",
  };

  const page = {
    async goto() {
      return { ok: () => true };
    },
    async waitForTimeout() {},
    async content() {
      return html([a, b, foreign]);
    },
  };

  const results = await discover(page, parentId, [a, b]);

  assert.deepEqual(
    Array.from(results, (item) => item.id),
    ["111", "222"],
  );
});
