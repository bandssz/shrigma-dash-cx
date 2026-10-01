/* Read-only status on the existing publication path. Never an activation review. */
'use strict';
const C=require('./journey-graph-lifecycle-contract.cjs');
const VERSION='journey_graph_activation_readiness_v1';
const BLOCKERS=Object.freeze(['graph_control_off','maintenance_closed','worker_deployment_off','worker_unavailable','cache_identity_unverified','native_clone_not_ready','execution_runtime_missing','epoch_conflict','scope_not_supported']);
const FIELDS=['contract','state','brand','journey_id','version','published_revision','publication_hash','checked_at','expires_at','blockers','authorizes_activate','authorizes_enrollment','authorizes_send'];
function validate(value,expected,now=Date.now()){
 const v=C.copy(value),at=Date.parse(v?.checked_at),until=Date.parse(v?.expires_at);
 if(!C.exact(v,FIELDS)||v.contract!==VERSION||v.state!=='blocked'||!C.UUID.test(v.journey_id||'')||!C.HASH.test(v.publication_hash||'')||!C.version(v.version)||!C.version(v.published_revision)||!['fish','aristo'].includes(v.brand)
  ||!Number.isFinite(at)||!Number.isFinite(until)||at>now+1000||now-at>30000||until<=now||until-at>30000||until<=at
  ||!Array.isArray(v.blockers)||!v.blockers.length||v.blockers.length>BLOCKERS.length||new Set(v.blockers).size!==v.blockers.length||v.blockers.some(x=>!BLOCKERS.includes(x))||!v.blockers.includes('cache_identity_unverified')
  ||['authorizes_activate','authorizes_enrollment','authorizes_send'].some(k=>v[k]!==false)||Object.entries(expected).some(([k,x])=>v[k]!==x))throw Object.assign(Error('GRAPH_PUBLICATION_READINESS_INVALID'),{code:'GRAPH_PUBLICATION_READINESS_INVALID'});
 return C.freeze(v);
}
async function read({query,server,receipt,clock=Date.now}){
 const expected={brand:server.brand,journey_id:server.journey_id,version:server.version,published_revision:server.published_revision,publication_hash:receipt.publication_hash};
 const result=await query('SELECT crm_graph_candidate.lifecycle_activation_readiness_v1($1::uuid,$2::text,$3::integer,$4::integer,$5::text) AS result',[expected.journey_id,expected.brand,expected.version,expected.published_revision,expected.publication_hash]);
 if(result.rows?.length!==1)throw Object.assign(Error('GRAPH_PUBLICATION_READINESS_INVALID'),{code:'GRAPH_PUBLICATION_READINESS_INVALID'});
 return validate(result.rows[0].result,expected,clock());
}
module.exports={VERSION,BLOCKERS,validate,read};
