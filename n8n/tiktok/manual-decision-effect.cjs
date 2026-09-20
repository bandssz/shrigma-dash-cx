/* One Code invocation owns both dispatch CAS and HTTP. No durable allowed output
 * is accepted as authority. Every invocation, including worker recovery, repeats
 * the CAS; an in_flight reservation never authorizes another provider request. */
'use strict';
function createEffect(C,M){
 const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
 const parse=x=>{if(typeof x!=='string')return x;try{return JSON.parse(x);}catch{return null;}};
 function utility(config){
  if(!object(config)||typeof config.url!=='string'||!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/webhook\/[A-Za-z0-9/_-]+$/.test(config.url)
   ||typeof config.key!=='string'||!config.key||config.key.length>8192||config.keyField!=='k'||config.queryField!=='q'||config.argsField!=='args')throw Error('TTS_MANUAL_UTILITY_CONFIG');
  return config;
 }
 function httpOptions(url,body,headers){return {method:'POST',url,body,headers,returnFullResponse:true,disableFollowRedirect:true,ignoreHttpStatusErrors:true,encoding:'text',timeout:30000,json:false};}
 async function execute(p,config,{http,makeRequest}={}){
  M.bound(p);utility(config);
  if(typeof http!=='function'||typeof makeRequest!=='function')throw Error('TTS_MANUAL_EFFECT_DEPENDENCY');
  let owned;
  try{
   const q=C.query('dispatch',p),body=JSON.stringify({[config.keyField]:config.key,[config.queryField]:q.sql,[config.argsField]:q.parameters});
   const response=await http(httpOptions(config.url,body,{'content-type':'application/json'})),rows=parse(response?.body);
   if(response?.statusCode!==200||response.error||!Array.isArray(rows)||rows.length!==1||!object(rows[0])||!object(rows[0].result))return M.uncertain(p);
   const gate=M.dispatch(p,rows[0].result);
   if(gate._route!=='transport')return gate;
   owned=gate.owned;
  }catch{return M.uncertain(p);}
  // There is deliberately no node boundary between the fresh witness and HTTP.
  // A crash here leaves in_flight. Re-entering this function must lose the CAS.
  let receipt;
  try{
   const request=makeRequest(owned),path='/affiliate_seller/202409/sample_applications/'+p.application_id+'/review?';
   const expected={review_result:p.request_payload.resultado};if(expected.review_result==='REJECT')expected.reject_reason=p.request_payload.motivo_rejeicao;
   if(!object(request)||typeof request.url!=='string'||!request.url.startsWith('https://open-api.tiktokglobalshop.com'+path)||request.body!==JSON.stringify(expected)
    ||!object(request.headers)||Object.keys(request.headers).sort().join(',')!=='content-type,x-tts-access-token'||request.headers['content-type']!=='application/json'||typeof request.headers['x-tts-access-token']!=='string'||!request.headers['x-tts-access-token'])throw Error('TTS_MANUAL_EFFECT_REQUEST');
   receipt=M.providerReceipt(await http(httpOptions(request.url,request.body,request.headers)));
  }catch{receipt={kind:'outcome_unknown',provider_code:null,request_id:null,reason:'transport_uncertain'};}
  return {_route:'finish',finish:{...owned,receipt}};
 }
 return {execute,utility,httpOptions};
}
module.exports={createEffect};
