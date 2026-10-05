'use strict';
// Real Auth/SQLite, original IAM SQL in disposable PGlite, and stream HTTP
// handlers. Synthetic credentials/provider only; no remote effects or sends.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{Readable}=require('node:stream'),{EventEmitter}=require('node:events'),{PGlite}=require('@electric-sql/pglite');
const {createAuth}=require('../services/dashboard-operational/auth.cjs'),S=require('../services/dashboard-operational/server.cjs'),P=require('../services/dashboard-operational/proxy.cjs'),R=require('../services/dashboard-operational/crm-manager-runtime.cjs'),A=require('../services/dashboard-operational/crm-campaign-writer-attestation.cjs');
const {createOrigin,definition}=require('./dashboard-operational-campaign-create-fixture.cjs'),Backend=require('../services/crm-campaign/server.cjs');
const hosts={manager:'gerencial.shrigma.com.br',growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'},owner='felipebandeira@oaristocrata.com',password='Synthetic master production password 2026!',bearer='synthetic-own-master-production-key',principal='synthetic-own-master-principal',CAPS=['read_content','draft','validate','submit'];
const profile='own-master-production-v1',campaignUrl=P.REVIEWED_DYNAMIC.routes.campaigns,readUrl=P.FIXED_DESTINATIONS['crm-read'];
const source=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
function request(app,ctx,url,{method='GET',body}={}){return new Promise(resolve=>{
 const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))],{objectMode:false});Object.assign(req,{url,method,headers:{host:ctx.host,origin:ctx.origin,cookie:ctx.cookieHeader,'x-csrf-token':ctx.csrf,...(body===undefined?{}:{'content-type':'application/json'})},socket:{remoteAddress:'127.0.0.1'}});
 const res=new EventEmitter();res.setHeader=()=>{};res.end=bytes=>{res.emit('finish');resolve({status:res.statusCode,body:JSON.parse(String(bytes))});};app.emit('request',req,res);
});}
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'own-master-production-')),dbPath=path.join(dir,'identity.sqlite'),encryptionKey=crypto.randomBytes(32);let now=1791000000000;
 const config={dbPath,encryptionKey,managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},allowedEmailDomains:['oaristocrata.com','shrigma.com.br','fishermans.com.br'],bootstrapAdminEmail:owner,bootstrapTokenSha256:crypto.createHash('sha256').update('synthetic-bootstrap').digest('hex'),now:()=>now,crmCampaignSubmitWrite:true,crmCampaignWriterProfile:profile};
 let auth=createAuth(config);await auth.completeBootstrap({email:owner,token:'synthetic-bootstrap',password,host:hosts.manager,origin:'https://'+hosts.manager});
 const login=async(host=hosts.manager,email=owner)=>{const l=await auth.login({email,password,host,origin:'https://'+host});return{host,method:'POST',origin:'https://'+host,cookieHeader:l.cookie.split(';')[0],csrf:l.csrf};};
 const context=await login(),db=new DatabaseSync(dbPath),pg=new PGlite();
 await pg.exec('CREATE TABLE public.crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL,dono text NOT NULL,ativo boolean NOT NULL DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer NOT NULL DEFAULT 0);CREATE TABLE public.shrigma_template_key_v2(actor text,capabilities jsonb,key_hash text,active boolean);CREATE TABLE public.dash_payload_cache(painel text PRIMARY KEY,payload jsonb NOT NULL,gerado_em timestamptz NOT NULL,bytes bigint,origem_ms bigint);');
 for(const name of ['n8n/access/panel-auth.sql','n8n/access/panel-operator.sql','n8n/access/panel-short-keys.sql','n8n/growth/crm-read-fast.sql'])await pg.exec(source(name));
 await pg.query("INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash) VALUES($1,'todos',$2,encode(sha256(convert_to($3,'UTF8')),'hex'))",[principal,owner,bearer]);await pg.query("INSERT INTO shrigma_panel_permission_v1 VALUES($1,'growth',$2::jsonb)",[principal,JSON.stringify(CAPS)]);
 const masterId=auth.session(context).user.id;auth.setUpstreamCredential({context,userId:masterId,slot:'growth-read',bearer});
 let identityCalls=0,loseAck=false,emptyCatalog=false,bodyCalls=[];
 const attestFetch=async(url,o)=>{identityCalls++;assert.equal(url,A.IDENTITY_URL);assert.equal(o.method,'GET');assert.equal(o.headers.Authorization,'Bearer '+bearer);assert.equal(db.isTransaction,false);const r=(await pg.query('SELECT * FROM shrigma_crm_read_fast_v1($1,NULL,$2::jsonb)',['Bearer '+bearer,JSON.stringify({action:'identity',painel:'growth'})])).rows[0];const response=new Response(JSON.stringify(r.body),{status:r.status_code,headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;};
 const nativeOptions=()=>{const operationId=crypto.randomUUID(),expiresAt=now+300000,programSha256='a'.repeat(64),scope=JSON.stringify({schema:'CRM_NATIVE_OWN_MASTER_SQLITE_WRITER_V1',operationId,owner,action:'install-own-master-campaign-writer',programSha256,expiresAt});return{operationId,programSha256,expiresAt,authorizationMac:crypto.createHmac('sha256',encryptionKey).update('native-own-master-sqlite-writer-v1:'+scope).digest('hex'),fetchImpl:attestFetch};};
 const origin=createOrigin(()=>now),settings={...config,mode:'operational',upstreamProfile:'production',crmCorporateCreate:true,upstreams:{'crm-read':readUrl,campaigns:campaignUrl},allowedUpstreamHosts:[new URL(readUrl).hostname,new URL(campaignUrl).hostname],dynamicRouteManifest:{schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:campaignUrl}}};
 const fetchImpl=async(url,o)=>{const u=new URL(url);assert.equal(u.origin+u.pathname,campaignUrl);const parsed=Backend.parse({method:o.method,headers:Object.fromEntries(Object.entries(o.headers).map(([k,v])=>[k.toLowerCase(),v])),rawHeaders:Object.entries(o.headers).flat()},u,o.method==='POST'?JSON.parse(o.body):undefined);assert.equal(parsed.key,bearer);const q=parsed.command;bodyCalls.push({method:o.method,action:q.acao,id:q.id??null});const reply=await origin.service.handle({actor:'panel:'+principal,caps:CAPS},q);if(emptyCatalog&&q.acao==='campanha_catalogo')reply.body={...reply.body,templates:[]};if(loseAck&&o.method==='POST')throw Error('SYNTHETIC_ACK_LOST');return new Response(JSON.stringify(reply.body),{status:reply.status,headers:{'content-type':'application/json'}});};
 const app=()=>{const a=S.createServer(settings,{auth,fetchImpl});t.after(()=>a.removeAllListeners());return a;};
 const baseline=()=>({user:db.prepare('SELECT * FROM users WHERE id=?').get(masterId),grants:db.prepare('SELECT * FROM grants WHERE user_id=? ORDER BY area').all(masterId),sessions:db.prepare('SELECT * FROM sessions ORDER BY token_hash').all()});
 t.after(async()=>{auth.close();db.close();await pg.close();fs.rmSync(dir,{recursive:true,force:true});encryptionKey.fill(0);});
 return{config,settings,db,pg,context,login,masterId,nativeOptions,activate:extra=>auth.activateNativeOwnMasterCampaignWriter({...nativeOptions(),...extra}),app,origin,bodyCalls,baseline,get auth(){return auth;},get identityCalls(){return identityCalls;},set loseAck(v){loseAck=v;},set emptyCatalog(v){emptyCatalog=v;},advance:n=>{now+=n;},restart(){auth.close();auth=createAuth(config);}};
}
const create=(brand,key)=>({acao:'campanha_criar',brand,definition:definition(brand),idempotency_key:key});

