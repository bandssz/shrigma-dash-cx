'use strict';
// Local, separate route. Does not add audience fields to the legacy campaign
// contract and does not call schedule, native create, send or subscriber writes.
const A=require('./segment-audience-contract.js'),S=require('./segment-audience-store.cjs'),H=require('./segment-audience-review.cjs');
const Campaign=require('./campaign-contract.js'),Tracking=require('./campaign-tracking.js');
const VERSION='crm-audience-campaign-binding-v1',ENABLED=false,MAX=999999999;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,HASH=/^[a-f0-9]{64}$/,CAMPAIGN_VERSION=/^[a-f0-9]{32}$/;
const FLAGS=Object.freeze({selector_ready:false,execution_blocked:true,authorizes_selection:false,authorizes_send:false});
const ACTIONS=Object.freeze({inspect:'campanha_publico_conferir',bind:'campanha_publico_vincular',read:'campanha_publico_obter',operation:'campanha_publico_operacao',validate:'campanha_publico_validar'});
const exact=(v,keys)=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const positive=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const fail=(code,status=503)=>Object.assign(Error(code),{code,status});
const copy=v=>JSON.parse(H.canonical(v));
const response=(status,body)=>({_http:status,_body:body});
const error=(status,code)=>response(status,{error:code});
function request(input){
 let p;try{p=copy(input);if(Buffer.byteLength(JSON.stringify(p))>12000)throw Error();}catch{throw fail('SEGMENT_BINDING_INPUT',400);}
 const fields={[ACTIONS.validate]:['campaign_id','expected_campaign_version','expected_binding_version','expected_binding_hash'],[ACTIONS.inspect]:['campaign_id','audience_id','audience_revision'],[ACTIONS.read]:['campaign_id'],[ACTIONS.operation]:['idempotency_key'],[ACTIONS.bind]:['campaign_id','expected_campaign_version','expected_binding_version','audience_id','audience_revision','expected_definition_hash','expected_context_hash','expected_catalog_hash','idempotency_key']};
 if(!p||!['fish','aristo'].includes(p.brand)||!Object.hasOwn(fields,p.acao)||!exact(p,['acao','brand',...fields[p.acao]]))throw fail('SEGMENT_BINDING_INPUT',400);
 if(Object.hasOwn(p,'campaign_id')&&!positive(p.campaign_id)||Object.hasOwn(p,'audience_revision')&&(!positive(p.audience_revision)||p.audience_revision>MAX)||Object.hasOwn(p,'expected_binding_version')&&(!Number.isSafeInteger(p.expected_binding_version)||p.expected_binding_version<0||p.expected_binding_version>=MAX))throw fail('SEGMENT_BINDING_INPUT',400);
 if(Object.hasOwn(p,'audience_id')){if(typeof p.audience_id!=='string'||!UUID.test(p.audience_id))throw fail('SEGMENT_BINDING_INPUT',400);p.audience_id=p.audience_id.toLowerCase();}
 if(Object.hasOwn(p,'expected_campaign_version')&&(typeof p.expected_campaign_version!=='string'||!CAMPAIGN_VERSION.test(p.expected_campaign_version)))throw fail('SEGMENT_BINDING_INPUT',400);
 for(const name of ['expected_definition_hash','expected_context_hash','expected_catalog_hash','expected_binding_hash'])if(Object.hasOwn(p,name)&&(typeof p[name]!=='string'||!HASH.test(p[name])))throw fail('SEGMENT_BINDING_INPUT',400);
 if(p.acao===ACTIONS.validate&&p.expected_binding_version<1)throw fail('SEGMENT_BINDING_INPUT',400);
 if(Object.hasOwn(p,'idempotency_key')&&(typeof p.idempotency_key!=='string'||!/^[A-Za-z0-9_.:-]{8,128}$/.test(p.idempotency_key)))throw fail('SEGMENT_BINDING_INPUT',400);return p;
}
const SQL=Object.freeze({
 lock:"SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('segment-campaign-binding:'||pg_catalog.jsonb_build_array($1::text,$2::text)::text,0))",
 operation:"SELECT brand,payload,payload_hash,response FROM crm_audience_v2.campaign_binding_request WHERE actor=$1::text AND operation_key=$2::text",
 campaign:"SELECT native,row_version FROM crm_audience_v2.campaign_snapshot($1::integer,true)",
 campaignRead:"SELECT native,row_version FROM crm_audience_v2.campaign_snapshot($1::integer,false)",
 current:"SELECT public.shrigma_campaign_provider('get',pg_catalog.jsonb_build_object('id',$1::integer)) AS current",
 campaignCatalog:"SELECT public.shrigma_campaign_provider('catalog',pg_catalog.jsonb_build_object('brand',$1::text)) AS catalog",
 bindingHistory:"SELECT binding,binding_hash FROM crm_audience_v2.campaign_binding_revision WHERE campaign_id=$1::integer AND binding_version=$2::integer",
 clock:"SELECT pg_catalog.clock_timestamp() AS now",
 dependencies:"SELECT crm_audience_v2.lock_campaign_dependencies($1::integer)",
 head:"SELECT * FROM crm_audience_v2.campaign_binding WHERE campaign_id=$1::integer FOR UPDATE",
 headRead:"SELECT * FROM crm_audience_v2.campaign_binding WHERE campaign_id=$1::integer FOR SHARE",
 audience:"SELECT r.*,a.brand,a.archived AS head_archived,a.version AS head_version FROM crm_audience_v2.audience a JOIN crm_audience_v2.revision r ON r.audience_id=a.id AND r.version=$2::integer WHERE a.id=$1::uuid AND a.brand=$3::text FOR SHARE OF a",
 // A row-version barrier, not an authorization bypass. Besides preventing old
 // RR snapshots from ignoring a new binding, it allows a native updated_at
 // trigger; the final provider version is captured and all other values pinned.
 touch:"SELECT native,row_version FROM crm_audience_v2.touch_campaign($1::integer)",
 insert:"INSERT INTO crm_audience_v2.campaign_binding(campaign_id,brand,binding_version,campaign_version,audience_id,audience_revision,definition_hash,context_hash,base_list_id,catalog_hash,binding,binding_hash,created_by,updated_by) VALUES($1,$2,$3,$4,$5::uuid,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$13) RETURNING *",
 update:"UPDATE crm_audience_v2.campaign_binding SET binding_version=$3,campaign_version=$4,audience_id=$5::uuid,audience_revision=$6,definition_hash=$7,context_hash=$8,base_list_id=$9,catalog_hash=$10,binding=$11::jsonb,binding_hash=$12,updated_by=$13,updated_at=pg_catalog.clock_timestamp() WHERE campaign_id=$1::integer AND brand=$2::text RETURNING *",
 revision:"INSERT INTO crm_audience_v2.campaign_binding_revision(campaign_id,binding_version,binding,binding_hash,actor) VALUES($1,$2,$3::jsonb,$4,$5)",
 receipt:"INSERT INTO crm_audience_v2.campaign_binding_request(actor,operation_key,brand,payload,payload_hash,response) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb)"
});
function nativeSnapshot(row,brand,id,requireDraft){
 const c=row?.native;if(!c||c.id!==id||c.attribs?.crm?.policy!=='crm-campaign-v1'||c.attribs.crm.brand!==brand)throw fail('SEGMENT_BINDING_CAMPAIGN_NOT_FOUND',404);
 if(requireDraft&&(c.status!=='draft'||c.sent!==0||c.started_at!==null||c.type!=='regular'||c.messenger!=='email'||c.content_type!=='html'||c.body_source!==null))throw fail('SEGMENT_BINDING_CAMPAIGN_LOCKED',409);
 return copy(c);
}
function currentSnapshot(raw,brand,id){
 if(!raw||raw.id!==id||typeof raw.version!=='string'||!CAMPAIGN_VERSION.test(raw.version)||raw.definition?.schema_version!=='crm-campaign-v1'||raw.definition.brand!==brand||!Array.isArray(raw.definition.list_ids))throw fail('SEGMENT_BINDING_CORRUPT');return copy(raw);
}
function audience(row,p,requireHead=true){
 let d;try{d=A.normalize(row?.definition);}catch{throw fail('SEGMENT_BINDING_CORRUPT');}
 if(row.brand!==p.brand||row.audience_id!==p.audience_id||row.version!==p.audience_revision||requireHead&&row.head_version!==p.audience_revision||row.archived||row.head_archived)throw fail('SEGMENT_BINDING_AUDIENCE_CHANGED',409);
 if(H.digest(d)!==row.definition_hash||H.digest(row.definition)!==row.definition_hash||H.digest(row.context)!==row.context_hash||row.context?.brand!==p.brand||row.context.contract!=='crm-audience-context-v1'||!positive(row.context?.base?.id))throw fail('SEGMENT_BINDING_CORRUPT');return row;
}
function binding(row){
 const b=row?.binding;
 if(!exact(b,['contract','brand','campaign_id','campaign_version','binding_version','audience_id','audience_revision','definition_hash','context_hash','base_list_id','definition','context','catalog_hash','authorizes_selection','authorizes_send'])||b.contract!==VERSION||b.authorizes_send!==false||b.authorizes_selection!==false||H.digest(b)!==row.binding_hash||H.digest(A.normalize(b.definition))!==b.definition_hash||H.digest(b.context)!==b.context_hash||b.context?.base?.id!==b.base_list_id||b.context.brand!==b.brand)throw fail('SEGMENT_BINDING_CORRUPT');
 for(const name of ['brand','campaign_id','campaign_version','binding_version','audience_id','audience_revision','definition_hash','context_hash','base_list_id','catalog_hash'])if(b[name]!==row[name])throw fail('SEGMENT_BINDING_CORRUPT');return b;
}
function view(row,current,catalog){
 const b=binding(row);let contextCurrent=false;try{contextCurrent=catalog.ready&&H.digest(S.pins(b.definition,catalog))===b.context_hash;}catch{}
 const shopify=b.context.rules.filter(x=>x.source==='shopify'),currency=shopify[0]?.currency??null,timezone=shopify[0]?.timezone??null;
 return {contract:VERSION,brand:b.brand,campaign_id:b.campaign_id,campaign_version:b.campaign_version,binding_version:b.binding_version,audience_id:b.audience_id,audience_revision:b.audience_revision,definition_hash:b.definition_hash,context_hash:b.context_hash,base_list_id:b.base_list_id,catalog_hash:b.catalog_hash,binding_hash:row.binding_hash,campaign_current:current?.version===b.campaign_version,semantic_context:{currency,timezone,current:contextCurrent},...FLAGS};
}
function createSegmentCampaignBinding({transaction,countProvider=null,refreshCatalog=null,timeoutMs=25000}={}){
 if(typeof transaction!=='function'||refreshCatalog!==null&&typeof refreshCatalog!=='function'||countProvider!==null&&typeof countProvider!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw fail('SEGMENT_BINDING_ADAPTER');
 async function execute({key,request:input,signal:external}={}){
  let p;try{p=request(input);}catch(e){return error(400,e.code||'SEGMENT_BINDING_INPUT');}
  if(typeof key!=='string'||!/^[a-z0-9-]{8,128}$/.test(key))return error(401,'SEGMENT_UNAUTHORIZED');
  if(external!==undefined&&!(external instanceof AbortSignal))return error(400,'SEGMENT_BINDING_INPUT');
  const writing=p.acao===ACTIONS.bind,controller=new AbortController(),signal=controller.signal;let timer,abortHandler;
  const active=()=>{if(signal.aborted)throw fail('SEGMENT_BINDING_UNCONFIRMED');};
  async function work(tx){
   if(typeof tx?.query!=='function')throw fail('SEGMENT_BINDING_ADAPTER');
   const query=async(q,v=[])=>{active();const r=await tx.query(q,v);active();if(!r||!Array.isArray(r.rows))throw fail('SEGMENT_BINDING_CORRUPT');return r;};
   await query(S.SQL.setup);const session=(await query(S.SQL.boundary)).rows[0];if(session?.isolation!=='read committed'||!(Number(session.timeout_ms)>0&&Number(session.timeout_ms)<=30000))throw fail('SEGMENT_SESSION_BOUNDARY');
   const auth=async()=>{const a=await S.readAuth(query,key,p.acao===ACTIONS.validate?'validate':writing?'draft':'read_content');if((writing||p.acao===ACTIONS.validate)&&!a.caps.includes('read_content'))throw fail('SEGMENT_ACCESS_DENIED',403);return a;};
   const who=await auth(),reauth=async()=>{if((await auth()).actor!==who.actor)throw fail('SEGMENT_UNAUTHORIZED',401);};
   if(writing)await query(SQL.lock,[who.actor,p.idempotency_key]);await reauth();
   if(writing||p.acao===ACTIONS.operation){
    const old=(await query(SQL.operation,[who.actor,p.idempotency_key])).rows[0];
    if(old){await reauth();if(old.brand!==p.brand||writing&&(old.payload_hash!==H.digest(p)||H.digest(old.payload)!==H.digest(p)))return error(409,'SEGMENT_BINDING_OPERATION_MISMATCH');return copy(old.response);}
    if(!writing){await reauth();return error(404,'SEGMENT_BINDING_OPERATION_UNCONFIRMED');}
   }
   if(refreshCatalog){await refreshCatalog({query,brand:p.brand,signal});await reauth();}
   let result,applied=false,campaign=null,current=null,catalog=null,a=null,record=null;
   async function fresh({afterWrite=false,requireAudience=false}={}){
    const c=await S.readCatalog(query,p.brand),now=(await query(SQL.current,[p.campaign_id])).rows[0]?.current;
    if(!c.ready||catalog&&c.expires_at!==catalog.expires_at||catalog&&c.catalog.catalog_hash!==catalog.catalog.catalog_hash||!now||now.version!==current.version)throw fail(afterWrite?'SEGMENT_BINDING_UNCONFIRMED':'SEGMENT_BINDING_CHANGED',409);
    if(requireAudience){const r=(await query(SQL.audience,[p.audience_id,p.audience_revision,p.brand])).rows;if(r.length!==1)throw fail(afterWrite?'SEGMENT_BINDING_UNCONFIRMED':'SEGMENT_BINDING_AUDIENCE_CHANGED',409);const n=audience(r[0],p);if(n.context_hash!==a.context_hash||n.definition_hash!==a.definition_hash||H.digest(S.pins(n.definition,c))!==n.context_hash)throw fail(afterWrite?'SEGMENT_BINDING_UNCONFIRMED':'SEGMENT_BINDING_AUDIENCE_CHANGED',409);}
    await reauth();return c;
   }
   try{
    const rows=(await query(p.acao===ACTIONS.validate?SQL.campaignRead:SQL.campaign,[p.campaign_id])).rows;if(rows.length!==1)throw fail('SEGMENT_BINDING_CAMPAIGN_NOT_FOUND',404);
    campaign=nativeSnapshot(rows[0],p.brand,p.campaign_id,p.acao!==ACTIONS.read);
    await query(SQL.dependencies,[p.campaign_id]);
    current=currentSnapshot((await query(SQL.current,[p.campaign_id])).rows[0]?.current,p.brand,p.campaign_id);
    const heads=(await query(p.acao===ACTIONS.validate?SQL.headRead:SQL.head,[p.campaign_id])).rows;record=heads.length===1?heads[0]:null;if(record)binding(record);
    catalog=await S.readCatalog(query,p.brand);
    if(p.acao===ACTIONS.read){await reauth();return response(200,{binding:record?view(record,current,catalog):null,campaign_id:p.campaign_id,campaign_version:current.version,...FLAGS});}
    if(!catalog.ready)throw fail('SEGMENT_BINDING_UNAVAILABLE');
    const ids=current.definition.list_ids;if(ids.length<1||ids.length>30||new Set(ids).size!==ids.length||ids.some(id=>!positive(id)||!catalog.catalog.lists.some(l=>l.id===id&&l.available)))throw fail('SEGMENT_BINDING_CAMPAIGN_SCOPE',409);
    if(p.acao===ACTIONS.validate){
     if(!countProvider)throw fail('SEGMENT_BINDING_UNAVAILABLE');
     if(!record||current.version!==p.expected_campaign_version||record.campaign_version!==current.version||record.binding_version!==p.expected_binding_version||record.binding_hash!==p.expected_binding_hash)throw fail('SEGMENT_BINDING_VERSION_CONFLICT',409);
     const b=binding(record),history=(await query(SQL.bindingHistory,[p.campaign_id,b.binding_version])).rows;
     if(history.length!==1||history[0].binding_hash!==record.binding_hash||H.digest(history[0].binding)!==record.binding_hash)throw fail('SEGMENT_BINDING_CORRUPT');
     const ref={brand:p.brand,audience_id:b.audience_id,audience_revision:b.audience_revision},revisions=(await query(SQL.audience,[b.audience_id,b.audience_revision,p.brand])).rows;
     if(revisions.length!==1)throw fail('SEGMENT_BINDING_AUDIENCE_NOT_FOUND',404);
     const saved=audience(revisions[0],ref,false);
     if(saved.definition_hash!==b.definition_hash||saved.context_hash!==b.context_hash||H.digest(saved.definition)!==H.digest(b.definition)||H.digest(saved.context)!==H.digest(b.context)||H.digest(S.pins(b.definition,catalog))!==b.context_hash)throw fail('SEGMENT_BINDING_AUDIENCE_CHANGED',409);
     if(ids.length!==1||ids[0]!==b.base_list_id||catalog.base_list_id!==b.base_list_id)throw fail('SEGMENT_BINDING_BASE_REQUIRED',409);
     const nativeCatalog=(await query(SQL.campaignCatalog,[p.brand])).rows[0]?.catalog;
     let content={ok:true,error:null};
     try{const prepared=Campaign.prepare(current.definition,{catalog:nativeCatalog,tracking:Tracking,trackingId:p.campaign_id});if(H.digest(prepared.definition)!==H.digest(current.definition))content={ok:false,error:'CAMPAIGN_CONTENT_REQUIRES_SAVE'};}
     catch{content={ok:false,error:'CAMPAIGN_CONTENT_INVALID'};}
     await fresh();
     const counted=await countProvider({definition:copy(b.definition),baseListId:b.base_list_id,catalog:copy(catalog.catalog),query,signal});
     const count=S.countResult(counted,b.definition,catalog,b.audience_id,b.audience_revision)._body;
     await fresh();await reauth();
     const now=new Date((await query(SQL.clock)).rows[0]?.now).getTime(),checked=Date.parse(count.checked_at),expires=Math.min(checked+60000,Date.parse(catalog.expires_at));
     if(!Number.isFinite(now)||checked>now+1000||expires<=now)throw fail('SEGMENT_BINDING_UNAVAILABLE');
     await reauth();
     return response(200,{validation:{contract:'crm-audience-campaign-validation-v1',binding:view(record,current,catalog),content,audience:{source_confirmed:count.source_confirmed,eligible_count:count.eligible_count,unknown_reason:count.unknown_reason},checked_at:count.checked_at,expires_at:new Date(expires).toISOString(),...FLAGS}});
    }
    const records=(await query(SQL.audience,[p.audience_id,p.audience_revision,p.brand])).rows;if(records.length!==1)throw fail('SEGMENT_BINDING_AUDIENCE_NOT_FOUND',404);a=audience(records[0],p);
    if(ids.length!==1||ids[0]!==a.context.base.id){
     if(p.acao===ACTIONS.inspect){const c=await fresh({requireAudience:true}),base=c.catalog.lists.find(l=>l.id===a.context.base.id&&l.brand===p.brand&&l.available);if(!base)throw fail('SEGMENT_BINDING_UNAVAILABLE');return response(409,{error:'SEGMENT_BINDING_BASE_REQUIRED',base_list:{id:base.id,name:base.name}});}
     throw fail('SEGMENT_BINDING_BASE_REQUIRED',409);
    }
    if(H.digest(S.pins(a.definition,catalog))!==a.context_hash)throw fail('SEGMENT_BINDING_AUDIENCE_CHANGED',409);
    const intent={brand:p.brand,campaign_id:p.campaign_id,expected_campaign_version:current.version,expected_binding_version:record?.binding_version??0,audience_id:p.audience_id,audience_revision:p.audience_revision,expected_definition_hash:a.definition_hash,expected_context_hash:a.context_hash,expected_catalog_hash:catalog.catalog.catalog_hash};
    if(p.acao===ACTIONS.inspect){await fresh({requireAudience:true});return response(200,{contract:VERSION,intent,audience_name:a.definition.name,expires_at:new Date(catalog.expires_at).toISOString(),...FLAGS});}
    if(Object.keys(intent).some(k=>intent[k]!==p[k]))throw fail('SEGMENT_BINDING_VERSION_CONFLICT',409);
    await fresh({requireAudience:true});
    const touched=(await query(SQL.touch,[p.campaign_id])).rows;if(touched.length!==1)throw fail('SEGMENT_BINDING_CORRUPT');applied=true;
    const after=nativeSnapshot(touched[0],p.brand,p.campaign_id,true),withoutTime=x=>{const v=copy(x);delete v.updated_at;return v;};
    if(H.digest(withoutTime(after))!==H.digest(withoutTime(campaign)))throw fail('SEGMENT_BINDING_UNCONFIRMED');
    current=currentSnapshot((await query(SQL.current,[p.campaign_id])).rows[0]?.current,p.brand,p.campaign_id);
    const b={contract:VERSION,brand:p.brand,campaign_id:p.campaign_id,campaign_version:current.version,binding_version:(record?.binding_version??0)+1,audience_id:p.audience_id,audience_revision:p.audience_revision,definition_hash:a.definition_hash,context_hash:a.context_hash,base_list_id:a.context.base.id,definition:copy(a.definition),context:copy(a.context),catalog_hash:catalog.catalog.catalog_hash,authorizes_selection:false,authorizes_send:false},hash=H.digest(b);
    const params=[b.campaign_id,b.brand,b.binding_version,b.campaign_version,b.audience_id,b.audience_revision,b.definition_hash,b.context_hash,b.base_list_id,b.catalog_hash,JSON.stringify(b),hash,who.actor];
    const saved=(await query(record?SQL.update:SQL.insert,params)).rows;if(saved.length!==1)throw fail('SEGMENT_BINDING_CORRUPT');record=saved[0];binding(record);
    await query(SQL.revision,[b.campaign_id,b.binding_version,JSON.stringify(b),hash,who.actor]);
    result=response(b.binding_version===1?201:200,{binding:view(record,current,catalog),transport_supported:false});
   }catch(e){
    if(applied||!['SEGMENT_BINDING_CAMPAIGN_NOT_FOUND','SEGMENT_BINDING_CAMPAIGN_LOCKED','SEGMENT_BINDING_CAMPAIGN_SCOPE','SEGMENT_BINDING_BASE_REQUIRED','SEGMENT_BINDING_AUDIENCE_CHANGED','SEGMENT_BINDING_AUDIENCE_NOT_FOUND','SEGMENT_BINDING_UNAVAILABLE','SEGMENT_BINDING_VERSION_CONFLICT','SEGMENT_BINDING_CHANGED','SEGMENT_LIST_UNAVAILABLE'].includes(e?.code))throw e;
    result=error(e.status||503,e.code);
   }
   if(writing)await query(SQL.receipt,[who.actor,p.idempotency_key,p.brand,JSON.stringify(p),H.digest(p),JSON.stringify(result)]);
   if(applied)await fresh({afterWrite:true,requireAudience:true});else await reauth();active();return result;
  }
  const uncertain=()=>response(writing?202:503,{error:'SEGMENT_BINDING_UNCONFIRMED',...(writing?{state:'unconfirmed',idempotency_key:p.idempotency_key,automatic_retry:false}:{})});
  if(external?.aborted)return uncertain();
  const aborted=new Promise((_,reject)=>{abortHandler=()=>{controller.abort();reject(fail('SEGMENT_BINDING_UNCONFIRMED'));};external?.addEventListener('abort',abortHandler,{once:true});});
  try{return await Promise.race([transaction(work,{signal,readOnly:false,isolation:'read committed'}),aborted,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('SEGMENT_BINDING_UNCONFIRMED'));},timeoutMs);})]);}
  catch(e){if(['SEGMENT_UNAUTHORIZED','SEGMENT_ACCESS_DENIED','SEGMENT_SESSION_BOUNDARY'].includes(e?.code))return error(e.status||503,e.code);return uncertain();}
  finally{clearTimeout(timer);external?.removeEventListener('abort',abortHandler);controller.abort();}
 }
 return Object.freeze({enabled:false,execute});
}
module.exports={VERSION,ENABLED,ACTIONS,FLAGS,SQL,request,binding,view,createSegmentCampaignBinding};
