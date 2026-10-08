'use strict';
// Existing original service only; never accepts a destination from a caller.
const ORIGIN='http://comunicacao_crm-shopify-sync:8080';
const REVISION='79861de6f9c3628885e7840858011180b5af9899';
const KEY=/^[A-Za-z0-9_.:-]{32,256}$/,IDEM=/^[A-Za-z0-9_.:-]{16,160}$/;
const fail=()=>{throw Object.assign(Error('SOURCE_TRANSPORT_UNAVAILABLE'),{code:'SOURCE_TRANSPORT_UNAVAILABLE',status:502});};
function createOriginalSourceTransport({fetchImpl=fetch}={}){
 if(typeof fetchImpl!=='function')fail();
 return async function transport(input){
  if(!input||Object.getPrototypeOf(input)!==Object.prototype||Object.keys(input).some(k=>!['method','path','body','bearer'].includes(k)))fail();
  const {method,path,body,bearer}=input;
  const health=method==='GET'&&path==='/healthz';
  let authenticated=method==='POST'&&path==='/v1/run';
  if(method==='GET'&&typeof path==='string'&&path.startsWith('/v1/operations/')){
   const encoded=path.slice('/v1/operations/'.length);let decoded;try{decoded=decodeURIComponent(encoded);}catch{fail();}authenticated=IDEM.test(decoded)&&encodeURIComponent(decoded)===encoded;
  }
  if(!health&&!authenticated||health&&(body!==undefined||bearer!==undefined)||authenticated&&!KEY.test(bearer||''))fail();
  if(method==='POST'){
   if(!body||Object.getPrototypeOf(body)!==Object.prototype||Object.keys(body).sort().join(',')!=='brand,idempotency_key,scheduled_for'||!['fish','aristo'].includes(body.brand)||!IDEM.test(body.idempotency_key||'')||typeof body.scheduled_for!=='string'||!/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/.test(body.scheduled_for)||!Number.isFinite(Date.parse(body.scheduled_for)))fail();
  }else if(body!==undefined)fail();
  const url=ORIGIN+path,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);timer.unref?.();
  try{
   const response=await fetchImpl(url,{method,redirect:'error',signal:controller.signal,headers:{Accept:'application/json',...(authenticated?{Authorization:'Bearer '+bearer}:{}),...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:JSON.stringify(body)}:{})});
   if(response.url!==url||response.redirected||!Number.isInteger(response.status)||response.status<200||response.status>=600||response.status>=300&&response.status<400||response.headers.get('x-crm-shopify-sync-revision')!==REVISION||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')||''))fail();
   const cap=16384,length=response.headers.get('content-length');if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>cap))fail();
   if(!response.body||typeof response.body.getReader!=='function')fail();const reader=response.body.getReader(),chunks=[];let bytes=0;
   try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;if(bytes>cap)fail();chunks.push(Buffer.from(r.value));}}finally{await reader.cancel().catch(()=>{});}
   let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail();}
   if(!value||Object.getPrototypeOf(value)!==Object.prototype)fail();
   return {status:response.status,revision:REVISION,body:value};
  }catch{fail();}finally{clearTimeout(timer);controller.abort();}
 };
}
module.exports=Object.freeze({createOriginalSourceTransport,ORIGIN,REVISION});
