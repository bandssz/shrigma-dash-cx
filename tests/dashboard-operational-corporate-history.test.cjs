'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{Readable}=require('node:stream'),{EventEmitter}=require('node:events');
const {parseHTML}=require('linkedom'),{fixture,hosts}=require('./corporate-writer-fixture.cjs');
const Server=require('../services/dashboard-operational/server.cjs'),{createCampaignBffClient}=require('../services/dashboard-operational/public/campaign-bff-client.js'),{createCampaignEditor}=require('../services/dashboard-operational/public/campaign-edit.compiled.js');
const V='a'.repeat(32),KEY='corporate_history_attempt_01';
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v),sha=v=>crypto.createHash('sha256').update(canonical(v)).digest('hex');
const q=(brand='fish')=>({acao:'campanha_validar',brand,id:7,expected_version:V,idempotency_key:KEY});
const receipt=(row,state='pending')=>({status:state==='pending'?202:200,body:{schema:'crm-campaign-bff-operation-v1',action:row.action,attemptKey:row.attemptKey,state,campaign:state==='pending'?null:{id:row.command.id||70,version:V,status:'draft',sent:0,startedAt:null,sendAt:null},validation:null}});
const journal=(brand='fish',action='campanha_validar')=>({schema:'crm-campaign-bff-client-v1',brand,action,attemptKey:KEY,command:action==='campanha_criar'?{acao:action,brand,idempotency_key:KEY,definition:{brand,send_at:null}}:q(brand),phase:'uncertain'});
const session=letter=>({authenticated:true,uiKey:'ui-'+letter.repeat(32),csrf:'c'.repeat(43),features:{campaignSubmitWrite:false,campaignCreate:false,campaignHistoryRead:true},user:{role:'manager',areas:['growth'],permissions:{growth:{read:true,edit:true}}}});
function settings(f){const url='https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-campanhas-api-a40da4ef222efba3f7278e35';return{...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,crmManagedWriter:{...f.config.crmManagedWriter,provisionerToken:'S'.repeat(43)},upstreams:{'crm-read':'https://comunicacao-crm-panel-read.tazdb8.easypanel.host/read',campaigns:url},allowedUpstreamHosts:['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host'],dynamicRouteManifest:{schema:'shrigma_dashboard_dynamic_upstreams_v1',sourceRevision:'4517cc3d3060a75e9d11c360479054cb0bd4d459',routes:{campaigns:url}}};}
function handler(server,ctx,url){return new Promise(resolve=>{const req=Readable.from([]);Object.assign(req,{url,method:'GET',headers:{host:ctx.host,origin:ctx.origin,cookie:ctx.cookieHeader,'x-csrf-token':ctx.csrf},socket:{remoteAddress:'127.0.0.1'}});const res=new EventEmitter();res.setHeader=()=>{};res.end=b=>{res.emit('finish');resolve({status:res.statusCode,body:JSON.parse(String(b))});};server.emit('request',req,res);});}
function queued(f,id,brand='fish'){
 const c=q(brand),mac=f.db.prepare('SELECT credential_mac FROM crm_writer_auth_binding_v1 WHERE user_id=?').get(id).credential_mac;
 f.db.prepare("INSERT INTO crm_campaign_delivery_v1(user_id,client_key,remote_key,brand,action,campaign_id,expected_version,payload_sha256,credential_mac,phase,created_at,updated_at) VALUES(?,?,?,?, 'validar',7,?,?,?,'queued',?,?)").run(id,c.idempotency_key,'synthetic_remote_history_key_'+brand,brand,V,sha(c),mac,f.now,f.now);
 return f.db.prepare('SELECT * FROM crm_campaign_delivery_v1 WHERE user_id=? AND brand=?').get(id,brand);
}
const current=brand=>({status:200,body:{campaign:{id:7,version:V,status:'draft',sent:0,started_at:null,send_at:null,definition:{brand,list_ids:[125]}}}});
async function admin(f){const l=await f.auth.login({email:f.config.bootstrapAdminEmail,password:'Synthetic writer manager password 2026!',host:hosts.manager,origin:'https://'+hosts.manager});Object.assign(f.context,{cookieHeader:l.cookie.split(';')[0],csrf:l.csrf});}

