'use strict';
// Actual auth SQLite and authoritative identity/operator/campaign-auth SQL in
// disposable PGlite. The HTTP handlers use streams, without opening a socket.
// All identities, keys, campaign rows and provider effects below are synthetic.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Readable}=require('node:stream'),{EventEmitter}=require('node:events');
const {PGlite}=require('@electric-sql/pglite');
const {fixture,hosts,CAPS}=require('./corporate-writer-fixture.cjs');
const {createOrigin,definition}=require('./dashboard-operational-campaign-create-fixture.cjs');
const S=require('../services/dashboard-operational/server.cjs'),P=require('../services/dashboard-operational/proxy.cjs');
const Backend=require('../services/crm-campaign/server.cjs'),Transport=require('../services/crm-campaign/transport.cjs');
const A=require('../services/dashboard-operational/crm-campaign-writer-attestation.cjs');
const bearer='master-writer-fixture-key',principalId='fixture-master-principal',owner='felipebandeira@oaristocrata.com';
const campaignUrl=P.REVIEWED_DYNAMIC.routes.campaigns,readUrl=P.FIXED_DESTINATIONS['crm-read'];
const source=name=>fs.readFileSync(path.join(__dirname,'../',name),'utf8');
const command=(key='master_create_fixture_01',brand='fish')=>({acao:'campanha_criar',brand,definition:definition(brand),idempotency_key:key});
function request(app,ctx,url,{method='GET',body,headers={}}={}){return new Promise(resolve=>{
 const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))],{objectMode:false});Object.assign(req,{url,method,headers:{host:ctx.host,origin:ctx.origin,cookie:ctx.cookieHeader,'x-csrf-token':ctx.csrf,...(body===undefined?{}:{'content-type':'application/json'}),...headers},socket:{remoteAddress:'127.0.0.1'}});
 const res=new EventEmitter();res.setHeader=()=>{};res.end=bytes=>{res.emit('finish');resolve({status:res.statusCode,body:JSON.parse(String(bytes))});};app.emit('request',req,res);
});}
async function setup(t,{backendPrincipal=principalId}={}){
 const f=await fixture(t),pg=new PGlite();t.after(()=>pg.close());
 // An explicit existing admin operation grants local Growth edit. Bootstrap
 // is read-only; writer installation itself must never grant permission.
 f.auth.setGrants({context:f.context,userId:f.master.user.id,permissions:{growth:{read:true,edit:true},organico:{read:true,edit:false},influs:{read:true,edit:false}}});
 const login=await f.auth.login({email:owner,password:'Synthetic writer manager password 2026!',host:hosts.manager,origin:'https://'+hosts.manager});
 Object.assign(f.context,{cookieHeader:login.cookie.split(';')[0],csrf:login.csrf});
 // Native Postgres sha256 is used; no crypto/auth SQL function is stubbed.
 await pg.exec(`CREATE TABLE public.crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL,dono text NOT NULL,ativo boolean NOT NULL DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer NOT NULL DEFAULT 0);CREATE TABLE public.shrigma_template_key_v2(actor text,capabilities jsonb,key_hash text,active boolean);`);
 for(const name of ['n8n/access/panel-auth.sql','n8n/access/panel-operator.sql','n8n/access/panel-short-keys.sql'])await pg.exec(source(name));
 await pg.exec(`CREATE TABLE public.dash_payload_cache(painel text PRIMARY KEY,payload jsonb NOT NULL,gerado_em timestamptz NOT NULL,bytes bigint,origem_ms bigint);REVOKE ALL ON public.dash_payload_cache FROM PUBLIC;`);
 await pg.exec(source('n8n/growth/crm-read-fast.sql'));
 const sql=source('n8n/growth/crm-campaign-gateway-role.sql'),start=sql.indexOf('CREATE FUNCTION public.shrigma_crm_campaign_auth_v1('),end=sql.indexOf('CREATE FUNCTION public.shrigma_crm_campaign_effect_v1(',start);assert.ok(start>=0&&end>start);
 await pg.exec(sql.slice(start,end));
 await pg.query("INSERT INTO public.crm_dash_chave(chave,painel,dono,chave_hash) VALUES($1,'todos',$2,encode(sha256(convert_to($3,'UTF8')),'hex'))",[backendPrincipal,owner,bearer]);
 await pg.query("INSERT INTO public.shrigma_panel_permission_v1 VALUES($1,'growth',$2::jsonb),($1,'influs','[\"read_creators\"]')",[backendPrincipal,JSON.stringify(CAPS)]);
 const identity=async()=>{const r=(await pg.query('SELECT * FROM public.shrigma_crm_read_fast_v1($1,NULL,$2::jsonb)',['Bearer '+bearer,JSON.stringify({action:'identity',painel:'growth'})])).rows[0];assert.equal(r.status_code,200);return r.body;};
 let projection=x=>x;const attestFetch=async(url,options)=>{assert.equal(url,A.IDENTITY_URL);assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,'Bearer '+bearer);const r=new Response(JSON.stringify(projection(await identity())),{status:200,headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:A.IDENTITY_URL});return r;};
 const install=async(extra={})=>{const hook=f.auth.installMasterCampaignWriter||f.auth.installCampaignWriter;return hook({context:f.context,userId:f.master.user.id,bearer,principalId:backendPrincipal,expiresAt:f.now+3600000,fetchImpl:attestFetch,...extra});};
 const origin=createOrigin(()=>f.now),calls=[];let loseAck=false;
 const nativeAuth=async()=>(await pg.query(Transport.AUTH_SQL,[bearer])).rows[0].auth;
 const fetchImpl=async(url,options)=>{
  const u=new URL(url);assert.equal(u.origin+u.pathname,campaignUrl);
  const parsed=Backend.parse({method:options.method,headers:Object.fromEntries(Object.entries(options.headers).map(([k,v])=>[k.toLowerCase(),v])),rawHeaders:Object.entries(options.headers).flat()},u,options.method==='POST'?JSON.parse(options.body):undefined);assert.equal(parsed.key,bearer);
  const auth=await nativeAuth();assert.equal(auth.actor,'panel:'+backendPrincipal);
  calls.push({method:options.method,action:parsed.command.acao,actor:auth.actor});
  if(options.method==='POST'){assert.equal(f.db.isTransaction,false);const row=f.db.prepare('SELECT phase FROM crm_campaign_create_v1 WHERE remote_key=?').get(parsed.command.idempotency_key)||f.db.prepare('SELECT phase FROM crm_campaign_delivery_v1 WHERE remote_key=?').get(parsed.command.idempotency_key);assert.equal(row?.phase,'uncertain');}
  const result=await origin.service.handle(auth,parsed.command);if(loseAck&&options.method==='POST')throw Error('SYNTHETIC_LOST_ACK');return new Response(JSON.stringify(result.body),{status:result.status,headers:{'content-type':'application/json'}});
 };
 const settings={...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,crmManagedWriter:{...f.config.crmManagedWriter,provisionerToken:'S'.repeat(43)},upstreams:{'crm-read':readUrl,campaigns:campaignUrl},allowedUpstreamHosts:[new URL(readUrl).hostname,new URL(campaignUrl).hostname],dynamicRouteManifest:{schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:campaignUrl}},crmCorporateCreate:true};
 const make=()=>{const app=S.createServer(settings,{auth:f.auth,fetchImpl,managedCrmRuntime:{kick:async()=>{},close:async()=>{}}});t.after(()=>app.removeAllListeners());assert.equal(app.listening,false);return app;};
 return{f,pg,identity,install,origin,calls,nativeAuth,make,post:(app,q,ctx=f.context)=>request(app,ctx,'/auth/campaign-create',{method:'POST',body:q}),get:(app,q)=>request(app,f.context,'/auth/campaign-create?brand='+q.brand+'&idempotency_key='+q.idempotency_key),projection:fn=>{projection=fn;},loseAck:v=>{loseAck=v;}};
}

