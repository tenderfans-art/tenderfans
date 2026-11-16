import assert from 'node:assert/strict';
import test from 'node:test';
import { typescriptLoader } from './helpers/typescript-loader.mjs';

function harness({ acquire, release, proof } = {}) {
  const calls = [], filters = [];
  const db = {
    rpc(name, args) {
      calls.push({ name, args });
      return { abortSignal: async signal => {
        if (name === 'acquire_event_processing_transport_permit') {
          return acquire?.(args, signal, calls) ?? { data: [{
            permit_id: 'permit', permit_token: 'owner',
            permit_expires_at: new Date(Date.now() + 120_000).toISOString(),
          }], error: null };
        }
        if (name === 'release_event_processing_transport_permit') {
          return release?.(args, signal, calls) ?? { data: true, error: null };
        }
        if (name === 'release_event_processing_transport_acquisition') return { error: null };
        assert.fail('Unexpected RPC: ' + name);
      } };
    },
    from(table) {
      assert.equal(table, 'event_processing_transport_permits');
      const query = {
        select(value) { assert.equal(value, 'id'); return query; },
        eq(...args) { filters.push(['eq', ...args]); return query; },
        not(...args) { filters.push(['not', ...args]); return query; },
        abortSignal() { return query; },
        async maybeSingle() { return proof?.() ?? { data: null, error: null }; },
      };
      return query;
    },
  };
  const load = typescriptLoader({ './transport-capacity-context': {
    getTransportCapacityContext: () => ({ supabase: db, sourceId: 'source' }),
    getSpotExecutionSignal: () => undefined,
  } }, text => text
    .replace('const ACQUIRE_WAIT_MS = 60_000;', 'const ACQUIRE_WAIT_MS = 100;')
    .replace('const ACQUIRE_RETRY_MS = 500;', 'const ACQUIRE_RETRY_MS = 1;')
    .replace('const RPC_TIMEOUT_MS = 15_000;', 'const RPC_TIMEOUT_MS = 20;')
    .replace('await sleep(250 * attempt)', 'await sleep(1 * attempt)'));
  return { ...load('lib/event-harvester/transport-capacity-permits.ts'), calls, filters };
}

test('statement/lock failures retry the original acquisition identity within its budget', async () => {
  for (const code of ['57014', '55P03', '40P01', '40001', 'PGRST003']) {
    let attempts = 0;
    const h = harness({ acquire: () => ++attempts === 1
      ? { data: null, error: { code, message: 'temporary database contention' } } : undefined });
    assert.equal(await h.withTransportPermit('browser', async () => 42), 42);
    const claims = h.calls.filter(x => x.name.startsWith('acquire_'));
    assert.equal(claims.length, 2);
    assert.equal(claims[0].args.p_acquisition_key, claims[1].args.p_acquisition_key);
    assert.equal(h.calls.filter(x => x.name === 'release_event_processing_transport_permit').length, 1);
  }
});

test('permission/argument errors propagate immediately and cancel the acquisition', async () => {
  for (const code of ['42501', '22023']) {
    const h = harness({ acquire: () => ({ data: null, error: { code, message: 'request rejected' } }) });
    await assert.rejects(h.withTransportPermit('http', () => assert.fail('must not execute')), /request rejected/);
    assert.equal(h.calls.filter(x => x.name.startsWith('acquire_')).length, 1);
    assert.equal(h.calls.at(-1).name, 'release_event_processing_transport_acquisition');
  }
});

test('repeated transient acquisition failures remain bounded and cancel the durable identity', async () => {
  const h = harness({ acquire: () => ({ data: null, error: { code: '57014', message: 'statement timeout' } }) });
  await assert.rejects(h.withTransportPermit('http', () => assert.fail('must not execute')), /Transport capacity unavailable/);
  assert.equal(h.calls.at(-1).name, 'release_event_processing_transport_acquisition');
  assert.equal(new Set(h.calls.map(x => x.args.p_acquisition_key).filter(Boolean)).size, 1);
});

test('an aborted release request is retried with the original permit ownership', async () => {
  let releases = 0;
  const h = harness({ release: (_args, signal) => {
    if (++releases > 1) return { data: true, error: null };
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({
      data: null, error: { message: 'AbortError: This operation was aborted' },
    }), { once: true }));
  } });
  assert.deepEqual(await h.withTransportPermit('http', async () => ({ inventory: 3 })), { inventory: 3 });
  const requests = h.calls.filter(x => x.name === 'release_event_processing_transport_permit');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].args, requests[1].args);
});

test('a committed release with a lost HTTP response is verified using ID, owner token and release state', async () => {
  let releases = 0;
  const h = harness({
    release: () => ++releases === 1
      ? { error: { message: 'TypeError: Failed to fetch' }, data: null }
      : { error: null, data: false },
    proof: () => ({ data: { id: 'permit' }, error: null }),
  });
  assert.equal(await h.withTransportPermit('http', async () => 'published'), 'published');
  assert.deepEqual(h.filters, [
    ['eq', 'id', 'permit'], ['eq', 'owner_token', 'owner'], ['not', 'released_at', 'is', null],
  ]);
});

test('a missing token-matched release proof remains ownership loss', async () => {
  const h = harness({ release: () => ({ error: null, data: false }) });
  await assert.rejects(h.withTransportPermit('http', async () => 'data'), /ownership lost/);
});

test('persistent release failures remain errors after three attempts', async () => {
  const h = harness({ release: () => ({ data: null, error: { code: '57014', message: 'statement timeout' } }) });
  await assert.rejects(h.withTransportPermit('http', async () => 'data'), /release failed: statement timeout/);
  assert.equal(h.calls.filter(x => x.name === 'release_event_processing_transport_permit').length, 3);
});