test('explicit own Master production profile admits no issuer, token, worker or forged descriptor',async t=>{
 const a=await setup(t);assert.equal(a.auth.managedCrmJournal,undefined);assert.equal(a.auth.managedCampaignWriterJournal,undefined);assert.equal(S.managedRuntimeFor(a.settings,a.auth),undefined);
 const env={DASHBOARD_MODE:'operational',DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:profile,DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_CRM_CORPORATE_CREATE:'enabled',DASHBOARD_MANAGER_HOST:hosts.manager,DASHBOARD_AREA_HOSTS:JSON.stringify(a.config.areaHosts),DASHBOARD_EMAIL_DOMAINS:JSON.stringify(a.config.allowedEmailDomains),DASHBOARD_ADMIN_EMAIL:owner,DASHBOARD_DB_PATH:a.config.dbPath,DASHBOARD_BOOTSTRAP_SHA256:a.config.bootstrapTokenSha256,DASHBOARD_ENCRYPTION_KEY:a.config.encryptionKey.toString('hex'),DASHBOARD_UPSTREAMS:JSON.stringify(a.settings.upstreams),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(a.settings.allowedUpstreamHosts),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify(a.settings.dynamicRouteManifest)};
 assert.equal(S.settingsFromEnv(env).crmCampaignWriterProfile,profile);
 for(const delta of [{DASHBOARD_CRM_MANAGED_READ:'enabled'},{DASHBOARD_CRM_MANAGER_PROVISIONER_TOKEN:'x'.repeat(43)},{DASHBOARD_CRM_MANAGED_WRITER:'enabled'},{DASHBOARD_CRM_AUDIENCE_DRAFT:'enabled'},{DASHBOARD_ADMIN_EMAIL:'other@oaristocrata.com'},{DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:'anything'}])assert.throws(()=>S.settingsFromEnv({...env,...delta}));
 assert.throws(()=>P.validateUpstreams(a.settings.upstreams,a.settings.allowedUpstreamHosts,a.settings.dynamicRouteManifest,'production',{crmCampaignSubmitWrite:true,crmCorporateWriter:{mode:profile}}));
 assert.equal(R.isCorporateWriterDescriptor(R.ownMasterWriterDescriptor(profile,a.config.allowedEmailDomains)),false);
});

