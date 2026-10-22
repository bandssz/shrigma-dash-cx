'use strict';
// Original SQLite journal/coordinator + native SQL issuer/auth/gateway in PGlite.
// All principals/keys and READ receipts are synthetic fixtures. No sockets,
// provider send, external HTTP, production rows or PostgreSQL concurrency claim.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite'),{Readable}=require('node:stream'),{EventEmitter}=require('node:events');
const {fixture,hosts}=require('./corporate-writer-fixture.cjs'),{transport}=require('./helpers/claude-portal-pages.cjs');
const S=require('../services/dashboard-operational/server.cjs'),P=require('../services/dashboard-operational/proxy.cjs');
const G=require('../services/crm-campaign/server.cjs'),T=require('../services/crm-campaign/transport.cjs');
const {createWriterClient}=require('../services/dashboard-operational/crm-manager-writer-client.cjs'),{createWriterCoordinator}=require('../services/dashboard-operational/crm-manager-writer-coordinator.cjs');
const {verifyCampaignWriterCredential}=require('../services/dashboard-operational/crm-campaign-writer-attestation.cjs');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8'),sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function gatewayFetch(server){return async(value,options={})=>{
 const url=new URL(value),headers=Object.fromEntries(new Headers(options.headers)),body=options.body;
 return new Promise(resolve=>{const req=Readable.from(body===undefined?[]:[Buffer.from(body)]);Object.assign(req,{url:url.pathname+url.search,method:options.method||'GET',headers,rawHeaders:Object.entries(headers).flat(),socket:{remoteAddress:'127.0.0.1'}});const res=new EventEmitter();const out={};res.writeHead=(status,h)=>{res.statusCode=status;Object.assign(out,h);};res.end=bytes=>{res.writableEnded=true;res.writableFinished=true;res.emit('finish');const response=new Response(bytes,{status:res.statusCode,headers:out});Object.defineProperty(response,'url',{value:url.href});resolve(response);};res.destroy=()=>resolve(new Response('{}',{status:503,headers:{'content-type':'application/json'}}));server.emit('request',req,res);});
};}
async function setup(t,{writer=true}={}){
 const f=await fixture(t);f.advance(Date.now()-f.now);
 // Refresh the real Master login after aligning the fixture clock with native SQL.
 const master=await f.auth.login({email:f.config.bootstrapAdminEmail,password:'Synthetic writer manager password 2026!',host:hosts.manager,origin:'https://'+hosts.manager});
 Object.assign(f.context,{cookieHeader:master.cookie.split(';')[0],csrf:master.csrf});
 const id=await f.manager();let ctx=await f.login();const db=new PGlite();t.after(()=>db.close());
 await db.exec('CREATE TABLE public.crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL,dono text,ativo boolean DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer DEFAULT 0);CREATE TABLE public.shrigma_template_key_v2(key_hash text,active boolean,actor text,capabilities jsonb);');
 for(const p of ['n8n/access/panel-auth.sql','n8n/access/panel-operator.sql','n8n/access/panel-short-keys.sql','tests/campaign-provider-schema.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-recovery.sql','n8n/growth/campaign-template-ownership.sql','n8n/growth/campaign-provider.sql','n8n/growth/campaign-write-guard.sql'])await db.exec(read(p));
 await db.exec("INSERT INTO crm_familia_campanha(marca,utm_campaign,familia) VALUES('fish','week','week'),('aristo','week','week')");
 await db.exec('CREATE ROLE central_leitor NOLOGIN;ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO central_leitor;');await db.exec(read('tools/crm-manager-writer-review/writer-provision-v1.sql'));
 await db.exec('CREATE ROLE crm_manager_content_fixture LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;GRANT EXECUTE ON FUNCTION public.crm_manager_writer_prepare_v1(jsonb),public.crm_manager_writer_commit_v1(jsonb),public.crm_manager_writer_revoke_v1(jsonb),public.crm_manager_writer_status_v1(jsonb) TO crm_manager_content_fixture;');
 await db.query('INSERT INTO crm_manager_writer_issuer_v1(issuer_id,namespace_id,login_role,allowed_email_domains,active) VALUES($1,$2,$3,$4,true)',[f.config.crmManagedWriter.issuerId,f.config.crmManagedWriter.namespaceId,'crm_manager_content_fixture',f.config.allowedEmailDomains]);
 await db.exec(read('n8n/growth/crm-campaign-gateway-role.sql'));await db.exec(read('n8n/growth/crm-campaign-content-authority.sql'));
 const api=async(sql,args=[])=>{await db.exec('SET ROLE crm_campaign_api');try{return await db.query(sql,args);}finally{await db.exec('RESET ROLE');}};
 const current=(key,brand='fish')=>api(T.CONTENT_AUTHORITY_SQL,[key,brand]);
 const readBinding=f.auth.managedCrmJournal.readBinding(id),readerKey=f.auth.getUpstreamCredential({...ctx,method:'GET',area:'growth',slot:'crm-panel-read',edit:false,brand:'fish'});
 // READ setup uses original verified SQLite receipts and a synthetic current
 // native panel principal, not a forged manager/admin context or edit grant.
 await db.query("INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash,expira_em) VALUES($1,'growth',$2,$3,$4)",[readBinding.principalId,ctx.owner||'manager@oaristocrata.com',sha(readerKey),new Date(readBinding.expiresAt).toISOString()]);
 await db.query("INSERT INTO shrigma_panel_permission_v1 VALUES($1,'growth',$2::jsonb)",[readBinding.principalId,JSON.stringify(['read_content','list_history','submission'])]);
 if(writer){
  const invoke=async({procedure,parameters})=>{await db.exec('SET SESSION AUTHORIZATION crm_manager_content_fixture');try{const result=(await db.query('SELECT '+procedure+'($1::jsonb) AS r',parameters)).rows[0].r;f.advance(Date.now()-f.now);return result;}finally{await db.exec('SET SESSION AUTHORIZATION postgres');}};
  // Reconstruct only the exact original client option contract.
  const originalClient=createWriterClient({issuerId:f.config.crmManagedWriter.issuerId,namespaceId:f.config.crmManagedWriter.namespaceId,allowedEmailDomains:f.config.allowedEmailDomains,now:()=>f.now,invoke});
  const attest=async input=>verifyCampaignWriterCredential(input,{fetchImpl:async url=>{const native=(await current(input.bearer)).rows[0].result;assert.ok(native);const response=new Response(JSON.stringify({schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',owner:native.owner,allowedPanels:['growth'],permissions:{growth:{who:native.actor,label:native.owner,caps:native.caps},influs:null}}),{headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;}});
  const coordinator=createWriterCoordinator({journal:f.auth.managedCampaignWriterJournal,client:originalClient,attest,now:()=>f.now});assert.equal(f.auth.fulfillManagedCampaignWriterRequests().queued,1);assert.deepEqual(await coordinator.run(f.operation(id)),{state:'ready'});
 }else{f.auth.setRequestedAccess({context:f.context,userId:id,requestedAccess:'read'});ctx=await f.login();}
 let native=0,effects=0,proofs=0,writes=0,duringProof=null;
 const pool={query:async(sql,args)=>{if(sql===T.EFFECT_SQL){effects++;const effect=JSON.parse(args[2]);if(effect.kind==='provider'&&['review','update','schedule','cancel'].includes(effect.action))writes++;}if(sql===T.CONTENT_AUTHORITY_SQL)proofs++;return api(sql,args);}},gateway=G.createServer({pool,enabled:true,revision:'synthetic-content-authority',native:async()=>{native++;throw Error('NO_NATIVE_BUSINESS_HTTP');}});t.after(()=>gateway.server.removeAllListeners());const originalFetch=gatewayFetch(gateway.server);
 const fetchImpl=async(url,options)=>{const result=await originalFetch(url,options);if(new URL(url).searchParams.get('acao')==='campanha_acesso'&&duringProof)await duringProof();return result;};
 const settings={...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,crmManagedWriter:{...f.config.crmManagedWriter,provisionerToken:'S'.repeat(43)},upstreams:{'crm-read':P.FIXED_DESTINATIONS['crm-read'],campaigns:P.REVIEWED_DYNAMIC.routes.campaigns},allowedUpstreamHosts:[new URL(P.FIXED_DESTINATIONS['crm-read']).hostname,new URL(P.REVIEWED_DYNAMIC.routes.campaigns).hostname],dynamicRouteManifest:{schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:P.REVIEWED_DYNAMIC.routes.campaigns}},crmCorporateCreate:true};
 const app=S.createServer(settings,{auth:f.auth,managedCrmRuntime:{kick:async()=>{},close:async()=>{}},fetchImpl});t.after(()=>app.removeAllListeners());const http=transport(app),get=(p,c=ctx)=>http.get(c.host,p,{cookie:c.cookieHeader,csrf:c.csrf,origin:c.origin}),post=body=>http.post(ctx.host,'/api/campaigns',body,{cookie:ctx.cookieHeader,csrf:ctx.csrf,origin:ctx.origin});
 return {f,id,ctx,db,http,get,post,current,readerKey,readBinding,get native(){return native;},get effects(){return effects;},get writes(){return writes;},get proofs(){return proofs;},set duringProof(v){duringProof=v;}};
}
test('actual native IAM + exclusive ownership enables only the current signed manager scope and exposes UI booleans',async t=>{
 const a=await setup(t),session=await a.get('/auth/session');assert.equal(session.status,200);assert.equal(session.json.features.campaignSubmitWrite,true);assert.equal(session.json.features.campaignCreate,true);assert.equal(session.json.features.campaignTemplateOwnershipUnavailable,false);
 const catalog=await a.get('/api/campaigns?acao=campanha_catalogo&brand=fish');assert.equal(catalog.status,200,JSON.stringify(catalog.json));assert.equal(catalog.json.current,true);assert.deepEqual(catalog.json.templates.map(x=>x.id),[1]);assert.equal(catalog.json.template_selection_available,true);assert.equal((await a.get('/api/campaigns?acao=campanha_catalogo&brand=aristo')).status,403);
 const users=await a.get('/auth/users',a.f.context),u=users.json.users.find(u=>u.id===a.id);assert.equal(u.campaignContentAccess.available,true);assert.equal(u.campaignContentAccess.writeReady,true);assert.equal(u.campaignContentAccess.catalogueReady,true);assert.doesNotMatch(JSON.stringify(u.campaignContentAccess),/dcrmw-|dcrm-|issuer|namespace|profileSha|panel:/);assert.equal(a.native,0);
 const before=a.proofs,unattested=await a.http.get(hosts.manager,'/auth/users',{cookie:a.f.context.cookieHeader,origin:a.f.context.origin});assert.equal(unattested.status,200);assert.equal(unattested.json.users.find(u=>u.id===a.id).campaignContentAccess.available,false);assert.equal(a.proofs,before);
});
test('actual READ catalogue remains scoped and a legitimate empty campaign library never advertises editing or creation',async t=>{
 const reader=await setup(t,{writer:false}),readOnly=await reader.get('/auth/session');assert.equal(readOnly.json.features.campaignSubmitWrite,false);const own=await reader.get('/api/campaigns?acao=campanha_catalogo&brand=fish');assert.equal(own.status,200);assert.deepEqual(own.json.templates.map(t=>t.id),[1]);assert.equal((await reader.post({acao:'campanha_validar',brand:'fish',id:100,expected_version:'a'.repeat(32),idempotency_key:'read-only-attempt-0001'})).status,403);assert.equal(reader.native,0);
 const a=await setup(t);await a.db.exec("UPDATE templates SET type='tx' WHERE id=1");const empty=await a.get('/api/campaigns?acao=campanha_catalogo&brand=fish');assert.equal(empty.status,200,JSON.stringify(empty.json));assert.equal(empty.json.current,true);assert.deepEqual(empty.json.templates,[]);assert.equal(empty.json.template_selection_available,false);const session=await a.get('/auth/session');assert.equal(session.json.features.campaignSubmitWrite,false);assert.equal(session.json.features.campaignCreate,false);assert.equal(session.json.features.campaignTemplateOwnershipUnavailable,false);
 const before=a.effects,rejected=await a.post({acao:'campanha_validar',brand:'fish',id:100,expected_version:'a'.repeat(32),idempotency_key:'empty-owned-library-0001'});assert.equal(rejected.status,503);assert.equal(a.effects,before);assert.equal(a.f.db.prepare('SELECT count(*) n FROM crm_campaign_delivery_v1').get().n,0);assert.equal(a.native,0);
});
test('disabled ownership trigger or drifted native IAM closes session and mutation before journal/provider effect',async t=>{
 const a=await setup(t);await a.db.exec('ALTER TABLE shrigma_template_email_registry DISABLE TRIGGER shrigma_campaign_template_registry_guard_v1');const before=a.effects,session=await a.get('/auth/session');assert.equal(session.json.features.campaignSubmitWrite,false);assert.equal(session.json.features.campaignTemplateOwnershipUnavailable,true);assert.equal((await a.get('/api/campaigns?acao=campanha_catalogo&brand=fish')).status,503);
 assert.equal((await a.post({acao:'campanha_validar',brand:'fish',id:100,expected_version:'a'.repeat(32),idempotency_key:'disabled-guard-attempt-01'})).status,503);assert.equal(a.effects,before+1);assert.equal(a.f.db.prepare('SELECT count(*) n FROM crm_campaign_delivery_v1').get().n,0);
 await a.db.exec('ALTER TABLE shrigma_template_email_registry ENABLE TRIGGER shrigma_campaign_template_registry_guard_v1');
 await a.db.exec('ALTER TABLE campaigns DISABLE TRIGGER shrigma_campaign_write_guard');assert.equal((await a.get('/auth/session')).json.features.campaignSubmitWrite,false);assert.equal((await a.post({acao:'campanha_validar',brand:'fish',id:100,expected_version:'a'.repeat(32),idempotency_key:'disabled-native-write-guard'})).status,503);await a.db.exec('ALTER TABLE campaigns ENABLE TRIGGER shrigma_campaign_write_guard');
 const providerSource=p=>read(p).match(/CREATE OR REPLACE FUNCTION public\.shrigma_campaign_provider\([\s\S]*?END \$fn\$;/)[0];
 // The recovery installer still carries an old provider without exclusive
 // template ownership; its exact body must never satisfy the current profile.
 await a.db.exec(providerSource('n8n/growth/campaign-recovery-install.sql'));assert.equal((await a.get('/auth/session')).json.features.campaignSubmitWrite,false);assert.equal((await a.get('/api/campaigns?acao=campanha_catalogo&brand=fish')).status,503);await a.db.exec(providerSource('n8n/growth/campaign-provider.sql'));
 await a.db.exec('GRANT SELECT ON lists TO crm_campaign_api');assert.equal((await a.get('/auth/session')).json.features.campaignSubmitWrite,false);await a.db.exec('REVOKE SELECT ON lists FROM crm_campaign_api');
 assert.equal((await a.get('/auth/session')).json.features.campaignSubmitWrite,true);
 await a.db.exec('UPDATE crm_manager_writer_issuer_v1 SET active=false');const revoked=await a.get('/auth/session');assert.equal(revoked.json.features.campaignSubmitWrite,false);assert.equal((await a.get('/api/campaigns?acao=campanha_catalogo&brand=fish')).status,200);assert.equal(a.native,0);
});
test('local revocation during native GET cannot publish a stale authenticated session or replay any write',async t=>{
 const a=await setup(t);let once=true;a.duringProof=async()=>{if(once){once=false;a.f.auth.revokeUser({context:a.f.context,userId:a.id});}};const result=await a.get('/auth/session');assert.deepEqual(result.json,{authenticated:false});assert.equal(a.native,0);assert.equal(a.effects,0);assert.equal(a.f.db.prepare('SELECT count(*) n FROM crm_campaign_delivery_v1').get().n,0);
});
test('the legitimate manager validates and schedules once through original BFF journal and native SQL provider, with cross-brand writes denied',async t=>{
 const a=await setup(t),C=require('../services/dashboard-operational/campaign-write-contract.js'),tracking=require('../services/dashboard-operational/campaign-write-tracking.js');
 const catalog=(await a.db.query("SELECT shrigma_campaign_catalog('fish') r")).rows[0].r,original=(await a.db.query('SELECT shrigma_campaign_current(100) r')).rows[0].r;
 const d={...original.definition,html:'<a href="https://fishermans.com.br/products/synthetic">Produto</a><a href="{{ UnsubscribeURL }}">Sair</a>',text:'https://fishermans.com.br/products/synthetic\n{{ UnsubscribeURL }}'};
 const prepared=C.prepare(d,{catalog,tracking,trackingId:100,now:a.f.now}).definition;
 // Fixture setup only: native guard receives its original writer GUC and no
 // provider receipt is fabricated. The tested mutations start below via HTTP.
 await a.db.exec('BEGIN');await a.db.query("SELECT set_config('shrigma.campaign_writer','100',true)");await a.db.query('UPDATE campaigns SET body=$1,altbody=$2 WHERE id=100',[prepared.html,prepared.text]);await a.db.exec('COMMIT');
 const current=(await a.db.query('SELECT shrigma_campaign_current(100) r')).rows[0].r;
 assert.equal((await a.post({acao:'campanha_validar',brand:'aristo',id:200,expected_version:current.version,idempotency_key:'cross-brand-native-write-01'})).status,403);
 const validated=await a.post({acao:'campanha_validar',brand:'fish',id:100,expected_version:current.version,idempotency_key:'actual-owned-validation-01'});assert.equal(validated.status,200,JSON.stringify(validated.json));assert.equal(validated.json.state,'succeeded',JSON.stringify(validated.json));
 const validation=(await a.db.query('SELECT validation FROM shrigma_campaign_validation WHERE provider_id=100')).rows[0].validation;
 const command={acao:'campanha_agendar',brand:'fish',id:100,expected_version:current.version,idempotency_key:'actual-owned-schedule-001',confirm:'agendar',audience_review_id:validation.audience.review_id};
 const scheduled=await a.post(command);assert.equal(scheduled.status,200,JSON.stringify(scheduled.json));assert.equal(scheduled.json.state,'succeeded');assert.equal((await a.db.query('SELECT status FROM campaigns WHERE id=100')).rows[0].status,'scheduled');
 const before=a.writes,replayed=await a.post(command);assert.equal(replayed.status,200);assert.equal(a.writes,before);assert.equal(a.writes,2);assert.equal((await a.db.query("SELECT count(*)::int n FROM shrigma_campaign_operation WHERE action='agendar' AND state='succeeded'")).rows[0].n,1);assert.equal(a.f.db.prepare("SELECT count(*) n FROM crm_campaign_delivery_v1 WHERE phase='succeeded'").get().n,2);assert.equal(a.native,0);
});
test('a non-cooperating GET transport cannot hold private admission past its hard deadline',async t=>{
 const a=await setup(t),{createContentAdmission}=require('../services/dashboard-operational/crm-campaign-content-admission.cjs'),runtime=require('../services/dashboard-operational/crm-manager-runtime.cjs');
 const descriptor=runtime.corporateWriterDescriptor(a.f.config.crmManagedWriter,a.f.config.crmManagedRead,a.f.config.allowedEmailDomains);
 const bridge=createContentAdmission({auth:a.f.auth,corporateWriter:descriptor,upstreams:{campaigns:new URL(P.REVIEWED_DYNAMIC.routes.campaigns)}},{deadlineMs:25,fetchImpl:()=>new Promise(()=>{})});
 const start=Date.now();await assert.rejects(bridge.attest(a.ctx,{brand:'fish',write:true}),e=>e.code==='BRAND_TEMPLATE_OWNERSHIP_NOT_READY');assert.ok(Date.now()-start<250);assert.equal(a.native,0);assert.equal(a.effects,0);
});
