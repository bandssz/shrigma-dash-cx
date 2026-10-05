'use strict';
// Compiled portal, original cookie/CSRF auth, disposable SQLite and PGlite.
// Only fixture identities/operator rows are synthetic. No network socket,
// real credentials, campaign provider write or send is used.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {fixture,hosts,CAPS}=require('./corporate-writer-fixture.cjs');
const {shell,transport,until}=require('./helpers/claude-portal-pages.cjs');
const S=require('../services/dashboard-operational/server.cjs'),P=require('../services/dashboard-operational/proxy.cjs');
const A=require('../services/dashboard-operational/crm-campaign-writer-attestation.cjs');
const OWNER='felipebandeira@oaristocrata.com',KEY='synthetic-master-own-ui-key',PRINCIPAL='synthetic-master-own-ui-principal',ACTIVATE='/auth/master/campaign-writer/activate';
const source=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
async function setup(t,{full=true,gates=true,values=new Map(),loseAck=null,wrapHttp=x=>x}={}){
 const f=await fixture(t),pg=new PGlite();t.after(()=>pg.close());
 await pg.exec(`CREATE TABLE public.crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL,dono text NOT NULL,ativo boolean NOT NULL DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer NOT NULL DEFAULT 0);
 CREATE TABLE public.shrigma_template_key_v2(actor text,capabilities jsonb,key_hash text,active boolean);`);
 for(const n of ['n8n/access/panel-auth.sql','n8n/access/panel-operator.sql','n8n/access/panel-short-keys.sql'])await pg.exec(source(n));
 await pg.exec('CREATE TABLE public.dash_payload_cache(painel text PRIMARY KEY,payload jsonb NOT NULL,gerado_em timestamptz NOT NULL,bytes bigint,origem_ms bigint);REVOKE ALL ON public.dash_payload_cache FROM PUBLIC;');
 await pg.exec(source('n8n/growth/crm-read-fast.sql'));
 await pg.query("INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash) VALUES($1,'growth',$2,encode(sha256(convert_to($3,'UTF8')),'hex'))",[PRINCIPAL,OWNER,KEY]);
 await pg.query("INSERT INTO shrigma_panel_permission_v1 VALUES($1,'growth','[\"read_content\",\"list_history\",\"submission\"]')",[PRINCIPAL]);
 let during=null,reads=0,business=0,contentReads=0;
 const fetchImpl=async(url,options)=>{
  const u=new URL(url);
  if(u.origin+u.pathname===P.REVIEWED_DYNAMIC.routes.campaigns&&u.searchParams.get('acao')==='campanha_acesso'){
   assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(u.searchParams.get('brand'),'fish');assert.match(options.headers.Authorization,/^Bearer [a-f0-9]{64}$/);
   contentReads++;const r=new Response(JSON.stringify({error:'CONTENT_AUTHORITY_NOT_READY'}),{status:503,headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:u.href});return r;
  }
  if(url!==A.IDENTITY_URL){business++;throw Error('Synthetic fixture does not permit business HTTP');}
  reads++;assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,'Bearer '+KEY);assert.equal(f.db.isTransaction,false);
  const result=(await pg.query('SELECT * FROM shrigma_crm_read_fast_v1($1,NULL,$2::jsonb)',['Bearer '+KEY,JSON.stringify({action:'identity',painel:'growth'})])).rows[0];
  if(during)await during();
  const response=new Response(JSON.stringify(result.body),{status:result.status_code,headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:A.IDENTITY_URL});return response;
 };
 await f.auth.setCrmPanelReadCredential({context:f.context,userId:f.master.user.id,slot:'crm-panel-read',bearer:KEY,fetchImpl});
 if(full){await pg.query("UPDATE crm_dash_chave SET painel='todos' WHERE chave=$1",[PRINCIPAL]);await pg.query('UPDATE shrigma_panel_permission_v1 SET caps=$1::jsonb WHERE principal_id=$2',[JSON.stringify(CAPS),PRINCIPAL]);}
 reads=0;
 const read=P.FIXED_DESTINATIONS['crm-read'],campaign=P.REVIEWED_DYNAMIC.routes.campaigns;
 const settings={...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,crmManagedWriter:{...f.config.crmManagedWriter,provisionerToken:'S'.repeat(43)},upstreams:{'crm-read':read,campaigns:campaign},allowedUpstreamHosts:[new URL(read).hostname,new URL(campaign).hostname],dynamicRouteManifest:{schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:campaign}},crmCorporateCreate:true};
 if(!gates)Object.assign(settings,{crmCampaignSubmitWrite:false,crmManagedWriter:undefined,crmCorporateCreate:false,upstreams:{'crm-read':read},dynamicRouteManifest:undefined});
 const app=S.createServer(settings,{auth:f.auth,fetchImpl,managedCrmRuntime:{kick:async()=>{},close:async()=>{}}});assert.equal(app.listening,false);t.after(()=>app.removeAllListeners());
 const http=wrapHttp(transport(app)),make=()=>shell(http,{host:hosts.manager,area:'gestao',cookie:f.context.cookieHeader,values,loseAck});
 const ui=make();await ui.ready();await until(()=>!ui.el('entry-shell').hidden,'own Master shell');
 const manage=async(x=ui)=>{x.el('entry-manage').click();await until(()=>!x.el('admin-panel').hidden&&x.document.querySelector('.user-row'),'actual access list');};
 const edit=()=>f.db.prepare("SELECT can_edit FROM grants WHERE user_id=? AND area='growth'").get(f.master.user.id).can_edit;
 return {f,pg,ui,http,make,manage,edit,get reads(){return reads;},get business(){return business;},get contentReads(){return contentReads;},set during(fn){during=fn;}};
}
const rowFor=(ui,email=OWNER)=>[...ui.document.querySelectorAll('.user-row')].find(r=>r.querySelector('strong')?.textContent===email);
const posts=ui=>ui.calls.filter(c=>c.method==='POST'&&c.path===ACTIVATE);
const preservedJournal=brand=>{const key='synthetic_preserved_attempt_'+brand;return JSON.stringify({schema:'crm-campaign-bff-client-v1',brand,action:'campanha_validar',attemptKey:key,command:{acao:'campanha_validar',brand,id:7,expected_version:'a'.repeat(32),idempotency_key:key},phase:'uncertain'});};
const assertZeroWrites=a=>{assert.equal(a.edit(),0);assert.equal(a.f.db.prepare('SELECT count(*) n FROM campaign_writer_attestation_v1').get().n,0);assert.equal(a.f.events.length,0);assert.equal(a.business,0);};

