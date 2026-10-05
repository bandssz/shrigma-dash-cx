'use strict';
// Genuine Auth/SQLite and server handler; synthetic upstream and local guard DOM.
// No socket, external fetch, provider call, deployment or real credential.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const {fixture,hosts}=require('./helpers/crm-managed-read-auth-fixture.cjs');
const {transport,META}=require('./helpers/claude-portal-pages.cjs');
const S=require('../services/dashboard-operational/server.cjs'),P=require('../services/dashboard-operational/proxy.cjs');
const route='/api/crm-read?action=cache_growth&painel=growth';
const closed={error:'UPSTREAM_CREDENTIAL_REJECTED'};
const deny=()=>{throw Error('AUTH_BOUNDARY_EXTERNAL_TRANSPORT_REFUSED');};
for(const name of ['node:net','node:tls','node:http','node:https','node:dgram']){
 const m=require(name);for(const key of ['connect','createConnection','request','get','createSocket'])if(typeof m[key]==='function')m[key]=deny;
 if(m.Socket?.prototype)m.Socket.prototype.connect=deny;if(m.Server?.prototype)m.Server.prototype.listen=deny;
}
for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('node:child_process')[key]=deny;
globalThis.fetch=deny;
function rejectedBody(stats,{cancelFails=false}={}){
 const response=new Response(JSON.stringify({error:'SYNTHETIC_REMOTE_SECRET',authorization:'synthetic-private-credential',other_brand:'aristo'}),{status:401,headers:{'content-type':'application/json'}});
 return {status:401,headers:{get(key){stats.headerReads++;return response.headers.get(key);}},body:{async cancel(){stats.cancels++;if(cancelFails)throw Error('synthetic cancel failure');await response.body.cancel();},getReader(){stats.bodyReads++;return response.body.getReader();}}};
}
const stat=()=>({calls:0,posts:0,cancels:0,headerReads:0,bodyReads:0});
function app(t,f,fetchImpl){
 const endpoint=P.FIXED_DESTINATIONS['crm-read'];
 const server=S.createServer({...f.config,mode:'operational',upstreamProfile:'production',upstreams:{'crm-read':endpoint},allowedUpstreamHosts:[new URL(endpoint).hostname]},
  {auth:f.auth,fetchImpl,managedCrmRuntime:{kick:async()=>{},close:async()=>{}}});
 assert.equal(server.listening,false);t.after(()=>server.removeAllListeners());return transport(server);
}
async function manager(f){
 const email='reader@synthetic.invalid',invite=f.invite(email,'growth','fish');await f.accept(invite);const login=await f.login(email);
 const client=f.client(),op=f.queued(invite.userId),prepared=await f.prepare(client,op);await f.commit(client,op,prepared.prepared);
 return {host:hosts.growth,login,userId:invite.userId,bearer:prepared.bearer};
}
const ctx=login=>({cookie:login.cookie.split(';')[0],metadata:META});
function journalState(f){return f.inspect(d=>({drafts:d.prepare('SELECT * FROM campaign_draft_operations ORDER BY user_id,brand').all(),audiences:d.prepare('SELECT * FROM audience_draft_operations ORDER BY user_id,brand').all(),managed:d.prepare('SELECT * FROM crm_manager_operations_v1 ORDER BY operation_id').all()}));}
function guard(http,{host,login}){
 const {document,window:dom}=parseHTML('<html><body><div id="seg-marca"><button data-marca="fish">Fish</button><button data-marca="aristo">Aristo</button></div></body></html>');
 const messages=[],calls=[],values=new Map([['synthetic_uncertain_journal','retain existing operation']]);
 const window={parent:{postMessage:data=>messages.push(data)},dispatchEvent(){},localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},fetch:async(input,init={})=>{
  const url=new URL(String(input),'https://'+host);assert.equal(url.origin,'https://'+host);const method=init.method||'GET';assert.equal(method,'GET');
  const r=await http.get(host,url.pathname+url.search,ctx(login));calls.push({path:url.pathname+url.search,status:r.status});
  return new Response(r.text,{status:r.status,headers:{'content-type':'application/json'}});
 }};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../services/dashboard-operational/public/guard.js'),'utf8'),{window,document,location:{origin:'https://'+host,href:'https://'+host+'/growth.html'},navigator:{},URL,URLSearchParams,Headers,Response,Request,FormData,CustomEvent:dom.CustomEvent,HTMLFormElement:dom.HTMLFormElement});
 return {window,document,messages,calls,values};
}

test('upstream 401 returns a closed 503 before reading headers/body, even if cancellation fails',async()=>{
 for(const cancelFails of [false,true]){
  const stats=stat(),r=await P.forward({route:'crm-read',method:'GET',query:new URLSearchParams('action=cache_growth&painel=growth'),user:{role:'superadmin'},credential:'synthetic-individual-reader',upstreams:{'crm-read':new URL(P.FIXED_DESTINATIONS['crm-read'])},origin:'https://crm.synthetic.invalid',fetchImpl:async()=>{stats.calls++;return rejectedBody(stats,{cancelFails});}});
  assert.deepEqual(r,{status:503,body:closed});assert.deepEqual(stats,{calls:1,posts:0,cancels:1,headerReads:0,bodyReads:0});
 }
});

