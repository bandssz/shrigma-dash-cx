'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {Readable,Writable}=require('node:stream');
const {createAuth}=require('../services/dashboard-operational/auth.cjs');
const {createNativeMcp,dispatchJson,ENDPOINT,redact}=require('../services/dashboard-operational/crm-native-mcp.cjs');
const {createServer,authOptionsFor}=require('../services/dashboard-operational/server.cjs');
const {handleOperator}=require('../services/dashboard-operational/crm-native-operator.cjs');
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const host='manager.synthetic.invalid',origin='https://'+host;
const opts={managerHost:host,areaHosts:{growth:'crm.synthetic.invalid',organico:'organic.synthetic.invalid',influs:'affiliate.synthetic.invalid'},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'master@synthetic.invalid',bootstrapTokenSha256:digest('only-local-bootstrap'),encryptionKey:crypto.randomBytes(32).toString('hex'),crmNativeEnabled:true};
let auth,ctx,temporary,dbPath,clock=1800000000000,settings;
test.before(async()=>{
 temporary=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-native-test-'));dbPath=path.join(temporary,'identity.sqlite');
 auth=createAuth({...opts,dbPath,now:()=>clock});
 await auth.completeBootstrap({email:opts.bootstrapAdminEmail,token:'only-local-bootstrap',password:'Synthetic-Only-Password-2026!',host,origin});
 const login=await auth.login({email:opts.bootstrapAdminEmail,password:'Synthetic-Only-Password-2026!',host,origin});
 ctx={cookieHeader:login.cookie.split(';')[0],host,origin,method:'POST',csrf:login.csrf};
 settings={...opts,dbPath,mode:'synthetic',upstreamProfile:'production',upstreams:{},allowedUpstreamHosts:[],publicDir:temporary};
});
test.afterEach(()=>{if(clock!==1800000000000)return;for(const c of auth.nativeConnections.list(ctx))if(!c.revoked)auth.nativeConnections.revoke({context:ctx,connectionId:c.id});});
test.after(()=>{auth?.close();fs.rmSync(temporary,{recursive:true,force:true});});
const issue=(overrides={})=>auth.nativeConnections.issue({context:ctx,brands:['fish'],scopes:['crm.read'],...overrides});
const denied=(fn,code)=>assert.throws(fn,e=>e.code===code);
function collect(){const chunks=[];const res=new Writable({write(c,e,done){chunks.push(Buffer.from(c));done();}});res.headers={};res.setHeader=(k,v)=>res.headers[k.toLowerCase()]=v;res.getHeader=k=>res.headers[k.toLowerCase()];res.statusCode=200;return {res,body:()=>{const value=Buffer.concat(chunks).toString();return value?JSON.parse(value):undefined;}};}
async function rpc(mcp,token,message,overrides={}){
 const req=Readable.from([Buffer.from(JSON.stringify(message))]);req.method='POST';req.headers={host,origin,authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream',...overrides};const c=collect();await mcp.handle(req,c.res,new URL(ENDPOINT,origin));await new Promise(resolve=>c.res.writableFinished?resolve():c.res.once('finish',resolve));return {status:c.res.statusCode,headers:c.res.headers,body:c.body()};
}
test('native issuance requires original Master browser session and exact Origin/CSRF',()=>{
 denied(()=>issue({context:{...ctx,csrf:'incorrect'}}),'CSRF_DENIED');
 denied(()=>issue({context:{...ctx,origin:'https://untrusted.invalid'}}),'ORIGIN_DENIED');
 denied(()=>issue({context:{...ctx,cookieHeader:undefined}}),'SESSION_REQUIRED');
});
test('native credential is distinct from cookie, keeps original identity and does not open CRM edit',()=>{
 const key=issue(),native=auth.nativeConnections.context(key.token),owner=auth.authorize({...native,area:'growth'});
 assert.equal(owner.id,auth.session(ctx).user.id);assert.equal(owner.role,'superadmin');
 assert.equal(native.cookieHeader,undefined);assert.equal(auth.session(native).user.permissions.growth.edit,false);
 denied(()=>issue({scopes:['crm.read','crm.draft']}),'GRANT_DENIED');
 denied(()=>auth.authorize({...native,method:'POST',csrf:'incorrect',area:'growth'}),'CSRF_DENIED');
});
test('native credential cannot issue or renew itself by masquerading as browser consent',()=>{
 const issued=issue();denied(()=>issue({context:{...auth.nativeConnections.context(issued.token),method:'POST'}}),'NATIVE_BROWSER_CONSENT_REQUIRED');
});
test('scope and brand restrictions reject writes and cross-brand reads before dispatch',async()=>{
 const key=issue();let calls=0;const m=createNativeMcp({auth,managerHost:host,invoke:async()=>{calls++;return {status:200,body:{}};}});
 await assert.rejects(m.call('crm_campaign_get',{brand:'aristo',id:1},key.token),e=>e.code==='BRAND_DENIED');
 await assert.rejects(m.call('crm_campaign_save',{brand:'fish',id:1,expected_version:'a'.repeat(32),definition:{},idempotency_key:'original-key-123456'},key.token),e=>e.code==='NATIVE_SCOPE_DENIED');
 assert.equal(calls,0);
});
test('tool arguments reject alternate URL, SQL, actors, cookies and absent operation identity',async()=>{
 const key=issue(),m=createNativeMcp({auth,managerHost:host,invoke:async()=>assert.fail('must not dispatch')});
 for(const args of [{brand:'fish',id:1,url:'https://foreign.invalid'},{brand:'fish',id:1,sql:'DROP TABLE users'},{brand:'fish',id:1,actor:'master'},{brand:'fish',id:1,cookie:'fake'}])await assert.rejects(m.call('crm_campaign_get',args,key.token),e=>e.code==='NATIVE_ARGUMENTS_INVALID');
 await assert.rejects(m.call('crm_campaign_save',{brand:'fish',id:1,expected_version:'a'.repeat(32),definition:{}},key.token),e=>e.code==='NATIVE_ARGUMENTS_INVALID');
});
test('the bearer remains private: only its hash and consent binding persist; list cannot retrieve it',()=>{
 const key=issue(),db=new DatabaseSync(dbPath),row=db.prepare('SELECT * FROM crm_native_connections_v1 WHERE id=?').get(key.connection.id);
 assert.equal(row.token_hash,digest(key.token));assert.equal(JSON.stringify(row).includes(key.token),false);db.close();
 assert.equal(JSON.stringify(auth.nativeConnections.list(ctx)).includes(key.token),false);
});
test('revocation is durable, idempotent and immediately denies the same credential',()=>{
 const key=issue();auth.nativeConnections.revoke({context:ctx,connectionId:key.connection.id});auth.nativeConnections.revoke({context:ctx,connectionId:key.connection.id});
 denied(()=>auth.nativeConnections.authenticate(key.token),'NATIVE_AUTH_REQUIRED');
 const db=new DatabaseSync(dbPath);assert.equal(db.prepare("SELECT COUNT(*) n FROM crm_native_connection_audit_v1 WHERE connection_id=? AND action='revoke'").get(key.connection.id).n,1);db.close();
});
test('persisted scope/expiry tampering cannot escalate a valid delegated credential',()=>{
 const key=issue(),db=new DatabaseSync(dbPath);db.prepare('UPDATE crm_native_connections_v1 SET scopes_json=? WHERE id=?').run('["crm.read","db.install"]',key.connection.id);db.close();
 denied(()=>auth.nativeConnections.authenticate(key.token),'NATIVE_AUTH_REQUIRED');
});
test('Streamable HTTP initialization/list/results work and session secrets are absent',async()=>{
 const key=issue(),m=createNativeMcp({auth,managerHost:host,invoke:async()=>({status:200,body:{authenticated:true,user:{role:'superadmin',permissions:{growth:{read:true,edit:false}},email:'private@synthetic.invalid'},csrf:'private-csrf',uiKey:'private-key',features:{campaignSubmitWrite:false}}})});
 const initial=await rpc(m,key.token,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}});assert.equal(initial.body.result.protocolVersion,'2025-11-25');
 const listed=await rpc(m,key.token,{jsonrpc:'2.0',id:2,method:'tools/list'});assert.equal(listed.body.result.tools.some(t=>t.name==='crm_campaign_save'),false);
 const state=await rpc(m,key.token,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'crm_status',arguments:{}}});assert.equal(state.body.result.structuredContent.body.authenticated,true);assert.equal(state.body.result.structuredContent.body.operational,false);
 assert.equal(JSON.stringify(state.body).includes('private-'),false);
 const notification=await rpc(m,key.token,{jsonrpc:'2.0',method:'notifications/initialized'});assert.equal(notification.status,202);assert.equal(notification.body,undefined);
});
test('transport rejects foreign Origin and unsupported protocol without invoking a tool',async()=>{
 const key=issue(),m=createNativeMcp({auth,managerHost:host,invoke:async()=>assert.fail('must not dispatch')});
 await assert.rejects(rpc(m,key.token,{jsonrpc:'2.0',id:1,method:'ping'},{origin:'https://attacker.invalid'}),e=>e.code==='ORIGIN_DENIED');
 await assert.rejects(rpc(m,key.token,{jsonrpc:'2.0',id:1,method:'ping'},{'mcp-protocol-version':'2099-01-01'}),e=>e.code==='NATIVE_PROTOCOL_UNSUPPORTED');
 const missing=await rpc(m,'wrong',{jsonrpc:'2.0',id:1,method:'ping'});assert.equal(missing.status,401);
});
test('runtime revocation during upstream read suppresses the returned data',async()=>{
 const key=issue(),m=createNativeMcp({auth,managerHost:host,invoke:async()=>{auth.nativeConnections.revoke({context:ctx,connectionId:key.connection.id});return {status:200,body:{campaign:{id:7,definition:{brand:'fish'}}}};}});
 await assert.rejects(m.call('crm_campaign_get',{brand:'fish',id:7},key.token),e=>e.code==='NATIVE_AUTH_REQUIRED');
});
test('SQL installation is refused when no installer has been admitted',async()=>{
 const key=issue({scopes:['db.inspect','db.install']}),m=createNativeMcp({auth,managerHost:host,invoke:async()=>assert.fail('must not dispatch')});
 await assert.rejects(m.call('db_inspect',{},key.token),e=>e.code==='NATIVE_INSTALLER_NOT_ADMITTED');
});
test('private operator path requires real Master and rejects native self-issuance',async()=>{
 const req=Readable.from([Buffer.from(JSON.stringify({action:'list'}))]);req.method='POST';req.headers={'content-type':'application/json'};const c=collect();
 await handleOperator({req,res:c.res,url:new URL('/auth/native-connections',origin),ctx,auth,managerHost:host});assert.ok(Array.isArray(c.body().connections));
 const key=issue(),native=auth.nativeConnections.context(key.token),req2=Readable.from([Buffer.from(JSON.stringify({action:'list'}))]);req2.method='POST';req2.headers={'content-type':'application/json'};
 await assert.rejects(handleOperator({req:req2,res:collect().res,url:new URL('/auth/native-connections',origin),ctx:{...native,method:'POST'},auth,managerHost:host}),e=>e.code==='NATIVE_BROWSER_CONSENT_REQUIRED');
});
test('canonical gateway dispatch authenticates the native principal and retains original feature gates',async()=>{
 const key=issue();const server=createServer(settings,{auth});
 const result=await dispatchJson((req,res,context)=>{
  // The gateway installs this dispatcher internally; this test uses its
  // actual exported request listener for the external MCP layer below.
  server.emit('request',req,res);
 },{method:'POST',path:ENDPOINT,body:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'crm_status',arguments:{}}},context:{host,origin,csrf:ctx.csrf}}).catch(e=>e);
 // No bearer was supplied to the public request, so it must be refused rather
 // than accepting a caller-provided internal context.
 assert.equal(result.status,401);
 const req=Readable.from([Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'crm_status',arguments:{}}}))]);req.method='POST';req.url=ENDPOINT;req.headers={host,authorization:'Bearer '+key.token,origin,'content-type':'application/json',accept:'application/json, text/event-stream'};req.socket={remoteAddress:'local-native-test'};
 const c=collect();server.emit('request',req,c.res);await new Promise(resolve=>c.res.once('finish',resolve));const response=c.body();assert.equal(response.result.structuredContent.body.authenticated,true);assert.equal(response.result.structuredContent.body.permissions.growth.edit,false);assert.equal(response.result.structuredContent.body.operational,false);
 server.close();
});
test('redaction preserves actual campaign definition addresses and original operation key',()=>{
 assert.deepEqual(redact({from_email:'campaign@synthetic.invalid',reply_to:'reply@synthetic.invalid',idempotency_key:'original-key',token:'secret',csrf:'secret',email:'private@synthetic.invalid',owner:'private'}),{from_email:'campaign@synthetic.invalid',reply_to:'reply@synthetic.invalid',idempotency_key:'original-key'});
});
test('delegations survive process restart but expiration is enforced without renewal or cookie fabrication',()=>{
 // Drain live connections from prior tests to keep the consent cap meaningful.
 for(const c of auth.nativeConnections.list(ctx))if(!c.revoked)auth.nativeConnections.revoke({context:ctx,connectionId:c.id});
 const key=issue({expiresDays:1});auth.close();auth=createAuth({...opts,dbPath,now:()=>clock});assert.equal(auth.nativeConnections.authenticate(key.token).id,key.connection.id);
 clock+=86400001;denied(()=>auth.nativeConnections.authenticate(key.token),'NATIVE_AUTH_REQUIRED');
});
test('disabled native mode does not expose delegation authority',()=>{
 const off=createAuth({...opts,crmNativeEnabled:false,dbPath:':memory:'});assert.equal(off.nativeConnections,undefined);off.close();
 assert.equal(authOptionsFor({...settings,crmNativeEnabled:false}).crmNativeEnabled,undefined);
});