test('expired READ session advertises only corporate history and queued HTTP GET does STATUS only, including auth/brand refusals',async t=>{
 const f=await fixture(t),id=await f.manager();f.advance(13*86400000);await admin(f);await f.issue(id);f.advance(86400000+1);const ctx=await f.login(),calls=[];
 const server=Server.createServer(settings(f),{auth:f.auth,managedCrmRuntime:{kick:()=>Promise.resolve(),close:()=>Promise.resolve()},fetchImpl:async(url,o)=>{const u=new URL(url);calls.push({method:o.method||'GET',action:u.searchParams.get('acao')});const data=u.searchParams.get('acao')==='campanha_obter'?current(u.searchParams.get('brand')).body:{operation:null};const r=new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:String(url)});return r;}});t.after(()=>server.removeAllListeners());
 const state=await handler(server,ctx,'/auth/session');assert.equal(state.status,200);assert.equal(state.body.features.campaignSubmitWrite,false);assert.equal(state.body.features.campaignCreate,false);assert.equal(state.body.features.campaignHistoryRead,true);assert.equal(f.auth.managedCrmJournal.credentialReady(id),false);assert.doesNotMatch(JSON.stringify(state.body),/credentialMac|principalId|namespaceId|lifecycleId|encrypted/);
 const before=queued(f,id),r=await handler(server,ctx,'/auth/campaign-delivery?brand=fish&idempotency_key='+KEY);assert.equal(r.status,202);assert.equal(r.body.state,'pending');assert.deepEqual(calls,[{method:'GET',action:'campanha_operacao'}]);assert.deepEqual(f.db.prepare('SELECT * FROM crm_campaign_delivery_v1 WHERE user_id=?').get(id),before);
 for(const context of [{...ctx,csrf:'forged'},{...ctx,origin:'https://sibling.invalid'}])assert.equal((await handler(server,context,'/auth/campaign-delivery?brand=fish&idempotency_key='+KEY)).status,403);assert.equal((await handler(server,ctx,'/auth/campaign-delivery?brand=aristo&idempotency_key='+KEY)).status,404);assert.equal(calls.length,1);
 assert.equal((await handler(server,{...ctx,cookieHeader:''},'/auth/campaign-delivery?brand=fish&idempotency_key='+KEY)).status,403);assert.equal(calls.length,1);await admin(f);f.auth.revokeUser({context:f.context,userId:id});assert.equal((await handler(server,ctx,'/auth/session')).body.authenticated,false);assert.equal(calls.length,1);
});

test('history refuses master/other panel/forged READ grant and expires with the WRITER rather than extending READ',async t=>{
 const f=await fixture(t),id=await f.manager();await f.issue(id);const ctx=await f.login();assert.equal(f.auth.campaignHistoryRead({...ctx,method:'GET'}),true);assert.equal(f.auth.campaignHistoryRead({...f.context,method:'GET'}),false);
 f.db.prepare('UPDATE grants SET can_edit=0 WHERE user_id=?').run(id);assert.equal(f.auth.campaignHistoryRead({...ctx,method:'GET'}),false);f.db.prepare('UPDATE grants SET can_edit=1 WHERE user_id=?').run(id);f.advance(14*86400000+1);const fresh=await f.login();assert.equal(f.auth.campaignHistoryRead({...fresh,method:'GET'}),false);assert.equal(f.auth.managedCrmJournal.credentialReady(id),false);
});