test('own Master actual button posts once with existing CSRF and confirms CRM-only edit without changing another area or browser journal',async t=>{
 const values=new Map(),a=await setup(t,{values}),baseline=a.f.masterBaseline();values.set('shrigma_campaign_bff_v1:'+a.f.master.uiKey+':fish',preservedJournal('fish'));const beforeStorage=[...values];await a.manage();
 const button=a.ui.el('admin-master-crm-activate');assert.ok(button);assert.equal(button.textContent,'Ativar edição do CRM');assert.match(rowFor(a.ui).textContent,/CRM · somente leitura/);
 let release;const wait=new Promise(r=>{release=r;});a.during=()=>wait;
 button.click();button.click();await until(()=>a.reads===1,'one authenticated identity GET');assert.equal(button.disabled,true);release();
 await until(()=>posts(a.ui).length===1&&a.ui.el('admin-message').textContent.startsWith('Edição de campanhas no CRM confirmada'),'activation confirmed by session GET');
 assert.deepEqual(posts(a.ui)[0].body,{});assert.equal(posts(a.ui)[0].status,200);assert.equal(a.ui.el('admin-master-crm-activate'),null);assert.match(rowFor(a.ui).textContent,/CRM · edição de campanhas ativa/);
 const after=a.f.masterBaseline();assert.deepEqual(after.user,baseline.user);assert.deepEqual(after.grants.map(g=>({...g})),baseline.grants.map(g=>({...g,...(g.area==='growth'?{can_edit:1}:{})})));assert.equal(a.edit(),1);assert.equal(a.reads,1);assert.equal(a.business,0);assert.equal(a.f.events.length,0);assert.deepEqual([...values],beforeStorage);
 const crm=a.ui.el('entry-nav').querySelector('[data-area="growth"]');crm.click();assert.equal(a.ui.el('entry-campaign-open').hidden,false);assert.equal(a.ui.el('entry-campaign-open').textContent,'Editar campanhas');
 for(const secret of [KEY,PRINCIPAL]){assert.equal(JSON.stringify(a.ui.calls).includes(secret),false);assert.equal(JSON.stringify([...values]).includes(secret),false);}
});

