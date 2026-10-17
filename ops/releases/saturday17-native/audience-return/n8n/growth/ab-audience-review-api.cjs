'use strict';
// HTTP-shaped boundary only. No listener, workflow, endpoint announcement or
// transport is installed. Snapshot evidence cannot authorize selection/send.
const R=require('./ab-audience-review.cjs'),H=require('./segment-audience-review.cjs');
const VERSION=R.VERSION,ENABLED=false;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const uuid=v=>typeof v==='string'&&UUID.test(v),hash=v=>typeof v==='string'&&HASH.test(v);
const fail=(code,status=400)=>Object.assign(Error(code),{code,status});
const response=(status,body)=>({status,headers:{'Cache-Control':'no-store'},body});
function copy(v,limit){const text=H.canonical(v);if(Buffer.byteLength(text)>limit)throw fail('AB_REVIEW_HTTP_SIZE',413);return JSON.parse(text);}
const flags=v=>v.authorizes_selection===false&&v.authorizes_send===false&&v.execution_blocked===true;
function review(v,brand){
 if(!exact(v,['review_id','test_id','brand','experiment_version','scope_hash','cohort_hash','status','reason','checked_at','expires_at','arms','minimum_reached','eligible_fingerprint','snapshot_only'])||v.brand!==brand||!uuid(v.review_id)||!uuid(v.test_id)||!integer(v.experiment_version,1,999999999)||!hash(v.scope_hash)||!hash(v.cohort_hash)||v.snapshot_only!==true||!['confirmed','unavailable'].includes(v.status))return false;
 const stamp=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
 if(!stamp(v.checked_at)||!stamp(v.expires_at)||Date.parse(v.expires_at)<Date.parse(v.checked_at)||Date.parse(v.expires_at)-Date.parse(v.checked_at)>300000||!Array.isArray(v.arms)||v.arms.length!==2)return false;
 if(v.status==='confirmed'&&(v.reason!==null||typeof v.minimum_reached!=='boolean'||!hash(v.eligible_fingerprint)||Date.parse(v.expires_at)<=Date.parse(v.checked_at)))return false;
 if(v.status==='unavailable'&&(!R.UNAVAILABLE_REASONS.includes(v.reason)||v.minimum_reached!==null||v.eligible_fingerprint!==null||v.expires_at!==v.checked_at))return false;
 if(v.arms.some((a,i)=>!exact(a,['arm','campaign_id','allocated','eligible','excluded','revoked','missing'])||a.arm!==['a','b'][i]||!integer(a.campaign_id,1,2147483647)||!integer(a.allocated,1,50000)))return false;
 if(v.arms[0].campaign_id===v.arms[1].campaign_id||v.arms.reduce((n,a)=>n+a.allocated,0)>100000||Math.abs(v.arms[0].allocated-v.arms[1].allocated)>1)return false;
 return v.arms.every(a=>v.status==='unavailable'?['eligible','excluded','revoked','missing'].every(k=>a[k]===null):['eligible','excluded','revoked','missing'].every(k=>integer(a[k],0,a.allocated))&&a.eligible+a.excluded===a.allocated&&a.revoked+a.missing<=a.excluded);
}
function parse(value){try{
 const v=copy(value,20000);if(!exact(v,['method','request'])||!['GET','POST'].includes(v.method))throw fail('AB_REVIEW_HTTP_METHOD',405);
 const r=v.request;if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['headers','body','query'].includes(k))||!r.headers||typeof r.headers!=='object'||Array.isArray(r.headers))throw fail('AB_REVIEW_HTTP_INPUT');
 const entries=Object.entries(r.headers),auth=entries.filter(([k])=>k.toLowerCase()==='authorization'),origin=entries.filter(([k])=>k.toLowerCase()==='origin');
 if(auth.length!==1||typeof auth[0][1]!=='string'||!/^Bearer [a-z0-9-]{8,128}$/.test(auth[0][1]))throw fail('SEGMENT_UNAUTHORIZED',401);
 if(origin.length>1||origin.length===1&&origin[0][1]!=='https://bandssz.github.io')throw fail('AB_REVIEW_HTTP_ORIGIN',403);
 if(v.method==='GET'&&r.body!==undefined&&!exact(r.body,[])||v.method==='POST'&&r.query!==undefined&&!exact(r.query,[]))throw fail('AB_REVIEW_HTTP_INPUT');
 const request=R.request(copy(v.method==='POST'?r.body:r.query,12000)),writing=request.acao===R.ACTIONS.review;
 if(v.method!==(writing?'POST':'GET'))throw fail('AB_REVIEW_HTTP_METHOD',405);
 return {key:auth[0][1].slice(7),request,writing};
 }catch(e){return {response:response([400,401,403,405,413].includes(e?.status)?e.status:400,{error:['AB_REVIEW_HTTP_METHOD','AB_REVIEW_HTTP_SIZE','AB_REVIEW_HTTP_INPUT','AB_REVIEW_HTTP_ORIGIN','SEGMENT_UNAUTHORIZED'].includes(e?.code)?e.code:'AB_REVIEW_HTTP_INPUT'})};}}