test('pure client permits scoped history GET for both actions/brands but denies all new POST verbs',async()=>{
 for(const [brand,action]of [['fish','campanha_validar'],['aristo','campanha_criar']]){
  let s=session('a');const rows=new Map(),calls=[],key=t=>t.uiKey+':'+t.brand;rows.set(key({uiKey:s.uiKey,brand}),journal(brand,action));const before=structuredClone(rows.get(key({uiKey:s.uiKey,brand})));
  const client=createCampaignBffClient({getSession:()=>s,readJournal:t=>rows.get(key(t))??null,writeJournal:(t,r)=>rows.set(key(t),structuredClone(r)),request:async r=>{calls.push(r);return receipt(rows.get(s.uiKey+':'+brand));}});
  assert.equal((await client.consult(brand)).state,'pending');assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.match(calls[0].path,new RegExp('^/auth/campaign-'+(action==='campanha_criar'?'create':'delivery')+'\\?brand='+brand));assert.equal(calls[0].path.endsWith(KEY),true);assert.equal(Object.hasOwn(calls[0],'body'),false);assert.deepEqual(rows.get(s.uiKey+':'+brand),before);
  for(const verb of ['create','save','validate','schedule','cancel'])await assert.rejects(client[verb]({}),{code:'CAMPAIGN_BFF_DENIED'});assert.equal(calls.length,1);
  s={...s,features:{campaignSubmitWrite:false}};await assert.rejects(client.consult(brand),{code:'CAMPAIGN_BFF_DENIED'});assert.equal(calls.length,1);
 }
});

test('late history ACK or corrupted brand cannot move a receipt to another actor/brand or authorize a POST',async()=>{
 let s=session('a'),release;const rows=new Map(),calls=[],old=s.uiKey;rows.set(old+':fish',journal());const client=createCampaignBffClient({getSession:()=>s,readJournal:t=>rows.get(t.uiKey+':'+t.brand)??null,writeJournal:(t,r)=>rows.set(t.uiKey+':'+t.brand,structuredClone(r)),request:r=>{calls.push(r);return new Promise(resolve=>{release=resolve;});}});
 const work=client.consult('fish');work.catch(()=>{});assert.equal(typeof release,'function');s=session('b');release(receipt(journal(),'succeeded'));await assert.rejects(work,{code:'CAMPAIGN_BFF_UNCERTAIN'});assert.equal(rows.has(s.uiKey+':fish'),false);assert.equal(rows.get(old+':fish').phase,'uncertain');assert.equal(rows.get(old+':fish').attemptKey,KEY);assert.equal(calls.length,1);
 s=session('a');rows.set(old+':aristo',journal('fish'));await assert.rejects(client.consult('aristo'),{code:'CAMPAIGN_BFF_STORAGE'});assert.equal(calls.length,1);
});

function dom(){const {document,window}=parseHTML(fs.readFileSync(path.resolve(__dirname,'../services/dashboard-operational/public/entry.html'),'utf8'));window.HTMLElement.prototype.focus=function(){};for(const select of document.querySelectorAll('select'))Object.defineProperty(select,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(value){for(const o of this.querySelectorAll('option'))o.toggleAttribute('selected',o.value===String(value));}});const d=document.getElementById('entry-campaign-dialog');d.showModal=()=>{d.open=true;};d.close=()=>{d.open=false;};return{document,window,$:id=>document.getElementById('campaign-'+id)};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('actual editor history-only mode consults the original journals in both brands, paints proof and never reads catalog or sends POST',async()=>{
 const d=dom(),s=session('a'),storage=new Map(),calls=[];for(const brand of ['fish','aristo'])storage.set('shrigma_campaign_bff_v1:'+s.uiKey+':'+brand,JSON.stringify(journal(brand)));
 const request=async q=>{calls.push(q);const u=new URL(q.path,'https://synthetic.invalid');assert.equal(q.method,'GET');assert.equal(u.pathname,'/auth/campaign-delivery');const r=JSON.parse(storage.get('shrigma_campaign_bff_v1:'+s.uiKey+':'+u.searchParams.get('brand')));return receipt(r,'succeeded');};
 const controller=createCampaignEditor({document:d.document,getSession:()=>s,request,storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},locks:{request:async(name,options,fn)=>fn({name})},createClient:createCampaignBffClient});assert.equal(await controller.open(),true);assert.equal(calls.length,1);assert.match(d.$('state').textContent,/resultado consultado/);assert.match(d.$('review').textContent,/leitura está indisponível/);
 for(const id of ['save','validate','schedule','cancel','create','new']){assert.equal(d.$(id).disabled||d.$(id).hidden,true,id);d.$(id).click();}await tick();assert.equal(calls.length,1);assert.equal(d.$('fields').disabled,true);assert.equal(d.$('select').disabled,true);
 d.$('select').dispatchEvent(new d.window.Event('change'));await tick();assert.equal(calls.length,1);d.$('brand').value='aristo';d.$('brand').dispatchEvent(new d.window.Event('change'));await tick();await tick();assert.equal(calls.length,2);assert.match(calls[1].path,/brand=aristo/);assert.equal(new Set(calls.map(c=>c.method)).size,1);controller.close();
});

