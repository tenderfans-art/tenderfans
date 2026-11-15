import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function load(file,require=()=>{throw Error('Unexpected import');}){const exports={};new Function('exports','require',compile(readFileSync(file,'utf8')))(exports,require);return exports;}
const refill=load('lib/event-harvester/market-workflow-refill.ts');
const policy=load('lib/event-harvester/market-workflow-policy.ts');
const result={claimed:1,completed:1,failed:0,deferred:0};
function harness(items,{onExecute,onClaim,onSleep,finalize=false}={}){
  const h={queue:[...items],claims:[],routes:[],sleeps:[],snapshots:new Map(),active:0,peak:0,done:0,finalized:0};
  const execute=route=>async(_db,item)=>{
    h.routes.push([route,item.work_id]);h.active++;h.peak=Math.max(h.peak,h.active);
    try{await onExecute?.(item,h);h.done++;return {...result};}finally{h.active--;}
  };
  const db={async rpc(name,args){
    if(name==='bind_shared_harvester_workflow_run')return {data:true,error:null};
    if(name==='finalize_shared_harvester_reservation'){h.finalized++;return {data:!finalize,error:null};}
    assert.equal(name,'claim_refilling_market_assignment');
    h.claims.push(args.p_slot_number);if(h.claims.length>1000)throw Error('Unexpected endless test polling');
    const key=args.p_slot_number;
    if(h.snapshots.has(key))return {data:h.snapshots.get(key),error:null};
    const decision=onClaim?.(h,args)??(h.queue.length?{kind:'work',item:h.queue.shift()}:h.active?{kind:'wait',delay_ms:60000}:{kind:'stop'});
    if(decision.kind==='work')h.snapshots.set(key,decision);
    return {data:decision,error:null};
  }};
  const require=name=>{
    if(name==='workflow')return {getWorkflowMetadata:()=>({workflowRunId:'run'}),getStepMetadata:()=>({stepId:'step',attempt:1}),
      sleep:async ms=>{h.sleeps.push(ms);await onSleep?.(h);await new Promise(setImmediate);}};
    if(name==='@supabase/supabase-js')return {createClient:()=>db};
    if(name.endsWith('/market-workflow-policy'))return policy;
    if(name.endsWith('/market-workflow-refill'))return refill;
    if(name.endsWith('/market-scheduler-diagnostics'))return {withMarketSchedulerDiagnostics:(_id,operation)=>operation()};
    if(name.endsWith('/market-facebook-inventory'))return {runWithMarketFacebookInventory:(_db,_id,_token,operation)=>operation()};
    if(name.endsWith('/market-detector-executor'))return {executeMarketDetectorWorkItem:execute('detect_spot')};
    if(name.endsWith('/market-batch-executor'))return {executeMarketHarvesterWorkItem:execute('harvest_source')};
    if(name.endsWith('/market-supplemental-executor'))return {executeMarketSupplementalWorkItem:async(db,market,mode,item)=>execute(mode)(db,item)};
    throw Error('Unexpected import: '+name);
  };
  const exports={};
  new Function('exports','require','process','console',compile(readFileSync('workflows/market-harvester.ts','utf8')))(exports,require,
    {env:{NEXT_PUBLIC_SUPABASE_URL:'https://test.invalid',SUPABASE_SECRET_KEY:'test'}},{error(){}});
  h.run=()=>exports.marketHarvesterWorkflow('market','reservation','market',8);
  return h;
}
const item=(id,type='detect_spot')=>({work_id:String(id),claimed_work_type:type,claimed_lease_token:'token-'+id,
  claimed_leased_until:'2030-01-01T12:30:00Z',claimed_venue_id:['detect_spot','archive_recheck'].includes(type)?'venue':null,
  claimed_source_id:type==='harvest_source'?'source':null});

test('fast lanes process beyond their former quota while another lane remains busy',{timeout:5000},async()=>{
  let release;const held=new Promise(resolve=>release=resolve);let fastDone=0;
  const h=harness([item('slow'),...Array.from({length:80},(_,i)=>item(i))],{
    async onExecute(work){if(work.work_id==='slow')await held;else if(++fastDone===80)release();}
  });
  const outcome=await h.run();assert.equal(outcome.completed,81);assert.equal(fastDone,80);
  assert.equal(h.peak,8);assert.equal(h.finalized,1);assert.ok(h.claims.some(slot=>slot>=64));
  assert.equal(new Set(h.claims).size,h.claims.length);
});
test('a waiting lane survives temporary no-work decisions and uses the original executor for every type',async()=>{
  let wait=true;
  const h=harness([item(1,'harvest_source'),item(2,'detect_spot'),item(3,'archive_recheck'),item(4,'harvest_provider')],{
    onClaim(){if(wait){wait=false;return {kind:'wait',delay_ms:60000};}}
  });
  assert.equal((await h.run()).completed,4);assert.ok(h.sleeps.length>0);
  assert.deepEqual(h.routes.map(x=>x[0]).sort(),['archive','detect_spot','harvest_source','provider']);
});
test('an unexpected lane failure waits for other original executions and preserves the original error',async()=>{
  const h=harness(Array.from({length:20},(_,i)=>item(i)),{finalize:true,
    onExecute(work){if(work.work_id==='0')throw Error('Original executor failure');}});
  await assert.rejects(h.run(),/Original executor failure/);assert.equal(h.done,19);assert.equal(h.active,0);assert.equal(h.finalized,1);
});
test('malformed instructions cannot invent work or create zero-delay polling',()=>{
  for(const value of [null,{}, {kind:'wait',delay_ms:0},{kind:'wait',delay_ms:60001},{kind:'work',item:item(1,'unknown')}])
    assert.throws(()=>refill.parseRefillInstruction(value),/Invalid refill response/);
});
test('refill preparation uses the old protocol only while its migration RPC is absent',async()=>{
  for(const code of ['PGRST202','42883'])assert.equal(await refill.prepareSharedMarketRefill({rpc:async()=>({error:{code}})},'reservation'),false);
  assert.equal(await refill.prepareSharedMarketRefill({rpc:async()=>({data:true,error:null})},'reservation'),true);
  await assert.rejects(refill.prepareSharedMarketRefill({rpc:async()=>({error:{code:'42501'}})},'reservation'),/preparation failed/);
});
test('continuous recovery accepts a healthy null result and validates sealed deadlines',async()=>{
  assert.equal(await refill.refillingMarketCancellationAt({rpc:async()=>({data:null,error:null})},'reservation','run'),null);
  const deadline='2030-01-01T12:30:00Z';
  assert.equal(await refill.refillingMarketCancellationAt({rpc:async()=>({data:deadline,error:null})},'reservation','run'),Date.parse(deadline));
  await assert.rejects(refill.refillingMarketCancellationAt({rpc:async()=>({data:'invalid',error:null})},'reservation','run'),/Invalid/);
});
