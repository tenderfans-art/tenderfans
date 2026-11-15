import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
function harness(data = { latitude: 27.77, longitude: -82.64 }, { error, parent } = {}) {
  const exports = {}, calls = [];
  const js = ts.transpileModule(readFileSync("lib/event-harvester/event-occurrence-evidence.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new Function("require", "exports", js)(name => name === "./transport-capacity-context"
    ? { getSpotExecutionSignal: () => parent } : require(name), exports);
  const lookup = exports.createOccurrenceEvidenceLookup({ from(table) {
    const call = { table }; calls.push(call);
    return { select(columns) { call.columns = columns; return this; },
      eq(column, id) { Object.assign(call, { column, id }); return this; },
      abortSignal(signal) { call.signal = signal; return this; },
      async maybeSingle() { return { data, error }; },
    };
  } });
  return { lookup, calls };
}

test("shared evidence derives timezone from coordinates and caches by attributed Spot", async () => {
  const h = harness();
  const values = await Promise.all([h.lookup("first"), h.lookup("first"), h.lookup("second")]);
  assert.deepEqual(values, Array(3).fill({ version: 1, timeZone: "America/New_York" }));
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls.map(c => c.id), ["first", "second"]);
  assert.ok(h.calls.every(c => c.signal instanceof AbortSignal));
});

test("shared evidence supports locations east of UTC", async () => {
  assert.equal((await harness({ latitude: 35.68, longitude: 139.69 }).lookup("venue")).timeZone, "Asia/Tokyo");
});

test("invalid or unavailable coordinates never invent a timezone", async () => {
  for (const data of [null, {}, { latitude: null, longitude: null }, { latitude: NaN, longitude: 20 },
    { latitude: 27, longitude: 181 }, { latitude: "27.77", longitude: "-82.64" }]) {
    assert.equal(await harness(data).lookup("venue"), null);
  }
  assert.equal(await harness(undefined, { error: Error("read unavailable") }).lookup("venue"), null);
});

test("parent cancellation remains cancellation rather than missing evidence", async () => {
  const controller = new AbortController(), reason = Error("Spot budget expired");
  controller.abort(reason);
  await assert.rejects(harness(undefined, { parent: controller.signal }).lookup("venue"), error => error === reason);
});

const calendar = readFileSync("components/EventsCalendar.tsx", "utf8");
const start = calendar.indexOf("    async function loadRequestedEvent()");
const end = calendar.indexOf("\n    loadRequestedEvent();", start);
const effect = ts.transpileModule(calendar.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
for (const resolved of ["canonical", null]) test(`event links use ${resolved ? "the merged canonical" : "the original ID during migration rollout"}`, async () => {
  const calls = [], db = {
    rpc: async (name, args) => { assert.equal(name, "resolve_published_event_id"); assert.equal(args.p_event_id, "original"); return { data: resolved }; },
    from: () => ({ select() { return this; }, eq(key, value) { calls.push([key, value]); return this; }, maybeSingle: async () => ({ data: null }) }),
  };
  await new Function("supabase", "requestedEventId", effect + "\nreturn loadRequestedEvent();")(db, "original");
  assert.deepEqual(calls, [["id", resolved ?? "original"], ["status", "published"]]);
});
