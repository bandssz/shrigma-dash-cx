'use strict';
// Local candidate only. Compose with the existing /segments adapter; no new
// listener, credentials, worker, request table or scheduling authority.
const {ACTION,RECOVER,validateRequest,receipt}=require('./segment-audience-native-freeze.cjs');
const ORIGIN='https://bandssz.github.io',LIMIT=32768;
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const reply=(status,body)=>({status,headers:{'Cache-Control':'no-store'},body});
const failure=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
const recoveryValid=p=>exact(p,['acao','brand','idempotency_key'])&&p.acao===RECOVER&&['aristo','fish'].includes(p.brand)&&/^[A-Za-z0-9_.:-]{8,128}$/.test(p.idempotency_key||'');
function parse(value){
 if(!exact(value,['method','request'])||!['GET','POST'].includes(value.method))failure('NATIVE_FREEZE_METHOD',405);
 const r=value.request;if(!r||Object.getPrototypeOf(r)!==Object.prototype||Object.keys(r).some(k=>!['headers','query','body'].includes(k)))failure('NATIVE_FREEZE_INPUT');
 const h=r.headers;if(!h||Object.getPrototypeOf(h)!==Object.prototype)failure('NATIVE_FREEZE_UNAUTHORIZED',401);
 const auth=Object.entries(h).filter(([k])=>k.toLowerCase()==='authorization'),origins=Object.entries(h).filter(([k])=>k.toLowerCase()==='origin');
 if(origins.length>1||origins.length===1&&origins[0][1]!==ORIGIN)failure('NATIVE_FREEZE_ORIGIN',403);
 if(auth.length!==1||typeof auth[0][1]!=='string'||!/^Bearer [a-z0-9-]{8,128}$/.test(auth[0][1]))failure('NATIVE_FREEZE_UNAUTHORIZED',401);
 if(value.method==='POST'&&r.query&&(!exact(r.query,[]) )||value.method==='GET'&&r.body&&(!exact(r.body,[])))failure('NATIVE_FREEZE_INPUT');
 const raw=value.method==='POST'?r.body:r.query;
 let p;try{const text=JSON.stringify(raw);if(typeof text!=='string'||Buffer.byteLength(text)>LIMIT)failure('NATIVE_FREEZE_SIZE',413);p=JSON.parse(text);}catch(e){if(e.code==='NATIVE_FREEZE_SIZE')throw e;failure('NATIVE_FREEZE_INPUT');}
 if(p?.acao===ACTION){if(value.method!=='POST')failure('NATIVE_FREEZE_METHOD',405);validateRequest(p);}
 else if(p?.acao===RECOVER){if(value.method!=='GET')failure('NATIVE_FREEZE_METHOD',405);if(!recoveryValid(p))failure('NATIVE_FREEZE_INPUT');}
 else failure('NATIVE_FREEZE_INPUT');
 return{key:auth[0][1].slice(7),request:p,writing:p.acao===ACTION};
}
const confirmedErrors=Object.freeze({NATIVE_FREEZE_INPUT:400,NATIVE_FREEZE_UNAUTHORIZED:401,NATIVE_FREEZE_ORIGIN:403,NATIVE_FREEZE_METHOD:405,NATIVE_FREEZE_SIZE:413,NATIVE_FREEZE_ACCESS_CHANGED:403,NATIVE_FREEZE_REQUEST_CONFLICT:409,NATIVE_FREEZE_CATALOG_CHANGED:409,NATIVE_FREEZE_AUDIENCE_CHANGED:409,SEGMENT_UNAUTHORIZED:401,SEGMENT_ACCESS_DENIED:403});
function createNativeAudienceAPI({legacy,freeze,enabled=false}={}){
 if(typeof legacy?.handle!=='function'||typeof freeze?.execute!=='function'||typeof freeze?.recover!=='function'||typeof enabled!=='boolean')throw Error('NATIVE_FREEZE_HTTP_CONFIG');
 async function handle(value,{signal}={}){
  const actions=[value?.request?.body?.acao,value?.request?.query?.acao];
  if(!actions.some(x=>x===ACTION||x===RECOVER))return legacy.handle(value,{signal});
  let entry;try{entry=parse(value);}catch(e){const status=confirmedErrors[e.code];return reply(status||400,{error:status?e.code:'NATIVE_FREEZE_INPUT'});}
  if(!enabled)return reply(503,{error:'NATIVE_FREEZE_DISABLED'});
  try{
   if(signal?.aborted)failure('NATIVE_FREEZE_ABORTED',503);
   const result=await freeze[entry.writing?'execute':'recover']({...entry,signal});
   if(signal?.aborted)failure('NATIVE_FREEZE_ABORTED',503);
   if(!entry.writing&&exact(result,['_http','_body'])&&result._http===404&&exact(result._body,['error','state','idempotency_key'])&&result._body.error==='NATIVE_FREEZE_NOT_OBSERVED'&&result._body.state==='unconfirmed'&&result._body.idempotency_key===entry.request.idempotency_key)return reply(404,result._body);
   // Original recover() binds actor/key/action/hash; project only its strict DTO.
   const request=entry.writing?entry.request:{brand:entry.request.brand,id:result?._body?.audience_id,expected_version:result?._body?.audience_version,expected_definition_hash:result?._body?.definition_hash};
   if(!entry.writing&&(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.id||'')||!Number.isSafeInteger(request.expected_version)||request.expected_version<1||request.expected_version>999999999||!/^[a-f0-9]{64}$/.test(request.expected_definition_hash||'')))failure('NATIVE_FREEZE_READBACK',503);
   const checked=receipt(result,request);if(signal?.aborted)failure('NATIVE_FREEZE_ABORTED',503);return reply(200,checked._body);
  }catch(e){
   const status=confirmedErrors[e.code];if(status)return reply(status,{error:e.code});
   // An uncertain POST is reconciled only by GET with the original key. A GET
   // that cannot observe a receipt never authorizes repeating that POST.
   return reply(entry.writing?202:503,{error:'NATIVE_FREEZE_UNCONFIRMED',state:'unconfirmed',idempotency_key:entry.request.idempotency_key});
  }
 }
 return Object.freeze({enabled,handle});
}
module.exports={createNativeAudienceAPI,parse};
