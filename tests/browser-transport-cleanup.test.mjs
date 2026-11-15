import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync("lib/event-harvester/first-party/browser-transport.ts", "utf8");
const compile = text => ts.transpileModule(
  text + "\nexport { fetchBrowserJsonResponsesOnce as inspectJsonOnce };",
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const javascript = compile(source);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(setImmediate);
const url = "https://venue.example.com/events";
const proxy = "http://user:private-password@proxy.example.com:8080";

function scenario({ kind, useProxy = false, abort = false, abortRecovery = false, navigationError, launchError } = {}) {
  const calls = [], launchOptions = [], payload = { events: [{ id: "verified-event" }] };
  const cleanup = deferred(), closeStarted = deferred();
  const browserController = new AbortController(), recoveryController = new AbortController();
  const abortReason = Object.assign(Error("Browser budget expired"), { name: "BrowserOperationTimeoutError" });
  let closeCalls = 0, settled = false;
  const page = {
    async route() { calls.push("route-filter"); },
    on(event, listener) { if (event === "response") this.onResponse = listener; },
    async goto() {
      calls.push("navigate");
      if (abort) {
        (abortRecovery ? recoveryController : browserController).abort(abortReason);
        // Chromium disconnect rejects the outstanding navigation while
        // Playwright's first close still awaits profile/artifact removal.
        throw abortReason;
      }
      if (navigationError) throw navigationError;
      this.onResponse?.({
        url: () => "https://venue.example.com/api/events",
        ok: () => true,
        json: async () => payload,
      });
      return { status: () => 200 };
    },
    async waitForTimeout() {},
    url: () => url,
    content: async () => "<html>Verified event page</html>",
    frames: () => [],
  };
  const browser = {
    newPage: async () => page,
    close() {
      closeCalls++;
      if (closeCalls > 1) {
        // Reproduce Playwright 1.63: the second close can finish once
        // disconnected, without awaiting the first cleanup promise.
        calls.push("second-close-after-disconnect");
        return Promise.resolve();
      }
      calls.push("browser-disconnected");
      closeStarted.resolve();
      return cleanup.promise.then(() => calls.push("cleanup-finished"), error => {
        calls.push("cleanup-failed");
        throw error;
      });
    },
  };
  const exports = {};
  new Function("require", "exports", javascript)(name => {
    if (name.endsWith("transport-recovery-context")) return { getTransportRecoveryProxy: () => undefined };
    if (name === "playwright-core") return { chromium: { launch: async options => {
      calls.push("launch"); launchOptions.push(options);
      if (launchError) throw launchError;
      return browser;
    } } };
    if (name === "@sparticuz/chromium") return { default: { args: ["--existing-browser-flag"] } };
    if (name === "./chromium-runtime") return { getChromiumExecutablePath: async () => "/tmp/chromium" };
    if (name === "../transport-capacity-permits") return { withTransportPermit: async (capacity, operation, parent) => {
      calls.push("acquire-" + capacity);
      if (capacity === "browser") assert.equal(parent, useProxy ? recoveryController.signal : undefined);
      try {
        return await operation(capacity === "browser" ? browserController.signal : recoveryController.signal);
      } finally {
        calls.push("release-" + capacity);
      }
    } };
    throw Error("Unexpected dependency " + name);
  }, exports);
  const pending = (kind === "evidence"
    ? exports.fetchBrowserEvidence(url, useProxy ? proxy : undefined)
    : exports.inspectJsonOnce(url, candidate => candidate.endsWith("/api/events"), useProxy ? proxy : undefined));
  const result = pending.then(value => { settled = true; return value; }, error => { settled = true; throw error; });
  // Observe immediately so deliberate failures never become unhandled.
  result.catch(() => {});
  return {
    result, calls, launchOptions, cleanup, closeStarted, abortReason, payload,
    closeCalls: () => closeCalls, settled: () => settled,
  };
}

for (const kind of ["evidence", "json"]) {
  test(`${kind}: aborted navigation retains the browser permit until original cleanup finishes`, async () => {
    const s = scenario({ kind, abort: true });
    await s.closeStarted.promise;
    await flush();
    assert.equal(s.closeCalls(), 1);
    assert.equal(s.settled(), false);
    assert.ok(!s.calls.includes("release-browser"));
    assert.ok(!s.calls.includes("second-close-after-disconnect"));
    s.cleanup.resolve();
    await assert.rejects(s.result, error => error === s.abortReason);
    assert.ok(s.calls.indexOf("cleanup-finished") < s.calls.indexOf("release-browser"));
  });

  test(`${kind}: proxied abort retains recovery and browser capacity through cleanup`, async () => {
    const s = scenario({ kind, abort: true, useProxy: true });
    await s.closeStarted.promise;
    await flush();
    assert.deepEqual(s.calls.slice(0, 3), ["acquire-recovery", "acquire-browser", "launch"]);
    assert.equal(s.closeCalls(), 1);
    assert.ok(!s.calls.some(call => call.startsWith("release-")));
    assert.deepEqual(s.launchOptions[0].proxy, {
      server: "http://proxy.example.com:8080", username: "user", password: "private-password",
    });
    s.cleanup.resolve();
    await assert.rejects(s.result, error => error === s.abortReason);
    assert.deepEqual(s.calls.slice(-3), ["cleanup-finished", "release-browser", "release-recovery"]);
  });

  test(`${kind}: recovery-signal cancellation shares the same pending close`, async () => {
    const s = scenario({ kind, abort: true, abortRecovery: true, useProxy: true });
    await s.closeStarted.promise;
    await flush();
    assert.equal(s.settled(), false);
    assert.equal(s.closeCalls(), 1);
    assert.ok(!s.calls.includes("release-recovery"));
    s.cleanup.resolve();
    await assert.rejects(s.result, error => error === s.abortReason);
    assert.ok(s.calls.indexOf("cleanup-finished") < s.calls.indexOf("release-browser"));
  });

  test(`${kind}: ordinary success preserves inventory and waits for cleanup`, async () => {
    const s = scenario({ kind });
    await s.closeStarted.promise;
    await flush();
    assert.equal(s.closeCalls(), 1);
    assert.equal(s.settled(), false);
    assert.ok(!s.calls.includes("release-browser"));
    assert.equal(s.launchOptions[0].timeout, 30000);
    assert.equal(s.launchOptions[0].headless, true);
    assert.deepEqual(s.launchOptions[0].args, ["--existing-browser-flag"]);
    s.cleanup.resolve();
    const value = await s.result;
    assert.equal(value.status, 200);
    if (kind === "evidence") {
      assert.equal(value.html, "<html>Verified event page</html>");
      assert.equal(value.finalUrl, url);
    } else {
      assert.deepEqual(value.payloads, [s.payload]);
      assert.equal(value.observedEndpoint, true);
      assert.equal(value.successfulResponse, true);
    }
    assert.ok(s.calls.indexOf("cleanup-finished") < s.calls.indexOf("release-browser"));
  });

  test(`${kind}: navigation failures remain failures after one complete cleanup`, async () => {
    const navigationError = Error("original navigation failure");
    const s = scenario({ kind, navigationError });
    await s.closeStarted.promise;
    await flush();
    assert.equal(s.settled(), false);
    assert.equal(s.closeCalls(), 1);
    s.cleanup.resolve();
    await assert.rejects(s.result, error => error === navigationError);
    assert.ok(s.calls.indexOf("cleanup-finished") < s.calls.indexOf("release-browser"));
  });

  test(`${kind}: cleanup rejection cannot turn successful extraction into success`, async () => {
    const cleanupError = Error("original cleanup failure");
    const s = scenario({ kind });
    await s.closeStarted.promise;
    s.cleanup.reject(cleanupError);
    await assert.rejects(s.result, error => error === cleanupError);
    assert.equal(s.closeCalls(), 1);
    assert.ok(s.calls.indexOf("cleanup-failed") < s.calls.indexOf("release-browser"));
  });

  test(`${kind}: abort callback cannot swallow a later cleanup rejection`, async () => {
    const cleanupError = Error("cleanup failed after disconnection");
    const s = scenario({ kind, abort: true });
    await s.closeStarted.promise;
    await flush();
    assert.equal(s.settled(), false);
    s.cleanup.reject(cleanupError);
    await assert.rejects(s.result, error => error === cleanupError);
    assert.equal(s.closeCalls(), 1);
    assert.ok(s.calls.indexOf("cleanup-failed") < s.calls.indexOf("release-browser"));
  });

  test(`${kind}: launch failure retains its original error and never closes an absent browser`, async () => {
    const launchError = Error("original launch failure");
    const s = scenario({ kind, launchError });
    await assert.rejects(s.result, error => error === launchError);
    assert.equal(s.closeCalls(), 0);
    assert.deepEqual(s.calls, ["acquire-browser", "launch", "release-browser"]);
  });
}