test('authoritative master four-cap identity enables its own production HTTP CREATE for both brands, without manager issuance or role/grant changes',async t=>{
 const a=await setup(t),before=a.f.masterBaseline(),identity=await a.identity();
 assert.equal(identity.role,'master');assert.equal(identity.panel,'todos');assert.deepEqual(identity.allowedPanels,['cx','growth','organico','influs']);assert.deepEqual(identity.permissions.growth.caps,CAPS);assert.deepEqual(await a.nativeAuth(),{actor:identity.permissions.growth.who,caps:CAPS});
 assert.equal(a.f.auth.campaignWriterReady(a.f.context),false);
 assert.deepEqual(await a.install(),{ok:true});assert.equal(a.f.auth.campaignWriterReady(a.f.context),true);
 const app=a.make(),session=await request(app,a.f.context,'/auth/session');assert.equal(session.body.user.role,'superadmin');assert.equal(session.body.features.campaignSubmitWrite,true);assert.equal(session.body.features.campaignCreate,true);assert.equal(session.body.features.campaignTemplateOwnershipUnavailable,false);
 for(const [i,brand]of ['fish','aristo'].entries()){const q=command('master_create_brand_'+i,brand),reply=await a.post(app,q);assert.equal(reply.status,200);assert.equal(reply.body.state,'succeeded');assert.equal(reply.body.campaign.status,'draft');assert.equal((await a.get(app,q)).body.campaign.id,reply.body.campaign.id);}
 assert.equal(a.origin.effects.create,2);assert.equal(a.calls.filter(x=>x.method==='POST').length,2);assert.equal(a.origin.effects.schedule,0);assert.deepEqual(a.f.masterBaseline().user,before.user);assert.deepEqual(a.f.masterBaseline().grants,before.grants);assert.equal(a.f.events.length,0);assert.equal(a.f.db.prepare('SELECT count(*) n FROM crm_writer_bridge_life_v1 WHERE user_id=?').get(a.f.master.user.id).n,0);
 const row=a.f.db.prepare('SELECT * FROM campaign_writer_attestation_v1').get();assert.match(row.master_proof_mac,/^[a-f0-9]{64}$/);assert.equal(row.owner,owner);assert.match(row.principal_id,/^master-[a-f0-9]{64}$/);assert.notEqual(row.principal_id,principalId);assert.equal(JSON.stringify(session.body).includes(bearer),false);
});

