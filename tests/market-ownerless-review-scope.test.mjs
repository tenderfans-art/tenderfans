import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const javascript = ts.transpileModule(readFileSync(
  "app/api/admin/markets/harvester-rpc/route.ts", "utf8",
), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const market = id(1), otherMarket = id(2), venue = id(3), otherVenue = id(4);
const owned = id(10), global = id(11), foreign = id(12), unmapped = id(13), foreignOwned = id(14);

function harness({ rows = [], failTable, configure } = {}) {
  const calls = [], queries = [];
  const tables = {
    platform_admins: [{ user_id: "administrator" }],
    event_processing_markets: [{ id: market, market_key: "pinellas-county" }],
    event_processing_market_venues: [{ venue_id: venue, market_id: market }],
    event_harvest_sources: [
      { id: owned, venue_id: venue, is_enabled: false },
      { id: global, venue_id: null, is_enabled: false },
      { id: foreign, venue_id: null },
      { id: unmapped, venue_id: null },
      { id: foreignOwned, venue_id: otherVenue },
    ],
    event_processing_shared_source_markets: [
      { source_id: global, market_id: market },
      { source_id: foreign, market_id: otherMarket },
      // A stale mapping cannot override a source's actual Spot owner.
      { source_id: foreignOwned, market_id: market },
    ],
    event_harvest_unresolved_venues: [
      { id: id(100), source_id: global },
      { id: id(101), source_id: foreign },
      { id: id(102), source_id: unmapped },
      { id: id(103), source_id: foreignOwned },
      { id: id(104), source_id: owned },
    ],
    event_harvest_candidates: [{ id: id(110), source_id: global }],
    event_google_spot_market_requests: [
      { place_id: "place-here", market_id: market },
      { place_id: "place-elsewhere", market_id: otherMarket },
    ],
  };
  configure?.(tables);

  function from(table) {
    const filters = [];
    let range, ordering;
    const query = {
      select() { return query; },
      eq(field, value) { filters.push([field, item => item === value]); return query; },
      in(field, values) {
        queries.push({ table, field, values: [...values] });
        filters.push([field, item => values.includes(item)]);
        return query;
      },
      order(field) { ordering = field; return query; },
      range(first, last) { range = [first, last]; return query; },
      maybeSingle() { return evaluate(true); },
      then(resolve, reject) { return evaluate(false).then(resolve, reject); },
    };
    async function evaluate(single) {
      if (table === failTable) return { data: null, error: { message: "metadata unavailable" } };
      let data = [...(tables[table] ?? [])].filter(row =>
        filters.every(([field, matches]) => matches(row[field])));
      if (ordering) data.sort((a, b) => String(a[ordering]).localeCompare(String(b[ordering])));
      if (range) data = data.slice(range[0], range[1] + 1);
      return { data: single ? data[0] ?? null : data, error: null };
    }
    return query;
  }

  const user = {
    auth: { getUser: async () => ({ data: { user: { id: "administrator" } }, error: null }) },
    rpc: async (name, args) => {
      calls.push({ name, args, identity: "authenticated-admin" });
      return { data: name.startsWith("admin_review_") ? "original-decision-result" : rows, error: null };
    },
  };
  const exports = {};
  new Function("require", "exports", "process", javascript)(name => {
    if (name === "next/server") return {
      NextResponse: { json: (body, options = {}) => ({ status: options.status ?? 200, body, headers: options.headers }) },
    };
    if (name === "@supabase/supabase-js") return {
      createClient(_url, key, options) {
        if (key === "anon") {
          assert.equal(options.global.headers.Authorization, "Bearer session");
          return user;
        }
        assert.equal(key, "service");
        return { from };
      },
    };
    throw new Error(`Unexpected module ${name}`);
  }, exports, { env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://database.example",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon", SUPABASE_SECRET_KEY: "service",
  } });

  const post = (name, args = {}) => exports.POST({
    nextUrl: new URL("https://app.example/api/admin/markets/harvester-rpc?market=pinellas-county"),
    headers: new Headers({ authorization: "Bearer session" }),
    json: async () => ({ name, args }),
  });
  return { post, calls, queries, tables };
}

test("Market reviews include explicitly mapped ownerless and existing Spot-owned sources", async () => {
  const rows = [owned, global, foreign, unmapped, foreignOwned, id(999)].map(source_id => ({
    source_id, venue_id: venue,
  }));
  const h = harness({ rows });
  const response = await h.post("admin_pending_event_harvest_unresolved_venues");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.map(row => row.source_id), [owned, global]);
  assert.equal(response.headers["Cache-Control"], "no-store");
});

