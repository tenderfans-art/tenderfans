import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync("lib/event-harvester/market-facebook-inventory.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const page = "https://www.facebook.com/ExamplePage";
const token = "private-lease-token";
const clone = value => structuredClone(value);
const entry = (title = "Original inventory") => ({
  externalEventId: "facebook:event:123:456", sourceUrl: "https://www.facebook.com/events/123/456/",
  title, description: null, startsAt: "2026-11-16T00:00:00Z", endsAt: null,
  allDay: false, flyerUrl: null, location: "123 Main St", venueName: "Another Spot",
  venueAddress: "123 Main St", allowSourceDefaultAttribution: false,
  rawPayload: { eventPlace: { facebookPlaceId: "place-9" }, verifiedOccurrences: [{ id: "456" }] },
});

function harness({ signal, fastTimeout = false, brokenLogger = false, respond } = {}) {
  const logs = [], calls = [], timeouts = [], rows = new Map();
  const works = new Map([
    ["global-work", { token, cycle: "cycle-a" }],
    ["spot-work", { token, cycle: "cycle-a" }],
    ["next-cycle-work", { token, cycle: "cycle-b" }],
    ["standalone-work", { token, cycle: null }],
  ]);
  const key = args => JSON.stringify([
    works.get(args.p_work_id)?.cycle, args.p_page_url, args.p_validate_page_identity,
  ]);
  const normal = args => {
    const work = works.get(args.p_work_id);
    if (!work?.cycle || work.token !== args.p_lease_token) return { data: null, error: null };
    const id = key(args);
    if (args.p_events !== null && !rows.has(id)) rows.set(id, clone(args.p_events));
    return { data: rows.get(id) ?? null, error: null };
  };
  const db = {
    rpc(name, args) {
      assert.equal(name, "market_facebook_inventory");
      const call = { args, signal: undefined };
      calls.push(call);
      return {
        abortSignal(rpcSignal) {
          call.signal = rpcSignal;
          return Promise.resolve().then(() => respond?.(call, normal) ?? normal(args));
        },
      };
    },
  };
  const exports = {};
  new Function("require", "exports", "console", "setTimeout", "clearTimeout", compiled)(
    name => name === "./transport-capacity-context"
      ? { getSpotExecutionSignal: () => signal }
      : require(name),
    exports,
    { info(tag, json) {
      if (brokenLogger) throw Error("logger unavailable");
      assert.equal(tag, "[market-facebook-inventory]");
      logs.push(JSON.parse(json));
    } },
    (callback, delay) => {
      timeouts.push(delay);
      const timer = setTimeout(callback, fastTimeout ? 5 : delay);
      // Keep timeout tests alive even when the fake RPC has no socket.
      return fastTimeout ? { timer, unref() {} } : timer;
    },
    timer => clearTimeout(timer?.timer ?? timer),
  );
  const run = (workId, operation, lease = token) =>
    exports.runWithMarketFacebookInventory(db, workId, lease, operation);
  const reuse = (fetch, validate = false, url = page) =>
    exports.reuseMarketFacebookInventory(url, validate, fetch);
  return { ...exports, db, run, reuse, calls, logs, rows, key, timeouts };
}

test("legacy calls and non-Facebook Market operations perform no cache RPC", async () => {
  const h = harness(), inventory = [entry()];
  assert.equal(await h.reuse(async () => inventory), inventory);
  const flags = { classified: "facebook", failed: 0 };
  assert.equal(await h.run("spot-work", async () => flags), flags);
  assert.equal(h.calls.length, 0);
  const error = Error("original adapter failure");
  await assert.rejects(h.reuse(async () => { throw error; }), value => value === error);
});

test("global and Spot source contexts reuse raw inventory within their cycle", async () => {
  const h = harness(), original = [entry()];
  let fetches = 0;
  const fetch = async () => { fetches++; return original; };
  assert.equal(await h.run("global-work", () => h.reuse(fetch)), original);
  const result = await h.run("spot-work", () => h.reuse(fetch));
  assert.deepEqual(result, original);
  assert.notEqual(result, original);
  assert.equal(fetches, 1);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.logs.map(log => log.event), ["miss", "stored", "hit"]);
  assert.equal(result[0].sourceId, undefined);
  assert.equal(result[0].venueId, undefined);
  assert.equal(result[0].allowSourceDefaultAttribution, false);
});

