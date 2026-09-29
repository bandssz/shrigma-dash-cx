'use strict';
// HTTP-shaped candidate only. This module opens no listener and installs no route.
const B=require('./segment-campaign-binding.cjs'),C=require('../../growth-campaign-audience-client.js'),H=require('./segment-audience-review.cjs');
const VERSION=B.VERSION,ENABLED=false,V=C.validation;
const exact=(o,keys)=>!!o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const fail=(code,status=400)=>Object.assign(Error(code),{code,status}),response=(status,body)=>({status,headers:{'Cache-Control':'no-store'},body});
const errors=new Set(['SEGMENT_BINDING_INPUT','SEGMENT_UNAUTHORIZED','SEGMENT_ACCESS_DENIED','SEGMENT_SESSION_BOUNDARY','SEGMENT_BINDING_OPERATION_MISMATCH','SEGMENT_BINDING_OPERATION_UNCONFIRMED','SEGMENT_BINDING_UNCONFIRMED','SEGMENT_BINDING_CAMPAIGN_NOT_FOUND','SEGMENT_BINDING_CAMPAIGN_LOCKED','SEGMENT_BINDING_CAMPAIGN_SCOPE','SEGMENT_BINDING_BASE_REQUIRED','SEGMENT_BINDING_AUDIENCE_CHANGED','SEGMENT_BINDING_AUDIENCE_NOT_FOUND','SEGMENT_BINDING_UNAVAILABLE','SEGMENT_BINDING_VERSION_CONFLICT','SEGMENT_BINDING_CHANGED','SEGMENT_LIST_UNAVAILABLE']);
function copy(value,limit){const text=H.canonical(value);if(Buffer.byteLength(text)>limit)throw fail('SEGMENT_BINDING_SIZE',413);return JSON.parse(text);}
function parse(value){try{
 const v=copy(value,20000);if(!exact(v,['method','request'])||!['GET','POST'].includes(v.method))throw fail('SEGMENT_BINDING_METHOD',405);
 const r=v.request;if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['headers','query','body'].includes(k))||!r.headers||typeof r.headers!=='object'||Array.isArray(r.headers))throw fail('SEGMENT_BINDING_INPUT');
 const entries=Object.entries(r.headers),auth=entries.filter(([k])=>k.toLowerCase()==='authorization'),origins=entries.filter(([k])=>k.toLowerCase()==='origin');
 if(auth.length!==1||typeof auth[0][1]!=='string'||!/^Bearer [a-z0-9-]{8,128}$/.test(auth[0][1]))throw fail('SEGMENT_UNAUTHORIZED',401);
 if(origins.length>1||origins.length===1&&origins[0][1]!=='https://bandssz.github.io')throw fail('SEGMENT_BINDING_ORIGIN',403);
 if(v.method==='GET'&&r.body!==undefined&&!exact(r.body,[])||v.method==='POST'&&r.query!==undefined&&!exact(r.query,[]))throw fail('SEGMENT_BINDING_INPUT');
 const p=copy(v.method==='GET'?r.query:r.body,12000);if(v.method==='GET'&&typeof p?.campaign_id==='string'&&/^[1-9][0-9]{0,9}$/.test(p.campaign_id))p.campaign_id=Number(p.campaign_id);
 const request=B.request(p),method=[B.ACTIONS.inspect,B.ACTIONS.bind,B.ACTIONS.validate].includes(request.acao)?'POST':'GET';if(v.method!==method)throw fail('SEGMENT_BINDING_METHOD',405);
 return {route:'execute',key:auth[0][1].slice(7),request,writing:request.acao===B.ACTIONS.bind};
 }catch(e){return {route:'response',response:response(e.status||400,{error:typeof e.code==='string'&&(e.code.startsWith('SEGMENT_BINDING_')||e.code==='SEGMENT_UNAUTHORIZED')?e.code:'SEGMENT_BINDING_INPUT'})};}}
function project(entry,value){
 const r=copy(value,64000),b=r?._body,status=r?._http,p=entry.request;if(!exact(r,['_http','_body'])||!b||typeof b!=='object'||Array.isArray(b))throw fail('SEGMENT_BINDING_READBACK_UNCONFIRMED');
 if(Object.hasOwn(b,'error')){
  if(!errors.has(b.error)||![202,400,401,403,404,409,422,503].includes(status))throw fail('SEGMENT_BINDING_READBACK_UNCONFIRMED');
  if(status===202){if(!entry.writing||!exact(b,['error','state','idempotency_key','automatic_retry'])||b.error!=='SEGMENT_BINDING_UNCONFIRMED'||b.state!=='unconfirmed'||b.idempotency_key!==p.idempotency_key||b.automatic_retry!==false)throw fail('SEGMENT_BINDING_READBACK_UNCONFIRMED');}
  else if(p.acao===B.ACTIONS.inspect&&status===409&&b.error==='SEGMENT_BINDING_BASE_REQUIRED'){if(!exact(b,['error','base_list'])||!V.baseHint(b.base_list))throw fail('SEGMENT_BINDING_READBACK_UNCONFIRMED');}
  else if(!exact(b,['error']))throw fail('SEGMENT_BINDING_READBACK_UNCONFIRMED');return response(status,b);
 }
 let ok=false;
 if(p.acao===B.ACTIONS.validate)ok=status===200&&exact(b,['validation'])&&V.validation(b.validation,p.brand,p.campaign_id)&&b.validation.binding.campaign_version===p.expected_campaign_version&&b.validation.binding.binding_version===p.expected_binding_version&&b.validation.binding.binding_hash===p.expected_binding_hash;
 else if(p.acao===B.ACTIONS.read)ok=status===200&&V.readBody(b,p.brand,p.campaign_id);
 else if(p.acao===B.ACTIONS.inspect)ok=status===200&&V.inspectBody(b,p.brand,p.campaign_id)&&b.intent.audience_id===p.audience_id&&b.intent.audience_revision===p.audience_revision;
 else if(p.acao===B.ACTIONS.bind)ok=V.receipt({status,body:b},p);
 else if(p.acao===B.ACTIONS.operation)ok=exact(b,['binding','transport_supported'])&&b.transport_supported===false&&V.view(b.binding,p.brand,b.binding?.campaign_id)&&status===(b.binding.binding_version===1?201:200)&&b.binding.campaign_current&&b.binding.semantic_context.current;
 if(!ok)throw fail('SEGMENT_BINDING_READBACK_UNCONFIRMED');return response(status,b);
}
function failure(entry){return response(entry?.writing?202:503,{error:'SEGMENT_BINDING_UNCONFIRMED',...(entry?.writing?{state:'unconfirmed',idempotency_key:entry.request.idempotency_key,automatic_retry:false}:{})});}
function createCampaignBindingAPI({store}={}){if(typeof store?.execute!=='function')throw fail('SEGMENT_BINDING_ADAPTER');return Object.freeze({enabled:false,async handle(value,{signal}={}){const entry=parse(value);if(entry.route==='response')return entry.response;try{return project(entry,await store.execute({key:entry.key,request:entry.request,signal}));}catch{return failure(entry);}}});}
module.exports={VERSION,ENABLED,parse,project,failure,createCampaignBindingAPI};
