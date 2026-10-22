'use strict';
// Actual bootstrap/password login, cookies, CSRF, SQLite, crypto and backend
// identity SQL. Requests use streams; no listening socket or remote effect.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Readable}=require('node:stream'),{EventEmitter}=require('node:events'),{PGlite}=require('@electric-sql/pglite');
const {fixture,hosts,pending,CAPS}=require('./corporate-writer-fixture.cjs');
const Server=require('../services/dashboard-operational/server.cjs'),Proxy=require('../services/dashboard-operational/proxy.cjs');
const Attest=require('../services/dashboard-operational/crm-campaign-writer-attestation.cjs');
const {diagnoseOwnMasterCampaignWriter}=require('../services/dashboard-operational/master-campaign-writer-diagnostic.cjs');
const URL_PATH='/auth/master/campaign-writer/activate',OWNER='felipebandeira@oaristocrata.com',KEY='synthetic-own-master-key',PRINCIPAL='synthetic-own-master-principal';
const source=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
function request(app,ctx,url=URL_PATH,{method='POST',body={},headers={}}={}){return new Promise(resolve=>{
 const req=Readable.from(method==='POST'?[Buffer.from(JSON.stringify(body))]:[],{objectMode:false});
 Object.assign(req,{url,method,headers:{host:ctx.host,origin:ctx.origin,cookie:ctx.cookieHeader,'x-csrf-token':ctx.csrf,'content-type':'application/json',...headers},socket:{remoteAddress:'127.0.0.1'}});
 const res=new EventEmitter(),responseHeaders={};res.setHeader=(k,v)=>{responseHeaders[k]=v;};res.end=value=>{res.emit('finish');resolve({status:res.statusCode,body:JSON.parse(String(value)),headers:responseHeaders});};app.emit('request',req,res);
});}
async function setup(t,{store=true,full=true,rawPrincipal=PRINCIPAL}={}){
 const f=await fixture(t),pg=new PGlite();t.after(()=>pg.close());
 await pg.exec(`CREATE TABLE public.crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL,dono text NOT NULL,ativo boolean NOT NULL DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer NOT NULL DEFAULT 0);
  CREATE TABLE public.shrigma_template_key_v2(actor text,capabilities jsonb,key_hash text,active boolean);`);
 for(const name of ['n8n/access/panel-auth.sql','n8n/access/panel-operator.sql','n8n/access/panel-short-keys.sql'])await pg.exec(source(name));
 await pg.exec('CREATE TABLE public.dash_payload_cache(painel text PRIMARY KEY,payload jsonb NOT NULL,gerado_em timestamptz NOT NULL,bytes bigint,origem_ms bigint);REVOKE ALL ON public.dash_payload_cache FROM PUBLIC;');
 await pg.exec(source('n8n/growth/crm-read-fast.sql'));
 await pg.query("INSERT INTO public.crm_dash_chave(chave,painel,dono,chave_hash) VALUES($1,'growth',$2,encode(sha256(convert_to($3,'UTF8')),'hex'))",[rawPrincipal,OWNER,KEY]);
 await pg.query("INSERT INTO public.shrigma_panel_permission_v1 VALUES($1,'growth','[\"read_content\",\"list_history\",\"submission\"]')",[rawPrincipal]);
 let projection=x=>x,during=null;const calls=[];
 const fetchImpl=async(url,options)=>{
  assert.equal(url,Attest.IDENTITY_URL);assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,'Bearer '+KEY);assert.equal(f.db.isTransaction,false,'GET must run outside SQLite mutation transaction');
  calls.push({url,method:options.method});
  const result=(await pg.query('SELECT * FROM public.shrigma_crm_read_fast_v1($1,NULL,$2::jsonb)',['Bearer '+KEY,JSON.stringify({action:'identity',painel:'growth'})])).rows[0];
  if(during)await during();
  const response=new Response(JSON.stringify(projection(result.body)),{status:result.status_code,headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:Attest.IDENTITY_URL});return response;
 };
 // The original setter accepts only READ. Seed through that real contract,
 // then the test backend's authoritative row explicitly gains Master caps.
 if(store)await f.auth.setCrmPanelReadCredential({context:f.context,userId:f.master.user.id,slot:'crm-panel-read',bearer:KEY,fetchImpl});
 const fullBackend=async()=>{await pg.query("UPDATE public.crm_dash_chave SET painel='todos' WHERE chave=$1",[rawPrincipal]);await pg.query("UPDATE public.shrigma_panel_permission_v1 SET caps=$1::jsonb WHERE principal_id=$2",[JSON.stringify(CAPS),rawPrincipal]);};
 if(full)await fullBackend();calls.length=0;
 const campaign=Proxy.REVIEWED_DYNAMIC.routes.campaigns,read=Proxy.FIXED_DESTINATIONS['crm-read'];
 const settings={...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,crmManagedWriter:{...f.config.crmManagedWriter,provisionerToken:'S'.repeat(43)},upstreams:{'crm-read':read,campaigns:campaign},allowedUpstreamHosts:[new URL(read).hostname,new URL(campaign).hostname],dynamicRouteManifest:{schema:Proxy.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:Proxy.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:campaign}},crmCorporateCreate:true};
 const make=(extra={})=>{const app=Server.createServer({...settings,...extra},{auth:f.auth,fetchImpl,managedCrmRuntime:{kick:async()=>{},close:async()=>{}}});assert.equal(app.listening,false);t.after(()=>app.removeAllListeners());return app;};
 const edited=()=>f.db.prepare("SELECT can_edit FROM grants WHERE user_id=? AND area='growth'").get(f.master.user.id).can_edit;
 const proof=()=>f.db.prepare('SELECT * FROM campaign_writer_attestation_v1 WHERE user_id=?').get(f.master.user.id);
 const zeroEdit=()=>{assert.equal(edited(),0);assert.equal(proof(),undefined);assert.equal(f.db.prepare("SELECT count(*) n FROM upstream_credentials WHERE user_id=? AND slot='growth-campaign'").get(f.master.user.id).n,0);assert.equal(f.events.length,0);};
 const diagnostic=()=>diagnoseOwnMasterCampaignWriter({dbPath:f.config.dbPath,encryptionKey:f.config.encryptionKey,fetchImpl});
 return {f,pg,fetchImpl,make,calls,settings,proof,edited,zeroEdit,diagnostic,fullBackend,set projection(fn){projection=fn;},set during(fn){during=fn;}};
}

