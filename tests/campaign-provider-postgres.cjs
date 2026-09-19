/* Run with CAMPAIGN_PGLITE_MODULE pointing to an installed @electric-sql/pglite.
   Isolated real PostgreSQL engine; no network, credentials, live tables or transport. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
(async()=>{
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');const db=new PGlite();
 try{
  for(const file of ['tests/campaign-provider-schema.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-provider.sql','tests/campaign-provider.sql','n8n/growth/campaign-write-guard.sql','tests/campaign-write-guard.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'..',file),'utf8'));
  const assert=require('node:assert/strict');
  const {createService}=require('../n8n/growth/campaign-service');
  const {createStore}=require('../n8n/growth/campaign-store');
  const {createProvider}=require('../n8n/growth/campaign-provider');
  let creations=0;
  const query=(sql,params)=>db.query(sql,params);
  const provider=createProvider({query,validateContent:async({templateVersion})=>({ok:true,templateVersion}),nativeCreate:async payload=>{
   creations++;
   await db.exec('BEGIN');
   await db.query(`INSERT INTO campaigns(id,name,subject,from_email,body,altbody,content_type,headers,status,tags,type,messenger,template_id,sent,attribs)
     VALUES(300,$1,$2,$3,$4,$5,'html',$6::jsonb,'draft','{}','regular','email',1,0,$7::jsonb)`,
     [payload.name,payload.subject,payload.from_email,payload.body,payload.altbody,JSON.stringify(payload.headers),JSON.stringify(payload.attribs)]);
   await db.query("INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(300,3,'Fish')");await db.exec('COMMIT');return {id:300};
  }});
  const service=createService({store:createStore({query}),provider});
  const auth={actor:'integration',caps:['read_content','draft','validate','submit']};
  const definition={schema_version:'crm-campaign-v1',brand:'fish',channel:'email',initiative:{key:'pipeline',name:'Pipeline'},utm_campaign:'pipeline',
   name:'Pipeline',subject:'Subject',from_email:'contato@fishermans.com.br',reply_to:'contato@fishermans.com.br',list_ids:[3],template_id:1,
   html:'<a href="https://fishermans.com.br/products/x">x</a>{{ UnsubscribeURL }}',text:'https://fishermans.com.br/products/x {{ UnsubscribeURL }}',tags:[],send_at:new Date(Date.now()+86400000).toISOString()};
  const req={acao:'campanha_salvar',brand:'fish',definition,idempotency_key:'integration-save-00001'};
  const attempts=await Promise.all([service.handle(auth,req),service.handle(auth,req)]);
  const saved=attempts.find(r=>r.status===201);assert.ok(saved,JSON.stringify(attempts));assert.equal(creations,1);
  assert.ok(saved.body.campaign.definition.html.includes('lm-300-l3'));
  const {id,version}=saved.body.campaign;
  const validated=await service.handle(auth,{acao:'campanha_validar',brand:'fish',id,expected_version:version,idempotency_key:'integration-validate-01'});
  assert.equal(validated.status,200,JSON.stringify(validated));
  const scheduled=await service.handle(auth,{acao:'campanha_agendar',brand:'fish',id,expected_version:version,confirm:'agendar',idempotency_key:'integration-schedule-01'});
  assert.equal(scheduled.status,200,JSON.stringify(scheduled));assert.equal(scheduled.body.campaign.status,'scheduled');
  assert.equal(scheduled.body.campaign.sent,0);
  const scheduledVersion=scheduled.body.campaign.version;
  const cancel={acao:'campanha_cancelar',brand:'fish',id,expected_version:scheduledVersion,confirm:'cancelar',idempotency_key:'integration-cancel-01'};
  assert.equal((await service.handle({...auth,caps:['read_content']},cancel)).status,403);
  assert.equal((await service.handle(auth,{...cancel,expected_version:version,idempotency_key:'integration-cancel-stale'})).status,409);
  assert.equal((await service.handle(auth,{...cancel,brand:'aristo',idempotency_key:'integration-cancel-brand'})).status,404);
  const cancelled=await service.handle(auth,cancel);
  assert.equal(cancelled.status,200,JSON.stringify(cancelled));assert.equal(cancelled.body.campaign.status,'cancelled');
  assert.notEqual(cancelled.body.campaign.version,scheduledVersion);assert.equal(cancelled.body.campaign.sent,0);assert.equal(cancelled.body.campaign.started_at,null);
  assert.deepEqual(await service.handle(auth,cancel),cancelled,'same-key cancellation returns the persisted receipt');
  const retained=await db.query("SELECT count(*)::int AS n FROM shrigma_campaign_operation WHERE actor='integration' AND operation_key='integration-cancel-01'");
  assert.equal(retained.rows[0].n,1,'cancellation does not remove its reservation');
  assert.equal((await service.handle(auth,req)).status,201);assert.equal(creations,1);
  console.log('Campaign provider PostgreSQL scenarios and service pipeline passed (isolated; native create/compiler simulated; no transport).');
 }finally{await db.close();}
})().catch(e=>{console.error(e.message,e.position||"",e.where||"");process.exitCode=1;});
