/* Local shadow composition: durable preparation, never publication/admission. */
'use strict';
const C=require('./journey-graph-lifecycle-contract.cjs');
const G=require('./journey-graph-contract.js'),R=require('./journey-graph-release.cjs');
const Catalog=require('./journey-graph-catalog.cjs');
const {createLifecycleReviewer}=require('./journey-graph-lifecycle-review.cjs');
const VERSION='journey_graph_lifecycle_prepare_v1',ENABLED=false;
const FLAGS=Object.freeze({authorizes_publish:false,authorizes_activate:false,authorizes_enrollment:false,authorizes_send:false});
const fail=code=>Object.assign(Error(code),{code});
const same=(a,b)=>C.digest(a)===C.digest(b);
const stableReview=r=>{const {checked_at,expires_at,review_hash,...v}=r;return v;};
const summary=r=>({journey_id:r.id,brand:r.brand,version:r.version,revision:r.head_revision,published_revision:r.published_revision,paused:r.paused});
const receiptFor=(v,hash)=>({contract:VERSION,state:'prepared',request_id:v.prepared_id,brand:v.brand,journey_id:v.base.journey_id,base_version:v.base.version,base_revision:v.base.revision,prepared_id:v.prepared_id,prepared_hash:hash,review_hash:v.review_hash,release_id:v.message.release_id,material_sha256:v.message.material_sha256,checkout_sha:v.checkout_sha,revision_reserved:false,...FLAGS});
const SESSION_SQL="SELECT pg_catalog.current_setting('statement_timeout') AS timeout,pg_catalog.current_setting('transaction_isolation') AS isolation";
function createLifecyclePreparer({pool,checkoutSha,catalogFor=Catalog.catalogFor,clock=Date.now,runtimeAccess=false}={}){
 if(typeof runtimeAccess!=='boolean'||typeof pool?.connect!=='function'||typeof checkoutSha!=='string'||!/^[a-f0-9]{40}$/.test(checkoutSha)||typeof catalogFor!=='function'||typeof clock!=='function')throw fail('GRAPH_PREPARE_ADAPTER');
 const stamp=()=>{const n=clock();if(!Number.isSafeInteger(n)||n<0)throw fail('GRAPH_PREPARE_CLOCK');return new Date(n).toISOString();};
 function input(value,action,authorization){
  const p=C.validateRequest(value);if(p.action!==action)throw fail('GRAPH_PREPARE_INPUT');
  if(typeof authorization!=='string'||!/^Bearer [a-z0-9-]{8,128}$/.test(authorization))throw fail('GRAPH_PREPARE_ACCESS');
  return {p,key:authorization.slice(7)};
 }
 async function session(q){
  const r=await q(SESSION_SQL),s=r.rows?.[0],m=/^(\d+(?:\.\d+)?)(ms|s|min)?$/.exec(s?.timeout||'');
  const ms=m?Number(m[1])*({ms:1,s:1000,min:60000}[m[2]]||1):0;
  if(r.rows?.length!==1||s.isolation!=='read committed'||ms<=0||ms>20000)throw fail('GRAPH_PREPARE_SESSION');
 }
 async function auth(q,key,needed){
  // The shared helper validates long/short credential hashes and area grants.
  // Its now() is transaction-start time: additionally fence real wall-clock
  // expiry on this same principal, including after locks and before COMMIT.
  const r=runtimeAccess?await q('SELECT crm_graph_candidate.lifecycle_auth_v1($1::text) AS result',[key]):await q("WITH live AS MATERIALIZED (SELECT 'panel:'||k.chave AS actor FROM public.crm_dash_chave k JOIN public.shrigma_panel_permission_v1 p ON p.principal_id=k.chave AND p.area='growth' WHERE k.ativo AND k.revogada_em IS NULL AND k.painel IN ('growth','todos') AND k.chave_hash IS NOT NULL AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($1::text,'UTF8')),'hex') IN(k.chave_hash,k.chave_hash_curta) AND (k.expira_em IS NULL OR k.expira_em>pg_catalog.clock_timestamp())) SELECT jsonb_build_object('auth',public.shrigma_panel_operator_v1($1,'growth'),'live_count',(SELECT pg_catalog.count(*)::integer FROM live),'live_actor',(SELECT pg_catalog.min(actor) FROM live)) AS result",[key]),x=r.rows?.[0]?.result,a=x?.auth;
  if(r.rows?.length!==1||x?.live_count!==1||x?.live_actor!==a?.who||typeof a?.who!=='string'||!/^panel:[A-Za-z0-9_.:-]{1,122}$/.test(a.who)||!Array.isArray(a.caps)||!needed.every(c=>a.caps.includes(c)))throw fail('GRAPH_PREPARE_ACCESS');
  return {actor:a.who,caps:a.caps,checked_at:stamp()};
 }
 // The pool must lend an exclusive connection with a server timeout already set.
 // No local timer is used as evidence that PostgreSQL has stopped a write.
 async function transaction(writing,fn){
  let c,discard,commitSent=false,begun=false;
  try{
   c=await pool.connect();const q=c.query.bind(c);await session(q);
   await q(writing?'BEGIN ISOLATION LEVEL READ COMMITTED':'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');begun=true;
   await q("SET LOCAL lock_timeout='500ms'");await session(q);
   let finalGuard;
   const result=await fn(q,guard=>{finalGuard=guard;});await session(q);
   if(typeof finalGuard!=='function')throw fail('GRAPH_PREPARE_ADAPTER');
   await finalGuard();commitSent=true;await q('COMMIT');begun=false;return C.freeze(result);
  }catch(e){
   let unknown=writing&&commitSent;
   if(c&&begun){try{await c.query('ROLLBACK');}catch{discard=Error('GRAPH_PREPARE_DISCARD');unknown=writing;}}
   if(unknown)throw fail('GRAPH_PREPARE_OUTCOME_UNKNOWN');
   const raised=e?.code==='P0001'&&/^GRAPH_(PREPARE|LIFECYCLE|RELEASE|CATALOG)_[A-Z_]+$/.test(e?.message||'')?e.message:null,code=/^GRAPH_(PREPARE|LIFECYCLE|RELEASE|CATALOG)_[A-Z_]+$/.test(e?.code||'')?e.code:raised||'GRAPH_PREPARE_UNAVAILABLE';throw fail(code);
  }finally{try{c?.release(discard);}catch{throw fail(writing?'GRAPH_PREPARE_OUTCOME_UNKNOWN':'GRAPH_PREPARE_UNAVAILABLE');}}
 }
 async function pins(q,p){
  // Both locks are held until preparation/receipt COMMIT. Read after any wait.
  if(runtimeAccess){const r=await q('SELECT crm_graph_candidate.lifecycle_prepare_pins_v1($1::uuid,$2::text,$3::integer) AS result',[p.journey_id,p.brand,p.expected_version]);if(r.rows?.length!==1||r.rows[0].result?.enabled!==false)throw fail('GRAPH_PREPARE_CONTROL');await session(q);return C.copy(r.rows[0].result);}
  const c=await q('SELECT enabled,xmin::text AS row_version FROM crm_graph_candidate.control WHERE singleton FOR SHARE');if(c.rows?.length!==1||c.rows[0].enabled!==false)throw fail('GRAPH_PREPARE_CONTROL');const j=await q('SELECT * FROM crm_graph_candidate.journey WHERE id=$1::uuid AND brand=$2 FOR UPDATE',[p.journey_id,p.brand]);if(j.rows?.length!==1)throw fail('GRAPH_PREPARE_NOT_FOUND');if(j.rows[0].version!==p.expected_version)throw fail('GRAPH_PREPARE_VERSION');await session(q);return C.copy(c.rows[0]);
 }
 function privilegedQuery(q){return (sql,args)=>q(runtimeAccess?sql.replaceAll('crm_graph_candidate.release_source_v1','crm_graph_candidate.lifecycle_release_source_v1').replaceAll('crm_graph_candidate.release_get_v1','crm_graph_candidate.lifecycle_release_get_v1').replaceAll('crm_graph_candidate.release_operation_v1','crm_graph_candidate.lifecycle_release_operation_v1').replaceAll('crm_graph_candidate.release_prepare_v1','crm_graph_candidate.lifecycle_release_prepare_v1'):sql,args);}
 async function native(q,brand,tid=null){if(runtimeAccess){const r=await q('SELECT crm_graph_candidate.lifecycle_native_snapshot_v1($1::text,$2::integer) AS result',[brand,tid]);if(r.rows?.length!==1||!r.rows[0].result)throw fail('GRAPH_PREPARE_SOURCE');return r.rows[0].result;}await q('LOCK TABLE public.shrigma_flow_definition,public.templates,public.shrigma_template_email_registry IN SHARE MODE');const c=await Catalog.catalogFor({brand,query:q});if(tid===null)return {catalog:c,source:null};const r=await q('SELECT crm_graph_candidate.release_source_v1($1::text,$2::integer) AS source',[brand,tid]);if(r.rows?.length!==1)return null;return {catalog:c,source:r.rows[0].source};}
 async function currentCatalog(q,brand){const snap=await native(q,brand);return catalogFor===Catalog.catalogFor?snap.catalog:catalogFor({brand,query:q});}
 function reviewer(q,key){
  return createLifecycleReviewer({clock,provider:{
   authenticate:()=>auth(q,key,C.PERMISSIONS.review),
   async readDraft({brand,journey_id}){
    const r=await q('SELECT j.*,r.definition,r.catalog,r.content_hash FROM crm_graph_candidate.journey j JOIN crm_graph_candidate.revision r ON r.journey_id=j.id AND r.brand=j.brand AND r.revision=j.head_revision WHERE j.id=$1::uuid AND j.brand=$2',[journey_id,brand]);
    if(r.rows?.length!==1)throw fail('GRAPH_PREPARE_NOT_FOUND');const row=r.rows[0];
    return {server:summary(row),definition:row.definition,catalog:row.catalog,content_hash:row.content_hash,checked_at:stamp()};
   },
   async readCatalog({brand}){return {catalog:await currentCatalog(q,brand),checked_at:stamp()};},
   async readSource({brand,binding}){
    const tid=Number(binding.slice('email.template.'.length)),snap=await native(q,brand,tid);
    if(!snap.source)throw fail('GRAPH_PREPARE_SOURCE');return {source:snap.source,checked_at:stamp()};
   }
  }});
 }
 function checkReview(row,actor,currentCheckout=true){
  if(!row||row.actor!==actor||currentCheckout&&row.checkout_sha!==checkoutSha)throw fail('GRAPH_PREPARE_REVIEW');
  const r=C.copy(row.evidence),{review_hash,...result}=r;
  if(review_hash!==row.review_hash||C.digest({actor,request:row.request,result})!==review_hash||r.original.brand!==row.brand||r.original.journey_id!==row.journey_id||r.original.version!==row.base_version||r.original.revision!==row.base_revision)throw fail('GRAPH_PREPARE_CORRUPT');
  return r;
 }
 async function readReceipt(q,p,actor,expectedHash){
  const result=await q('SELECT o.*,s.prepared,s.prepared_hash,s.release_id,s.review_hash FROM crm_graph_candidate.lifecycle_prepare_operation_v1 o JOIN crm_graph_candidate.lifecycle_prepared_v1 s ON s.request_id=o.request_id WHERE o.request_id=$1::uuid',[p.request_id]);
  if(!result.rows.length)return null;
  const r=result.rows[0];if(r.actor!==actor||r.brand!==p.brand)throw fail('GRAPH_PREPARE_NOT_FOUND');
  if(expectedHash&&r.request_hash!==expectedHash)throw fail('GRAPH_PREPARE_REPLAY_MISMATCH');
  const v=C.copy(r.prepared),receipt=C.copy(r.response);
  if(r.request_hash!==C.commandFingerprint(r.request)||C.digest(v)!==r.prepared_hash||v.contract!==VERSION||v.prepared_id!==p.request_id||v.brand!==p.brand||v.review_hash!==r.review_hash||v.message.release_id!==r.release_id||v.revision_reserved!==false||!same(receipt,receiptFor(v,r.prepared_hash))||!Object.entries(FLAGS).every(([k,x])=>v[k]===x))throw fail('GRAPH_PREPARE_CORRUPT');
  const release=await R.createReleaseProvider({query:privilegedQuery(q)}).read(p.brand,r.release_id);
  const h=runtimeAccess?await q('SELECT crm_graph_candidate.lifecycle_release_material_hash_v1($2::text,$1::uuid) AS hash',[r.release_id,p.brand]):await q("SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(material::text,'UTF8')),'hex') AS hash FROM crm_graph_candidate.message_release_v1 WHERE id=$1::uuid AND brand=$2",[r.release_id,p.brand]);
  if(h.rows?.length!==1||h.rows[0].hash!==release.material_sha256||release.material_sha256!==v.message.material_sha256||C.digest(v.material)!==v.message.material_plan_hash||C.digest(v.source)!==v.message.source_plan_hash||C.digest({definition:v.definition,catalog:v.operational_catalog})!==v.content_hash||!same(release.material,v.material)||!same(release.source,v.source)||!same(R.catalogMessage(release),v.operational_catalog.messages.find(m=>m.key===v.message.binding)))throw fail('GRAPH_PREPARE_CORRUPT');
  return {state:'prepared',actor:r.actor,request_payload:C.copy(r.request),receipt,prepared:v};
 }
 return Object.freeze({enabled:false,
  async review(value,{authorization}={}){
   const {p,key}=input(value,'review',authorization);
   let reviewHash;
   try{return await transaction(true,async(q,seal)=>{
    const a=await auth(q,key,C.PERMISSIONS.review),control=await pins(q,p);
    let deadline=null;seal(async()=>{if((await auth(q,key,C.PERMISSIONS.review)).actor!==a.actor)throw fail('GRAPH_PREPARE_ACCESS');if(deadline!==null&&clock()>=deadline)throw fail('GRAPH_PREPARE_REVIEW_EXPIRED');});
    const review=await reviewer(q,key).review(p,{authorization});
    if((await auth(q,key,C.PERMISSIONS.review)).actor!==a.actor)throw fail('GRAPH_PREPARE_ACCESS');
    // A blocked review stays read-only; only usable review evidence is durable.
    if(review.state!=='compatible_for_preparation')return {state:'blocked',review};
    deadline=Date.parse(review.expires_at);
    reviewHash=review.review_hash;
    await q('INSERT INTO crm_graph_candidate.lifecycle_review_v1(review_hash,actor,brand,journey_id,base_revision,base_version,checkout_sha,control_pin,request,evidence) VALUES($1,$2,$3,$4::uuid,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb) ON CONFLICT(review_hash) DO NOTHING',[review.review_hash,a.actor,p.brand,p.journey_id,review.original.revision,p.expected_version,checkoutSha,JSON.stringify(control),JSON.stringify(p),JSON.stringify(review)]);
    const stored=(await q('SELECT * FROM crm_graph_candidate.lifecycle_review_v1 WHERE review_hash=$1',[review.review_hash])).rows[0];
    if(!same(checkReview(stored,a.actor),review)||!same(stored.control_pin,control))throw fail('GRAPH_PREPARE_CORRUPT');
    if((await auth(q,key,C.PERMISSIONS.review)).actor!==a.actor)throw fail('GRAPH_PREPARE_ACCESS');
    if(clock()>=Date.parse(review.expires_at))throw fail('GRAPH_PREPARE_REVIEW_EXPIRED');
    return {state:'reviewed',review,checkout_sha:checkoutSha,control_pin:control};
   });}catch(e){if(e.code==='GRAPH_PREPARE_OUTCOME_UNKNOWN'&&reviewHash){e.review_hash=reviewHash;e.brand=p.brand;}throw e;}
  },
  async reviewRecord(value,{authorization}={}){
   const p=C.copy(value);
   if(!C.exact(p,['brand','review_hash'])||!['fish','aristo'].includes(p.brand)||typeof p.review_hash!=='string'||!C.HASH.test(p.review_hash))throw fail('GRAPH_PREPARE_INPUT');
   if(typeof authorization!=='string'||!/^Bearer [a-z0-9-]{8,128}$/.test(authorization))throw fail('GRAPH_PREPARE_ACCESS');
   return transaction(false,async(q,seal)=>{
    const a=await auth(q,authorization.slice(7),C.PERMISSIONS.operation),row=(await q('SELECT * FROM crm_graph_candidate.lifecycle_review_v1 WHERE review_hash=$1 AND brand=$2 AND actor=$3',[p.review_hash,p.brand,a.actor])).rows[0];
    seal(async()=>{if((await auth(q,authorization.slice(7),C.PERMISSIONS.operation)).actor!==a.actor)throw fail('GRAPH_PREPARE_ACCESS');});
    if((await auth(q,authorization.slice(7),C.PERMISSIONS.operation)).actor!==a.actor)throw fail('GRAPH_PREPARE_ACCESS');
    if(!row)return {state:'unconfirmed',review_hash:p.review_hash,automatic_retry:false,...FLAGS};
    return {state:'reviewed',review:checkReview(row,a.actor,false),checkout_sha:row.checkout_sha,control_pin:row.control_pin};
   });
  },
  async prepare(value,{authorization}={}){
   const {p,key}=input(value,'prepare',authorization),requestHash=C.commandFingerprint(p);
   try{return await transaction(true,async(q,seal)=>{
    // Lock first; authentication is fresh after waiting and is required on replay.
    await q('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))',['graph-lifecycle-operation:'+p.request_id]);await session(q);
    const a=await auth(q,key,C.PERMISSIONS.prepare),publicationTable=await q("SELECT pg_catalog.to_regclass('crm_graph_candidate.lifecycle_publication_operation_v1')::text AS name");if(publicationTable.rows?.[0]?.name&&(await q('SELECT 1 FROM crm_graph_candidate.lifecycle_publication_operation_v1 WHERE request_id=$1::uuid',[p.request_id])).rows?.length)throw fail('GRAPH_PREPARE_REPLAY_MISMATCH');const existing=await readReceipt(q,p,a.actor,requestHash);
    let deadline=null;seal(async()=>{if((await auth(q,key,C.PERMISSIONS.prepare)).actor!==a.actor)throw fail('GRAPH_PREPARE_ACCESS');if(deadline!==null&&clock()>=deadline)throw fail('GRAPH_PREPARE_REVIEW_EXPIRED');});
    if(existing){if((await auth(q,key,C.PERMISSIONS.prepare)).actor!==a.actor)throw fail('GRAPH_PREPARE_ACCESS');return existing;}
    const control=await pins(q,p),row=(await q('SELECT * FROM crm_graph_candidate.lifecycle_review_v1 WHERE review_hash=$1',[p.review_hash])).rows[0],review=checkReview(row,a.actor);
    deadline=Date.parse(review.expires_at);
    if(row.brand!==p.brand||row.journey_id!==p.journey_id||row.base_version!==p.expected_version||!same(row.control_pin,control))throw fail('GRAPH_PREPARE_DRIFT');
    if(clock()<Date.parse(review.checked_at)||clock()>=Date.parse(review.expires_at))throw fail('GRAPH_PREPARE_REVIEW_EXPIRED');
    const fresh=await reviewer(q,key).review(row.request,{authorization});
    if(!same(stableReview(fresh),stableReview(review))||fresh.state!=='compatible_for_preparation')throw fail('GRAPH_PREPARE_DRIFT');
    if((await q('SELECT request_id FROM crm_graph_candidate.lifecycle_prepared_v1 WHERE review_hash=$1',[p.review_hash])).rows.length)throw fail('GRAPH_PREPARE_REVIEW_CONSUMED');
    const message=review.proposal.message,release=await R.createReleaseProvider({query:privilegedQuery(q)}).prepare(a.actor,{request_id:p.request_id,brand:p.brand,binding:message.binding,expected_snapshot:message.source_snapshot,purchase_policy:R.PURCHASE_POLICY.version});
    if(C.digest(release.source)!==message.source_plan_hash||C.digest(release.material)!==message.material_plan_hash)throw fail('GRAPH_PREPARE_DRIFT');
    const planning=await currentCatalog(q,p.brand);if(C.digest(planning)!==review.proposal.planning_catalog_hash)throw fail('GRAPH_PREPARE_DRIFT');
    const operational=R.bindCatalog(Catalog.withObservedPurchase(planning,{observationPolicy:R.PURCHASE_POLICY.version}),[release]);
    const validation=G.validateGraph(review.proposal.definition,{catalog:operational});
    // Preserve unavailable fields; a prepared material is not a proven adapter.
    const prepared={contract:VERSION,scope:C.SCOPE,mode:'shadow',kind:'prepared_material_snapshot',prepared_id:p.request_id,brand:p.brand,review_hash:p.review_hash,checkout_sha:checkoutSha,control_pin:control,
     base:C.copy(review.original),proposed_revision:review.proposal.proposed_revision,revision_reserved:false,
     definition:C.copy(review.proposal.definition),planning_catalog:C.copy(planning),planning_catalog_hash:review.proposal.planning_catalog_hash,operational_catalog:operational,
     content_hash:C.digest({definition:review.proposal.definition,catalog:operational}),hash_contract:'canonical_json_sha256_v1',
     message:{binding:message.binding,release_id:release.id,source_snapshot:release.source_snapshot,source_plan_hash:message.source_plan_hash,material_plan_hash:message.material_plan_hash,material_sha256:release.material_sha256,material_hash_contract:'postgres_jsonb_text_sha256'},
     source:C.copy(release.source),material:C.copy(release.material),
     readiness:{material_complete:true,runtime_graph_valid:validation.ok,native_cache_bound:false,source_admitted:false,eligibility_available:operational.fields.find(f=>f.key==='contact.email_allowed')?.available===true,transport:false},
     blockers:[...(!validation.ok?[{code:'runtime_fields_unavailable',message:'A conferência atual de elegibilidade ainda não está disponível para esta revisão.'}]:[]),{code:'native_cache',message:'A mensagem ainda precisa de cópia nativa imutável e conferência do cache.'},{code:'publication',message:'Esta preparação não é uma revisão publicada.'},{code:'activation',message:'Entrada de eventos e ativação ainda exigem conferência e confirmação próprias.'}],...FLAGS};
    const preparedHash=C.digest(prepared),receipt=receiptFor(prepared,preparedHash);
    if(clock()>=Date.parse(review.expires_at))throw fail('GRAPH_PREPARE_REVIEW_EXPIRED');
    if((await auth(q,key,C.PERMISSIONS.prepare)).actor!==a.actor)throw fail('GRAPH_PREPARE_ACCESS');await session(q);
    await q('INSERT INTO crm_graph_candidate.lifecycle_prepared_v1(request_id,review_hash,actor,brand,journey_id,base_revision,base_version,release_id,prepared_hash,prepared) VALUES($1::uuid,$2,$3,$4,$5::uuid,$6,$7,$8::uuid,$9,$10::jsonb)',[p.request_id,p.review_hash,a.actor,p.brand,p.journey_id,review.original.revision,p.expected_version,release.id,preparedHash,JSON.stringify(prepared)]);
    await q('INSERT INTO crm_graph_candidate.lifecycle_prepare_operation_v1(request_id,actor,brand,request_hash,request,response) VALUES($1::uuid,$2,$3,$4,$5::jsonb,$6::jsonb)',[p.request_id,a.actor,p.brand,requestHash,JSON.stringify(p),JSON.stringify(receipt)]);
    const result=await readReceipt(q,p,a.actor,requestHash);
    if((await auth(q,key,C.PERMISSIONS.prepare)).actor!==a.actor)throw fail('GRAPH_PREPARE_ACCESS');
    if(clock()>=Date.parse(review.expires_at))throw fail('GRAPH_PREPARE_REVIEW_EXPIRED');return result;
   });}catch(e){if(e.code==='GRAPH_PREPARE_OUTCOME_UNKNOWN')e.request_id=p.request_id;throw e;}
  },
  async operation(value,{authorization}={}){
   const {p,key}=input(value,'operation',authorization);
   return transaction(false,async(q,seal)=>{
    const a=await auth(q,key,C.PERMISSIONS.operation),found=await readReceipt(q,p,a.actor);
    seal(async()=>{if((await auth(q,key,C.PERMISSIONS.operation)).actor!==a.actor)throw fail('GRAPH_PREPARE_ACCESS');});
    if((await auth(q,key,C.PERMISSIONS.operation)).actor!==a.actor)throw fail('GRAPH_PREPARE_ACCESS');
    // Absence is not proof of rollback. This never retries or creates anything.
    return found||{state:'unconfirmed',actor:a.actor,request_payload:C.copy(p),request_id:p.request_id,automatic_retry:false,...FLAGS};
   });
  }
 });
}
module.exports={VERSION,ENABLED,SESSION_SQL,createLifecyclePreparer};
