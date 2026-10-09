import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

import fs from "node:fs";
import { Agent, fetch } from "undici";
import path from "node:path";

const base = process.env.DETECTOR_BASE_URL ?? "http://localhost:3000";

const dispatcher = new Agent({
  headersTimeout: 1800000,
  bodyTimeout: 1800000,
});
const secret = process.env.CRON_SECRET;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

if (!secret || !supabaseUrl || !supabaseKey) {
  throw new Error("Missing CRON_SECRET or Supabase credentials.");
}

const outputDir = path.join(process.cwd(), ".harvester-runs");
fs.mkdirSync(outputDir, { recursive: true });

const headers = {
  authorization: `Bearer ${secret}`,
};

const dbHeaders = {
  apikey: supabaseKey,
  authorization: `Bearer ${supabaseKey}`,
};

async function getJson(url, requestHeaders = headers) {
  const response = await fetch(url, {
    headers: requestHeaders,
    dispatcher,
    signal: AbortSignal.timeout(1800000),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `${response.status} ${url}\n${body.slice(0, 2000)}`,
    );
  }

  return JSON.parse(body);
}

async function getAllRows(table, query) {
  const rows = [];
  const pageSize = 500;

  for (let offset = 0; ; offset += pageSize) {
    const url = new URL(
      `${supabaseUrl}/rest/v1/${table}`,
    );

    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      headers: {
        ...dbHeaders,
        Range: `${offset}-${offset + pageSize - 1}`,
        "Range-Unit": "items",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Database read failed: ${response.status} ${await response.text()}`,
      );
    }

    const page = await response.json();
    rows.push(...page);

    if (page.length < pageSize) break;
  }

  return rows;
}

function save(name, value) {
  fs.writeFileSync(
    path.join(outputDir, name),
    JSON.stringify(value, null, 2),
  );
}

const venues = await getAllRows("venues", {
  select: "id,name",
  status: "eq.active",
  website_url: "not.is.null",
  order: "id.asc",
});

console.log(`Eligible Spots: ${venues.length}`);

const batchSize = 1;
const fullResultsPath = path.join(outputDir, "full-scan-results.json");
const fullResults = fs.existsSync(fullResultsPath)
  ? JSON.parse(fs.readFileSync(fullResultsPath, "utf8"))
  : [];

for (let offset = fullResults.length; offset < venues.length; offset += batchSize) {
  console.log(
    `Full scan: ${offset + 1}–${Math.min(offset + batchSize, venues.length)}`,
  );

  const url = new URL(
    "/api/jobs/first-party-event-detector",
    base,
  );

  url.searchParams.set("mode", "full-scan");
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("limit", String(batchSize));

  const result = await getJson(url);
  fullResults.push(result);
  save("full-scan-results.json", fullResults);

  if (result.failed > 0 || (result.failures ?? []).length > 0) {
    console.warn(
      `Spot ${offset + 1}: ${result.failed} processing issue(s) recorded; continuing.`,
    );
    for (const failure of result.failures ?? []) {
      console.warn(JSON.stringify(failure));
    }
  }

  if (result.spots !== Math.min(batchSize, venues.length - offset)) {
    throw new Error(`Unexpected full-scan batch size at offset ${offset}`);
  }

  if (!result.bucketInvariantHolds) {
    throw new Error(`Classification invariant failed at offset ${offset}`);
  }
}

const failedFindings = await getAllRows(
  "event_harvest_detector_findings",
  {
    select: "venue_id",
    category: "eq.transport",
    detector_status: "in.(transport_failed,transport_blocked)",
    resolved_at: "is.null",
  },
);

const eligibleSet = new Set(venues.map((v) => v.id));
const recoverySnapshotPath = path.join(outputDir, "recovery-diagnostics-snapshot.json");

const recoveryIds = fs.existsSync(recoverySnapshotPath)
  ? JSON.parse(fs.readFileSync(recoverySnapshotPath, "utf8"))
  : [
      ...new Set(failedFindings.map((f) => f.venue_id)),
    ].filter((id) => eligibleSet.has(id));

save("recovery-diagnostics-snapshot.json", recoveryIds);

console.log(`Expanded transport recovery queue: ${recoveryIds.length}`);

const recoveryResultsPath = path.join(outputDir, "recovery-diagnostics-results.json");
const recoveryResults = fs.existsSync(recoveryResultsPath)
  ? JSON.parse(fs.readFileSync(recoveryResultsPath, "utf8"))
  : [];

for (let offset = recoveryResults.length; offset < recoveryIds.length; offset += batchSize) {
  const batch = recoveryIds.slice(offset, offset + batchSize);

  console.log(
    `Vultr recovery: ${offset + 1}–${offset + batch.length}`,
  );

  const url = new URL(
    "/api/jobs/first-party-event-detector",
    base,
  );

  url.searchParams.set("mode", "transport-recovery");
  url.searchParams.set("venue_ids", batch.join(","));

  const result = await getJson(url);
  recoveryResults.push(result);
  save("recovery-diagnostics-results.json", recoveryResults);

  if (result.failed > 0 || (result.failures ?? []).length > 0) {
    console.warn(
      `Recovery batch: ${result.failed} processing issue(s) recorded; continuing.`,
    );
    for (const failure of result.failures ?? []) {
      console.warn(JSON.stringify(failure));
    }
  }

  if (!result.bucketInvariantHolds) {
    throw new Error("Recovery classification invariant failed.");
  }
}

const remaining = await getAllRows(
  "event_harvest_detector_findings",
  {
    select: "venue_id,detector_status",
    category: "eq.transport",
    resolved_at: "is.null",
  },
);

const report = {
  eligibleSpots: venues.length,
  fullScanProcessed: fullResults.reduce(
    (sum, r) => sum + r.spots, 0,
  ),
  recoverySnapshot: recoveryIds.length,
  recoveryProcessed: recoveryResults.reduce(
    (sum, r) => sum + r.spots, 0,
  ),
  remainingTransportFindings: remaining.length,
  remainingTransportFailed: remaining.filter(
    (r) => r.detector_status === "transport_failed",
  ).length,
  remainingTransportBlocked: remaining.filter(
    (r) => r.detector_status === "transport_blocked",
  ).length,
  fullScanFailures: fullResults.flatMap(
    (r) => r.failures ?? [],
  ),
  recoveryFailures: recoveryResults.flatMap(
    (r) => r.failures ?? [],
  ),
};

save("final-report.json", report);
save("remaining-transport-findings.json", remaining);

console.log("\n=== FINAL REPORT ===");
console.log(JSON.stringify(report, null, 2));
console.log(`\nSaved results to ${outputDir}`);