test('queued GET and simultaneous original POST do not suppress or duplicate the authorized original effect',async t=>{
 const f=await fixture(t),id=await f.manager();await f.issue(id);const ctx=await f.login(),calls=[];let release,started;const seen=new Promise(r=>{started=r;});const delivery=f.auth.campaignDeliveryFor(async(context,wire)=>{calls.push(wire);if(wire.method==='GET'&&wire.command.acao==='campanha_operacao'&&!release){started();return new Promise(r=>{release=()=>r({status:404,body:{error:'MISSING'}});});}if(wire.method==='GET'&&wire.command.acao==='campanha_obter')return current(wire.command.brand);if(wire.method==='POST')return null;return{status:404,body:{error:'MISSING'}};});const before=queued(f,id);
 const read=delivery.reconcile({...ctx,method:'GET'},{brand:'fish',idempotency_key:KEY});await tick();assert.equal(calls[0].command.acao,'campanha_operacao');await seen;assert.deepEqual(calls.map(c=>c.method+':'+c.command.acao),['GET:campanha_operacao']);
 const write=delivery.submit({...ctx,method:'POST'},q());assert.deepEqual(await write,{state:'pending',campaign:null});release();assert.deepEqual(await read,{state:'pending',campaign:null});assert.equal(calls.filter(c=>c.method==='POST').length,1);const after=f.db.prepare('SELECT * FROM crm_campaign_delivery_v1 WHERE user_id=?').get(id);assert.equal(after.remote_key,before.remote_key);assert.equal(after.credential_mac,before.credential_mac);assert.equal(after.payload_sha256,before.payload_sha256);assert.equal(after.phase,'uncertain');
 assert.deepEqual(await delivery.reconcile({...ctx,method:'GET'},{brand:'fish',idempotency_key:KEY}),{state:'pending',campaign:null});assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.equal(calls.filter(c=>c.command.acao==='campanha_operacao').length,2);
});

test('entry exposes an honest history CTA only for the scoped manager when WRITE is false',()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../services/dashboard-operational/public/entry.js'),'utf8'),start=source.indexOf('campaignUi?.close();if(campaignButton)',source.indexOf(' function openPanel(')),end=source.indexOf('\n  audienceGate=',start);assert.ok(start>=0&&end>start);
 for(const [history,role,edit,expected]of [[true,'manager',true,false],[false,'manager',true,true],[true,'superadmin',true,true],[true,'manager',false,true]]){const c={area:'growth',campaignUi:{close(){}},campaignButton:{hidden:true,textContent:''},session:{...session('a'),features:{campaignSubmitWrite:false,campaignHistoryRead:history},user:{...session('a').user,role,permissions:{growth:{read:true,edit}}}}};vm.runInNewContext(source.slice(start,end),c);assert.equal(c.campaignButton.hidden,expected);if(!expected)assert.match(c.campaignButton.textContent,/Consultar tentativas/);}
});

test('failed/contradictory old terminal GET after WRITER rotation preserves its proof and does not deadlock a fresh authorized attempt',async()=>{
 const s={...session('a'),features:{campaignSubmitWrite:true,campaignHistoryRead:true}},rows=new Map(),calls=[],original={...journal(),phase:'succeeded'};rows.set(s.uiKey+':fish',original);let behavior=q=>({status:403,body:{error:'CAMPAIGN_EDIT_DENIED'}});
 const client=createCampaignBffClient({getSession:()=>s,readJournal:t=>rows.get(t.uiKey+':'+t.brand)??null,writeJournal:(t,r)=>rows.set(t.uiKey+':'+t.brand,structuredClone(r)),request:async q=>{calls.push(q);return behavior(q);}});
 await assert.rejects(client.consult('fish'),{code:'CAMPAIGN_BFF_UNCERTAIN'});assert.deepEqual(rows.get(s.uiKey+':fish'),original);assert.equal(calls[0].method,'GET');
 behavior=()=>receipt(original,'pending');await assert.rejects(client.consult('fish'),{code:'CAMPAIGN_BFF_UNCERTAIN'});assert.deepEqual(rows.get(s.uiKey+':fish'),original);assert.equal(calls[1].method,'GET');
 behavior=()=>receipt(rows.get(s.uiKey+':fish'),'pending');const next={...q(),idempotency_key:'new_after_writer_rotation_02'};delete next.acao;assert.equal((await client.validate(next)).state,'pending');assert.equal(calls[2].method,'POST');assert.equal(calls[2].body.idempotency_key,next.idempotency_key);assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.equal(rows.get(s.uiKey+':fish').attemptKey,next.idempotency_key);
});


