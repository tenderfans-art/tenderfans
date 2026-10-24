import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const ts = require("typescript");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith("@/")) {
    request = path.resolve(process.cwd(), request.slice(2));
  }
  return originalResolve.call(this, request, parent, ...rest);
};

require.extensions[".ts"] = function (module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  module._compile(compiled.outputText, filename);
};

const {
  fetchSpotHopperEvents,
  SpotHopperSurfaceError,
} = require("../lib/event-harvester/first-party/spothopper-events.ts");

const originalFetch = globalThis.fetch;

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

function site(body = "") {
  return `<html><head><meta name="generator" content="SpotHopper"></head><body>${body}</body></html>`;
}

async function withMockFetch(responses, run) {
  globalThis.fetch = async (input) => {
    const url = String(input);
    const response = responses[url];

    if (!response) {
      throw new Error(`Unexpected URL: ${url}`);
    }

    return htmlResponse(response.body, response.status);
  };

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("recognized empty calendar remains valid", async () => {
  await withMockFetch({
    "https://example.test/": {
      body: site('<div class="events-general-holder"><div id="noEventsMessage"></div></div>'),
      status: 200,
    },
  }, async () => {
    const events = await fetchSpotHopperEvents("https://example.test/");
    assert.deepEqual(events, []);
  });
});

test("accessible site without calendar is unsupported", async () => {
  await withMockFetch({
    "https://example.test/": {
      body: site(),
      status: 200,
    },
    "https://example.test/-events": {
      body: site(),
      status: 200,
    },
    "https://example.test/events": {
      body: site(),
      status: 200,
    },
  }, async () => {
    await assert.rejects(
      fetchSpotHopperEvents("https://example.test/"),
      (error) =>
        error instanceof SpotHopperSurfaceError &&
        error.reason === "unsupported_surface"
    );
  });
});

test("blocked calendar candidates preserve access failure", async () => {
  await withMockFetch({
    "https://example.test/": {
      body: site(),
      status: 200,
    },
    "https://example.test/-events": {
      body: "Forbidden",
      status: 403,
    },
    "https://example.test/events": {
      body: "Forbidden",
      status: 403,
    },
  }, async () => {
    await assert.rejects(
      fetchSpotHopperEvents("https://example.test/"),
      (error) =>
        error instanceof SpotHopperSurfaceError &&
        error.reason === "access_failed" &&
        error.message.includes("HTTP 403")
    );
  });
});

test("valid calendar succeeds despite earlier candidate failure", async () => {
  await withMockFetch({
    "https://example.test/": {
      body: site('<a href="/-events">Events</a><a href="/events">Calendar</a>'),
      status: 200,
    },
    "https://example.test/-events": {
      body: "Forbidden",
      status: 403,
    },
    "https://example.test/events": {
      body: site('<div class="events-general-holder"><div id="noEventsMessage"></div></div>'),
      status: 200,
    },
  }, async () => {
    const events = await fetchSpotHopperEvents("https://example.test/");
    assert.deepEqual(events, []);
  });
});
