import assert from 'node:assert/strict';
import test from 'node:test';
import { typescriptLoader } from './helpers/typescript-loader.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(setImmediate);
const url = 'https://public.example.com/events';
const endpoint = 'https://api.example.com/events';

function scenario({ delayed = false, noResponse = false, http2Failure = false, navigationErrors = [], navigationStatus = 200, holdFirstClose = false, proxy, invalidJson = false } = {}) {
  const calls = [], launches = [], contexts = [], waits = [], navigated = deferred(), firstClose = deferred(), cleanup = deferred();
  let observer, responseWait, navigationCount = 0, closed = 0;
  const emit = () => {
    const response = { url: () => endpoint, ok: () => true,
      json: async () => { if (invalidJson) throw Error(typeof invalidJson === 'string' ? invalidJson : 'invalid endpoint JSON'); return []; } };
    observer?.(response);
    if (responseWait?.predicate(response)) responseWait.resolve(response);
  };
  const page = {
    async route() {}, on(event, listener) { if (event === 'response') observer = listener; },
    waitForResponse(predicate, options) {
      const gate = deferred(); responseWait = { ...gate, predicate }; waits.push(options.timeout);
      if (noResponse) gate.reject(Object.assign(Error('observation timed out'), { name: 'TimeoutError' }));
      return gate.promise;
    },
    async goto() {
      const current = ++navigationCount;
      navigated.resolve();
      if (http2Failure && current === 1) throw Error('page.goto: net::ERR_HTTP2_PROTOCOL_ERROR');
      if (navigationErrors[current - 1]) throw navigationErrors[current - 1];
      if (noResponse) responseWait?.reject(Object.assign(Error('observation timed out'), { name: 'TimeoutError' }));
      else if (!delayed) emit();
      return { status: () => navigationStatus };
    },
    async waitForTimeout() { calls.push('fixed-wait'); },
    url: () => url, content: async () => '<html>Verified public page</html>', frames: () => [],
  };
  const load = typescriptLoader({
    '@/lib/event-harvester/transport-recovery-context': { getTransportRecoveryProxy: () => proxy },
    'playwright-core': { chromium: { launch: async options => {
      launches.push(options); calls.push('launch');
      const launchNumber = launches.length;
      return { newPage: async options => { contexts.push(options); return page; }, close: async () => {
        calls.push('close-start'); firstClose.resolve();
        if (holdFirstClose && launchNumber === 1) await cleanup.promise;
        closed++; calls.push('close-finished');
      } };
    } } },
    '@sparticuz/chromium': { args: ['--existing-flag'] },
    './chromium-runtime': { getChromiumExecutablePath: async () => '/tmp/test-chromium' },
    '../transport-capacity-permits': { withTransportPermit: async (kind, operation) => {
      calls.push('acquire-' + kind);
      try { return await operation(new AbortController().signal); }
      finally { calls.push('release-' + kind); }
    } },
  });
  const browser = load('lib/event-harvester/first-party/browser-transport.ts');
  return { ...browser, calls, launches, contexts, waits, navigated, firstClose, cleanup, emit, closed: () => closed };
}

test('a delayed endpoint keeps the browser/permit until the response arrives and accepts empty inventory', async () => {
  const h = scenario({ delayed: true });
  let settled = false;
  const pending = h.fetchBrowserJsonResponses(url, value => value === endpoint).then(result => { settled = true; return result; });
  await h.navigated.promise; await flush();
  assert.equal(settled, false);
  assert.equal(h.closed(), 0);
  assert.equal(h.calls.includes('fixed-wait'), false);
  assert.equal(h.calls.includes('release-browser'), false);
  assert.deepEqual(h.waits, [20_000]);
  h.emit();
  const result = await pending;
  assert.equal(result.observedEndpoint, true);
  assert.equal(result.successfulResponse, true);
  assert.deepEqual(result.payloads, [[]]);
  assert.ok(h.calls.indexOf('close-finished') < h.calls.indexOf('release-browser'));
});

test('an endpoint timeout preserves the missing-response outcome', async () => {
  const h = scenario({ noResponse: true });
  const result = await h.fetchBrowserJsonResponses(url, value => value === endpoint);
  assert.equal(result.observedEndpoint, false);
  assert.equal(result.successfulResponse, false);
  assert.deepEqual(result.payloads, []);
  assert.equal(h.closed(), 1);
});

test('invalid endpoint JSON propagates after cleanup instead of becoming empty success', async () => {
  const h = scenario({ invalidJson: true });
  await assert.rejects(h.fetchBrowserJsonResponses(url, value => value === endpoint), /invalid endpoint JSON/);
  assert.equal(h.closed(), 1);
});