test('one own-session empty-body activation proves Master via one real backend GET and changes only own Growth edit plus writer proof',async t=>{
 const a=await setup(t),before=a.f.masterBaseline(),read=a.f.db.prepare("SELECT * FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").get(a.f.master.user.id),app=a.make();a.zeroEdit();
 const result=await request(app,a.f.context);assert.equal(result.status,200,JSON.stringify(result));assert.deepEqual(result.body,{ok:true,ready:true});assert.equal(result.headers['Cache-Control'],'no-store');assert.equal(a.calls.length,1);
 const after=a.f.masterBaseline();assert.deepEqual(after.user,before.user);assert.deepEqual(after.grants.map(g=>({...g})),before.grants.map(g=>g.area==='growth'?{...g,can_edit:1}:{...g}));
 assert.deepEqual(a.f.db.prepare("SELECT * FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").get(a.f.master.user.id),read);
 const proof=a.proof();assert.equal(proof.owner,OWNER);assert.match(proof.principal_id,/^master-[a-f0-9]{64}$/);assert.notEqual(proof.principal_id,PRINCIPAL);assert.equal(proof.expires_at-proof.attested_at,14*86400000);assert.match(proof.master_proof_mac,/^[a-f0-9]{64}$/);
 assert.equal(a.f.auth.campaignWriterReady(a.f.context),true);assert.equal(a.f.events.length,0);assert.equal(a.f.db.prepare('SELECT count(*) n FROM crm_writer_bridge_life_v1').get().n,0);
 assert.equal(a.f.db.prepare('SELECT count(*) n FROM crm_campaign_create_v1').get().n,0);assert.equal(a.f.db.prepare('SELECT count(*) n FROM crm_campaign_delivery_v1').get().n,0);
 const session=await request(app,a.f.context,'/auth/session',{method:'GET'});assert.equal(session.body.features.campaignSubmitWrite,true);assert.equal(session.body.features.campaignCreate,true);
 for(const value of [KEY,PRINCIPAL]){assert.equal(JSON.stringify(result.body).includes(value),false);assert.equal(JSON.stringify(session.body).includes(value),false);}
 // Existing own growth-campaign source is verified afresh; no business replay.
 a.f.advance(1000);assert.equal((await request(app,a.f.context)).status,200);assert.equal(a.calls.length,2);assert.equal(a.proof().expires_at-a.proof().attested_at,14*86400000);
});

test('no own slot or current backend READ-only identity never grants edit',async t=>{
 for(const [options,expected,error,count]of [[{store:false},503,'INDIVIDUAL_CREDENTIAL_MISSING',0],[{full:false},403,'CREDENTIAL_ATTESTATION_FAILED',1]]){
  const a=await setup(t,options),result=await request(a.make(),a.f.context);assert.equal(result.status,expected);assert.equal(result.body.error,error);assert.equal(a.calls.length,count);a.zeroEdit();
 }
});

