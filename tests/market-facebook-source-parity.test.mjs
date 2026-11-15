import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
function compile(path, imports = {}) {
  const exports = {};
  const js = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", js)(
    name => Object.hasOwn(imports, name) ? imports[name] : require(name), exports,
  );
  return exports;
}

const sampleEvent = {
  externalEventId: "facebook-occurrence-1", sourceUrl: "https://www.facebook.com/events/123/",
  title: "Live Music", description: null, startsAt: "2050-01-10T20:00:00Z", endsAt: null,
  allDay: false, flyerUrl: null, location: null, venueName: "New Business",
  venueAddress: "15 New St, Dunedin, FL 34698", allowSourceDefaultAttribution: false,
  rawPayload: { platform: "facebook_events", allowSourceDefaultAttribution: false },
};
const source = (id, venueId) => ({
  id, provider: "first_party", source_type: "facebook_events", name: id,
  source_url: "https://www.facebook.com/OnePage/", external_source_id: "one-page",
  venue_id: venueId, is_enabled: true, trust_level: "trusted", config: {}, bootstrapped_at: null,
});

function harness({ event = sampleEvent, approvedSource = null } = {}) {
  const cache = new Map(), calls = { fetch: [], attribution: [], google: [], recorded: [] };
  const db = {
    rpc(name, args) {
      if (name === "market_facebook_inventory") {
        const key = JSON.stringify([args.p_page_url, args.p_validate_page_identity]);
        return { abortSignal: async () => {
          if (args.p_events !== null && !cache.has(key)) cache.set(key, structuredClone(args.p_events));
          return { data: cache.has(key) ? structuredClone(cache.get(key)) : null, error: null };
        } };
      }
      assert.equal(name, "resolved_event_harvest_venue");
      calls.attribution.push(args.p_source_id);
      return Promise.resolve({
        data: args.p_source_id === approvedSource ? [{ venue_id: "human-approved-spot" }] : [],
        error: null,
      });
    },
    from(table) {
      assert.equal(table, "venues");
      let id;
      const q = {
        select() { return q; },
        eq(field, value) { if (field === "id") id = value; return q; },
        maybeSingle: async () => ({ data: id ? {
          name: "Original Source Spot", street_address: "1 Old St", city: "Dunedin",
          state_region: "FL", postal_code: "34698",
        } : null, error: null }),
        then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); },
      };
      return q;
    },
  };
  const reuse = compile("lib/event-harvester/market-facebook-inventory.ts", {
    "./transport-capacity-context": { getSpotExecutionSignal: () => undefined },
  });
  const identity = compile("lib/event-harvester/identity.ts");
  const previewImports = new Proxy({
    "../identity": identity,
    "../market-facebook-inventory": reuse,
    "./facebook-events": { fetchFacebookEvents: async (_url, options) => {
      calls.fetch.push(options.validatePageIdentity);
      return [structuredClone(event)];
    } },
  }, {
    getOwnPropertyDescriptor(target, name) {
      return Reflect.getOwnPropertyDescriptor(target, name) ?? { configurable: true, enumerable: true, value: {} };
    },
    get(target, name) { return Reflect.has(target, name) ? Reflect.get(target, name) : {}; },
  });
  const preview = compile("lib/event-harvester/first-party/preview.ts", previewImports);
  const validation = compile("lib/event-harvester/first-party/validate.ts", {
    "./preview": preview,
    "./spothopper-events": { SpotHopperSurfaceError: class extends Error {} },
    "../transport-capacity-context": { getSpotExecutionSignal: () => undefined },
  });
  const attribution = compile("lib/event-harvester/first-party/attribution.ts", {
    "../venue-identity": compile("lib/event-harvester/venue-identity.ts"),
    "../google-places": {
      searchGoogleVenue: async (evidence, options) => {
        calls.google.push({ evidence, options });
        return { place: { id: "new-google-place", name: "New Business", formattedAddress: "Dunedin, FL" },
          score: 0.9, evidence: { reviewOnly: true } };
      },
      resolveReviewedGoogleSpot: async () => null,
      recordGoogleSpotDiscovery: async (_db, result) => { calls.recorded.push(result.place.id); return "pending"; },
      registerHarvestGoogleSpot: async () => { throw Error("Review-only business must not auto-register"); },
    },
  });
  const run = operation => reuse.runWithMarketFacebookInventory(db, "owned-work", "lease", operation);
  return { ...preview, ...validation, ...attribution, calls, db, run };
}