test('missing or forged attestation cannot turn an own growth-campaign credential into a production writer',async t=>{
 const a=await setup(t),app=a.make();assert.equal((await a.post(app,command())).status,403);assert.equal(a.calls.length,0);
 await a.install();const row=a.f.db.prepare('SELECT * FROM campaign_writer_attestation_v1').get();
 for(const field of ['master_proof_mac','principal_id','owner','expires_at','attested_at','credential_mac']){
  const changed=field==='master_proof_mac'?'0'.repeat(64):field==='expires_at'?row.expires_at+1:field==='attested_at'?row.attested_at-1:field==='credential_mac'?'1'.repeat(64):'other-fixture-principal';
  a.f.db.prepare('UPDATE campaign_writer_attestation_v1 SET '+field+'=? WHERE user_id=?').run(changed,row.user_id);
  assert.equal(a.f.auth.campaignWriterReady(a.f.context),false,field);assert.equal((await a.post(app,command('master_tamper_'+field))).status,403);a.f.db.prepare('UPDATE campaign_writer_attestation_v1 SET '+field+'=? WHERE user_id=?').run(row[field],row.user_id);
 }
 a.f.db.prepare('DELETE FROM campaign_writer_attestation_v1').run();assert.equal(a.f.auth.campaignWriterReady(a.f.context),false);assert.equal(a.calls.length,0);assert.equal(a.origin.effects.create,0);
});

test('master attestation refuses manager/anonymous identities, ownership/principal/schema conflicts, missing or widened caps',async t=>{
 const a=await setup(t),baseline=a.f.masterBaseline();
 const patches=[x=>({...x,role:'manager'}),x=>({...x,role:'anonymous'}),x=>({...x,panel:'growth'}),x=>({...x,owner:'other@oaristocrata.com'}),x=>({...x,allowedPanels:['growth']}),x=>({...x,extra:true}),x=>({...x,permissions:{...x.permissions,growth:null}}),x=>({...x,permissions:{...x.permissions,growth:{...x.permissions.growth,who:'panel:other-fixture-principal'}}}),x=>({...x,permissions:{...x.permissions,growth:{...x.permissions.growth,label:'other@oaristocrata.com'}}}),...[[...CAPS,'crm_send'],['read_content','list_history','submission'],CAPS.slice(0,3),[...CAPS].reverse()].map(caps=>x=>({...x,permissions:{...x.permissions,growth:{...x.permissions.growth,caps}}}))];
 for(const patch of patches){a.projection(patch);await assert.rejects(a.install(),e=>e.code==='CREDENTIAL_ATTESTATION_FAILED');assert.equal(a.f.db.prepare('SELECT count(*) n FROM campaign_writer_attestation_v1').get().n,0);}
 assert.deepEqual(a.f.masterBaseline(),baseline);assert.equal(a.calls.length,0);
});

