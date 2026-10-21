'use strict';
// Same API16 credential as the original service. Closed, GET-only paths.
function createNativeReadTransport({origin,username,token,fetchFn=fetch,timeoutMs=20000,maxResponseBytes=8*1024*1024}){
 const url=new URL(origin);if(url.origin!=='https://email.shrigma.com.br'||url.href!==url.origin+'/'||!username||!token)throw Error('NATIVE_CONFIGURATION');
 const authorization='Basic '+Buffer.from(username+':'+token).toString('base64');
 return async path=>{
  if(typeof path!=='string'||!(/^\/api\/campaigns\/[1-9][0-9]{0,9}$/.test(path)||path==='/api/lists?minimal=true&per_page=all'||/^\/api\/campaigns\?no_body=false&per_page=100&page=[1-9][0-9]{0,3}$/.test(path)))throw Error('NATIVE_READ_PATH_INVALID');
  let r;try{r=await fetchFn(url.origin+path,{method:'GET',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(timeoutMs),headers:{Authorization:authorization,Accept:'application/json'}});}catch{throw Error('NATIVE_READ_UNAVAILABLE');}
  if(r.status!==200||!r.body||Number(r.headers.get('content-length'))>maxResponseBytes){await r.body?.cancel();throw Error('NATIVE_READ_UNCONFIRMED');}
  const chunks=[];let bytes=0;for await(const chunk of r.body){bytes+=chunk.length;if(bytes>maxResponseBytes)throw Error('NATIVE_READ_UNCONFIRMED');chunks.push(chunk);}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('NATIVE_READ_UNCONFIRMED');}
  if(!Object.hasOwn(value,'data'))throw Error('NATIVE_READ_UNCONFIRMED');return value.data;
 };
}
module.exports={createNativeReadTransport};
