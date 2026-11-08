import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

const sql = read(
  "supabase/migrations/117_shared_provider_busy_deferral.sql"
);
const executor = read(
  "lib/event-harvester/market-supplemental-executor.ts"
);
const route = read("app/api/jobs/event-harvester/route.ts");

test("deferral requires service role and original work owner", () => {
  assert.match(sql, /auth\.role\(\) <> 'service_role'/);
  assert.match(sql, /w\.id = p_work_id/);
  assert.match(sql, /w\.work_type = 'harvest_provider'/);
  assert.match(sql, /w\.status = 'leased'/);
  assert.match(sql, /w\.lease_token = p_lease_token/);
  assert.match(sql, /w\.leased_until > v_now/);
});

test("contention returns work to the existing queue", () => {
  assert.match(sql, /status = 'retry'/);
  assert.match(sql, /due_at = v_now \+ make_interval/);
  assert.match(sql, /attempts = greatest\(0, w\.attempts - 1\)/);
  assert.match(sql, /lease_token = null/);
  assert.match(sql, /leased_until = null/);
  assert.match(sql, /p_delay_seconds not between 15 and 600/);
});

test("only provider busy responses trigger deferral", () => {
  assert.match(route, /error: "ticketmaster_provider_busy"/);
  assert.match(executor, /response\.status === 409/);
  assert.match(
    executor,
    /body\.error === "ticketmaster_provider_busy"/
  );
  assert.match(
    executor,
    /"defer_shared_market_provider_work"/
  );
  assert.match(executor, /p_delay_seconds: 60/);
});

test("failed deferral cannot become a consumed attempt", () => {
  assert.match(
    executor,
    /if \(deferralError \|\| deferred !== true\)/
  );
  assert.match(
    executor,
    /if \(providerBusyDeferralAttempted\) \{\s*throw cause;/
  );
  assert.match(executor, /"fail_event_processing_work"/);
});

test("completion and archive paths remain separate", () => {
  assert.match(executor, /mode === "archive"/);
  assert.match(executor, /"complete_event_processing_work"/);
  assert.match(executor, /result\.deferred = 1;/);
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
  assert.doesNotMatch(
    sql,
    /update public\.event_processing_markets/i
  );
  assert.equal(JSON.parse(read("vercel.json")).crons.filter(c => c.path !== "/api/jobs/shared-market-dispatch").length, 4);
});