test('no private master hook accepts another user, invalid lifetime, lost CSRF or a changed local grant during attestation',async t=>{
 const a=await setup(t),id=await a.f.manager();
 for(const extra of [{userId:id},{expiresAt:a.f.now},{expiresAt:a.f.now+15*86400000},{context:{...a.f.context,csrf:'synthetic-wrong-csrf'}}])await assert.rejects(a.install(extra));
 a.projection(x=>{a.f.db.prepare("UPDATE grants SET can_edit=0 WHERE user_id=? AND area='growth'").run(a.f.master.user.id);return x;});await assert.rejects(a.install(),e=>e.code==='GRANT_DENIED');assert.equal(a.f.db.prepare('SELECT count(*) n FROM campaign_writer_attestation_v1').get().n,0);assert.equal(a.calls.length,0);
});

test('manager FULL still fails ownership HTTP gate; master installation does not open manager promotion or unverified setters',async t=>{
 const a=await setup(t),id=await a.f.manager(),ctx=await a.f.login();await a.f.issue(id);await a.install();const app=a.make(),reply=await a.post(app,command(),ctx);assert.equal(reply.status,503);assert.equal(reply.body.error,'BRAND_TEMPLATE_OWNERSHIP_NOT_READY');assert.equal(a.calls.length,0);
 await assert.rejects(a.f.auth.installCampaignWriter({context:a.f.context,userId:id,bearer:'a'.repeat(64),principalId:'dcrmw-'+ 'b'.repeat(32),expiresAt:a.f.now+3600000}),e=>e.code==='EDIT_NOT_READY');
 assert.throws(()=>a.f.auth.setUpstreamCredential({context:a.f.context,userId:a.f.master.user.id,slot:'growth-campaign',bearer}),e=>e.code==='CREDENTIAL_ATTESTATION_REQUIRED');
});

test('reduced authoritative submit permission is reevaluated by the real gateway before any SQL/native effect; reinstall also refuses',async t=>{
 const a=await setup(t);await a.install();await a.pg.query("UPDATE public.shrigma_panel_permission_v1 SET caps=$1::jsonb WHERE principal_id=$2 AND area='growth'",[JSON.stringify(CAPS.slice(0,3)),principalId]);
 let effects=0;const execute=Transport.createExecutor({pool:{query:async(sql,args)=>{if(sql===Transport.AUTH_SQL)return a.pg.query(sql,args);effects++;throw Error('NO_EFFECT_ALLOWED');}},native:async()=>{effects++;throw Error('NO_NATIVE_ALLOWED');}});
 const result=await execute({key:bearer,command:{acao:'campanha_agendar',brand:'fish',id:7,expected_version:'a'.repeat(32),confirm:'agendar',idempotency_key:'master_reduced_submit_01',audience_review_id:'11111111-1111-4111-8111-111111111111'}});assert.equal(result.status,403);assert.equal(result.body.error,'CAPABILITY_MISSING');assert.equal(effects,0);await assert.rejects(a.install(),e=>e.code==='CREDENTIAL_ATTESTATION_FAILED');
});

test('lost ACK retains encrypted master journal across restart and resolves by GET only; rotation and local permission reduction never replay',async t=>{
 const a=await setup(t);await a.install();const q=command(),app=a.make();a.loseAck(true);const first=await a.post(app,q);assert.equal(first.status,202);assert.equal(first.body.state,'pending');assert.equal(a.origin.effects.create,1);
 const prior=a.f.db.prepare('SELECT * FROM crm_campaign_create_v1').get();assert.equal(prior.phase,'uncertain');assert.match(prior.input_ciphertext,/^v1\./);assert.notEqual(prior.remote_key,prior.client_key);assert.equal(a.calls.filter(x=>x.method==='POST').length,1);await assert.rejects(a.install(),e=>e.code==='CAMPAIGN_RECONCILIATION_REQUIRED');
 a.f.restart();a.loseAck(false);const recovered=await a.get(a.make(),q);assert.equal(recovered.status,200);assert.equal(recovered.body.state,'succeeded');assert.equal(a.origin.effects.create,1);assert.equal(a.calls.filter(x=>x.method==='POST').length,1);
 const historical=a.f.db.prepare('SELECT * FROM crm_campaign_create_v1').get();a.f.auth.setGrants({context:a.f.context,userId:a.f.master.user.id,permissions:{growth:{read:true,edit:false},organico:{read:true,edit:false},influs:{read:true,edit:false}}});assert.equal(a.f.auth.campaignWriterReady(a.f.context),false);assert.deepEqual(a.f.db.prepare('SELECT * FROM crm_campaign_create_v1').get(),historical);assert.equal(a.calls.filter(x=>x.method==='POST').length,1);
});

