import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const container = process.env.TENDERFANS_TEST_POSTGRES_CONTAINER;
const database = "tf_orphan_" + process.pid;
const read = file => readFileSync("supabase/migrations/" + file + ".sql", "utf8");
const literal = value => value === null ? "null" : "'" + String(value).replaceAll("'", "''") + "'";
function command(args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", container, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", error = "";
    child.stdout.on("data", data => { out += data; }); child.stderr.on("data", data => { error += data; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(out.trim()) : reject(Error(error + out)));
    child.stdin.end(input);
  });
}
const sql = text => command(["psql", "-U", "postgres", "-d", database, "-qAt", "-v", "ON_ERROR_STOP=1"], text);
const json = async text => JSON.parse((await sql(text)).split("\n").at(-1));
function table(file, name) {
  const found = read(file).match(new RegExp(`^create table public\\.${name} \\([\\s\\S]*?^\\);`, "m"));
  assert.ok(found, name); return found[0];
}
function rpc(file, name) {
  const found = read(file).match(new RegExp(`create(?: or replace)? function\\s+public\\.${name}\\s*\\([\\s\\S]*?as\\s+(\\$[A-Za-z_0-9]*\\$)[\\s\\S]*?\\1;`, "i"));
  assert.ok(found, name); return found[0];
}

