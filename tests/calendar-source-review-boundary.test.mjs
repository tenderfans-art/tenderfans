import assert from 'node:assert/strict';
import test from 'node:test';
import { typescriptLoader } from './helpers/typescript-loader.mjs';

const venueId = '00000000-0000-4000-8000-000000000001';
const pageUrl = 'https://venue.example.com/events';
const errorKey = `adapter_error:${JSON.stringify(['calendar_image', pageUrl])}`;

async function scan({ approved = false, rejected = false, htmlSource = true, publisher = false, reviewError = false } = {}) {
  const calls = [], probes = [];
  const venue = { id: venueId, status: 'active', name: 'Example Venue', website_url: 'https://venue.example.com/' };
  const sources = [
    ...(htmlSource ? [{ id: 'html-source', venue_id: venueId, provider: 'first_party', source_type: 'html_events', is_enabled: true }] : []),
    ...(approved ? [{ id: 'approved-calendar', venue_id: venueId, provider: 'first_party', source_type: 'calendar_image', is_enabled: true,
      external_source_id: `first_party:calendar_image:${pageUrl}` }] : []),
  ];
  const findings = [
    { venue_id: venueId, finding_key: errorKey, category: 'adapter_error', source_type: 'calendar_image', source_url: pageUrl, status: 'active' },
    { venue_id: venueId, finding_key: 'other-adapter-error', category: 'adapter_error', source_type: 'html_events', source_url: pageUrl, status: 'active' },
    { venue_id: venueId, finding_key: 'other-calendar-error', category: 'adapter_error', source_type: 'calendar_image', source_url: 'https://venue.example.com/other-calendar', status: 'active' },
    ...(!approved ? [{ venue_id: venueId, finding_key: `calendar_image:${pageUrl}`, category: 'calendar_image', source_url: pageUrl, status: rejected ? 'rejected' : 'active' }] : []),
  ];
  function from(table) {
    const filters = [];
    const query = {
      select() { return query; },
      eq(field, value) { filters.push(row => row[field] === value); return query; },
      neq(field, value) { filters.push(row => row[field] !== value); return query; },
      in(field, values) { filters.push(row => values.includes(row[field])); return query; },
      not(field, operator, value) { assert.equal(operator, 'is'); filters.push(row => row[field] !== value); return query; },
      limit() { return query; },
      then(resolve, reject) {
        const rows = table === 'event_harvest_detector_eligible_venues' ? [venue]
          : table === 'event_harvest_sources' ? sources
            : table === 'event_harvest_detector_findings' ? findings
              : table === 'venue_external_refs' ? [] : assert.fail('Unexpected table ' + table);
        return Promise.resolve({ data: rows.filter(row => filters.every(matches => matches(row))), error: null }).then(resolve, reject);
      },
    };
    return query;
  }
  const supabase = { from, rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === 'upsert_first_party_event_source') assert.fail('Discovery must not approve a calendar source');
    if (name === 'upsert_event_harvest_detector_finding') {
      if (reviewError && args.p_category === 'calendar_image') return { error: { message: 'Review persistence failed' } };
      const row = findings.find(f => f.finding_key === args.p_finding_key);
      if (row) row.status = 'active';
      else findings.push({ venue_id: args.p_venue_id, finding_key: args.p_finding_key, category: args.p_category, source_url: args.p_source_url, status: 'active' });
    } else if (name === 'resolve_event_harvest_adapter_error') {
      for (const row of findings) if (row.category === 'adapter_error' && row.finding_key === args.p_finding_key) row.status = 'resolved';
    } else if (name === 'resolve_event_harvest_detector_findings') {
      for (const row of findings) if (row.category === args.p_category && row.status === 'active') row.status = 'resolved';
    } else assert.equal(name, 'record_event_harvest_execution_result');
    return { data: 'fixture-id', error: null };
  } };
  const detect = async () => ({
    websiteUrl: venue.website_url, fetchedUrl: venue.website_url, status: 'detected',
    detections: [{ sourceType: 'calendar_image', url: pageUrl, confidence: 'medium', adapterAvailable: true, supported: true, evidence: ['Dated image candidate'] }],
    browserOutcomes: [], discoveredEventPages: [], error: null,
  });
  const load = typescriptLoader({
    '@/lib/event-harvester/transport-capacity-context': { getSpotExecutionSignal: () => undefined, runWithTransportCapacityContext: async (_client, _venue, operation) => operation() },
    '@/lib/event-harvester/venue-identity': {},
    '@/lib/event-harvester/transport-recovery-context': { runWithTransportRecovery: async (_proxy, operation) => operation() },
    'next/server': { NextResponse: { json: Response.json } },
    '@supabase/supabase-js': { createClient: () => supabase },
    '@/lib/event-harvester/first-party/source-detector': { detectFirstPartySources: detect, runWithPreferredFirstPartyProxy: async operation => operation(), fetchHtml: async () => ({ ok: true, html: publisher ? '<title>Example Venue Music Calendar</title>' : '<html></html>' }) },
    '@/lib/event-harvester/first-party/ratify': { ratifyDetectedSource: async (...args) => { probes.push(args); assert.fail('Unapproved discovery must not reach ratification'); } },
    '@/lib/event-harvester/first-party/validate': { validateFirstPartySource: async () => assert.fail('Unapproved discovery must not invoke calendar parsing') },
    '@/lib/event-harvester/first-party/corporate-html-spot-discovery': {},
    '@/lib/event-harvester/google-places': {
      searchGoogleVenue: async () => { probes.push('google-identity'); return { evidence: {} }; },
      resolveReviewedGoogleSpot: async () => venueId,
    },
  });
  const values = { CRON_SECRET: 'fixture-secret', NEXT_PUBLIC_SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SECRET_KEY: 'fixture-key', TENDERFANS_TRANSPORT_PROXY_URL: 'http://proxy.example.com:8080' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    const response = await load('app/api/jobs/first-party-event-detector/route.ts').GET(new Request(
      `https://app.example.com/api/jobs/first-party-event-detector?venue_id=${venueId}`,
      { headers: { authorization: 'Bearer fixture-secret' } },
    ));
    assert.equal(response.status, 200);
    return { result: await response.json(), calls, probes, findings };
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

test('a healthy HTML source retains independent pending calendar review without premature parsing', async () => {
  const h = await scan();
  assert.equal(h.result.failed, 0);
  assert.equal(h.result.buckets.validated, 1);
  assert.equal(h.result.registered, 0);
  assert.equal(h.findings.find(f => f.category === 'calendar_image').status, 'active');
  assert.equal(h.findings.find(f => f.finding_key === errorKey).status, 'resolved');
  assert.equal(h.findings.find(f => f.finding_key === 'other-adapter-error').status, 'active');
  assert.equal(h.findings.find(f => f.finding_key === 'other-calendar-error').status, 'active');
  const saved = h.calls.findIndex(c => c.name === 'upsert_event_harvest_detector_finding' && c.args.p_category === 'calendar_image');
  const cleared = h.calls.findIndex(c => c.name === 'resolve_event_harvest_adapter_error' && c.args.p_finding_key === errorKey);
  assert.ok(saved >= 0 && cleared > saved);
});

test('a pending calendar is still accounted for without any previously validated source', async () => {
  const h = await scan({ htmlSource: false });
  assert.equal(h.result.failed, 0);
  assert.equal(h.result.bucketInvariantHolds, true);
  assert.equal(h.result.buckets.calendarImage, 1);
  assert.equal(h.result.registered, 0);
});

test('Google qualification of the same Spot does not approve its pending calendar', async () => {
  const h = await scan({ publisher: true });
  assert.ok(h.probes.includes('google-identity'));
  assert.equal(h.result.failed, 0);
  assert.equal(h.findings.find(f => f.category === 'calendar_image').status, 'active');
});

test('approved calendar sources retain genuine harvest errors and do not reopen source review', async () => {
  const h = await scan({ approved: true });
  assert.equal(h.result.failed, 0);
  assert.equal(h.findings.find(f => f.finding_key === errorKey).status, 'active');
  assert.equal(h.calls.some(c => c.name === 'upsert_event_harvest_detector_finding' && c.args.p_category === 'calendar_image'), false);
});

test('an explicit rejection is preserved and never parsed or approved by rediscovery', async () => {
  const h = await scan({ rejected: true });
  assert.equal(h.result.failed, 0);
  assert.equal(h.findings.find(f => f.category === 'calendar_image').status, 'rejected');
});

test('failed persistence of source review cannot retire the previous adapter error', async () => {
  const h = await scan({ reviewError: true });
  assert.equal(h.result.failed, 1);
  assert.equal(h.findings.find(f => f.finding_key === errorKey).status, 'active');
  assert.equal(h.calls.some(c => c.name === 'resolve_event_harvest_adapter_error' && c.args.p_finding_key === errorKey), false);
});
