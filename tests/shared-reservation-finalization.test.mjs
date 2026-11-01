import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  "supabase/migrations/099_shared_worker_admission.sql",
  "utf8",
);

function functionBody(name, delimiter) {
  const start = sql.indexOf(
    `create function public.${name}(`,
  );
  assert.ok(start >= 0, `${name} exists`);
  const end = sql.indexOf(delimiter, start);
  assert.ok(end > start, `${name} body ends`);
  return sql.slice(start, end);
}

test("finalization refuses live original source assignments", () => {
  const body = functionBody(
    "finalize_shared_harvester_reservation",
    "$finalize$;",
  );
  assert.match(body, /shared_harvester_source_assignments/);
  assert.match(body, /w\.lease_token\s*=\s*a\.lease_token/);
  assert.match(body, /w\.leased_until\s*>\s*clock_timestamp\(\)/);
  assert.match(body, /return false;/);
});

test("reconciliation preserves claimed live assignments", () => {
  const body = functionBody(
    "reconcile_shared_harvester_reservations",
    "$reconcile$;",
  );
  assert.match(body, /shared_harvester_source_assignments/);
  assert.match(body, /w\.lease_token\s*=\s*a\.lease_token/);
  assert.match(body, /w\.leased_until\s*>\s*v_now/);
  assert.match(body, /and not exists\s*\(/);
});
