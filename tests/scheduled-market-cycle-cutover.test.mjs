import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(p,'utf8');
const sql=read('supabase/migrations/125_scheduled_market_cycle_cutover.sql');
const dispatch=read('app/api/jobs/shared-market-dispatch/route.ts');
const admin=read('app/api/admin/markets/route.ts');
const cron=JSON.parse(read('vercel.json'));

test('atomic dormant migration with explicit activation only',()=>{
  assert.match(sql,/^begin;/m);
  assert.match(sql,/^commit;/m);
  assert.match(sql,/Unexpected already-active scheduled Market/);
  assert.doesNotMatch(sql,/set\s+schedule_enabled\s*=\s*true\s*where\s+market_key/i);
  assert.match(sql,/activate_market_daily_schedule/);
});
test('local daily schedule avoids hardcoded UTC intervals',()=>{
  assert.match(sql,/at time zone p_zone/);
  assert.match(sql,/next_market_schedule_after/);
  assert.doesNotMatch(sql,/interval\s+'24 hours'/);
});
test('only due Markets, without unfinished jobs or reservations, start',()=>{
  assert.match(sql,/next_scheduled_at <= clock_timestamp\(\)/);
  assert.match(sql,/status='running'/);
  assert.match(sql,/status in \('pending','retry','leased'\)/);
  assert.match(sql,/status in \('reserved','claimed'\)/);
  assert.match(sql,/for update of em skip locked/);
});
test('all four work types queued exactly once, no silent omitted work',()=>{
  for(const kind of ['detect_spot','harvest_source','archive_recheck','harvest_provider'])
    assert.match(sql,new RegExp(`'${kind}'`));
  assert.match(sql,/v_inserted<>v_expected/);
  assert.match(sql,/incomplete cohort/);
  assert.match(sql,/market_cycle_id/);
  assert.match(sql,/venue_id is null/);
  assert.match(sql,/a.next_check_at<=v_now/);
});
test('original queue functions reused but scheduled Markets excluded',()=>{
  assert.match(sql,/create or replace function public.enqueue_due_market_processing/);
  assert.match(sql,/create or replace function public.enqueue_due_market_supplemental_processing/);
  assert.equal((sql.match(/and schedule_enabled = false/g)||[]).length,2);
  assert.match(dispatch,/"enqueue_due_market_processing"/);
  assert.match(dispatch,/"enqueue_due_market_supplemental_processing"/);
});
test('settlement does not expire live leases or cancel eligible work',()=>{
  assert.match(sql,/reconcile_running_market_cycles/);
  assert.match(sql,/finished_at=clock_timestamp\(\)/);
  assert.doesNotMatch(sql,/status='cancelled'/);
  assert.doesNotMatch(sql,/delete from public.event_processing_work/i);
  assert.doesNotMatch(sql,/truncate\s+/i);
});
test('original shared admission/recovery and workflow retained',()=>{
  assert.match(dispatch,/"recover_expired_market_source_executions"/);
  assert.match(dispatch,/"settle_terminal_shared_harvester_run"/);
  assert.match(dispatch,/"reconcile_shared_harvester_reservations"/);
  assert.match(dispatch,/"reserve_shared_harvester_batch"/);
  assert.match(dispatch,/start\(marketHarvesterWorkflow/);
  assert.match(dispatch,/"start_due_market_cycles"/);
  assert.match(dispatch,/"reconcile_running_market_cycles"/);
});
test('Admin Enable uses scheduled Market with shared dispatcher cron',()=>{
  assert.match(admin,/"set_market_processing_enabled"/);
  assert.match(sql,/max_concurrent_batches|No changes to worker/i);
  assert.deepEqual(cron.crons,[{path:"/api/jobs/shared-market-dispatch",schedule:"*/5 * * * *"}]);
  assert.ok(cron.crons.some(x=>x.path==='/api/jobs/shared-market-dispatch'));
});
