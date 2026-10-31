import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  "supabase/migrations/094_first_party_source_execution_lock.sql",
  "utf8",
);

const ingestion = readFileSync(
  "lib/event-harvester/first-party/ingest.ts",
  "utf8",
);

test("source execution lock has a unique source key", () => {
  assert.match(
    migration,
    /source_id uuid primary key/i,
  );
});

test("duplicate claims cannot replace an active token", () => {
  assert.match(
    migration,
    /on conflict \(source_id\) do nothing/i,
  );
});

test("release requires the original execution token", () => {
  assert.match(
    migration,
    /where source_id = p_source_id\s+and execution_token = p_execution_token/i,
  );
});

test("execution lock cannot expire automatically", () => {
  assert.doesNotMatch(migration, /leased_until|expires_at/i);
});

test("live ingestion claims a source before loading it", () => {
  const claim = ingestion.indexOf(
    '"claim_first_party_source_execution"',
  );
  const load = ingestion.indexOf(
    "await loadFirstPartySource(supabase, sourceId)",
  );

  assert.ok(claim >= 0);
  assert.ok(load > claim);
});

test("dry runs do not acquire execution locks", () => {
  assert.match(
    ingestion,
    /if \(!dryRun\)\s*\{[\s\S]*?claim_first_party_source_execution/,
  );
});

test("ingestion releases its execution lock", () => {
  assert.match(
    ingestion,
    /finally\s*\{[\s\S]*?release_first_party_source_execution/,
  );
});

test("ingestion failures retain their original error", () => {
  assert.match(
    ingestion,
    /catch \(error\)\s*\{\s*ingestionFailed = true;\s*throw error;/,
  );
});