test("a successful empty inventory is cached without becoming a cache miss", async () => {
  const h = harness(); let fetches = 0;
  for (const work of ["global-work", "spot-work"]) {
    assert.deepEqual(await h.run(work, () => h.reuse(async () => { fetches++; return []; })), []);
  }
  assert.equal(fetches, 1);
  assert.equal(h.logs.at(-1).event, "hit");
  assert.equal(h.logs.at(-1).count, 0);
});

test("detector Page identity validation never reuses harvest inventory", async () => {
  const h = harness(); const modes = [];
  for (const mode of [false, true, true, false]) {
    const result = await h.run("spot-work", () => h.reuse(async () => {
      modes.push(mode); return [entry(mode ? "Validated" : "Harvested")];
    }, mode));
    assert.equal(result[0].title, mode ? "Validated" : "Harvested");
  }
  assert.deepEqual(modes, [false, true]);
  assert.equal(h.rows.size, 2);
});

test("the database confines reuse to the authoritative work cycle and token", async () => {
  const h = harness(); let fetches = 0;
  const fetch = async () => [entry(String(++fetches))];
  assert.equal((await h.run("global-work", () => h.reuse(fetch)))[0].title, "1");
  assert.equal((await h.run("next-cycle-work", () => h.reuse(fetch)))[0].title, "2");
  assert.equal((await h.run("spot-work", () => h.reuse(fetch), "wrong-token"))[0].title, "3");
  assert.equal((await h.run("standalone-work", () => h.reuse(fetch)))[0].title, "4");
  assert.equal((await h.run("spot-work", () => h.reuse(fetch)))[0].title, "1");
  assert.equal(h.rows.size, 2);
});

test("concurrent Market contexts retain independent work and cycle identities", async () => {
  const h = harness();
  const result = await Promise.all([
    h.run("global-work", () => h.reuse(async () => { await Promise.resolve(); return [entry("A")]; })),
    h.run("next-cycle-work", () => h.reuse(async () => [entry("B")])),
  ]);
  assert.deepEqual(result.map(events => events[0].title), ["A", "B"]);
  assert.equal(h.rows.size, 2);
  for (const workId of ["global-work", "next-cycle-work"]) {
    assert.equal(h.calls.filter(call => call.args.p_work_id === workId).length, 2);
  }
});

test("adapter exceptions retain their exact identity and are never cached as empty", async () => {
  const h = harness(); const error = Error("Facebook Page has no public Events surface");
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(h.run("spot-work", () => h.reuse(async () => { throw error; })), value => value === error);
  }
  assert.equal(h.rows.size, 0);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => call.args.p_events === null));
});

test("cache read and publish outages preserve the fresh adapter result", async () => {
  const h = harness({ respond: () => ({ data: null, error: Error("private-lease-token https://secret.example payload") }) });
  const original = [entry()]; let fetches = 0;
  assert.equal(await h.run("spot-work", () => h.reuse(async () => { fetches++; return original; })), original);
  assert.equal(fetches, 1);
  assert.deepEqual(h.logs.map(log => log.phase), ["read", "publish"]);
  assert.ok(!JSON.stringify(h.logs).includes("private-lease-token"));
});

test("cache timeouts abort the RPC and cannot wait indefinitely for ignored aborts", async () => {
  const h = harness({ fastTimeout: true, respond: () => new Promise(() => {}) });
  const original = [entry()];
  assert.equal(await h.run("spot-work", () => h.reuse(async () => original)), original);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => call.signal.aborted));
  assert.deepEqual(h.timeouts, [5000, 5000]);
});

