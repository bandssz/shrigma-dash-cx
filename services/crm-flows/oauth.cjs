'use strict';
// Shopify OAuth token cache belongs to fixed server configuration, never a request.
function createTokenProvider({shops,oauth,fetchImpl=fetch,clock=Date.now}={}){
 const cached=new Map(),pending=new Map();
 async function obtain(brand){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
  try{
   const c=oauth[brand],response=await fetchImpl('https://'+shops[brand].myshopifyDomain+'/admin/oauth/access_token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',client_id:c.clientId,client_secret:c.clientSecret}),redirect:'error',signal:controller.signal});
   if(response.status!==200||!response.body)throw Error();let size=0;const parts=[];
   for await(const chunk of response.body){size+=chunk.length;if(size>16384){controller.abort();throw Error();}parts.push(Buffer.from(chunk));}
   const value=JSON.parse(Buffer.concat(parts).toString('utf8'));
   if(typeof value.access_token!=='string'||!value.access_token||/[\s\0]/.test(value.access_token)||!Number.isSafeInteger(value.expires_in)||value.expires_in<120||value.expires_in>86400)throw Error();
   cached.set(brand,{token:value.access_token,expires:clock()+value.expires_in*1000-60000});return value.access_token;
  }catch{throw Object.assign(Error('GRAPH_SERVICE_AUTH_UNAVAILABLE'),{code:'GRAPH_SERVICE_AUTH_UNAVAILABLE'});}finally{clearTimeout(timer);}
 }
 return async (brand,{signal}={})=>{
  if(!['fish','aristo'].includes(brand)||!shops?.[brand]||!oauth?.[brand])throw Object.assign(Error('GRAPH_SERVICE_BRAND'),{code:'GRAPH_SERVICE_BRAND'});
  if(signal?.aborted)throw Object.assign(Error('GRAPH_SERVICE_AUTH_ABORTED'),{code:'GRAPH_SERVICE_AUTH_ABORTED'});
  const value=cached.get(brand);if(value&&value.expires>clock())return value.token;
  if(!pending.has(brand))pending.set(brand,obtain(brand).finally(()=>pending.delete(brand)));
  if(!signal)return pending.get(brand);
  let abort;try{return await Promise.race([pending.get(brand),new Promise((_,reject)=>{abort=()=>reject(Object.assign(Error('GRAPH_SERVICE_AUTH_ABORTED'),{code:'GRAPH_SERVICE_AUTH_ABORTED'}));signal.addEventListener('abort',abort,{once:true});})]);}
  finally{signal.removeEventListener('abort',abort);}
 };
}
module.exports={createTokenProvider};
