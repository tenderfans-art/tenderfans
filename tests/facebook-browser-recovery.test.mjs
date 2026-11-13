import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const facebook = readFileSync(
  "lib/event-harvester/first-party/facebook-events.ts",
  "utf8",
);
const browser = readFileSync(
  "lib/event-harvester/first-party/browser-transport.ts",
  "utf8",
);

const start = facebook.indexOf(
  "export async function fetchFacebookEvents(",
);
const end = facebook.indexOf(
  "async function fetchFacebookEventsUnderPermit(",
  start,
);

assert.ok(start >= 0 && end > start);

const wrapper = facebook.slice(start, end).replace(
  "export async function fetchFacebookEvents(",
  "async function fetchFacebookEvents(",
);

const javascript = ts.transpileModule(
  wrapper + "\nglobalThis.runFacebook = fetchFacebookEvents;",
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  },
).outputText;

function scenario({
  proxyUrl = "http://user:secret@proxy.example:3128",
  directError = null,
  recoveryError = null,
  denyRecovery = false,
} = {}) {
  const calls = [];
  let recoverySignal = null;

  const context = {
    Error,
    getTransportRecoveryProxy: () => proxyUrl,
    getSpotExecutionSignal: () => undefined,
    browserProxyOptions(url) {
      assert.equal(url, proxyUrl);
      calls.push("configure-proxy");

      return {
        server: "http://proxy.example:3128",
        username: "user",
        password: "secret",
      };
    },
    async withTransportPermit(kind, operation, parentSignal) {
      calls.push("acquire:" + kind);

      if (kind === "browser" && recoverySignal) {
        assert.equal(parentSignal, recoverySignal);
      }

      const signal = new AbortController().signal;

      if (kind === "recovery") {
        recoverySignal = signal;
      }

      try {
        if (kind === "recovery" && denyRecovery) {
          const error = new Error(
            "Transport capacity unavailable: recovery",
          );
          error.name = "TransportCapacityUnavailableError";
          throw error;
        }

        return await operation(signal);
      } finally {
        calls.push("release:" + kind);
      }
    },
    async fetchFacebookEventsUnderPermit(
      _url, _options, signal, proxy,
    ) {
      signal.throwIfAborted();

      calls.push(
        proxy ? "attempt:proxy" : "attempt:direct",
      );

      const message = proxy
        ? recoveryError
        : directError;

      if (message) throw new Error(message);

      return [{
        externalEventId: proxy
          ? "facebook:recovered"
          : "facebook:direct",
      }];
    },
    console: {
      info() {},
      warn() {},
    },
  };

  vm.runInNewContext(javascript, context);

  return {
    calls,
    run: () =>
      context.runFacebook(
        "https://www.facebook.com/example",
      ),
  };
}

test("direct browser success does not acquire recovery capacity", async () => {
  const { calls, run } = scenario();
  const events = await run();

  assert.equal(events[0].externalEventId, "facebook:direct");
  assert.deepEqual(calls, [
    "acquire:browser",
    "attempt:direct",
    "release:browser",
  ]);
});

test("access restriction retries through recovery then browser", async () => {
  const { calls, run } = scenario({
    directError:
      "Facebook Events page is unavailable or access restricted",
  });

  const events = await run();

  assert.equal(events[0].externalEventId, "facebook:recovered");

  assert.deepEqual(calls, [
    "acquire:browser",
    "attempt:direct",
    "release:browser",
    "configure-proxy",
    "acquire:recovery",
    "acquire:browser",
    "attempt:proxy",
    "release:browser",
    "release:recovery",
  ]);
});

test("recognized HTTP access restrictions permit recovery", async () => {
  for (const status of [403, 429, 503]) {
    const { calls, run } = scenario({
      directError: `Facebook events page returned HTTP ${status}`,
    });

    const events = await run();

    assert.equal(
      events[0].externalEventId,
      "facebook:recovered",
    );
    assert.ok(calls.includes("acquire:recovery"));
  }
});

test("missing Events surface and HTTP 404 never retry", async () => {
  for (const error of [
    "Facebook Page has no public Events surface",
    "Facebook events page returned HTTP 404",
    "Facebook Page requires login",
  ]) {
    const { calls, run } = scenario({
      directError: error,
    });

    await assert.rejects(run(), {
      message: error,
    });

    assert.equal(
      calls.includes("acquire:recovery"),
      false,
    );
  }
});

test("no recovery context preserves direct failure", async () => {
  const { calls, run } = scenario({
    proxyUrl: null,
    directError:
      "Facebook Events page is unavailable or access restricted",
  });

  await assert.rejects(run(), /access restricted/);

  assert.equal(
    calls.includes("acquire:recovery"),
    false,
  );

  assert.deepEqual(calls, [
    "acquire:browser",
    "attempt:direct",
    "release:browser",
  ]);
});

test("proxy access failure preserves original classification", async () => {
  const { calls, run } = scenario({
    directError:
      "Facebook Events page is unavailable or access restricted",
    recoveryError: "net::ERR_PROXY_CONNECTION_FAILED",
  });

  await assert.rejects(run(), /access restricted/);

  assert.ok(calls.includes("attempt:proxy"));
  assert.equal(calls.at(-1), "release:recovery");
});

test("recovery permit denial remains an infrastructure failure", async () => {
  const { calls, run } = scenario({
    directError:
      "Facebook Events page is unavailable or access restricted",
    denyRecovery: true,
  });

  await assert.rejects(
    run(),
    /Transport capacity unavailable: recovery/,
  );

  assert.equal(calls.includes("attempt:proxy"), false);
  assert.equal(calls.at(-1), "release:recovery");
});

test("browser resource failures are never converted to access failures", async () => {
  const { calls, run } = scenario({
    directError: "page.goto: net::ERR_INSUFFICIENT_RESOURCES",
  });

  await assert.rejects(run(), /ERR_INSUFFICIENT_RESOURCES/);
  assert.equal(calls.includes("acquire:recovery"), false);
});

test("Playwright receives proxy only on the recovery attempt", () => {
  assert.match(
    facebook,
    /fetchFacebookEventsUnderPermit\([\s\S]*?permitSignal,\s*proxy/,
  );
  assert.match(
    facebook,
    /\.\.\.\(proxy \? \{ proxy \} : \{\}\)/,
  );
});

test("shared proxy parser preserves credentials and protocol rules", () => {
  const parserStart = browser.indexOf(
    "export function browserProxyOptions(",
  );
  const parserEnd = browser.indexOf(
    "export function isNonessentialBrowserResourceType(",
    parserStart,
  );

  assert.ok(parserStart >= 0 && parserEnd > parserStart);

  const parser = browser.slice(
    parserStart,
    parserEnd,
  ).replace(
    "export function browserProxyOptions(",
    "function browserProxyOptions(",
  );

  const code = ts.transpileModule(
    parser + "\nglobalThis.parseProxy = browserProxyOptions;",
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    },
  ).outputText;

  const context = { URL };
  vm.runInNewContext(code, context);

  const config = context.parseProxy(
    "http://name%40team:p%40ss@proxy.example:3128",
  );

  assert.equal(config.server, "http://proxy.example:3128");
  assert.equal(config.username, "name@team");
  assert.equal(config.password, "p@ss");

  assert.throws(
    () => context.parseProxy(
      "socks5://proxy.example:1080",
    ),
    /Unsupported browser proxy protocol/,
  );
});
