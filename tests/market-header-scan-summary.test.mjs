import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

const sql = read(
  "supabase/migrations/124_market_header_coverage_tally.sql",
);
const original = read(
  "supabase/migrations/076_event_harvest_coverage_tally.sql",
);
const api = read(
  "app/api/admin/harvester-coverage/route.ts",
);
const summary = read(
  "app/api/admin/markets/scan-summary/route.ts",
);
const status = read(
  "app/admin/markets/[marketKey]/MarketScanStatus.tsx",
);
const page = read(
  "app/admin/markets/[marketKey]/page.tsx",
);
const tally = read(
  "app/admin/harvester/CoverageTally.tsx",
);

test("scoped tally preserves global eligibility semantics", () => {
  for (const snippet of [
    "v.status = 'active'",
    "v.website_url is not null",
    "s.provider = 'first_party'",
    "s.is_enabled = true",
    "f.status = 'active'",
    "'no_source'",
    "'calendar_image'",
    "'transport'",
  ]) {
    assert.ok(sql.includes(snippet), snippet);
    assert.ok(original.includes(snippet), snippet);
  }
});

test("market tally is restricted to assigned Spots", () => {
  assert.match(sql, /mv.market_id = p_market_id/g);
  assert.match(sql, /event_processing_market_venues/);
  assert.match(sql, /count\(distinct f\.venue_id\)/);
  assert.match(sql, /f\.category = 'adapter_error'/);
  assert.match(sql, /f\.resolved_at is null/);
});

test("tally migration is complete and doesn't mutate scheduler", () => {
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
  assert.doesNotMatch(sql, /update public\.event_processing_work/i);
  assert.doesNotMatch(sql, /update public\.event_processing_markets/i);
  assert.doesNotMatch(sql, /set\s+schedule_enabled/i);
  assert.match(sql, /to service_role/);
});

test("global tally remains available; Market tally is scoped", () => {
  assert.match(api, /admin_event_harvest_coverage_tally_for_market/);
  assert.match(api, /p_market_id: market\.id/);
  assert.match(api, /admin_event_harvest_coverage_tally"/);
  assert.match(tally, /marketKey\?: string/);
  assert.match(tally, /encodeURIComponent\(marketKey\)/);
  assert.match(tally, /unaccounted" \+ marketSuffix/);
  assert.match(tally, /adapter-errors" \+ marketSuffix/);
});

test("scan summary requires Admin identity and Market membership", () => {
  assert.match(summary, /auth\.getUser\(/);
  assert.match(summary, /platform_admins/);
  assert.match(summary, /market_key/);
  assert.match(summary, /event_processing_market_cycles/);
  assert.match(summary, /event_processing_market_cycle_progress/);
  assert.match(summary, /eq\("cycle_id", latest\.id\)/);
  assert.match(summary, /cycle: null/);
  assert.match(summary, /no-store/);
});

test("status shows duration only beside the Market title", () => {
  assert.match(status, /formatMarketCycleDuration/);
  assert.match(status, /No scan yet/);
  assert.match(status, /Running/);
  assert.match(status, /Completed/);
  assert.match(status, /role="tooltip"/);
  assert.match(status, /Spots scanned:/);
  assert.match(status, /Successful:/);
  assert.match(status, /Exceptions:/);
  assert.match(status, /setInterval/);
});

test("header preserves title, tally and far-right toggle", () => {
  const title = page.indexOf("{market.display_name}");
  const scan = page.indexOf("<MarketScanStatus marketKey=");
  const tallyControl = page.indexOf("<CoverageTally marketKey=");
  const toggle = page.indexOf('className="btn primary"');

  assert.ok(title >= 0);
  assert.ok(scan > title);
  assert.ok(tallyControl > scan);
  assert.ok(toggle > tallyControl);
  assert.match(page, /operate\("set-enabled"/);
  assert.match(page, /market\.spot_count/);

  for (const name of [
    "Verification Requests",
    "Harvester Management",
    "Manage Spots",
    "Manage Tenders",
    "Events",
    "Contests",
  ]) {
    assert.ok(page.includes(name), name);
  }
});