test('Origin, CSRF, real session, method, explicit gates and exact empty body reject before backend GET',async t=>{
 const a=await setup(t),app=a.make();
 for(const [ctx,options]of [
  [{...a.f.context,origin:'https://foreign.example.test'},{}],
  [{...a.f.context,csrf:'synthetic-wrong-csrf'},{}],
  [{...a.f.context,cookieHeader:''},{}],
  [a.f.context,{method:'GET'}],
  [a.f.context,{body:{userId:a.f.master.user.id}}],
  [a.f.context,{body:{bearer:KEY}}],
  [a.f.context,{body:{principalId:PRINCIPAL}}],
  [a.f.context,{body:{slot:'growth-campaign'}}],
  [a.f.context,{body:{expiresAt:a.f.now+86400000}}],
  [a.f.context,{body:[]}]
 ]){const result=await request(app,ctx,URL_PATH,options);assert.ok(result.status>=400);a.zeroEdit();}
 assert.equal((await request(app,a.f.context,URL_PATH+'?userId='+a.f.master.user.id)).status,400);
 const disabled=a.make({crmCampaignSubmitWrite:false,crmManagedWriter:undefined,crmCorporateCreate:false,upstreams:{'crm-read':Proxy.FIXED_DESTINATIONS['crm-read']},dynamicRouteManifest:undefined});assert.equal((await request(disabled,a.f.context)).body.error,'EDIT_NOT_READY');
 assert.equal(a.calls.length,0);a.zeroEdit();
});

test('actual backend wrong owner, revoked key and malformed role/principal/caps identity reject with zero edit',async t=>{
 const a=await setup(t),app=a.make();
 await a.pg.query("UPDATE crm_dash_chave SET dono='other@oaristocrata.com'");assert.equal((await request(app,a.f.context)).status,403);a.zeroEdit();await a.pg.query('UPDATE crm_dash_chave SET dono=$1',[OWNER]);
 await a.pg.query('UPDATE crm_dash_chave SET ativo=false');assert.equal((await request(app,a.f.context)).status,403);a.zeroEdit();await a.pg.query('UPDATE crm_dash_chave SET ativo=true');
 for(const patch of [x=>({...x,role:'manager'}),x=>({...x,panel:'growth'}),x=>({...x,preview:true}),x=>({...x,permissions:{...x.permissions,growth:{...x.permissions.growth,who:'arbitrary-principal'}}}),x=>({...x,permissions:{...x.permissions,growth:{...x.permissions.growth,caps:['read_content','draft','validate']}}}),x=>({...x,permissions:{...x.permissions,growth:{...x.permissions.growth,caps:[...CAPS,'send']}}})]){
  a.projection=patch;const result=await request(app,a.f.context);assert.equal(result.status,403);assert.equal(result.body.error,'CREDENTIAL_ATTESTATION_FAILED');a.zeroEdit();
 }
});

test('changed session, owner, source cipher, grants or newly pending operation during attestation cannot promote',async t=>{
 for(const mutate of [
  a=>a.f.auth.logout(a.f.context),
  a=>a.f.db.prepare("UPDATE users SET state='disabled' WHERE id=?").run(a.f.master.user.id),
  a=>a.f.db.prepare("UPDATE users SET email='other@oaristocrata.com' WHERE id=?").run(a.f.master.user.id),
  a=>a.f.db.prepare("UPDATE upstream_credentials SET encrypted_key='changed-fixture-cipher' WHERE user_id=? AND slot='crm-panel-read'").run(a.f.master.user.id),
  a=>a.f.db.prepare("UPDATE grants SET can_edit=1 WHERE user_id=? AND area='influs'").run(a.f.master.user.id),
  a=>pending(a.f,a.f.master.user.id,'crm_campaign_delivery_v1','queued')
 ]){
  const a=await setup(t);a.during=()=>mutate(a);const result=await request(a.make(),a.f.context);assert.ok(result.status>=400,JSON.stringify(result));assert.equal(a.calls.length,1);a.zeroEdit();
 }
});