test('native own Master authority retains key/HMAC/4caps/one-shot and only Growth promotion',async t=>{
 const a=await setup(t),before=a.baseline();await assert.rejects(a.activate({authorizationMac:'0'.repeat(64)}),e=>e.code==='NATIVE_MASTER_AUTHORIZATION_REQUIRED');assert.equal(a.identityCalls,0);
 assert.deepEqual(await a.activate(),{ok:true,ready:true,actor:'native-integrator',attemptMustRemainConsumed:true});assert.equal(a.identityCalls,1);
 const after=a.baseline();assert.deepEqual(after.user,before.user);assert.deepEqual(after.sessions,before.sessions);for(const area of ['organico','influs'])assert.deepEqual(after.grants.find(x=>x.area===area),before.grants.find(x=>x.area===area));assert.equal(after.grants.find(x=>x.area==='growth').can_edit,1);
 a.restart();await assert.rejects(a.activate(),e=>e.code==='NATIVE_MASTER_ATTEMPT_CONSUMED');assert.equal(a.identityCalls,1);
 const row=a.db.prepare('SELECT * FROM campaign_writer_attestation_v1').get();assert.match(row.principal_id,/^master-[a-f0-9]{64}$/);assert.equal(JSON.stringify(row).includes(bearer),false);a.db.prepare('UPDATE campaign_writer_attestation_v1 SET master_proof_mac=?').run('0'.repeat(64));assert.equal(a.auth.campaignWriterReady(a.context),false);
});

