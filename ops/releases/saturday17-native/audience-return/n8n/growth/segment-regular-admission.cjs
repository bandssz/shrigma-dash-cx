'use strict';
// Integrated with the existing binding validator and the same dedicated,
// confirmed transaction. The service route has a separate OFF-by-default gate.
const {randomUUID}=require('node:crypto');
const B=require('./segment-campaign-binding.cjs'),S=require('./segment-audience-store.cjs'),H=require('./segment-audience-review.cjs');
const M=require('./ab-audience-material.cjs'),Render=require('./segment-regular-render.cjs');
const VERSION='crm-audience-regular-admission-v1';
const ACTIONS=Object.freeze({prepare:'campanha_publico_preparar_envio',schedule:'campanha_publico_agendar',operation:'campanha_publico_agendamento_operacao'});
const exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const clone=v=>JSON.parse(H.canonical(v)),response=(_http,_body)=>({_http,_body}),error=(s,c)=>response(s,{error:c});
const fail=code=>Object.assign(Error(code),{code});
const SQL=Object.freeze({
 runtime:'SELECT crm_audience_v2.regular_admission_runtime($1) AS runtime',
 snapshot:'SELECT crm_audience_v2.regular_admission_snapshot($1) AS snapshot_text',
 lock:"SELECT pg_advisory_xact_lock(hashtextextended('regular-admission:'||jsonb_build_array($1::text,$2::text)::text,0))",
 operation:'SELECT brand,payload,payload_hash,response FROM crm_audience_v2.regular_admission_request WHERE actor=$1 AND operation_key=$2',
 receipt:'INSERT INTO crm_audience_v2.regular_admission_request(actor,operation_key,brand,payload,payload_hash,response) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb)',
 review:'SELECT * FROM crm_audience_v2.regular_admission_review WHERE id=$1::uuid AND actor=$2',
 save:'INSERT INTO crm_audience_v2.regular_admission_review(id,actor,brand,campaign_id,campaign_version,binding_version,binding_hash,material,material_hash,runtime,eligible_count,checked_at,expires_at) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12::timestamptz,$13::timestamptz)',
 schedule:'SELECT crm_audience_v2.regular_admission_schedule($1::uuid,$2) AS campaign'
});
function request(input){
 const p=clone(input);if(!['fish','aristo'].includes(p?.brand)||!Object.values(ACTIONS).includes(p?.acao))throw fail('REGULAR_ADMISSION_INPUT');
 if(p.acao===ACTIONS.operation){if(!exact(p,['acao','brand','idempotency_key'])||typeof p.idempotency_key!=='string'||!/^[A-Za-z0-9_.:-]{8,128}$/.test(p.idempotency_key))throw fail('REGULAR_ADMISSION_INPUT');return p;}
 const common=['acao','brand','campaign_id','expected_campaign_version','expected_binding_version','expected_binding_hash'];
 if(!exact(p,[...common,...(p.acao===ACTIONS.schedule?['review_id','confirm','idempotency_key']:[])]))throw fail('REGULAR_ADMISSION_INPUT');
 B.request(Object.fromEntries(common.map(k=>[k,k==='acao'?B.ACTIONS.validate:p[k]])));
 if(p.acao===ACTIONS.schedule&&(!uuid(p.review_id)||p.confirm!=='agendar'||typeof p.idempotency_key!=='string'||!/^[A-Za-z0-9_.:-]{8,128}$/.test(p.idempotency_key)))throw fail('REGULAR_ADMISSION_INPUT');return p;
}
function sender(value){const mailbox="[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+";return value.match(new RegExp('^('+mailbox+')$','i'))?.[1]||value.match(new RegExp('^[^<>\\r\\n]+<('+mailbox+')>$','i'))?.[1]||null;}
function reviewView(r){return {contract:VERSION,review_id:r.id,brand:r.brand,campaign_id:r.campaign_id,campaign_version:r.campaign_version,binding_version:r.binding_version,binding_hash:r.binding_hash,material_hash:r.material_hash,eligible_count:r.eligible_count,send_at:r.material.campaign.send_at,checked_at:new Date(r.checked_at).toISOString(),expires_at:new Date(r.expires_at).toISOString(),requires_confirmation:true};}
function createRegularAdmission({transaction,countProvider,refreshCatalog=null,timeoutMs=10000,id=randomUUID}={}){
 if(typeof transaction!=='function'||typeof countProvider!=='function'||typeof id!=='function')throw fail('REGULAR_ADMISSION_ADAPTER');
 async function execute({request:input,key,signal}={}){
  let p;try{p=request(input);}catch{return error(400,'REGULAR_ADMISSION_INPUT');}
  const writing=p.acao===ACTIONS.schedule,uncertain=()=>response(writing?202:503,{error:'REGULAR_ADMISSION_UNCONFIRMED',...(writing?{state:'unconfirmed',idempotency_key:p.idempotency_key,automatic_retry:false}:{})});
  if(typeof key!=='string'||!/^[a-z0-9-]{8,128}$/.test(key))return error(401,'SEGMENT_UNAUTHORIZED');
  if(p.acao===ACTIONS.operation){
   try{return await transaction(async tx=>{await tx.query(S.SQL.setup);const who=await S.readAuth(tx.query.bind(tx),key,'read_content');const old=(await tx.query(SQL.operation,[who.actor,p.idempotency_key])).rows[0];const again=await S.readAuth(tx.query.bind(tx),key,'read_content');if(who.actor!==again.actor)throw fail('SEGMENT_UNAUTHORIZED');return !old?error(404,'REGULAR_ADMISSION_OPERATION_UNCONFIRMED'):old.brand!==p.brand?error(409,'REGULAR_ADMISSION_OPERATION_MISMATCH'):clone(old.response);},{signal,readOnly:false,isolation:'read committed'});}catch(e){return ['SEGMENT_UNAUTHORIZED','SEGMENT_ACCESS_DENIED'].includes(e.code)?error(e.code==='SEGMENT_UNAUTHORIZED'?401:403,e.code):uncertain();}
  }
  let who,runtime,stored,reauth,replay=false;
  const validator=B.createSegmentCampaignBinding({countProvider,refreshCatalog,timeoutMs,transaction:async(work,opts)=>transaction(async tx=>{
   const out=await work(tx);
   if(writing&&who&&!replay&&out._http!==401&&out._http!==403){
    await reauth();await tx.query(SQL.receipt,[who.actor,p.idempotency_key,p.brand,JSON.stringify(p),H.digest(p),JSON.stringify(out)]);await reauth();
   }
   return out;
  },opts),validationHooks:{
   authorize(actor){if(writing&&!actor.caps.includes('submit'))throw Object.assign(fail('SEGMENT_ACCESS_DENIED'),{status:403});},
   async before(ctx){
    who=ctx.who;reauth=ctx.reauth;const {query}=ctx;
    if(writing){
     await query(SQL.lock,[who.actor,p.idempotency_key]);await reauth();
     const old=(await query(SQL.operation,[who.actor,p.idempotency_key])).rows[0];
     if(old){replay=true;return old.brand===p.brand&&old.payload_hash===H.digest(p)&&H.digest(old.payload)===H.digest(p)?clone(old.response):error(409,'REGULAR_ADMISSION_OPERATION_MISMATCH');}
     stored=(await query(SQL.review,[p.review_id,who.actor])).rows[0];
     if(!stored||stored.brand!==p.brand||stored.campaign_id!==p.campaign_id||stored.campaign_version!==p.expected_campaign_version||stored.binding_version!==p.expected_binding_version||stored.binding_hash!==p.expected_binding_hash)return error(409,'REGULAR_ADMISSION_REVIEW_REQUIRED');
    }
    runtime=(await query(SQL.runtime,[p.brand])).rows[0]?.runtime;await reauth();
   },
   async after({query,validation,current,binding}){
    if(!validation.content.ok)return error(409,validation.content.error);
    if(!validation.audience.source_confirmed)return error(503,'REGULAR_ADMISSION_SOURCE_UNAVAILABLE');
    if(validation.audience.eligible_count<1)return error(409,'REGULAR_ADMISSION_EMPTY');
    let material;
    try{const text=(await query(SQL.snapshot,[p.campaign_id])).rows[0]?.snapshot_text;material=M.materialize(M.parseDatabaseSnapshot(text),{brand:p.brand,campaignId:p.campaign_id});}
    catch(e){if(e.code?.startsWith('AB_MATERIAL_'))return error(409,'REGULAR_ADMISSION_MATERIAL_UNAVAILABLE');throw e;}
    // File metadata does not prove attachment bytes. Until immutable attachment
    // storage is supported, refuse attachments instead of silently dropping them.
    if(material.snapshot.media.length)return error(409,'REGULAR_ADMISSION_ATTACHMENTS_UNAVAILABLE');
    if(!Render.headersAllowed(material.snapshot.campaign.headers))return error(409,'REGULAR_ADMISSION_HEADERS_UNAVAILABLE');
    if(!Render.validate(material.snapshot))return error(409,'REGULAR_ADMISSION_RENDER_UNAVAILABLE');
    const sets=material.snapshot.campaign.headers.flatMap(h=>Object.entries(h).filter(([k])=>k.toLowerCase()==='x-ses-configuration-set').map(([,v])=>v));
    if(sets.length>1||sets.length===1&&sets[0]!==runtime?.configuration_set)return error(409,'REGULAR_ADMISSION_SENDER_UNAVAILABLE');
    if(sender(material.snapshot.campaign.from_email)!==runtime?.envelope_from)return error(409,'REGULAR_ADMISSION_SENDER_UNAVAILABLE');
    const clock=new Date((await query(B.SQL.clock)).rows[0]?.now).getTime(),sendAt=Date.parse(current.definition.send_at);
    if(!Number.isFinite(clock)||!Number.isFinite(sendAt)||sendAt<clock+15*60000)return error(409,'REGULAR_ADMISSION_SCHEDULE_TOO_SOON');
    if(H.digest((await query(SQL.runtime,[p.brand])).rows[0]?.runtime)!==H.digest(runtime))return error(409,'REGULAR_ADMISSION_CHANGED');
    if(!writing){
     const rid=id();if(!uuid(rid))throw fail('REGULAR_ADMISSION_ID');
     const r={id:rid,actor:who.actor,brand:p.brand,campaign_id:p.campaign_id,campaign_version:p.expected_campaign_version,binding_version:binding.binding_version,binding_hash:binding.binding_hash,material:material.snapshot,material_hash:material.material_hash,runtime,eligible_count:validation.audience.eligible_count,checked_at:new Date(clock).toISOString(),expires_at:new Date(Math.min(clock+60000,Date.parse(validation.expires_at))).toISOString()};
     if(Date.parse(r.expires_at)<=clock)return error(409,'REGULAR_ADMISSION_EXPIRED');
     await query(SQL.save,[r.id,r.actor,r.brand,r.campaign_id,r.campaign_version,r.binding_version,r.binding_hash,JSON.stringify(r.material),r.material_hash,JSON.stringify(r.runtime),r.eligible_count,r.checked_at,r.expires_at]);await reauth();
     return response(200,{review:reviewView(r)});
    }
    if(new Date(stored.expires_at).getTime()<=clock||new Date(stored.checked_at).getTime()>clock)return error(409,'REGULAR_ADMISSION_EXPIRED');
    if(stored.material_hash!==material.material_hash||M.canonical(stored.material)!==M.canonical(material.snapshot)||H.digest(stored.runtime)!==H.digest(runtime)||stored.eligible_count!==validation.audience.eligible_count)return error(409,'REGULAR_ADMISSION_CHANGED');
    await reauth();const campaign=(await query(SQL.schedule,[p.review_id,who.actor])).rows[0]?.campaign;
    if(campaign?.id!==p.campaign_id||campaign.status!=='scheduled'||campaign.sent!==0||campaign.started_at!==null)throw fail('REGULAR_ADMISSION_UNCONFIRMED');
    await reauth();return response(200,{scheduled:{contract:VERSION,brand:p.brand,campaign_id:p.campaign_id,review_id:p.review_id,idempotency_key:p.idempotency_key,status:'scheduled',campaign_version:campaign.version,send_at:campaign.send_at,eligible_count:stored.eligible_count}});
   }
  }});
  const translated={acao:B.ACTIONS.validate,brand:p.brand,campaign_id:p.campaign_id,expected_campaign_version:p.expected_campaign_version,expected_binding_version:p.expected_binding_version,expected_binding_hash:p.expected_binding_hash};
  const out=await validator.execute({key,request:translated,signal});return out._body?.error==='SEGMENT_BINDING_UNCONFIRMED'?uncertain():out;
 }
 return Object.freeze({enabled:false,execute});
}
module.exports={VERSION,ACTIONS,SQL,request,reviewView,createRegularAdmission};