test('foreign credential reuse and failed proof persistence cannot leave a partial Growth promotion or manager change',async t=>{
 const a=await setup(t),invite=a.f.invite('other-manager@oaristocrata.com'),other=invite.userId,before=a.f.db.prepare('SELECT * FROM users WHERE id=?').get(other),grants=a.f.db.prepare('SELECT * FROM grants WHERE user_id=? ORDER BY area').all(other),app=a.make();
 a.f.db.prepare('INSERT INTO upstream_credentials VALUES(?,?,?,?,?)').run(other,'growth-read',a.f.encrypt(KEY),a.f.digest(KEY),a.f.now);
 const reused=await request(app,a.f.context);assert.equal(reused.body.error,'CREDENTIAL_REUSED');assert.equal(a.calls.length,0);a.zeroEdit();a.f.db.prepare('DELETE FROM upstream_credentials WHERE user_id=?').run(other);
 a.f.db.exec("CREATE TRIGGER fixture_proof_failure BEFORE INSERT ON campaign_writer_attestation_v1 BEGIN SELECT RAISE(ABORT,'synthetic-proof-persistence-failure'); END;");
 const failed=await request(app,a.f.context);assert.equal(failed.status,500);assert.deepEqual(failed.body,{error:'INTERNAL_ERROR'});a.zeroEdit();
 assert.deepEqual(a.f.db.prepare('SELECT * FROM users WHERE id=?').get(other),before);assert.deepEqual(a.f.db.prepare('SELECT * FROM grants WHERE user_id=? ORDER BY area').all(other),grants);
});

test('legacy principal equal to stored bearer stays RAM-only and existing install hook still uses original expected-principal API',async t=>{
 const a=await setup(t,{rawPrincipal:KEY});assert.equal((await request(a.make(),a.f.context)).status,200);
 const dump=a.f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({name})=>a.f.db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all());assert.equal(JSON.stringify(dump).includes(KEY),false);
 await a.f.auth.installMasterCampaignWriter({context:a.f.context,userId:a.f.master.user.id,bearer:KEY,principalId:KEY,expiresAt:a.f.now+3600000,fetchImpl:a.fetchImpl});assert.equal(a.f.auth.campaignWriterReady(a.f.context),true);assert.equal(a.calls.length,2);
 await assert.rejects(Attest.verifyStoredMasterCampaignWriterCredential({bearer:KEY,owner:OWNER,principalId:KEY},{fetchImpl:a.fetchImpl}));assert.equal(a.calls.length,2);
});

test('DBRO diagnostic returns only closed states, accepts original growth-read and changes no SQLite data',async t=>{
 const a=await setup(t),before=a.f.masterBaseline();assert.deepEqual(await a.diagnostic(),{state:'ready'});assert.deepEqual(a.f.masterBaseline(),before);a.zeroEdit();
 a.f.db.prepare("DELETE FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").run(a.f.master.user.id);assert.deepEqual(await a.diagnostic(),{state:'no-slot'});a.zeroEdit();
 a.f.auth.setUpstreamCredential({context:a.f.context,userId:a.f.master.user.id,slot:'growth-read',bearer:KEY});const legacy=a.f.masterBaseline();assert.deepEqual(await a.diagnostic(),{state:'ready'});assert.deepEqual(a.f.masterBaseline(),legacy);a.zeroEdit();
 const activation=await request(a.make(),a.f.context);assert.deepEqual(activation.body,{ok:true,ready:true});assert.equal(a.f.auth.campaignWriterReady(a.f.context),true);assert.equal(a.edited(),1);assert.equal(a.calls.length,3);assert.equal(a.f.events.length,0);
 const promoted=a.f.masterBaseline();await a.pg.query('UPDATE crm_dash_chave SET ativo=false');assert.deepEqual(await a.diagnostic(),{state:'not-ready'});assert.deepEqual(a.f.masterBaseline(),promoted);
 assert.deepEqual(await diagnoseOwnMasterCampaignWriter({dbPath:a.f.config.dbPath,encryptionKey:crypto.randomBytes(32),fetchImpl:a.fetchImpl}),{state:'not-ready'});
});

test('DBRO diagnostic refuses a locally changed owner or slot while GET is in flight',async t=>{
 const a=await setup(t);a.during=()=>a.f.db.prepare("UPDATE upstream_credentials SET updated_at=updated_at+1 WHERE user_id=? AND slot='crm-panel-read'").run(a.f.master.user.id);
 assert.deepEqual(await a.diagnostic(),{state:'not-ready'});a.zeroEdit();
});

test('legacy growth-read promotion still rejects a bad all-brand MAC and a READ-only backend',async t=>{
 for(const invalidMac of [false,true]){const a=await setup(t,{store:false,full:false});a.f.auth.setUpstreamCredential({context:a.f.context,userId:a.f.master.user.id,slot:'growth-read',bearer:KEY});if(invalidMac)a.f.db.prepare("UPDATE upstream_brand_bindings_v1 SET binding_mac=? WHERE user_id=? AND slot='growth-read'").run('0'.repeat(64),a.f.master.user.id);const result=await request(a.make(),a.f.context);assert.ok(result.status>=400);assert.equal(a.calls.length,invalidMac?0:1);a.zeroEdit();}
});
