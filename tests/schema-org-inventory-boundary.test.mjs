import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isSchemaOrgInventoryPage } from
  "../lib/event-harvester/first-party/schema-org-inventory.ts";

const collection = `
<script type="application/ld+json">
{"@type":"CollectionPage"}
</script>`;

const event = (url, name, startDate) => ({
  "@type": "Event",
  url,
  name,
  startDate,
});

test("individual event-detail page is not a source", () => {
  const url = "https://example.test/event/one";

  assert.equal(
    isSchemaOrgInventoryPage(
      [event(url, "Concert", "2026-11-12")],
      "",
      url,
    ),
    false,
  );
});

test("event detail remains excluded with collection metadata", () => {
  const url = "https://example.test/event/one";

  assert.equal(
    isSchemaOrgInventoryPage(
      [event(url, "Concert", "2026-11-12")],
      collection,
      url,
    ),
    false,
  );
});

test("fragment event identity identifies the detail page", () => {
  const url = "https://example.test/event/one";

  assert.equal(
    isSchemaOrgInventoryPage(
      [{
        "@type": "Event",
        "@id": `${url}#event`,
        name: "Concert",
        startDate: "2026-11-12",
      }],
      collection,
      url,
    ),
    false,
  );
});

test("single event without collection evidence is not a source", () => {
  assert.equal(
    isSchemaOrgInventoryPage(
      [event(
        "https://example.test/event/one",
        "Concert",
        "2026-11-12",
      )],
      "",
      "https://example.test/events",
    ),
    false,
  );
});

test("explicit collection with an event is a source", () => {
  assert.equal(
    isSchemaOrgInventoryPage(
      [event(
        "https://example.test/event/one",
        "Concert",
        "2026-11-12",
      )],
      collection,
      "https://example.test/events",
    ),
    true,
  );
});

test("multiple distinct events constitute an inventory", () => {
  assert.equal(
    isSchemaOrgInventoryPage(
      [
        event(
          "https://example.test/event/one",
          "Concert One",
          "2026-11-12",
        ),
        event(
          "https://example.test/event/two",
          "Concert Two",
          "2026-11-13",
        ),
      ],
      "",
      "https://example.test/events",
    ),
    true,
  );
});

test("duplicate copies of one event are not a collection", () => {
  const single = event(
    "https://example.test/event/one",
    "Concert",
    "2026-11-12",
  );

  assert.equal(
    isSchemaOrgInventoryPage(
      [single, single],
      "",
      "https://example.test/events",
    ),
    false,
  );
});

test("empty inventory cannot be inferred from Event markup", () => {
  assert.equal(
    isSchemaOrgInventoryPage(
      [],
      collection,
      "https://example.test/events",
    ),
    false,
  );
});

test("the detector uses the inventory gate", () => {
  const source = readFileSync(
    "lib/event-harvester/first-party/source-detector.ts",
    "utf8",
  );

  assert.match(
    source,
    /isSchemaOrgInventoryPage\(\s*extractSchemaOrgEvents\(html\)/,
  );

  assert.match(
    source,
    /hasSchemaOrgEventInventory &&/,
  );
});
