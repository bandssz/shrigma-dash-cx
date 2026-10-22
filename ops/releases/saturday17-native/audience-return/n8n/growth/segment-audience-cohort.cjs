'use strict';
// PRIVATE preparation input, never an endpoint projection or a send grant.
// Host owns one dedicated READ COMMITTED transaction until its receipt commits.
const A=require('./segment-audience-contract.js'),S=require('./segment-contract.js'),H=require('./segment-audience-review.cjs');
const VERSION='crm-audience-list-cohort-v1',ENABLED=false,MAX_BASE=100000;
const fail=code=>Object.assign(Error(code),{code}),positive=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const BOUNDARY=`SELECT pg_catalog.current_setting('transaction_isolation')='read committed'
 AND (SELECT setting::bigint BETWEEN 1 AND 30000 FROM pg_catalog.pg_settings WHERE name='statement_timeout')
 AND (SELECT setting::bigint BETWEEN 1 AND 500 FROM pg_catalog.pg_settings WHERE name='lock_timeout') AS confirmed`;
const UNKNOWN_SQL=`WITH boundary AS MATERIALIZED (${BOUNDARY})
SELECT false AS source_confirmed,CASE WHEN confirmed THEN $1::text ELSE 'session_boundary_unconfirmed' END AS unknown_reason,
 NULL::jsonb AS member_ids,NULL::bigint AS eligible_count,pg_catalog.statement_timestamp() AS checked_at FROM boundary`;
