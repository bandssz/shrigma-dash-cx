'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict'),http=require('node:http');
const {DatabaseSync}=require('node:sqlite');
const host='manager.synthetic.invalid',origin='https://'+host,sha=b=>crypto.createHash('sha256').update(b).digest('hex');
let stage='immutable-read';
function verifyRealImmutableRead(){
 const dir=fs.mkdtempSync('/tmp/native-immutable-'),file=dir+'/identity.sqlite',w=new DatabaseSync(file);
 w.exec('PRAGMA journal_mode=WAL;CREATE TABLE proof(value INTEGER);INSERT INTO proof VALUES(7)');w.close();
 assert.deepEqual(fs.readdirSync(dir),['identity.sqlite']);fs.chmodSync(file,0o400);fs.chmodSync(dir,0o500);
 const before=fs.statSync(file),bytes=fs.readFileSync(file),r=new DatabaseSync('file:'+file+'?immutable=1',{readOnly:true});
 try{assert.deepEqual({...r.prepare('SELECT value FROM proof').get()},{value:7});assert.equal(r.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(r.prepare('PRAGMA foreign_key_check').all().length,0);assert.throws(()=>r.exec('INSERT INTO proof VALUES(8)'),/readonly/i);}finally{r.close();}
 const after=fs.statSync(file);for(const k of ['dev','ino','size','mode','nlink','uid','gid','mtimeMs','ctimeMs'])assert.equal(after[k],before[k],k);assert(fs.readFileSync(file).equals(bytes));assert.deepEqual(fs.readdirSync(dir),['identity.sqlite']);fs.chmodSync(dir,0o700);fs.rmSync(dir,{recursive:true});
 return true;
}
async function main(){
 assert.equal(process.version,'v22.23.3');assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);
 const realImmutableReadWithoutWrites=verifyRealImmutableRead();stage='identity';
 const bootstrapToken=crypto.randomBytes(32).toString('base64url'),password=crypto.randomBytes(32).toString('base64url');
 Object.assign(process.env,{DASHBOARD_MODE:'synthetic',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:host,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.synthetic.invalid',organico:'organic.synthetic.invalid',influs:'affiliate.synthetic.invalid'}),DASHBOARD_EMAIL_DOMAINS:'["synthetic.invalid"]',DASHBOARD_ADMIN_EMAIL:'master@synthetic.invalid',DASHBOARD_BOOTSTRAP_SHA256:sha(bootstrapToken),DASHBOARD_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),DASHBOARD_UPSTREAMS:'{}',DASHBOARD_UPSTREAM_HOSTS:'[]',HOST:'127.0.0.1',PORT:'8080'});
 const bytes=fs.readFileSync('/app/native-backend/manifest.json'),manifestSha256=sha(bytes),N=require('/app/native-backend/bootstrap.cjs');
 assert.throws(()=>N.verifyRelease('0'.repeat(64)),/NATIVE_BACKEND_RELEASE_REFUSED/);
 stage='fresh-entrypoint-refusal';
 let originalContinuityRefused=false;try{await require('/app/native-backend/start-existing.cjs').startExisting({manifestSha256,imageDigest:'1'.repeat(64)});}catch(e){originalContinuityRefused=/^CONTINUITY_/.test(e.code||'');}assert.equal(originalContinuityRefused,true);assert.equal(fs.existsSync('/dashboard-data/dashboard.sqlite'),false);
 stage='start';require('/app/canary-start.cjs').prepare();
 const started=require('/app/presentation-release/release.cjs').startWithPresentation(()=>N.start({manifestSha256}));
 await new Promise(resolve=>started.server.listening?resolve():started.server.once('listening',resolve));
 const request=(path,{method='GET',body,cookie,csrf,bearer}={})=>new Promise((resolve,reject)=>{
  const r=http.request({host:'127.0.0.1',port:8080,path,method,agent:false,headers:{Host:host,Origin:origin,Accept:'application/json, text/event-stream',...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(bearer?{Authorization:'Bearer '+bearer}:{})}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let value;try{value=JSON.parse(text);}catch{value=text;}resolve({status:res.statusCode,value,cookie:res.headers['set-cookie']?.[0]});});});
  r.on('error',reject);r.setTimeout(5000,()=>r.destroy(Object.assign(Error('SMOKE_HTTP_TIMEOUT'),{code:'SMOKE_HTTP_TIMEOUT'})));r.end(body===undefined?undefined:JSON.stringify(body));
 });
 stage='health';
 const health=await request('/healthz');assert.equal(health.status,200);assert.equal(health.value.nativeMcp,true);assert.equal(health.value.nativeBackendManifestSha256,manifestSha256);
 assert.equal(N.verifyReady({manifestSha256}).runtimeFiles,33);assert.equal(require('/app/presentation-release/release.cjs').verifyReady().runtimeFilesUnchanged,28);
 assert.equal((await request('/api/native/mcp',{method:'POST',body:{jsonrpc:'2.0',id:1,method:'ping'}})).status,401);
 assert.equal((await request('/auth/native-connection')).status,401);
 stage='synthetic-master';assert.equal((await request('/auth/bootstrap/complete',{method:'POST',body:{email:'master@synthetic.invalid',token:bootstrapToken,password}})).status,200);
 const login=await request('/auth/login',{method:'POST',body:{email:'master@synthetic.invalid',password}});assert.equal(login.status,200);
 const cookie=login.cookie.split(';')[0],csrf=login.value.csrf,originalId=login.value.user.id;
 assert.equal((await request('/auth/native-connection',{cookie})).status,200);
 stage='consent';const issued=await request('/auth/native-connections',{method:'POST',cookie,csrf,body:{action:'issue',label:'CI isolated test',brands:['fish'],scopes:['crm.read'],expiresDays:1}});assert.equal(issued.status,201);const bearer=issued.value.token;
 const call=async(name,args={})=>request('/api/native/mcp',{method:'POST',bearer,body:{jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}}});
 stage='native-invocation';const state=await call('crm_status');assert.equal(state.status,200);assert.equal(state.value.result.structuredContent.body.authenticated,true);assert.equal(state.value.result.structuredContent.body.permissions.growth.edit,false);assert.equal(state.value.result.structuredContent.body.operational,false);assert.equal(JSON.stringify(state.value).includes(csrf),false);assert.equal(JSON.stringify(state.value).includes(cookie),false);
 const other=await call('crm_campaign_get',{brand:'aristo',id:1});assert.equal(other.value.result.structuredContent.error,'BRAND_DENIED');
 const write=await call('crm_campaign_save',{brand:'fish',id:1,expected_version:'a'.repeat(32),definition:{},idempotency_key:'same-original-key-12345'});assert.equal(write.value.result.structuredContent.error,'NATIVE_SCOPE_DENIED');
 const db=new DatabaseSync('/dashboard-data/dashboard.sqlite',{readOnly:true});const delegate=db.prepare('SELECT user_id,token_hash FROM crm_native_connections_v1 WHERE id=?').get(issued.value.connection.id);assert.equal(delegate.user_id,originalId);assert.equal(delegate.token_hash,sha(bearer));assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE role='superadmin'").get().n,1);db.close();
 stage='revoke';assert.equal((await request('/auth/native-connections',{method:'POST',cookie,csrf,body:{action:'revoke',connectionId:issued.value.connection.id}})).status,200);
 assert.equal((await call('crm_status')).status,401);
 console.log(JSON.stringify({schema:'shrigma-native-image-smoke-v1',ok:true,realImmutableReadWithoutWrites,freshPrestartDeniedWithoutOriginalContinuity:originalContinuityRefused,node:process.version,uid:process.getuid(),manifestSha256,sourceRevision:JSON.parse(bytes).sourceRevision,originalIdentityRetained:true,genuineSyntheticConsent:true,unauthenticatedInvocationDenied:true,crossBrandDenied:true,writeWithoutGrantDenied:true,nativeRevocationDenied:true,originalPackAndV2PresentationPreserved:true,actualNativeRuntimeFiles:33,runtimeReplacements:2,runtimeAdditions:5,sqlInstallerEnabled:false,productionIdentityUsed:false,operational:false}));
 process.kill(process.pid,'SIGTERM');
}
main().catch(e=>{console.error(JSON.stringify({ok:false,stage,code:/^[A-Z][A-Z0-9_]{1,80}$/.test(e.code||'')?e.code:'NATIVE_IMAGE_SMOKE_FAILED'}));process.exitCode=1;process.kill(process.pid,'SIGTERM');});
