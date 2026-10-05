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


// Reuse the existing authoritative SQL/SQLite master fixture above and the
// portal's compiled shell. Only identities/provider rows in this test are fake.
const {shell,transport,until}=require('./helpers/claude-portal-pages.cjs');
const {createCampaignBffClient}=require('../services/dashboard-operational/crm-campaign-bff-client.cjs');
async function masterUi(t,{installed=true,loseAck=null,wrapHttp=x=>x,values=new Map()}={}){
 const a=await setup(t);a.f.advance(Date.now()-a.f.now);
 // The compiled shell uses the browser clock. Renew only this disposable
 // session after moving its fixture clock, so the real five-minute review
 // is evaluated at the same instant; no production timing guard is changed.
 const login=await a.f.auth.login({email:owner,password:'Synthetic writer manager password 2026!',host:hosts.manager,origin:'https://'+hosts.manager});Object.assign(a.f.context,{cookieHeader:login.cookie.split(';')[0],csrf:login.csrf});
 if(installed)await a.install();const http=wrapHttp(transport(a.make()));
 const ui=shell(http,{host:hosts.manager,area:'gestao',cookie:a.f.context.cookieHeader,values,loseAck});
 await ui.ready();await until(()=>!ui.el('entry-shell').hidden,'master shell');
 return {a,ui,http};
}
async function open(ui){assert.equal(ui.el('entry-campaign-open').hidden,false);ui.el('entry-campaign-open').click();await until(()=>ui.dialog.open&&!ui.el('campaign-new').disabled,'campaign catalog');}
function journal(ui,brand){const row=[...ui.values].find(([k])=>k.startsWith('shrigma_campaign_bff_v1:')&&k.endsWith(':'+brand));return row?JSON.parse(row[1]):null;}
function draft(ui,brand){
 ui.el('campaign-new').click();const d=definition(brand);
 for(const [field,key]of [['name','name'],['subject','subject'],['from','from_email'],['reply','reply_to'],['html','html'],['text','text']])ui.input('campaign-'+field,d[key]);
 ui.input('campaign-initiative-key',d.initiative.key);ui.input('campaign-initiative-name',d.initiative.name);ui.input('campaign-utm',d.utm_campaign);
 const list=ui.el('campaign-lists').querySelector('input');assert.equal(Number(list.value),d.list_ids[0]);list.checked=true;list.dispatchEvent(new ui.window.Event('input',{bubbles:true}));
}
async function action(ui,name){const button=ui.el('campaign-'+name);assert.equal(button.disabled,false,name);const before=ui.calls.filter(x=>x.method==='POST').length;button.click();await until(()=>ui.calls.filter(x=>x.method==='POST').length===before+1&&!ui.el('campaign-consult').disabled&&journal(ui,ui.el('campaign-brand').value)?.phase==='succeeded',name);await until(()=>ui.calls.at(-1)?.path.includes('campanha_obter')&&!ui.el('campaign-fields').disabled||name==='schedule'&&ui.el('campaign-state').textContent.includes('scheduled'),name+' readback');}

test('attested production MASTER opens the real shell and creates, saves, reviews and schedules once in each authorized brand',async t=>{
 const {a,ui}=await masterUi(t),baseline=a.f.masterBaseline();await open(ui);
 assert.equal(ui.el('campaign-brand').disabled,false);assert.deepEqual([...ui.el('campaign-brand').querySelectorAll('option')].map(o=>o.value),['fish','aristo']);
 for(const [i,brand]of ['fish','aristo'].entries()){
  if(i){const before=ui.calls.length;ui.select('campaign-brand',brand);await until(()=>ui.calls.length>before&&!ui.el('campaign-new').disabled&&ui.calls.at(-1)?.path.includes('campanha_listar'),'brand read');}
  assert.equal(ui.el('campaign-brand').value,brand);draft(ui,brand);await action(ui,'create');
  assert.equal(journal(ui,brand).brand,brand);ui.input('campaign-time',new Date(a.f.now+3600000).toISOString().slice(0,16));await action(ui,'save');await action(ui,'validate');
  assert.equal(ui.el('campaign-schedule').disabled,true);ui.check('campaign-confirm');await action(ui,'schedule');assert.match(ui.el('campaign-state').textContent,/scheduled/);
 }
 assert.deepEqual(a.origin.effects,{create:2,save:4,validate:2,schedule:2,cancel:0});assert.equal(a.calls.filter(x=>x.method==='POST').length,8);
 assert.equal(new Set(ui.calls.filter(x=>x.method==='POST').map(x=>x.body.idempotency_key)).size,8);
 assert.deepEqual(a.f.masterBaseline().user,baseline.user);assert.deepEqual(a.f.masterBaseline().grants,baseline.grants);assert.equal(a.f.events.length,0);
 assert.equal(journal(ui,'fish').brand,'fish');assert.equal(journal(ui,'aristo').brand,'aristo');assert.equal(JSON.stringify([...ui.values]).includes(bearer),false);assert.equal(JSON.stringify(ui.calls).includes(bearer),false);
});

