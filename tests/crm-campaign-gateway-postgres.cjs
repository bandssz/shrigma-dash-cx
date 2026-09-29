'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{createHash}=require('node:crypto');
const {Client,Pool}=require('pg');
const {createServer,PATH}=require('../services/crm-campaign/server.cjs');
const {createExecutor}=require('../services/crm-campaign/transport.cjs');
if(process.env.CRM_CAMPAIGN_GATEWAY_TEST_ISOLATED!=='1'||!process.env.TEST_DATABASE_URL)throw Error('isolated PostgreSQL required');
const ROOT=path.join(__dirname,'..'),read=f=>fs.readFileSync(path.join(ROOT,f),'utf8'),hash=s=>createHash('sha256').update(s).digest('hex');
const parsed=new URL(process.env.TEST_DATABASE_URL);
if(parsed.protocol!=='postgresql:'||parsed.hostname!=='127.0.0.1'||parsed.port===''||parsed.port==='5432'||parsed.pathname!=='/listmonk'||parsed.username!=='postgres'||parsed.password)throw Error('isolated PostgreSQL URL required');
const ownerUrl=parsed.href,apiParsed=new URL(parsed);apiParsed.username='crm_campaign_api';apiParsed.password='synthetic-password';const apiUrl=apiParsed.href;
const definition=(brand='fish')=>({schema_version:'crm-campaign-v1',brand,channel:'email',initiative:{key:'gateway-proof',name:'Gateway proof'},utm_campaign:'gateway-proof',name:'Gateway proof',subject:'Proof subject',from_email:brand==='fish'?'Fish <contato@fishermans.com.br>':'Aristo <contato@oaristocrata.com>',reply_to:brand==='fish'?'contato@fishermans.com.br':'contato@oaristocrata.com',list_ids:[brand==='fish'?3:7],template_id:1,html:`<a href="https://${brand==='fish'?'fishermans.com.br':'oaristocrata.com'}/products/proof">Proof</a> {{ UnsubscribeURL }}`,text:`https://${brand==='fish'?'fishermans.com.br':'oaristocrata.com'}/products/proof\n{{ UnsubscribeURL }}`,tags:[],send_at:new Date(Date.now()+24*60*60*1000).toISOString()});
async function request(app,{method='GET',query='',body}={}){return new Promise((resolve,reject)=>{const bytes=body&&Buffer.from(JSON.stringify(body)),req=http.request({host:'127.0.0.1',port:app.server.address().port,path:PATH+query,method,headers:bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{Authorization:'Bearer synthetic-manager-key'}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch(e){reject(e);}});});req.on('error',reject);req.end(bytes);});}
const post=(app,value)=>request(app,{method:'POST',body:{k:'synthetic-manager-key',...value}});
function atomic(sql){return `DO $campaign_gateway$ BEGIN EXECUTE $gateway_ddl$${sql}$gateway_ddl$; END $campaign_gateway$;`;}
async function install(owner){
 await owner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE TABLE crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL,dono text,ativo boolean DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer DEFAULT 0); CREATE TABLE shrigma_template_key_v2(key_hash text,active boolean,actor text,capabilities jsonb);`);
 for(const f of ['n8n/access/panel-auth.sql','n8n/access/panel-operator.sql','n8n/access/panel-short-keys.sql','tests/campaign-provider-schema.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-recovery.sql','n8n/growth/campaign-provider.sql'])await owner.query(read(f));
 await owner.query('INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash,chave_hash_curta) VALUES($1,\'growth\',\'Manager\',$2,$3)',['synthetic-manager-id',hash('synthetic-manager-key'),hash('synthetic-short-key')]);
 await owner.query("INSERT INTO shrigma_panel_permission_v1 VALUES('synthetic-manager-id','growth',$1::jsonb)",[JSON.stringify(['read_content','draft','validate','submit'])]);
 await owner.query(atomic(read('n8n/growth/crm-campaign-gateway-role.sql')));
 await owner.query("ALTER ROLE crm_campaign_api LOGIN PASSWORD 'synthetic-password'");
}
test('real HTTP runtime uses restricted login for reads, existing/new saves, review and schedule',async t=>{
 const owner=new Client({connectionString:ownerUrl});await owner.connect();t.after(()=>owner.end());await install(owner);
 const version=(await owner.query('SHOW server_version')).rows[0].server_version;
 assert.equal((await owner.query('SHOW server_version_num')).rows[0].server_version_num,'170010');
 const pool=new Pool({connectionString:apiUrl,max:4,statement_timeout:12000,query_timeout:12500});t.after(()=>pool.end());
 const failures=[],guardedPool={query:async(sql,params)=>{try{return await pool.query(sql,params);}catch(e){const effect=params?.[2]&&JSON.parse(params[2]);failures.push({kind:effect?.kind,action:effect?.action,code:e.code,message:e.message});throw e;}}};
 let next=300,nativeCreates=0,previews=0,loseCreate=false,losePreview=false;
 const native=async effect=>{
  if(effect.kind==='preview'){previews++;if(losePreview){losePreview=false;throw Error('synthetic preview response loss');}return {status:200,body:'rendered locally'};}
  assert.equal(effect.kind,'nativeCreate');nativeCreates++;const p=effect.payload,id=next++;
  await owner.query(`INSERT INTO campaigns(id,name,subject,from_email,body,altbody,body_source,content_type,send_at,headers,status,tags,type,messenger,template_id,sent,started_at,attribs)
   VALUES($1,$2,$3,$4,$5,$6,NULL,'html',NULL,$7::jsonb,'draft',$8::varchar[],'regular','email',$9,0,NULL,$10::jsonb)`,[id,p.name,p.subject,p.from_email,p.body,p.altbody,JSON.stringify(p.headers),p.tags,p.template_id,JSON.stringify(p.attribs)]);
  for(const listId of p.lists)await owner.query('INSERT INTO campaign_lists(campaign_id,list_id,list_name) SELECT $1,id,name FROM lists WHERE id=$2',[id,listId]);
  if(loseCreate){loseCreate=false;throw Error('synthetic create response loss');}
  return {status:201,body:{data:{id}}};
 };
 const app=createServer({pool,native,executor:createExecutor({pool:guardedPool,native}),revision:'a'.repeat(40),enabled:true});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.stop());
 const catalog=await request(app,{query:'?acao=campanha_catalogo&brand=fish'});assert.equal(catalog.status,200);assert.equal(catalog.body.brand,'fish');
 const existing=(await request(app,{query:'?acao=campanha_obter&brand=fish&id=100'})).body.campaign;
 const saveExisting=await post(app,{acao:'campanha_salvar',brand:'fish',id:100,expected_version:existing.version,idempotency_key:'pg-existing-save-0001',definition:definition()});
 assert.equal(saveExisting.status,200);assert.equal(saveExisting.body.campaign.id,100);
 const staleKey='pg-stale-edit-000001',stale=await post(app,{acao:'campanha_salvar',brand:'fish',id:100,expected_version:existing.version,idempotency_key:staleKey,definition:definition()});
 assert.equal(stale.status,409);assert.equal(stale.body.error,'VERSION_CONFLICT');
 const staleRead=await request(app,{query:'?acao=campanha_operacao&brand=fish&idempotency_key='+staleKey});assert.equal(staleRead.body.operation.state,'rejected');assert.equal(staleRead.body.operation.providerId,100);assert.ok(!Object.hasOwn(staleRead.body.operation,'lease'));
 const saveNew=await post(app,{acao:'campanha_salvar',brand:'aristo',idempotency_key:'pg-new-save-0000001',definition:definition('aristo')});
 assert.equal(saveNew.status,201,JSON.stringify({body:saveNew.body,failures}));assert.equal(saveNew.body.campaign.id,300);assert.equal(nativeCreates,1);assert.equal(previews,6);
 const current=saveExisting.body.campaign;
 const review=await post(app,{acao:'campanha_validar',brand:'fish',id:100,expected_version:current.version,idempotency_key:'pg-review-operation-1'});
 assert.equal(review.status,200);const reviewId=review.body.validation.audience.review_id;assert.match(reviewId,/^[0-9a-f-]{36}$/);
 const schedule=await post(app,{acao:'campanha_agendar',brand:'fish',id:100,expected_version:current.version,idempotency_key:'pg-schedule-oper-0001',confirm:'agendar',audience_review_id:reviewId});
 assert.equal(schedule.status,200);assert.equal(schedule.body.campaign.status,'scheduled');assert.equal(schedule.body.audience.review_id,reviewId);
 const replay=await post(app,{acao:'campanha_agendar',brand:'fish',id:100,expected_version:current.version,idempotency_key:'pg-schedule-oper-0001',confirm:'agendar',audience_review_id:reviewId});assert.deepEqual(replay,schedule);
 const cancelled=await post(app,{acao:'campanha_cancelar',brand:'fish',id:100,expected_version:schedule.body.campaign.version,idempotency_key:'pg-cancel-oper-00001',confirm:'cancelar'});assert.equal(cancelled.status,200);assert.equal(cancelled.body.campaign.status,'cancelled');
 loseCreate=true;const lostCreate={acao:'campanha_salvar',brand:'fish',idempotency_key:'pg-lost-create-000001',definition:definition()};
 const lost=await post(app,lostCreate);assert.equal(lost.body.error,'OUTCOME_UNKNOWN');assert.equal(nativeCreates,2);
 const lostAgain=await post(app,lostCreate);assert.deepEqual(lostAgain,lost);assert.equal(nativeCreates,2);
 const lossRead=await request(app,{query:'?acao=campanha_operacao&brand=fish&idempotency_key='+lostCreate.idempotency_key});assert.equal(lossRead.status,200);assert.equal(lossRead.body.operation.state,'outcome_unknown');assert.equal(Object.hasOwn(lossRead.body,'recovery'),false);
 losePreview=true;const interruptedSave={acao:'campanha_salvar',brand:'fish',idempotency_key:'pg-lost-preview-00001',definition:definition()};
 const failedPreview=await post(app,interruptedSave);assert.equal(failedPreview.body.error,'OUTCOME_UNKNOWN');assert.equal(failedPreview.body.provider_id,302);
 const recoveredRead=await request(app,{query:'?acao=campanha_operacao&brand=fish&idempotency_key='+interruptedSave.idempotency_key});assert.equal(recoveredRead.status,200,JSON.stringify({recoveredRead,failures}));
 const recovery=recoveredRead.body.recovery;assert.equal(recovery.campaign.id,302);assert.equal(recovery.frozen,false);
 const recovered=await post(app,{acao:'campanha_recuperar',brand:'fish',id:302,expected_version:recovery.campaign.version,source_operation_id:recovery.source_operation_id,idempotency_key:'pg-recover-oper-00001',confirm:'recuperar'});assert.equal(recovered.status,200,JSON.stringify({recovered,failures}));assert.equal(recovered.body.campaign.id,302);assert.equal(nativeCreates,3);
 await owner.query("UPDATE crm_dash_chave SET revogada_em=clock_timestamp() WHERE chave='synthetic-manager-id'");assert.equal((await request(app,{query:'?acao=campanha_catalogo&brand=fish'})).status,401);
 const role=(await owner.query("SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolconnlimit FROM pg_roles WHERE rolname='crm_campaign_api'")).rows[0];assert.deepEqual(role,{rolcanlogin:true,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolinherit:false,rolreplication:false,rolbypassrls:false,rolconnlimit:4});
 await assert.rejects(pool.query('SELECT * FROM public.campaigns'),e=>e.code==='42501');
 await assert.rejects(pool.query("SELECT public.shrigma_campaign_provider('catalog','{\"brand\":\"fish\"}'::jsonb)"),e=>e.code==='42501');
 const counts=(await owner.query("SELECT count(*) FILTER(WHERE state='succeeded') succeeded,count(*) FILTER(WHERE state='pending') pending FROM shrigma_campaign_operation")).rows[0];assert.equal(Number(counts.pending),0);assert.ok(Number(counts.succeeded)>=4);
 assert.equal(Number((await owner.query('SELECT coalesce(sum(sent),0) sent FROM campaigns')).rows[0].sent),0);
 console.log(JSON.stringify({postgres:version,http:true,restricted_login:true,native_fake_only:true,new_save:true,existing_save:true,stale_rejected:true,review:true,schedule:true,cancel:true,replay:true,lost_create_no_retry:true,recovery:true,revocation:true,direct_denied:true,native_creates:nativeCreates,previews,sends:0}));
});