function failure(entry){return response(entry?.writing?202:503,{error:'AB_AUDIENCE_REVIEW_UNCONFIRMED',...(entry?.writing?{state:'unconfirmed',operation_id:entry.request.operation_id,automatic_retry:false}:{})});}
function project(entry,value){
 const r=copy(value,64000),b=r?._body,p=entry.request,status=r?._http;
 if(!exact(r,['_http','_body'])||!b||typeof b!=='object'||Array.isArray(b))throw fail('AB_REVIEW_HTTP_OUTPUT');
 if(Object.hasOwn(b,'error')){
  const allowed=R.ERROR_STATUS[b.error];if(!allowed||!(Array.isArray(allowed)?allowed:[allowed]).includes(status))throw fail('AB_REVIEW_HTTP_OUTPUT');
  if(status===202){if(!entry.writing||!exact(b,['error','state','operation_id','automatic_retry'])||b.error!=='AB_AUDIENCE_REVIEW_UNCONFIRMED'||b.state!=='unconfirmed'||b.operation_id!==p.operation_id||b.automatic_retry!==false)throw fail('AB_REVIEW_HTTP_OUTPUT');}
  else if(!exact(b,['error']))throw fail('AB_REVIEW_HTTP_OUTPUT');return response(status,b);
 }
 if(!exact(b,['review','authorizes_selection','authorizes_send','execution_blocked'])||!flags(b))throw fail('AB_REVIEW_HTTP_OUTPUT');
 if(p.acao===R.ACTIONS.get&&status===200&&b.review===null)return response(status,b);
 if(!review(b.review,p.brand))throw fail('AB_REVIEW_HTTP_OUTPUT');
 if(p.acao===R.ACTIONS.review&&(status!==201||b.review.test_id!==p.test_id||b.review.experiment_version!==p.expected_version||b.review.scope_hash!==p.expected_scope_hash))throw fail('AB_REVIEW_HTTP_OUTPUT');
 if(p.acao===R.ACTIONS.get&&(status!==200||b.review.test_id!==p.test_id))throw fail('AB_REVIEW_HTTP_OUTPUT');
 if(p.acao===R.ACTIONS.operation&&status!==201)throw fail('AB_REVIEW_HTTP_OUTPUT');
 return response(status,b);
}
function createAudienceReviewAPI({store}={}){
 if(typeof store?.execute!=='function')throw fail('AB_REVIEW_HTTP_ADAPTER');
 return Object.freeze({enabled:false,async handle(value,{signal}={}){const entry=parse(value);if(entry.response)return entry.response;try{return project(entry,await store.execute({key:entry.key,request:entry.request,signal}));}catch{return failure(entry);}}});
}
module.exports={VERSION,ENABLED,review,parse,project,failure,createAudienceReviewAPI};
