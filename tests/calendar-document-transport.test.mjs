import assert from 'node:assert/strict';
import test from 'node:test';
import { typescriptLoader } from './helpers/typescript-loader.mjs';

const pdfUrl = 'https://calendar.example.com/pdf/November26.pdf';
const pdf = new TextEncoder().encode('%PDF-1.7\nCalendar fixture\n%%EOF');
const response = (body, contentType, url, status = 200) => {
  const value = new Response(body, { status, headers: { 'content-type': contentType } });
  Object.defineProperty(value, 'url', { value: url });
  return value;
};

test('legacy HTTP uploads are fetched over HTTPS with bounded image recovery allowance', async () => {
  const calls = [];
  const load = typescriptLoader({
    '@/lib/event-harvester/transport-recovery-context': { getTransportRecoveryProxy: () => undefined },
    '@/lib/event-harvester/signed-fetch': { signedHarvesterFetch: async (...args) => {
      calls.push(args);
      return response(new Uint8Array(2_333_184), 'image/png', args[0]);
    } },
  });
  const asset = await load('lib/event-harvester/first-party/calendar-image-assets.ts')
    .acquireCalendarImageAsset('http://calendar.example.com/uploads/November26.png');
  assert.equal(calls[0][0], 'https://calendar.example.com/uploads/November26.png');
  assert.equal(calls[0][3].maxResponseBytes, 16 * 1024 * 1024);
  assert.equal(asset.bytes.byteLength, 2_333_184);
  assert.equal(asset.resolvedUrl, calls[0][0]);
  assert.equal(asset.detectedUrl, 'http://calendar.example.com/uploads/November26.png');
});

test('calendar document discovery includes dated PDF links and excludes unrelated PDFs', () => {
  const load = typescriptLoader({
    '@/lib/event-harvester/transport-recovery-context': { getTransportRecoveryProxy: () => undefined },
    '@/lib/event-harvester/signed-fetch': {},
  });
  const assets = load('lib/event-harvester/first-party/calendar-image-assets.ts');
  assert.deepEqual(assets.discoverCalendarImageAssets(
    '<a href="/pdf/November26.pdf">Music calendar</a><a href="/pdf/menu.pdf">Menu</a>',
    'https://calendar.example.com/',
  ), [pdfUrl]);
});

test('proxy bodies retain the ordinary 2 MiB limit and accept a bounded larger document only when requested', async () => {
  const load = typescriptLoader({ undici: {}, 'http-message-sig': {},
    './transport-capacity-http': {}, './transport-capacity-permits': {} },
  (text, file) => file.endsWith('/signed-fetch.ts') ? text + '\nexport { readLimitedBody };' : text);
  const signed = load('lib/event-harvester/signed-fetch.ts');
  await assert.rejects(signed.readLimitedBody(new Response(new Uint8Array(2_333_184))), /size limit/);
  assert.equal((await signed.readLimitedBody(new Response(new Uint8Array(2_333_184)), 16 * 1024 * 1024)).length, 2_333_184);
  for (const limit of [0, -1, Infinity, 16 * 1024 * 1024 + 1]) {
    await assert.rejects(signed.signedHarvesterFetch(pdfUrl, {}, undefined, { maxResponseBytes: limit }), /Invalid harvester response size limit/);
  }
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(9)); }, cancel() { cancelled = true; } });
  await assert.rejects(signed.readLimitedBody(new Response(stream), 8), /size limit/);
  assert.equal(cancelled, true);
});

test('PDFs use file input and preserve the existing structured extraction contract', async () => {
  const originalFetch = globalThis.fetch, originalKey = process.env.OPENAI_API_KEY;
  let body;
  process.env.OPENAI_API_KEY = 'test-only-key';
  const extraction = { isEventCalendar: true, qualificationReason: 'Verified calendar', weekStart: 'Monday', events: [] };
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return Response.json({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(extraction) }] }] });
  };
  try {
    const vision = typescriptLoader()('lib/event-harvester/first-party/calendar-image-vision.ts');
    assert.deepEqual(await vision.extractCalendarImage({ contentType: 'application/pdf', bytes: pdf }), extraction);
    const input = body.input[0].content[1];
    assert.equal(input.type, 'input_file');
    assert.equal(input.filename, 'calendar.pdf');
    assert.equal(input.detail, 'high');
    assert.equal(input.file_data, 'data:application/pdf;base64,' + Buffer.from(pdf).toString('base64'));
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.name, 'calendar_image_extraction');
    assert.equal(body.model, 'gpt-5.4');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('a direct PDF calendar reuses its fetched bytes and still requires visual qualification', async () => {
  for (const qualifies of [true, false]) {
    let requests = 0, extractions = 0;
    const load = typescriptLoader({
      './calendar-image-assets': {
        fetchCalendarImageResource: async () => { requests++; return response(pdf, 'application/pdf', pdfUrl); },
        isCalendarPdfContentType: value => /^application\/pdf/i.test(value ?? ''),
        discoverCalendarImageAssets: () => assert.fail('PDF is not an HTML page'),
        acquireCalendarImageAsset: () => assert.fail('Do not download the same PDF twice'),
      },
      './calendar-image-vision': { extractCalendarImage: async asset => {
        extractions++; assert.equal(asset.contentType, 'application/pdf'); assert.deepEqual(asset.bytes, pdf);
        return { isEventCalendar: qualifies, qualificationReason: 'Fixture qualification', weekStart: null, events: [] };
      } },
    });
    const operation = load('lib/event-harvester/first-party/calendar-image-events.ts').fetchCalendarImageEvents(pdfUrl);
    if (qualifies) assert.deepEqual(await operation, []);
    else await assert.rejects(operation, /calendar|schedule/i);
    assert.equal(requests, 1);
    assert.equal(extractions, qualifies ? 1 : 2);
  }
});

test('PDF discovery retains the source for calendar qualification and avoids HTML browser navigation', async () => {
  const homepage = 'https://calendar.example.com/';
  const html = '<html><a href="/pdf/November26.pdf">Live music calendar</a></html>';
  const fetchResource = async url => url === homepage
    ? response(html, 'text/html', url)
    : url === pdfUrl ? response(pdf, 'application/pdf', url)
    : response('Not found', 'text/plain', url, 404);
  let browserCalls = 0;
  const load = typescriptLoader({
    '@/lib/event-harvester/signed-fetch': { signedHarvesterFetch: fetchResource },
    '@/lib/event-harvester/transport-recovery-context': { getTransportRecoveryProxy: () => undefined },
    './browser-transport': { fetchBrowserEvidence: async () => { browserCalls++; throw Error('PDF incorrectly sent to browser'); } },
  });
  const result = await load('lib/event-harvester/first-party/source-detector.ts').detectFirstPartySources(homepage);
  assert.equal(browserCalls, 0);
  assert.ok(result.detections.some(x => x.sourceType === 'calendar_image' && x.url === pdfUrl));
  assert.ok(result.documentUrls.includes(pdfUrl));
  const document = result.discoveredEventPages.find(x => x.url === pdfUrl);
  assert.equal(document.contentType, 'application/pdf');
  assert.equal(document.htmlBytes, 0);
  assert.equal(result.browserOutcomes.length, 0);
});