function compileCohort({definition,baseListId,catalog}={}){
 let d,c;try{d=A.normalize(definition);c=JSON.parse(H.canonical(catalog));}catch{throw fail('AUDIENCE_COHORT_INPUT');}
 if(!positive(baseListId))throw fail('AUDIENCE_COHORT_BASE');
 if(c?.brand!==d.brand||typeof c.current!=='boolean'||!Array.isArray(c.lists)||c.lists.length>1000)throw fail('AUDIENCE_COHORT_CATALOG');
 const leaves=A.leaves(d),ids=[...new Set([baseListId,...leaves.filter(x=>x.rule.op==='in_list').map(x=>x.rule.list_id)])].sort((a,b)=>a-b);
 const available=c.current&&ids.every(id=>{const found=c.lists.filter(l=>l?.id===id);return found.length===1&&found[0].brand===d.brand&&found[0].available===true;});
 const external=leaves.some(x=>x.rule.op!=='in_list'),reason=!available?'list_source_unavailable':external?'external_source_unavailable':null;
 const metadata={definition:d,definition_hash:H.digest(d),base_list_id:baseListId,list_ids:ids,unknown_reason:reason,transport_supported:false};
 if(reason)return Object.freeze({...metadata,text:UNKNOWN_SQL,values:[reason]});
 // Reuse v1's exact list-only normalization/catalog admission; only the SQL
 // execution shape changes to capture/lock a bounded private cohort.
 const approved=S.compileCount({...d,schema_version:S.VERSION},{baseListId,catalog:c});
 if(H.canonical(approved.list_ids)!==H.canonical(ids))throw fail('AUDIENCE_COHORT_INPUT');
 const values=[d.brand,ids,baseListId,d.rule];
 // The SECURITY DEFINER function owns the exact native reads and row locks.
 // Keeping the whole calculation in one SQL function call preserves the
 // command snapshot while avoiding UPDATE grants solely for SELECT FOR SHARE.
 const text=`SELECT source_confirmed,unknown_reason,member_ids,eligible_count,checked_at
 FROM crm_audience_v2.ab_audience_cohort_source($1::text,$2::integer[],$3::integer,$4::jsonb)`;
 return Object.freeze({...metadata,text,values});
}
async function resolveCohort({definition,baseListId,catalog,query,signal,timeoutMs=30000,clock=Date.now}={}){
 if(typeof query!=='function'||typeof clock!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000||signal!==undefined&&!(signal instanceof AbortSignal))throw fail('AUDIENCE_COHORT_INPUT');
 const p=compileCohort({definition,baseListId,catalog});if(signal?.aborted)throw fail('AUDIENCE_COHORT_ABORTED');
 const start=clock();if(!Number.isSafeInteger(start)||start<0)throw fail('AUDIENCE_COHORT_INPUT');
 const controller=new AbortController();let timer,abort;
 const stopped=new Promise((_,reject)=>{abort=()=>{controller.abort();reject(fail('AUDIENCE_COHORT_ABORTED'));};signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>{controller.abort();reject(fail('AUDIENCE_COHORT_TIMEOUT'));},timeoutMs);});
 try{
  const raw=await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)throw fail('AUDIENCE_COHORT_ABORTED');return query(p.text,p.values,{signal:controller.signal});}),stopped]);
  if(controller.signal.aborted)throw fail(signal?.aborted?'AUDIENCE_COHORT_ABORTED':'AUDIENCE_COHORT_TIMEOUT');
  const end=clock();if(!Number.isSafeInteger(end)||end<start||end-start>=timeoutMs)throw fail('AUDIENCE_COHORT_TIMEOUT');
  if(!raw||!Array.isArray(raw.rows)||raw.rows.length!==1)throw fail('AUDIENCE_COHORT_UNCONFIRMED');
  const r=raw.rows[0];if(!r||typeof r!=='object'||Object.keys(r).sort().join(',')!=='checked_at,eligible_count,member_ids,source_confirmed,unknown_reason'||typeof r.source_confirmed!=='boolean')throw fail('AUDIENCE_COHORT_UNCONFIRMED');
  const stamp=r.checked_at instanceof Date?r.checked_at.toISOString():r.checked_at;if(typeof stamp!=='string'||!Number.isFinite(Date.parse(stamp))||Date.parse(stamp)<start-1000||Date.parse(stamp)>end+1000)throw fail('AUDIENCE_COHORT_UNCONFIRMED');
  if(!r.source_confirmed){
   if(r.member_ids!==null||r.eligible_count!==null)throw fail('AUDIENCE_COHORT_UNCONFIRMED');
   if(r.unknown_reason==='base_limit_exceeded'&&!p.unknown_reason)throw fail('AUDIENCE_COHORT_LIMIT');
   if(r.unknown_reason==='session_boundary_unconfirmed')throw fail('AUDIENCE_COHORT_BOUNDARY');
   if(!['list_source_unavailable','external_source_unavailable'].includes(r.unknown_reason)||p.unknown_reason&&r.unknown_reason!==p.unknown_reason||!p.unknown_reason&&r.unknown_reason!=='list_source_unavailable')throw fail('AUDIENCE_COHORT_UNCONFIRMED');
   return Object.freeze({source_confirmed:false,unknown_reason:r.unknown_reason,member_ids:null,eligible_count:null,checked_at:new Date(stamp).toISOString()});
  }
  const count=typeof r.eligible_count==='string'&&/^(0|[1-9][0-9]*)$/.test(r.eligible_count)?Number(r.eligible_count):r.eligible_count;
  if(p.unknown_reason||r.unknown_reason!==null||!Array.isArray(r.member_ids)||r.member_ids.length>MAX_BASE||!Number.isSafeInteger(count)||count<0||count!==r.member_ids.length||r.member_ids.some((id,n)=>!positive(id)||n>0&&id<=r.member_ids[n-1]))throw fail('AUDIENCE_COHORT_UNCONFIRMED');
  return Object.freeze({source_confirmed:true,unknown_reason:null,member_ids:Object.freeze(r.member_ids.slice()),eligible_count:count,checked_at:new Date(stamp).toISOString()});
 }catch(e){throw fail(['AUDIENCE_COHORT_ABORTED','AUDIENCE_COHORT_TIMEOUT','AUDIENCE_COHORT_UNCONFIRMED','AUDIENCE_COHORT_BOUNDARY','AUDIENCE_COHORT_LIMIT'].includes(e?.code)?e.code:'AUDIENCE_COHORT_UNCONFIRMED');}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}
// Snapshot limits: base_candidates fixes membership identity at the statement
// snapshot, not at future send time. Existing rows may return newer values after
// lock waits (READ COMMITTED EPQ); only those locked values feed the predicate.
// New subscribers/memberships after the statement snapshot are excluded. SHARE
// locks last only until the HOST transaction ends. Outer catalog/context/auth
// pins, hash confirmation, receipt and actual SQL cancellation belong to host.
// The client-side deadline above is NOT proof the SQL stopped or rolled back.
module.exports={VERSION,ENABLED,MAX_BASE,compileCohort,resolveCohort};
