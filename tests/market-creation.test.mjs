import assert from 'node:assert/strict';
import test from 'node:test';
import { typescriptLoader } from './helpers/typescript-loader.mjs';

const {countyMarketIdentity,isMarketTimezone}=typescriptLoader()('lib/market-creation.ts');
test('county supplies the Market display name and URL key',()=>{
  assert.deepEqual(countyMarketIdentity('  Hillsborough   County  '),{
    name:'Hillsborough County',key:'hillsborough-county',
  });
  assert.equal(isMarketTimezone('America/New_York'),true);
  assert.equal(isMarketTimezone('America/Chicago'),true);
  for(const value of [undefined,null,{},'', 'not-a-timezone']) assert.equal(isMarketTimezone(value),false);
});

function harness({admin=true,rpcError=null}={}) {
  const calls=[];
  const row={id:'00000000-0000-4000-8000-000000000001',market_key:'hillsborough-county',
    display_name:'Hillsborough County',is_enabled:false};
  const db={
    from(table){
      const query={select(){return query;},eq(){return query;},
        async maybeSingle(){return {data:admin?{user_id:'admin'}:null,error:null};},
        async single(){assert.equal(table,'event_processing_markets');return {data:row,error:null};},
      };return query;
    },
    async rpc(name,args){calls.push({name,args});return {data:rpcError?null:row.id,error:rpcError};},
  };
  const load=typescriptLoader({
    'next/server':{NextResponse:{json:(body,options={})=>({body,status:options.status??200})}},
    '@supabase/supabase-js':{createClient(_url,key){return key==='anon'
      ?{auth:{getUser:async()=>({data:{user:{id:'admin'}},error:null})}}:db;}},
  },source=>source.replaceAll('process.env.NEXT_PUBLIC_SUPABASE_URL','"https://db.example"')
    .replaceAll('process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY','"anon"')
    .replaceAll('process.env.SUPABASE_SECRET_KEY','"service"'));
  const {POST}=load('app/api/admin/markets/route.ts');
  return {calls,post:body=>POST(new Request('https://tf.example/api/admin/markets',{
    method:'POST',headers:{authorization:'Bearer session','content-type':'application/json'},
    body:JSON.stringify(body),
  }))};
}
const input={action:'create',countyName:'Hillsborough County',stateRegion:'FL',scheduleTimezone:'America/New_York'};
test('admin creation derives identity once and submits the explicit local schedule zone',async()=>{
  const h=harness();
  const response=await h.post({...input,countyName:' Hillsborough   County ',stateRegion:' fl ',
    name:'Unrelated label',key:'different-key',is_enabled:true,max_concurrent_sources:128});
  assert.equal(response.status,200);
  assert.equal(response.body.market.is_enabled,false);
  assert.deepEqual(h.calls,[{name:'create_market_with_county',args:{
    p_name:'Hillsborough County',p_key:'hillsborough-county',p_country_code:'US',p_state_region:'FL',
    p_county_name:'Hillsborough County',p_schedule_timezone:'America/New_York',
  }}]);
});
test('invalid county, state or schedule zone never reaches creation',async()=>{
  for(const fields of [{countyName:''},{countyName:{}},{countyName:'x'.repeat(101)},
    {stateRegion:'Florida'},{scheduleTimezone:'not-a-timezone'},{scheduleTimezone:undefined}]) {
    const h=harness();assert.equal((await h.post({...input,...fields})).status,400);
    assert.deepEqual(h.calls,[]);
  }
});
test('creation retains administrator access checks and atomic duplicate errors',async()=>{
  const denied=harness({admin:false});assert.equal((await denied.post(input)).status,403);
  assert.deepEqual(denied.calls,[]);
  const duplicate=harness({rpcError:{code:'23505'}});
  const response=await duplicate.post(input);
  assert.equal(response.status,400);assert.match(response.body.error,/already assigned/);
});
