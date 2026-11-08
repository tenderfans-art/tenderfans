import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const ticket = readFileSync(
  "app/api/jobs/event-harvester/route.ts",
  "utf8",
);
const detector = readFileSync(
  "app/api/jobs/first-party-event-detector/route.ts",
  "utf8",
);
const migration = readFileSync(
  "supabase/migrations/114_market_provider_archive_scope.sql",
  "utf8",
);
const previousArchive = readFileSync(
  "supabase/migrations/086_event_harvest_archive.sql",
  "utf8",
);
const cron = JSON.parse(readFileSync("vercel.json", "utf8"));

test("Market-scoped Ticketmaster validates membership", () => {
  assert.match(ticket, /hasMarketScope/);
  assert.match(ticket, /requestedMarketId/);
  assert.match(ticket, /event_processing_markets/);
  assert.match(ticket, /market\.is_enabled/);
  assert.match(
    ticket,
    /event_processing_market_venues!inner\(market_id\)/,
  );
  assert.match(
    ticket,
    /event_processing_market_venues\.market_id/,
  );
});

test("Ticketmaster unmapped and mapped Spots share Market scope", () => {
  assert.match(ticket, /activeVenueIds\.length === 0/);
  assert.match(
    ticket,
    /refsQuery = refsQuery\.in\(\s*"venue_id",\s*activeVenueIds/,
  );
  assert.match(ticket, /const scopedVenueIds = \[\.\.\.spotMap\.keys\(\)\]/);
  assert.match(ticket, /\.in\("venue_id", scopedVenueIds\)/);
});

test("Ticketmaster original global behavior is retained", () => {
  assert.match(
    ticket,
    /let scopedVenuesQuery = supabase/,
  );
  assert.match(
    ticket,
    /requestedMarketId\s*\?\s*await scopedVenuesQuery\s*:\s*await unmappedVenuesQuery/,
  );
  assert.match(ticket, /source: "ticketmaster"/);
  assert.match(ticket, /dryRun: false/);
  assert.match(ticket, /sync_ticketmaster_event/);
  assert.match(ticket, /ticketmasterVenueMatch/);
  assert.match(ticket, /directLifecycleChecked/);
});

test("archive scope uses atomic existing-style leases", () => {
  assert.match(
    migration,
    /create function public\.claim_market_event_harvest_archive_rechecks/,
  );
  for (const fragment of [
    "event_processing_market_venues",
    "a.next_check_at <= now()",
    "for update of a skip locked",
    "archive_lease_token = gen_random_uuid()",
    "a.restored_at is null",
    "m.is_enabled = true",
  ]) {
    assert.ok(migration.includes(fragment), fragment);
  }
});

test("global archive route remains supported unchanged", () => {
  assert.match(
    detector,
    /archiveMarketId\s*\?\s*"claim_market_event_harvest_archive_rechecks"\s*:\s*"claim_event_harvest_archive_rechecks"/,
  );
  assert.match(detector, /finish_event_harvest_archive_recheck/);
  assert.match(previousArchive, /claim_event_harvest_archive_rechecks/);
  assert.match(previousArchive, /finish_event_harvest_archive_recheck/);
});

test("migration neither activates Markets nor alters legacy crons", () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /^commit;/m);
  assert.match(migration, /auth\.role\(\) <> 'service_role'/);
  assert.match(migration, /to service_role/);
  assert.doesNotMatch(migration, /update public\.event_processing_markets/i);
  assert.equal(cron.crons.filter(c => c.path !== "/api/jobs/shared-market-dispatch").length, 4);
  assert.ok(
    cron.crons.some((item) =>
      item.path === "/api/jobs/event-harvester"
    ),
  );
  assert.ok(
    cron.crons.some((item) =>
      item.path.includes("mode=archive-recheck")
    ),
  );
});
