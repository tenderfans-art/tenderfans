import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const read = p => readFileSync(p, "utf8");
const compile = s => ts.transpileModule(s, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function harness({ brokenLogger = false, brokenResources = false, blockedResources = false,
  lowStorage = false, blockedStorage = false } = {}) {
  const events = [], timers = new Set();
  let storageProbes = 0;
  let clock = 1000;
  class Clock extends Date { static now() { return clock; } }
  const fs = {
    statfs: async () => {
      if (blockedResources) await new Promise(() => {});
      if (brokenResources) throw Error("unavailable");
      return { bavail: lowStorage ? 4 : 512, bsize: 1048576 };
    },
    readFile: async () => {
      if (brokenResources) throw Error("unavailable");
      return "104857600";
    },
  };
  const exports = {};
  new Function("require", "exports", "console", "setInterval", "clearInterval", "Date", "process",
    compile(read("lib/event-harvester/market-scheduler-diagnostics.ts")))(
    name => name === "node:fs/promises" ? fs :
      name === "./market-runtime-storage-diagnostics" ? {
        getMarketRuntimeStorageDiagnostics: async () => {
          storageProbes++;
          if (blockedStorage) await new Promise(() => {});
          return { tmpProfilesMiB: 300 };
        },
      } : require(name), exports,
    { info(tag, json) { if (brokenLogger) throw Error("logger unavailable"); events.push(JSON.parse(json)); } },
    callback => { const timer = { callback, unref() {} }; timers.add(timer); return timer; },
    timer => timers.delete(timer), Clock,
    { pid: 7, env: {}, memoryUsage: () => ({ rss: 67108864 }) },
  );
  return { ...exports, events, timers, storageProbes: () => storageProbes,
    advance(ms) { clock += ms; } };
}
const identity = { workId: "work-a", stepId: "step-a", attempt: 1, leaseToken: "must-not-log" };
const flush = () => new Promise(setImmediate);

test("diagnostics preserve original results and exclude execution tokens", async () => {
  const h = harness();
  const flags = { detectorFailed: 1, harvestSkipped: false, sourcesFailed: 1 };
  const value = await h.withMarketSchedulerDiagnostics(identity, async () => {
    h.markMarketSchedulerPhase("detector");
    h.advance(20);
    h.markMarketSchedulerPhase("harvester");
    return flags;
  });
  assert.equal(value, flags);
  assert.equal(h.timers.size, 0);
  assert.ok(h.events.some(e => e.phase === "detector" && e.phaseMs === 20));
  assert.ok(h.events.some(e => e.phase === "harvester"));
  assert.ok(!JSON.stringify(h.events).includes("must-not-log"));
});

test("diagnostics preserve the exact original exception", async () => {
  const h = harness(), error = new Error("original execution error");
  await assert.rejects(h.withMarketSchedulerDiagnostics(identity, async () => { throw error; }), e => e === error);
  assert.equal(h.timers.size, 0);
  assert.equal(h.events.at(-1).event, "execution-ended");
});

test("missing resource access and broken logging never change processing", async () => {
  const h = harness({ brokenResources: true, brokenLogger: true });
  assert.equal(await h.withMarketSchedulerDiagnostics(identity, async () => 42), 42);
  assert.equal(h.timers.size, 0);
});

test("resource sampling is not awaited by processing or cleanup", async () => {
  const h = harness({ blockedResources: true });
  assert.equal(await h.withMarketSchedulerDiagnostics(identity, async () => 42), 42);
  assert.equal(h.timers.size, 0);
});

test("concurrent executions retain independent phase context", async () => {
  const h = harness(); let release;
  const wait = new Promise(resolve => { release = resolve; });
  const first = h.withMarketSchedulerDiagnostics(identity, async () => {
    h.markMarketSchedulerPhase("detector"); await wait;
    h.markMarketSchedulerPhase("record-completion");
  });
  const second = h.withMarketSchedulerDiagnostics({ workId: "work-b", stepId: "step-b", attempt: 2 }, async () => {
    h.markMarketSchedulerPhase("harvester"); await wait;
  });
  await flush();
  for (const timer of h.timers) timer.callback();
  assert.ok(h.events.some(e => e.workId === "work-a" && e.phase === "detector" && e.activeExecutionsInProcess === 2));
  assert.ok(h.events.some(e => e.workId === "work-b" && e.phase === "harvester" && e.sdkAttempt === 2));
  release(); await Promise.all([first, second]);
  assert.equal(h.timers.size, 0);
});

test("storage breakdown is bounded to once per process per minute under pressure", async () => {
  const h = harness({ lowStorage: true });
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const first = h.withMarketSchedulerDiagnostics(identity, async () => wait);
  const second = h.withMarketSchedulerDiagnostics({ ...identity, workId: "work-b" }, async () => wait);
  await flush();
  assert.equal(h.storageProbes(), 1);
  assert.equal(h.events.filter(e => e.event === "storage-pressure").length, 1);
  h.advance(30_000);
  for (const timer of h.timers) timer.callback();
  await flush();
  assert.equal(h.storageProbes(), 1);
  h.advance(30_000);
  for (const timer of h.timers) timer.callback();
  await flush();
  assert.equal(h.storageProbes(), 2);
  release();
  await Promise.all([first, second]);
});

test("storage inspection cannot block original processing or its cleanup", async () => {
  const h = harness({ lowStorage: true, blockedStorage: true });
  const value = await h.withMarketSchedulerDiagnostics(identity, async () => { await flush(); return 42; });
  assert.equal(value, 42);
  assert.equal(h.storageProbes(), 1);
  assert.equal(h.timers.size, 0);
});

test("normal free space does not inspect profiles or process descriptors", async () => {
  const h = harness();
  await h.withMarketSchedulerDiagnostics(identity, async () => { await flush(); return 42; });
  assert.equal(h.storageProbes(), 0);
});

const batch = read("lib/event-harvester/market-batch-executor.ts");
const isolated = batch.slice(batch.indexOf("export class MarketLeaseLostError"), batch.indexOf("export async function executeMarketHarvesterBatch("));
const exports = {};
new Function("exports", compile(isolated))(exports);
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

test("observes a blocked renewal and shutdown without releasing it early", async () => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const events = []; let finished = false;
  const run = exports.withLeaseRenewal({ rpc: async () => { started(); return response; } }, "work", "token",
    async () => { await waiting; return 42; }, 5, undefined,
    { renewal: e => events.push(e), shutdown: () => events.push("shutdown") })
    .then(value => { finished = true; return value; });
  await waiting; await tick(10);
  assert.equal(finished, false);
  assert.deepEqual(events, ["start", "shutdown"]);
  release({ data: true, error: null });
  assert.equal(await run, 42);
  assert.deepEqual(events, ["start", "shutdown", "end"]);
});

test("diagnostic hook exceptions cannot alter lease or execution outcomes", async () => {
  let calls = 0;
  const value = await exports.withLeaseRenewal({ rpc: async () => { calls++; return { data: true, error: null }; } },
    "work", "token", async () => { await tick(20); return 42; }, 5, undefined,
    { renewal() { throw Error("diagnostic only"); }, shutdown() { throw Error("diagnostic only"); } });
  assert.equal(value, 42);
  assert.ok(calls > 0);
});
