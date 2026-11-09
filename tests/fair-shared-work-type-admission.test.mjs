import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const oldSql = readFileSync(
  "supabase/migrations/115_shared_provider_archive_admission.sql",
  "utf8",
);

const newSql = readFileSync(
  "supabase/migrations/120_fair_shared_work_type_admission.sql",
  "utf8",
);

const start = (
  "create or replace function public." +
  "reserve_shared_harvester_batch_scoped("
);

function functionBody(sql) {
  const i = sql.indexOf(start);
  assert.ok(i >= 0);

  const j = sql.indexOf("$reserve_shared$;", i);
  assert.ok(j > i);

  return sql.slice(i, j + "$reserve_shared$;".length);
}

const previous = functionBody(oldSql);
const current = functionBody(newSql);

test("Market admission remains the original implementation", () => {
  assert.match(current, /v_live_workflows/);
  assert.match(current, /v_legacy_workflows/);
  assert.match(current, /v_live_sources/);
  assert.match(current, /v_workflow_limit/);
  assert.match(current, /v_source_limit/);
  assert.match(current, /shared_market_work_eligible/);
  assert.match(current, /market_shared_harvester_entitlement/);
});

test("oldest unserved eligible type wins inside its Market", () => {
  assert.match(
    current,
    /r\.work_type = eligible\.work_type/,
  );
  assert.match(
    current,
    /max\(r\.reserved_at\) as last_type_reserved/,
  );

  const market = current.indexOf(
    "history.last_reserved asc nulls first",
  );
  const type = current.indexOf(
    "type_history.last_type_reserved asc nulls first",
  );
  const due = current.indexOf(
    "eligible.oldest_due asc",
  );

  assert.ok(market >= 0);
  assert.ok(type > market);
  assert.ok(due > type);
});

test("deterministic ties do not always favor detectors", () => {
  assert.match(
    current,
    /eligible\.work_type asc/,
  );
  assert.match(current, /from public\.event_processing_dispatch_reservations r/);
});

test("all existing work types retain their original paths", () => {
  for (const type of [
    "harvest_source",
    "detect_spot",
    "harvest_provider",
    "archive_recheck",
  ]) {
    assert.ok(current.includes(`'${type}'`), type);
    assert.ok(previous.includes(`'${type}'`), type);
  }
});

test("Ticketmaster still has exclusive provider admission", () => {
  assert.match(
    current,
    /pr\.work_type = 'harvest_provider'/,
  );
  assert.match(
    current,
    /pw\.work_type = 'harvest_provider'/,
  );
});

test("only work-type scheduling order was changed", () => {
  const oldJoin = `  ) history on true
  join lateral public.market_shared_harvester_entitlement(`;

  const newJoin = `  ) history on true
  -- Fair work-type admission inside each Market.
  -- A recently selected type yields to other ready types.
  left join lateral (
    select max(r.reserved_at) as last_type_reserved
    from public.event_processing_dispatch_reservations r
    where r.market_id = m.id
      and r.work_type = eligible.work_type
  ) type_history on true
  join lateral public.market_shared_harvester_entitlement(`;

  const oldOrder = `  order by
    history.last_reserved asc nulls first,
    eligible.oldest_due asc,
    m.id asc
  limit 1;`;

  const newOrder = `  order by
    -- Preserve the existing Market-first fairness policy.
    history.last_reserved asc nulls first,
    -- Within a Market, give the least-recently-served
    -- eligible work type the next reservation.
    type_history.last_type_reserved asc nulls first,
    -- Existing queue age remains the next priority.
    eligible.oldest_due asc,
    m.id asc,
    -- Deterministic final tie breaker.
    eligible.work_type asc
  limit 1;`;

  assert.equal(
    current
      .replace(newJoin, oldJoin)
      .replace(newOrder, oldOrder),
    previous,
  );
});

test("migration preserves current Market configuration", () => {
  assert.match(newSql, /^begin;/m);
  assert.match(newSql, /^commit;/m);
  assert.doesNotMatch(
    newSql,
    /update public\.event_processing_markets/i,
  );
  assert.doesNotMatch(
    newSql,
    /update public\.event_processing_work/i,
  );
  assert.doesNotMatch(
    newSql,
    /update public\.event_harvest_sources/i,
  );
});
