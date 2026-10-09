'use strict';
// Includes a monotonic deadline guard for late results before timer callbacks.
// Synthetic private credentials and disposable SQLite only. Never production.
const test=require('node:test'),a=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const runtime=process.env.SCHEDULER_BINDING_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational');
const P=require(runtime+'/native-scheduler-api-profile.cjs'),B=require(runtime+'/native-scheduler-binding.cjs');
const c={apiUser:'isolated_api',apiToken:'isolated-private-api-token_123456'};
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const profile=(delta={})=>({data:{id:19,username:c.apiUser,type:'api',status:'enabled',password:null,user_role:{id:2,name:'isolated-read-only',permissions:['settings:get']},...delta}});
function response(value,{status=200,url=P.URL,redirected=false,contentType='application/json; charset=UTF-8',bytes}={}){
 const b=bytes??Buffer.from(JSON.stringify(value));let consumed=false;
 return {url,status,redirected,headers:{get:k=>k==='content-type'?contentType:k==='content-length'?String(b.length):null},body:{getReader:()=>({read:async()=>consumed?{done:true}:(consumed=true,{done:false,value:b}),cancel:async()=>{}})}};
}
test('original API profile fixed GET authenticates token privately and exposes only identity hash',async()=>{
 const calls=[],v=await P.createOriginalApiVerifier({fetchImpl:async(url,args)=>{calls.push({url,args});return response(profile());}})(c);
 a.equal(calls.length,1);a.equal(calls[0].url,P.URL);a.equal(calls[0].args.method,'GET');a.equal(calls[0].args.redirect,'error');a.equal(calls[0].args.headers.Authorization,'token '+c.apiUser+':'+c.apiToken);a.equal(calls[0].args.headers.Cookie,undefined);
 a.equal(v.settingsReadPermitted,true);a.equal(v.authenticationView,'original-api-cache');a(!JSON.stringify(v).includes(c.apiToken));a(!JSON.stringify(v).includes(c.apiUser));
 a.deepEqual(P.profile(profile({user_role:{id:1,name:'superadmin',permissions:null}}),c.apiUser).roleId,1);
});
for(const [label,delta,code] of [
 ['wrong identity',{username:'different'},'SCHEDULER_API_PROFILE_REFUSED'],['interactive user',{type:'user'},'SCHEDULER_API_PROFILE_REFUSED'],['disabled',{status:'disabled'},'SCHEDULER_API_PROFILE_REFUSED'],['legacy configuration identity',{id:0},'SCHEDULER_API_PROFILE_REFUSED'],
 ['secret returned',{password:c.apiToken},'SCHEDULER_API_PROFILE_REFUSED'],['no original permission',{user_role:{id:2,name:'reader',permissions:['campaigns:get']}},'SCHEDULER_API_PERMISSION_REFUSED'],
 ['null nonadmin permissions',{user_role:{id:2,name:'reader',permissions:null}},'SCHEDULER_API_PERMISSION_REFUSED'],
 ['fake admin by name',{user_role:{id:2,name:'superadmin',permissions:[]}},'SCHEDULER_API_PERMISSION_REFUSED']
])test('profile refuses '+label,()=>a.throws(()=>P.profile(profile(delta),c.apiUser),{code}));
test('duplicate keys, invalid UTF8 and oversized private response refuse without output/retry',async()=>{
 for(const bytes of [Buffer.from('{"data":'+JSON.stringify(profile().data)+',"data":'+JSON.stringify(profile().data)+'}'),Buffer.from([0xff]),Buffer.alloc(16385,32)]){
  let calls=0;await a.rejects(P.createOriginalApiVerifier({fetchImpl:async()=>{calls++;return response(null,{bytes});}})(c),{code:'SCHEDULER_API_PROFILE_REFUSED'});a.equal(calls,1);
 }
});
test('peer redirect, HTTP auth failure and arbitrary/raw exceptions are finite refusals',async()=>{
 for(const options of [{status:403},{redirected:true},{url:'http://foreign/api/profile'},{contentType:'text/html'}])await a.rejects(P.createOriginalApiVerifier({fetchImpl:async()=>response(profile(),options)})(c),{code:'SCHEDULER_API_PEER_REFUSED'});
 await a.rejects(P.createOriginalApiVerifier({fetchImpl:async()=>{throw Error(c.apiToken);}})(c),e=>e.code==='SCHEDULER_API_UNAVAILABLE'&&!e.stack.includes(c.apiToken));
});
test('profile deadline covers ignored-signal fetch and stalled body without repeated GET',async()=>{
 for(const fetchImpl of [()=>new Promise(()=>{}),async()=>({...response(profile()),body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:()=>new Promise(()=>{})})}})]){
  await a.rejects(P.createOriginalApiVerifier({fetchImpl,timeoutMs:10})(c),{code:'SCHEDULER_API_TIMEOUT'});
 }
});
const browser={method:'POST'},native={method:'GET',nativeBearer:'isolated-native-token'};
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES('isolated-owner');CREATE TABLE crm_native_connections_v1(id TEXT PRIMARY KEY);");
 const connectionId='a1111111-1111-4111-8111-111111111111';db.prepare('INSERT INTO crm_native_connections_v1 VALUES(?)').run(connectionId);
 let live=true,revision=1,clock=1000,profileHash=hash('original-api-fixture');const calls=[];
 const current=()=>{if(!live)throw Object.assign(Error('SCHEDULER_CONNECTION_REFUSED'),{code:'SCHEDULER_CONNECTION_REFUSED'});return {ownerId:'isolated-owner',ownerRevision:hash('owner'),profileRevision:revision,connectionHash:hash('connection'),authorityHash:hash('original-crm')};};
 const encrypt=s=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',Buffer.alloc(32,7),iv),b=Buffer.concat([cipher.update(s),cipher.final()]);return [iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),b.toString('base64url')].join('.');};
 const decrypt=s=>{const [iv,tag,b]=s.split('.').map(x=>Buffer.from(x,'base64url')),dec=crypto.createDecipheriv('aes-256-gcm',Buffer.alloc(32,7),iv);dec.setAuthTag(tag);return Buffer.concat([dec.update(b),dec.final()]).toString();};
 const options={enabled:true,db,current,encrypt,decrypt,mac:s=>crypto.createHmac('sha256',Buffer.alloc(32,5)).update(s).digest('hex'),now:()=>clock,verify:async value=>{calls.push(value.apiToken);return {profileHash,settingsReadPermitted:true,authenticationView:'original-api-cache'};}};
 const vault=B.createSchedulerBinding(options);
 return {db,connectionId,vault,calls,options,close:()=>db.close(),revokeOwner:()=>{live=false;},changeProfile:()=>{revision++;},changeApi:()=>{profileHash=hash('changed');},tick:()=>{clock++;}};
}
const bind=f=>f.vault.bind({context:browser,connectionId:f.connectionId,...c,consent:true});
test('private binding encrypted in existing identity DB has own consent and pins no send/recovery',async()=>{
 const f=fixture();try{a.equal(f.vault.status({context:browser,connectionId:f.connectionId}).linked,false);const v=await bind(f);
 a.equal(v.purpose,B.SCOPE);a.equal(v.linked,true);a.equal(v.consented,true);a.equal(v.authorizesSend,false);a.equal(v.operational,false);a(!JSON.stringify(v).includes(c.apiToken));
 const row=f.db.prepare('SELECT * FROM crm_scheduler_api_binding_v1').get();a(!row.encrypted_json.includes(c.apiToken));a.equal(f.db.prepare('SELECT COUNT(*) n FROM crm_scheduler_read_consent_v1').get().n,1);
 }finally{f.close();}
});
test('no inherited read/db.inspect/health purpose and no native self binding',async()=>{
 const f=fixture();try{await a.rejects(f.vault.withVerifiedCredential({context:native,connectionId:f.connectionId,read:async()=>{throw Error('must not read');}}),{code:'SCHEDULER_API_BINDING_REQUIRED'});
 await a.rejects(f.vault.bind({context:native,connectionId:f.connectionId,...c,consent:true}),{code:'SCHEDULER_BROWSER_CONSENT_REQUIRED'});
 await a.rejects(f.vault.bind({context:browser,connectionId:f.connectionId,...c,consent:false}),{code:'SCHEDULER_BROWSER_CONSENT_REQUIRED'});a.equal(f.calls.length,0);
 }finally{f.close();}
});
test('owner changes during original profile verify leave no persisted credential or consent',async()=>{
 const f=fixture();try{const vault=B.createSchedulerBinding({...f.options,verify:async()=>{f.changeProfile();return {profileHash:hash('api'),settingsReadPermitted:true,authenticationView:'original-api-cache'};}});
 await a.rejects(vault.bind({context:browser,connectionId:f.connectionId,...c,consent:true}),{code:'SCHEDULER_BINDING_CHANGED'});
 a.equal(f.db.prepare('SELECT COUNT(*) n FROM crm_scheduler_api_binding_v1').get().n,0);a.equal(f.db.prepare('SELECT COUNT(*) n FROM crm_scheduler_read_consent_v1').get().n,0);
 }finally{f.close();}
});
test('private native READ rechecks original identity, owner and consent before/releasing output',async()=>{
 const f=fixture();try{await bind(f);let reads=0;
 const result=await f.vault.withVerifiedCredential({context:native,connectionId:f.connectionId,read:async(cred,check)=>{a.equal(cred.apiToken,c.apiToken);a.equal(check().purpose,B.SCOPE);reads++;return {data:null};}});
 a.deepEqual(result,{data:null});a.equal(reads,1);a.equal(f.calls.length,3);
 await a.rejects(f.vault.withVerifiedCredential({context:native,connectionId:f.connectionId,read:async()=>{f.revokeOwner();return {secret:'suppress'};}}),{code:'SCHEDULER_CONNECTION_REFUSED'});
 }finally{f.close();}
});
test('original API permission/profile change rejects without touching diagnostic endpoint',async()=>{
 const f=fixture();try{await bind(f);f.changeApi();let reads=0;await a.rejects(f.vault.withVerifiedCredential({context:native,connectionId:f.connectionId,read:async()=>{reads++;}}),{code:'SCHEDULER_API_PROFILE_CHANGED'});a.equal(reads,0);}finally{f.close();}
});
test('rotation preserves historical binding/consent and denies old in-flight output',async()=>{
 const f=fixture();try{const original=await bind(f),next={...c,apiToken:'isolated-rotated-token_123456789'};
 await a.rejects(f.vault.withVerifiedCredential({context:native,connectionId:f.connectionId,read:async()=>{await f.vault.bind({context:browser,connectionId:f.connectionId,...next,consent:true});return {data:null};}}),{code:'SCHEDULER_BINDING_CHANGED'});
 a.equal(f.db.prepare('SELECT COUNT(*) n FROM crm_scheduler_api_binding_v1').get().n,2);a.equal(f.db.prepare('SELECT COUNT(*) n FROM crm_scheduler_read_consent_v1').get().n,2);a.equal(f.db.prepare('SELECT revoked_at FROM crm_scheduler_api_binding_v1 WHERE id=?').get(original.bindingId).revoked_at,1000);
 a.equal(f.vault.status({context:browser,connectionId:f.connectionId}).linked,true);
 }finally{f.close();}
});
test('explicit binding revoke denies later READ and audit contains no credential',async()=>{
 const f=fixture();try{await bind(f);f.vault.revoke({context:browser,connectionId:f.connectionId});a.equal(f.vault.status({context:browser,connectionId:f.connectionId}).linked,false);await a.rejects(f.vault.withVerifiedCredential({context:native,connectionId:f.connectionId,read:async()=>({data:null})}),{code:'SCHEDULER_API_BINDING_REQUIRED'});a(!JSON.stringify(f.db.prepare('SELECT * FROM crm_scheduler_binding_audit_v1').all()).includes(c.apiToken));}finally{f.close();}
});
test('tampered encrypted record or consent never releases a credential',async()=>{
 for(const table of ['crm_scheduler_api_binding_v1','crm_scheduler_read_consent_v1']){const f=fixture();try{await bind(f);f.db.exec(table==='crm_scheduler_api_binding_v1'?"UPDATE crm_scheduler_api_binding_v1 SET encrypted_json='tamper'":"UPDATE crm_scheduler_read_consent_v1 SET purpose='db.inspect'");await a.rejects(f.vault.withVerifiedCredential({context:native,connectionId:f.connectionId,read:async()=>{throw Error('must not read');}}));}finally{f.close();}}
});

test('monotonic late profile result refuses before timer callback gets an event-loop turn',async t=>{
 const {performance}=require('node:perf_hooks');let clock=0;t.mock.method(performance,'now',()=>clock);
 await a.rejects(P.createOriginalApiVerifier({fetchImpl:async()=>{clock=12001;return response(profile());}})(c),{code:'SCHEDULER_API_TIMEOUT'});
});
