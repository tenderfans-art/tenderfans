import assert from 'node:assert/strict';
import test from 'node:test';
import { typescriptLoader } from './helpers/typescript-loader.mjs';

const id = '00000000-0000-4000-8000-000000000001';
async function open({ records = [], error = null, eventId = id } = {}) {
  const filters = [], calls = [];
  const query = {
    select(fields) { calls.push(fields); return this; },
    eq(field, value) { filters.push([field, value]); return this; },
    order() { return this; },
    limit() {
      return Promise.resolve({ error, data: error ? null : records.filter(row =>
        filters.every(([field, value]) => (field === 'events.status' ? row.status : row[field]) === value)),
      });
    },
  };
  const load = typescriptLoader({
    '@supabase/supabase-js': { createClient: () => ({ from(table) { assert.equal(table, 'event_source_links'); return query; } }) },
    'next/server': { NextResponse: { redirect: (url, options) => new Response(null, {
      ...options, headers: { ...options.headers, Location: String(url) },
    }) } },
  });
  const response = await load('app/events/[eventId]/source/route.ts').GET(
    new Request(`https://tenderfans.example/events/${eventId}/source?url=https://unrelated.example/`),
    { params: Promise.resolve({ eventId }) },
  );
  return { response, filters, calls };
}

test('event title destination uses the stored published event URL and ignores incoming redirect parameters', async () => {
  const { response, filters, calls } = await open({ records: [{ event_id: id, status: 'published', source_url: 'https://publisher.example/event/live-music/' }] });
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), 'https://publisher.example/event/live-music/');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(filters, [['event_id', id], ['events.status', 'published']]);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /events!inner\(status, venues\(website_url\)\)/);
  assert.match(calls[0], /source_page_url:raw_payload->>sourcePageUrl/);
});

test('events without an external source retain their TenderFans event details', async () => {
  const { response } = await open();
  assert.equal(response.headers.get('location'), `https://tenderfans.example/events?event=${id}`);
});

test('draft or cancelled events never disclose their stored source URL', async () => {
  for (const status of ['draft', 'cancelled']) {
    const { response } = await open({ records: [{ event_id: id, status, source_url: 'https://private.example/unpublished-event' }] });
    assert.equal(response.headers.get('location'), `https://tenderfans.example/events?event=${id}`);
  }
});

test('unsafe or malformed URLs are skipped in favor of a usable recorded source', async () => {
  const records = ['javascript:alert(1)', 'data:text/html,invalid', 'https://user:password@publisher.example/', 'not-a-url', 'https://publisher.example/event/verified']
    .map(source_url => ({ event_id: id, status: 'published', source_url }));
  const { response } = await open({ records });
  assert.equal(response.headers.get('location'), 'https://publisher.example/event/verified');
});

test('invalid event IDs stop before a database request', async () => {
  const { response, calls } = await open({ eventId: 'invalid-id' });
  assert.equal(response.status, 404);
  assert.deepEqual(calls, []);
});

test('an embedded calendar links to its recorded containing page instead of the provider UI', async () => {
  const { response } = await open({ records: [{
    event_id: id, status: 'published',
    source_url: 'https://calendar.google.com/calendar/embed?src=calendar-id',
    publisher: { source_url: 'https://calendar.google.com/calendar/embed?src=calendar-id', public_page_url: 'https://venue.example.com/live-music/' },
    events: { venues: { website_url: 'https://venue.example.com/' } },
  }] });
  assert.equal(response.headers.get('location'), 'https://venue.example.com/live-music/');
});

test('a legacy technical source without a saved containing page falls back to the venue website', async () => {
  const { response } = await open({ records: [{
    event_id: id, status: 'published', source_url: 'https://publisher.example.com/calendar.ics',
    events: { venues: { website_url: 'https://venue.example.com/' } },
  }] });
  assert.equal(response.headers.get('location'), 'https://venue.example.com/');
});
