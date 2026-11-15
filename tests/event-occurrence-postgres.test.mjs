import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { reconcileEventDuplicates } from "../scripts/reconcile-event-duplicates.mjs";

const container = process.env.TENDERFANS_TEST_POSTGRES_CONTAINER;
const database = "tf_occurrence_" + process.pid;
function command(args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", container, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", error = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(out.trim()) : reject(Error(error + "\n" + out)));
    child.stdin.end(input);
  });
}
const sql = text => command(["psql", "-U", "postgres", "-d", database, "-qAt", "-v", "ON_ERROR_STOP=1"], text);
const json = async text => JSON.parse((await sql(text)).split("\n").at(-1));
const quote = value => value == null ? "null" : "'" + String(value).replaceAll("'", "''") + "'";
const read = file => readFileSync(file, "utf8");

for (const lineEndings of ["LF", "CRLF", "changed"]) test(`shared event occurrence lifecycle on PostgreSQL (${lineEndings})`, { skip: !container, timeout: 120000 }, async t => {
  await command(["psql", "-U", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1"],
    `select 'create role anon' where not exists(select 1 from pg_roles where rolname='anon')\n\\gexec\n` +
    `select 'create role authenticated' where not exists(select 1 from pg_roles where rolname='authenticated')\n\\gexec\n` +
    `select 'create role service_role' where not exists(select 1 from pg_roles where rolname='service_role')\n\\gexec\n` +
    `select 'create role tf_event_readonly' where not exists(select 1 from pg_roles where rolname='tf_event_readonly')\n\\gexec\n` +
    `alter role tf_event_readonly bypassrls;\n` +
    `create database ${database};`);
  t.after(() => command(["psql", "-U", "postgres", "-qAt"], `drop database ${database} with (force);`));
  await sql(read("tests/fixtures/event-occurrence-baseline.sql"));
  for (const name of ["040_event_harvester_foundation", "041_ticketmaster_harvester", "050_first_party_event_sources",
    "055_bootstrap_event_notification_suppression", "057_first_party_event_disappearance",
    "058_event_all_day_semantics", "059_venue_scoped_first_party_sources",
    "060_first_party_event_attribution", "089_verified_event_identity_linking",
    "091_cross_source_occurrence_guard", "094_first_party_source_execution_lock"]) await sql(read(`supabase/migrations/${name}.sql`));
  if (lineEndings === "CRLF") {
    await sql(`do $crlf$ begin execute replace(pg_get_functiondef(
      'public.flag_event_harvest_occurrence_review(uuid)'::regprocedure), E'\\n', E'\\r\\n'); end; $crlf$;`);
    assert.equal(await sql(`select md5(prosrc) from pg_proc
      where oid='public.flag_event_harvest_occurrence_review(uuid)'::regprocedure;`),
      "b1dd0f67441db0091a941b93838e04c1", "replicates the production baseline exactly");
  }
  if (lineEndings === "changed") {
    await sql(`do $changed$ begin execute replace(pg_get_functiondef(
      'public.flag_event_harvest_occurrence_review(uuid)'::regprocedure),
      'possible_cross_source_duplicate', 'different_review_policy'); end; $changed$;`);
    await assert.rejects(sql(read("supabase/migrations/128_shared_event_occurrence_identity.sql")), /differs from the verified baseline/);
    assert.equal(await sql(`select exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='events' and column_name='merged_into_event_id');`),"f");
    return;
  }
  await sql(read("supabase/migrations/128_shared_event_occurrence_identity.sql"));
  assert.equal(await sql(`select position('perform public.lock_event_harvest_occurrence(p_candidate_id);'
    in prosrc) > 0 from pg_proc where oid='public.flag_event_harvest_occurrence_review(uuid)'::regprocedure;`),"t");

  async function fixture() {
    const venue = randomUUID(), a = randomUUID(), b = randomUUID(), c = randomUUID();
    await sql(`insert into public.venues(id,name) values (${quote(venue)},'Shared venue');
      insert into public.event_harvest_sources(id,provider,source_type,name,venue_id,source_url,trust_level)
      values ${[a,b,c].map((id,i) => `(${quote(id)},'first_party','source_${i}','Source',${quote(venue)},'https://publisher.example/feed/${i}','trusted')`).join(",")};`);
    return { venue, a, b, c };
  }
  async function candidate(f, source, { allDay = false, start = "2026-11-14T05:00:00Z", end = "2026-11-15T04:59:59Z",
    title = "Community event", url = "https://publisher.example/event/one/", zone = "America/New_York", fingerprint, status = "matched" } = {}) {
    const id = randomUUID();
    const hash = fingerprint ?? createHash("sha256").update([f.venue,title.toLowerCase(),start].join("|")).digest("hex");
    await sql(`insert into public.event_harvest_candidates(id,source_id,external_event_id,source_url,raw_title,
      normalized_title,venue_id,starts_at,ends_at,is_all_day,event_fingerprint,status,raw_payload)
      values (${quote(id)},${quote(source)},${quote(id)},${quote(url)},${quote(title)},${quote(title.toLowerCase())},
      ${quote(f.venue)},${quote(start)},${quote(end)},${allDay},${quote(hash)},${quote(status)},
      ${quote(JSON.stringify({isAllDay:allDay,tenderfansOccurrence:zone?{version:1,timeZone:zone}:null}))}::jsonb);`);
    return id;
  }
  const graduate = id => sql(`select public.graduate_harvest_candidate(${quote(id)},null);`);
  const link = id => sql(`select public.link_harvest_candidate_to_existing_event(${quote(id)});`);
  async function sync(id) {
    return sql(`select public.sync_first_party_event(c.id,c.source_url,c.raw_title,c.raw_description,
      c.raw_starts_at,c.raw_ends_at,c.normalized_title,c.starts_at,c.ends_at,c.event_fingerprint,null,c.raw_payload)
      from public.event_harvest_candidates c where c.id=${quote(id)};`);
  }
  const allDay = { allDay:true,start:"2026-11-14T00:00:00Z",end:"2026-11-15T00:00:00Z" };

  for (const order of ["all-day first", "timed first"]) await t.test(order, async () => {
    const f=await fixture(), day=await candidate(f,f.a,allDay), timed=await candidate(f,f.b);
    const first=order==="all-day first"?day:timed, second=first===day?timed:day;
    const canonical=await graduate(first); await sync(first);
    assert.equal(await link(second),canonical); await sync(second); await sync(day);
    const state=await json(`select jsonb_build_object('count',count(*),'allDay',bool_or(is_all_day),
      'start',min(starts_at)::text) from public.events where venue_id=${quote(f.venue)} and status='published';`);
    assert.equal(state.count,1); assert.equal(state.allDay,false); assert.equal(Date.parse(state.start),Date.parse("2026-11-14T05:00:00Z"));
    assert.equal(await sql(`select count(*) from public.event_source_links where event_id=${quote(canonical)};`),"2");
  });

  await t.test("publication rechecks simultaneous source discoveries",async()=>{
    const f=await fixture(),a=await candidate(f,f.a,allDay),b=await candidate(f,f.b);
    assert.equal(await link(a),""); assert.equal(await link(b),"");
    const results=await Promise.all([graduate(a),graduate(b)]);
    assert.equal(results[0],results[1]);
    assert.equal(await sql(`select count(*) from public.events where venue_id=${quote(f.venue)};`),"1");
  });

  await t.test("an all-day observation cannot bridge distinct timed performances",async()=>{
    const f=await fixture(),day=await candidate(f,f.a,allDay),first=await candidate(f,f.b);
    const canonical=await graduate(day); await sync(day); assert.equal(await link(first),canonical); await sync(first);
    const second=await candidate(f,f.c,{start:"2026-11-14T20:00:00Z",end:"2026-11-14T23:00:00Z"});
    assert.equal(await link(second),""); assert.notEqual(await graduate(second),canonical);
  });

  await t.test("recurring dates and different venues stay distinct",async()=>{
    const f=await fixture(),first=await candidate(f,f.a,allDay); const canonical=await graduate(first); await sync(first);
    const next=await candidate(f,f.b,{start:"2026-11-15T05:00:00Z",end:"2026-11-16T04:59:59Z"});
    assert.equal(await link(next),""); assert.notEqual(await graduate(next),canonical);
    const other=await fixture(),same=await candidate(other,other.a);assert.equal(await link(same),"");
  });

  await t.test("missing timezone evidence and feed URLs do not gain guessed identity",async()=>{
    const f=await fixture(),first=await candidate(f,f.a,allDay);await graduate(first);await sync(first);
    const unknown=await candidate(f,f.b,{zone:null});assert.equal(await link(unknown),"");
    assert.equal(await graduate(unknown),"");
    assert.equal(await sql(`select status from public.event_harvest_candidates where id=${quote(unknown)};`),"needs_review");
    const x=await candidate(f,f.b,{url:"https://publisher.example/feed/1"});assert.equal(await link(x),"");
  });

  await t.test("the same instant does not confuse a date-only event with the previous local date",async()=>{
    const f=await fixture(),day=await candidate(f,f.a,allDay);await graduate(day);await sync(day);
    const previousEvening=await candidate(f,f.b,{start:allDay.start,end:"2026-11-14T03:00:00Z"});
    assert.equal(await link(previousEvening),"");
  });

  await t.test("date identity works east of UTC and across DST",async()=>{
    for(const spec of [{zone:"Asia/Tokyo",start:"2026-11-13T15:00:00Z",end:"2026-11-14T14:59:59Z"},
      {zone:"America/New_York",start:"2026-11-01T04:00:00Z",end:"2026-11-02T04:59:59Z",date:"2026-11-01"}]){
      const f=await fixture(),date=spec.date??"2026-11-14";
      const day=await candidate(f,f.a,{allDay:true,start:date+"T00:00:00Z",end:null,zone:spec.zone});
      const canonical=await graduate(day);await sync(day);
      assert.equal(await link(await candidate(f,f.b,spec)),canonical);
    }
  });

  await t.test("ambiguous all-day records enter review without retracting timed shows",async()=>{
    const f=await fixture(),a=await candidate(f,f.a),b=await candidate(f,f.b,{start:"2026-11-14T20:00:00Z",end:"2026-11-14T23:00:00Z"});
    await graduate(a);await sync(a);await graduate(b);await sync(b);
    const day=await candidate(f,f.c,allDay);assert.equal(await graduate(day),"");
    assert.equal(await sql(`select status from public.event_harvest_candidates where id=${quote(day)};`),"needs_review");
    assert.equal(await sql(`select count(*) from public.events where venue_id=${quote(f.venue)} and status='published';`),"2");
  });

  await t.test("unprivileged callers cannot run merge maintenance",async()=>{
    assert.equal(await sql("select has_function_privilege('anon','public.merge_event_harvest_duplicate(uuid,uuid)','execute');"),"f");
    assert.equal(await sql("select has_function_privilege('authenticated','public.reconcile_event_harvest_duplicates(uuid,text)','execute');"),"f");
  });

  await t.test("bootstrap obeys the same identity and timing precedence",async()=>{
    const f=await fixture(),day=await candidate(f,f.a,allDay),timed=await candidate(f,f.b);
    const canonical=await sql(`select public.bootstrap_first_party_harvest_candidate(${quote(day)});`);
    assert.equal(await sql(`select public.bootstrap_first_party_harvest_candidate(${quote(timed)});`),canonical);
    assert.equal(await sql(`select is_all_day from public.events where id=${quote(canonical)};`),"f");
    assert.equal(await sql(`select count(*) from public.notification_events where source_id=${quote(canonical)};`),"1");
  });

  await t.test("one source disappearing cannot cancel another source's confirmed occurrence",async()=>{
    const f=await fixture(),day=await candidate(f,f.a,{allDay:true,start:"2099-01-10T00:00:00Z",end:"2099-01-11T00:00:00Z"}),
      timed=await candidate(f,f.b,{start:"2099-01-10T05:00:00Z",end:"2099-01-11T04:59:59Z"});
    const canonical=await graduate(day);await sync(day);assert.equal(await link(timed),canonical);await sync(timed);
    await sql(`update public.event_harvest_candidates set last_seen_at=now()-interval '1 hour' where venue_id=${quote(f.venue)};`);
    for(let i=0;i<2;i++)await sql(`select * from public.reconcile_first_party_source_absences(${quote(f.a)},now());`);
    assert.equal(await sql(`select status from public.events where id=${quote(canonical)};`),"published");
    for(let i=0;i<2;i++)await sql(`select * from public.reconcile_first_party_source_absences(${quote(f.b)},now());`);
    assert.equal(await sql(`select status from public.events where id=${quote(canonical)};`),"cancelled");
  });

  async function legacyPair(f) {
    const day=await candidate(f,f.a,allDay),timed=await candidate(f,f.b);
    const oldId=randomUUID(),keepId=randomUUID();
    await sql(`insert into public.events(id,venue_id,title,starts_at,ends_at,is_all_day,status)
      values (${quote(oldId)},${quote(f.venue)},'Community event','2026-11-14T00:00:00Z','2026-11-15T00:00:00Z',true,'published'),
      (${quote(keepId)},${quote(f.venue)},'Community event','2026-11-14T05:00:00Z','2026-11-15T04:59:59Z',false,'published');
      update public.event_harvest_candidates set canonical_event_id=${quote(oldId)},status='published' where id=${quote(day)};
      update public.event_harvest_candidates set canonical_event_id=${quote(keepId)},status='published' where id=${quote(timed)};
      insert into public.event_source_links(event_id,source_id,candidate_id,external_event_id)
        values (${quote(oldId)},${quote(f.a)},${quote(day)},${quote(day)}),(${quote(keepId)},${quote(f.b)},${quote(timed)},${quote(timed)});`);
    return {day,timed,oldId,keepId};
  }
  await t.test("reconciliation retains timing, provenance, reminders, history and old event links",async()=>{
    const f=await fixture(),p=await legacyPair(f),reminder=randomUUID(),delivery=randomUUID();
    await sql(`insert into public.event_reminders(id,event_id,email,wants_email) values
      (${quote(reminder)},${quote(p.oldId)},'fan@example.com',true);
      insert into public.notification_deliveries(id,reminder_id,status) values (${quote(delivery)},${quote(reminder)},'sent');
      insert into public.notification_events(entity_kind,venue_id,event_type,source_kind,source_id,status)
      values ('venue',${quote(f.venue)},'spot.event_published','event',${quote(p.oldId)},'pending');`);
    const counts=await json(`select public.reconcile_event_harvest_duplicates(${quote(f.venue)},'America/New_York');`);
    assert.equal(counts.merged_events,1);assert.equal(counts.skipped_groups,0);
    assert.equal(await sql(`select event_id from public.event_reminders where id=${quote(reminder)};`),p.keepId);
    assert.equal(await sql(`select count(*) from public.notification_deliveries where id=${quote(delivery)};`),"1");
    assert.equal(await sql(`select public.resolve_published_event_id(${quote(p.oldId)});`),p.keepId);
    assert.equal(await sql(`select count(*) from public.event_source_links where event_id=${quote(p.keepId)};`),"2");
    assert.equal(await sql(`select status from public.notification_events where source_id=${quote(p.oldId)};`),"suppressed");
    await sync(p.day);assert.equal(await sql(`select is_all_day from public.events where id=${quote(p.keepId)};`),"f");
    assert.equal((await json(`select public.reconcile_event_harvest_duplicates(${quote(f.venue)},'America/New_York');`)).merged_events,0);
    await sql(`update public.events set status='published' where id=${quote(p.oldId)};`);
    assert.equal(await sql(`select status from public.events where id=${quote(p.oldId)};`),"cancelled");
  });

  await t.test("overlapping reminder identities preserve both records and defer reconciliation",async()=>{
    const f=await fixture(),p=await legacyPair(f),a=randomUUID(),b=randomUUID(),delivery=randomUUID();
    await sql(`insert into public.event_reminders(id,event_id,email,wants_email,status) values
      (${quote(a)},${quote(p.oldId)},'fan@example.com',true,'sent'),(${quote(b)},${quote(p.keepId)},'FAN@example.com',true,'active');
      insert into public.notification_deliveries(id,reminder_id,status) values (${quote(delivery)},${quote(a)},'sent');`);
    assert.equal((await json(`select public.reconcile_event_harvest_duplicates(${quote(f.venue)},'America/New_York');`)).merged_events,0);
    assert.equal(await sql(`select status from public.event_reminders where id=${quote(a)};`),"sent");
    assert.equal(await sql(`select status from public.event_reminders where id=${quote(b)};`),"active");
    assert.equal(await sql(`select count(*) from public.notification_deliveries where id=${quote(delivery)};`),"1");
  });

  await t.test("legacy doubles cannot create a third canonical while awaiting reconciliation",async()=>{
    const f=await fixture();await legacyPair(f);const incoming=await candidate(f,f.c);
    assert.equal(await graduate(incoming),"");
    assert.equal(await sql(`select status from public.event_harvest_candidates where id=${quote(incoming)};`),"needs_review");
    assert.equal(await sql(`select count(*) from public.events where venue_id=${quote(f.venue)};`),"2");
  });

  await t.test("maintenance command derives geography and reconciles with the actual SQL functions",async()=>{
    const f=await fixture(),p=await legacyPair(f);
    await sql(`update public.venues set latitude=27.77,longitude=-82.64 where id=${quote(f.venue)};`);
    await sql(`grant usage on schema public to tf_event_readonly;
      grant select on all tables in schema public to tf_event_readonly;`);
    assert.equal(await sql(`select has_function_privilege('tf_event_readonly',
      'public.event_harvest_occurrence_url(public.event_harvest_candidates)','execute');`),"f");
    await assert.rejects(sql(`begin read only; set local role tf_event_readonly;
      select public.event_harvest_occurrence_url(c) from public.event_harvest_candidates c limit 1;`),
      /permission denied for function event_harvest_occurrence_url/);
    const result=await reconcileEventDuplicates(async (statement,{readOnly=false}={})=>{
      const query=readOnly?`begin read only; set local role tf_event_readonly; ${statement} commit;`:statement;
      return (await json(query)).__tf_event_maintenance__;
    });
    assert.equal(result.merged_events,1);
    assert.equal(await sql(`select public.resolve_published_event_id(${quote(p.oldId)});`),p.keepId);
  });

  await t.test("reconciliation preserves in-progress source executions and retries after release",async()=>{
    const f=await fixture(),p=await legacyPair(f);
    const token=await sql(`select public.claim_first_party_source_execution(${quote(f.a)});`);
    const first=await json(`select public.reconcile_event_harvest_duplicates(${quote(f.venue)},'America/New_York');`);
    assert.equal(first.merged_events,0);assert.equal(first.deferred_venues,1);
    assert.equal(await sql(`select canonical_event_id from public.event_harvest_candidates where id=${quote(p.day)};`),p.oldId);
    assert.equal(await sql(`select execution_token from public.first_party_source_executions where source_id=${quote(f.a)};`),token);
    await sql(`select public.release_first_party_source_execution(${quote(f.a)},${quote(token)});`);
    assert.equal((await json(`select public.reconcile_event_harvest_duplicates(${quote(f.venue)},'America/New_York');`)).merged_events,1);
  });

  await t.test("in-flight delivery and incompatible reminder choices defer the merge",async()=>{
    for(const kind of ['delivery','preferences']){
      const f=await fixture(),p=await legacyPair(f),id=randomUUID();
      await sql(`insert into public.event_reminders(id,event_id,email,wants_email) values (${quote(id)},${quote(p.oldId)},'fan@example.com',true);`);
      if(kind==='delivery')await sql(`insert into public.notification_deliveries(reminder_id,status)values(${quote(id)},'processing');`);
      else await sql(`insert into public.event_reminders(event_id,email,wants_email,wants_sms,phone_e164)
        values (${quote(p.keepId)},'fan@example.com',true,true,'+15555550101');`);
      const result=await json(`select public.reconcile_event_harvest_duplicates(${quote(f.venue)},'America/New_York');`);
      assert.equal(result.merged_events,0);assert.equal(result.skipped_groups,1);
    }
  });
});
