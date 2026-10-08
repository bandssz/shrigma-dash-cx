'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {Readable,Writable}=require('node:stream');
const inputs=path.resolve(process.env.CAMPAIGN_CREATE_INPUTS||path.join(__dirname,'../../../../inputs/gateway'));
const runtime=process.env.CAMPAIGN_CREATE_RUNTIME||path.join(__dirname,'../../services/dashboard-operational/crm-native-mcp.cjs');
const fs=require('node:fs'),Module=require('node:module');
// Compile the delivered delta with original dependency resolution when isolated.
let native;if(fs.existsSync(path.join(path.dirname(runtime),'proxy.cjs')))native=require(runtime);else{const filename=path.join(inputs,'services/dashboard-operational/crm-native-mcp.cjs'),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m._compile(fs.readFileSync(runtime,'utf8'),filename);native=m.exports;}
const {createNativeMcp,dispatchJson,ENDPOINT}=native;
const {createCampaignCreator}=require(path.join(inputs,'services/dashboard-operational/crm-campaign-create.cjs'));
const {createServer}=require(path.join(inputs,'services/dashboard-operational/server.cjs'));
const proxy=require(path.join(inputs,'services/dashboard-operational/proxy.cjs'));
const host='manager.synthetic.invalid',origin='https://'+host,token='f'.repeat(43),owner='11111111-1111-4111-8111-111111111111';
const key='same-create-intent-1234',args=()=>({brand:'fish',definition:{brand:'fish',send_at:null},idempotency_key:key});
function fixture({enabled=true,scope='crm.draft',invoke}={}){
 const state={revoked:false,checks:[],calls:[],scope};
 const check=(bearer,q={})=>{assert.equal(bearer,token);state.checks.push(q);if(state.revoked)throw Object.assign(Error('revoked'),{code:'NATIVE_AUTH_REQUIRED'});if(q.scope&&q.scope!==state.scope)throw Object.assign(Error('scope'),{code:'NATIVE_SCOPE_DENIED'});if(q.brand&&q.brand!=='fish')throw Object.assign(Error('brand'),{code:'BRAND_DENIED'});return{scopes:[state.scope],brands:['fish']};};
 const auth={nativeConnections:{authenticate:check,context:bearer=>{check(bearer);return{host,origin,nativeBearer:bearer,principalId:owner};}}};
 const m=createNativeMcp({auth,managerHost:host,createCampaignEnabled:enabled,invoke:async r=>{state.calls.push(r);return invoke?invoke(r,state):{status:202,body:{state:'pending'}};}});
 return{m,state,auth};
}
async function rpc(m,method,params){const req=Readable.from([Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method,params}))]);req.method='POST';req.headers={host,origin,authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'};const chunks=[];const res=new Writable({write(c,e,done){chunks.push(c);done();}});res.setHeader=()=>{};await m.handle(req,res,new URL(ENDPOINT,origin));if(!res.writableFinished)await new Promise(r=>res.once('finish',r));return JSON.parse(Buffer.concat(chunks));}
const rejected=(p,code)=>assert.rejects(p,e=>e.code===code);
test('default OFF hides and rejects create, retains authorized historical GET',async()=>{const f=fixture({enabled:false});const defaultM=createNativeMcp({auth:f.auth,managerHost:host,invoke:async()=>assert.fail('default OFF')});await rejected(defaultM.call('crm_campaign_create',args(),token),'NATIVE_TOOL_NOT_FOUND');const names=(await rpc(f.m,'tools/list')).result.tools.map(t=>t.name);assert(!names.includes('crm_campaign_create'));assert(names.includes('crm_campaign_create_operation'));await rejected(f.m.call('crm_campaign_create',args(),token),'NATIVE_TOOL_NOT_FOUND');await f.m.call('crm_campaign_create_operation',{brand:'fish',idempotency_key:key},token);assert.equal(f.state.calls[0].method,'GET');});
test('only boolean true enables creation',async()=>{const f=fixture({enabled:'true'});await rejected(f.m.call('crm_campaign_create',args(),token),'NATIVE_TOOL_NOT_FOUND');});
for(const name of ['crm_campaign_create','crm_campaign_create_operation']){
 test(name+' requires explicit draft and is hidden from READ',async()=>{const f=fixture({scope:'crm.read'});assert(!(await rpc(f.m,'tools/list')).result.tools.some(t=>t.name===name));await rejected(f.m.call(name,name.endsWith('operation')?{brand:'fish',idempotency_key:key}:args(),token),'NATIVE_SCOPE_DENIED');assert.equal(f.state.calls.length,0);});
 test(name+' denies foreign brand before dispatch',async()=>{const f=fixture();await rejected(f.m.call(name,name.endsWith('operation')?{brand:'aristo',idempotency_key:key}:{...args(),brand:'aristo'},token),'BRAND_DENIED');assert.equal(f.state.calls.length,0);});
 for(const extra of ['actor','url','sql','acao'])test(name+' rejects extra '+extra,async()=>{const f=fixture();await rejected(f.m.call(name,{...(name.endsWith('operation')?{brand:'fish',idempotency_key:key}:args()),[extra]:'untrusted'},token),'NATIVE_ARGUMENTS_INVALID');assert.equal(f.state.calls.length,0);});
 test(name+' checks live revocation before dispatch',async()=>{const f=fixture();f.state.revoked=true;await rejected(f.m.call(name,name.endsWith('operation')?{brand:'fish',idempotency_key:key}:args(),token),'NATIVE_AUTH_REQUIRED');assert.equal(f.state.calls.length,0);});
 test(name+' suppresses result revoked during await',async()=>{const f=fixture({invoke:async(r,s)=>{await Promise.resolve();s.revoked=true;return{status:200,body:{campaign:{id:7}}};}});await rejected(f.m.call(name,name.endsWith('operation')?{brand:'fish',idempotency_key:key}:args(),token),'NATIVE_AUTH_REQUIRED');assert.equal(f.state.calls.length,1);});
}
test('POST derives action and preserves intent and same native identity; no grant/renewal API exists',async()=>{const f=fixture();await f.m.call('crm_campaign_create',args(),token);const r=f.state.calls[0];assert.equal(r.path,'/auth/campaign-create');assert.equal(r.method,'POST');assert.deepEqual(r.body,{acao:'campanha_criar',...args()});assert.equal(r.context.nativeBearer,token);assert.equal(r.context.principalId,owner);assert(f.state.checks.filter(q=>q.scope==='crm.draft'&&q.brand==='fish').length>=3);});
test('historical GET uses BFF journal only and preserves exact key/context',async()=>{const f=fixture({enabled:false});await f.m.call('crm_campaign_create_operation',{brand:'fish',idempotency_key:key},token);const r=f.state.calls[0],u=new URL(r.path,origin);assert.equal(u.pathname,'/auth/campaign-create');assert.deepEqual([...u.searchParams],[['brand','fish'],['idempotency_key',key]]);assert.equal(r.body,undefined);assert.equal(r.context.nativeBearer,token);assert.equal(r.context.principalId,owner);});
test('create and reconciliation have conservative annotations',()=>{const f=fixture();for(const name of ['crm_campaign_create','crm_campaign_create_operation']){const t=f.m.tools.find(t=>t.name===name);assert.equal(t.scope,'crm.draft');assert.deepEqual(t.annotations,{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false});assert.equal(t.inputSchema.additionalProperties,false);}});
test('responses redact nested secrets and actor identity',async()=>{const f=fixture({invoke:async()=>({status:200,body:{state:'pending',nested:[{token:'secret',cookie:'secret',actorId:'secret',principalId:'secret',password:'secret',email:'secret',id:1}]}})});assert.deepEqual((await f.m.call('crm_campaign_create',args(),token)).body,{state:'pending',nested:[{id:1}]});});
// Original dispatcher + original durable journal, local SQLite and private synthetic adapters.
// No HTTP listener, external transport, real credential, or production acceptance.
function journalFixture(){
 const db=new DatabaseSync(':memory:'),remote=[],cryptKey=crypto.randomBytes(32);let current=true;
 const encrypt=s=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',cryptKey,iv);const b=Buffer.concat([c.update(s,'utf8'),c.final()]);return['v1',iv.toString('base64url'),c.getAuthTag().toString('base64url'),b.toString('base64url')].join('.');};
 const decrypt=s=>{const [,iv,tag,b]=s.split('.'),d=crypto.createDecipheriv('aes-256-gcm',cryptKey,Buffer.from(iv,'base64url'));d.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([d.update(Buffer.from(b,'base64url')),d.final()]).toString();};
 const identity=()=>{if(!current)throw Error('revoked');return{userId:owner,role:'manager',slot:'growth-campaign',canEdit:true,credentialMac:'a'.repeat(64),caps:['read_content','draft','validate','submit']};};
 const creator=createCampaignCreator({db,enabled:true,profile:'crm-sandbox',allowedEmailDomains:['synthetic.invalid'],authorize:identity,transport:async(ctx,r)=>{remote.push(r);if(r.method==='POST')return null;return r.command.acao==='campanha_catalogo'?{status:200,body:{synthetic:true}}:{status:404,body:{error:'UNKNOWN'}};},now:()=>1800000000000,encrypt,decrypt,preflightDefinition:d=>d,prepareDefinition:d=>({definition:d,tracking:{policy:'fixture',term:'fixture',list_ids:[],changed_links:0}}),hasOpenDelivery:()=>false});
 const auth={campaignCreateFor:()=>creator,campaignDeliveryFor:()=>({}),authorizeBrand:()=>{identity();return{id:owner,role:'manager'};},campaignWriterAuthorization:()=>identity()};
 const server=createServer({managerHost:host,areaHosts:{growth:'crm.synthetic.invalid'},mode:'operational',upstreamProfile:'crm-sandbox',crmCampaignSubmitWrite:true,allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'master@synthetic.invalid',allowedUpstreamHosts:[proxy.SANDBOX_HOST],upstreams:{...proxy.SANDBOX_DESTINATIONS,campaigns:proxy.SANDBOX_CAMPAIGN_DESTINATION},publicDir:__dirname},{auth,fetchImpl:()=>assert.fail('network must never be used')});
 const f=fixture({invoke:r=>dispatchJson(server.listeners('request')[0],r)});
 return{...f,db,remote,creator,close:()=>{db.close();server.close();}};
}
for(const delta of [{brand:'aristo'},{send_at:'2026-10-09T12:00:00Z'}])test('original dispatcher/journal rejects definition '+Object.keys(delta)[0],async()=>{const f=journalFixture();try{const r=await f.m.call('crm_campaign_create',{...args(),definition:{...args().definition,...delta}},token);assert.equal(r.status,400);assert.equal(f.remote.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM crm_campaign_create_v1').get().n,0);}finally{f.close();}});
test('original journal uncertain POST is committed once; repeat POST and GET never replay',async()=>{const f=journalFixture();try{const first=await f.m.call('crm_campaign_create',args(),token);assert.equal(first.status,202);assert.equal(first.body.state,'pending');const row=f.db.prepare('SELECT * FROM crm_campaign_create_v1').get();assert.equal(row.phase,'uncertain');assert.equal(row.user_id,owner);assert.equal(row.client_key,key);assert.notEqual(row.remote_key,key);assert.equal(f.remote.filter(r=>r.method==='POST').length,1);assert.equal(f.remote.find(r=>r.method==='POST').command.acao,'campanha_salvar');assert(!Object.hasOwn(f.remote.find(r=>r.method==='POST').command,'id'));await f.m.call('crm_campaign_create',args(),token);await f.m.call('crm_campaign_create_operation',{brand:'fish',idempotency_key:key},token);assert.equal(f.remote.filter(r=>r.method==='POST').length,1);assert(f.remote.filter(r=>r.command.acao==='campanha_operacao').every(r=>r.method==='GET'&&r.command.idempotency_key===row.remote_key));}finally{f.close();}});
test('original identity store enforces draft consent, brand, no self-renewal and live revocation',async()=>{
 const os=require('node:os'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'campaign-native-identity-'));
 const {createAuth}=require(path.join(inputs,'services/dashboard-operational/auth.cjs'));
 const email='master@synthetic.invalid',password='Synthetic-Only-Password-2026!',bootstrap='local-bootstrap-only';
 const auth=createAuth({dbPath:path.join(temp,'identity.sqlite'),managerHost:host,areaHosts:{growth:'crm.synthetic.invalid',organico:'organic.synthetic.invalid',influs:'affiliate.synthetic.invalid'},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:email,bootstrapTokenSha256:crypto.createHash('sha256').update(bootstrap).digest('hex'),encryptionKey:crypto.randomBytes(32).toString('hex'),crmNativeEnabled:true,now:()=>1800000000000});
 try{
  await auth.completeBootstrap({email,token:bootstrap,password,host,origin});
  const login=async()=>{const l=await auth.login({email,password,host,origin});return{host,origin,method:'POST',cookieHeader:l.cookie.split(';')[0],csrf:l.csrf};};
  let ctx=await login();
  const issue=scopes=>auth.nativeConnections.issue({context:ctx,brands:['fish'],scopes});
  assert.throws(()=>issue(['crm.draft']),e=>e.code==='GRANT_DENIED');
  const read=issue(['crm.read']);let calls=0;
  const readM=createNativeMcp({auth,managerHost:host,createCampaignEnabled:true,invoke:async()=>{calls++;return{status:200,body:{}};}});
  await rejected(readM.call('crm_campaign_create',args(),read.token),'NATIVE_SCOPE_DENIED');assert.equal(calls,0);
  assert.equal(auth.session(ctx).user.permissions.growth.edit,false);
  assert.throws(()=>auth.nativeConnections.issue({context:{...auth.nativeConnections.context(read.token),method:'POST'},brands:['fish'],scopes:['crm.read']}),e=>e.code==='NATIVE_BROWSER_CONSENT_REQUIRED');
  const user=auth.session(ctx).user;
  // Explicit original fixture admin grant, never performed by the MCP tool.
  auth.setGrants({context:ctx,userId:user.id,permissions:{growth:{read:true,edit:true},organico:{read:true,edit:false},influs:{read:true,edit:false}}});
  ctx=await login();const draft=issue(['crm.draft']);
  const m=createNativeMcp({auth,managerHost:host,createCampaignEnabled:true,invoke:async r=>{assert.equal(auth.authorize({...r.context,area:'growth',edit:true}).id,user.id);auth.nativeConnections.revoke({context:ctx,connectionId:draft.connection.id});return{status:200,body:{private:'must suppress'}};}});
  await rejected(m.call('crm_campaign_create_operation',{brand:'aristo',idempotency_key:key},draft.token),'BRAND_DENIED');
  await rejected(m.call('crm_campaign_create',args(),draft.token),'NATIVE_AUTH_REQUIRED');
 }finally{auth.close();fs.rmSync(temp,{recursive:true,force:true});}
});
