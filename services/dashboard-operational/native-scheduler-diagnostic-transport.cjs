'use strict';
// Uninstalled transport core. Only Root-private hooks may supply CURRENT
// authorization/binding and credentials; this module creates no admission.
const {performance}=require('node:perf_hooks');
const {timingSafeEqual}=require('node:crypto');
const MAX_BYTES=16384,TIMEOUT_MS=12000;
const URL='http://comunicacao_listmonk:9000/api/internal/campaign-scan-diagnostic';
const TARGET=Object.freeze({project:'comunicacao',service:'listmonk'});
const CURRENT_SCHEMA='shrigma-scheduler-diagnostic-current-v1';
const CREDENTIAL_SCHEMA='shrigma-listmonk-api-credential-v1';
const BINDING_KEYS=Object.freeze(['schema','service','serviceBinding','runtimeBinding','identityBinding','credentialBinding','authorizationBinding']);
const HASH=/^[a-f0-9]{64}$/;
const PHASES=Object.freeze(['BeginTxx','SelectContext']);
const SQLSTATES=Object.freeze(['08000','08001','08003','08004','08006','08007','08P01','0A000','25006','25P02','40001','40P01','42501','42601','42703','42804','42883','42P01','53100','53200','53300','55P03','57014','57P01','57P02','57P03','58000','58030','XX000','XX001','XX002','unknown']);
const STATUS=Object.freeze({
 SCANNER_DIAGNOSTIC_NOT_CONFIGURED:503,SCANNER_DIAGNOSTIC_INPUT_REFUSED:400,
 SCANNER_DIAGNOSTIC_AUTHORIZATION_REFUSED:403,SCANNER_DIAGNOSTIC_CREDENTIAL_REFUSED:403,
 SCANNER_DIAGNOSTIC_BINDING_CHANGED:409,SCANNER_DIAGNOSTIC_TRANSPORT_REFUSED:502,
 SCANNER_DIAGNOSTIC_RESPONSE_REFUSED:502,SCANNER_DIAGNOSTIC_RESPONSE_TOO_LARGE:502,
 SCANNER_DIAGNOSTIC_TIMEOUT:504
});
class Refusal extends Error {
 constructor(code){super(code);this.name='ScannerDiagnosticRefusal';this.code=code;this.status=STATUS[code];Object.defineProperty(this,'stack',{value:this.name+': '+code});Object.freeze(this);}
}
const refuse=code=>{throw new Refusal(code);};
const ordinary=(value,keys)=>{
 if(!value||Object.getPrototypeOf(value)!==Object.prototype)return false;
 const own=Reflect.ownKeys(value);
 return own.length===keys.length&&keys.every(key=>{
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  return descriptor&&Object.hasOwn(descriptor,'value')&&descriptor.enumerable;
 })&&own.every(key=>typeof key==='string'&&keys.includes(key));
};
function binding(value){
 if(!ordinary(value,BINDING_KEYS)||value.schema!==CURRENT_SCHEMA||value.service!=='comunicacao/listmonk'||
  BINDING_KEYS.slice(2).some(key=>typeof value[key]!=='string'||!HASH.test(value[key])))
  refuse('SCANNER_DIAGNOSTIC_AUTHORIZATION_REFUSED');
 return Object.freeze(Object.fromEntries(BINDING_KEYS.map(key=>[key,value[key]])));
}
const sameBinding=(a,b)=>BINDING_KEYS.every(key=>a[key]===b[key]);
function credential(value,expected){
 if(!ordinary(value,['schema','identityBinding','credentialBinding','authorization'])||
  value.schema!==CREDENTIAL_SCHEMA||value.identityBinding!==expected.identityBinding||
  value.credentialBinding!==expected.credentialBinding||typeof value.authorization!=='string'||
  !/^token ([!-9;-~]{1,256}):([!-~]{1,4096})$/.test(value.authorization))
  refuse('SCANNER_DIAGNOSTIC_CREDENTIAL_REFUSED');
 return value.authorization;
}
function equalSecret(left,right){
 const a=Buffer.from(left,'utf8'),b=Buffer.from(right,'utf8');
 try{return a.length===b.length&&timingSafeEqual(a,b);}finally{a.fill(0);b.fill(0);}
}
function timestamp(value){
 const match=/^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?Z$/.exec(value);
 if(!match)return false;
 const [,year,month,day,hour,minute,second]=match.map((part,index)=>index>0&&index<7?Number(part):part);
 const leap=year%4===0&&(year%100!==0||year%400===0);
 const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 return month>=1&&month<=12&&day>=1&&day<=days[month-1]&&hour<=23&&minute<=59&&second<=59;
}
// A narrow parser keeps duplicate keys (including escaped aliases) from being
// hidden by JSON.parse, and never constructs an object from arbitrary keys.
function parseSnapshot(text){
 let at=0;
 const bad=()=>refuse('SCANNER_DIAGNOSTIC_RESPONSE_REFUSED');
 const space=()=>{while(at<text.length&&/[ \t\r\n]/.test(text[at]))at++;};
 const consume=char=>{space();if(text[at++]!==char)bad();};
 function string(){
  space();if(text[at]!=='"')bad();
  const start=at++;
  let escaped=false;
  while(at<text.length){
   const c=text[at++];
   if(c==='"'&&!escaped){
    try{return JSON.parse(text.slice(start,at));}catch{bad();}
   }
   if(c==='\\'&&!escaped)escaped=true;else escaped=false;
  }
  bad();
 }
 consume('{');if(string()!=='data')bad();consume(':');space();
 let data=null;
 if(text.slice(at,at+4)==='null')at+=4;
 else{
  consume('{');const values=Object.create(null),seen=new Set();
  for(let count=0;count<3;count++){
   if(count)consume(',');
   const key=string();
   if(!['phase','sqlstate','timestamp'].includes(key)||seen.has(key))bad();
   seen.add(key);consume(':');values[key]=string();
  }
  consume('}');
  if(!PHASES.includes(values.phase)||!SQLSTATES.includes(values.sqlstate)||!timestamp(values.timestamp))bad();
  data=Object.freeze({phase:values.phase,sqlstate:values.sqlstate,timestamp:values.timestamp});
 }
 consume('}');space();if(at!==text.length)bad();
 return Object.freeze({data});
}
function createNativeSchedulerDiagnosticTransport(options){
 let fetchImpl,authorizeCurrent,resolveCredential;
 try{
  if(!ordinary(options,['fetchImpl','authorizeCurrent','resolveCredential'])||
   ['fetchImpl','authorizeCurrent','resolveCredential'].some(key=>typeof options[key]!=='function'))
   refuse('SCANNER_DIAGNOSTIC_NOT_CONFIGURED');
  ({fetchImpl,authorizeCurrent,resolveCredential}=options);
 }catch{refuse('SCANNER_DIAGNOSTIC_NOT_CONFIGURED');}
 return async function read(args){
  try{if(!ordinary(args,[]))refuse('SCANNER_DIAGNOSTIC_INPUT_REFUSED');}
  catch{refuse('SCANNER_DIAGNOSTIC_INPUT_REFUSED');}
  const controller=new AbortController(),deadline=performance.now()+TIMEOUT_MS;
  let active=true,timer,response,reader,authorization,delivered=false;
  const canceled=new WeakSet();
  const live=()=>{if(!active||performance.now()>=deadline)refuse('SCANNER_DIAGNOSTIC_TIMEOUT');};
  const cancel=object=>{
   if(!object||typeof object!=='object'||canceled.has(object))return;
   canceled.add(object);
   try{if(typeof object.cancel==='function')Promise.resolve(object.cancel()).catch(()=>{});}catch{}
   try{if(typeof object.releaseLock==='function')object.releaseLock();}catch{}
  };
  const close=()=>{if(reader)cancel(reader);else try{cancel(response?.body);}catch{}};
  async function current(stage,expected){
   live();let proof;
   try{proof=await authorizeCurrent(Object.freeze({stage,target:TARGET,expectedBinding:expected||null}));}
   catch{live();refuse('SCANNER_DIAGNOSTIC_AUTHORIZATION_REFUSED');}
   live();let value;
   try{value=binding(proof);}catch{refuse('SCANNER_DIAGNOSTIC_AUTHORIZATION_REFUSED');}
   if(expected&&!sameBinding(value,expected))refuse('SCANNER_DIAGNOSTIC_BINDING_CHANGED');
   return value;
  }
  async function privateCredential(expected){
   live();let value;
   try{value=await resolveCredential(Object.freeze({target:TARGET,binding:expected}));}
   catch{live();refuse('SCANNER_DIAGNOSTIC_CREDENTIAL_REFUSED');}
   live();
   try{return credential(value,expected);}catch{refuse('SCANNER_DIAGNOSTIC_CREDENTIAL_REFUSED');}
  }
  const timeout=new Promise((_,reject)=>{
   timer=setTimeout(()=>{
    active=false;controller.abort();close();
    reject(new Refusal('SCANNER_DIAGNOSTIC_TIMEOUT'));
   },TIMEOUT_MS);
  });
  const task=(async()=>{
   const before=await current('before',null);
   authorization=await privateCredential(before);
   // Revalidate after the asynchronous credential hook, directly before GET.
   await current('before',before);live();
   const request=Object.freeze({
    method:'GET',redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal,
    headers:Object.freeze({Accept:'application/json',Authorization:authorization})
   });
   let value;
   try{value=await fetchImpl(URL,request);}
   catch{live();refuse('SCANNER_DIAGNOSTIC_TRANSPORT_REFUSED');}
   if(!active||performance.now()>=deadline){
    try{cancel(value?.body);}catch{}
    refuse('SCANNER_DIAGNOSTIC_TIMEOUT');
   }
   response=value;
   try{
    if(!response||response.url!==URL||response.redirected!==false||response.status!==200||
     typeof response.headers?.get!=='function'||
     !/^application\/json(?:[ \t]*;[ \t]*charset=utf-8)?$/i.test(response.headers.get('content-type')||''))
     refuse('SCANNER_DIAGNOSTIC_TRANSPORT_REFUSED');
    const length=response.headers.get('content-length');
    if(length!==null&&(typeof length!=='string'||!/^(0|[1-9][0-9]*)$/.test(length)))
     refuse('SCANNER_DIAGNOSTIC_TRANSPORT_REFUSED');
    if(length!==null&&Number(length)>MAX_BYTES)refuse('SCANNER_DIAGNOSTIC_RESPONSE_TOO_LARGE');
    if(!response.body||typeof response.body.getReader!=='function')refuse('SCANNER_DIAGNOSTIC_TRANSPORT_REFUSED');
    reader=response.body.getReader();
    if(!reader||typeof reader.read!=='function')refuse('SCANNER_DIAGNOSTIC_TRANSPORT_REFUSED');
   }catch(error){if(error instanceof Refusal)throw error;refuse('SCANNER_DIAGNOSTIC_TRANSPORT_REFUSED');}
   const chunks=[];let bytes=0;
   while(true){
    live();let part;
    try{part=await reader.read();}catch{live();refuse('SCANNER_DIAGNOSTIC_TRANSPORT_REFUSED');}
    live();
    if(!part||typeof part.done!=='boolean')refuse('SCANNER_DIAGNOSTIC_TRANSPORT_REFUSED');
    if(part.done)break;
    if(!(part.value instanceof Uint8Array)||part.value.byteLength===0)refuse('SCANNER_DIAGNOSTIC_TRANSPORT_REFUSED');
    bytes+=part.value.byteLength;
    if(bytes>MAX_BYTES)refuse('SCANNER_DIAGNOSTIC_RESPONSE_TOO_LARGE');
    chunks.push(Buffer.from(part.value));
   }
   close(); // Finish stream cleanup before the final credential/CURRENT checks.
   let result;
   try{result=parseSnapshot(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks,bytes)));}
   catch(error){if(error instanceof Refusal)throw error;refuse('SCANNER_DIAGNOSTIC_RESPONSE_REFUSED');}
   live();
   // Credential is checked before the final CURRENT hook, so no other private
   // asynchronous callback runs after that last authorization/binding check.
   const afterCredential=await privateCredential(before);
   if(!equalSecret(authorization,afterCredential))refuse('SCANNER_DIAGNOSTIC_BINDING_CHANGED');
   await current('after',before);live();
   return result;
  })();
  task.catch(()=>{}); // Late ignored-signal failures must not be unhandled.
  try{const result=await Promise.race([task,timeout]);live();delivered=true;return result;}
  catch(error){if(error instanceof Refusal)throw error;refuse('SCANNER_DIAGNOSTIC_TRANSPORT_REFUSED');}
  finally{active=false;clearTimeout(timer);if(!delivered)controller.abort();close();authorization=undefined;}
 };
}
module.exports=Object.freeze({createNativeSchedulerDiagnosticTransport,MAX_BYTES,TIMEOUT_MS,PHASES,SQLSTATES,CURRENT_SCHEMA,CREDENTIAL_SCHEMA,TARGET,REFUSAL_CODES:Object.freeze(Object.keys(STATUS))});
