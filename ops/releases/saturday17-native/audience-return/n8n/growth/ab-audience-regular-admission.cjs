'use strict';
// Pair admission composed inside the authenticated read/lock path. This module
// does not install SQL, publish a route, enable a worker or bypass A/B guards.
const {randomUUID}=require('node:crypto');
const I=require('./ab-audience-admission-inspect.cjs'),D=require('./ab-audience-admission-contract.cjs');
const S=require('./segment-audience-store.cjs'),B=require('./segment-campaign-binding.cjs');
const H=require('./segment-audience-review.cjs'),M=require('./ab-audience-material.cjs');
const Render=require('./segment-regular-render.cjs');

const VERSION='crm-ab-audience-regular-admission-v1';
const ACTIONS=Object.freeze({prepare:'ab_publico_admissao_preparar',schedule:'ab_publico_admissao_agendar',operation:'ab_publico_admissao_operacao'});
const SQL=Object.freeze({
 tracking:'SELECT crm_audience_v2.ab_regular_tracking() AS ready',
 runtime:'SELECT crm_audience_v2.regular_admission_runtime($1) AS runtime',
 lock:"SELECT pg_advisory_xact_lock(hashtextextended('ab-regular-admission:'||jsonb_build_array($1::text,$2::text)::text,0))",
 operation:'SELECT brand,payload,payload_hash,response FROM crm_audience_v2.ab_regular_request WHERE actor=$1 AND operation_key=$2',
 receipt:'INSERT INTO crm_audience_v2.ab_regular_request(actor,operation_key,brand,payload,payload_hash,response) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb)',
 review:'SELECT * FROM crm_audience_v2.ab_regular_review WHERE id=$1::uuid AND actor=$2',
 save:`INSERT INTO crm_audience_v2.ab_regular_review
  (id,actor,brand,test_id,experiment_version,scope_hash,audience_review_id,inspection,materials,runtime,checked_at,expires_at)
  VALUES($1::uuid,$2,$3,$4::uuid,$5,$6,$7::uuid,$8::jsonb,$9::jsonb,$10::jsonb,$11::timestamptz,$12::timestamptz)`,
 schedule:'SELECT crm_audience_v2.ab_regular_schedule($1::uuid,$2) AS result'
});
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),positive=v=>Number.isSafeInteger(v)&&v>0&&v<=999999999;
const clone=v=>JSON.parse(H.canonical(v)),result=(_http,_body)=>({_http,_body}),error=(status,code)=>result(status,{error:code});
const fail=code=>Object.assign(Error(code),{code});
function request(input){
 let p;try{p=clone(input);}catch{throw fail('AB_REGULAR_ADMISSION_INPUT');}
 if(!p||!['fish','aristo'].includes(p.brand)||!Object.values(ACTIONS).includes(p.acao))throw fail('AB_REGULAR_ADMISSION_INPUT');
 if(p.acao===ACTIONS.operation){if(!exact(p,['acao','brand','idempotency_key'])||typeof p.idempotency_key!=='string'||!/^[A-Za-z0-9_.:-]{8,128}$/.test(p.idempotency_key))throw fail('AB_REGULAR_ADMISSION_INPUT');return p;}
 const common=['acao','brand','test_id','expected_version','expected_scope_hash','audience_review_id'];
 if(!exact(p,[...common,...(p.acao===ACTIONS.schedule?['admission_review_id','confirm','idempotency_key']:[])]))throw fail('AB_REGULAR_ADMISSION_INPUT');
 if(!uuid(p.test_id)||!positive(p.expected_version)||!hash(p.expected_scope_hash)||!uuid(p.audience_review_id))throw fail('AB_REGULAR_ADMISSION_INPUT');
 if(p.acao===ACTIONS.schedule&&(!uuid(p.admission_review_id)||p.confirm!=='agendar_duas'||typeof p.idempotency_key!=='string'||!/^[A-Za-z0-9_.:-]{8,128}$/.test(p.idempotency_key)))throw fail('AB_REGULAR_ADMISSION_INPUT');
 return p;
}
function sender(value){const mailbox="[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+";return typeof value==='string'&&(value.match(new RegExp('^('+mailbox+')$','i'))?.[1]||value.match(new RegExp('^[^<>\\r\\n]+<('+mailbox+')>$','i'))?.[1])||null;}
function stableInspection(value){const v=clone(value),audience=v.audience;delete v.checked_at;delete v.expires_at;delete v.inspection_hash;delete audience.checked_at;return v;}
function materialSnapshots(materials){return materials.slice().sort((a,b)=>a.campaign_id-b.campaign_id).map(m=>clone(m.snapshot));}
function materialValid(material,runtime){
 const s=material?.snapshot;if(!s||s.media.length||!Render.headersAllowed(s.campaign.headers)||!Render.validate(s))return false;
 const sets=s.campaign.headers.flatMap(h=>Object.entries(h).filter(([k])=>k.toLowerCase()==='x-ses-configuration-set').map(([,v])=>v));
 return sets.length<=1&&(sets.length===0||sets[0]===runtime?.configuration_set)&&sender(s.campaign.from_email)===runtime?.envelope_from;
}
function reviewView(row){const i=row.inspection;return {contract:VERSION,admission_review_id:row.id,brand:row.brand,test_id:row.test_id,experiment_version:row.experiment_version,scope_hash:row.scope_hash,audience_review_id:row.audience_review_id,eligible_fingerprint:i.audience.eligible_fingerprint,arms:i.audience.arms.map(a=>({arm:a.arm,campaign_id:a.campaign_id,eligible:a.eligible,material_hash:i.materials.find(m=>m.arm===a.arm).material_hash})),send_at:i.send_at,checked_at:new Date(row.checked_at).toISOString(),expires_at:new Date(row.expires_at).toISOString(),requires_confirmation:true};}
function createABRegularAdmission({transaction,timeoutMs=10000,id=randomUUID,createInspection=I.createAdmissionInspection}={}){
 if(typeof transaction!=='function'||typeof id!=='function'||typeof createInspection!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw fail('AB_REGULAR_ADMISSION_ADAPTER');
 async function execute({request:input,key,signal}={}){
  let p;try{p=request(input);}catch{return error(400,'AB_REGULAR_ADMISSION_INPUT');}
  const writing=p.acao===ACTIONS.schedule,uncertain=()=>result(writing?202:503,{error:'AB_REGULAR_ADMISSION_UNCONFIRMED',...(writing?{state:'unconfirmed',idempotency_key:p.idempotency_key,automatic_retry:false}:{})});
  if(typeof key!=='string'||!/^[a-z0-9-]{8,128}$/.test(key))return error(401,'SEGMENT_UNAUTHORIZED');
  if(p.acao===ACTIONS.operation){
   try{return await transaction(async tx=>{await tx.query(S.SQL.setup);const who=await S.readAuth(tx.query.bind(tx),key,'read_content'),old=(await tx.query(SQL.operation,[who.actor,p.idempotency_key])).rows[0],again=await S.readAuth(tx.query.bind(tx),key,'read_content');if(again.actor!==who.actor)throw fail('SEGMENT_UNAUTHORIZED');return !old?error(404,'AB_REGULAR_ADMISSION_OPERATION_UNCONFIRMED'):old.brand!==p.brand?error(409,'AB_REGULAR_ADMISSION_OPERATION_MISMATCH'):clone(old.response);},{signal,readOnly:false,isolation:'read committed'});}catch(e){return ['SEGMENT_UNAUTHORIZED','SEGMENT_ACCESS_DENIED'].includes(e.code)?error(e.code==='SEGMENT_UNAUTHORIZED'?401:403,e.code):uncertain();}
  }
  let who,reauth,runtime,stored,replay=false;
  const inspector=createInspection({transaction,timeoutMs,inspectionHooks:{
   authorize(actor){if(writing&&!actor.caps.includes('submit'))throw Object.assign(fail('SEGMENT_ACCESS_DENIED'),{status:403});},
   async before(ctx){
    who=ctx.who;reauth=ctx.reauth;
    if(writing){
     await ctx.query(SQL.lock,[who.actor,p.idempotency_key]);await reauth();
     const old=(await ctx.query(SQL.operation,[who.actor,p.idempotency_key])).rows[0];
     if(old){replay=true;return old.brand===p.brand&&old.payload_hash===H.digest(p)&&H.digest(old.payload)===H.digest(p)?clone(old.response):error(409,'AB_REGULAR_ADMISSION_OPERATION_MISMATCH');}
     stored=(await ctx.query(SQL.review,[p.admission_review_id,who.actor])).rows[0];
     if(!stored||stored.brand!==p.brand||stored.test_id!==p.test_id||stored.experiment_version!==p.expected_version||stored.scope_hash!==p.expected_scope_hash||stored.audience_review_id!==p.audience_review_id)return error(409,'AB_REGULAR_ADMISSION_REVIEW_REQUIRED');
    }
    if((await ctx.query(SQL.tracking)).rows[0]?.ready!==true)return error(409,'AB_REGULAR_ADMISSION_TRACKING_UNAVAILABLE');
    runtime=(await ctx.query(SQL.runtime,[p.brand])).rows[0]?.runtime;await reauth();
   },
   async after(ctx){
    const inspection=ctx.view?.inspection,materials=ctx.materials.slice().sort((a,b)=>a.campaign_id-b.campaign_id);
    if(!inspection||materials.length!==2||materials.some((m,i)=>m.campaign_id!==inspection.materials.slice().sort((a,b)=>a.campaign_id-b.campaign_id)[i].campaign_id||m.material_hash!==inspection.materials.slice().sort((a,b)=>a.campaign_id-b.campaign_id)[i].material_hash))return error(409,'AB_REGULAR_ADMISSION_CHANGED');
    if(materials.some(m=>!materialValid(m,runtime)))return error(409,'AB_REGULAR_ADMISSION_MATERIAL_UNAVAILABLE');
    const clock=new Date((await ctx.query(B.SQL.clock)).rows[0]?.now).getTime(),sendAt=Date.parse(inspection.send_at);
    if(!Number.isFinite(clock)||!Number.isFinite(sendAt)||sendAt<clock+900000)return error(409,'AB_REGULAR_ADMISSION_SCHEDULE_TOO_SOON');
    const currentRuntime=(await ctx.query(SQL.runtime,[p.brand])).rows[0]?.runtime;if(H.digest(currentRuntime)!==H.digest(runtime))return error(409,'AB_REGULAR_ADMISSION_CHANGED');
    if(!writing){
     const rid=id();if(!uuid(rid))throw fail('AB_REGULAR_ADMISSION_ID');
     const row={id:rid,actor:who.actor,brand:p.brand,test_id:p.test_id,experiment_version:p.expected_version,scope_hash:p.expected_scope_hash,audience_review_id:p.audience_review_id,inspection:clone(inspection),materials:materialSnapshots(materials),runtime:clone(runtime),checked_at:new Date(clock).toISOString(),expires_at:new Date(Math.min(clock+60000,Date.parse(inspection.expires_at))).toISOString()};
     if(Date.parse(row.expires_at)<=clock)return error(409,'AB_REGULAR_ADMISSION_EXPIRED');
     await ctx.query(SQL.save,[row.id,row.actor,row.brand,row.test_id,row.experiment_version,row.scope_hash,row.audience_review_id,JSON.stringify(row.inspection),JSON.stringify(row.materials),JSON.stringify(row.runtime),row.checked_at,row.expires_at]);await reauth();
     return result(200,{review:reviewView(row)});
    }
    const expires=new Date(stored.expires_at).getTime(),checked=new Date(stored.checked_at).getTime();
    if(!Number.isFinite(expires)||!Number.isFinite(checked)||checked>clock||expires<=clock||expires-checked>60000||Date.parse(inspection.expires_at)<=clock)return error(409,'AB_REGULAR_ADMISSION_EXPIRED');
    const snapshots=materialSnapshots(materials),storedSnapshots=clone(stored.materials);
    if(H.digest(stableInspection(stored.inspection))!==H.digest(stableInspection(inspection))||H.digest(storedSnapshots)!==H.digest(snapshots)||H.digest(stored.runtime)!==H.digest(runtime))return error(409,'AB_REGULAR_ADMISSION_CHANGED');
    await reauth();const scheduled=(await ctx.query(SQL.schedule,[p.admission_review_id,who.actor])).rows[0]?.result;
    if(!exact(scheduled,['test_id','brand','state','version','campaigns'])||scheduled.test_id!==p.test_id||scheduled.brand!==p.brand||scheduled.state!=='scheduled'||!positive(scheduled.version)||!Array.isArray(scheduled.campaigns)||scheduled.campaigns.length!==2)throw fail('AB_REGULAR_ADMISSION_UNCONFIRMED');
    const ids=inspection.materials.map(m=>m.campaign_id).sort((a,b)=>a-b),campaigns=scheduled.campaigns.slice().sort((a,b)=>a.id-b.id);
    if(campaigns.some((c,i)=>c?.id!==ids[i]||c.status!=='scheduled'||c.sent!==0||c.started_at!==null))throw fail('AB_REGULAR_ADMISSION_UNCONFIRMED');
    const out=result(200,{scheduled:{contract:VERSION,brand:p.brand,test_id:p.test_id,admission_review_id:p.admission_review_id,idempotency_key:p.idempotency_key,status:'scheduled',version:scheduled.version,send_at:inspection.send_at,campaigns:campaigns.map(c=>({campaign_id:c.id,campaign_version:c.version}))}});
    await reauth();await ctx.query(SQL.receipt,[who.actor,p.idempotency_key,p.brand,JSON.stringify(p),H.digest(p),JSON.stringify(out)]);await reauth();return out;
   }
  }});
  const translated={acao:D.ACTION,brand:p.brand,test_id:p.test_id,expected_version:p.expected_version,expected_scope_hash:p.expected_scope_hash,review_id:p.audience_review_id};
  const out=await inspector.execute({key,request:translated,signal});
  if(replay)return out;
  return writing&&out._http===503?uncertain():out;
 }
 return Object.freeze({enabled:false,execute});
}
module.exports={VERSION,ACTIONS,SQL,request,reviewView,stableInspection,materialValid,createABRegularAdmission};
