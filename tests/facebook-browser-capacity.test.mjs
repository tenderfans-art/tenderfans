import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const source = readFileSync(
  "lib/event-harvester/first-party/facebook-events.ts",
  "utf8"
);

const marker = "export async function fetchFacebookEvents(";
const start = source.indexOf(marker);

assert.ok(start >= 0);

const extracted = source.slice(start)
  .replace(marker, "async function fetchFacebookEvents(");

const javascript = ts.transpileModule(
  extracted + "\nglobalThis.runFacebook = fetchFacebookEvents;",
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }
).outputText;

async function scenario({ abort = false, grant = true } = {}) {
  const calls = [];
  const controller = new AbortController();

  const browser = {
    async newPage() {
      calls.push("new-page");
      return {
        async route(_pattern, handler) {
          calls.push("resource-filter-installed");

          for (const type of ["image", "font", "media", "script", "xhr"]) {
            const route = {
              request: () => ({ resourceType: () => type }),
              abort: async () => calls.push(type + "-blocked"),
              continue: async () => calls.push(type + "-allowed"),
            };
            await handler(route);
          }
        },
        async goto() {
          calls.push("navigate");

          if (abort) {
            controller.abort(new Error("Permit cancelled"));
          }

          throw new Error(
            "page.goto: net::ERR_INSUFFICIENT_RESOURCES"
          );
        },
      };
    },
    async close() {
      calls.push("browser-closed");
    },
  };

  const context = {
    getChromiumExecutablePath: async () => "/test/chromium",
    Chromium: {
      args: [],
      executablePath: async () => "/test/chromium",
    },
    playwright: {
      async launch() {
        calls.push("browser-launched");
        return browser;
      },
    },
    USER_AGENT: "Test",
    getTransportRecoveryProxy: () => undefined,
    isNonessentialBrowserResourceType: type =>
      ["image", "font", "media"].includes(type),
    eventsUrl: url => `${url}/events`,
    withTransportPermit: async (kind, operation) => {
      assert.equal(kind, "browser");
      calls.push("permit-requested");

      try {
        if (!grant) {
          throw new Error("Transport capacity unavailable: browser");
        }

        return await operation(controller.signal);
      } finally {
        calls.push("permit-released");
      }
    },
  };

  vm.runInNewContext(javascript, context);

  await assert.rejects(
    context.runFacebook("https://www.facebook.com/testpage"),
    /ERR_INSUFFICIENT_RESOURCES|Transport capacity unavailable/
  );

  return calls;
}

test("Facebook browser launch occurs inside shared capacity permit", () => {
  assert.match(
    source,
    /withTransportPermit\(\s*"browser",/
  );
});

test("navigation failure closes browser before permit release", async () => {
  const calls = await scenario();

  assert.deepEqual(calls, [
    "permit-requested",
    "browser-launched",
    "new-page",
    "resource-filter-installed",
    "image-blocked",
    "font-blocked",
    "media-blocked",
    "script-allowed",
    "xhr-allowed",
    "navigate",
    "browser-closed",
    "permit-released",
  ]);
});

test("permit cancellation closes browser exactly once", async () => {
  const calls = await scenario({ abort: true });

  assert.equal(
    calls.filter(value => value === "browser-closed").length,
    1
  );

  assert.ok(
    calls.indexOf("browser-closed") <
    calls.indexOf("permit-released")
  );
});

test("Facebook retains scripts and data while blocking media", () => {
  assert.match(source, /page\.route\("\*\*\/\*"/);
  assert.match(source, /isNonessentialBrowserResourceType/);
});

test("capacity denial cannot launch an unpermitted browser", async () => {
  const calls = await scenario({ grant: false });

  assert.deepEqual(calls, [
    "permit-requested",
    "permit-released",
  ]);
});