test('missing or invalid backend attestation keeps MASTER shell closed and sends no campaign POST',async t=>{
 const {a,ui}=await masterUi(t,{installed:false});assert.equal(ui.el('entry-campaign-open').hidden,true);ui.el('entry-campaign-open').click();await new Promise(r=>setImmediate(r));assert.equal(ui.dialog.open,false);assert.equal(a.calls.length,0);
 await a.install();a.f.db.prepare('UPDATE campaign_writer_attestation_v1 SET master_proof_mac=?').run('0'.repeat(64));
 const another=shell(transport(a.make()),{host:hosts.manager,area:'gestao',cookie:a.f.context.cookieHeader});await another.ready();await until(()=>!another.el('entry-shell').hidden,'invalid-proof shell');assert.equal(another.el('entry-campaign-open').hidden,true);assert.equal(a.calls.length,0);
});

test('SOURCE BFF rejects missing feature, forged MASTER scope, revoked Growth and unauthenticated session before journal or POST',async t=>{
 const {a}=await masterUi(t);const current=(await request(a.make(),a.f.context,'/auth/session')).body;let session=current,requests=0,writes=0;
 const client=createCampaignBffClient({getSession:()=>session,readJournal:()=>null,writeJournal:()=>{writes++;},request:async()=>{requests++;throw Error('unexpected request');}});
 const changed=[x=>({...x,authenticated:false}),x=>({...x,features:{...x.features,campaignSubmitWrite:false,campaignHistoryRead:false}}),x=>({...x,features:{...x.features,campaignSubmitWrite:false,campaignHistoryRead:true}}),x=>({...x,user:{...x.user,brands:['fish']}}),x=>({...x,user:{...x.user,brands:['fish','fish']}}),x=>({...x,user:{...x.user,brand:'fish'}}),x=>({...x,user:{...x.user,brandAccess:'single'}}),x=>({...x,user:{...x.user,areas:['growth']}}),x=>({...x,user:{...x.user,areas:['growth','organico','organico']}}),x=>({...x,user:{...x.user,areas:['cx','growth','organico','influs']}}),x=>({...x,user:{...x.user,role:'analyst'}}),x=>({...x,user:{...x.user,permissions:{...x.user.permissions,growth:{read:false,edit:true}}}}),x=>({...x,user:{...x.user,permissions:{...x.user.permissions,growth:{read:true,edit:false}}}})];
 for(const change of changed){session=change(structuredClone(current));await assert.rejects(client.create({brand:'fish',definition:definition(),idempotency_key:'master_forged_ui_case'}),e=>e.code==='CAMPAIGN_BFF_DENIED');}
 assert.equal(requests,0);assert.equal(writes,0);assert.equal(a.calls.length,0);
 // Positive SOURCE client uses the same real attested /auth/session, cookie,
 // CSRF, SQLite journals and backend handler; the user is never relabeled.
 session=current;const rows=new Map(),app=a.make(),storageKey=s=>s.uiKey+':'+s.brand;
 const real=createCampaignBffClient({getSession:()=>session,readJournal:s=>rows.get(storageKey(s))??null,writeJournal:(s,row)=>rows.set(storageKey(s),row),request:q=>request(app,a.f.context,q.path,{method:q.method,body:q.body,headers:q.headers})});
 for(const [i,brand]of ['fish','aristo'].entries()){const reply=await real.create({brand,definition:definition(brand),idempotency_key:'master_source_success_'+i});assert.equal(reply.state,'succeeded');assert.equal((await real.consult(brand)).state,'succeeded');assert.equal(rows.get(current.uiKey+':'+brand).brand,brand);}
 assert.equal(a.calls.filter(x=>x.method==='POST').length,2);assert.equal(a.origin.effects.create,2);assert.equal(rows.size,2);
});

