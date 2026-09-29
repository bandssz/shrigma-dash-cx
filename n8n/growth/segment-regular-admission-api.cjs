'use strict';
const R=require('./segment-regular-admission.cjs'),V=require('../../growth-campaign-regular-client.js').validation;
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===k.length&&k.every(x=>Object.hasOwn(v,x));
const response=(status,body)=>({status,headers:{'Cache-Control':'no-store'},body});
function parse(v){
 if(!exact(v,['method','request'])||!['GET','POST'].includes(v.method)||!v.request?.headers||Object.keys(v.request).some(k=>!['headers','query','body'].includes(k)))return response(400,{error:'REGULAR_ADMISSION_INPUT'});
 const h=Object.entries(v.request.headers),a=h.filter(([k])=>k.toLowerCase()==='authorization'),o=h.filter(([k])=>k.toLowerCase()==='origin');
 if(a.length!==1||typeof a[0][1]!=='string'||!/^Bearer [a-z0-9-]{8,128}$/.test(a[0][1]))return response(401,{error:'SEGMENT_UNAUTHORIZED'});
 if(o.length>1||o.length===1&&o[0][1]!=='https://bandssz.github.io')return response(403,{error:'REGULAR_ADMISSION_ORIGIN'});
 if(v.method==='GET'&&v.request.body!==undefined||v.method==='POST'&&v.request.query!==undefined)return response(400,{error:'REGULAR_ADMISSION_INPUT'});
 try{const p=R.request(v.method==='POST'?v.request.body:v.request.query);if(JSON.stringify(p).length>12000)throw Error();if((p.acao===R.ACTIONS.operation?'GET':'POST')!==v.method)return response(405,{error:'REGULAR_ADMISSION_METHOD'});return {p,key:a[0][1].slice(7),writing:p.acao===R.ACTIONS.schedule};}catch{return response(400,{error:'REGULAR_ADMISSION_INPUT'});}
}
function project(entry,r){
 const {p}=entry,b=r?._body,s=r?._http;if(!exact(r,['_http','_body']))throw Error('REGULAR_ADMISSION_RESPONSE');
 if(exact(b,['error'])&&[400,401,403,404,409,422,503].includes(s)&&(V.reasons.has(b.error)||['REGULAR_ADMISSION_INPUT','REGULAR_ADMISSION_OPERATION_MISMATCH','REGULAR_ADMISSION_OPERATION_UNCONFIRMED','REGULAR_ADMISSION_UNCONFIRMED','SEGMENT_UNAUTHORIZED','SEGMENT_ACCESS_DENIED','SEGMENT_SESSION_BOUNDARY'].includes(b.error)))return response(s,b);
 if(s===202&&entry.writing&&exact(b,['error','state','idempotency_key','automatic_retry'])&&b.error==='REGULAR_ADMISSION_UNCONFIRMED'&&b.state==='unconfirmed'&&b.idempotency_key===p.idempotency_key&&b.automatic_retry===false)return response(s,b);
 if(p.acao===R.ACTIONS.prepare&&s===200&&exact(b,['review'])&&V.review(b.review,p.brand,p.campaign_id)&&b.review.campaign_version===p.expected_campaign_version&&b.review.binding_version===p.expected_binding_version&&b.review.binding_hash===p.expected_binding_hash)return response(s,b);
 if(p.acao===R.ACTIONS.schedule&&V.receipt({status:s,body:b},p))return response(s,b);
 if(p.acao===R.ACTIONS.operation&&s===200&&exact(b,['scheduled'])&&V.scheduled(b.scheduled,p.brand)&&b.scheduled.idempotency_key===p.idempotency_key)return response(s,b);
 throw Error('REGULAR_ADMISSION_RESPONSE');
}
function createRegularAdmissionAPI({store}={}){if(typeof store?.execute!=='function')throw Error('REGULAR_ADMISSION_ADAPTER');return {async handle(v,{signal}={}){const e=parse(v);if(e.status)return e;try{return project(e,await store.execute({key:e.key,request:e.p,signal}));}catch{return response(e.writing?202:503,{error:'REGULAR_ADMISSION_UNCONFIRMED',...(e.writing?{state:'unconfirmed',idempotency_key:e.p.idempotency_key,automatic_retry:false}:{})});}}};}
module.exports={parse,project,createRegularAdmissionAPI};