test("Spot cancellation while reading propagates the original reason and never fetches", async () => {
  const controller = new AbortController(), reason = Error("Spot lease lost");
  const h = harness({ signal: controller.signal, respond: call => {
    if (call.args.p_events === null) { controller.abort(reason); return new Promise(() => {}); }
  } });
  let fetches = 0;
  await assert.rejects(h.run("spot-work", () => h.reuse(async () => { fetches++; return []; })), value => value === reason);
  assert.equal(fetches, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.aborted, true);
});

test("an already cancelled Spot cannot read inventory or start its adapter", async () => {
  const controller = new AbortController(), reason = Error("deadline");
  controller.abort(reason);
  const h = harness({ signal: controller.signal });
  await assert.rejects(h.run("spot-work", () => h.reuse(async () => { assert.fail("must not fetch"); })), value => value === reason);
  assert.equal(h.calls.length, 0);
});

test("Spot cancellation after fetching prevents cache publication", async () => {
  const controller = new AbortController(), reason = Error("deadline");
  const h = harness({ signal: controller.signal });
  await assert.rejects(h.run("spot-work", () => h.reuse(async () => { controller.abort(reason); return [entry()]; })), value => value === reason);
  assert.equal(h.calls.length, 1);
  assert.equal(h.rows.size, 0);
});

test("Spot cancellation during optional publication still preserves its exact reason", async () => {
  const controller = new AbortController(), reason = Error("lease ended during publish");
  const h = harness({ signal: controller.signal, respond: call => {
    if (call.args.p_events !== null) { controller.abort(reason); return new Promise(() => {}); }
  } });
  await assert.rejects(h.run("spot-work", () => h.reuse(async () => [entry()])), value => value === reason);
  assert.equal(h.calls.length, 2);
  assert.equal(h.rows.size, 0);
});

test("cached consumers receive independent nested payload copies", async () => {
  const h = harness(), original = [entry()];
  await h.run("global-work", () => h.reuse(async () => original));
  original[0].rawPayload.eventPlace.facebookPlaceId = "producer mutation";
  const first = await h.run("spot-work", () => h.reuse(async () => assert.fail("cached")));
  first[0].rawPayload.verifiedOccurrences[0].id = "consumer mutation";
  first[0].rawPayload.eventPlace.facebookPlaceId = "consumer mutation";
  const second = await h.run("spot-work", () => h.reuse(async () => assert.fail("cached")));
  assert.equal(second[0].rawPayload.eventPlace.facebookPlaceId, "place-9");
  assert.equal(second[0].rawPayload.verifiedOccurrences[0].id, "456");
});

test("malformed cache payloads fall back without reclassifying adapter inventory", async () => {
  for (const malformed of ["{broken JSON", {}, [null], [{ title: "missing fields" }], [{ ...entry(), rawPayload: [] }]]) {
    const h = harness({ respond: (call, normal) => call.args.p_events === null ? { data: malformed, error: null } : normal(call.args) });
    const original = [entry()];
    assert.equal(await h.run("spot-work", () => h.reuse(async () => original)), original);
    assert.ok(h.logs.some(log => log.reason === "invalid-inventory"));
  }
});

test("malformed fresh adapter reports are returned unchanged and never published", async () => {
  const h = harness(), malformed = [{ title: "adapter output retained" }];
  assert.equal(await h.run("spot-work", () => h.reuse(async () => malformed)), malformed);
  assert.equal(h.calls.length, 1);
  assert.equal(h.rows.size, 0);
});

test("cache serialization failures cannot replace a successful adapter report", async () => {
  const h = harness(), original = [entry()];
  original[0].rawPayload.notCloneable = () => "retained original value";
  assert.equal(await h.run("spot-work", () => h.reuse(async () => original)), original);
  assert.equal(h.calls.length, 1);
  assert.equal(h.rows.size, 0);
  assert.ok(h.logs.some(log => log.event === "error" && log.phase === "publish"));
});

