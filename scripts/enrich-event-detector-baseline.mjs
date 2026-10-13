import fs from "node:fs";
import path from "node:path";

const dir = path.resolve("reports/harvester/baseline");
const spotsPath = path.join(dir, "spots.json");
const summaryPath = path.join(dir, "summary.json");

if (!fs.existsSync(spotsPath) || !fs.existsSync(summaryPath)) {
  throw new Error("Original baseline snapshot is missing");
}

const spots = JSON.parse(fs.readFileSync(spotsPath, "utf8"));
const original = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

if (
  spots.length !== original.allSpots ||
  spots.filter(s => s.detectorEligible).length !==
    original.detectorEligibleSpots
) {
  throw new Error("Baseline population mismatch");
}

const eligible = spots.filter(s => s.detectorEligible);
const categories = [
  "calendar_image",
  "facebook",
  "browser_required",
  "challenge_encountered",
  "transport",
  "no_source",
  "html_error",
];

const countBy = (rows, key) => {
  const counts = {};
  for (const row of rows) {
    const value = String(row[key] ?? "(unknown)");
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1])
  );
};

const records = eligible.map(s => {
  const activeFindings = s.findings.filter(
    f => f.status === "active" && !f.resolved_at
  );

  const enabledSources = s.sources.filter(
    source => source.is_enabled
  );

  const enabledFirstParty = enabledSources.filter(
    source => source.provider === "first_party"
  );

  return {
    venueId: s.id,
    name: s.name,
    websiteUrl: s.website_url,
    enabledSourceCount: enabledSources.length,
    enabledFirstPartyCount: enabledFirstParty.length,
    hasValidatedFirstPartySource: enabledFirstParty.length > 0,
    enabledProviders: [...new Set(
      enabledSources.map(source => source.provider)
    )].sort(),
    enabledAdapterTypes: [...new Set(
      enabledFirstParty.map(source => source.source_type)
    )].sort(),
    activeCategories: [...new Set(
      activeFindings.map(f => f.category)
    )].sort(),
    historicalCategories: [...new Set(
      s.findings.map(f => f.category)
    )].sort(),
    activeFindingCount: activeFindings.length,
    historicalFindingCount: s.findings.length,
  };
});

const allSources = spots.flatMap(s => s.sources);
const enabledSources = allSources.filter(s => s.is_enabled);
const enabledFirstParty = enabledSources.filter(
  s => s.provider === "first_party"
);

const coverage = {
  baselineCapturedAt: original.capturedAt,
  baselineGitCommit: original.gitCommit,
  allSpots: spots.length,
  eligibleSpots: eligible.length,
  eligibleWithValidatedFirstParty:
    records.filter(r => r.hasValidatedFirstPartySource).length,
  eligibleWithoutValidatedFirstParty:
    records.filter(r => !r.hasValidatedFirstPartySource).length,
  eligibleWithAnyEnabledSource:
    records.filter(r => r.enabledSourceCount > 0).length,
  eligibleWithoutAnyEnabledSource:
    records.filter(r => r.enabledSourceCount === 0).length,
  eligibleWithNeitherFirstPartyNorActiveFinding:
    records.filter(r =>
      !r.hasValidatedFirstPartySource &&
      r.activeCategories.length === 0
    ).length,
  eligibleWithFirstPartyAndActiveFinding:
    records.filter(r =>
      r.hasValidatedFirstPartySource &&
      r.activeCategories.length > 0
    ).length,
  eligibleWithMultipleActiveCategories:
    records.filter(r => r.activeCategories.length > 1).length,
  sourceRows: allSources.length,
  enabledSourceRows: enabledSources.length,
  enabledFirstPartyRows: enabledFirstParty.length,
  enabledSourcesByProvider: countBy(enabledSources, "provider"),
  enabledFirstPartyByAdapter: countBy(
    enabledFirstParty, "source_type"
  ),
  activeFindingSpotsByCategory: Object.fromEntries(
    categories.map(category => [
      category,
      records.filter(r => r.activeCategories.includes(category)).length,
    ])
  ),
  historicalFindingSpotsByCategory: Object.fromEntries(
    categories.map(category => [
      category,
      records.filter(r => r.historicalCategories.includes(category)).length,
    ])
  ),
};

const cohort = records.map(r => r.venueId).sort();

if (new Set(cohort).size !== cohort.length) {
  throw new Error("Duplicate Spot IDs in baseline");
}

const md = [
  "# Event Detector — Enriched Pre-Refresh Baseline",
  "",
  `Original capture: ${coverage.baselineCapturedAt}`,
  `Original Git commit: ${coverage.baselineGitCommit}`,
  "",
  "## Population and coverage",
  "",
  `- All Spots: ${coverage.allSpots}`,
  `- Eligible Spots: ${coverage.eligibleSpots}`,
  `- Eligible with validated first-party source: ${coverage.eligibleWithValidatedFirstParty}`,
  `- Eligible without validated first-party source: ${coverage.eligibleWithoutValidatedFirstParty}`,
  `- Eligible with any enabled source: ${coverage.eligibleWithAnyEnabledSource}`,
  `- Eligible without any enabled source: ${coverage.eligibleWithoutAnyEnabledSource}`,
  `- Without first-party source or active finding: ${coverage.eligibleWithNeitherFirstPartyNorActiveFinding}`,
  `- With first-party source and active finding: ${coverage.eligibleWithFirstPartyAndActiveFinding}`,
  `- Multiple active categories: ${coverage.eligibleWithMultipleActiveCategories}`,
  "",
  "## Enabled sources by provider",
  "",
  "| Provider | Source records |",
  "|---|---:|",
  ...Object.entries(coverage.enabledSourcesByProvider)
    .map(([k,v]) => `| ${k} | ${v} |`),
  "",
  "## Enabled first-party adapters",
  "",
  "| Adapter type | Source records |",
  "|---|---:|",
  ...Object.entries(coverage.enabledFirstPartyByAdapter)
    .map(([k,v]) => `| ${k} | ${v} |`),
  "",
  "## Findings by category",
  "",
  "| Category | Active Spots | Historical Spots |",
  "|---|---:|---:|",
  ...categories.map(k =>
    `| ${k} | ${coverage.activeFindingSpotsByCategory[k]} | ${coverage.historicalFindingSpotsByCategory[k]} |`
  ),
  "",
  "## Interpretation",
  "",
  "- Validated sources remain successful even with zero events.",
  "- Source coverage and event inventory are separate measurements.",
  "- Active findings can coexist with validated sources.",
  "- Historical findings remain visible after resolution.",
  "- Missing active findings do not prove a Spot was scanned.",
  "- This baseline uses only the original saved snapshot.",
  "",
].join("\n");

const outputs = [
  ["coverage.json", JSON.stringify(coverage, null, 2)],
  ["coverage.md", md],
  ["cohort.json", JSON.stringify(cohort, null, 2)],
  ["classification-records.json", JSON.stringify(records, null, 2)],
];

for (const [name] of outputs) {
  if (fs.existsSync(path.join(dir, name))) {
    throw new Error(`Refusing to overwrite ${name}`);
  }
}

for (const [name, content] of outputs) {
  fs.writeFileSync(path.join(dir, name), content + "\n");
}

console.log(md);
console.log(`PASS: ${cohort.length} fixed-cohort Spot IDs saved`);
console.log("PASS: Original snapshot preserved");