test("one raw Page inventory preserves both source identities and new-Spot discovery", async () => {
  const h = harness();
  const global = await h.run(() => h.previewFirstPartySource(source("global", null)));
  const owned = await h.run(() => h.previewFirstPartySource(source("owned", "source-spot")));
  assert.deepEqual(h.calls.fetch, [false]);
  assert.equal(global[0].sourceId, "global");
  assert.equal(global[0].venueId, null);
  assert.equal(owned[0].sourceId, "owned");
  assert.equal(owned[0].venueId, "source-spot");
  assert.equal(owned[0].allowSourceDefaultAttribution, false);
  for (const event of [global[0], owned[0]]) {
    const result = await h.resolveFirstPartyAttribution(h.db, event);
    assert.equal(result.status, "unresolved");
    assert.equal(result.evidence.googlePlaceId, "new-google-place");
  }
  assert.deepEqual(h.calls.attribution, ["global", "owned"]);
  assert.equal(h.calls.google.length, 2);
  assert.deepEqual(h.calls.recorded, ["new-google-place", "new-google-place"]);
  global[0].rawPayload.mutated = true;
  assert.equal(owned[0].rawPayload.mutated, undefined);
});

test("reuse preserves the existing ownership-dependent incomplete-location review branches", async () => {
  const h = harness({ event: { ...sampleEvent, venueName: "Original Source Spot", venueAddress: null } });
  const global = await h.run(() => h.previewFirstPartySource(source("global", null)));
  const owned = await h.run(() => h.previewFirstPartySource(source("owned", "source-spot")));
  const a = await h.resolveFirstPartyAttribution(h.db, global[0]);
  const b = await h.resolveFirstPartyAttribution(h.db, owned[0]);
  assert.equal(a.evidence.reason, "named_event_venue_requires_location_resolution");
  assert.equal(b.evidence.reason, "source_default_attribution_disallowed");
  assert.equal(h.calls.google.length, 1);
  assert.deepEqual(h.calls.recorded, []);
  assert.deepEqual(h.calls.fetch, [false]);
});

test("source-specific human approvals remain source-specific after inventory reuse", async () => {
  const h = harness({ approvedSource: "global" });
  const global = await h.run(() => h.previewFirstPartySource(source("global", null)));
  const owned = await h.run(() => h.previewFirstPartySource(source("owned", "source-spot")));
  const a = await h.resolveFirstPartyAttribution(h.db, global[0]);
  const b = await h.resolveFirstPartyAttribution(h.db, owned[0]);
  assert.equal(a.method, "admin_resolved");
  assert.equal(a.venueId, "human-approved-spot");
  assert.equal(b.status, "unresolved");
  assert.equal(h.calls.google.length, 1);
  assert.deepEqual(h.calls.fetch, [false]);
});

test("harvest inventory cannot satisfy detector Facebook identity validation", async () => {
  const h = harness();
  await h.run(() => h.previewFirstPartySource(source("global", null)));
  const first = await h.run(() => h.validateFirstPartySource(source("owned", "source-spot")));
  const second = await h.run(() => h.validateFirstPartySource(source("another", "other-spot")));
  assert.deepEqual(h.calls.fetch, [false, true]);
  assert.equal(first.status, "validated");
  assert.equal(second.status, "validated");
  assert.equal(first.events[0].sourceId, "owned");
  assert.equal(second.events[0].sourceId, "another");
});
