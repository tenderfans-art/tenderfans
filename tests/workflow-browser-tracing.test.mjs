import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = readFileSync(
  new URL("../next.config.ts", import.meta.url),
  "utf8",
);

test("Workflow runtime explicitly traces browser assets", () => {
  const block = config.match(
    /"\/\.well-known\/workflow\/v1\/\*":\s*\[([\s\S]*?)\]/,
  );

  assert.ok(
    block,
    "Workflow flow and step routes must have tracing",
  );

  assert.match(
    block[1],
    /node_modules\/playwright-core\/browsers\.json/,
  );

  assert.match(
    block[1],
    /node_modules\/@sparticuz\/chromium\/bin\/\*\*\/\*/,
  );

  assert.match(
    config,
    /"\/api\/jobs\/first-party-event-detector":\s*\[/,
  );

  assert.match(
    config,
    /"\/api\/jobs\/first-party-event-harvester":\s*\[/,
  );
});