test('terminal local proof survives denied/malformed/timed-out GET while unresolved attempts stay uncertain and READ-only cannot make a fresh POST',async()=>{
 const errors=[()=>({status:403,body:{error:'DENIED'}}),()=>({status:200,body:{schema:'malformed'}}),()=>{throw new Error('synthetic timeout');}];
 for(const brand of ['fish','aristo'])for(const phase of ['succeeded','rejected','pending','uncertain'])for(const fail of errors){
  const s=session('a'),rows=new Map(),calls=[],original={...journal(brand),phase},key=s.uiKey+':'+brand;rows.set(key,original);
  const client=createCampaignBffClient({getSession:()=>s,readJournal:t=>rows.get(t.uiKey+':'+t.brand)??null,writeJournal:(t,r)=>rows.set(t.uiKey+':'+t.brand,structuredClone(r)),request:async q=>{calls.push(q);return fail();}});
  await assert.rejects(client.consult(brand),{code:'CAMPAIGN_BFF_UNCERTAIN'});assert.deepEqual(rows.get(key),{...original,phase:['succeeded','rejected'].includes(phase)?phase:'uncertain'});assert.deepEqual(calls.map(c=>c.method),['GET']);
  const next={...q(brand),idempotency_key:'fresh_history_denied_id_01'};delete next.acao;await assert.rejects(client.validate(next),{code:'CAMPAIGN_BFF_DENIED'});assert.equal(calls.length,1);
 }
});


test('compiled editor keeps a terminal CREATE closed after old-actor GET refusal and only opens a fresh draft by explicit current-WRITE action',async()=>{
 for(const phase of ['succeeded','rejected'])for(const brand of ['fish','aristo']){
  const d=dom(),s={...session('a'),features:{campaignSubmitWrite:true,campaignCreate:true,campaignHistoryRead:true}},storage=new Map(),calls=[],original={...journal(brand,'campanha_criar'),phase,...(phase==='succeeded'?{createdId:70}:{})};
  const key='shrigma_campaign_bff_v1:'+s.uiKey+':'+brand;storage.set(key,JSON.stringify(original));d.$('brand').value=brand;
  const controller=createCampaignEditor({document:d.document,getSession:()=>s,request:async q=>{calls.push(q);assert.equal(q.method,'GET');const u=new URL(q.path,'https://synthetic.invalid');if(u.pathname==='/auth/campaign-create')return{status:403,body:{error:'OLD_ACTOR'}};assert.equal(u.pathname,'/api/campaigns');return{status:200,body:u.searchParams.get('acao')==='campanha_catalogo'?{brand,current:true,lists:[],templates:[]}:{campaigns:[]}};},storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},locks:{request:async(name,options,fn)=>fn({name})},createClient:createCampaignBffClient});
  assert.equal(await controller.open(),true);assert.deepEqual(JSON.parse(storage.get(key)),original);assert.equal(d.$('create').hidden,true);assert.equal(d.$('create-details').hidden,true);assert.equal(d.$('new').disabled,false);assert.equal(calls.length,3);assert.equal(calls.every(c=>c.method==='GET'),true);
  d.$('new').click();assert.equal(d.$('create').hidden,false);assert.equal(d.$('create-details').hidden,false);assert.equal(d.$('name').value,'');assert.deepEqual(JSON.parse(storage.get(key)),original);assert.equal(calls.length,3);controller.close();
 }
});