test('lost CREATE ACK and brand switches preserve separate MASTER journals; reconciliation is exact GET with zero POST replay',async t=>{
 let lose=true;const {a,ui}=await masterUi(t,{loseAck:(method,body)=>lose&&method==='POST'&&body?.acao==='campanha_criar'&&body.brand==='fish'});await open(ui);draft(ui,'fish');ui.el('campaign-create').click();
 await until(()=>journal(ui,'fish')?.phase==='uncertain'&&!ui.el('campaign-consult').disabled,'uncertain fish ACK');const key=journal(ui,'fish').attemptKey;assert.equal(a.origin.effects.create,1);const posted=ui.calls.filter(x=>x.method==='POST').length;
 lose=false;ui.select('campaign-brand','aristo');await until(()=>!ui.el('campaign-new').disabled&&ui.calls.at(-1)?.path.includes('campanha_listar'),'aristo catalog');assert.equal(journal(ui,'aristo'),null);assert.equal(ui.el('campaign-name').value,'');assert.equal(journal(ui,'fish').phase,'uncertain');
 ui.select('campaign-brand','fish');await until(()=>journal(ui,'fish').phase==='succeeded'&&ui.el('campaign-state').textContent.includes('draft')&&!ui.el('campaign-fields').disabled,'fish GET reconciliation');
 assert.ok(ui.calls.some(x=>x.method==='GET'&&x.path==='/auth/campaign-create?brand=fish&idempotency_key='+key));assert.equal(ui.calls.filter(x=>x.method==='POST').length,posted);assert.equal(a.origin.effects.create,1);
 const before=ui.calls.length;const fake=ui.document.createElement('option');fake.value='foreign';ui.el('campaign-brand').append(fake);ui.select('campaign-brand','foreign');await new Promise(r=>setImmediate(r));assert.equal(ui.el('campaign-brand').value,'fish');assert.equal(ui.calls.length,before);
});

test('late fish read after switching MASTER to aristo cannot restore fish form or issue POST',async t=>{
 let release,held=false,hold=false;const gate=new Promise(r=>{release=r;});
 const {a,ui}=await masterUi(t,{wrapHttp:http=>({...http,get:async(host,p,ctx)=>{const result=await http.get(host,p,ctx);if(hold&&p.includes('campanha_catalogo')&&p.includes('brand=fish')){held=true;await gate;}return result;}})});
 await open(ui);draft(ui,'fish');await action(ui,'create');const fishName=ui.el('campaign-name').value;const posted=ui.calls.filter(x=>x.method==='POST').length;
 hold=true;ui.el('campaign-refresh').click();await until(()=>held,'held fish read');ui.select('campaign-brand','aristo');await until(()=>ui.el('campaign-brand').value==='aristo'&&!ui.el('campaign-new').disabled&&ui.calls.at(-1)?.path.includes('campanha_listar'),'aristo current');
 const priorFishLists=ui.calls.filter(x=>x.path.includes('campanha_listar')&&x.path.includes('brand=fish')).length;release();await until(()=>ui.calls.filter(x=>x.path.includes('campanha_listar')&&x.path.includes('brand=fish')).length===priorFishLists+1,'late fish read chain completed');
 assert.equal(ui.el('campaign-brand').value,'aristo');assert.equal(ui.el('campaign-name').value,'');assert.ok(!ui.el('campaign-state').textContent.includes(fishName));assert.equal(ui.calls.filter(x=>x.method==='POST').length,posted);assert.equal(journal(ui,'fish').phase,'succeeded');assert.equal(journal(ui,'aristo'),null);assert.equal(a.origin.effects.create,1);
});
