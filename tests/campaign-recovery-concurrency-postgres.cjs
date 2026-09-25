'use strict';
// Disposable CI database only. Independent connections; never invokes Listmonk.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{Client}=require('pg');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8'),raw=process.env.TEST_DATABASE_URL;
let target;try{target=new URL(raw);}catch{}
if(process.env.CAMPAIGN_TEST_DATABASE_ISOLATED!=='1'||!target||!['localhost','127.0.0.1'].includes(target.hostname)||target.pathname!=='/campaign_recovery_test'||target.username!=='synthetic'||target.password)throw Error('Requires disposable localhost campaign_recovery_test with synthetic user.');
(async()=>{
 const clients=['recovery-owner','recovery-worker','recovery-observer'].map(application_name=>new Client({connectionString:raw,application_name}));
 await Promise.all(clients.map(c=>c.connect()));const [a,b,c]=clients;
 try{
  assert.equal((await a.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0,'refuse a populated database');
  for(const f of ['tests/campaign-provider-schema.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-recovery.sql','n8n/growth/campaign-provider.sql','n8n/growth/campaign-write-guard.sql'])await a.query(read(f));
  let counter=0;
  const call=async(client,action,p)=>(await client.query('SELECT shrigma_campaign_store($1,$2::jsonb) r',[action,JSON.stringify(p)])).rows[0].r;
  const claim=(client,action)=>call(client,'claim',{actor:'synthetic-manager',key:'concurrency-key-'+(++counter),hash:'a'.repeat(64),brand:'fish',action});
  const source=await claim(a,'salvar');
  await a.query('BEGIN');await a.query("SELECT set_config('shrigma.campaign_writer','100',true)");await a.query("UPDATE campaigns SET send_at=NULL,attribs=jsonb_set(attribs,'{crm,created_operation_id}',to_jsonb($1::text)) WHERE id=100",[source.id]);await a.query('COMMIT');
  await call(a,'finish',{id:source.id,lease:source.lease,providerId:100,state:'outcome_unknown',response:{status:502,body:{error:'OUTCOME_UNKNOWN',operation_id:source.id,provider_id:100}}});
  const sourceBefore=(await a.query('SELECT to_jsonb(o) row FROM shrigma_campaign_operation o WHERE id=$1',[source.id])).rows[0].row;
  const current=async()=>(await c.query('SELECT shrigma_campaign_current(100) r')).rows[0].r;
  const recover=(client,op,version)=>client.query("SELECT shrigma_campaign_provider('recover',$1::jsonb) r",[JSON.stringify({id:100,sourceOperationId:source.id,operationId:op.id,expectedVersion:version})]);
  async function blocked(){for(let i=0;i<100;i++){if((await c.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='recovery-worker' AND wait_event_type='Lock'")).rows[0].n)return;await new Promise(r=>setTimeout(r,20));}throw Error('Worker did not wait on independent lock');}
  // A confirmed proof is advisory. A campaign change committed while waiting must fail CAS.
  let version=(await current()).version,op=await claim(a,'recuperar');
  await a.query('BEGIN');await a.query('SELECT id FROM campaigns WHERE id=100 FOR UPDATE');
  let pending=recover(b,op,version).then(value=>({value}),error=>({error}));await blocked();
  await a.query("SELECT set_config('shrigma.campaign_writer','100',true)");await a.query("UPDATE campaigns SET name=name||' changed' WHERE id=100");await a.query('COMMIT');
  assert.equal((await pending).error?.message,'VERSION_CONFLICT');assert.equal((await c.query('SELECT count(*)::int n FROM shrigma_campaign_recovery_receipt')).rows[0].n,0);
  // Two keys, one source: the source row serializes recovery ownership.
  version=(await current()).version;const first=await claim(a,'recuperar'),second=await claim(a,'recuperar');const campaignBefore=await current();
  await a.query('BEGIN');const result=(await recover(a,first,version)).rows[0].r;
  pending=recover(b,second,version).then(value=>({value}),error=>({error}));await blocked();await a.query('COMMIT');
  assert.equal((await pending).error?.message,'RECOVERY_ALREADY_CLAIMED');assert.equal((await c.query('SELECT count(*)::int n FROM shrigma_campaign_recovery_receipt')).rows[0].n,1);
  assert.deepEqual(await current(),campaignBefore);
  assert.deepEqual((await c.query('SELECT to_jsonb(o) row FROM shrigma_campaign_operation o WHERE id=$1',[source.id])).rows[0].row,sourceBefore);
  // Simulate a lost post-commit transport response: only the durable operation is read.
  const receipt=(await c.query('SELECT state,response,provider_id FROM shrigma_campaign_operation WHERE id=$1',[first.id])).rows[0];
  assert.equal(receipt.state,'succeeded');assert.deepEqual(receipt.response.body,result);assert.equal(receipt.provider_id,100);
  await call(c,'finish',{id:first.id,lease:first.lease,providerId:100,state:'succeeded',response:receipt.response});
  const replay=await call(c,'claim',{actor:'synthetic-manager',key:'concurrency-key-'+(counter-1),hash:'a'.repeat(64),brand:'fish',action:'recuperar'});assert.equal(replay.acquired,false);assert.deepEqual(replay.response,receipt.response);
  assert.equal((await current()).status,'draft');assert.equal((await current()).sent,0);
  console.log('PASS recovery independent sessions: stale-version race refuses, two keys recover once, atomic receipt survives response loss, original receipt/campaign unchanged. No transport.');
 }finally{await Promise.allSettled(clients.map(c=>c.end()));}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
