import nextEnv from "@next/env";
import fs from "node:fs";
import path from "node:path";

nextEnv.loadEnvConfig(process.cwd());

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;

if (!url || !key) {
  throw new Error("Missing Supabase environment credentials.");
}

const outputDir = path.join(
  process.cwd(),
  "reports/harvester/verification"
);

const headers = {
  apikey: key,
  authorization: `Bearer ${key}`,
};

async function readAll(table, params = {}) {
  const result = [];
  const size = 500;

  for (let offset = 0; ; offset += size) {
    const endpoint = new URL(`${url}/rest/v1/${table}`);

    for (const [name, value] of Object.entries(params)) {
      endpoint.searchParams.set(name, value);
    }

    const response = await fetch(endpoint, {
      headers: {
        ...headers,
        Range: `${offset}-${offset + size - 1}`,
        "Range-Unit": "items",
      },
    });

    if (!response.ok) {
      throw new Error(
        `${table}: HTTP ${response.status}: ${await response.text()}`
      );
    }

    const page = await response.json();
    result.push(...page);

    if (page.length < size) break;
  }

  return result;
}

const [venues, findings, sources, archives] = await Promise.all([
  readAll("venues", {
    select: "id,name,website_url,status",
    order: "id.asc",
  }),
  readAll("event_harvest_detector_findings", {
    select: "*",
    order: "venue_id.asc",
  }),
  readAll("event_harvest_sources", {
    select: "*",
    order: "venue_id.asc",
  }),
  readAll("event_harvest_archive", {
    select: "venue_id,restored_at",
  }),
]);

const venueMap = new Map(venues.map(v => [v.id, v]));

const activeFindings = findings.filter(
  f => f.status === "active" && venueMap.has(f.venue_id)
);

const facebookIds = new Set(
  activeFindings
    .filter(f =>
      f.category === "adapter_error" &&
      ["facebook", "facebook_events"].includes(f.source_type)
    )
    .map(f => f.venue_id)
);

const enabledSourceIds = new Set(
  sources
    .filter(s =>
      s.provider === "first_party" &&
      s.is_enabled === true
    )
    .map(s => s.venue_id)
);

const archivedIds = new Set(
  archives
    .filter(a => a.restored_at === null)
    .map(a => a.venue_id)
);

const noSourceIds = new Set(
  activeFindings
    .filter(f =>
      f.category === "no_source" &&
      !enabledSourceIds.has(f.venue_id) &&
      !archivedIds.has(f.venue_id)
    )
    .map(f => f.venue_id)
);

const overlapIds = [...noSourceIds].filter(
  id => facebookIds.has(id)
);

const noSourceOnlyIds = [...noSourceIds].filter(
  id => !facebookIds.has(id)
);

const facebookOnlyIds = [...facebookIds].filter(
  id => !noSourceIds.has(id)
);

const counts = {
  facebookErrors: facebookIds.size,
  noSources: noSourceIds.size,
  facebookOnly: facebookOnlyIds.length,
  noSourcesOnly: noSourceOnlyIds.length,
  overlap: overlapIds.length,
};

console.log("COHORT COUNTS");
console.log(JSON.stringify(counts, null, 2));

const expected = {
  facebookErrors: 138,
  noSources: 67,
  facebookOnly: 121,
  noSourcesOnly: 50,
  overlap: 17,
};

for (const [name, value] of Object.entries(expected)) {
  if (counts[name] !== value) {
    throw new Error(
      `${name}: expected ${value}, found ${counts[name]}. ` +
      "Database classification changed. Snapshot not saved."
    );
  }
}

function buildSpot(id, group) {
  const venue = venueMap.get(id);

  return {
    venue_id: id,
    spot_name: venue.name,
    website_url: venue.website_url,
    comparison_group: group,
    facebook_detected: findings.some(f =>
      f.venue_id === id && f.category === "facebook"
    ),
    findings: findings
      .filter(f => f.venue_id === id)
      .map(f => ({
        id: f.id,
        category: f.category,
        status: f.status,
        detector_status: f.detector_status,
        source_type: f.source_type,
        source_url: f.source_url,
        fetched_url: f.fetched_url,
        finding_key: f.finding_key,
        error: f.error,
        evidence: f.evidence,
        first_seen_at: f.first_seen_at,
        last_seen_at: f.last_seen_at,
      })),
    registered_sources: sources
      .filter(s => s.venue_id === id)
      .map(s => ({
        id: s.id,
        provider: s.provider,
        source_type: s.source_type,
        external_source_id: s.external_source_id,
        is_enabled: s.is_enabled,
        config: s.config,
      })),
    audit: {
      status: "pending",
      classification: null,
      findings: [],
      proposed_action: null,
      verified_at: null,
    },
  };
}

const sortByName = (a, b) =>
  a.spot_name.localeCompare(b.spot_name) ||
  a.venue_id.localeCompare(b.venue_id);

const cohort = noSourceOnlyIds
  .map(id => buildSpot(id, "NO_SOURCES_ONLY"))
  .sort(sortByName);

const comparison = {
  generated_at: new Date().toISOString(),
  counts,
  groups: {
    NO_SOURCES_ONLY: cohort,
    OVERLAP: overlapIds
      .map(id => buildSpot(id, "OVERLAP"))
      .sort(sortByName),
    FACEBOOK_ERROR_ONLY: facebookOnlyIds
      .map(id => buildSpot(id, "FACEBOOK_ERROR_ONLY"))
      .sort(sortByName),
  },
};

fs.mkdirSync(outputDir, { recursive: true });

fs.writeFileSync(
  path.join(outputDir, "no-source-50.json"),
  JSON.stringify(cohort, null, 2) + "\n"
);

fs.writeFileSync(
  path.join(outputDir, "population-comparison.json"),
  JSON.stringify(comparison, null, 2) + "\n"
);

const markdown = [
  "# No Sources — 50-Spot Verification Cohort",
  "",
  `Snapshot: ${comparison.generated_at}`,
  "",
  "This is a frozen verification baseline, not a live Admin queue.",
  "All 50 entries require individual evidence-based review.",
  "",
  "## Population",
  "",
  `- Facebook Adapter Errors: ${counts.facebookErrors}`,
  `- No Sources: ${counts.noSources}`,
  `- Facebook only: ${counts.facebookOnly}`,
  `- No Sources only: ${counts.noSourcesOnly}`,
  `- Overlap: ${counts.overlap}`,
  "",
  "## Target Spots",
  "",
  "| # | Spot | Website | Audit |",
  "|---|---|---|---|",
  ...cohort.map((s, i) =>
    `| ${i + 1} | ${s.spot_name.replaceAll("|", "\\|")} | ` +
    `${s.website_url ?? "—"} | Pending |`
  ),
  "",
  "## Verification Rules",
  "",
  "- Inspect existing findings and source evidence first.",
  "- Check website event pages, calendars, links and platform fingerprints.",
  "- Identify missed supported adapters and new reusable adapter candidates.",
  "- Never introduce Spot-specific production logic.",
  "- Preserve existing validated sources and prevent regressions.",
  "- Do not reclassify a Spot without supporting evidence.",
  "",
];

fs.writeFileSync(
  path.join(outputDir, "no-source-50.md"),
  markdown.join("\n")
);

console.log("\nSNAPSHOT SAVED");
console.log(`Target Spots: ${cohort.length}`);
console.log(`Folder: ${outputDir}`);

for (const [i, spot] of cohort.entries()) {
  console.log(
    `${String(i + 1).padStart(2, "0")}. ${spot.spot_name}`
  );
}
