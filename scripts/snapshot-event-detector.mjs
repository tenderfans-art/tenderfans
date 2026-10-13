import nextEnv from "@next/env";
import fs from "node:fs";
import path from "node:path";

nextEnv.loadEnvConfig(process.cwd());

const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;

if (!base || !key) {
  throw new Error("Missing Supabase credentials");
}

const label = process.argv[2];

if (!label || !/^[a-zA-Z0-9_-]+$/.test(label)) {
  throw new Error(
    "Usage: node scripts/snapshot-event-detector.mjs baseline"
  );
}

const dir = path.resolve("reports/harvester", label);

if (fs.existsSync(dir)) {
  throw new Error(
    `Snapshot already exists: ${dir}. Refusing to overwrite.`
  );
}

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
};

async function allRows(table, params) {
  const rows = [];
  const pageSize = 500;

  for (let offset = 0; ; offset += pageSize) {
    const url = new URL(`${base}/rest/v1/${table}`);

    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }

    const response = await fetch(url, {
      headers: {
        ...headers,
        Range: `${offset}-${offset + pageSize - 1}`,
        "Range-Unit": "items",
      },
    });

    if (!response.ok) {
      throw new Error(
        `${table}: HTTP ${response.status}: ` +
        (await response.text()).slice(0, 500)
      );
    }

    const page = await response.json();
    rows.push(...page);

    if (page.length < pageSize) break;
  }

  return rows;
}

const [venues, findings, sources] = await Promise.all([
  allRows("venues", {
    select: "id,name,website_url,status",
    order: "id.asc",
  }),
  allRows("event_harvest_detector_findings", {
    select: "*",
    order: "id.asc",
  }),
  allRows("event_harvest_sources", {
    select: "id,venue_id,provider,source_type,source_url,is_enabled",
    order: "id.asc",
  }),
]);

const byVenue = (rows) => {
  const map = new Map();

  for (const row of rows) {
    if (!row.venue_id) continue;
    if (!map.has(row.venue_id)) map.set(row.venue_id, []);
    map.get(row.venue_id).push(row);
  }

  return map;
};

const findingMap = byVenue(findings);
const sourceMap = byVenue(sources);

const spots = venues.map((venue) => {
  const venueFindings = findingMap.get(venue.id) ?? [];
  const venueSources = sourceMap.get(venue.id) ?? [];

  const activeFindings = venueFindings.filter(
    (f) => f.status === "active" && !f.resolved_at
  );

  const enabledFirstParty = venueSources.filter(
    (s) => s.provider === "first_party" && s.is_enabled
  );

  return {
    ...venue,
    detectorEligible:
      venue.status === "active" &&
      venue.website_url !== null,
    activeCategories: [
      ...new Set(activeFindings.map((f) => f.category)),
    ].sort(),
    hasEnabledFirstPartySource: enabledFirstParty.length > 0,
    findings: venueFindings,
    sources: venueSources,
  };
});

const eligible = spots.filter((s) => s.detectorEligible);

const categories = [
  "calendar_image",
  "facebook",
  "browser_required",
  "challenge_encountered",
  "transport",
  "no_source",
  "html_error",
];

const counts = Object.fromEntries(
  categories.map((category) => [
    category,
    eligible.filter(
      (spot) => spot.activeCategories.includes(category)
    ).length,
  ])
);

const otherCategories = [
  ...new Set(
    eligible.flatMap((spot) => spot.activeCategories)
  ),
].filter((category) => !categories.includes(category));

const summary = {
  capturedAt: new Date().toISOString(),
  label,
  gitCommit: (
    await import("node:child_process")
  ).execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  allSpots: spots.length,
  detectorEligibleSpots: eligible.length,
  findingsTotal: findings.length,
  activeFindings: findings.filter(
    (f) => f.status === "active" && !f.resolved_at
  ).length,
  registeredSources: sources.length,
  eligibleWithEnabledFirstPartySource:
    eligible.filter((s) => s.hasEnabledFirstPartySource).length,
  eligibleWithNoActiveFindings:
    eligible.filter((s) => s.activeCategories.length === 0).length,
  categorySpotCounts: counts,
  otherCategories,
};

const csvValue = (value) =>
  `"${String(value ?? "").replaceAll('"', '""')}"`;

const csv = [
  [
    "venue_id",
    "name",
    "website_url",
    "detector_eligible",
    "active_categories",
    "enabled_first_party_source",
    "finding_count",
    "source_count",
  ].join(","),
  ...spots.map((s) =>
    [
      s.id,
      s.name,
      s.website_url,
      s.detectorEligible,
      s.activeCategories.join("|"),
      s.hasEnabledFirstPartySource,
      s.findings.length,
      s.sources.length,
    ].map(csvValue).join(",")
  ),
].join("\n") + "\n";

const markdown = [
  `# Event Detector Snapshot — ${label}`,
  "",
  `Captured: ${summary.capturedAt}`,
  `Git commit: ${summary.gitCommit}`,
  "",
  `- All Spots: ${summary.allSpots}`,
  `- Detector-eligible Spots: ${summary.detectorEligibleSpots}`,
  `- Historical findings: ${summary.findingsTotal}`,
  `- Active findings: ${summary.activeFindings}`,
  `- Registered sources: ${summary.registeredSources}`,
  `- Eligible Spots with enabled first-party sources: ${summary.eligibleWithEnabledFirstPartySource}`,
  `- Eligible Spots with no active findings: ${summary.eligibleWithNoActiveFindings}`,
  "",
  "## Active findings by category",
  "",
  "| Category | Spots |",
  "|---|---:|",
  ...Object.entries(counts).map(
    ([category, count]) => `| ${category} | ${count} |`
  ),
  "",
  `Other categories: ${otherCategories.join(", ") || "none"}`,
  "",
  "Counts overlap when a Spot has multiple active findings.",
  "No active findings does not imply a successful detector scan.",
  "Enabled first-party sources are tracked separately.",
  "",
].join("\n");

fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(
  path.join(dir, "spots.json"),
  JSON.stringify(spots, null, 2)
);
fs.writeFileSync(
  path.join(dir, "summary.json"),
  JSON.stringify(summary, null, 2)
);
fs.writeFileSync(path.join(dir, "spots.csv"), csv);
fs.writeFileSync(path.join(dir, "summary.md"), markdown);

if (
  JSON.parse(
    fs.readFileSync(path.join(dir, "spots.json"), "utf8")
  ).length !== venues.length
) {
  throw new Error("Snapshot verification failed");
}

console.log(markdown);
console.log(`PASS: Snapshot saved to ${dir}`);
