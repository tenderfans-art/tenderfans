import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(
  "lib/event-harvester/market-batch-executor.ts",
  "utf8",
);

const start = source.indexOf("export class MarketLeaseLostError");
const end = source.indexOf(
  "export async function executeMarketHarvesterBatch(",
);

assert.ok(start >= 0 && end > start);

const isolated = source.slice(start, end);

const compiled = ts.transpileModule(isolated, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

const module = { exports: {} };
new Function("module", "exports", compiled)(
  module,
  module.exports,
);

const {
  withLeaseRenewal,
  MarketLeaseLostError,
  MarketWorkDeadlineExceededError,
} = module.exports;

function fakeDb(handler) {
  return {
    rpc: async (name, args) => {
      assert.equal(name, "renew_event_processing_lease");
      assert.equal(args.p_work_id, "work-1");
      assert.equal(args.p_lease_token, "token-1");
      return handler();
    },
  };
}

const tick = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

test("successful ingestion stops heartbeat", async () => {
  let renewals = 0;

  const result = await withLeaseRenewal(
    fakeDb(() => {
      renewals++;
      return { data: true, error: null };
    }),
    "work-1",
    "token-1",
    async () => "success",
    5,
  );

  assert.equal(result, "success");

  const count = renewals;
  await tick(20);

  assert.equal(renewals, count);
});

test("active ingestion renews its lease", async () => {
  let renewals = 0;

  const result = await withLeaseRenewal(
    fakeDb(() => {
      renewals++;
      return { data: true, error: null };
    }),
    "work-1",
    "token-1",
    async () => {
      await tick(35);
      return "finished";
    },
    5,
  );

  assert.equal(result, "finished");
  assert.ok(renewals >= 1);
});

test("lost lease ownership is reported distinctly", async () => {
  await assert.rejects(
    withLeaseRenewal(
      fakeDb(() => ({ data: false, error: null })),
      "work-1",
      "token-1",
      async () => {
        await tick(25);
        return "finished";
      },
      5,
    ),
    MarketLeaseLostError,
  );
});

test("renewal RPC rejection becomes lease-loss error", async () => {
  await assert.rejects(
    withLeaseRenewal(
      fakeDb(() => {
        throw new Error("database unavailable");
      }),
      "work-1",
      "token-1",
      async () => {
        await tick(25);
        return "finished";
      },
      5,
    ),
    MarketLeaseLostError,
  );
});

test("shutdown waits for an in-flight renewal", async () => {
  let releaseRenewal;
  let renewalStarted;

  const started = new Promise((resolve) => {
    renewalStarted = resolve;
  });

  const renewalDone = new Promise((resolve) => {
    releaseRenewal = resolve;
  });

  let finished = false;

  const running = withLeaseRenewal(
    fakeDb(async () => {
      renewalStarted();
      await renewalDone;
      return { data: true, error: null };
    }),
    "work-1",
    "token-1",
    async () => {
      await started;
      return "done";
    },
    5,
  ).then((value) => {
    finished = true;
    return value;
  });

  await started;
  await tick(10);

  assert.equal(finished, false);

  releaseRenewal();

  assert.equal(await running, "done");
  assert.equal(finished, true);
});

test("original ingestion failure is preserved", async () => {
  const original = new Error("ingestion failed");

  await assert.rejects(
    withLeaseRenewal(
      fakeDb(() => ({ data: true, error: null })),
      "work-1",
      "token-1",
      async () => {
        throw original;
      },
      5,
    ),
    (error) => error === original,
  );
});

test("Spot deadline requests cancellation and waits for cleanup", async () => {
  let cleanupFinished = false;

  await assert.rejects(
    withLeaseRenewal(
      fakeDb(() => ({ data: true, error: null })),
      "work-1",
      "token-1",
      async (signal) => {
        await new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            setTimeout(() => {
              cleanupFinished = true;
              resolve();
            }, 20);
          }, { once: true });
        });
      },
      5,
      15,
    ),
    MarketWorkDeadlineExceededError,
  );

  assert.equal(cleanupFinished, true);
});

test("bounded successful work retains normal completion", async () => {
  const value = await withLeaseRenewal(
    fakeDb(() => ({ data: true, error: null })),
    "work-1",
    "token-1",
    async (signal) => {
      assert.equal(signal.aborted, false);
      return "completed";
    },
    5,
    1000,
  );

  assert.equal(value, "completed");
});
