'use strict';
// Disposable PostgreSQL engine. No transport, live credentials or addresses.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
(async()=>{
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite();
 try{
  for(const file of ['tests/campaign-provider-schema.sql','tests/fixtures/campaign-store-pre-recovery.sql','tests/fixtures/campaign-provider-pre-recovery.sql','n8n/growth/campaign-write-guard.sql'])await db.exec(read(file));
  const q=async(sql,p=[])=>(await db.query(sql,p)).rows;
  const call=async(a,p)=>(await q('SELECT shrigma_campaign_store($1,$2::jsonb) r',[a,JSON.stringify(p)]))[0].r;
  const provider=async(a,p)=>(await q('SELECT shrigma_campaign_provider($1,$2::jsonb) r',[a,JSON.stringify(p)]))[0].r;
  const source=await call('claim',{actor:'synthetic-manager',key:'original-save-key-001',hash:'a'.repeat(64),brand:'fish',action:'salvar'});
  await db.exec('BEGIN');await q("SELECT set_config('shrigma.campaign_writer','100',true)");
  await q("UPDATE campaigns SET attribs=jsonb_set(attribs,'{crm,created_operation_id}',to_jsonb($1::text)),send_at=NULL WHERE id=100",[source.id]);await db.exec('COMMIT');
  await call('finish',{id:source.id,lease:source.lease,providerId:100,state:'outcome_unknown',response:{status:502,body:{error:'OUTCOME_UNKNOWN',provider_id:100,operation_id:source.id}}});
  const snapshot=async()=>({campaigns:await q('SELECT * FROM campaigns ORDER BY id'),ops:await q('SELECT * FROM shrigma_campaign_operation ORDER BY id'),subscribers:await q('SELECT * FROM subscribers ORDER BY id'),links:await q('SELECT * FROM subscriber_lists ORDER BY subscriber_id,list_id')});
  const before=await snapshot();const migration=read('n8n/growth/campaign-recovery-install.sql');await db.exec(migration);await db.exec(migration);assert.deepEqual(await snapshot(),before,'upgrade and replay preserve all historical data');
  const functions=await q("SELECT proname,prosrc FROM pg_proc WHERE proname IN ('shrigma_campaign_store','shrigma_campaign_provider','shrigma_campaign_recovery') ORDER BY proname");
  const fresh=new PGlite();try{for(const f of ['tests/campaign-provider-schema.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-recovery.sql','n8n/growth/campaign-provider.sql'])await fresh.exec(read(f));assert.deepEqual((await fresh.query("SELECT proname,prosrc FROM pg_proc WHERE proname IN ('shrigma_campaign_store','shrigma_campaign_provider','shrigma_campaign_recovery') ORDER BY proname")).rows,functions);}finally{await fresh.close();}
  for(const ddl of ["ALTER TABLE shrigma_campaign_recovery_receipt ADD COLUMN unexpected text", "ALTER TABLE shrigma_campaign_recovery_receipt DROP CONSTRAINT shrigma_campaign_recovery_receipt_pkey", "ALTER TABLE shrigma_campaign_recovery_receipt ALTER COLUMN provider_id DROP NOT NULL", "ALTER TABLE shrigma_campaign_recovery_receipt ALTER COLUMN created_at SET DEFAULT now()"]){
   const bad=new PGlite();try{for(const f of ['tests/campaign-provider-schema.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-recovery.sql','n8n/growth/campaign-provider.sql'])await bad.exec(read(f));await bad.exec(ddl);await assert.rejects(bad.exec(migration),/RECOVERY_TABLE_DRIFT/);await bad.exec('ROLLBACK');}finally{await bad.close();}
  }
  const inspect=actor=>provider('recovery_inspect',{sourceOperationId:source.id,actor});
  assert.equal(await inspect('other-manager'),null);const proof=await inspect('synthetic-manager');assert.equal(proof.source_operation_id,source.id);assert.equal(proof.campaign.id,100);assert.equal(proof.frozen,false);
  const oldReceipt=await call('get',{actor:'synthetic-manager',key:'original-save-key-001'});assert.equal(oldReceipt.operation_key,'original-save-key-001');assert.equal('lease' in oldReceipt,false);
  let index=0;
  async function claim(actor='synthetic-manager',brand='fish'){return call('claim',{actor,key:'recovery-key-fixture-'+(++index),hash:'b'.repeat(64),brand,action:'recuperar'});}
  const payload=op=>({id:100,operationId:op.id,sourceOperationId:source.id,expectedVersion:proof.campaign.version});
  for(const [label,sql] of [
   ['pending source',"UPDATE shrigma_campaign_operation SET state='pending',response=NULL WHERE id=$1"],
   ['different receipt',"UPDATE shrigma_campaign_operation SET response=jsonb_set(response,'{body,provider_id}','101') WHERE id=$1"],
   ['wrong origin',"SELECT set_config('shrigma.campaign_writer','100',true); UPDATE campaigns SET attribs=jsonb_set(attribs,'{crm,created_operation_id}','\"00000000-0000-4000-8000-000000000001\"') WHERE id=100"],
   ['started',"SELECT set_config('shrigma.campaign_writer','100',true); UPDATE campaigns SET started_at=clock_timestamp() WHERE id=100"],
   ['sent',"SELECT set_config('shrigma.campaign_writer','100',true); UPDATE campaigns SET sent=1 WHERE id=100"],
   ['scheduled',"SELECT set_config('shrigma.campaign_writer','100',true); UPDATE campaigns SET status='scheduled' WHERE id=100"]]){
    await db.exec('BEGIN');if(sql.includes('$1'))await q(sql,[source.id]);else await db.exec(sql);assert.equal(await inspect('synthetic-manager'),null,label);const op=await claim();await assert.rejects(provider('recover',payload(op)),/RECOVERY_UNAVAILABLE/,label);await db.exec('ROLLBACK');
  }
  for(const [actor,brand] of [['other-manager','fish'],['synthetic-manager','aristo']]){await db.exec('BEGIN');const op=await claim(actor,brand);await assert.rejects(provider('recover',payload(op)),/RECOVERY_UNAVAILABLE/);await db.exec('ROLLBACK');}
  await db.exec('BEGIN');let op=await claim();await assert.rejects(provider('recover',{...payload(op),expectedVersion:'stale'}),/VERSION_CONFLICT/);await db.exec('ROLLBACK');
  const preserved=await snapshot();
  const vm=require('node:vm'),context=vm.createContext({});vm.runInContext(read('n8n/growth/campaign-runtime.bundle.js'),context,{timeout:5000});
  const runtime=context.ShrigmaCampaignRuntime.createRuntime(),request={acao:'campanha_recuperar',brand:'fish',id:100,expected_version:proof.campaign.version,source_operation_id:source.id,confirm:'recuperar',idempotency_key:'runtime-recovery-key-001'},effects=[];
  async function drive(executionId){let out=await runtime.start({actor:'synthetic-manager',caps:['read_content','draft']},request,{executionId});
   for(let n=0;out.kind==='effect'&&n<12;n++){const e=out.effect;effects.push(e.kind+':'+e.action);assert.ok(['store','provider'].includes(e.kind),'recovery must have no native effects');
    const result=await (e.kind==='store'?call:provider)(e.action,JSON.parse(JSON.stringify(e.payload)));
    out=await runtime.resume(out.context,{effect_id:e.id,ok:true,value:{rows:[{result}]}},{executionId});}
   assert.equal(out.kind,'response');return JSON.parse(JSON.stringify(out.response));}
  const completed=await drive('recovery-synthetic-1');assert.equal(completed.status,200,JSON.stringify(completed));const recovered=completed.body;
  op=(await q("SELECT * FROM shrigma_campaign_operation WHERE operation_key='runtime-recovery-key-001'"))[0];
  assert.deepEqual(effects,['store:claim','provider:recover','store:finish']);assert.deepEqual(await drive('recovery-synthetic-2'),completed);assert.equal(effects.filter(x=>x==='provider:recover').length,1);
  assert.equal(recovered.recovery_policy,'crm-campaign-recovery-v1');assert.deepEqual(recovered.campaign,proof.campaign);
  const after=await snapshot();assert.deepEqual(after.campaigns,preserved.campaigns);assert.deepEqual(after.subscribers,preserved.subscribers);assert.deepEqual(after.links,preserved.links);assert.deepEqual(after.ops.find(o=>o.id===source.id),preserved.ops.find(o=>o.id===source.id));
  const receipt=await call('get',{actor:'synthetic-manager',key:'runtime-recovery-key-001'});assert.equal(receipt.state,'succeeded');assert.deepEqual(receipt.response.body,recovered);assert.equal(await inspect('synthetic-manager'),null);
  await call('finish',{id:op.id,lease:op.lease,providerId:100,state:'succeeded',response:receipt.response});
  const second=await claim();await assert.rejects(provider('recover',payload(second)),/RECOVERY_ALREADY_CLAIMED/);assert.equal((await q('SELECT count(*)::int n FROM shrigma_campaign_recovery_receipt'))[0].n,1);
  await db.exec("CREATE OR REPLACE FUNCTION shrigma_campaign_provider(a text,p jsonb) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$");await assert.rejects(db.exec(migration),/RECOVERY_PROVIDER_DRIFT/);await db.exec('ROLLBACK');
  console.log('PASS recovery SQL: drift-safe/idempotent migration; actor, brand, source receipt, origin, status and CAS guards; one atomic receipt; source/campaign/audience unchanged; no transport.');
 }finally{await db.close();}
})().catch(e=>{console.error(e.message,e.where||'');process.exitCode=1;});
