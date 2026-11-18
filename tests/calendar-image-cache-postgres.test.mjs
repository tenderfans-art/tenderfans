import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const container = process.env.TENDERFANS_TEST_POSTGRES_CONTAINER;
const database = 'tf_image_cache_' + process.pid;
const literal = value => value === null ? 'null' : "'" + String(value).replaceAll("'", "''") + "'";
function command(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', value => out += value); child.stderr.on('data', value => err += value);
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(out.trim()) : reject(Error(err + out)));
    child.stdin.end(input);
  });
}
const sql = text => command(['psql', '-U', 'postgres', '-d', database, '-qAt', '-v', 'ON_ERROR_STOP=1'], text);
const json = async text => JSON.parse((await sql(text)).split('\n').at(-1));
const call = (key, token, action = 'claim', extraction = null) =>
  `select public.calendar_image_extraction_cache(${literal(key)},${literal(token)},${literal(action)},${extraction === null ? 'null' : literal(JSON.stringify(extraction)) + '::jsonb'});`;
const empty = { isEventCalendar: true, qualificationReason: 'Verified empty calendar', weekStart: null, events: [] };

test('calendar extraction reuse on PostgreSQL', { skip: !container, timeout: 120000 }, async t => {
  await command(['psql', '-U', 'postgres', '-qAt', '-v', 'ON_ERROR_STOP=1'],
    "select pg_advisory_lock(hashtext('tenderfans-test-roles'));\n" + ['anon', 'authenticated', 'service_role'].map(role =>
      `select 'create role ${role}' where not exists(select 1 from pg_roles where rolname='${role}')\n\\gexec\n`).join('') +
    `select pg_advisory_unlock(hashtext('tenderfans-test-roles')); create database ${database};`);
  t.after(() => command(['psql', '-U', 'postgres', '-qAt'], `drop database ${database} with(force);`));
  await sql(readFileSync('supabase/migrations/131_calendar_image_extraction_cache.sql', 'utf8'));

  await t.test('concurrent initial claims elect exactly one paid producer', async () => {
    const key = 'a'.repeat(64), tokens = [randomUUID(), randomUUID()];
    const rows = await Promise.all(tokens.map(token => json(call(key, token))));
    assert.deepEqual(rows.map(row => row.state).sort(), ['busy', 'claimed']);
    const owner = tokens[rows.findIndex(row => row.state === 'claimed')];
    const other = tokens.find(token => token !== owner);
    assert.equal((await json(call(key, other, 'save', empty))).state, 'lost');
    assert.equal((await json(call(key, other, 'release'))).state, 'lost');
    const saved = await json(call(key, owner, 'save', empty));
    assert.deepEqual(saved.extraction, empty);
    assert.deepEqual(await json(call(key, other)), saved);
    assert.deepEqual(await json(call(key, owner, 'save', { ...empty, qualificationReason: 'Must not overwrite' })), saved);
  });

  await t.test('claim replay preserves its original deadline and expired claims can be recovered', async () => {
    const key = 'b'.repeat(64), first = randomUUID(), second = randomUUID();
    await json(call(key, first));
    const initial = await sql(`select claim_until from public.calendar_image_extractions where cache_key=${literal(key)};`);
    assert.equal((await json(call(key, first))).state, 'claimed');
    assert.equal(await sql(`select claim_until from public.calendar_image_extractions where cache_key=${literal(key)};`), initial);
    assert.equal((await json(call(key, second, 'renew'))).state, 'lost');
    await sql(`update public.calendar_image_extractions set claim_until=clock_timestamp()+interval '10 seconds' where cache_key=${literal(key)};`);
    assert.equal((await json(call(key, first, 'renew'))).state, 'renewed');
    assert.equal(await sql(`select claim_until>clock_timestamp()+interval '90 seconds' from public.calendar_image_extractions where cache_key=${literal(key)};`), 't');
    await sql(`update public.calendar_image_extractions set claim_until=clock_timestamp()-interval '1 second' where cache_key=${literal(key)};`);
    assert.equal((await json(call(key, first, 'save', empty))).state, 'lost');
    assert.equal((await json(call(key, first, 'renew'))).state, 'lost');
    assert.equal((await json(call(key, second))).state, 'claimed');
    assert.equal((await json(call(key, first, 'save', empty))).state, 'lost');
    assert.equal((await json(call(key, first, 'release'))).state, 'lost');
    assert.equal((await json(call(key, second, 'release'))).state, 'released');
    assert.equal((await json(call(key, first))).state, 'claimed');
  });

  await t.test('confirmed non-calendars and valid empty extraction are reusable outcomes', async () => {
    const key = 'c'.repeat(64), token = randomUUID();
    const negative = { ...empty, isEventCalendar: false, qualificationReason: 'Photograph, confirmed twice' };
    await json(call(key, token));
    assert.deepEqual((await json(call(key, token, 'save', negative))).extraction, negative);
    assert.deepEqual((await json(call(key, randomUUID()))).extraction, negative);
  });

  await t.test('malformed output cannot become a cache hit', async () => {
    const key = 'd'.repeat(64), token = randomUUID();
    await json(call(key, token));
    for (const bad of [{}, { ...empty, events: {} }, { ...empty, weekStart: 'Friday' }, { ...empty, isEventCalendar: false, events: [{}] }]) {
      await assert.rejects(sql(call(key, token, 'save', bad)), /Invalid calendar extraction cache payload/);
    }
    assert.equal((await json(call(key, randomUUID()))).state, 'busy');
  });

  await t.test('only service role can use the RPC and direct table access stays closed', async () => {
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(sql(`set role ${role}; ${call('e'.repeat(64), randomUUID())}`), /permission denied/);
      await assert.rejects(sql(`set role ${role}; select * from public.calendar_image_extractions;`), /permission denied/);
    }
    const key = 'e'.repeat(64), token = randomUUID();
    assert.equal((await json(`set role service_role; ${call(key, token)}`)).state, 'claimed');
    await assert.rejects(sql('set role service_role; select * from public.calendar_image_extractions;'), /permission denied/);
  });
});