test('master editor GET and save/validate/schedule use production profile, current audience review and one journal POST per action',async t=>{
 const a=await setup(t);await a.install();const app=a.make();
 const catalog=await request(app,a.f.context,'/api/campaigns?acao=campanha_catalogo&brand=fish');assert.equal(catalog.status,200);
 const created=await a.post(app,command());assert.equal(created.status,200);let row=created.body.campaign;
 const save={acao:'campanha_salvar',brand:'fish',id:row.id,expected_version:row.version,idempotency_key:'master_editor_save_01',definition:{...definition(),send_at:new Date(a.f.now+3600000).toISOString()}};
 const saved=await request(app,a.f.context,'/api/campaigns',{method:'POST',body:save});assert.equal(saved.status,200);assert.equal(saved.body.state,'succeeded');row=saved.body.campaign;
 const validate={acao:'campanha_validar',brand:'fish',id:row.id,expected_version:row.version,idempotency_key:'master_editor_validate_01'};
 const validated=await request(app,a.f.context,'/api/campaigns',{method:'POST',body:validate});assert.equal(validated.status,200);assert.equal(validated.body.state,'succeeded');assert.equal(validated.body.validation.audience.eligible_count,2);
 const schedule={acao:'campanha_agendar',brand:'fish',id:row.id,expected_version:row.version,idempotency_key:'master_editor_schedule_01',confirm:'agendar',audience_review_id:validated.body.validation.audience.review_id};
 const scheduled=await request(app,a.f.context,'/api/campaigns',{method:'POST',body:schedule});assert.equal(scheduled.status,200);assert.equal(scheduled.body.state,'succeeded');assert.equal(scheduled.body.campaign.status,'scheduled');
 const again=await request(app,a.f.context,'/api/campaigns',{method:'POST',body:schedule});assert.equal(again.status,200);assert.equal(again.body.state,'succeeded');
 // CREATE itself saves its normalized definition once; the editor save is
 // the second provider update. Repeated schedule makes no extra provider call.
 assert.deepEqual(a.origin.effects,{create:1,save:2,validate:1,schedule:1,cancel:0});assert.equal(a.calls.filter(x=>x.method==='POST').length,4);assert.equal(a.f.db.prepare("SELECT count(*) n FROM crm_campaign_delivery_v1 WHERE phase='succeeded'").get().n,3);
});

test('old six-column attestations migrate without gaining master authority; expired master proof stays closed',async t=>{
 const a=await setup(t);await a.install();const original=a.f.db.prepare('SELECT user_id,owner,principal_id,credential_mac,expires_at,attested_at FROM campaign_writer_attestation_v1').get();
 a.f.db.exec('ALTER TABLE campaign_writer_attestation_v1 DROP COLUMN master_proof_mac');a.f.restart();assert.deepEqual(a.f.db.prepare('SELECT user_id,owner,principal_id,credential_mac,expires_at,attested_at FROM campaign_writer_attestation_v1').get(),original);assert.equal(a.f.auth.campaignWriterReady(a.f.context),false);
 await a.install({expiresAt:a.f.now+300000});a.f.advance(300001);assert.equal(a.f.auth.campaignWriterReady(a.f.context),false);assert.equal((await a.post(a.make(),command())).status,403);assert.equal(a.calls.length,0);
});

test('master campaign GET without a writer, with invalid proof or after authoritative read_content revocation never exposes catalog',async t=>{
 const a=await setup(t),app=a.make(),url='/api/campaigns?acao=campanha_catalogo&brand=fish';
 assert.equal((await request(app,a.f.context,url)).status,503);assert.equal(a.calls.length,0);
 await a.install();const proof=a.f.db.prepare('SELECT master_proof_mac FROM campaign_writer_attestation_v1').get().master_proof_mac;a.f.db.prepare('UPDATE campaign_writer_attestation_v1 SET master_proof_mac=?').run('0'.repeat(64));assert.equal(a.f.auth.campaignWriterReady(a.f.context),false);assert.equal((await request(app,a.f.context,url)).status,503);assert.equal(a.calls.length,0);
 a.f.db.prepare('UPDATE campaign_writer_attestation_v1 SET master_proof_mac=?').run(proof);
 await a.pg.query("UPDATE public.shrigma_panel_permission_v1 SET caps=$1::jsonb WHERE principal_id=$2 AND area='growth'",[JSON.stringify(CAPS.slice(1)),principalId]);
 // Stored local proof has a TTL, not a claim that remote grants never change.
 // The actual backend operator grants are checked again on every GET/POST.
 const denied=await request(app,a.f.context,url);assert.equal(denied.status,403);assert.equal(denied.body.error,'CAPABILITY_MISSING');assert.equal(denied.body.lists,undefined);assert.equal(a.calls.length,1);assert.equal(a.calls[0].method,'GET');assert.equal(a.origin.effects.create,0);await assert.rejects(a.install(),e=>e.code==='CREDENTIAL_ATTESTATION_FAILED');
});

