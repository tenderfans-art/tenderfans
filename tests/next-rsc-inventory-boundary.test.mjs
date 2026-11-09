import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  extractNextRscEventRecords as parse,
  isNextRscInventoryPage as inventory,
} from "../lib/event-harvester/first-party/next-rsc-inventory.ts";

const event = (id, slug, status = "upcoming") => ({
  id, slug, title: `Show ${id}`,
  startsAtIso: "2026-12-12T20:00:00Z",
  status, isDraft: false,
});
const html = events => {
  const payload = events.map(x => JSON.stringify(x)).join(",");
  return `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;
};

test("RSC calendar is a source", () => {
  const page = html([event("1","one"), event("2","two")]);
  assert.equal(parse(page).length, 2);
  assert.equal(inventory(page, "https://example.test/music"), true);
});

test("individual detail page is not a source", () => {
  assert.equal(inventory(html([]), "https://example.test/music/one"), false);
  assert.equal(inventory(html([event("1","one")]), "https://example.test/music"), false);
});

test("detail containing related events remains excluded", () => {
  const page = html([event("1","one"), event("2","two")]);
  assert.equal(inventory(page, "https://example.test/music/one"), false);
});

test("duplicate RSC records do not establish collection", () => {
  const page = html([event("1","one"), event("1","one")]);
  assert.equal(parse(page).length, 1);
  assert.equal(inventory(page, "https://example.test/music"), false);
});

test("historical inventory is still recognized", () => {
  const page = html([
    event("1","one","completed"), event("2","two","completed")
  ]);
  assert.equal(inventory(page, "https://example.test/music"), true);
});

test("detector and harvester use the shared parser", () => {
  const detector = readFileSync(
    "lib/event-harvester/first-party/source-detector.ts", "utf8"
  );
  const harvester = readFileSync(
    "lib/event-harvester/first-party/next-rsc-events.ts", "utf8"
  );
  assert.match(detector, /isNextRscInventoryPage\(html, pageUrl\)/);
  assert.match(harvester, /extractNextRscEventRecords\(html\)/);
});
