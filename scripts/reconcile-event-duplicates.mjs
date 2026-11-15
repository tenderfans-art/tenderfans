import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import tzLookup from "tz-lookup";

const marker = "__tf_event_maintenance__";
const wrapped = expression => `select jsonb_build_object('${marker}', ${expression}) as payload;`;
const literal = value => "'" + value.replaceAll("'", "''") + "'";

export function decodeEventMaintenanceResult(output) {
  // Hosted CLI releases can return rows directly; local queries can wrap
  // those same rows with a boundary and an untrusted-data warning.
  const rows = Array.isArray(output) ? output : output?.rows;
  if (!Array.isArray(rows) || rows.length !== 1 ||
      !Object.hasOwn(rows[0]?.payload ?? {}, marker)) throw Error("Unexpected Supabase query result");
  return rows[0].payload[marker];
}

function queryLinkedProject(statement, { readOnly = false } = {}) {
  const args = ["--yes", "--loglevel=error", "supabase@3", "db", "query", "--remote",
    "--output-format", "json", readOnly ? "--read-only" : "--yes", statement];
  const result = spawnSync("npx", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
  if (result.error || result.status !== 0) throw Error(result.stderr || result.error?.message || "Database query failed");
  return decodeEventMaintenanceResult(JSON.parse(result.stdout));
}

export async function reconcileEventDuplicates(query = queryLinkedProject) {
  const ready = await query(wrapped("to_regprocedure('public.reconcile_event_harvest_duplicates(uuid,text)') is not null"), { readOnly: true });
  if (ready !== true) throw Error("Apply migration 128 before reconciling events");
  const venues = await query(wrapped(`coalesce((
    select jsonb_agg(to_jsonb(spot)) from (
      select v.id, v.latitude, v.longitude from public.venues v
      where exists (
        select 1 from public.event_harvest_candidates a
        join public.event_harvest_candidates b on b.venue_id = a.venue_id and b.id <> a.id
        join public.events ea on ea.id = a.canonical_event_id
        join public.events eb on eb.id = b.canonical_event_id
        where a.venue_id = v.id and a.canonical_event_id <> b.canonical_event_id
          and a.status = 'published' and b.status = 'published'
          and ea.status = 'published' and eb.status = 'published'
          and (a.event_fingerprint = b.event_fingerprint or (
            a.normalized_title = b.normalized_title
            and public.event_harvest_occurrence_url(a) = public.event_harvest_occurrence_url(b)
          ))
      ) order by v.id
    ) spot
  ), '[]'::jsonb)`), { readOnly: true });
  if (!Array.isArray(venues)) throw Error("Unexpected venue result");
  const counts = { merged_events: 0, skipped_groups: 0, deferred_venues: 0, venues_missing_coordinates: 0 };
  for (const venue of venues) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(venue.id)) {
      throw Error("Invalid venue identity in maintenance result");
    }
    if (typeof venue.latitude !== "number" || typeof venue.longitude !== "number" ||
        !Number.isFinite(venue.latitude) || !Number.isFinite(venue.longitude) ||
        Math.abs(venue.latitude) > 90 || Math.abs(venue.longitude) > 180) {
      counts.venues_missing_coordinates++;
      continue;
    }
    const zone = tzLookup(venue.latitude, venue.longitude);
    const result = await query(wrapped(`public.reconcile_event_harvest_duplicates(${literal(venue.id)}::uuid, ${literal(zone)})`));
    if (!Number.isInteger(result?.merged_events) || !Number.isInteger(result?.skipped_groups)) {
      throw Error("Unexpected reconciliation result");
    }
    counts.merged_events += result.merged_events;
    counts.skipped_groups += result.skipped_groups;
    counts.deferred_venues += result.deferred_venues ?? 0;
  }
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--apply") {
    console.error("Usage: node scripts/reconcile-event-duplicates.mjs --apply");
    process.exitCode = 1;
  } else {
    reconcileEventDuplicates().then(counts => console.log(JSON.stringify(counts, null, 2))).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