test('legacy master principal equal to its real synthetic bearer stays RAM-only: local SQLite/session/journal contain only encrypted credential and segregated actor HMAC',async t=>{
 const a=await setup(t,{backendPrincipal:bearer});const identity=await a.identity();assert.equal(identity.permissions.growth.who,'panel:'+bearer);await a.install();
 const stored=a.f.db.prepare('SELECT * FROM campaign_writer_attestation_v1').get();assert.match(stored.principal_id,/^master-[a-f0-9]{64}$/);assert.notEqual(stored.principal_id,bearer);assert.notEqual(stored.principal_id,'master-'+a.f.digest(bearer));await a.install();assert.equal(a.f.db.prepare('SELECT principal_id FROM campaign_writer_attestation_v1').get().principal_id,stored.principal_id);
 const app=a.make(),q=command(),reply=await a.post(app,q);assert.equal(reply.status,200);assert.equal(reply.body.state,'succeeded');assert.equal((await a.get(app,q)).body.state,'succeeded');
 const dump=a.f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({name})=>({table:name,rows:a.f.db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all()}));
 assert.equal(JSON.stringify(dump).includes(bearer),false);assert.equal(JSON.stringify(reply.body).includes(bearer),false);assert.equal(JSON.stringify((await request(app,a.f.context,'/auth/session')).body).includes(bearer),false);assert.equal(a.origin.effects.create,1);assert.equal(a.calls.filter(x=>x.method==='POST').length,1);
});

test('master promotion refuses a credential owned elsewhere and opaque actor uniqueness conflict rolls back without overwriting either user',async t=>{
 const a=await setup(t),other=await a.f.manager();
 a.f.db.prepare('INSERT INTO upstream_credentials(user_id,slot,encrypted_key,key_digest,updated_at) VALUES(?,?,?,?,?)').run(other,'growth-campaign-read',a.f.encrypt(bearer),a.f.digest(bearer),a.f.now);
 await assert.rejects(a.install(),e=>e.code==='CREDENTIAL_REUSED');assert.equal(a.f.db.prepare("SELECT count(*) n FROM upstream_credentials WHERE user_id=? AND slot='growth-campaign'").get(a.f.master.user.id).n,0);assert.equal(a.f.db.prepare('SELECT count(*) n FROM campaign_writer_attestation_v1').get().n,0);
 a.f.db.prepare("DELETE FROM upstream_credentials WHERE user_id=? AND slot='growth-campaign-read'").run(other);await a.install();const master=a.f.db.prepare('SELECT * FROM campaign_writer_attestation_v1 WHERE user_id=?').get(a.f.master.user.id),credential=a.f.db.prepare("SELECT * FROM upstream_credentials WHERE user_id=? AND slot='growth-campaign'").get(a.f.master.user.id);
 a.f.db.prepare('DELETE FROM campaign_writer_attestation_v1 WHERE user_id=?').run(a.f.master.user.id);a.f.db.prepare('INSERT INTO campaign_writer_attestation_v1(user_id,owner,principal_id,credential_mac,expires_at,attested_at) VALUES(?,?,?,?,?,?)').run(other,'manager@oaristocrata.com',master.principal_id,'0'.repeat(64),master.expires_at,master.attested_at);
 const foreign=a.f.db.prepare('SELECT * FROM campaign_writer_attestation_v1 WHERE user_id=?').get(other);await assert.rejects(a.install(),e=>e.code==='ERR_SQLITE_ERROR'&&e.message.includes('principal_id')&&!e.message.includes(bearer));assert.deepEqual(a.f.db.prepare("SELECT * FROM upstream_credentials WHERE user_id=? AND slot='growth-campaign'").get(a.f.master.user.id),credential);assert.deepEqual(a.f.db.prepare('SELECT * FROM campaign_writer_attestation_v1 WHERE user_id=?').get(other),foreign);assert.equal(a.f.auth.campaignWriterReady(a.f.context),false);assert.equal(a.calls.length,0);
});
