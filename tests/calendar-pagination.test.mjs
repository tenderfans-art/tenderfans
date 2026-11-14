import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync("components/EventsCalendar.tsx", "utf8");
const helperStart = source.indexOf("export async function loadAllCalendarEventPages");
const helperEnd = source.indexOf("export default function EventsCalendar", helperStart);
const effectStart = source.indexOf("    const controller = new AbortController();", helperEnd);
const effectEnd = source.indexOf("\n  }, [calendarWeeks, venueId]);", effectStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart && effectStart > helperEnd && effectEnd > effectStart);
const compile = (value) => ts.transpileModule(value, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function("exports", compile(source.slice(helperStart, helperEnd)))(module.exports);
const { loadAllCalendarEventPages: loadAll } = module.exports;
const runEffect = new Function("supabase", "calendarWeeks", "venueId", "setEvents",
  "setLoading", "setLoadError", "loadAllCalendarEventPages", "console",
  compile(source.slice(effectStart, effectEnd)));
const weeks = [{ start: new Date("2026-11-01T04:00:00Z"), end: new Date("2026-12-06T04:59:59.999Z") }];
const flush = () => new Promise(setImmediate);
const rows = (count) => Array.from({ length: count }, (_, id) => ({
  id: String(id), title: `Event ${id}`, starts_at: "2026-11-29T19:00:00Z",
  venues: { name: "Publishing Spot" },
}));
function database(respond) {
  const calls = [];
  return { calls, from(table) {
    const call = { table, filters: [], orders: [] };
    calls.push(call);
    const query = {
      select() { return this; },
      eq(...args) { call.filters.push(["eq", ...args]); return this; },
      gte(...args) { call.filters.push(["gte", ...args]); return this; },
      lte(...args) { call.filters.push(["lte", ...args]); return this; },
      order(...args) { call.orders.push(args); return this; },
      range(from, to) { Object.assign(call, { from, to }); return this; },
      abortSignal(signal) { call.signal = signal; return respond(call); },
    };
    return query;
  } };
}
function mount(db, venueId, state = { events: [], loading: false, error: false, writes: [] }) {
  const set = (key) => (value) => { state[key] = value; state.writes.push([key, value]); };
  const cleanup = runEffect(db, weeks, venueId, set("events"), set("loading"),
    set("error"), loadAll, { error() {} });
  return { state, cleanup };
}

test("loads events beyond 1000 without losing tied start times", async () => {
  const data = rows(1251), calls = [];
  const result = await loadAll((from, to) => {
    calls.push([from, to]);
    return Promise.resolve({ data: data.slice(from, to + 1), error: null });
  }, new AbortController().signal);
  assert.deepEqual(result, data);
  assert.deepEqual(calls, [[0, 499], [500, 999], [1000, 1499]]);
});

test("empty and exact-page-multiple results terminate correctly", async () => {
  for (const count of [0, 500, 1000]) {
    const data = rows(count); let calls = 0;
    const result = await loadAll((from, to) => {
      calls++;
      return Promise.resolve({ data: data.slice(from, to + 1), error: null });
    }, new AbortController().signal);
    assert.equal(result.length, count);
    assert.equal(calls, count / 500 + 1);
  }
});

test("later-page failure rejects instead of returning partial events", async () => {
  const failure = new Error("Second page unavailable");
  await assert.rejects(loadAll((from) => Promise.resolve(from === 0
    ? { data: rows(500), error: null } : { data: null, error: failure }),
  new AbortController().signal), (error) => error === failure);
});

test("cancelled pagination never starts another request", async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(loadAll(async () => {
    calls++; controller.abort(); return { data: rows(500), error: null };
  }, controller.signal), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("actual calendar loader preserves scopes and stable ordering on every page", async () => {
  for (const venueId of [undefined, "venue-a"]) {
    const data = rows(1251);
    const db = database(({ from, to }) => Promise.resolve({ data: data.slice(from, to + 1), error: null }));
    const { state, cleanup } = mount(db, venueId);
    await flush();
    assert.equal(state.events.length, 1251);
    assert.equal(state.events[1250].venue_name, "Publishing Spot");
    assert.equal(state.loading, false);
    assert.equal(state.error, false);
    assert.equal(db.calls.length, 3);
    for (const call of db.calls) {
      assert.equal(call.table, "events");
      assert.deepEqual(call.orders, [["starts_at", { ascending: true }], ["id", { ascending: true }]]);
      assert.deepEqual(call.filters.filter(([op]) => op === "eq"), venueId
        ? [["eq", "status", "published"], ["eq", "venue_id", venueId]]
        : [["eq", "status", "published"]]);
      assert.equal(call.filters.filter(([op]) => op === "gte" || op === "lte").length, venueId ? 0 : 2);
    }
    assert.equal(state.writes.filter(([key, value]) => key === "events" && value.length).length, 1);
    cleanup();
  }
});

test("actual loader exposes a later-page error without publishing partial counts", async () => {
  const db = database(({ from }) => Promise.resolve(from === 0
    ? { data: rows(500), error: null } : { data: null, error: new Error("Unavailable") }));
  const { state, cleanup } = mount(db);
  await flush();
  assert.deepEqual(state.events, []);
  assert.equal(state.error, true);
  assert.equal(state.loading, false);
  assert.equal(state.writes.some(([key, value]) => key === "events" && value.length), false);
  cleanup();
});

test("superseded month responses cannot overwrite newer data or loading state", async () => {
  let resolveOld;
  const old = mount(database(() => new Promise((resolve) => { resolveOld = resolve; })));
  old.cleanup();
  const fresh = mount(database(() => Promise.resolve({ data: rows(1), error: null })), undefined, old.state);
  await flush();
  const writeCount = fresh.state.writes.length;
  resolveOld({ data: rows(500), error: null });
  await flush();
  assert.equal(fresh.state.events.length, 1);
  assert.equal(fresh.state.loading, false);
  assert.equal(fresh.state.error, false);
  assert.equal(fresh.state.writes.length, writeCount);
  fresh.cleanup();
});
