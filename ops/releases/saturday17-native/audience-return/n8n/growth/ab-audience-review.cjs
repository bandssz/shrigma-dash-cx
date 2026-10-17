'use strict';
// Shadow-only review of the immutable preparation. No native writes or host.
const {randomUUID,createHash}=require('node:crypto');
const C=require('../../growth-ab-experiment-contract.js');
const S=require('./segment-audience-store.cjs'),B=require('./segment-campaign-binding.cjs'),H=require('./segment-audience-review.cjs');
const Allocated=require('./segment-audience-allocated.cjs');
const VERSION='crm-ab-audience-review-v1',ENABLED=false;
const ACTIONS=Object.freeze({review:'ab_publico_revisar',operation:'ab_publico_revisao_operacao',get:'ab_publico_revisao_obter'});
const FLAGS=Object.freeze({authorizes_selection:false,authorizes_send:false,execution_blocked:true});
const UNAVAILABLE_REASONS=Object.freeze(['source_unavailable','source_expired','audience_archived','context_changed','list_source_unavailable','external_source_unavailable','allocation_unavailable','allocation_changed','allocation_malformed']);
const ERROR_STATUS=Object.freeze({AB_AUDIENCE_REVIEW_INPUT:400,SEGMENT_UNAUTHORIZED:401,SEGMENT_ACCESS_DENIED:403,SEGMENT_SESSION_BOUNDARY:503,AB_AUDIENCE_REVIEW_NOT_FOUND:404,AB_AUDIENCE_REVIEW_OPERATION_UNCONFIRMED:404,AB_AUDIENCE_REVIEW_OPERATION_MISMATCH:409,AB_AUDIENCE_REVIEW_VERSION_CONFLICT:409,AB_AUDIENCE_REVIEW_SCOPE_CHANGED:409,AB_AUDIENCE_REVIEW_STATE:409,AB_AUDIENCE_REVIEW_CAMPAIGN_CHANGED:409,AB_AUDIENCE_REVIEW_BINDING_CHANGED:409,AB_AUDIENCE_REVIEW_UNCONFIRMED:Object.freeze([202,503])});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/,MD5=/^[a-f0-9]{32}$/;
const uuid=v=>typeof v==='string'&&UUID.test(v),hash=v=>typeof v==='string'&&HASH.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const integer=(v,max=2147483647)=>Number.isSafeInteger(v)&&v>0&&v<=max;
const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=100000;
const copy=v=>JSON.parse(H.canonical(v));
const fail=(code,status=ERROR_STATUS[code]||503)=>Object.assign(Error(code),{code,status});
const response=(status,body)=>({_http:status,_body:body});
const error=(status,code)=>response(status,{error:code});
function iso(v){const n=v instanceof Date?v.getTime():Date.parse(v);if(!Number.isFinite(n))throw fail('AB_AUDIENCE_REVIEW_CORRUPT');return new Date(n).toISOString();}
const timestamp=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const memberSnapshotHash=rows=>H.digest(rows.map(m=>`${m.subscriber_id}:${m.arm}:${m.expected_arm}:${m.revoked_at instanceof Date?(Number.isFinite(m.revoked_at.getTime())?m.revoked_at.toISOString():'invalid-date'):String(m.revoked_at)}`));
function request(value){
 let p;try{p=copy(value);if(Buffer.byteLength(JSON.stringify(p))>20000)throw Error();}catch{throw fail('AB_AUDIENCE_REVIEW_INPUT');}
 const fields={[ACTIONS.review]:['test_id','expected_version','expected_scope_hash','operation_id'],[ACTIONS.operation]:['operation_id'],[ACTIONS.get]:['test_id']};
 if(!p||typeof p.acao!=='string'||!['fish','aristo'].includes(p.brand)||!Object.hasOwn(fields,p.acao)||!exact(p,['acao','brand',...fields[p.acao]]))throw fail('AB_AUDIENCE_REVIEW_INPUT');
 for(const k of ['test_id','operation_id'])if(Object.hasOwn(p,k)&&(typeof p[k]!=='string'||!uuid(p[k])))throw fail('AB_AUDIENCE_REVIEW_INPUT');
 if(p.acao===ACTIONS.review&&(!integer(p.expected_version,999999999)||typeof p.expected_scope_hash!=='string'||!hash(p.expected_scope_hash)))throw fail('AB_AUDIENCE_REVIEW_INPUT');return p;
}
function publicReview(value){
 const r=copy(value),keys=['review_id','test_id','brand','experiment_version','scope_hash','cohort_hash','status','reason','checked_at','expires_at','arms','minimum_reached','eligible_fingerprint','snapshot_only'];
 if(!exact(r,keys)||!uuid(r.review_id)||!uuid(r.test_id)||!['fish','aristo'].includes(r.brand)||!integer(r.experiment_version,999999999)||!hash(r.scope_hash)||!hash(r.cohort_hash)||!['confirmed','unavailable'].includes(r.status)||!timestamp(r.checked_at)||!timestamp(r.expires_at)||r.snapshot_only!==true||!Array.isArray(r.arms)||r.arms.length!==2)throw fail('AB_AUDIENCE_REVIEW_CORRUPT');
 const confirmed=r.status==='confirmed';
 if(confirmed?(r.reason!==null||typeof r.minimum_reached!=='boolean'||!hash(r.eligible_fingerprint)||Date.parse(r.expires_at)<=Date.parse(r.checked_at)||Date.parse(r.expires_at)-Date.parse(r.checked_at)>300000):(!UNAVAILABLE_REASONS.includes(r.reason)||r.minimum_reached!==null||r.eligible_fingerprint!==null||r.expires_at!==r.checked_at))throw fail('AB_AUDIENCE_REVIEW_CORRUPT');
 for(const [i,a]of r.arms.entries()){
  if(!exact(a,['arm','campaign_id','allocated','eligible','excluded','revoked','missing'])||a.arm!==['a','b'][i]||!integer(a.campaign_id)||!integer(a.allocated,50000))throw fail('AB_AUDIENCE_REVIEW_CORRUPT');
  if(confirmed?(['eligible','excluded','revoked','missing'].some(k=>!count(a[k]))||a.eligible+a.excluded!==a.allocated||a.revoked+a.missing>a.excluded):['eligible','excluded','revoked','missing'].some(k=>a[k]!==null))throw fail('AB_AUDIENCE_REVIEW_CORRUPT');
 }
 if(r.arms[0].campaign_id===r.arms[1].campaign_id)throw fail('AB_AUDIENCE_REVIEW_CORRUPT');return r;
}
const SQL=Object.freeze({
 operationLock:"SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crm-ab-v2-operation:'||$1::text,0))",
 brandLock:"SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crm-ab-v2-brand:'||$1::text,0))",
 operation:'SELECT brand,payload,payload_hash,response FROM crm_audience_v2.ab_review_request WHERE actor=$1 AND operation_key=$2::uuid',
 experiment:'SELECT * FROM public.crm_ab_experiment_v2 WHERE test_id=$1::uuid AND brand=$2 FOR UPDATE',
 existing:'SELECT test_id FROM crm_audience_v2.ab_scope WHERE test_id=$1::uuid AND brand=$2',
 scope:'SELECT * FROM crm_audience_v2.ab_scope WHERE test_id=$1::uuid AND brand=$2',
 preparation:"SELECT actor,payload,payload_hash,response FROM crm_audience_v2.ab_request WHERE brand=$2 AND response#>>'{_body,experiment,test_id}'=$1::text AND response->>'_http'='201' LIMIT 2",
 arms:'SELECT * FROM public.crm_ab_arm_v2 WHERE test_id=$1::uuid ORDER BY arm FOR SHARE',
 members:"WITH locked AS MATERIALIZED (SELECT subscriber_id,arm,revoked_at FROM public.crm_ab_member_v2 WHERE test_id=$1::uuid ORDER BY subscriber_id FOR SHARE) SELECT subscriber_id,arm,revoked_at,CASE WHEN row_number() OVER(ORDER BY pg_catalog.sha256(pg_catalog.convert_to($2::text||':'||subscriber_id::text,'UTF8')),subscriber_id)<=floor(count(*) OVER()/2.0) THEN 'a' ELSE 'b' END AS expected_arm FROM locked ORDER BY subscriber_id LIMIT 100001",
 history:'SELECT binding,binding_hash FROM crm_audience_v2.campaign_binding_revision WHERE campaign_id=$1 AND binding_version=$2',
 latest:'SELECT * FROM crm_audience_v2.ab_review WHERE test_id=$1::uuid AND brand=$2 ORDER BY review_sequence DESC LIMIT 1',
 saved:'SELECT * FROM crm_audience_v2.ab_review WHERE review_id=$1::uuid',
 insert:'INSERT INTO crm_audience_v2.ab_review(review_id,test_id,brand,actor,evidence,evidence_hash) VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6) RETURNING review_sequence',
 receipt:'INSERT INTO crm_audience_v2.ab_review_request(actor,operation_key,brand,payload,payload_hash,response) VALUES($1,$2::uuid,$3,$4::jsonb,$5,$6::jsonb)',
 now:'SELECT pg_catalog.clock_timestamp() AS now'
});
function stored(row){
 const e=row?.evidence;
 if(!exact(e,['contract','review','protocol_hash','scope','source_snapshot_hash','allocation_fingerprint'])||e.contract!==VERSION||H.digest(e)!==row.evidence_hash||!hash(e.protocol_hash)||!hash(e.source_snapshot_hash)||e.allocation_fingerprint!==null&&!hash(e.allocation_fingerprint)||H.digest(e.scope)!==e.review?.scope_hash)throw fail('AB_AUDIENCE_REVIEW_CORRUPT');
 const r=publicReview(e.review);if(r.review_id!==row.review_id||r.test_id!==row.test_id||r.brand!==row.brand||!/^panel:[A-Za-z0-9_.:-]{1,194}$/.test(row.actor)||!/^\d+$/.test(String(row.review_sequence))||BigInt(row.review_sequence)<1n)throw fail('AB_AUDIENCE_REVIEW_CORRUPT');return r;
}
async function readSource(query,brand){
 const config=await query(S.SQL.config,[brand]),lists=await query(S.SQL.lists,[brand]);
 const raw={config:config.rows.map(r=>Object.fromEntries(Object.entries(r).filter(([k])=>k!=='read_at').map(([k,v])=>[k,v instanceof Date?v.toISOString():v]))),lists:lists.rows};
 let current=null;try{current=await S.readCatalog(async(q,args)=>{
  if(q===S.SQL.config)return config;
  if(q===S.SQL.lists)return lists;
  if(q===S.SQL.shopify){const snapshot=await query(q,args);raw.shopify=snapshot.rows;return snapshot;}
  throw fail('AB_AUDIENCE_REVIEW_CORRUPT');
 },brand);}catch(e){if(e?.code!=='SEGMENT_UNAVAILABLE'&&e?.code!=='SEGMENT_READBACK_UNCONFIRMED')throw e;}
 // Database JSON values preserve PostgreSQL's stable jsonb ordering. This
 // private raw-source hash deliberately does not claim the bounded UI
 // canonicalization contract, which rejects malformed/oversize catalogs.
 return {current,raw,hash:createHash('sha256').update(JSON.stringify(raw)).digest('hex')};
}
function createAudienceReview({transaction,timeoutMs=25000}={}){
 if(typeof transaction!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw fail('AB_AUDIENCE_REVIEW_ADAPTER');
 async function execute({key,request:input,signal:external}={}){
  let p;try{p=request(input);}catch{return error(400,'AB_AUDIENCE_REVIEW_INPUT');}
  if(typeof key!=='string'||!/^[a-z0-9-]{8,128}$/.test(key))return error(401,'SEGMENT_UNAUTHORIZED');
  if(external!==undefined&&!(external instanceof AbortSignal))return error(400,'AB_AUDIENCE_REVIEW_INPUT');
  const writing=p.acao===ACTIONS.review,controller=new AbortController(),signal=controller.signal;let timer,abort;
  const active=()=>{if(signal.aborted)throw fail('AB_AUDIENCE_REVIEW_UNCONFIRMED');};
  const uncertain=()=>response(writing?202:503,{error:'AB_AUDIENCE_REVIEW_UNCONFIRMED',...(writing?{state:'unconfirmed',operation_id:p.operation_id,automatic_retry:false}:{})});
  async function work(tx){
   if(typeof tx?.query!=='function')throw fail('AB_AUDIENCE_REVIEW_ADAPTER');
   const query=async(q,v=[])=>{active();const r=await tx.query(q,v);active();if(!Array.isArray(r?.rows))throw fail('AB_AUDIENCE_REVIEW_CORRUPT');return r;};
   await query(S.SQL.setup);const boundary=(await query(S.SQL.boundary)).rows[0];
   if(boundary?.isolation!=='read committed'||!(Number(boundary.timeout_ms)>0&&Number(boundary.timeout_ms)<=30000))throw fail('SEGMENT_SESSION_BOUNDARY');
   const auth=async()=>{const a=await S.readAuth(query,key,writing?'validate':'read_content');if(writing&&!a.caps.includes('read_content'))throw fail('SEGMENT_ACCESS_DENIED');return a;};
   const who=await auth(),reauth=async()=>{if((await auth()).actor!==who.actor)throw fail('SEGMENT_UNAUTHORIZED');};
   if(writing)await query(SQL.operationLock,[p.operation_id]);await reauth();
   if(writing||p.acao===ACTIONS.operation){const prior=(await query(SQL.operation,[who.actor,p.operation_id])).rows[0];
    if(prior){await reauth();if(prior.brand!==p.brand||H.digest(prior.payload)!==prior.payload_hash||writing&&H.digest(p)!==prior.payload_hash)return error(409,'AB_AUDIENCE_REVIEW_OPERATION_MISMATCH');
     const receipt=copy(prior.response);if(!exact(receipt,['_http','_body']))throw fail('AB_AUDIENCE_REVIEW_CORRUPT');
     if(receipt._http===201){
      if(!exact(receipt._body,['review',...Object.keys(FLAGS)])||Object.keys(FLAGS).some(k=>receipt._body[k]!==FLAGS[k]))throw fail('AB_AUDIENCE_REVIEW_CORRUPT');
      const v=publicReview(receipt._body.review),saved=(await query(SQL.saved,[v.review_id])).rows;
      if(v.brand!==p.brand||v.test_id!==prior.payload.test_id||saved.length!==1||saved[0].actor!==who.actor||H.digest(stored(saved[0]))!==H.digest(v))throw fail('AB_AUDIENCE_REVIEW_CORRUPT');
     }else if(!exact(receipt._body,['error'])||!['AB_AUDIENCE_REVIEW_NOT_FOUND','AB_AUDIENCE_REVIEW_VERSION_CONFLICT','AB_AUDIENCE_REVIEW_SCOPE_CHANGED','AB_AUDIENCE_REVIEW_STATE','AB_AUDIENCE_REVIEW_CAMPAIGN_CHANGED','AB_AUDIENCE_REVIEW_BINDING_CHANGED'].includes(receipt._body.error)||ERROR_STATUS[receipt._body.error]!==receipt._http)throw fail('AB_AUDIENCE_REVIEW_CORRUPT');
     await reauth();return receipt;
    }
    if(!writing){await reauth();return error(404,'AB_AUDIENCE_REVIEW_OPERATION_UNCONFIRMED');}
   }
   if(!writing){
    if((await query(SQL.existing,[p.test_id,p.brand])).rows.length!==1){await reauth();return error(404,'AB_AUDIENCE_REVIEW_NOT_FOUND');}
    const rows=(await query(SQL.latest,[p.test_id,p.brand])).rows;const review=rows.length?stored(rows[0]):null;await reauth();return response(200,{review,...FLAGS});
   }
   let applied=false,result,source,scope,e,allocationHash=null,originalArms,memberRows,revision,bindings=[];
   const now=async()=>iso((await query(SQL.now)).rows[0]?.now);
   const fresh=async(confirmed,expiresAt)=>{
    const src=await readSource(query,p.brand);if(src.hash!==source.hash)throw fail('AB_AUDIENCE_REVIEW_UNCONFIRMED');
    const sc=(await query(SQL.scope,[p.test_id,p.brand])).rows;if(sc.length!==1||sc[0].scope_hash!==scope.scope_hash||sc[0].cohort_hash!==scope.cohort_hash||H.digest(sc[0].scope)!==scope.scope_hash)throw fail('AB_AUDIENCE_REVIEW_UNCONFIRMED');
    const ex=(await query(SQL.experiment,[p.test_id,p.brand])).rows;if(ex.length!==1||ex[0].version!==e.version||ex[0].state!=='prepared'||ex[0].transport_bound!==false||ex[0].source_complete!==false||ex[0].seed!==e.seed||H.digest(ex[0].protocol)!==H.digest(e.protocol))throw fail('AB_AUDIENCE_REVIEW_UNCONFIRMED');
    const r=(await query(B.SQL.audience,[scope.scope.audience_id,scope.scope.audience_revision,p.brand])).rows;
    if(r.length!==1||r[0].head_archived!==revision.head_archived||r[0].archived!==revision.archived||r[0].definition_hash!==revision.definition_hash||r[0].context_hash!==revision.context_hash||H.digest(r[0].definition)!==revision.definition_hash||H.digest(r[0].context)!==revision.context_hash)throw fail('AB_AUDIENCE_REVIEW_UNCONFIRMED');
    for(const b of bindings){const current=(await query(B.SQL.current,[b.campaign_id])).rows[0]?.current,head=(await query(B.SQL.head,[b.campaign_id])).rows;if(current?.version!==b.campaign_version||head.length!==1||H.digest(B.binding(head[0]))!==H.digest(b))throw fail('AB_AUDIENCE_REVIEW_UNCONFIRMED');}
    const m=(await query(SQL.members,[p.test_id,e.seed])).rows;
    if(memberSnapshotHash(m)!==memberSnapshotHash(memberRows))throw fail('AB_AUDIENCE_REVIEW_UNCONFIRMED');
    await reauth();const stamp=await now();if(confirmed&&(!src.current?.ready||Date.parse(expiresAt)<=Date.parse(stamp)))throw fail('AB_AUDIENCE_REVIEW_UNCONFIRMED');return stamp;
   };
   try{
    await query(SQL.brandLock,[p.brand]);await reauth();
    const ex=(await query(SQL.experiment,[p.test_id,p.brand])).rows;if(ex.length!==1)throw fail('AB_AUDIENCE_REVIEW_NOT_FOUND');e=ex[0];
    if(e.version!==p.expected_version)throw fail('AB_AUDIENCE_REVIEW_VERSION_CONFLICT');if(e.state!=='prepared'||e.transport_bound!==false||e.source_complete!==false)throw fail('AB_AUDIENCE_REVIEW_STATE');
    try{C.protocol(e.protocol);}catch{throw fail('AB_AUDIENCE_REVIEW_CORRUPT');}
    if(e.protocol.test_id!==p.test_id||e.protocol.brand!==p.brand||!uuid(e.seed))throw fail('AB_AUDIENCE_REVIEW_CORRUPT');
    const scopes=(await query(SQL.scope,[p.test_id,p.brand])).rows;if(scopes.length!==1)throw fail('AB_AUDIENCE_REVIEW_NOT_FOUND');scope=scopes[0];const s=scope.scope;
    if(!hash(scope.scope_hash)||!hash(scope.cohort_hash)||H.digest(s)!==scope.scope_hash||s.contract!=='crm-ab-audience-scope-v1'||s.test_id!==p.test_id||s.brand!==p.brand||H.digest(s.definition)!==s.definition_hash||H.digest(s.context)!==s.context_hash||!Array.isArray(s.bindings)||s.bindings.length!==2||H.digest(e.source_list_ids)!==H.digest([s.base_list_id]))throw fail('AB_AUDIENCE_REVIEW_CORRUPT');
    if(scope.scope_hash!==p.expected_scope_hash)throw fail('AB_AUDIENCE_REVIEW_SCOPE_CHANGED');
    const prep=(await query(SQL.preparation,[p.test_id,p.brand])).rows;const prior=prep[0],body=prior?.response?._body;
    if(prep.length!==1||H.digest(prior.payload)!==prior.payload_hash||H.digest(prior.payload.protocol)!==H.digest(e.protocol)||body?.scope_hash!==scope.scope_hash||body?.experiment?.test_id!==p.test_id||body.experiment.brand!==p.brand||body.experiment.state!=='prepared'||body.experiment.transport_bound!==false||body.authorizes_send!==false||body.authorizes_selection!==false||body.execution_blocked!==true||!Array.isArray(body.experiment.arms)||body.experiment.arms.length!==2)throw fail('AB_AUDIENCE_REVIEW_CORRUPT');
    originalArms=body.experiment.arms.map((a,i)=>{const pin=s.bindings[i],protocol=e.protocol.arms[i];if(a.arm!==['a','b'][i]||!integer(a.allocated,50000)||a.campaign_id!==pin.campaign_id||pin.arm!==a.arm||pin.campaign_id!==protocol.campaign_id||pin.campaign_version!==protocol.expected_version||!MD5.test(pin.campaign_version))throw fail('AB_AUDIENCE_REVIEW_CORRUPT');return {arm:a.arm,campaign_id:a.campaign_id,allocated:a.allocated};});
    if(originalArms.reduce((n,a)=>n+a.allocated,0)!==body.eligible_count||body.eligible_count<2||body.eligible_count>100000||originalArms[0].allocated!==Math.floor(body.eligible_count/2))throw fail('AB_AUDIENCE_REVIEW_CORRUPT');
    const campaigns=[];for(const id of originalArms.map(a=>a.campaign_id).sort((a,b)=>a-b)){const rows=(await query(B.SQL.campaign,[id])).rows,c=rows[0]?.native;if(rows.length!==1||c?.attribs?.crm?.brand!==p.brand||c.attribs.crm.policy!=='crm-campaign-v1'||c.status!=='draft'||c.sent!==0||c.started_at!==null||c.type!=='regular'||c.messenger!=='email'||c.content_type!=='html'||c.body_source!==null)throw fail('AB_AUDIENCE_REVIEW_CAMPAIGN_CHANGED');campaigns.push(c);}
    for(const c of campaigns)await query(B.SQL.dependencies,[c.id]);
    for(const c of campaigns){const pin=s.bindings.find(b=>b.campaign_id===c.id),current=(await query(B.SQL.current,[c.id])).rows[0]?.current;if(current?.version!==pin.campaign_version||H.digest(current.definition.list_ids)!==H.digest([s.base_list_id]))throw fail('AB_AUDIENCE_REVIEW_CAMPAIGN_CHANGED');
     const heads=(await query(B.SQL.head,[c.id])).rows;if(heads.length!==1)throw fail('AB_AUDIENCE_REVIEW_BINDING_CHANGED');const b=B.binding(heads[0]),hist=(await query(SQL.history,[c.id,pin.binding_version])).rows;
     if(b.brand!==p.brand||b.binding_version!==pin.binding_version||H.digest(b)!==pin.binding_hash||b.campaign_version!==pin.campaign_version||b.audience_id!==s.audience_id||b.audience_revision!==s.audience_revision||b.definition_hash!==s.definition_hash||b.context_hash!==s.context_hash||b.base_list_id!==s.base_list_id||hist.length!==1||hist[0].binding_hash!==pin.binding_hash||H.digest(hist[0].binding)!==pin.binding_hash)throw fail('AB_AUDIENCE_REVIEW_BINDING_CHANGED');bindings.push(b);
    }
    source=await readSource(query,p.brand);const r=(await query(B.SQL.audience,[s.audience_id,s.audience_revision,p.brand])).rows;
    if(r.length!==1||r[0].definition_hash!==s.definition_hash||r[0].context_hash!==s.context_hash||H.digest(r[0].definition)!==s.definition_hash||H.digest(r[0].context)!==s.context_hash)throw fail('AB_AUDIENCE_REVIEW_CORRUPT');revision=r[0];
    const arms=(await query(SQL.arms,[p.test_id])).rows;memberRows=(await query(SQL.members,[p.test_id,e.seed])).rows;
    const allocationValid=arms.length===2&&arms.every((a,i)=>a.arm===originalArms[i].arm&&a.campaign_id===originalArms[i].campaign_id&&a.campaign_version===s.bindings[i].campaign_version&&a.allocated_count===originalArms[i].allocated&&a.list_id===null&&a.finished_at===null&&a.transport_interrupted_at===null)&&memberRows.length===body.eligible_count&&memberRows.every((m,i)=>integer(m.subscriber_id)&&(!i||m.subscriber_id>memberRows[i-1].subscriber_id)&&m.arm===m.expected_arm&&['a','b'].includes(m.arm))&&H.digest(memberRows.map(m=>m.subscriber_id))===scope.cohort_hash&&originalArms.every(a=>memberRows.filter(m=>m.arm===a.arm).length===a.allocated);
    if(allocationValid)allocationHash=H.digest({a:memberRows.filter(m=>m.arm==='a').map(m=>m.subscriber_id),b:memberRows.filter(m=>m.arm==='b').map(m=>m.subscriber_id)});
    const sourceExpiry=source.current?.expires_at,stampBefore=await now();let reason=!allocationValid?'allocation_changed':revision.head_archived||revision.archived?'audience_archived':!source.current?'source_unavailable':!source.current.ready?(sourceExpiry&&Date.parse(sourceExpiry)<=Date.parse(stampBefore)?'source_expired':'source_unavailable'):null;
    if(!reason){try{if(H.digest(S.pins(s.definition,source.current))!==s.context_hash)reason='context_changed';}catch(err){if(err?.code!=='SEGMENT_LIST_UNAVAILABLE')throw err;reason='list_source_unavailable';}}
    let resolved=null;if(!reason){try{resolved=await Allocated.resolveAllocated({definition:s.definition,baseListId:s.base_list_id,catalog:source.current.catalog,testId:p.test_id,query,signal});}catch(err){if(err?.code!=='AUDIENCE_ALLOCATED_LIMIT')throw err;resolved={source_confirmed:false,unknown_reason:'allocation_malformed'};}if(!resolved.source_confirmed){if(!UNAVAILABLE_REASONS.includes(resolved.unknown_reason))throw fail('AB_AUDIENCE_REVIEW_CORRUPT');reason=resolved.unknown_reason;}}
    const checked=await fresh(false,null);if(!reason&&Date.parse(sourceExpiry)<=Date.parse(checked))reason='source_expired';let publicArms,eligibleFingerprint=null,minimum=null;
    if(!reason){
     if(!Array.isArray(resolved.members)||resolved.members.length!==memberRows.length||resolved.members.some((m,i)=>m.subscriber_id!==memberRows[i].subscriber_id||m.arm!==memberRows[i].arm||typeof m.eligible!=='boolean'||(m.revoked_at===null?null:iso(m.revoked_at))!==(memberRows[i].revoked_at===null?null:iso(memberRows[i].revoked_at)))||!Array.isArray(resolved.arms)||resolved.arms.length!==2)throw fail('AB_AUDIENCE_REVIEW_CORRUPT');
     publicArms=originalArms.map((a,i)=>{const v=resolved.arms[i];if(v.arm!==a.arm||v.allocated!==a.allocated)throw fail('AB_AUDIENCE_REVIEW_CORRUPT');return {...a,eligible:v.eligible,excluded:v.excluded,revoked:v.revoked,missing:v.missing};});
     eligibleFingerprint=H.digest({test_id:p.test_id,scope_hash:scope.scope_hash,a:resolved.members.filter(m=>m.arm==='a'&&m.eligible).map(m=>m.subscriber_id),b:resolved.members.filter(m=>m.arm==='b'&&m.eligible).map(m=>m.subscriber_id)});minimum=publicArms.every(a=>a.eligible>=e.protocol.rule.minimum_per_arm);
    }else publicArms=originalArms.map(a=>({...a,eligible:null,excluded:null,revoked:null,missing:null}));
    const review=publicReview({review_id:randomUUID(),test_id:p.test_id,brand:p.brand,experiment_version:e.version,scope_hash:scope.scope_hash,cohort_hash:scope.cohort_hash,status:reason?'unavailable':'confirmed',reason,checked_at:checked,expires_at:reason?checked:new Date(Math.min(Date.parse(sourceExpiry),Date.parse(checked)+300000)).toISOString(),arms:publicArms,minimum_reached:minimum,eligible_fingerprint:eligibleFingerprint,snapshot_only:true});
    const evidence={contract:VERSION,review,protocol_hash:H.digest(e.protocol),scope:s,source_snapshot_hash:source.hash,allocation_fingerprint:allocationHash};
    await fresh(!reason,review.expires_at);applied=true;
    const inserted=(await query(SQL.insert,[review.review_id,p.test_id,p.brand,who.actor,JSON.stringify(evidence),H.digest(evidence)])).rows;if(inserted.length!==1)throw fail('AB_AUDIENCE_REVIEW_CORRUPT');
    const saved=(await query(SQL.saved,[review.review_id])).rows;if(saved.length!==1||H.digest(stored(saved[0]))!==H.digest(review))throw fail('AB_AUDIENCE_REVIEW_CORRUPT');result=response(201,{review,...FLAGS});
    await query(SQL.receipt,[who.actor,p.operation_id,p.brand,JSON.stringify(p),H.digest(p),JSON.stringify(result)]);
    await fresh(!reason,review.expires_at);active();return result;
   }catch(err){
    const known=['AB_AUDIENCE_REVIEW_NOT_FOUND','AB_AUDIENCE_REVIEW_VERSION_CONFLICT','AB_AUDIENCE_REVIEW_SCOPE_CHANGED','AB_AUDIENCE_REVIEW_STATE','AB_AUDIENCE_REVIEW_CAMPAIGN_CHANGED','AB_AUDIENCE_REVIEW_BINDING_CHANGED'];
    if(applied||!known.includes(err?.code))throw err;result=error(ERROR_STATUS[err.code],err.code);
   }
   await query(SQL.receipt,[who.actor,p.operation_id,p.brand,JSON.stringify(p),H.digest(p),JSON.stringify(result)]);await reauth();active();return result;
  }
  if(external?.aborted)return uncertain();
  const aborted=new Promise((_,reject)=>{abort=()=>{controller.abort();reject(fail('AB_AUDIENCE_REVIEW_UNCONFIRMED'));};external?.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([transaction(work,{signal,readOnly:false,isolation:'read committed'}),aborted,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('AB_AUDIENCE_REVIEW_UNCONFIRMED'));},timeoutMs);})]);}
  catch(err){if(['SEGMENT_UNAUTHORIZED','SEGMENT_ACCESS_DENIED','SEGMENT_SESSION_BOUNDARY'].includes(err?.code))return error(ERROR_STATUS[err.code],err.code);return uncertain();}
  finally{clearTimeout(timer);external?.removeEventListener('abort',abort);controller.abort();}
 }
 return Object.freeze({enabled:ENABLED,execute});
}
module.exports={VERSION,ENABLED,ACTIONS,FLAGS,ERROR_STATUS,UNAVAILABLE_REASONS,SQL,request,publicReview,createAudienceReview};
