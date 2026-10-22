'use strict';
// Private review of an ORIGINAL allocation. No base enumeration, mutation,
// revocation, admission, endpoint projection, selection or send authorization.
const Cohort=require('./segment-audience-cohort.cjs');
const VERSION='crm-audience-allocated-review-v1',ENABLED=false,MAX_MEMBERS=100000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=code=>Object.assign(Error(code),{code}),positive=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const exact=(v,keys)=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const BOUNDARY=`SELECT pg_catalog.current_setting('transaction_isolation')='read committed'
 AND (SELECT setting::bigint BETWEEN 1 AND 30000 FROM pg_catalog.pg_settings WHERE name='statement_timeout')
 AND (SELECT setting::bigint BETWEEN 1 AND 500 FROM pg_catalog.pg_settings WHERE name='lock_timeout') AS confirmed`;
const UNKNOWN_SQL=`WITH boundary AS MATERIALIZED (${BOUNDARY})
SELECT false AS source_confirmed,CASE WHEN confirmed THEN $1::text ELSE 'session_boundary_unconfirmed' END AS unknown_reason,
 pg_catalog.statement_timestamp() AS checked_at,NULL::jsonb AS members,NULL::jsonb AS arms FROM boundary`;
function compileAllocated({definition,baseListId,catalog,testId}={}){
 if(typeof testId!=='string'||!UUID.test(testId))throw fail('AUDIENCE_ALLOCATED_TEST');
 let p;try{p=Cohort.compileCohort({definition,baseListId,catalog});}catch(e){throw fail(['AUDIENCE_COHORT_BASE','AUDIENCE_COHORT_CATALOG'].includes(e?.code)?e.code.replace('COHORT','ALLOCATED'):'AUDIENCE_ALLOCATED_INPUT');}
 const metadata={definition:p.definition,definition_hash:p.definition_hash,base_list_id:p.base_list_id,list_ids:p.list_ids,test_id:testId,unknown_reason:p.unknown_reason,transport_supported:false};
 if(p.unknown_reason)return Object.freeze({...metadata,text:UNKNOWN_SQL,values:[p.unknown_reason]});
 const values=[p.definition.brand,p.list_ids,testId,p.base_list_id,p.definition.rule];
 const text=`SELECT source_confirmed,unknown_reason,checked_at,members,arms
 FROM crm_audience_v2.ab_audience_allocated_source($1::text,$2::integer[],$3::uuid,$4::integer,$5::jsonb)`;
 return Object.freeze({...metadata,text,values});
}
async function resolveAllocated({definition,baseListId,catalog,testId,query,signal,timeoutMs=30000,clock=Date.now}={}){
 if(typeof query!=='function'||typeof clock!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000||signal!==undefined&&!(signal instanceof AbortSignal))throw fail('AUDIENCE_ALLOCATED_INPUT');
 const plan=compileAllocated({definition,baseListId,catalog,testId});if(signal?.aborted)throw fail('AUDIENCE_ALLOCATED_ABORTED');
 const start=clock();if(!Number.isSafeInteger(start)||start<0)throw fail('AUDIENCE_ALLOCATED_INPUT');
 const controller=new AbortController();let timer,abort;
 const stopped=new Promise((_,reject)=>{abort=()=>{controller.abort();reject(fail('AUDIENCE_ALLOCATED_ABORTED'));};signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>{controller.abort();reject(fail('AUDIENCE_ALLOCATED_TIMEOUT'));},timeoutMs);});
 try{
  const raw=await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)throw fail('AUDIENCE_ALLOCATED_ABORTED');return query(plan.text,plan.values,{signal:controller.signal});}),stopped]);
  if(controller.signal.aborted)throw fail(signal?.aborted?'AUDIENCE_ALLOCATED_ABORTED':'AUDIENCE_ALLOCATED_TIMEOUT');
  const end=clock();if(!Number.isSafeInteger(end)||end<start||end-start>=timeoutMs)throw fail('AUDIENCE_ALLOCATED_TIMEOUT');
  if(!raw||!Array.isArray(raw.rows)||raw.rows.length!==1)throw fail('AUDIENCE_ALLOCATED_UNCONFIRMED');const r=raw.rows[0];
  if(!exact(r,['source_confirmed','unknown_reason','checked_at','members','arms'])||typeof r.source_confirmed!=='boolean')throw fail('AUDIENCE_ALLOCATED_UNCONFIRMED');
  const stamp=r.checked_at instanceof Date?r.checked_at.toISOString():r.checked_at;if(typeof stamp!=='string'||!Number.isFinite(Date.parse(stamp))||Date.parse(stamp)<start-1000||Date.parse(stamp)>end+1000)throw fail('AUDIENCE_ALLOCATED_UNCONFIRMED');
  if(!r.source_confirmed){
   if(r.members!==null||r.arms!==null)throw fail('AUDIENCE_ALLOCATED_UNCONFIRMED');
   if(r.unknown_reason==='allocated_limit_exceeded'&&!plan.unknown_reason)throw fail('AUDIENCE_ALLOCATED_LIMIT');
   if(r.unknown_reason==='session_boundary_unconfirmed')throw fail('AUDIENCE_ALLOCATED_BOUNDARY');
   if(!['list_source_unavailable','external_source_unavailable','allocation_unavailable','allocation_changed','allocation_malformed'].includes(r.unknown_reason)||plan.unknown_reason&&r.unknown_reason!==plan.unknown_reason||!plan.unknown_reason&&r.unknown_reason==='external_source_unavailable')throw fail('AUDIENCE_ALLOCATED_UNCONFIRMED');
   return Object.freeze({source_confirmed:false,unknown_reason:r.unknown_reason,checked_at:new Date(stamp).toISOString(),members:null,arms:null});
  }
  if(plan.unknown_reason||r.unknown_reason!==null||!Array.isArray(r.members)||r.members.length<2||r.members.length>MAX_MEMBERS||!Array.isArray(r.arms)||r.arms.length!==2)throw fail('AUDIENCE_ALLOCATED_UNCONFIRMED');
  const counts=['a','b'].map(arm=>({arm,allocated:0,eligible:0,excluded:0,revoked:0,missing:0})),members=[];
  for(const [n,m]of r.members.entries()){
   if(!exact(m,['subscriber_id','arm','revoked_at','reason','eligible'])||!positive(m.subscriber_id)||n>0&&m.subscriber_id<=r.members[n-1].subscriber_id||!['a','b'].includes(m.arm)||!['revoked','missing','global_disabled','base_consent','rule','eligible'].includes(m.reason)||typeof m.eligible!=='boolean'||m.eligible!==(m.reason==='eligible')||m.revoked_at!==null&&(typeof m.revoked_at!=='string'||!Number.isFinite(Date.parse(m.revoked_at)))||(m.revoked_at!==null)!==(m.reason==='revoked'))throw fail('AUDIENCE_ALLOCATED_UNCONFIRMED');
   const c=counts[m.arm==='a'?0:1];c.allocated++;c[m.eligible?'eligible':'excluded']++;if(m.reason==='revoked'||m.reason==='missing')c[m.reason]++;
   members.push(Object.freeze({...m,revoked_at:m.revoked_at===null?null:new Date(m.revoked_at).toISOString()}));
  }
  for(let n=0;n<2;n++){const actual=r.arms[n],expected=counts[n];if(!exact(actual,Object.keys(expected))||expected.allocated<1||Object.keys(expected).some(k=>actual[k]!==expected[k]))throw fail('AUDIENCE_ALLOCATED_UNCONFIRMED');}
  return Object.freeze({source_confirmed:true,unknown_reason:null,checked_at:new Date(stamp).toISOString(),members:Object.freeze(members),arms:Object.freeze(counts.map(Object.freeze))});
 }catch(e){throw fail(['AUDIENCE_ALLOCATED_ABORTED','AUDIENCE_ALLOCATED_TIMEOUT','AUDIENCE_ALLOCATED_UNCONFIRMED','AUDIENCE_ALLOCATED_BOUNDARY','AUDIENCE_ALLOCATED_LIMIT'].includes(e?.code)?e.code:'AUDIENCE_ALLOCATED_UNCONFIRMED');}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}
// Original allocation IDs/arms come only from member_candidates at this single
// statement's snapshot. RC/EPQ can refresh an EXISTING row after a lock wait;
// captured member deletion/arm change/undo of a revocation makes all unknown.
// Later inserts stay outside this review. The caller must separately verify the
// immutable cohort/seed/count pins and phase, auth and catalog/context, and hold
// the same transaction through receipt commit. Locks end at transaction end.
// Timer/abort is a cancellation request, not evidence that SQL stopped/rolled back.
module.exports={VERSION,ENABLED,MAX_MEMBERS,compileAllocated,resolveAllocated};
