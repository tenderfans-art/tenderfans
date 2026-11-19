import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const container=process.env.TENDERFANS_TEST_POSTGRES_CONTAINER;
const database='tf_market_creation_'+process.pid;
const read=name=>readFileSync('supabase/migrations/'+name+'.sql','utf8');
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
function command(args,input='') {return new Promise((resolve,reject)=>{
  const child=spawn('docker',['exec','-i',container,...args],{stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);
  child.on('error',reject);child.on('close',code=>code===0?resolve(out.trim()):reject(Error(err+out)));
  child.stdin.end(input);
});}
const sql=source=>command(['psql','-U','postgres','-d',database,'-qAt','-v','ON_ERROR_STOP=1'],source);
const json=async source=>JSON.parse((await sql(source)).split('\n').at(-1));
function table(file,name){const match=read(file).match(new RegExp(`^create table public\\.${name} \\([\\s\\S]*?^\\);`,'m'));assert.ok(match,name);return match[0];}
function rpc(file,name){const match=read(file).match(new RegExp(`create(?: or replace)? function\\s+public\\.${name}\\s*\\([\\s\\S]*?as\\s+(\\$[A-Za-z_0-9]*\\$)[\\s\\S]*?\\1;`,'i'));assert.ok(match,name);return match[0];}

test('county creation and first enable on PostgreSQL',{skip:!container,timeout:120000},async t=>{
  await command(['psql','-U','postgres','-qAt','-v','ON_ERROR_STOP=1'],
    "select pg_advisory_lock(hashtext('tenderfans-test-roles'));\n"+
    ['anon','authenticated','service_role'].map(role=>`select 'create role ${role}' where not exists(select 1 from pg_roles where rolname='${role}')\n\\gexec\n`).join('')+
    `select pg_advisory_unlock(hashtext('tenderfans-test-roles'));create database ${database};`);
  t.after(()=>command(['psql','-U','postgres','-qAt'],`drop database ${database} with(force);`));
  await sql(`create schema auth;
    create function auth.role() returns text language sql as $$select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'service_role')$$;
    create table public.venues(id uuid primary key);`);
  await sql(table('092_market_batch_work_queue','event_processing_markets'));
  await sql(table('092_market_batch_work_queue','event_processing_market_venues'));
  await sql(table('099_shared_worker_admission','event_processing_pool_config'));
  await sql(`alter table public.event_processing_markets add column max_concurrent_sources integer not null default 8;
    alter table public.event_processing_pool_config
      add column max_concurrent_sources integer not null default 16 check(max_concurrent_sources between 1 and 128),
      add column max_http_sources integer default 16,add column max_browser_sources integer default 4,
      add column max_recovery_sources integer default 2;
    insert into public.event_processing_pool_config(singleton) values(true);`);
  await sql(read('111_market_source_capacity_baseline'));
  await sql(read('123_scheduled_market_cycle_foundation').match(/alter table public.event_processing_markets[\s\S]*?;/)[0]);
  await sql(table('106_market_geographic_onboarding','event_processing_market_counties'));
  await sql(rpc('106_market_geographic_onboarding','create_market_with_county'));
  for(const name of ['next_market_schedule_after','set_market_processing_enabled'])
    await sql(rpc('125_scheduled_market_cycle_cutover',name));
  await sql(read('132_county_market_activation_capacity'));
  const create=(county,key,zone='America/New_York')=>json(`select to_json(public.create_market_with_county(
    'Unrelated label',${literal(key)},'US','FL',${literal(county)},${literal(zone)}));`);
  const market=id=>json(`select row_to_json(m) from public.event_processing_markets m where id=${literal(id)};`);
  const pool=()=>json('select row_to_json(p) from public.event_processing_pool_config p;');
  const assign=async id=>{const venue=randomUUID();await sql(`insert into public.venues values(${literal(venue)});
    insert into public.event_processing_market_venues(venue_id,market_id) values(${literal(venue)},${literal(id)});`);};
  const enable=(id,on=true)=>sql(`select public.set_market_processing_enabled(${literal(id)},${on});`);
  let first,second,isolation;
  await t.test('creation is disabled with two workflows, sixteen jobs and the requested local zone',async()=>{
    first=await create('First County','first-county');second=await create('Second County','second-county');
    for(const id of [first,second]) {const m=await market(id);
      assert.equal(m.max_concurrent_batches,2);assert.equal(m.max_concurrent_sources,16);
      assert.equal(m.is_enabled,false);assert.equal(m.schedule_enabled,false);assert.equal(m.next_scheduled_at,null);
      assert.equal(m.schedule_timezone,'America/New_York');assert.equal(m.schedule_local_time,'09:30:00');
    }
    assert.equal((await market(first)).display_name,'First County');
    assert.equal((await pool()).max_concurrent_sources,16);
  });
  await t.test('duplicate counties and invalid zones leave no partial Market',async()=>{
    await assert.rejects(create('First County','duplicate-key'),/duplicate key/);
    await assert.rejects(create('Third County','third-county','invalid/timezone'),/time zone required/);
    assert.equal(await json('select to_json(count(*)) from public.event_processing_markets;'),2);
  });
  await t.test('empty Market cannot enable or consume capacity',async()=>{
    await assert.rejects(enable(first),/Assign Spots/);
    assert.equal((await market(first)).is_enabled,false);assert.equal((await pool()).max_concurrent_batches,2);
  });
  await t.test('simultaneous first enables allocate both baselines, excluding disabled isolation',async()=>{
    isolation=await json("insert into public.event_processing_markets(market_key,display_name,max_concurrent_batches) values('isolation','Isolation',1) returning to_json(id);");
    await assign(first);await assign(second);
    await Promise.all([enable(first),enable(second)]);
    const p=await pool();assert.equal(p.max_concurrent_batches,4);assert.equal(p.max_concurrent_sources,32);
    assert.equal(p.max_browser_sources,4);assert.equal(p.max_http_sources,16);assert.equal(p.max_recovery_sources,2);
    for(const id of [first,second]) {const m=await market(id);
      assert.equal(m.is_enabled,true);assert.equal(m.schedule_enabled,true);
      assert.equal(await json(`select to_json((next_scheduled_at at time zone schedule_timezone)::time::text)
        from public.event_processing_markets where id=${literal(id)};`),'09:30:00');
    }
    assert.equal((await market(isolation)).is_enabled,false);
    assert.equal((await market(isolation)).max_concurrent_batches,1);
  });
  await t.test('repeated enable does not multiply capacity or move an existing next occurrence',async()=>{
    const before=await market(first);await enable(first);await enable(second);
    assert.equal((await market(first)).next_scheduled_at,before.next_scheduled_at);
    assert.equal((await pool()).max_concurrent_sources,32);
    await sql('update public.event_processing_pool_config set max_concurrent_sources=64,max_concurrent_batches=8;');
    await enable(first);assert.equal((await pool()).max_concurrent_sources,64);
    await enable(second,false);assert.equal((await pool()).max_concurrent_sources,64);
    assert.equal((await market(second)).is_enabled,false);
  });
  await t.test('an older disabled one-workflow Market receives the standard baseline on enable',async()=>{
    await assign(isolation);await enable(isolation);
    assert.equal((await market(isolation)).max_concurrent_batches,2);
    assert.equal((await market(isolation)).max_concurrent_sources,16);
  });
  await t.test('local clock scheduling remains DST safe',async()=>{
    for(const [after,expected]of [['2027-03-13T15:00:00Z','2027-03-14T13:30:00+00:00'],
      ['2027-11-06T15:00:00Z','2027-11-07T14:30:00+00:00']]) {
      const actual=await json(`select to_json(public.next_market_schedule_after('America/New_York','09:30',${literal(after)}));`);
      assert.equal(Date.parse(actual),Date.parse(expected));
    }
  });
  await t.test('fleet capacity scales beyond the old single-pool limit',async()=>{
    const more=[];
    for(let i=0;i<7;i++) {const id=await create('Additional '+i+' County','additional-'+i);await assign(id);more.push(id);}
    await Promise.all(more.map(id=>enable(id)));
    assert.equal((await pool()).max_concurrent_sources,144);
    assert.equal((await pool()).max_concurrent_batches,18);
    assert.equal((await market(second)).is_enabled,false);
    assert.equal((await pool()).max_browser_sources,4);
  });
  await t.test('non-service callers cannot create or enable Markets',async()=>{
    await assert.rejects(sql("set request.jwt.claim.role='authenticated';select public.set_market_processing_enabled("+literal(first)+",true);"),/Service role required/);
    await assert.rejects(sql("set role authenticated;select public.create_market_with_county('X','x','US','FL','X County','UTC');"),/permission denied/);
  });
});
