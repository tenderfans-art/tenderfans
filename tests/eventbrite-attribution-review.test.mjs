import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(path, "utf8");

const ratifier = read(
  "lib/event-harvester/first-party/ratify.ts"
);

const detector = read(
  "app/api/jobs/first-party-event-detector/route.ts"
);

const panel = read(
  "app/admin/harvester/source-review/SourceOwnershipPanel.tsx"
);

const ownershipSql = read(
  "supabase/migrations/081_html_source_ownership_approval.sql"
);

const eventbrite = ratifier.slice(
  ratifier.indexOf("async function ratifyEventbrite("),
  ratifier.indexOf("const directlyRatifiableSourceTypes")
);

test("Eventbrite ownership ambiguities have review status", () => {
  assert.match(
    ratifier,
    /status: "review_required";/
  );

  assert.equal(
    (eventbrite.match(/status: "review_required"/g) ?? []).length,
    7
  );

  assert.match(
    eventbrite,
    /Direct organizer URL does not by itself establish Spot attribution/
  );

  assert.match(
    eventbrite,
    /Physical event location does not establish organizer ownership/
  );
});

test("Invalid identities and inspection failures remain failures", () => {
  assert.equal(
    (eventbrite.match(/status: "ratification_failed"/g) ?? []).length,
    3
  );

  assert.match(
    eventbrite,
    /Eventbrite event identity could not be inspected/
  );

  assert.equal(
    (eventbrite.match(/status: "rejected"/g) ?? []).length,
    2
  );
});

test("Attribution review is stored without registering a source", () => {
  const start = detector.indexOf(
    'if (ratification.status === "review_required")'
  );

  const end = detector.indexOf(
    'if (ratification.status === "rejected")',
    start
  );

  assert.ok(start >= 0 && end > start);
  const branch = detector.slice(start, end);

  assert.match(
    branch,
    /upsert_event_harvest_detector_finding/
  );

  assert.match(
    branch,
    /p_category: "source_ownership"/
  );

  assert.match(
    branch,
    /p_source_url: candidate.url/
  );

  assert.match(
    branch,
    /p_evidence: ratification.evidence/
  );

  assert.match(branch, /continue;/);

  assert.doesNotMatch(
    branch,
    /upsert_first_party_event_source/
  );

  assert.doesNotMatch(branch, /failed \+= 1/);
});

test("Real ratification failures remain retryable", () => {
  const start = detector.indexOf(
    'if (ratification.status === "review_required")'
  );

  const end = detector.indexOf(
    'ratified += 1;',
    start
  );

  const branch = detector.slice(start, end);

  assert.match(
    branch,
    /ratification.status === "ratification_failed"/
  );

  assert.match(
    branch,
    /await recordAdapterError/
  );

  assert.match(branch, /failed \+= 1/);
});

test("Eventbrite does not use HTML approval controls", () => {
  assert.match(
    panel,
    /eventbriteReview \? \(/
  );

  assert.match(
    panel,
    /HTML source approval does not apply/
  );

  assert.match(
    panel,
    /eventbriteReview \? \([\s\S]*?\) : \(\s*<>[\s\S]*?Approve/
  );

  assert.match(
    ownershipSql,
    /f.source_type <> 'html_events'/
  );
});

test("Rejected ownership findings remain rejected", () => {
  assert.match(
    ownershipSql,
    /old.category = 'source_ownership'/
  );

  assert.match(
    ownershipSql,
    /old.status = 'rejected'/
  );

  assert.match(
    ownershipSql,
    /new.status := 'rejected'/
  );
});