test("synchronous RPC client failures do not change adapter behavior", async () => {
  const h = harness(), original = [entry()];
  h.db.rpc = () => { throw Error("private-lease-token in a client failure"); };
  assert.equal(await h.run("spot-work", () => h.reuse(async () => original)), original);
  assert.deepEqual(h.logs.map(log => log.phase), ["read", "publish"]);
  assert.ok(!JSON.stringify(h.logs).includes(token));
});

test("publication receives a private snapshot while the caller keeps its own fresh result", async () => {
  const h = harness({ respond: (call, normal) => {
    if (call.args.p_events !== null) call.args.p_events[0].rawPayload.eventPlace.facebookPlaceId = "snapshot only";
    return normal(call.args);
  } });
  const original = [entry()];
  assert.equal(await h.run("global-work", () => h.reuse(async () => original)), original);
  assert.equal(original[0].rawPayload.eventPlace.facebookPlaceId, "place-9");
});

test("concurrent misses keep their fresh results while the first completed publication wins", async () => {
  const h = harness(); let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const first = [entry("First")], second = [entry("Second")];
  let fetches = 0;
  const start = (work, result) => h.run(work, () => h.reuse(async () => {
    fetches++; if (fetches === 2) release(); await waiting; return result;
  }));
  const result = await Promise.all([start("global-work", first), start("spot-work", second)]);
  assert.equal(result[0], first);
  assert.equal(result[1], second);
  assert.equal(fetches, 2);
  const cached = await h.run("spot-work", () => h.reuse(async () => assert.fail("cached")));
  assert.equal(cached[0].title, "First");
  assert.equal(h.rows.size, 1);
});

test("Page key normalization retains path case and profile query identity", async () => {
  const h = harness(); let fetches = 0;
  const fetch = async () => [entry(String(++fetches))];
  await h.run("global-work", () => h.reuse(fetch, false, "http://m.facebook.com/ExamplePage/#tracking"));
  await h.run("spot-work", () => h.reuse(fetch, false, "https://mbasic.facebook.com/ExamplePage"));
  assert.equal(fetches, 1);
  for (const url of [
    "https://www.facebook.com/examplepage",
    "https://www.facebook.com/profile.php?id=111",
    "https://www.facebook.com/profile.php?id=222",
    "https://www.facebook.com/ExamplePage?identity=other",
  ]) await h.run("spot-work", () => h.reuse(fetch, false, url));
  assert.equal(fetches, 5);
  assert.ok(h.calls.some(call => call.args.p_page_url.endsWith("profile.php?id=111")));
});

test("unrecognized, credentialed, nonstandard-port and oversized URLs bypass only the cache", async () => {
  const h = harness(); let fetches = 0;
  const urls = [
    "not a URL", "https://facebook.com.evil.example/Page", "https://user:password@www.facebook.com/Page",
    "https://www.facebook.com:8443/Page", "ftp://www.facebook.com/Page", "https://www.facebook.com/",
    "https://www.facebook.com/" + "a".repeat(1024),
  ];
  for (const url of urls) {
    const original = [entry()];
    assert.equal(await h.run("spot-work", () => h.reuse(async () => { fetches++; return original; }, false, url)), original);
  }
  assert.equal(fetches, urls.length);
  assert.equal(h.calls.length, 0);
});

test("broken logging cannot affect successful reuse", async () => {
  const h = harness({ brokenLogger: true });
  const original = [entry()];
  assert.equal(await h.run("global-work", () => h.reuse(async () => original)), original);
  assert.deepEqual(await h.run("spot-work", () => h.reuse(async () => assert.fail("cached"))), original);
});

test("reuse diagnostics exclude Page URLs, tokens, event titles and raw payloads", async () => {
  const h = harness();
  await h.run("global-work", () => h.reuse(async () => [entry("private-event-title")]));
  const serialized = JSON.stringify(h.logs);
  for (const secret of [token, "facebook.com", "private-event-title", "eventPlace", "place-9"]) {
    assert.ok(!serialized.includes(secret));
  }
});
