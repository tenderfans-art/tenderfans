import assert from 'node:assert/strict';
import test from 'node:test';
import { typescriptLoader } from './helpers/typescript-loader.mjs';

const venue = '00000000-0000-4000-8000-000000000001';
const scope = 'from=2026-11-01T00:00:00Z&to=2026-12-06T23:59:59Z';
async function open(params = scope, rows = [], failure = null) {
  const calls = [], filters = [], orders = [];
  let clients = 0, range, signal;
  const query = {
    select(value) { calls.push(value); return this; },
    returns() { return this; },
    eq(...args) { filters.push(['eq', ...args]); return this; },
    gte(...args) { filters.push(['gte', ...args]); return this; },
    lte(...args) { filters.push(['lte', ...args]); return this; },
    order(...args) { orders.push(args); return this; },
    range(...args) { range = args; return this; },
    async abortSignal(value) {
      signal = value;
      const data = rows.filter(row => filters.every(([op, key, value]) =>
        key === 'venues.status' || (op === 'eq' ? row[key] === value : op === 'gte' ? row[key] >= value : row[key] <= value)));
      return { error: failure, data: data.slice(range[0], range[1] + 1).map(({ status, ...publicRow }) => ({
        ...publicRow, venues: publicRow.venues?.status === 'active' ? publicRow.venues : null,
      })) };
    },
  };
  const load = typescriptLoader({ '@supabase/supabase-js': { createClient() {
    clients++; return { from(table) { assert.equal(table, 'events'); return query; } };
  } } });
  const request = new Request(`https://tenderfans.example/api/events/calendar?${params}`);
  const response = await load('app/api/events/calendar/route.ts').GET(request);
  return { response, body: await response.json(), calls, filters, orders, clients, range, signal, request };
}

test('calendar API returns only published events with public search hints and stable root pagination', async () => {
  const rows = ['published', 'draft', 'cancelled'].map((status, id) => ({
    id, venue_id: venue, title: 'Example Artist', starts_at: '2026-11-20T19:00:00Z', status,
    event_source_links: [{ candidate: { performer: { genre: 'Jazz', name: 'Example Artist' }, calendar_context: 'PRIVATE' } }],
  }));
  const r = await open(`${scope}&status=draft`, rows);
  assert.equal(r.response.status, 200);
  assert.equal(r.response.headers.get('cache-control'), 'no-store');
  assert.equal(r.body.data.length, 1);
  assert.deepEqual(r.body.data[0].search_metadata.categories, ['entertainment', 'music']);
  assert.doesNotMatch(JSON.stringify(r.body), /PRIVATE|event_source_links|raw_payload|calendar_context/);
  assert.deepEqual(r.filters, [['eq', 'status', 'published'], ['eq', 'venues.status', 'active'], ['gte', 'starts_at', '2026-11-01T00:00:00Z'], ['lte', 'starts_at', '2026-12-06T23:59:59Z']]);
  assert.deepEqual(r.orders, [['starts_at', { ascending: true }], ['id', { ascending: true }]]);
  assert.deepEqual(r.range, [0, 499]);
  assert.equal(r.signal, r.request.signal);
  assert.doesNotMatch(r.calls[0], /\*|raw_payload\s*[,)]/);
});

test('Spot calendar retains venue scope across pages without a month restriction', async () => {
  const rows = Array.from({ length: 501 }, (_, id) => ({ id, title: 'Example', status: 'published', venue_id: venue }));
  const r = await open(`venue_id=${venue}&offset=500&limit=500`, rows);
  assert.deepEqual(r.filters, [['eq', 'status', 'published'], ['eq', 'venues.status', 'active'], ['eq', 'venue_id', venue]]);
  assert.deepEqual(r.range, [500, 999]);
  assert.equal(r.body.data.length, 1);
  assert.equal(r.body.data[0].id, 500);
});

test('malformed, missing, reversed or oversized scopes stop before privileged access', async () => {
  for (const params of ['', 'venue_id=invalid', `${scope}&offset=-1`, `${scope}&limit=501`, `${scope}&limit=0`, `${scope}&offset=1.5`, `${scope}&offset=Infinity`, 'from=invalid&to=2026-12-01T00:00:00Z', 'from=2026-12-01T00:00:00Z&to=2026-11-01T00:00:00Z', 'from=2026-01-01T00:00:00Z&to=2026-12-01T00:00:00Z']) {
    const r = await open(params);
    assert.equal(r.response.status, 400, params);
    assert.equal(r.clients, 0, params);
  }
});

test('database errors return a generic error instead of partial data or private details', async () => {
  const r = await open(scope, [], { message: 'PRIVATE DATABASE DETAILS' });
  assert.equal(r.response.status, 500);
  assert.deepEqual(r.body, { error: 'Unable to load events.' });
});

test('a published event does not disclose a pending Spot profile through the server client', async () => {
  const r = await open(scope, [{ title: 'Public event', status: 'published', starts_at: '2026-11-20T19:00:00Z', venues: { status: 'pending', name: 'PRIVATE SPOT' } }]);
  assert.equal(r.body.data.length, 1);
  assert.equal(r.body.data[0].venues, null);
  assert.doesNotMatch(JSON.stringify(r.body), /PRIVATE SPOT/);
});