for (const kind of ['evidence', 'json']) test(`${kind}: HTTP/2 fallback waits for cleanup before compatible headers and HTTP/1`, async () => {
  const h = scenario({ http2Failure: true, holdFirstClose: true });
  const pending = kind === 'evidence' ? h.fetchBrowserEvidence(url)
    : h.fetchBrowserJsonResponses(url, value => value === endpoint);
  await h.firstClose.promise; await flush();
  assert.equal(h.launches.length, 1);
  assert.equal(h.calls.includes('release-browser'), false);
  h.cleanup.resolve();
  assert.equal((await pending).status, 200);
  assert.equal(h.launches.length, 2);
  assert.deepEqual(h.launches[0].args, ['--existing-flag']);
  assert.deepEqual(h.launches[1].args, ['--existing-flag', '--disable-http2']);
  assert.equal(h.contexts[0].userAgent, 'TenderFans Event Harvester/1.0');
  assert.match(h.contexts[1].userAgent, /Chrome\//);
  assert.equal(h.contexts[1].extraHTTPHeaders['Accept-Language'], 'en-US,en;q=0.9');
  assert.equal(h.closed(), 2);
});

for (const kind of ['evidence', 'json']) {
  const execute = h => kind === 'evidence' ? h.fetchBrowserEvidence(url)
    : h.fetchBrowserJsonResponses(url, value => value === endpoint);

  test(`${kind}: an empty navigation response retries compatible headers after permit release`, async () => {
    const h = scenario({ navigationErrors: [Error('page.goto: net::ERR_EMPTY_RESPONSE')], holdFirstClose: true });
    const pending = execute(h);
    await h.firstClose.promise; await flush();
    assert.equal(h.launches.length, 1);
    assert.equal(h.calls.includes('release-browser'), false);
    h.cleanup.resolve();
    const result = await pending;
    assert.equal(result.status, 200);
    assert.equal(h.launches.length, 2);
    assert.equal(h.closed(), 2);
    assert.deepEqual(h.launches[1].args, ['--existing-flag']);
    assert.equal(h.contexts[0].userAgent, 'TenderFans Event Harvester/1.0');
    assert.equal(h.contexts[0].extraHTTPHeaders, undefined);
    assert.match(h.contexts[1].userAgent, /Chrome\//);
    assert.equal(h.contexts[1].extraHTTPHeaders['Accept-Language'], 'en-US,en;q=0.9');
    assert.ok(h.calls.indexOf('release-browser') < h.calls.lastIndexOf('launch'));
    if (kind === 'json') assert.deepEqual(result.payloads, [[]]);
    else assert.equal(result.html, '<html>Verified public page</html>');
  });

  test(`${kind}: repeated navigation failures stop after one compatibility retry`, async () => {
    const first = Error('page.goto: net::ERR_EMPTY_RESPONSE');
    const second = Error('page.goto: net::ERR_HTTP2_PROTOCOL_ERROR');
    const h = scenario({ navigationErrors: [first, second] });
    await assert.rejects(execute(h), error => error === second);
    assert.equal(h.launches.length, 2);
    assert.equal(h.closed(), 2);
  });

  for (const name of ['AbortError', 'BrowserOperationTimeoutError', 'TransportPermitOwnershipLostError', 'TransportCapacityUnavailableError']) {
    test(`${kind}: ${name} cannot trigger navigation compatibility recovery`, async () => {
      const error = Object.assign(Error('page.goto: net::ERR_EMPTY_RESPONSE'), { name });
      const h = scenario({ navigationErrors: [error], proxy: 'http://proxy.example.com:8080' });
      await assert.rejects(execute(h), value => value === error);
      assert.equal(h.launches.length, 1);
      assert.equal(h.closed(), 1);
    });
  }

  test(`${kind}: an HTTP access response preserves its status without a navigation retry`, async () => {
    const h = scenario({ navigationStatus: 403 });
    assert.equal((await execute(h)).status, 403);
    assert.equal(h.launches.length, 1);
    assert.equal(h.closed(), 1);
  });
}

test('JSON recovery transport applies the same bounded compatibility retry with its own permits', async () => {
  const h = scenario({
    proxy: 'http://proxy.example.com:8080',
    navigationErrors: [
      Error('page.goto: net::ERR_EMPTY_RESPONSE'),
      Error('page.goto: net::ERR_EMPTY_RESPONSE'),
      Error('page.goto: net::ERR_EMPTY_RESPONSE'),
    ],
  });
  const result = await h.fetchBrowserJsonResponses(url, value => value === endpoint);
  assert.deepEqual(result.payloads, [[]]);
  assert.equal(h.launches.length, 4);
  assert.equal(h.closed(), 4);
  assert.equal(h.launches[0].proxy, undefined);
  assert.equal(h.launches[1].proxy, undefined);
  assert.equal(h.launches[2].proxy.server, 'http://proxy.example.com:8080');
  assert.equal(h.launches[3].proxy.server, 'http://proxy.example.com:8080');
  assert.equal(h.contexts[2].userAgent, 'TenderFans Event Harvester/1.0');
  assert.match(h.contexts[3].userAgent, /Chrome\//);
  assert.equal(h.calls.filter(x => x === 'release-browser').length, 4);
  assert.equal(h.calls.filter(x => x === 'release-recovery').length, 2);
});

test('endpoint JSON failures that mention an empty response do not retry browser navigation', async () => {
  const h = scenario({ invalidJson: 'Endpoint body failed: net::ERR_EMPTY_RESPONSE' });
  await assert.rejects(h.fetchBrowserJsonResponses(url, value => value === endpoint), /Endpoint body failed: net::ERR_EMPTY_RESPONSE/);
  assert.equal(h.launches.length, 1);
});

test('browser evidence honors the existing recovery context when its caller omits a proxy argument', async () => {
  const h = scenario({ proxy: 'http://user:example-password@proxy.example.com:8080' });
  await h.fetchBrowserEvidence(url);
  assert.deepEqual(h.calls.slice(0, 3), ['acquire-recovery', 'acquire-browser', 'launch']);
  assert.deepEqual(h.launches[0].proxy, {
    server: 'http://proxy.example.com:8080', username: 'user', password: 'example-password',
  });
  assert.deepEqual(h.calls.slice(-2), ['release-browser', 'release-recovery']);
});
