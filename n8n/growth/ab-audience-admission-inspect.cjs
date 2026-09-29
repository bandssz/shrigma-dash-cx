'use strict';
// Read-only application inspection: locks are allowed, data writes are not.
// This is not an admission token and does not call the legacy scheduler.
const D=require('./ab-audience-admission-contract.cjs');
const {createHash}=require('node:crypto');
const C=require('../../growth-ab-experiment-contract.js');
const S=require('./segment-audience-store.cjs'),B=require('./segment-campaign-binding.cjs'),H=require('./segment-audience-review.cjs');
const R=require('./ab-audience-review.cjs'),A=require('./segment-audience-allocated.cjs'),M=require('./ab-audience-material-read.cjs');
const ENABLED=false;
const ERROR_STATUS=Object.freeze({AB_ADMISSION_INPUT:400,SEGMENT_UNAUTHORIZED:401,SEGMENT_ACCESS_DENIED:403,AB_ADMISSION_NOT_FOUND:404,AB_ADMISSION_VERSION:409,AB_ADMISSION_SCOPE:409,AB_ADMISSION_STATE:409,AB_ADMISSION_REVIEW_CHANGED:409,AB_ADMISSION_REVIEW_UNAVAILABLE:409,AB_ADMISSION_REVIEW_EXPIRED:409,AB_ADMISSION_CAMPAIGN_CHANGED:409,AB_ADMISSION_BINDING_CHANGED:409,AB_ADMISSION_AUDIENCE_CHANGED:409,AB_ADMISSION_SCHEDULE:409,AB_ADMISSION_MINIMUM:422,AB_ADMISSION_SOURCE_UNAVAILABLE:503,AB_ADMISSION_UNCONFIRMED:503,SEGMENT_SESSION_BOUNDARY:503});
const fail=code=>Object.assign(Error(code),{code});
const result=(status,body)=>({_http:status,_body:body});
const error=code=>result(ERROR_STATUS[code]||503,{error:ERROR_STATUS[code]?code:'AB_ADMISSION_UNCONFIRMED'});
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const epoch=v=>{const n=v instanceof Date?v.getTime():typeof v==='string'?Date.parse(v):NaN;if(!Number.isFinite(n))throw fail('AB_ADMISSION_UNCONFIRMED');return n;};
const iso=v=>new Date(epoch(v)).toISOString();
const SQL=Object.freeze({
 setup:"SELECT pg_catalog.set_config('TimeZone','UTC',true),pg_catalog.set_config('DateStyle','ISO, YMD',true)",
 now:R.SQL.now,
 finish:`WITH auth_live AS MATERIALIZED (${S.SQL.auth}),boundary AS MATERIALIZED (${M.SQL.boundary}) SELECT boundary.*,auth_live.* FROM boundary CROSS JOIN auth_live`
});
function checkedReview(row,scope,experiment,actor){
 const e=row?.evidence;
 if(!exact(e,['contract','review','protocol_hash','scope','source_snapshot_hash','allocation_fingerprint'])||e.contract!==R.VERSION||H.digest(e)!==row.evidence_hash||e.protocol_hash!==H.digest(experiment.protocol)||!hash(e.source_snapshot_hash)||!hash(e.allocation_fingerprint)||H.digest(e.scope)!==scope.scope_hash)throw fail('AB_ADMISSION_UNCONFIRMED');
 const r=R.publicReview(e.review);
 if(r.review_id!==row.review_id||r.test_id!==row.test_id||r.brand!==row.brand||row.actor!==actor||r.test_id!==experiment.test_id||r.brand!==experiment.brand||r.experiment_version!==experiment.version||r.scope_hash!==scope.scope_hash||r.cohort_hash!==scope.cohort_hash||!/^\d+$/.test(String(row.review_sequence))||BigInt(row.review_sequence)<1n)throw fail('AB_ADMISSION_REVIEW_CHANGED');
 return r;
}
async function source(query,brand){
 const config=await query(S.SQL.config,[brand]),lists=await query(S.SQL.lists,[brand]);
 const raw={config:config.rows.map(r=>Object.fromEntries(Object.entries(r).filter(([k])=>k!=='read_at').map(([k,v])=>[k,v instanceof Date?v.toISOString():v]))),lists:lists.rows};
 let current;try{current=await S.readCatalog(async(q,args)=>{
  if(q===S.SQL.config)return config;
  if(q===S.SQL.lists)return lists;
  if(q===S.SQL.shopify){const snapshot=await query(q,args);raw.shopify=snapshot.rows;return snapshot;}
  throw fail('AB_ADMISSION_UNCONFIRMED');
 },brand);}catch(e){if(!['SEGMENT_UNAVAILABLE','SEGMENT_READBACK_UNCONFIRMED'].includes(e?.code))throw e;throw fail('AB_ADMISSION_SOURCE_UNAVAILABLE');}
 if(!current.ready)throw fail('AB_ADMISSION_SOURCE_UNAVAILABLE');
 // Same raw-source codec as review, but this fingerprint only detects drift
 // within this inspection. Equivalent refreshes do not replace pinned rules
 // or extend the historical review's expiry.
 return {current,fingerprint:createHash('sha256').update(JSON.stringify(raw)).digest('hex')};
}
function createAdmissionInspection({transaction,timeoutMs=25000,inspectionHooks={}}={}){
 if(typeof transaction!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw fail('AB_ADMISSION_ADAPTER');
 if(!inspectionHooks||typeof inspectionHooks!=='object'||Object.keys(inspectionHooks).some(k=>!['authorize','before','after'].includes(k)||typeof inspectionHooks[k]!=='function'))throw fail('AB_ADMISSION_ADAPTER');
 async function execute({key,request:input,signal:external}={}){
  let p;try{p=D.request(input);}catch{return error('AB_ADMISSION_INPUT');}
  if(typeof key!=='string'||!/^[a-z0-9-]{8,128}$/.test(key))return error('SEGMENT_UNAUTHORIZED');
  if(external!==undefined&&!(external instanceof AbortSignal))return error('AB_ADMISSION_INPUT');
  const controller=new AbortController(),signal=controller.signal;let timer,abort;
  const active=()=>{if(signal.aborted)throw fail('AB_ADMISSION_UNCONFIRMED');};
  async function work(tx){
   if(typeof tx?.query!=='function')throw fail('AB_ADMISSION_ADAPTER');
   const query=async(q,v=[])=>{active();const r=await tx.query(q,v,{signal});active();if(!Array.isArray(r?.rows))throw fail('AB_ADMISSION_UNCONFIRMED');return r;};
   await query(S.SQL.setup);await query(SQL.setup);
   const boundary=(await query(M.SQL.boundary)).rows[0];if(!M.validBoundary(boundary))throw fail('SEGMENT_SESSION_BOUNDARY');
   const auth=async()=>{const a=await S.readAuth(query,key,'validate');if(!a.caps.includes('read_content'))throw fail('SEGMENT_ACCESS_DENIED');if(inspectionHooks.authorize)await inspectionHooks.authorize(a);return a;};
   const who=await auth(),reauth=async()=>{if((await auth()).actor!==who.actor)throw fail('SEGMENT_UNAUTHORIZED');};
   // Server-only composition for the common pair admission. Hooks share this
   // authenticated transaction and cannot come from the HTTP request.
   if(inspectionHooks.before){const early=await inspectionHooks.before({query,who,reauth,request:p});if(early!==undefined){await reauth();active();return early;}}
   const now=async()=>epoch((await query(SQL.now)).rows[0]?.now);
   await query(R.SQL.brandLock,[p.brand]);await reauth();
   const ex=(await query(R.SQL.experiment,[p.test_id,p.brand])).rows;if(ex.length!==1)throw fail('AB_ADMISSION_NOT_FOUND');const e=ex[0];
   if(e.version!==p.expected_version)throw fail('AB_ADMISSION_VERSION');if(e.state!=='prepared'||e.transport_bound!==false||e.source_complete!==false)throw fail('AB_ADMISSION_STATE');
   C.protocol(e.protocol);if(e.protocol.test_id!==p.test_id||e.protocol.brand!==p.brand||!uuid(e.seed))throw fail('AB_ADMISSION_UNCONFIRMED');
   const scopes=(await query(R.SQL.scope,[p.test_id,p.brand])).rows;if(scopes.length!==1)throw fail('AB_ADMISSION_NOT_FOUND');const scope=scopes[0],s=scope.scope;
   if(!hash(scope.scope_hash)||!hash(scope.cohort_hash)||H.digest(s)!==scope.scope_hash||s.contract!=='crm-ab-audience-scope-v1'||s.test_id!==p.test_id||s.brand!==p.brand||H.digest(s.definition)!==s.definition_hash||H.digest(s.context)!==s.context_hash||!Array.isArray(s.bindings)||s.bindings.length!==2||H.digest(e.source_list_ids)!==H.digest([s.base_list_id]))throw fail('AB_ADMISSION_UNCONFIRMED');
   if(scope.scope_hash!==p.expected_scope_hash)throw fail('AB_ADMISSION_SCOPE');
   const latest=(await query(R.SQL.latest,[p.test_id,p.brand])).rows;if(latest.length!==1||latest[0].review_id!==p.review_id)throw fail('AB_ADMISSION_REVIEW_CHANGED');
   // An unavailable head never falls back to an older confirmed review.
   if(latest[0].evidence?.review?.status==='unavailable')throw fail('AB_ADMISSION_REVIEW_UNAVAILABLE');
   const review=checkedReview(latest[0],scope,e,who.actor);
   if(review.status!=='confirmed')throw fail('AB_ADMISSION_REVIEW_UNAVAILABLE');
   if(!review.minimum_reached)throw fail('AB_ADMISSION_MINIMUM');
   if(epoch(review.expires_at)<=await now())throw fail('AB_ADMISSION_REVIEW_EXPIRED');
   const preparation=(await query(R.SQL.preparation,[p.test_id,p.brand])).rows,prior=preparation[0],prepared=prior?.response?._body;
   if(preparation.length!==1||H.digest(prior.payload)!==prior.payload_hash||H.digest(prior.payload.protocol)!==H.digest(e.protocol)||prepared?.scope_hash!==scope.scope_hash||prepared.experiment?.test_id!==p.test_id||prepared.experiment.brand!==p.brand||prepared.experiment.state!=='prepared'||prepared.experiment.transport_bound!==false||prepared.authorizes_send!==false||prepared.authorizes_selection!==false||prepared.execution_blocked!==true||!Array.isArray(prepared.experiment.arms)||prepared.experiment.arms.length!==2)throw fail('AB_ADMISSION_UNCONFIRMED');
   const original=prepared.experiment.arms.map((a,i)=>{const pin=s.bindings[i],protocol=e.protocol.arms[i];if(a.arm!==['a','b'][i]||!integer(a.allocated)||a.allocated>50000||a.campaign_id!==pin.campaign_id||pin.arm!==a.arm||pin.campaign_id!==protocol.campaign_id||pin.campaign_version!==protocol.expected_version)throw fail('AB_ADMISSION_UNCONFIRMED');return {arm:a.arm,campaign_id:a.campaign_id,allocated:a.allocated};});
   if(original.reduce((n,a)=>n+a.allocated,0)!==prepared.eligible_count||prepared.eligible_count<2||prepared.eligible_count>100000||original[0].allocated!==Math.floor(prepared.eligible_count/2))throw fail('AB_ADMISSION_UNCONFIRMED');
   const ids=original.map(a=>a.campaign_id).sort((a,b)=>a-b),bindings=[];let sendAt=null,nativeSendAt=null;
   for(const id of ids){const rows=(await query(B.SQL.campaign,[id])).rows,c=rows[0]?.native;
    if(rows.length!==1||c?.attribs?.crm?.brand!==p.brand||c.attribs.crm.policy!=='crm-campaign-v1'||c.status!=='draft'||c.sent!==0||c.started_at!==null||c.type!=='regular'||c.messenger!=='email'||c.content_type!=='html'||c.body_source!==null)throw fail('AB_ADMISSION_CAMPAIGN_CHANGED');
    // to_jsonb(timestamptz) is text; compare it before the millisecond UI
    // projection so distinct native microseconds cannot collapse together.
    if(typeof c.send_at!=='string'||nativeSendAt!==null&&nativeSendAt!==c.send_at)throw fail('AB_ADMISSION_SCHEDULE');nativeSendAt=c.send_at;sendAt=iso(c.send_at);
   }
   const material=await M.readCampaignMaterials({query,brand:p.brand,campaignIds:ids,signal,timeoutMs});
   for(const id of ids){const pin=s.bindings.find(b=>b.campaign_id===id),current=(await query(B.SQL.current,[id])).rows[0]?.current;
    if(current?.version!==pin.campaign_version||H.digest(current.definition.list_ids)!==H.digest([s.base_list_id]))throw fail('AB_ADMISSION_CAMPAIGN_CHANGED');
    const heads=(await query(B.SQL.head,[id])).rows;if(heads.length!==1)throw fail('AB_ADMISSION_BINDING_CHANGED');const b=B.binding(heads[0]),hist=(await query(R.SQL.history,[id,pin.binding_version])).rows;
    if(b.brand!==p.brand||b.binding_version!==pin.binding_version||H.digest(b)!==pin.binding_hash||b.campaign_version!==pin.campaign_version||b.audience_id!==s.audience_id||b.audience_revision!==s.audience_revision||b.definition_hash!==s.definition_hash||b.context_hash!==s.context_hash||b.base_list_id!==s.base_list_id||hist.length!==1||hist[0].binding_hash!==pin.binding_hash||H.digest(hist[0].binding)!==pin.binding_hash)throw fail('AB_ADMISSION_BINDING_CHANGED');bindings.push(b);
   }
   const firstSource=await source(query,p.brand),catalog=firstSource.current;
   const revisions=(await query(B.SQL.audience,[s.audience_id,s.audience_revision,p.brand])).rows,revision=revisions[0];
   if(revisions.length!==1||revision.definition_hash!==s.definition_hash||revision.context_hash!==s.context_hash||H.digest(revision.definition)!==s.definition_hash||H.digest(revision.context)!==s.context_hash)throw fail('AB_ADMISSION_UNCONFIRMED');
   if(revision.archived!==false||revision.head_archived!==false)throw fail('AB_ADMISSION_AUDIENCE_CHANGED');
   try{if(H.digest(S.pins(s.definition,catalog))!==s.context_hash)throw fail('AB_ADMISSION_AUDIENCE_CHANGED');}catch(err){if(err?.code==='SEGMENT_LIST_UNAVAILABLE')throw fail('AB_ADMISSION_SOURCE_UNAVAILABLE');throw err;}
   const arms=(await query(R.SQL.arms,[p.test_id])).rows,members=(await query(R.SQL.members,[p.test_id,e.seed])).rows;
   if(arms.length!==2||!arms.every((a,i)=>a.arm===original[i].arm&&a.campaign_id===original[i].campaign_id&&a.campaign_version===s.bindings[i].campaign_version&&a.allocated_count===original[i].allocated&&a.list_id===null&&a.finished_at===null&&a.transport_interrupted_at===null)||members.length!==prepared.eligible_count||!members.every((m,i)=>integer(m.subscriber_id)&&(!i||m.subscriber_id>members[i-1].subscriber_id)&&m.arm===m.expected_arm&&['a','b'].includes(m.arm))||H.digest(members.map(m=>m.subscriber_id))!==scope.cohort_hash||!original.every(a=>members.filter(m=>m.arm===a.arm).length===a.allocated))throw fail('AB_ADMISSION_AUDIENCE_CHANGED');
   const allocation=H.digest({a:members.filter(m=>m.arm==='a').map(m=>m.subscriber_id),b:members.filter(m=>m.arm==='b').map(m=>m.subscriber_id)});
   if(allocation!==latest[0].evidence.allocation_fingerprint)throw fail('AB_ADMISSION_AUDIENCE_CHANGED');
   const resolve=async()=>{
    const v=await A.resolveAllocated({definition:s.definition,baseListId:s.base_list_id,catalog:catalog.catalog,testId:p.test_id,query,signal});
    if(!v.source_confirmed)throw fail('AB_ADMISSION_SOURCE_UNAVAILABLE');
    if(!Array.isArray(v.members)||v.members.length!==members.length||v.members.some((m,i)=>m.subscriber_id!==members[i].subscriber_id||m.arm!==members[i].arm||typeof m.eligible!=='boolean'||(m.revoked_at===null?null:iso(m.revoked_at))!==(members[i].revoked_at===null?null:iso(members[i].revoked_at)))||!Array.isArray(v.arms)||v.arms.length!==2)throw fail('AB_ADMISSION_UNCONFIRMED');
    const fingerprint=H.digest({test_id:p.test_id,scope_hash:scope.scope_hash,a:v.members.filter(m=>m.arm==='a'&&m.eligible).map(m=>m.subscriber_id),b:v.members.filter(m=>m.arm==='b'&&m.eligible).map(m=>m.subscriber_id)});
    const counts=original.map((a,i)=>({...a,eligible:v.arms[i].eligible,excluded:v.arms[i].excluded,revoked:v.arms[i].revoked,missing:v.arms[i].missing}));
    if(fingerprint!==review.eligible_fingerprint||H.digest(counts)!==H.digest(review.arms)||!counts.every(a=>a.eligible>=e.protocol.rule.minimum_per_arm))throw fail('AB_ADMISSION_AUDIENCE_CHANGED');
    return {fingerprint,counts,checked_at:v.checked_at};
   };
   const resolved=await resolve();await reauth();
   const secondSource=await source(query,p.brand);if(secondSource.fingerprint!==firstSource.fingerprint)throw fail('AB_ADMISSION_UNCONFIRMED');
   const secondReview=(await query(R.SQL.latest,[p.test_id,p.brand])).rows;if(secondReview.length!==1||secondReview[0].review_id!==review.review_id||secondReview[0].evidence_hash!==latest[0].evidence_hash||H.digest(secondReview[0].evidence)!==latest[0].evidence_hash)throw fail('AB_ADMISSION_REVIEW_CHANGED');
   const secondMaterial=await M.readCampaignMaterials({query,brand:p.brand,campaignIds:ids,signal,timeoutMs});
   if(secondMaterial.materials.some((m,i)=>m.material_hash!==material.materials[i].material_hash))throw fail('AB_ADMISSION_CAMPAIGN_CHANGED');
   for(const b of bindings){const current=(await query(B.SQL.current,[b.campaign_id])).rows[0]?.current,head=(await query(B.SQL.head,[b.campaign_id])).rows;if(current?.version!==b.campaign_version)throw fail('AB_ADMISSION_CAMPAIGN_CHANGED');if(head.length!==1||H.digest(B.binding(head[0]))!==H.digest(b))throw fail('AB_ADMISSION_BINDING_CHANGED');}
   const rev=(await query(B.SQL.audience,[s.audience_id,s.audience_revision,p.brand])).rows;if(rev.length!==1||rev[0].archived!==false||rev[0].head_archived!==false||rev[0].definition_hash!==s.definition_hash||rev[0].context_hash!==s.context_hash||H.digest(rev[0].definition)!==s.definition_hash||H.digest(rev[0].context)!==s.context_hash)throw fail('AB_ADMISSION_AUDIENCE_CHANGED');
   const finalExperiment=(await query(R.SQL.experiment,[p.test_id,p.brand])).rows,finalScope=(await query(R.SQL.scope,[p.test_id,p.brand])).rows;
   if(finalExperiment.length!==1||finalExperiment[0].state!=='prepared'||finalExperiment[0].version!==e.version||finalExperiment[0].seed!==e.seed||finalExperiment[0].transport_bound!==false||finalExperiment[0].source_complete!==false||H.digest(finalExperiment[0].protocol)!==H.digest(e.protocol)||finalScope.length!==1||finalScope[0].scope_hash!==scope.scope_hash||finalScope[0].cohort_hash!==scope.cohort_hash||H.digest(finalScope[0].scope)!==scope.scope_hash)throw fail('AB_ADMISSION_UNCONFIRMED');
   const finalResolved=await resolve();
   // Last database round trip rechecks clock-based auth and the transaction
   // boundary together. Do not let a delayed final query renew stale evidence.
   const finalRows=await query(SQL.finish,[key]),lastBoundary=finalRows.rows[0];
   if(finalRows.rows.length!==1||!M.validBoundary(lastBoundary)||lastBoundary.pid!==boundary.pid||lastBoundary.xid!==boundary.xid)throw fail('SEGMENT_SESSION_BOUNDARY');
   const lastAuth=await S.readAuth(q=>q===S.SQL.auth?finalRows:Promise.reject(fail('AB_ADMISSION_UNCONFIRMED')),key,'validate');
   if(lastAuth.actor!==who.actor)throw fail('SEGMENT_UNAUTHORIZED');if(!lastAuth.caps.includes('read_content'))throw fail('SEGMENT_ACCESS_DENIED');
   const checked=epoch(lastBoundary.now),expires=Math.min(epoch(review.expires_at),epoch(catalog.expires_at),checked+300000);
   if(checked<epoch(review.checked_at)||expires<=checked)throw fail('AB_ADMISSION_REVIEW_EXPIRED');
   if(epoch(sendAt)<checked+900000)throw fail('AB_ADMISSION_SCHEDULE');
   const view=D.seal({test_id:p.test_id,brand:p.brand,experiment_version:e.version,scope_hash:scope.scope_hash,review_id:review.review_id,checked_at:new Date(checked).toISOString(),expires_at:new Date(expires).toISOString(),send_at:sendAt,audience:{audience_id:s.audience_id,audience_revision:s.audience_revision,cohort_hash:scope.cohort_hash,eligible_fingerprint:finalResolved.fingerprint,arms:finalResolved.counts,minimum_reached:true,checked_at:finalResolved.checked_at,snapshot_only:true},materials:original.map(a=>({arm:a.arm,campaign_id:a.campaign_id,campaign_version:s.bindings.find(b=>b.campaign_id===a.campaign_id).campaign_version,material_hash:material.materials.find(m=>m.campaign_id===a.campaign_id).material_hash})),blockers:['external_material_unconfirmed','execution_path_not_installed']});
   if(inspectionHooks.after){const out=await inspectionHooks.after({query,who,reauth,request:p,view,materials:secondMaterial.materials,experiment:e,scope,bindings});await reauth();active();return out;}
   active();return result(200,view);
  }
  if(external?.aborted)return error('AB_ADMISSION_UNCONFIRMED');
  const cancelled=new Promise((_,reject)=>{abort=()=>{controller.abort();reject(fail('AB_ADMISSION_UNCONFIRMED'));};external?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>{controller.abort();reject(fail('AB_ADMISSION_UNCONFIRMED'));},timeoutMs);});
  try{return await Promise.race([transaction(work,{signal,readOnly:false,isolation:'read committed'}),cancelled]);}
  catch(e){return error(e?.code);}
  finally{clearTimeout(timer);external?.removeEventListener('abort',abort);controller.abort();}
 }
 return Object.freeze({enabled:ENABLED,execute});
}
module.exports={VERSION:D.VERSION,ENABLED,ERROR_STATUS,SQL,createAdmissionInspection};
