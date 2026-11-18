import assert from 'node:assert/strict';
import test from 'node:test';
import { typescriptLoader } from './helpers/typescript-loader.mjs';

const positive = () => ({ isEventCalendar: true, qualificationReason: 'Verified schedule', weekStart: null, events: [] });
const asset = (bytes = 'unchanged-image', url = 'https://images.example.com/calendar.png') => ({
  detectedUrl: url, resolvedUrl: url, contentType: 'image/png', bytes: new TextEncoder().encode(bytes), usedOriginalCandidate: false,
});
const contract = typescriptLoader()('lib/event-harvester/first-party/calendar-image-vision.ts').calendarImageExtractionContract;

function fixture({ failAction, signal, hasContext = true } = {}) {
  const rows = new Map(), calls = [];
  const supabase = { rpc: (name, args) => ({ abortSignal: async requestSignal => {
    assert.equal(name, 'calendar_image_extraction_cache'); requestSignal.throwIfAborted();
    calls.push(args);
    if (args.p_action === failAction) return { data: null, error: { message: 'Database unavailable' } };
    const key = args.p_cache_key;
    let row = rows.get(key), data;
    if (row?.extraction) data = { state: 'ready', extraction: structuredClone(row.extraction) };
    else if (args.p_action === 'claim') {
      if (!row) { row = { token: args.p_claim_token }; rows.set(key, row); }
      data = { state: row.token === args.p_claim_token ? 'claimed' : 'busy' };
    } else if (!row || row.token !== args.p_claim_token) data = { state: 'lost' };
    else if (args.p_action === 'release') { rows.delete(key); data = { state: 'released' }; }
    else if (args.p_action === 'renew') data = { state: 'renewed' };
    else { row.extraction = structuredClone(args.p_extraction); data = { state: 'ready', extraction: structuredClone(row.extraction) }; }
    return { data, error: null };
  } }) };
  const overrides = { '../transport-capacity-context': {
    getTransportCapacityContext: () => hasContext ? { supabase, sourceId: 'approved-source' } : undefined,
    getSpotExecutionSignal: () => signal,
  } };
  const freshClient = () => typescriptLoader(overrides)('lib/event-harvester/first-party/calendar-image-extraction-cache.ts').reuseCalendarImageExtraction;
  return { rows, calls, overrides, freshClient };
}

test('unchanged bytes reuse durable output across fresh client modules and changed image URLs', async () => {
  const h = fixture(); let paid = 0;
  const produce = async () => { paid++; return positive(); };
  const first = await h.freshClient()(asset(), contract('2026-11-17'), produce);
  const second = await h.freshClient()(asset('unchanged-image', 'https://cdn.example.com/renamed.png'), contract('2026-11-18'), produce);
  assert.deepEqual(first, second);
  assert.equal(paid, 1);
  assert.equal(h.rows.size, 1);
  assert.equal(h.calls.filter(c => c.p_action === 'save').length, 1);
});

test('changed bytes, MIME type, extraction contract, or necessary month context reparse', async () => {
  const h = fixture(), reuse = h.freshClient(); let paid = 0;
  const produce = async () => { paid++; return positive(); };
  await reuse(asset(), contract('2026-11-17'), produce);
  await reuse(asset('changed-image'), contract('2026-11-17'), produce);
  await reuse({ ...asset(), contentType: 'application/pdf' }, contract('2026-11-17'), produce);
  await reuse(asset(), contract('2026-12-01'), produce);
  await reuse(asset(), contract('2026-11-17') + 'new-model-contract', produce);
  assert.equal(paid, 5);
  assert.equal(h.rows.size, 5);
  assert.equal(contract('2026-11-01'), contract('2026-11-30'));
  assert.notEqual(contract('2026-11-30'), contract('2026-12-01'));
});

test('concurrent independent clients share one producer and reuse its empty inventory', async () => {
  const h = fixture(); let finish, paid = 0;
  const gate = new Promise(resolve => { finish = resolve; });
  const produce = async signal => { assert.equal(signal.aborted, false); paid++; await gate; return positive(); };
  const first = h.freshClient()(asset(), contract('2026-11-17'), produce);
  await new Promise(setImmediate);
  const second = h.freshClient()(asset(), contract('2026-11-17'), produce);
  await new Promise(setImmediate);
  assert.equal(paid, 1);
  finish();
  assert.deepEqual(await first, await second);
  assert.equal(paid, 1);
});

test('billing and transport failures release their claims and never become cached success', async () => {
  for (const message of ['OpenAI calendar-image extraction failed: no credits remaining', 'OpenAI connection reset']) {
    const h = fixture(), reuse = h.freshClient(); let paid = 0;
    await assert.rejects(reuse(asset(), contract('2026-11-17'), async () => { paid++; throw Error(message); }), error => error.message === message);
    assert.equal(h.rows.size, 0);
    await reuse(asset(), contract('2026-11-17'), async () => { paid++; return positive(); });
    assert.equal(paid, 2);
  }
});

