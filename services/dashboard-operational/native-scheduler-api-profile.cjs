'use strict';
// This verifies the authenticated ORIGINAL API identity through its existing
// profile route. No PG login, browser cookie, caller actor or grant is accepted.
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const URL='http://comunicacao_listmonk:9000/api/profile';
const ORIGINAL_AUTH_SOURCE='1b5e8d38c778e869003486d3c38bc7a964661e91';
const own=(v,k)=>Object.hasOwn(v,k);
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>own(v,k)&&own(Object.getOwnPropertyDescriptor(v,k),'value'));
const fail=(code,status=503)=>{throw Object.assign(Error(code),{code,status});};
function credential(v){
 if(!exact(v,['apiUser','apiToken'])||typeof v.apiUser!=='string'||!/^[A-Za-z0-9_.@+-]{1,80}$/.test(v.apiUser)||typeof v.apiToken!=='string'||!/^[!-~]{16,512}$/.test(v.apiToken))fail('SCHEDULER_API_CREDENTIAL_REFUSED',400);
 return {apiUser:v.apiUser,apiToken:v.apiToken};
}
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function parsePrivateProfile(bytes){
 let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{fail('SCHEDULER_API_PROFILE_REFUSED');}
 if(text.charCodeAt(0)===0xfeff)fail('SCHEDULER_API_PROFILE_REFUSED');
 const stack=[];
 for(let i=0;i<text.length;i++){
  const c=text[i];if(c==='{'){stack.push(new Set());continue;}if(c==='['){stack.push(null);continue;}if(c==='}'||c===']'){stack.pop();continue;}
  if(c!=='"')continue;let end=i+1;
  for(;end<text.length;end++){if(text[end]==='\\'){end++;continue;}if(text[end]==='"')break;}
  let next=end+1;while(/\s/.test(text[next]||'')&&next<text.length)next++;
  if(text[next]===':'){let key;try{key=JSON.parse(text.slice(i,end+1));}catch{fail('SCHEDULER_API_PROFILE_REFUSED');}const keys=stack.at(-1);if(!(keys instanceof Set)||keys.has(key))fail('SCHEDULER_API_PROFILE_REFUSED');keys.add(key);}
  i=end;
 }
 try{return JSON.parse(text);}catch{fail('SCHEDULER_API_PROFILE_REFUSED');}
}
function profile(value,apiUser){
 if(!exact(value,['data']))fail('SCHEDULER_API_PROFILE_REFUSED');
 const p=value.data,allowed=['id','created_at','updated_at','username','password','password_login','email','name','type','status','avatar','twofa_type','loggedin_at','user_role_id','list_role_id','user_role','list_role'];
 if(!p||Object.getPrototypeOf(p)!==Object.prototype||Reflect.ownKeys(p).some(k=>typeof k!=='string'||!allowed.includes(k)||!own(Object.getOwnPropertyDescriptor(p,k),'value'))||!Number.isSafeInteger(p.id)||p.id<1||p.username!==apiUser||p.type!=='api'||p.status!=='enabled'||own(p,'password')&&p.password!==null)fail('SCHEDULER_API_PROFILE_REFUSED');
 const r=p.user_role;
 const permissions=r?.permissions===null&&r?.id===1?[]:r?.permissions;
 if(!exact(r,['id','name','permissions'])||!Number.isSafeInteger(r.id)||r.id<1||typeof r.name!=='string'||r.name.length>256||!Array.isArray(permissions)||permissions.length>128||permissions.some(x=>typeof x!=='string'||!/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/.test(x))||new Set(permissions).size!==permissions.length||own(p,'user_role_id')&&p.user_role_id!==r.id||r.id!==1&&!permissions.includes('settings:get'))fail('SCHEDULER_API_PERMISSION_REFUSED',403);
 const normalized={originalId:p.id,usernameHash:hash(p.username),roleId:r.id,permissionsHash:hash(JSON.stringify([...permissions].sort())),originalAuthSource:ORIGINAL_AUTH_SOURCE};
 return Object.freeze({...normalized,profileHash:hash(JSON.stringify(normalized)),authenticationView:'original-api-cache',settingsReadPermitted:true});
}
function createOriginalApiVerifier({fetchImpl=fetch,timeoutMs=12000}={}){
 if(typeof fetchImpl!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>12000)fail('SCHEDULER_API_CONFIGURATION_REFUSED');
 return async function verify(input){
  const c=credential(input),ac=new AbortController(),deadline=performance.now()+timeoutMs;let reader,timer,expired=false;
  const live=()=>{if(expired||performance.now()>=deadline){expired=true;ac.abort();fail('SCHEDULER_API_TIMEOUT',504);}};
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;ac.abort();reject(Object.assign(Error('SCHEDULER_API_TIMEOUT'),{code:'SCHEDULER_API_TIMEOUT',status:504}));},timeoutMs);});
  const task=(async()=>{
   const r=await fetchImpl(URL,{method:'GET',redirect:'error',cache:'no-store',signal:ac.signal,headers:{Accept:'application/json',Authorization:'token '+c.apiUser+':'+c.apiToken}});
   if(expired||performance.now()>=deadline){Promise.resolve().then(()=>r.body?.cancel?.()).catch(()=>{});live();}
   if(r.url!==URL||r.redirected||r.status!==200||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(r.headers?.get('content-type')||''))fail('SCHEDULER_API_PEER_REFUSED');
   const length=r.headers.get('content-length');
   if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>16384)||!r.body||typeof r.body.getReader!=='function')fail('SCHEDULER_API_PROFILE_REFUSED');
   reader=r.body.getReader();let bytes=0;const chunks=[];
   while(true){const x=await reader.read();live();if(x.done)break;if(!(x.value instanceof Uint8Array)||x.value.byteLength===0)fail('SCHEDULER_API_PROFILE_REFUSED');bytes+=x.value.byteLength;if(bytes>16384)fail('SCHEDULER_API_PROFILE_REFUSED');chunks.push(Buffer.from(x.value));}
   const value=profile(parsePrivateProfile(Buffer.concat(chunks)),c.apiUser);live();return value;
  })();
  try{return await Promise.race([task,timeout]);}
  catch(e){if(['SCHEDULER_API_PROFILE_REFUSED','SCHEDULER_API_PERMISSION_REFUSED','SCHEDULER_API_PEER_REFUSED','SCHEDULER_API_TIMEOUT'].includes(e?.code))throw Object.assign(Error(e.code),{code:e.code,status:e.status});fail('SCHEDULER_API_UNAVAILABLE');}
  finally{expired=true;clearTimeout(timer);ac.abort();if(reader)Promise.resolve().then(()=>reader.cancel()).catch(()=>{});}
 };
}
module.exports=Object.freeze({createOriginalApiVerifier,credential,profile,URL,ORIGINAL_AUTH_SOURCE});
