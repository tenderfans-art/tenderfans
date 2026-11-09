import test from "node:test";
import assert from "node:assert/strict";
import {
  isSquarespaceInventoryPage as inventory,
  discoverIcalUrls,
} from "../lib/event-harvester/first-party/squarespace-inventory.ts";

const root = "https://example.test/events";
const link = slug =>
  `<a href="/events/${slug}?format=ical">Calendar</a>`;

test("calendar with multiple events is a source", () => {
  assert.equal(inventory(link("one") + link("two"), root), true);
});

test("individual event is not a source", () => {
  assert.equal(inventory(link("one"), root + "/one"), false);
});

test("detail with related events remains excluded", () => {
  assert.equal(inventory(link("one") + link("two"), root + "/one"), false);
});

test("arbitrary single event link is not a source", () => {
  assert.equal(inventory(link("one"), root), false);
});

test("explicit one-event listing remains supported", () => {
  const html = `<div class="eventlist-event">${link("one")}</div>`;
  assert.equal(inventory(html, root), true);
});

test("existing iCal parser retains its URLs", () => {
  assert.deepEqual(
    discoverIcalUrls(link("one"), root),
    [root + "/one?format=ical"],
  );
});