test('reduced real IAM caps consume native attempt without any local writer even after restart',async t=>{
 const a=await setup(t);await a.pg.query('UPDATE shrigma_panel_permission_v1 SET caps=$1::jsonb WHERE principal_id=$2',['["read_content"]',principal]);
 await assert.rejects(a.activate(),e=>e.code==='CREDENTIAL_ATTESTATION_FAILED');assert.equal(a.db.prepare("SELECT can_edit FROM grants WHERE user_id=? AND area='growth'").get(a.masterId).can_edit,0);assert.equal(a.db.prepare('SELECT 1 FROM campaign_writer_attestation_v1').get(),undefined);a.restart();await assert.rejects(a.activate(),e=>e.code==='NATIVE_MASTER_ATTEMPT_CONSUMED');assert.equal(a.identityCalls,1);
});

test('CRM literal uses real host-bound Master login; admin/other areas and crossed host/CSRF remain closed',async t=>{
 const a=await setup(t);await a.activate();const crm=await a.login(hosts.growth),app=a.app();assert.equal(a.auth.campaignWriterReady(crm),true);assert.equal((await request(app,crm,'/auth/session')).body.features.campaignSubmitWrite,true);
 assert.equal(a.auth.session({...crm,host:hosts.manager}).authenticated,false);assert.equal(a.auth.session({...a.context,host:hosts.growth}).authenticated,false);
 assert.throws(()=>a.auth.authorize({...crm,admin:true}),e=>e.code==='ADMIN_REQUIRED');assert.throws(()=>a.auth.authorize({...crm,area:'organico'}),e=>e.code==='AREA_DENIED');assert.throws(()=>a.auth.authorize({...crm,area:'influs'}),e=>e.code==='AREA_DENIED');
 for(const host of [hosts.organico,hosts.influs])await assert.rejects(a.login(host),e=>e.code==='AUTH_INVALID');
 const q=create('fish','own_master_wrong_origin_01');assert.equal((await request(app,{...crm,origin:'https://'+hosts.manager},'/auth/campaign-create',{method:'POST',body:q})).status,403);assert.equal((await request(app,{...crm,csrf:a.context.csrf},'/auth/campaign-create',{method:'POST',body:q})).status,403);assert.equal(a.origin.effects.create,0);
});

test('own Master CREATE/save/validate and lost ACK recovery retain real catalog and one POST journals for both brands',async t=>{
 const a=await setup(t);await a.activate();const crm=await a.login(hosts.growth);let app=a.app();
 for(const [i,brand]of ['fish','aristo'].entries()){
  const q=create(brand,'own_master_real_create_'+i);a.loseAck=i===0;const result=await request(app,crm,'/auth/campaign-create',{method:'POST',body:q});assert.equal(result.status,i===0?202:200);a.loseAck=false;
  if(i===0){a.restart();app=a.app();}
  const receipt=await request(app,crm,'/auth/campaign-create?brand='+brand+'&idempotency_key='+q.idempotency_key);assert.equal(receipt.status,200);assert.equal(receipt.body.campaign.status,'draft');assert.equal(receipt.body.campaign.sent,0);
  const row=receipt.body.campaign,save={acao:'campanha_salvar',brand,id:row.id,expected_version:row.version,idempotency_key:'own_master_save_'+i,definition:{...definition(brand),name:'Updated safe synthetic draft'}};
  const saved=await request(app,crm,'/api/campaigns',{method:'POST',body:save});assert.equal(saved.status,200);const validate={acao:'campanha_validar',brand,id:row.id,expected_version:saved.body.campaign.version,idempotency_key:'own_master_validate_'+i};assert.equal((await request(app,crm,'/api/campaigns',{method:'POST',body:validate})).status,200);
 }
 assert.equal(a.origin.effects.create,2);assert.equal(a.origin.effects.save,4);assert.equal(a.origin.effects.validate,2);assert.equal(a.origin.effects.schedule,0);assert.equal(a.bodyCalls.filter(c=>c.method==='POST'&&c.action==='campanha_salvar'&&c.id===null).length,2);
 a.emptyCatalog=true;const refused=await request(app,crm,'/auth/campaign-create',{method:'POST',body:create('fish','own_master_empty_catalog_01')});assert.equal(refused.status,409);assert.equal(a.origin.effects.create,2);
});

