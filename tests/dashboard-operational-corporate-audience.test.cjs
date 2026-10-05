'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {setup,hosts,sha}=require('./corporate-audience-native-fixture.cjs');
const S=require('../n8n/growth/segment-audience-store.cjs'),P=require('../services/dashboard-operational/proxy.cjs');
const Server=require('../services/dashboard-operational/server.cjs'),{transport}=require('./helpers/claude-portal-pages.cjs');
async function portal(t,a,{enabled=true,lostAck=false,onScope}={}){
 let posts=0;const fetchImpl=async(value,options)=>{
  const url=new URL(value);assert.equal(url.href.split('?')[0],P.REVIEWED_DYNAMIC.routes.segments);assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers.Origin,undefined);
  const key=options.headers.Authorization.slice(7),p=options.method==='POST'?JSON.parse(options.body):Object.fromEntries(url.searchParams),r=await a.api.handle({method:options.method,request:{headers:{Authorization:'Bearer '+key},[options.method==='POST'?'body':'query']:p}});
  if(p.acao==='segmento_contexto_v2'&&onScope)await onScope();
  if(options.method==='POST'){posts++;if(lostAck){lostAck=false;throw Error('synthetic lost ACK after commit');}}
  return new Response(JSON.stringify(r.body),{status:r.status,headers:{'content-type':'application/json'}});
 };
 const config={...a.f.config,mode:'operational',upstreamProfile:'production',crmAudienceDraft:enabled,crmManagedReadUi:true,crmManagedWriter:{...a.f.config.crmManagedWriter,provisionerToken:'S'.repeat(43)},upstreams:{'crm-read':P.FIXED_DESTINATIONS['crm-read'],campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,...(enabled?{segments:P.REVIEWED_DYNAMIC.routes.segments}:{})},allowedUpstreamHosts:[new URL(P.FIXED_DESTINATIONS['crm-read']).hostname,new URL(P.REVIEWED_DYNAMIC.routes.campaigns).hostname,new URL(P.REVIEWED_DYNAMIC.routes.segments).hostname],dynamicRouteManifest:{schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,...(enabled?{segments:P.REVIEWED_DYNAMIC.routes.segments}:{})}}};
 const app=Server.createServer(config,{auth:a.f.auth,managedCrmRuntime:{kick:async()=>{},close:async()=>{}},fetchImpl});t.after(()=>app.removeAllListeners());const http=transport(app);
 const opts=ctx=>({cookie:ctx.cookieHeader,csrf:ctx.csrf,origin:ctx.origin});
 return{get:(p,u=a.users.fish)=>http.get(u.ctx.host,p,opts(u.ctx)),post:(p,u=a.users.fish)=>http.post(u.ctx.host,'/api/segments',p,opts(u.ctx)),get posts(){return posts;}};
}
test('native FULL Writer creates only its brand and stores exact durable revisions/receipts',async t=>{
 const a=await setup(t);
 for(const brand of ['fish','aristo']){
  const u=a.users[brand],p=await a.create(brand,u.key),other=brand==='fish'?'aristo':'fish';
  assert.equal((await a.call({acao:'segmentos_listar',brand:other,limit:50,offset:0},u.key)).status,403);
  assert.equal((await a.call({...p,brand:other,definition:{...p.definition,brand:other}},u.key)).status,403);
  const r=await a.call(p,u.key);assert.equal(r.status,201,JSON.stringify(r));assert.equal(r.body.segment.brand,brand);assert.equal(r.body.transport_supported,false);
  const same=await a.call({acao:'segmento_operacao_v2',brand,idempotency_key:p.idempotency_key},u.key);assert.equal(same.status,200);assert.equal(same.body.operation.receipt.status,201);
 }
 assert.equal((await a.db.query('SELECT count(*) n FROM crm_audience_v2.audience')).rows[0].n,2);assert.equal((await a.db.query('SELECT count(*) n FROM crm_audience_v2.revision')).rows[0].n,2);assert.equal((await a.db.query('SELECT count(*) n FROM crm_audience_v2.request')).rows[0].n,2);
 assert.equal((await a.call({acao:'segmento_contar',brand:'fish',definition:(await a.create('fish',a.users.fish.key)).definition,expected_catalog_hash:(await a.create('fish',a.users.fish.key)).expected_catalog_hash},a.users.fish.key)).status,503);
});
test('unbound legacy operator, READ and invalid/null brand never acquire corporate Writer authority; PUBLIC denied',async t=>{
 const a=await setup(t),key='synthetic-unbound-writer';
 await a.db.query("INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash,expira_em) VALUES('unbound','growth','x@shrigma.com.br',$1,clock_timestamp()+interval '1 day')",[sha(key)]);await a.db.exec("INSERT INTO shrigma_panel_permission_v1 VALUES('unbound','growth','[\"read_content\",\"draft\",\"validate\",\"submit\"]')");
 assert.equal((await a.call({acao:'segmentos_listar',brand:'fish',limit:50,offset:0},key)).status,403);
 const reader=a.f.auth.getUpstreamCredential({...a.users.fish.ctx,method:'GET',area:'growth',brand:'fish',slot:'crm-panel-read',edit:false});assert.equal((await a.call({acao:'segmentos_listar',brand:'fish',limit:50,offset:0},reader)).status,403);
 for(const b of [null,'','todas','fishermans'])assert.equal((await a.db.query('SELECT crm_audience_v2.authenticate_corporate_v1($1,$2) r',[a.users.fish.key,b])).rows[0].r,null);
 assert.equal((await a.db.query("SELECT has_function_privilege('public','crm_audience_v2.authenticate_corporate_v1(text,text)','EXECUTE') v")).rows[0].v,false);
});
test('issuer, owner, active generation, caps and expiry drift after wait roll back before any audience revision',async t=>{
 const a=await setup(t),u=a.users.fish;
 const changes=["UPDATE crm_manager_writer_issuer_v1 SET active=false", "UPDATE crm_manager_writer_subject_v1 SET owner='different@shrigma.com.br'", "UPDATE crm_manager_writer_subject_v1 SET active_generation=0", "UPDATE crm_manager_writer_generation_v1 SET issued_at_ms=1,candidate_expires_at_ms=600001,expires_at_ms=1209600001", "UPDATE shrigma_panel_permission_v1 SET caps='[\"read_content\"]' WHERE principal_id LIKE 'dcrmw-%'"];
 for(const sql of changes){
  const p=await a.create('fish',u.key);let done=false;a.afterQuery=async(text,args,tx)=>{if(!done&&text===S.SQL.lock){done=true;await tx.exec(sql);}};
  assert.equal((await a.call(p,u.key)).status,403,sql);a.afterQuery=null;
  assert.equal((await a.db.query('SELECT count(*) n FROM crm_audience_v2.audience')).rows[0].n,0);
  assert.equal((await a.db.query('SELECT count(*) n FROM crm_audience_v2.request')).rows[0].n,0);
 }
});
test('real Master remains two-brand and a legacy principal equal to bearer is never persisted or returned',async t=>{
 const a=await setup(t),key='synthetic-real-master-bearer';await a.db.query("INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash,expira_em) VALUES($1,'todos','felipebandeira@oaristocrata.com',$2,clock_timestamp()+interval '1 day')",[key,sha(key)]);
 await a.db.query("INSERT INTO shrigma_panel_permission_v1 VALUES($1,'growth','[\"read_content\",\"draft\",\"validate\",\"submit\"]')",[key]);
 for(const brand of ['fish','aristo']){const p=await a.create(brand,key),r=await a.call(p,key);assert.equal(r.status,201,JSON.stringify(r));assert.match(r.body.segment.updated_by,/^panel:audience-master-[a-f0-9]{64}$/);assert.equal(JSON.stringify(r).includes(key),false);}
 for(const table of ['audience','revision','request'])assert.equal(JSON.stringify((await a.db.query('SELECT * FROM crm_audience_v2.'+table)).rows).includes(key),false);
});
test('corporate BFF uses original per-user Writer, CSRF and audience journal; lost ACK reconciles only by GET',async t=>{
 const a=await setup(t),h=await portal(t,a,{lostAck:true}),p=await a.create('fish',a.users.fish.key);
 const catalog=await h.get('/api/segments?acao=segmentos_listar&brand=fish&limit=50&offset=0');assert.equal(catalog.status,200,JSON.stringify(catalog));assert.equal(catalog.json.capabilities.draft,true);assert.equal(catalog.json.capabilities.count,false);
 const first=await h.post(p);assert.equal(first.status,502,JSON.stringify(first));assert.equal(h.posts,1);const row=a.f.db.prepare('SELECT * FROM audience_draft_operations WHERE user_id=?').get(a.users.fish.id);assert.equal(row.phase,'uncertain');assert.match(row.actor_mac,/^[a-f0-9]{64}$/);
 assert.equal((await h.post({...p,idempotency_key:crypto.randomUUID()})).status,409);assert.equal(h.posts,1);
 const r=await h.get('/api/segments?acao=segmento_operacao&brand=fish&idempotency_key='+p.idempotency_key);assert.equal(r.status,201,JSON.stringify(r));assert.equal(h.posts,1);assert.equal(a.f.db.prepare('SELECT phase FROM audience_draft_operations WHERE user_id=?').get(a.users.fish.id).phase,'succeeded');
 assert.equal((await h.post({...p,brand:'aristo',definition:{...p.definition,brand:'aristo'}})).status,403);assert.equal(h.posts,1);
});
test('local revoke during private scope GET closes before reserve/POST; OFF does not select the Writer slot',async t=>{
 const a=await setup(t),p=await a.create('fish',a.users.fish.key),off=await portal(t,a,{enabled:false});assert.equal((await off.post(p)).status,403);assert.equal(off.posts,0);
 const h=await portal(t,a,{onScope:()=>a.f.auth.revokeUser({context:a.f.context,userId:a.users.fish.id})});assert.equal((await h.post(p)).status,401);assert.equal(h.posts,0);assert.equal(a.f.db.prepare('SELECT count(*) n FROM audience_draft_operations').get().n,0);
});