test("all three mapped ownerless review decisions use the original authenticated RPC", async () => {
  for (const [name, argument, record] of [
    ["admin_review_event_harvest_unresolved_venue", "p_unresolved_id", id(100)],
    ["admin_review_calendar_event_verification", "p_candidate_id", id(110)],
    ["admin_review_event_occurrence", "p_candidate_id", id(110)],
  ]) {
    const h = harness();
    const args = { [argument]: record, p_venue_id: venue, p_decision: "approved" };
    const response = await h.post(name, args);
    assert.equal(response.status, 200, name);
    assert.equal(response.body.data, "original-decision-result");
    assert.deepEqual(h.calls, [{ name, args, identity: "authenticated-admin" }]);
  }
});

test("foreign, unmapped and foreign-owned sources cannot authorize a review decision", async () => {
  for (const record of [id(101), id(102), id(103), id(999)]) {
    const h = harness();
    const response = await h.post("admin_review_event_harvest_unresolved_venue", {
      p_unresolved_id: record, p_venue_id: venue,
    });
    assert.equal(response.status, 403);
    assert.equal(h.calls.length, 0);
  }
});

test("mapped source authorization still requires any destination Spot to belong to the Market", async () => {
  const h = harness();
  const response = await h.post("admin_review_event_harvest_unresolved_venue", {
    p_unresolved_id: id(100), p_venue_id: otherVenue,
  });
  assert.equal(response.status, 403);
  assert.equal(h.calls.length, 0);
});

test("existing Spot-owned decisions remain authorized without a publisher mapping", async () => {
  const h = harness();
  const response = await h.post("admin_review_event_harvest_unresolved_venue", {
    p_unresolved_id: id(104), p_venue_id: venue,
  });
  assert.equal(response.status, 200);
  assert.equal(h.queries.some(query => query.table === "event_processing_shared_source_markets"), false);
});

test("metadata failures return an error without leaking review rows or executing decisions", async () => {
  for (const failTable of ["event_harvest_sources", "event_processing_shared_source_markets"]) {
    const h = harness({ rows: [{ source_id: global, private: "review payload" }], failTable });
    const read = await h.post("admin_pending_event_harvest_unresolved_venues");
    assert.equal(read.status, 503);
    assert.equal(read.body.data, undefined);
    h.calls.length = 0;
    const write = await h.post("admin_review_event_harvest_unresolved_venue", { p_unresolved_id: id(100) });
    assert.equal(write.status, 503);
    assert.equal(h.calls.length, 0);
  }
});

test("Google Spot Review retains its separate Place and Market authorization", async () => {
  const h = harness({ rows: [{ place_id: "place-here" }, { place_id: "place-elsewhere" }] });
  const read = await h.post("admin_list_google_spot_reviews");
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.data, [{ place_id: "place-here" }]);
  const allowed = await h.post("admin_review_google_spot", { p_place_id: "place-here" });
  assert.equal(allowed.status, 200);
  const denied = await h.post("admin_review_google_spot", { p_place_id: "place-elsewhere" });
  assert.equal(denied.status, 403);
  assert.equal(h.calls.filter(call => call.name === "admin_review_google_spot").length, 1);
  assert.equal(h.queries.some(query => query.table === "event_processing_shared_source_markets"), false);
});

test("ownership metadata stays bounded and membership pagination retains the final Spot", async () => {
  const extraSources = Array.from({ length: 201 }, (_, index) => ({ id: id(2000 + index), venue_id: null }));
  const lastVenue = id(9999), lastSource = id(9998);
  const h = harness({
    rows: [...extraSources.map(source => ({ source_id: source.id })), { source_id: lastSource }],
    configure(tables) {
      tables.event_processing_market_venues = Array.from({ length: 1001 }, (_, index) => ({
        venue_id: index === 1000 ? lastVenue : id(5000 + index), market_id: market,
      }));
      tables.event_harvest_sources.push(...extraSources, { id: lastSource, venue_id: lastVenue });
      tables.event_processing_shared_source_markets.push(...extraSources.map(source => ({ source_id: source.id, market_id: market })));
    },
  });
  const response = await h.post("admin_list_event_occurrence_reviews");
  assert.equal(response.status, 200);
  assert.equal(response.body.data.length, 202);
  assert.ok(response.body.data.some(row => row.source_id === lastSource));
  assert.ok(h.queries.every(query => query.values.length <= 100));
  assert.equal(h.queries.filter(query => query.table === "event_harvest_sources").length, 3);
});
