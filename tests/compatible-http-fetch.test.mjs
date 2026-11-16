import assert from 'node:assert/strict';
import test from 'node:test';
import { typescriptLoader } from './helpers/typescript-loader.mjs';

const { withCompatibleHttpHeaders } = typescriptLoader()('lib/event-harvester/compatible-http-fetch.ts');
const denied = () => new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/html' } });

test('a public GET rejected by request identity retries with compatible headers while preserving API accept headers', async () => {
  const calls = [];
  const result = await withCompatibleHttpHeaders(async headers => {
    calls.push(headers);
    return calls.length === 1 ? denied() : Response.json([{ id: 1 }]);
  }, { headers: { Accept: 'application/json', 'User-Agent': 'TenderFans Event Harvester/1.0', 'Signature-Agent': 'test-agent' } });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[1].get('user-agent'), /^Mozilla\/5/);
  assert.equal(calls[1].get('accept'), 'application/json');
  assert.equal(calls[1].get('signature-agent'), 'test-agent');
  assert.equal(calls[0].get('user-agent'), 'TenderFans Event Harvester/1.0');
});

test('a failed compatible request preserves the original denial for the existing recovery stage', async () => {
  const original = denied(); let calls = 0;
  assert.equal(await withCompatibleHttpHeaders(async () => ++calls === 1 ? original
    : new Response('Unavailable', { status: 503 })), original);
  assert.equal(calls, 2);
});

test('successful responses and non-GET requests are never repeated', async () => {
  for (const [status, method] of [[200, 'GET'], [403, 'POST']]) {
    let calls = 0;
    await withCompatibleHttpHeaders(async () => { calls++; return new Response('body', { status }); }, { method });
    assert.equal(calls, 1);
  }
});

test('positive verification challenges are not converted into usable HTML', async () => {
  for (const marker of [
    '<title>One Moment, Please...</title>Please wait while your request is being verified',
    '<script src="/cdn-cgi/challenge-platform/runtime.js"></script>',
    '<script src="/.well-known/sgcaptcha/runtime.js"></script>',
  ]) {
    let calls = 0;
    const original = new Response(marker, { status: 403, headers: { 'content-type': 'text/html' } });
    assert.equal(await withCompatibleHttpHeaders(async () => { calls++; return original; }), original);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const original = denied();
  const result = await withCompatibleHttpHeaders(async () => ++calls === 1 ? original : new Response(
    '<script src="/cdn-cgi/challenge-platform/runtime.js"></script>', { headers: { 'content-type': 'text/html' } },
  ));
  assert.equal(result, original);
});

test('Cloudflare analytics on an ordinary page is not classified as a challenge', async () => {
  let calls = 0;
  const result = await withCompatibleHttpHeaders(async () => ++calls === 1 ? denied()
    : new Response('<script src="https://static.cloudflareinsights.com/beacon.min.js"></script>', {
      headers: { 'content-type': 'text/html' },
    }));
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
});

test('transport cancellation remains a failure during compatible recovery', async () => {
  let calls = 0;
  await assert.rejects(withCompatibleHttpHeaders(async () => {
    if (++calls === 1) return denied();
    throw new DOMException('Cancelled', 'AbortError');
  }), error => error.name === 'AbortError');
});