test('current backend READ-only identity keeps compiled Master UI honest and makes no campaign write or retry',async t=>{
 const a=await setup(t,{full:false});await a.manage();a.ui.el('admin-master-crm-activate').click();
 await until(()=>posts(a.ui).length===1&&a.ui.el('admin-message').textContent.includes('continua em leitura'),'READ refusal');
 assert.equal(posts(a.ui)[0].status,403);assert.equal(a.reads,1);assert.match(rowFor(a.ui).textContent,/CRM · somente leitura/);assert.ok(a.ui.el('admin-master-crm-activate'));assert.equal(a.ui.el('entry-campaign-open').hidden,true);assertZeroWrites(a);
});

test('revoked authoritative Master key is refused through the real button and retains read-only local permission',async t=>{
 const a=await setup(t);await a.pg.query('UPDATE crm_dash_chave SET ativo=false');await a.manage();a.ui.el('admin-master-crm-activate').click();
 await until(()=>posts(a.ui).length===1&&a.ui.el('admin-message').textContent.includes('continua em leitura'),'revoked key refusal');
 assert.equal(posts(a.ui)[0].status,403);assert.equal(a.reads,1);assertZeroWrites(a);
});

test('explicit gates OFF expose no activation button and do not send an activation POST',async t=>{
 const a=await setup(t,{gates:false});await a.manage();assert.equal(a.ui.el('admin-master-crm-activate'),null);assert.match(rowFor(a.ui).textContent,/CRM · somente leitura/);assert.equal(posts(a.ui).length,0);assert.equal(a.reads,0);assertZeroWrites(a);
});

test('a foreign user row never receives own-Master activation and a real manager session exposes none',async t=>{
 const a=await setup(t,{wrapHttp:http=>({...http,get:async(host,p,ctx)=>{const r=await http.get(host,p,ctx);if(p==='/auth/users')r.json={users:r.json.users.map(u=>u.role==='superadmin'?{...u,id:'b1111111-1234-4234-8234-123456789abc',email:'other@oaristocrata.com'}:u)};return r;}})});
 await a.manage();assert.equal(a.ui.el('admin-master-crm-activate'),null);assert.equal(posts(a.ui).length,0);
 await a.f.manager();const ctx=await a.f.login();const manager=shell(a.http,{host:hosts.growth,area:'crm',cookie:ctx.cookieHeader});await manager.ready();await until(()=>!manager.el('entry-shell').hidden,'actual manager shell');assert.equal(manager.el('entry-manage').hidden,true);assert.equal(manager.el('admin-master-crm-activate'),null);assert.equal(posts(manager).length,0);assert.equal(a.contentReads,1,'only current read-only admission GET; unavailable SQL closes editing');assertZeroWrites(a);
});

test('lost activation ACK is reconciled only by real session/access GETs and reloading never repeats it or removes campaign journal',async t=>{
 const values=new Map();let lose=true;const a=await setup(t,{values,loseAck:(method,body)=>lose&&method==='POST'&&Object.keys(body||{}).length===0});values.set('shrigma_campaign_bff_v1:'+a.f.master.uiKey+':aristo',preservedJournal('aristo'));const prior=[...values];await a.manage();a.ui.el('admin-master-crm-activate').click();
 await until(()=>posts(a.ui).length===1&&a.ui.el('admin-message').textContent.startsWith('Edição de campanhas no CRM confirmada'),'GET confirms lost ACK');
 assert.equal(a.edit(),1);assert.equal(a.reads,1);assert.equal(a.business,0);assert.deepEqual([...values],prior);assert.equal(a.ui.el('admin-master-crm-activate'),null);
 lose=false;const reload=a.make();await reload.ready();await until(()=>!reload.el('entry-shell').hidden,'reloaded Master shell');await a.manage(reload);assert.equal(reload.el('admin-master-crm-activate'),null);assert.equal(posts(reload).length,0);assert.equal(a.reads,1);assert.deepEqual([...values],prior);
});

test('real own session revoked during the proof returns to login without stale access rows, edit or replay',async t=>{
 const a=await setup(t);await a.manage();a.during=()=>a.f.auth.logout(a.f.context);a.ui.el('admin-master-crm-activate').click();
 await until(()=>posts(a.ui).length===1&&!a.ui.el('entry-login').hidden,'revoked session login');assert.equal(posts(a.ui)[0].status,401);assert.equal(a.ui.el('admin-users').children.length,0);assert.equal(a.ui.el('admin-master-crm-activate'),null);assert.equal(a.reads,1);assertZeroWrites(a);
});
