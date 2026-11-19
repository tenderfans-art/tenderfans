import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const container=process.env.TENDERFANS_TEST_POSTGRES_CONTAINER;
const database="tf_refill_"+process.pid;
const literal=v=>v===null?"null":"'"+String(v).replaceAll("'","''")+"'";
const read=f=>readFileSync("supabase/migrations/"+f+".sql","utf8");
function command(args,input="") {return new Promise((resolve,reject)=>{
  const child=spawn("docker",["exec","-i",container,...args],{stdio:["pipe","pipe","pipe"]});
  let out="",err="";child.stdout.on("data",v=>out+=v);child.stderr.on("data",v=>err+=v);
  child.on("error",reject);child.on("close",c=>c===0?resolve(out.trim()):reject(Error(err+out)));child.stdin.end(input);
});}
const sql=s=>command(["psql","-U","postgres","-d",database,"-qAt","-v","ON_ERROR_STOP=1"],s);
const json=async s=>JSON.parse((await sql(s)).split("\n").at(-1));
function table(file,name){const m=read(file).match(new RegExp(`^create table public\\.${name} \\([\\s\\S]*?^\\);`,"m"));assert.ok(m,name);return m[0];}
function rpc(file,name){const m=read(file).match(new RegExp(`create(?: or replace)? function\\s+public\\.${name}\\s*\\([\\s\\S]*?as\\s+(\\$[A-Za-z_0-9]*\\$)[\\s\\S]*?\\1;`,"i"));assert.ok(m,name);return m[0];}