test('cache unavailability and missing execution context stop before paid parsing', async () => {
  for (const options of [{ failAction: 'claim' }, { hasContext: false }]) {
    const h = fixture(options); let paid = 0;
    await assert.rejects(h.freshClient()(asset(), contract('2026-11-17'), async () => { paid++; return positive(); }), /cache claim failed|source execution context/);
    assert.equal(paid, 0);
  }
});

test('invalid model output is not stored and cancellation never starts paid parsing', async () => {
  const h = fixture();
  await assert.rejects(h.freshClient()(asset(), contract('2026-11-17'), async () => ({ ...positive(), events: null })), /invalid payload/);
  assert.equal(h.rows.size, 0);
  const controller = new AbortController(); controller.abort(Error('Spot deadline expired'));
  const cancelled = fixture({ signal: controller.signal }); let paid = 0;
  await assert.rejects(cancelled.freshClient()(asset(), contract('2026-11-17'), async () => { paid++; return positive(); }), /Spot deadline expired/);
  assert.equal(paid, 0);
});

test('producer renewal retains content ownership without changing its source deadline', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = fixture(); let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const pending = h.freshClient()(asset(), contract('2026-11-17'), async signal => {
    await gate; assert.equal(signal.aborted, false); return positive();
  });
  await new Promise(setImmediate);
  t.mock.timers.tick(30_000); await new Promise(setImmediate);
  assert.equal(h.calls.filter(c => c.p_action === 'renew').length, 1);
  finish(); await pending;
  assert.equal(h.calls.filter(c => c.p_action === 'save').length, 1);
});

test('lost cache ownership aborts paid extraction and cannot save partial output', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = fixture({ failAction: 'renew' });
  const pending = h.freshClient()(asset(), contract('2026-11-17'), signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const rejected = assert.rejects(pending, /cache renew failed/);
  await new Promise(setImmediate);
  t.mock.timers.tick(30_000);
  await rejected;
  assert.equal(h.rows.size, 0);
  assert.equal(h.calls.some(c => c.p_action === 'save'), false);
});

test('source cancellation interrupts extraction and releases the incomplete cache claim', async () => {
  const controller = new AbortController(), h = fixture({ signal: controller.signal });
  const pending = h.freshClient()(asset(), contract('2026-11-17'), signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const rejected = assert.rejects(pending, /Original Spot deadline/);
  await new Promise(setImmediate); controller.abort(Error('Original Spot deadline'));
  await rejected;
  assert.equal(h.rows.size, 0);
});

function parser(h, extract) {
  const load = typescriptLoader({
    ...h.overrides,
    './calendar-image-assets': {
      fetchCalendarImageResource: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      isCalendarPdfContentType: () => false,
      discoverCalendarImageAssets: () => ['https://images.example.com/calendar.png'],
      acquireCalendarImageAsset: async () => asset(),
    },
    './calendar-image-vision': { calendarImageExtractionContract: contract, extractCalendarImage: extract },
  });
  return load('lib/event-harvester/first-party/calendar-image-events.ts').fetchCalendarImageEvents;
}

test('non-calendar confirmation happens twice once, then its negative result is reused', async () => {
  const h = fixture(); let paid = 0;
  const extract = async () => { paid++; return { ...positive(), isEventCalendar: false }; };
  await assert.rejects(parser(h, extract)('https://venue.example.com/events'), /none qualified/);
  assert.equal(paid, 2);
  await assert.rejects(parser(h, extract)('https://venue.example.com/events'), /none qualified/);
  assert.equal(paid, 2);
});

test('cached raw extraction still runs current date freshness and source provenance rules', async () => {
  const h = fixture(); let paid = 0;
  const extraction = { ...positive(), events: [{
    title: 'Live Music', localDate: '2026-11-17', displayedWeekday: null,
    startTime: '19:00', endTime: '21:00', allDay: false,
    titleConfidence: 1, dateConfidence: 1, timeConfidence: 1,
    dateBasis: 'event_explicit', timeBasis: 'event_explicit',
    evidence: { displayedTitle: 'Live Music', displayedDate: 'November 17, 2026', displayedTime: '7 PM - 9 PM', context: [] },
  }] };
  const extract = async () => { paid++; return extraction; };
  const NativeDate = globalThis.Date;
  let now = '2026-11-16T12:00:00Z';
  globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [now])); } };
  try {
    const first = await parser(h, extract)('https://venue.example.com/events');
    const second = await parser(h, extract)('https://other.example.com/calendar');
    assert.equal(first.length, 1); assert.equal(second.length, 1);
    assert.equal(first[0].sourceUrl, 'https://venue.example.com/events');
    assert.equal(second[0].sourceUrl, 'https://other.example.com/calendar');
    assert.equal(first[0].startsAt, '2026-11-18T00:00:00.000Z');
    now = '2026-11-18T12:00:00Z';
    await assert.rejects(parser(h, extract)('https://venue.example.com/events'), /none qualified/);
    assert.equal(paid, 1);
  } finally { globalThis.Date = NativeDate; }
});
