'use strict';
// Isolated synthetic upgrade proof. Historical receipts remain queryable as written.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
(async()=>{
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite(),fresh=new PGlite();
 try{
  for(const d of [db,fresh])await d.exec(read('tests/campaign-provider-schema.sql'));
  for(const f of ['tests/fixtures/campaign-store-pre-audience.sql','tests/fixtures/campaign-provider-pre-audience.sql','n8n/growth/campaign-write-guard.sql'])await db.exec(read(f));
  for(const f of ['tests/fixtures/campaign-store-pre-recovery.sql','tests/fixtures/campaign-provider-pre-recovery.sql','n8n/growth/campaign-write-guard.sql'])await fresh.exec(read(f));
  const query=async(sql,p=[])=>(await db.query(sql,p)).rows;
  const call=async(a,p)=>(await query('SELECT shrigma_campaign_store($1,$2::jsonb) AS r',[a,JSON.stringify(p)]))[0].r;
  const c=(await query('SELECT shrigma_campaign_current(100) AS r'))[0].r;
  const legacy={policy:'crm-campaign-v1',version:c.version,ok:true,validated_at:new Date().toISOString()};
  await call('validation_set',{providerId:100,validation:legacy});
  for(const state of ['pending','succeeded','outcome_unknown']){
   const op=await call('claim',{actor:'legacy',key:'legacy-operation-'+state,hash:'a'.repeat(64),brand:'fish',action:'agendar'});
   if(state!=='pending')await call('finish',{id:op.id,lease:op.lease,providerId:100,state,response:{status:state==='succeeded'?200:502,body:state==='succeeded'?{campaign:c,operation_id:op.id}:{code:'OUTCOME_UNKNOWN',operation_id:op.id}}});
  }
  const snapshot=async()=>({ops:await query('SELECT * FROM shrigma_campaign_operation ORDER BY operation_key'),reviews:await query('SELECT * FROM shrigma_campaign_validation'),guards:await query('SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname'),campaigns:await query('SELECT * FROM campaigns ORDER BY id')});
  const before=await snapshot(),migration=read('n8n/growth/campaign-audience.sql');
  await db.exec(migration);await db.exec(migration);assert.deepEqual(await snapshot(),before);
  const bodies=d=>d.query("SELECT proname,prosrc,provolatile,prosecdef,proconfig,proacl FROM pg_proc WHERE proname IN ('shrigma_campaign_store','shrigma_campaign_provider','shrigma_campaign_audience') ORDER BY proname");
  assert.deepEqual((await bodies(db)).rows,(await bodies(fresh)).rows);
  assert.deepEqual(await call('validation_get',{providerId:100}),legacy);
  for(const op of before.ops){const readback=await call('get',{actor:'legacy',key:op.operation_key});assert.deepEqual(readback.response,op.response);assert.equal(readback.state,op.state);assert.equal('lease' in readback,false);}
  const op=await call('claim',{actor:'after-upgrade',key:'legacy-review-rejected-01',hash:'b'.repeat(64),brand:'fish',action:'agendar'});
  await db.exec("INSERT INTO crm_familia_campanha VALUES('fish','week','week')");
  await assert.rejects(db.query("SELECT shrigma_campaign_provider('schedule',$1::jsonb)",[JSON.stringify({id:100,expectedVersion:c.version,operationId:op.id})]),/AUDIENCE_REVIEW_REQUIRED/);
  assert.equal((await query('SELECT status FROM campaigns WHERE id=100'))[0].status,'draft');
  // Drift aborts the whole upgrade before replacing any routine or touching an audit row.
  await db.exec("CREATE OR REPLACE FUNCTION public.shrigma_campaign_provider(a text,p jsonb) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$");
  const driftBodies=(await bodies(db)).rows,driftData=await snapshot();
  await assert.rejects(db.exec(migration),/AUDIENCE_PROVIDER_DRIFT/);await db.exec('ROLLBACK');
  assert.deepEqual((await bodies(db)).rows,driftBodies);assert.deepEqual(await snapshot(),driftData);
  console.log('PASS audience migration: old/new exact bodies, idempotence, guards/audit/campaign preservation, legacy receipt reads, new schedule rejection and atomic drift refusal.');
 }finally{await db.close();await fresh.close();}
})().catch(e=>{console.error(e.message,e.where||'');process.exitCode=1;});