for(const endings of ["LF","CRLF"])test(`continuous Market admission on PostgreSQL (${endings})`,{skip:!container,timeout:180000},async t=>{
  await command(["psql","-U","postgres","-qAt","-v","ON_ERROR_STOP=1"],
    "select pg_advisory_lock(hashtext('tenderfans-test-roles'));\n"+["anon","authenticated","service_role"].map(role=>
      `select 'create role ${role}' where not exists(select 1 from pg_roles where rolname='${role}')\n\\gexec\n`).join("")+
    `select pg_advisory_unlock(hashtext('tenderfans-test-roles')); create database ${database};`);
  t.after(()=>command(["psql","-U","postgres","-qAt"],`drop database ${database} with(force);`));
  await sql(readFileSync("tests/fixtures/continuous-market-baseline.sql","utf8"));
  for(const name of ["event_processing_markets","event_processing_market_venues","event_processing_work"])
    await sql(table("092_market_batch_work_queue",name));
  for(const name of ["event_processing_pool_config","event_processing_dispatch_reservations","shared_harvester_source_assignments"])
    await sql(table("099_shared_worker_admission",name));
  await sql(`alter table public.event_processing_markets
      add column max_concurrent_sources integer default 16,add column max_borrowed_sources integer default 16,
      add column max_borrowed_workflows integer default 2,add column overflow_queue_wait_minutes integer default 30,
      add column schedule_enabled boolean default false;
    alter table public.event_processing_pool_config add column max_concurrent_sources integer default 16,
      add column max_http_sources integer default 16,add column max_browser_sources integer default 4,
      add column max_recovery_sources integer default 2;
    insert into public.event_processing_pool_config(singleton)values(true);
    alter table public.event_processing_work add column market_cycle_id uuid;
    alter table public.event_processing_dispatch_reservations drop constraint event_processing_dispatch_reservations_work_type_check;
    alter table public.event_processing_dispatch_reservations add constraint event_processing_dispatch_reservations_work_type_check
      check(work_type in ('detect_spot','harvest_source','archive_recheck','harvest_provider'));`);
  await sql(table("110_approved_publisher_market_scheduling","event_processing_shared_source_markets"));
  await sql(table("123_scheduled_market_cycle_foundation","event_processing_market_cycles"));
  const functions=[
    ["110_approved_publisher_market_scheduling","event_processing_source_in_market"],
    ["121_spot_first_market_processing","shared_market_work_eligible"],
    ["115_shared_provider_archive_admission","market_shared_harvester_entitlement"],
    ["120_fair_shared_work_type_admission","reserve_shared_harvester_batch_scoped"],
    ["099_shared_worker_admission","finalize_shared_harvester_reservation"],
    ["119_terminal_workflow_settlement","settle_terminal_shared_harvester_run"],
    ["119_terminal_workflow_settlement","bind_shared_harvester_workflow_run"],
    ["126_align_market_workflow_deadlines","tf_cap_workflow_reservation_deadline"],
    ["122_bounded_market_execution_lifecycle","tf_cap_work_execution_deadline"],
    ["093_market_batch_claims","complete_event_processing_work"],
    ["093_market_batch_claims","fail_event_processing_work"],
    ["125_scheduled_market_cycle_cutover","reconcile_running_market_cycles"],
  ];
  for(const [file,name]of functions){let text=rpc(file,name);if(endings==="CRLF")text=text.replaceAll("\n","\r\n");await sql(text);}
  await sql(`create trigger tf_cap_workflow_reservation_deadline before insert or update on public.event_processing_dispatch_reservations
    for each row execute function public.tf_cap_workflow_reservation_deadline();
    create trigger tf_cap_work_execution_deadline before insert or update on public.event_processing_work
    for each row execute function public.tf_cap_work_execution_deadline();`);
  await sql(read("129_recover_closed_workflow_assignments"));
  await sql(read("130_continuous_market_refill"));
  const reset=()=>sql("truncate public.event_processing_markets,public.venues,public.event_harvest_sources cascade;");
  async function fixture(kinds=["detect_spot"],{marketId,cycleId}={}){
    const f={market:marketId??randomUUID(),cycle:cycleId??randomUUID(),work:[],reservations:[]};
    const statements=[];
    if(!marketId)statements.push(`insert into public.event_processing_markets(id,market_key,display_name,is_enabled,schedule_enabled)
      values(${literal(f.market)},${literal('m-'+f.market)},'Test',true,true);
      insert into public.event_processing_market_cycles(id,market_id,scheduled_for)values(${literal(f.cycle)},${literal(f.market)},now());`);
    for(const kind of kinds){
      const work=randomUUID(),venue=randomUUID(),source=randomUUID();f.work.push({id:work,kind,venue,source});
      if(kind==="detect_spot"||kind==="archive_recheck")statements.push(`insert into public.venues(id)values(${literal(venue)});
        insert into public.event_processing_market_venues(venue_id,market_id)values(${literal(venue)},${literal(f.market)});`);
      if(kind==="archive_recheck")statements.push(`insert into public.event_harvest_archive(venue_id,next_check_at)values(${literal(venue)},now()-interval '1 day');`);
      if(kind==="harvest_source")statements.push(`insert into public.event_harvest_sources(id)values(${literal(source)});
        insert into public.event_processing_shared_source_markets(source_id,market_id)values(${literal(source)},${literal(f.market)});`);
      if(kind==="harvest_provider")statements.push(`insert into public.event_harvest_sources(id,provider,external_source_id)
        values(${literal(source)},'ticketmaster','discovery-v2');
        insert into public.venues(id)values(${literal(venue)});
        insert into public.event_processing_market_venues(venue_id,market_id)values(${literal(venue)},${literal(f.market)});`);
      statements.push(`insert into public.event_processing_work(id,market_id,market_cycle_id,work_type,venue_id,source_id)
        values(${literal(work)},${literal(f.market)},${literal(f.cycle)},${literal(kind)},
        ${['detect_spot','archive_recheck'].includes(kind)?literal(venue):'null'},${kind==='harvest_source'?literal(source):'null'});`);
    }
    await sql(statements.join('\n'));
    return f;
  }
  async function reservation(f,{legacy=false}={}){
    const id=randomUUID(),run="wrun_"+randomUUID().replaceAll("-","");
    await sql(`insert into public.event_processing_dispatch_reservations(id,market_id,work_type,expires_at)
      values(${literal(id)},${literal(f.market)},'detect_spot',now()+interval '10 minutes');`);
    if(!legacy)assert.equal(await sql(`select public.prepare_shared_market_refill(${literal(id)});`),"t");
    assert.equal(await sql(`select public.bind_shared_harvester_workflow_run(${literal(f.market)},${literal(id)},${literal(run)});`),"t");
    const r={id,run};f.reservations.push(r);return r;
  }
  const claim=(r,slot)=>json(`select public.claim_refilling_market_assignment(${literal(r.id)},${slot});`);
  const complete=item=>sql(`select public.complete_event_processing_work(${literal(item.work_id)},${literal(item.claimed_lease_token)},'{}');`);
  const monitor=r=>sql(`select public.reconcile_shared_market_refill(${literal(r.id)},${literal(r.run)});`);
  const settle=r=>sql(`select public.settle_terminal_shared_harvester_run(${literal(r.id)},${literal(r.run)},'completed');`);

  await t.test("healthy runs claim beyond 20/55 minutes and more than 64 assignments",async()=>{
    await reset();const f=await fixture(Array(80).fill("detect_spot")),r=await reservation(f);
    await sql(`update public.event_processing_dispatch_reservations set reserved_at=now()-interval '70 minutes' where id=${literal(r.id)};`);
    assert.equal(await monitor(r),"");
    await sql(`do $exercise$ declare result jsonb; begin
      for i in 0..79 loop
        result:=public.claim_refilling_market_assignment(${literal(r.id)},i);
        if result->>'kind'<>'work' then raise exception 'Lane stopped at assignment %: %',i,result; end if;
        if (result->'item'->>'claimed_leased_until')::timestamptz-clock_timestamp()<interval '29 minutes' then
          raise exception 'Work lost its execution budget';
        end if;
        if not public.complete_event_processing_work((result->'item'->>'work_id')::uuid,
            (result->'item'->>'claimed_lease_token')::uuid,'{}') then raise exception 'Completion rejected'; end if;
      end loop;
    end; $exercise$;`);
    assert.equal((await claim(r,80)).kind,"stop");
    assert.equal(await sql(`select count(*) from public.shared_harvester_source_assignments where reservation_id=${literal(r.id)};`),"80");
  });
  await t.test("all work types use their original eligibility and a shared free lane",async()=>{
    await reset();const f=await fixture(['harvest_source','detect_spot','archive_recheck','harvest_provider']),r=await reservation(f),seen=[];
    for(let i=0;i<4;i++){const x=await claim(r,i);assert.equal(x.kind,"work");seen.push(x.item.claimed_work_type);await complete(x.item);}
    assert.deepEqual(seen.sort(),['archive_recheck','detect_spot','harvest_provider','harvest_source']);
  });
  await t.test("unstarted runs keep the original short admission expiry",async()=>{
    await reset();const f=await fixture(),id=randomUUID();
    await sql(`insert into public.event_processing_dispatch_reservations(id,market_id,work_type,expires_at)
      values(${literal(id)},${literal(f.market)},'detect_spot',now()+interval '10 minutes');`);
    assert.equal(await sql(`select public.prepare_shared_market_refill(${literal(id)});`),'t');
    assert.equal(await sql(`select expires_at<=reserved_at+interval '10 minutes' from public.event_processing_dispatch_reservations where id=${literal(id)};`),'t');
  });
  await t.test("temporary retry backoff never retires a lane or blocks ready Spots",async()=>{
    await reset();const f=await fixture(['harvest_source','detect_spot']),r=await reservation(f);
    await sql(`update public.event_processing_work set status='retry',due_at=now()+interval '10 minutes',attempts=1
      where id=${literal(f.work[0].id)};`);
    const first=await claim(r,0);assert.equal(first.item.claimed_work_type,'detect_spot');await complete(first.item);
    assert.deepEqual(await claim(r,8),{kind:'wait',delay_ms:60000});
    await sql(`update public.event_processing_work set due_at=now()+interval '3 seconds' where id=${literal(f.work[0].id)};`);
    const waiting=await claim(r,9);assert.equal(waiting.kind,'wait');assert.ok(waiting.delay_ms>=1000&&waiting.delay_ms<=3000);
    await sql(`update public.event_processing_work set due_at=now() where id=${literal(f.work[0].id)};`);
    assert.equal((await claim(r,16)).item.claimed_work_type,'harvest_source');
  });
  await t.test("concurrent claims respect 16 slots and refill a freed slot immediately",async()=>{
    await reset();const f=await fixture(Array(40).fill('detect_spot')),a=await reservation(f),b=await reservation(f);
    const results=await Promise.all(Array.from({length:32},(_,i)=>claim(i%2?a:b,i)));
    assert.equal(results.filter(x=>x.kind==='work').length,16);assert.equal(results.filter(x=>x.kind==='wait').length,16);
    assert.equal(await sql("select count(*) from public.event_processing_work where status='leased';"),"16");
    await complete(results.find(x=>x.kind==='work').item);
    assert.equal((await claim(a,100)).kind,'work');
    assert.equal(await sql("select count(*) from public.event_processing_work where status='leased';"),"16");
  });
  await t.test("two Markets admit two Workflows and sixteen independent worker slots each",async()=>{
    await reset();
    await sql('update public.event_processing_pool_config set max_concurrent_sources=32,max_concurrent_batches=4;');
    try {
      const markets=[await fixture(Array(24).fill('detect_spot')),await fixture(Array(24).fill('detect_spot'))];
      const runs=[];
      for(const f of markets) {
        const own=[];
        for(let i=0;i<2;i++) {
          const reserved=await json(`select row_to_json(r) from public.reserve_shared_harvester_batch_scoped(${literal(f.market)}) r;`);
          assert.equal(reserved.selected_market_id,f.market);
          const r={id:reserved.reservation_id,run:'wrun_'+randomUUID().replaceAll('-','')};
          assert.equal(await sql(`select public.prepare_shared_market_refill(${literal(r.id)});`),'t');
          assert.equal(await sql(`select public.bind_shared_harvester_workflow_run(${literal(f.market)},${literal(r.id)},${literal(r.run)});`),'t');
          own.push(r);
        }
        assert.equal(await sql(`select count(*) from public.reserve_shared_harvester_batch_scoped(${literal(f.market)});`),'0');
        runs.push(own);
      }
      const claimed=await Promise.all(markets.map((f,index)=>Promise.all(
        runs[index].flatMap(r=>Array.from({length:8},(_,slot)=>claim(r,slot))))));
      for(let i=0;i<markets.length;i++) {
        assert.equal(claimed[i].filter(x=>x.kind==='work').length,16);
        const venues=new Set(markets[i].work.map(w=>w.venue));
        for(const x of claimed[i]) assert.ok(venues.has(x.item.claimed_venue_id));
        assert.equal((await claim(runs[i][0],100)).kind,'wait');
      }
      assert.equal(await sql("select count(*) from public.event_processing_work where status='leased';"),'32');
      await complete(claimed[0][0].item);
      assert.equal((await claim(runs[1][0],101)).kind,'wait');
      assert.equal((await claim(runs[0][0],101)).kind,'work');
      assert.equal(await sql("select count(*) from public.event_processing_work where status='leased';"),'32');
    } finally {
      await reset();
      await sql('update public.event_processing_pool_config set max_concurrent_sources=16,max_concurrent_batches=2;');
    }
  });
  await t.test("immutable replay survives closure and never claims another item",async()=>{
    await reset();const f=await fixture(['detect_spot','detect_spot']),r=await reservation(f),x=await claim(r,0);
    await sql(`select public.stop_shared_market_refill(${literal(r.id)});`);
    assert.deepEqual(await claim(r,0),x);assert.equal((await claim(r,8)).kind,'stop');
    assert.equal(await sql("select sum(attempts) from public.event_processing_work;"),"1");
  });
  await t.test("expired ownership seals admission without shortening a newer job budget",async()=>{
    await reset();const f=await fixture(Array(3).fill('detect_spot')),r=await reservation(f),old=(await claim(r,0)).item,newer=(await claim(r,1)).item;
    await sql(`update public.event_processing_work set last_started_at=now()-interval '31 minutes',leased_until=now()-interval '1 minute'
      where id=${literal(old.work_id)};
      update public.shared_harvester_source_assignments set claimed_leased_until=now()-interval '1 minute'
      where work_id=${literal(old.work_id)};`);
    const deadline=await monitor(r);assert.ok(Date.parse(deadline)>=Date.parse(newer.claimed_leased_until)+299000);
    assert.equal((await claim(r,8)).kind,'stop');assert.equal(await monitor(r),deadline);
    assert.equal(await sql(`select status from public.event_processing_work where id=${literal(old.work_id)};`),'leased');
    assert.equal(await settle(r),'2');
  });
  await t.test("bound expired reservations keep Workflow capacity until terminal settlement",async()=>{
    await reset();const f=await fixture(Array(4).fill('detect_spot')),a=await reservation(f),b=await reservation(f);
    await claim(a,0);await claim(b,0);
    await sql("update public.event_processing_dispatch_reservations set reserved_at=now()-interval '2 hours',expires_at=now()-interval '1 minute';");
    assert.equal(await sql(`select count(*) from public.reserve_shared_harvester_batch_scoped(${literal(f.market)});`),'0');
    await settle(a);
    assert.equal(await sql(`select count(*) from public.reserve_shared_harvester_batch_scoped(${literal(f.market)});`),'1');
  });
  await t.test("source locks and publisher ownership remain authoritative",async()=>{
    await reset();const f=await fixture(['harvest_source','detect_spot']),r=await reservation(f);
    await sql(`insert into public.first_party_source_executions(source_id)values(${literal(f.work[0].source)});`);
    const x=await claim(r,0);assert.equal(x.item.claimed_work_type,'detect_spot');await complete(x.item);
    assert.equal((await claim(r,1)).kind,'wait');
    await sql("delete from public.first_party_source_executions;");
    assert.equal((await claim(r,2)).item.claimed_work_type,'harvest_source');
  });
  await t.test("provider execution remains exclusive across mixed Workflows",async()=>{
    await reset();const f=await fixture(['harvest_provider','harvest_provider']),a=await reservation(f),b=await reservation(f);
    const x=await claim(a,0);assert.equal(x.item.claimed_work_type,'harvest_provider');
    assert.equal((await claim(b,0)).kind,'wait');await complete(x.item);
    assert.equal((await claim(b,8)).item.claimed_work_type,'harvest_provider');
  });
  await t.test("original retry limits and backoff remain in force",async()=>{
    await reset();const f=await fixture(['harvest_source']),r=await reservation(f);
    for(let attempt=1;attempt<=5;attempt++){
      const x=(await claim(r,attempt)).item;assert.ok(x);
      assert.equal(await sql(`select public.fail_event_processing_work(${literal(x.work_id)},${literal(x.claimed_lease_token)},'Original source failure');`),'t');
      const state=await json(`select jsonb_build_object('status',status,'attempts',attempts,'error',last_error,'backoff',due_at>now())
        from public.event_processing_work where id=${literal(x.work_id)};`);
      assert.equal(state.status,attempt===5?'failed':'retry');assert.equal(state.attempts,attempt);assert.equal(state.error,'Original source failure');
      if(attempt<5){assert.equal(state.backoff,true);await sql(`update public.event_processing_work set due_at=now() where id=${literal(x.work_id)};`);}
    }
    assert.equal((await claim(r,6)).kind,'stop');
  });
  await t.test("a run cannot consume a different cycle or change active legacy ownership",async()=>{
    await reset();const f=await fixture(['detect_spot']),r=await reservation(f),legacy=await reservation(f,{legacy:true});
    assert.equal(await sql(`select public.prepare_shared_market_refill(${literal(legacy.id)});`),'f');
    await sql(`update public.event_processing_dispatch_reservations set reserved_at=now()-interval '20 minutes',expires_at=now()+interval '4 hours'
      where id=${literal(legacy.id)};`);
    assert.equal(await sql(`select round(extract(epoch from(expires_at-reserved_at))/60) from public.event_processing_dispatch_reservations where id=${literal(legacy.id)};`),'55');
    await complete((await claim(r,0)).item);
    const next=randomUUID();await sql(`insert into public.event_processing_market_cycles(id,market_id,scheduled_for)
      values(${literal(next)},${literal(f.market)},now()+interval '1 day');
      insert into public.event_processing_work(market_id,market_cycle_id,work_type,venue_id)
      values(${literal(f.market)},${literal(next)},'detect_spot',${literal(f.work[0].venue)});`);
    assert.equal((await claim(r,8)).kind,'stop');
  });
  await t.test("other waiting Markets receive bounded access to the shared fleet",async()=>{
    await reset();const f=await fixture(Array(3).fill('detect_spot')),a=await reservation(f),b=await reservation(f);
    const x=(await claim(a,0)).item;
    await fixture(['detect_spot']);
    await sql(`update public.event_processing_dispatch_reservations set reserved_at=now()-interval '21 minutes' where id=${literal(a.id)};`);
    assert.equal((await claim(a,8)).kind,'stop');
    const deadline=await monitor(a);assert.ok(Date.parse(deadline)>=Date.parse(x.claimed_leased_until)+299000);
    assert.equal((await claim(b,0)).kind,'work');
  });
  await t.test("only service callers can use refill and invalid run identity is rejected",async()=>{
    await reset();const f=await fixture(),r=await reservation(f);
    await assert.rejects(sql(`select public.reconcile_shared_market_refill(${literal(r.id)},'wrong');`),/does not belong/);
    for(const signature of ['prepare_shared_market_refill(uuid)','claim_refilling_market_assignment(uuid,integer)','reconcile_shared_market_refill(uuid,text)','list_refilling_market_runs_to_reconcile(integer)'])
      assert.equal(await sql(`select has_function_privilege('anon','public.${signature}','execute');`),'f');
    assert.equal(await sql("select has_function_privilege('service_role','public.stop_shared_market_refill(uuid)','execute');"),'f');
    await assert.rejects(sql(`set request.jwt.claim.role='authenticated'; select public.claim_refilling_market_assignment(${literal(r.id)},0);`),/Service role required/);
  });
});
