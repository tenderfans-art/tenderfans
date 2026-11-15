import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
const read = file => readFileSync(file,"utf8");
const compile = source => ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const module = {exports:{}};
new Function("exports",compile(read("lib/event-harvester/market-workflow-recovery.ts")))(module.exports);
const {loadSharedWorkflowReconciliationRuns:load}=module.exports;

test("recovery loads closed orphan candidates through the bounded RPC",async()=>{
  const result={data:[{id:"closed",workflow_run_id:"run",reserved_at:"2026-11-15T01:15:00Z"}],error:null};
  assert.equal(await load({rpc:async(name,args)=>{assert.equal(name,"list_refilling_market_runs_to_reconcile");assert.equal(args.p_limit,32);return result;},from(){assert.fail("no fallback");}}),result);
});
for(const code of ['PGRST202','42883'])test(`rollout fallback remains available for ${code}`,async()=>{
  const calls=[],result={data:[],error:null};
  const q={select(...a){calls.push(['select',...a]);return q;},in(...a){calls.push(['in',...a]);return q;},not(){return q;},order(){return q;},limit(n){assert.equal(n,32);return Promise.resolve(result);}};
  assert.equal(await load({rpc:async()=>({error:{code}}),from:()=>q}),result);
  assert.ok(calls.some(c=>c[0]==='in'&&c[2].join(',')==='reserved,claimed'));
});
test("permission and other database errors are never hidden by rollout fallback",async()=>{
  const result={data:null,error:{code:"42501",message:"denied"}};
  assert.equal(await load({rpc:async()=>result,from(){assert.fail("must preserve error");}}),result);
});
test("migration 129 selection remains available during the next schema rollout",async()=>{
  const calls=[],result={data:[],error:null};
  assert.equal(await load({async rpc(name){calls.push(name);return calls.length===1?{error:{code:'PGRST202'}}:result;}}),result);
  assert.deepEqual(calls,['list_refilling_market_runs_to_reconcile','list_shared_harvester_runs_to_reconcile']);
});

const route=read("app/api/jobs/shared-market-dispatch/route.ts");
const start=route.indexOf("  let terminalRunsSettled = 0;");
const end=route.indexOf("\n  if (terminalRunsSettled > 0)",start);
assert.ok(start>=0&&end>start);
const policy={exports:{}};
new Function("exports",compile(read("lib/event-harvester/market-workflow-policy.ts")))(policy.exports);
const clock=Date.parse("2030-01-01T12:00:00Z");
class Clock extends Date {static now(){return clock;}}
function harness(status,{age=180,afterCancel=status,statusError=false,settlementError=false,continuous=false,deadline=null}={}){
  const calls=[];let current=status;
  const getRun=id=>({get status(){calls.push(['status',id]);return statusError?Promise.reject(Error("provider unavailable")):Promise.resolve(current);},async cancel(){calls.push(['cancel',id]);current=afterCancel;}});
  const db={async rpc(name,args){calls.push(['settle',name,args]);return settlementError?{data:null,error:{message:"database unavailable"}}:{data:1,error:null};}};
  const refillCheck=async()=>{calls.push(['refill-check']);return deadline;};
  const run=new Function("supabase","getRun","marketWorkflowTiming","console","Date","refillingMarketCancellationAt",compile(
    `return async function(liveRuns){${route.slice(start,end)}\nreturn terminalRunsSettled;};`
  ))(db,getRun,policy.exports.marketWorkflowTiming,{error(){},warn(){},info(){}},Clock,refillCheck);
  return {calls,run:()=>run([{id:"reservation",workflow_run_id:"run",work_type:continuous?'market_scan':'detect_spot',reserved_at:new Date(clock-age*60000).toISOString()}])};
}
test("completed orphan runs are authoritatively checked before settlement",async()=>{
  const h=harness("completed");assert.equal(await h.run(),1);
  assert.deepEqual(h.calls.map(c=>c[0]),['status','settle']);
  assert.equal(h.calls[1][2].p_terminal_status,"completed");
});
test("an in-budget running Workflow is never settled",async()=>{
  const h=harness("running",{age:10});assert.equal(await h.run(),0);assert.deepEqual(h.calls.map(c=>c[0]),['status']);
});
test("deadline cancellation still requires confirmed terminal status",async()=>{
  const pending=harness("running");assert.equal(await pending.run(),0);
  assert.deepEqual(pending.calls.map(c=>c[0]),['status','cancel','status']);
  const stopped=harness("running",{afterCancel:"cancelled"});assert.equal(await stopped.run(),1);
  assert.equal(stopped.calls.at(-1)[2].p_terminal_status,"cancelled");
});
test("an unavailable provider status preserves ownership",async()=>{
  const h=harness("running",{statusError:true});assert.equal(await h.run(),0);assert.deepEqual(h.calls.map(c=>c[0]),['status']);
});
test("settlement failures remain visible to the dispatcher",async()=>{
  const h=harness("completed",{settlementError:true});assert.equal((await h.run()).status,503);
});
test("a healthy continuously refilling run survives the old 55-minute boundary",async()=>{
  const h=harness('running',{continuous:true,age:180});assert.equal(await h.run(),0);
  assert.deepEqual(h.calls.map(c=>c[0]),['status','refill-check']);
});
test("a sealed run waits for every current budget and verifies cancellation before settlement",async()=>{
  const future=harness('running',{continuous:true,deadline:clock+60000});assert.equal(await future.run(),0);
  assert.deepEqual(future.calls.map(c=>c[0]),['status','refill-check']);
  const due=harness('running',{continuous:true,deadline:clock-1,afterCancel:'cancelled'});assert.equal(await due.run(),1);
  assert.deepEqual(due.calls.map(c=>c[0]),['status','refill-check','cancel','status','settle']);
});
