'use strict';
// Authenticated shadow preparation only. No HTTP host, schedule, selection,
// native writes, transport or credentials are supplied by this module.
const C=require('../../growth-ab-experiment-contract.js');
const S=require('./segment-audience-store.cjs'),B=require('./segment-campaign-binding.cjs'),H=require('./segment-audience-review.cjs');
const Cohort=require('./segment-audience-cohort.cjs');
const VERSION='crm-ab-audience-prepare-v1',ENABLED=false;
const ACTIONS=Object.freeze({inspect:'ab_publico_conferir',prepare:'ab_publico_preparar',operation:'ab_publico_operacao'});
const FLAGS=Object.freeze({authorizes_selection:false,authorizes_send:false,execution_blocked:true});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/,MD5=/^[a-f0-9]{32}$/;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const copy=v=>JSON.parse(H.canonical(v));
const fail=(code,status=503)=>Object.assign(Error(code),{code,status});
const response=(status,body)=>({_http:status,_body:body});
const error=(status,code)=>response(status,{error:code});
function request(value){
 let p;try{p=copy(value);if(Buffer.byteLength(JSON.stringify(p))>20000)throw Error();}catch{throw fail('AB_AUDIENCE_INPUT',400);}
 const fields={[ACTIONS.inspect]:['protocol'],[ACTIONS.prepare]:['protocol','intent','operation_id'],[ACTIONS.operation]:['operation_id']};
 if(!p||!['fish','aristo'].includes(p.brand)||!Object.hasOwn(fields,p.acao)||!exact(p,['acao','brand',...fields[p.acao]]))throw fail('AB_AUDIENCE_INPUT',400);
 if(p.operation_id!==undefined&&(typeof p.operation_id!=='string'||!UUID.test(p.operation_id)))throw fail('AB_AUDIENCE_INPUT',400);
 if(p.acao!==ACTIONS.operation){try{C.protocol(p.protocol);}catch{throw fail('AB_AUDIENCE_INPUT',400);}if(p.protocol.brand!==p.brand||p.protocol.arms.some(a=>!MD5.test(a.expected_version)))throw fail('AB_AUDIENCE_INPUT',400);}
 if(p.acao===ACTIONS.prepare){const i=p.intent;
  if(!exact(i,['contract','protocol_hash','scope_hash','cohort_hash','eligible_count','expires_at'])||i.contract!==VERSION||['protocol_hash','scope_hash','cohort_hash'].some(k=>typeof i[k]!=='string'||!HASH.test(i[k]))||!Number.isSafeInteger(i.eligible_count)||i.eligible_count<0||i.eligible_count>100000||typeof i.expires_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(i.expires_at)||!Number.isFinite(Date.parse(i.expires_at)))throw fail('AB_AUDIENCE_INPUT',400);
 }
 return p;
}
const SQL=Object.freeze({
 operationLock:"SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crm-ab-v2-operation:'||$1::text,0))",
 brandLock:"SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crm-ab-v2-brand:'||$1::text,0))",
 operation:"SELECT brand,payload,payload_hash,response FROM crm_audience_v2.ab_request WHERE actor=$1::text AND operation_key=$2::uuid",
 active:"SELECT test_id FROM public.crm_ab_experiment_v2 WHERE test_id=$1::uuid OR (brand=$2::text AND state IN('prepared','scheduled'))",
 history:"SELECT binding,binding_hash FROM crm_audience_v2.campaign_binding_revision WHERE campaign_id=$1::integer AND binding_version=$2::integer",
 insertExperiment:"INSERT INTO public.crm_ab_experiment_v2(test_id,brand,protocol,source_list_ids,source_complete) VALUES($1::uuid,$2,$3::jsonb,$4::integer[],false) RETURNING seed",
 insertScope:"INSERT INTO crm_audience_v2.ab_scope(test_id,brand,scope,scope_hash,cohort_hash,actor) VALUES($1::uuid,$2,$3::jsonb,$4,$5,$6)",
 insertArms:"INSERT INTO public.crm_ab_arm_v2(test_id,arm,campaign_id,campaign_version) SELECT $1::uuid,a->>'arm',(a->>'campaign_id')::integer,a->>'expected_version' FROM pg_catalog.jsonb_array_elements($2::jsonb) a",
 insertMembers:"INSERT INTO public.crm_ab_member_v2(test_id,subscriber_id,arm) SELECT $1::uuid,id,CASE WHEN pg_catalog.row_number() OVER(ORDER BY pg_catalog.sha256(pg_catalog.convert_to($2::text||':'||id::text,'UTF8')),id)<=floor(cardinality($3::integer[])/2.0) THEN 'a' ELSE 'b' END FROM pg_catalog.unnest($3::integer[]) id",
 updateCounts:"UPDATE public.crm_ab_arm_v2 a SET allocated_count=(SELECT count(*) FROM public.crm_ab_member_v2 m WHERE m.test_id=a.test_id AND m.arm=a.arm) WHERE a.test_id=$1::uuid",
 snapshot:"SELECT public.crm_ab_snapshot_v2($1::uuid) AS experiment",
 scope:"SELECT scope,scope_hash,cohort_hash FROM crm_audience_v2.ab_scope WHERE test_id=$1::uuid",
 receipt:"INSERT INTO crm_audience_v2.ab_request(actor,operation_key,brand,payload,payload_hash,response) VALUES($1,$2::uuid,$3,$4::jsonb,$5,$6::jsonb)",
 now:"SELECT pg_catalog.clock_timestamp() AS now"
});
function createAudiencePrepare({transaction,timeoutMs=25000}={}){
 if(typeof transaction!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw fail('AB_AUDIENCE_ADAPTER');
 async function execute({key,request:input,signal:external}={}){
  let p;try{p=request(input);}catch(e){return error(400,e.code||'AB_AUDIENCE_INPUT');}
  if(typeof key!=='string'||!/^[a-z0-9-]{8,128}$/.test(key))return error(401,'SEGMENT_UNAUTHORIZED');
  if(external!==undefined&&!(external instanceof AbortSignal))return error(400,'AB_AUDIENCE_INPUT');
  const writing=p.acao===ACTIONS.prepare,controller=new AbortController(),signal=controller.signal;let timer,abort;
  const active=()=>{if(signal.aborted)throw fail('AB_AUDIENCE_UNCONFIRMED');};
  const uncertain=()=>response(writing?202:503,{error:'AB_AUDIENCE_UNCONFIRMED',...(writing?{state:'unconfirmed',operation_id:p.operation_id,automatic_retry:false}:{})});
  async function work(tx){
   if(typeof tx?.query!=='function')throw fail('AB_AUDIENCE_ADAPTER');
   const query=async(q,v=[])=>{active();const r=await tx.query(q,v);active();if(!Array.isArray(r?.rows))throw fail('AB_AUDIENCE_CORRUPT');return r;};
   await query(S.SQL.setup);const boundary=(await query(S.SQL.boundary)).rows[0];
   if(boundary?.isolation!=='read committed'||!(Number(boundary.timeout_ms)>0&&Number(boundary.timeout_ms)<=30000))throw fail('SEGMENT_SESSION_BOUNDARY');
   const auth=async()=>{const a=await S.readAuth(query,key,writing?'draft':'read_content');if(writing&&!a.caps.includes('read_content'))throw fail('SEGMENT_ACCESS_DENIED',403);return a;};
   const who=await auth(),reauth=async()=>{if((await auth()).actor!==who.actor)throw fail('SEGMENT_UNAUTHORIZED',401);};
   if(writing)await query(SQL.operationLock,[p.operation_id]);await reauth();
   if(writing||p.acao===ACTIONS.operation){const prior=(await query(SQL.operation,[who.actor,p.operation_id])).rows[0];
    if(prior){await reauth();if(prior.brand!==p.brand||H.digest(prior.payload)!==prior.payload_hash||writing&&H.digest(p)!==prior.payload_hash)return error(409,'AB_AUDIENCE_OPERATION_MISMATCH');return copy(prior.response);}
    if(!writing)return error(404,'AB_AUDIENCE_OPERATION_UNCONFIRMED');
   }
   let applied=false,result,catalog,scope,bindings=[],campaigns=[];
   const ids=p.protocol.arms.map(a=>a.campaign_id).sort((a,b)=>a-b);
   async function fresh(afterWrite=false){
    const c=await S.readCatalog(query,p.brand);
    if(!c.ready||c.catalog.catalog_hash!==catalog.catalog.catalog_hash||c.expires_at!==catalog.expires_at)throw fail(afterWrite?'AB_AUDIENCE_UNCONFIRMED':'AB_AUDIENCE_CONTEXT_CHANGED',409);
    for(const b of bindings){
     const now=(await query(B.SQL.current,[b.campaign_id])).rows[0]?.current;
     if(now?.version!==b.campaign_version)throw fail(afterWrite?'AB_AUDIENCE_UNCONFIRMED':'AB_AUDIENCE_CAMPAIGN_CHANGED',409);
     const heads=(await query(B.SQL.head,[b.campaign_id])).rows;
     if(heads.length!==1||H.digest(B.binding(heads[0]))!==H.digest(b))throw fail(afterWrite?'AB_AUDIENCE_UNCONFIRMED':'AB_AUDIENCE_BINDING_CHANGED',409);
    }
    const b=bindings[0],rows=(await query(B.SQL.audience,[b.audience_id,b.audience_revision,p.brand])).rows;
    if(rows.length!==1||rows[0].archived!==false||rows[0].head_archived!==false||rows[0].head_version!==b.audience_revision||rows[0].definition_hash!==b.definition_hash||rows[0].context_hash!==b.context_hash||H.digest(rows[0].definition)!==b.definition_hash||H.digest(rows[0].context)!==b.context_hash||H.digest(S.pins(b.definition,c))!==b.context_hash)throw fail(afterWrite?'AB_AUDIENCE_UNCONFIRMED':'AB_AUDIENCE_CONTEXT_CHANGED',409);
    await reauth();const stamp=(await query(SQL.now)).rows[0]?.now,now=stamp instanceof Date?stamp.getTime():Date.parse(stamp);
    if(!Number.isFinite(now))throw fail('AB_AUDIENCE_CORRUPT');
    if(Date.parse(c.expires_at)<=now||writing&&Date.parse(p.intent.expires_at)<=now)throw fail(afterWrite?'AB_AUDIENCE_UNCONFIRMED':'AB_AUDIENCE_INSPECTION_EXPIRED',409);
    return c;
   }
   try{
    await query(SQL.brandLock,[p.brand]);await reauth();
    if((await query(SQL.active,[p.protocol.test_id,p.brand])).rows.length)throw fail('AB_AUDIENCE_ACTIVE_EXISTS',409);
    // Keep the existing campaign -> dependencies -> binding -> config ->
    // audience lock order; both campaigns are acquired numerically first.
    for(const id of ids){const rows=(await query(B.SQL.campaign,[id])).rows,c=rows[0]?.native;
     if(rows.length!==1||c?.attribs?.crm?.policy!=='crm-campaign-v1'||c.attribs.crm.brand!==p.brand)throw fail('AB_AUDIENCE_CAMPAIGN_NOT_FOUND',404);
     if(c.status!=='draft'||c.sent!==0||c.started_at!==null||c.type!=='regular'||c.messenger!=='email'||c.content_type!=='html'||c.body_source!==null)throw fail('AB_AUDIENCE_CAMPAIGN_LOCKED',409);campaigns.push(c);
    }
    for(const c of campaigns)await query(B.SQL.dependencies,[c.id]);
    for(const id of ids){const current=(await query(B.SQL.current,[id])).rows[0]?.current,arm=p.protocol.arms.find(a=>a.campaign_id===id);
     if(!current||current.definition?.brand!==p.brand||current.version!==arm.expected_version)throw fail('AB_AUDIENCE_CAMPAIGN_CHANGED',409);
     const rows=(await query(B.SQL.head,[id])).rows;if(rows.length!==1)throw fail('AB_AUDIENCE_BINDING_REQUIRED',409);
     const b=B.binding(rows[0]);
     if(b.brand!==p.brand||b.campaign_id!==id||b.campaign_version!==current.version||H.digest(current.definition.list_ids)!==H.digest([b.base_list_id]))throw fail('AB_AUDIENCE_BINDING_CHANGED',409);
     const history=(await query(SQL.history,[id,b.binding_version])).rows;
     if(history.length!==1||history[0].binding_hash!==rows[0].binding_hash||H.digest(history[0].binding)!==rows[0].binding_hash)throw fail('AB_AUDIENCE_CORRUPT');bindings.push(copy(b));
    }
    const [a,b]=bindings;
    if(['audience_id','audience_revision','definition_hash','context_hash','base_list_id'].some(k=>a[k]!==b[k]))throw fail('AB_AUDIENCE_SCOPE_DIFFERS',409);
    catalog=await S.readCatalog(query,p.brand);if(!catalog.ready)throw fail('AB_AUDIENCE_SOURCE_UNAVAILABLE',503);
    scope={contract:'crm-ab-audience-scope-v1',test_id:p.protocol.test_id,brand:p.brand,audience_id:a.audience_id,audience_revision:a.audience_revision,definition:copy(a.definition),definition_hash:a.definition_hash,context:copy(a.context),context_hash:a.context_hash,base_list_id:a.base_list_id,catalog_hash:catalog.catalog.catalog_hash,bindings:p.protocol.arms.map(arm=>{const x=bindings.find(b=>b.campaign_id===arm.campaign_id);return {arm:arm.arm,campaign_id:x.campaign_id,binding_version:x.binding_version,binding_hash:H.digest(x),campaign_version:x.campaign_version};})};
    await fresh();
    const cohort=await Cohort.resolveCohort({definition:a.definition,baseListId:a.base_list_id,catalog:catalog.catalog,query,signal});
    if(!cohort.source_confirmed)throw fail('AB_AUDIENCE_SOURCE_UNAVAILABLE',503);
    const members=cohort.member_ids,n=cohort.eligible_count;
    if(!Array.isArray(members)||n!==members.length||members.some((x,i)=>!Number.isSafeInteger(x)||x<1||x>2147483647||i>0&&members[i-1]>=x))throw fail('AB_AUDIENCE_CORRUPT');
    const intent={contract:VERSION,protocol_hash:H.digest(p.protocol),scope_hash:H.digest(scope),cohort_hash:H.digest(members),eligible_count:n,expires_at:catalog.expires_at};
    await fresh();
    if(!writing)return response(200,{contract:VERSION,intent,audience_name:a.definition.name,audience_revision:a.audience_revision,minimum_reached:n>=2&&Math.floor(n/2)>=p.protocol.rule.minimum_per_arm,...FLAGS});
    if(H.digest(intent)!==H.digest(p.intent))throw fail('AB_AUDIENCE_INSPECTION_CHANGED',409);
    if(n<2||Math.floor(n/2)<p.protocol.rule.minimum_per_arm)throw fail('AB_AUDIENCE_MINIMUM_NOT_REACHED',422);
    await reauth();applied=true;
    const inserted=(await query(SQL.insertExperiment,[p.protocol.test_id,p.brand,JSON.stringify(p.protocol),[a.base_list_id]])).rows;
    if(inserted.length!==1||!UUID.test(inserted[0].seed))throw fail('AB_AUDIENCE_CORRUPT');
    await query(SQL.insertScope,[p.protocol.test_id,p.brand,JSON.stringify(scope),intent.scope_hash,intent.cohort_hash,who.actor]);
    await query(SQL.insertArms,[p.protocol.test_id,JSON.stringify(p.protocol.arms)]);
    await query(SQL.insertMembers,[p.protocol.test_id,inserted[0].seed,members]);
    await query(SQL.updateCounts,[p.protocol.test_id]);
    const experiment=(await query(SQL.snapshot,[p.protocol.test_id])).rows[0]?.experiment;
    if(!experiment||experiment.state!=='prepared'||experiment.transport_bound!==false||experiment.arms?.length!==2||experiment.arms.reduce((sum,x)=>sum+x.allocated,0)!==n)throw fail('AB_AUDIENCE_CORRUPT');
    const savedScope=(await query(SQL.scope,[p.protocol.test_id])).rows;
    if(savedScope.length!==1||savedScope[0].scope_hash!==intent.scope_hash||savedScope[0].cohort_hash!==intent.cohort_hash||H.digest(savedScope[0].scope)!==intent.scope_hash)throw fail('AB_AUDIENCE_CORRUPT');
    result=response(201,{contract:VERSION,experiment,scope_hash:intent.scope_hash,audience_id:a.audience_id,audience_revision:a.audience_revision,eligible_count:n,...FLAGS});
   }catch(e){
    const known=['AB_AUDIENCE_ACTIVE_EXISTS','AB_AUDIENCE_CAMPAIGN_NOT_FOUND','AB_AUDIENCE_CAMPAIGN_LOCKED','AB_AUDIENCE_CAMPAIGN_CHANGED','AB_AUDIENCE_BINDING_REQUIRED','AB_AUDIENCE_BINDING_CHANGED','AB_AUDIENCE_SCOPE_DIFFERS','AB_AUDIENCE_SOURCE_UNAVAILABLE','AB_AUDIENCE_CONTEXT_CHANGED','AB_AUDIENCE_INSPECTION_EXPIRED','AB_AUDIENCE_INSPECTION_CHANGED','AB_AUDIENCE_MINIMUM_NOT_REACHED','AUDIENCE_COHORT_LIMIT','SEGMENT_LIST_UNAVAILABLE'];
    if(applied||!known.includes(e?.code))throw e;result=error(e.status||(e.code==='AUDIENCE_COHORT_LIMIT'?422:503),e.code);
   }
   if(writing)await query(SQL.receipt,[who.actor,p.operation_id,p.brand,JSON.stringify(p),H.digest(p),JSON.stringify(result)]);
   if(applied)await fresh(true);else await reauth();active();return result;
  }
  if(external?.aborted)return uncertain();
  const aborted=new Promise((_,reject)=>{abort=()=>{controller.abort();reject(fail('AB_AUDIENCE_UNCONFIRMED'));};external?.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([transaction(work,{signal,readOnly:false,isolation:'read committed'}),aborted,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('AB_AUDIENCE_UNCONFIRMED'));},timeoutMs);})]);}
  catch(e){if(['SEGMENT_UNAUTHORIZED','SEGMENT_ACCESS_DENIED','SEGMENT_SESSION_BOUNDARY'].includes(e?.code))return error(e.status||503,e.code);return uncertain();}
  finally{clearTimeout(timer);external?.removeEventListener('abort',abort);controller.abort();}
 }
 return Object.freeze({enabled:ENABLED,execute});
}
module.exports={VERSION,ENABLED,ACTIONS,FLAGS,SQL,request,createAudiencePrepare};