test('one admitted draft POST receiving upstream 401 is never replayed',async()=>{
 const stats=stat(),definition={schema_version:'crm-campaign-v1',brand:'fish',channel:'email',initiative:{key:'gateway-proof',name:'Gateway proof'},utm_campaign:'gateway-proof',name:'Synthetic draft',subject:'Synthetic',from_email:'contato@fishermans.com.br',reply_to:'contato@fishermans.com.br',list_ids:[3],template_id:1,html:'<p>Synthetic {{ UnsubscribeURL }}</p>',text:'Synthetic {{ UnsubscribeURL }}',tags:[],send_at:null};
 const r=await P.forward({route:'campaigns',method:'POST',query:new URLSearchParams(),body:{acao:'campanha_salvar',brand:'fish',definition,idempotency_key:'a'.repeat(32)},user:{role:'manager',areas:['growth']},credential:'synthetic-draft-writer',upstreams:{campaigns:new URL(P.REVIEWED_DYNAMIC.routes.campaigns)},origin:'https://crm.synthetic.invalid',crmDraftWrite:true,fetchImpl:async(_u,options)=>{stats.calls++;stats.posts+=options.method==='POST'?1:0;return rejectedBody(stats);}});
 assert.deepEqual(r,{status:503,body:closed});assert.deepEqual(stats,{calls:1,posts:1,cancels:1,headerReads:0,bodyReads:0});
});

for(const role of ['master','manager'])test('real '+role+' session survives upstream 401; guard emits no logout and retains journals',async t=>{
 const f=await fixture();t.after(()=>f.close());const reader=role==='master'?{host:hosts.manager,login:f.master,bearer:f.masterKey}:await manager(f);
 const stats=stat(),beforeMaster=f.baseline(),beforeJournals=journalState(f);
 const http=app(t,f,async(_u,options)=>{stats.calls++;stats.posts+=options.method==='POST'?1:0;assert.equal(options.headers.Authorization,'Bearer '+reader.bearer);return rejectedBody(stats);});
 const ui=guard(http,reader),r=await ui.window.fetch(route);assert.deepEqual({status:r.status,sessionExpired:ui.messages.some(m=>m.type==='shrigma:session-expired')},{status:503,sessionExpired:false});assert.deepEqual(await r.json(),closed);
assert.deepEqual([...ui.values],[['synthetic_uncertain_journal','retain existing operation']]);
 const session=await http.get(reader.host,'/auth/session',ctx(reader.login));assert.equal(session.status,200);assert.equal(session.json.authenticated,true);assert.equal(session.json.user.role,role==='master'?'superadmin':'manager');
 assert.deepEqual(f.baseline(),beforeMaster);assert.deepEqual(journalState(f),beforeJournals);assert.deepEqual(stats,{calls:1,posts:0,cancels:1,headerReads:0,bodyReads:0});
 assert.deepEqual(ui.calls.map(c=>c.path),['/auth/session',route]);
 if(role==='manager')assert.deepEqual([...ui.document.querySelectorAll('#seg-marca button')].map(b=>b.dataset.marca),['fish']);
});

for(const state of ['expired during forward','revoked during forward'])test('real manager '+state+' retains local 401 and guard logout without replay',async t=>{
 const f=await fixture();t.after(()=>f.close());const reader=await manager(f),stats=stat(),journalsBefore=journalState(f);
 const http=app(t,f,async()=>{stats.calls++;if(state.startsWith('expired'))f.advance(31*60*1000);else f.auth.revokeUser({context:f.context,userId:reader.userId});return rejectedBody(stats);});
 const ui=guard(http,reader),r=await ui.window.fetch(route);assert.equal(r.status,401);assert.deepEqual(await r.json(),{error:'SESSION_REQUIRED'});assert.equal(ui.messages.filter(m=>m.type==='shrigma:session-expired').length,1);
 assert.deepEqual([...ui.values],[['synthetic_uncertain_journal','retain existing operation']]);assert.equal((await http.get(reader.host,'/auth/session',ctx(reader.login))).json.authenticated,false);
 const again=await ui.window.fetch(route);assert.equal(again.status,401);assert.equal(stats.calls,1);assert.equal(stats.posts,0);assert.equal(stats.cancels,1);assert.equal(stats.headerReads+stats.bodyReads,0);
 const after=journalState(f);assert.deepEqual(after.drafts,journalsBefore.drafts);assert.deepEqual(after.audiences,journalsBefore.audiences);
 if(state.startsWith('expired'))assert.deepEqual(after.managed,journalsBefore.managed);
});