for (const endings of ["LF", "CRLF"]) test(`expired Workflow ownership on PostgreSQL (${endings})`, { skip: !container, timeout: 120000 }, async t => {
  await command(["psql", "-U", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1"],
    "select pg_advisory_lock(hashtext('tenderfans-test-roles'));\n" + ["anon", "authenticated", "service_role"].map(role =>
      `select 'create role ${role}' where not exists(select 1 from pg_roles where rolname='${role}')\n\\gexec\n`).join("") +
    `select pg_advisory_unlock(hashtext('tenderfans-test-roles')); create database ${database};`);
  t.after(() => command(["psql", "-U", "postgres", "-qAt"], `drop database ${database} with(force);`));
  await sql(readFileSync("tests/fixtures/market-recovery-baseline.sql", "utf8"));
  await sql(table("092_market_batch_work_queue", "event_processing_markets"));
  await sql(table("092_market_batch_work_queue", "event_processing_work"));
  await sql(table("099_shared_worker_admission", "event_processing_pool_config"));
  await sql(table("099_shared_worker_admission", "event_processing_dispatch_reservations"));
  await sql(table("099_shared_worker_admission", "shared_harvester_source_assignments"));
  await sql(`insert into public.event_processing_pool_config(singleton) values(true);
    alter table public.event_processing_work add column market_cycle_id uuid;
    alter table public.event_processing_dispatch_reservations drop constraint event_processing_dispatch_reservations_work_type_check;
    alter table public.event_processing_dispatch_reservations add check(work_type in ('detect_spot','harvest_source','archive_recheck','harvest_provider'));`);
  let legacy = rpc("099_shared_worker_admission", "finalize_shared_harvester_reservation") + "\n" +
    rpc("119_terminal_workflow_settlement", "settle_terminal_shared_harvester_run");
  if (endings === "CRLF") legacy = legacy.replaceAll("\n", "\r\n");
  await sql(legacy);
  await sql(rpc("125_scheduled_market_cycle_cutover", "reconcile_running_market_cycles"));

  async function fixture({ state = "claimed", expired = true, attempts = 5, max = 5, status = "leased", kind = "detect_spot", bound = true } = {}) {
    const f = { market:randomUUID(), cycle:randomUUID(), venue:randomUUID(), source:randomUUID(),
      work:randomUUID(), reservation:randomUUID(), token:randomUUID(), batch:randomUUID(), run:"wrun_"+randomUUID().replaceAll("-","") };
    const lease = expired ? "now()-interval '144 minutes'" : "now()+interval '10 minutes'";
    await sql(`insert into public.venues(id) values(${literal(f.venue)});
      insert into public.event_harvest_sources(id)values(${literal(f.source)});
      insert into public.event_processing_markets(id,market_key,display_name)values(${literal(f.market)},${literal('m-'+f.market)},'Test');
      insert into public.event_processing_market_cycles(id,market_id,started_at)values(${literal(f.cycle)},${literal(f.market)},now()-interval '14 hours');
      insert into public.event_processing_work(id,market_id,market_cycle_id,work_type,venue_id,source_id,status,attempts,max_attempts,lease_token,leased_until,last_started_at)
      values(${literal(f.work)},${literal(f.market)},${literal(f.cycle)},${literal(kind)},
        ${['detect_spot','archive_recheck'].includes(kind)?literal(f.venue):'null'},${kind==='harvest_source'?literal(f.source):'null'},
        ${literal(status)},${attempts},${max},${status==='leased'?literal(f.token):'null'},${status==='leased'?lease:'null'},now()-interval '174 minutes');
      insert into public.event_processing_dispatch_reservations(id,market_id,work_type,status,reserved_at,expires_at,released_at,workflow_run_id)
      values(${literal(f.reservation)},${literal(f.market)},${literal(kind)},${literal(state)},now()-interval '180 minutes',now()-interval '125 minutes',
        ${['released','expired'].includes(state)?"now()-interval '138 minutes'":'null'},${bound?literal(f.run):'null'});
      insert into public.shared_harvester_source_assignments(reservation_id,slot_number,work_id,lease_token,claimed_batch_id,claimed_attempt,claimed_venue_id,claimed_source_id,claimed_leased_until)
      values(${literal(f.reservation)},0,${literal(f.work)},${literal(f.token)},${literal(f.batch)},${attempts},
        ${['detect_spot','archive_recheck'].includes(kind)?literal(f.venue):'null'},${kind==='harvest_source'?literal(f.source):'null'},${lease});`);
    return f;
  }
  const finalize = f => sql(`select public.finalize_shared_harvester_reservation(${literal(f.reservation)});`);
  const settle = (f,status="completed") => sql(`select public.settle_terminal_shared_harvester_run(${literal(f.reservation)},${literal(f.run)},${literal(status)});`);
  const cycle = f => sql(`select public.reconcile_running_market_cycles(${literal(f.market)},32);`);

  const orphan = await fixture();
  await t.test("reproduces the production orphan with the previous functions", async () => {
    assert.equal(await finalize(orphan),"t"); assert.equal(await settle(orphan),"0");
    assert.equal(await sql(`select status from public.event_processing_work where id=${literal(orphan.work)};`),"leased");
    assert.equal(await cycle(orphan),"0");
  });
  await sql(read("129_recover_closed_workflow_assignments"));

  await t.test("finds released expired ownership and records exhausted work as failed",async()=>{
    const rows=await json(`select coalesce(jsonb_agg(to_jsonb(r)),'[]') from public.list_shared_harvester_runs_to_reconcile(32) r;`);
    assert.ok(rows.some(r=>r.id===orphan.reservation));
    const released=await sql(`select released_at from public.event_processing_dispatch_reservations where id=${literal(orphan.reservation)};`);
    assert.equal(await settle(orphan),"1");
    const state=await json(`select jsonb_build_object('status',status,'token',lease_token,'expiry',leased_until,'error',last_error)
      from public.event_processing_work where id=${literal(orphan.work)};`);
    assert.equal(state.status,"failed");assert.equal(state.token,null);assert.equal(state.expiry,null);
    assert.match(state.error,/completed before work acknowledgement/);
    assert.equal(await settle(orphan),"0");
    assert.equal(await sql(`select released_at from public.event_processing_dispatch_reservations where id=${literal(orphan.reservation)};`),released);
    assert.equal(await cycle(orphan),"1");
    const result=await json(`select jsonb_build_object('status',status,'finished',finished_at is not null)
      from public.event_processing_market_cycles where id=${literal(orphan.cycle)};`);
    assert.deepEqual(result,{status:"completed_with_failures",finished:true});
  });

  await t.test("finalization keeps expired unacknowledged assignments visible",async()=>{
    const f=await fixture();assert.equal(await finalize(f),"f");
    assert.equal(await sql(`select status from public.event_processing_dispatch_reservations where id=${literal(f.reservation)};`),"claimed");
    assert.equal(await settle(f,"failed"),"1");assert.equal(await finalize(f),"t");
  });
  await t.test("acknowledged work still finalizes normally",async()=>{
    const f=await fixture({status:"completed"});assert.equal(await finalize(f),"t");
  });
  for(const kind of ['detect_spot','harvest_source','archive_recheck','harvest_provider'])await t.test(`retry/backoff and attempt policy are retained for ${kind}`,async()=>{
    const f=await fixture({state:"expired",attempts:2,kind});assert.equal(await settle(f,"cancelled"),"1");
    const state=await json(`select jsonb_build_object('status',status,'future',due_at>now(),'attempts',attempts,'max',max_attempts)
      from public.event_processing_work where id=${literal(f.work)};`);
    assert.deepEqual(state,{status:"retry",future:true,attempts:2,max:5});
    assert.equal(await cycle(f),"0");
  });
  await t.test("a superseding lease can never be settled by the old run",async()=>{
    const f=await fixture({state:"released"}),token=randomUUID();
    await sql(`update public.event_processing_work set lease_token=${literal(token)} where id=${literal(f.work)};`);
    assert.equal(await settle(f),"0");
    assert.equal(await sql(`select lease_token from public.event_processing_work where id=${literal(f.work)};`),token);
    const rows=await json(`select coalesce(jsonb_agg(to_jsonb(r)),'[]') from public.list_shared_harvester_runs_to_reconcile(64) r;`);
    assert.ok(!rows.some(r=>r.id===f.reservation));
  });
  await t.test("closed reservations with live work are excluded and protected",async()=>{
    const f=await fixture({state:"released",expired:false});assert.equal(await settle(f),"0");
    const rows=await json(`select coalesce(jsonb_agg(to_jsonb(r)),'[]') from public.list_shared_harvester_runs_to_reconcile(64) r;`);
    assert.ok(!rows.some(r=>r.id===f.reservation));
  });
  await t.test("invalid run identity and nonterminal statuses cannot change work",async()=>{
    const f=await fixture({state:"released"});
    await assert.rejects(settle({...f,run:"wrong-run"}),/does not belong/);
    await assert.rejects(settle(f,"running"),/Invalid terminal/);
    assert.equal(await sql(`select status from public.event_processing_work where id=${literal(f.work)};`),"leased");
  });
  await t.test("lookup limits and service-only access remain enforced",async()=>{
    await assert.rejects(sql("select * from public.list_shared_harvester_runs_to_reconcile(0);"),/Invalid Workflow reconciliation limit/);
    assert.equal(await sql("select has_function_privilege('anon','public.list_shared_harvester_runs_to_reconcile(integer)','execute');"),"f");
    assert.equal(await sql("select max_concurrent_batches from public.event_processing_pool_config;"),"2");
  });
});