test('manager intent, stale grants or private setters cannot enable own Master profile writing',async t=>{
 const a=await setup(t),i=a.auth.createInvite({context:a.context,email:'synthetic-manager@fishermans.com.br',areas:['growth'],brand:'fish',requestedAccess:'edit'});await a.auth.acceptInvite({token:i.token,password,host:hosts.growth,origin:'https://'+hosts.growth});const ctx=await a.login(hosts.growth,'synthetic-manager@fishermans.com.br');
 const listed=a.auth.users({context:a.context}).find(u=>u.id===i.userId);assert.equal(listed.requestedAccess,'edit');assert.deepEqual(listed.crmAccess,{state:'unavailable',ready:false,operational:false,reason:'INDIVIDUAL_ACCESS_NOT_READY',renewalPhase:null,expired:false,canRenew:false});assert.equal(listed.permissions.growth.edit,false);
 assert.throws(()=>a.auth.setGrants({context:a.context,userId:i.userId,permissions:{growth:{read:true,edit:true}}}),e=>e.code==='EDIT_NOT_READY');await assert.rejects(a.auth.installCampaignWriter({context:a.context,userId:i.userId,bearer:'a'.repeat(64),principalId:'dcrmw-'+'b'.repeat(32),expiresAt:1791000000000+300000}),e=>e.code==='EDIT_NOT_READY');
 a.db.prepare("UPDATE grants SET can_edit=1 WHERE user_id=? AND area='growth'").run(i.userId);assert.equal(a.auth.campaignWriterReady(ctx),false);assert.equal(a.auth.approveManagedCampaignWriter,undefined);
 const app=a.app();assert.equal((await request(app,ctx,'/auth/session')).body.features.campaignSubmitWrite,false);assert.equal((await request(app,ctx,'/auth/campaign-create',{method:'POST',body:create('fish','manager_closed_own_master_01')})).status,403);assert.equal(a.bodyCalls.length,0);
});

test('manager own profile public metadata reports the unavailable direct access instead of active reading or writing',()=>{
 const entry=source('services/dashboard-operational/public/entry.js'),start=entry.indexOf(' function crmAccessLabel('),end=entry.indexOf(' async function saveAccessRequest(');assert.ok(start>=0&&end>start);
 const element=()=>({children:[],textContent:'',append(...c){this.children.push(...c);},setAttribute(){},addEventListener(){}}),text=n=>[n.textContent,...n.children.map(text)].filter(Boolean).join(' | '),ctx={document:{createElement:element},AREAS:{growth:{label:'CRM'}},saveAccessRequest(){},revoke(){}};
 require('node:vm').runInNewContext(entry.slice(start,end)+'\nglobalThis.render=userRow;',ctx);
 for(const requestedAccess of ['read','edit']){const rendered=text(ctx.render({id:'synthetic-manager-id',role:'manager',email:'synthetic-manager@fishermans.com.br',areas:['growth'],brand:'fish',brandAccess:'single',status:'active',permissions:{growth:{read:true,edit:false}},requestedAccess,crmAccess:{state:'unavailable',ready:false,operational:false,reason:'INDIVIDUAL_ACCESS_NOT_READY',canRenew:false,renewalPhase:null},campaignContentAccess:{available:false}}));assert.match(rendered,/Cadastro preservado · acesso individual ainda não habilitado/);assert.match(rendered,/Cadastro ativo/);assert.doesNotMatch(rendered,/Somente leitura|Edição ativa|Edição configurada|Conteúdo em leitura|Renovar acesso CRM|Aprovar edição/);}
});
