'use strict';
// The existing panel journal owns one operation. Preparation, scoped review,
// material admission and paired schedule compose inside that same transaction.
const {createHash}=require('node:crypto');
const C=require('../../growth-ab-experiment-contract.js'),S=require('./segment-audience-store.cjs');
const H=require('./segment-audience-review.cjs'),P=require('./ab-audience-prepare.cjs');
const R=require('./ab-audience-review.cjs'),A=require('./ab-audience-regular-admission.cjs');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));
const fail=code=>Object.assign(Error(code),{code});
const response=(status,body)=>({status,body,headers:{'Cache-Control':'no-store'}});
const actorView=actor=>'panel:'+createHash('sha256').update('crm-ab-email-operator-v2:'+actor).digest('hex');
const SQL=Object.freeze({
 lock:"SELECT pg_advisory_xact_lock(hashtextextended('ab-panel:'||$1::text||':'||$2::text,0))",
 operation:'SELECT * FROM crm_audience_v2.ab_panel_request WHERE actor=$1 AND operation_id=$2::uuid',
 save:'INSERT INTO crm_audience_v2.ab_panel_request(actor,operation_id,brand,action,payload,payload_hash,response) VALUES($1,$2::uuid,$3,$4,$5::jsonb,$6,$7::jsonb)',
 scope:'SELECT s.scope_hash,e.version FROM crm_audience_v2.ab_scope s JOIN public.crm_ab_experiment_v2 e USING(test_id) WHERE s.test_id=$1::uuid AND s.brand=$2',
 experiment:'SELECT public.crm_ab_snapshot_v2(e.test_id) AS experiment FROM public.crm_ab_experiment_v2 e JOIN crm_audience_v2.ab_scope s USING(test_id) WHERE e.test_id=$1::uuid AND e.brand=$2',
 measurement:'SELECT public.crm_ab_measure_v2($1::uuid) AS measurement',
 review:'SELECT * FROM crm_audience_v2.ab_regular_review WHERE id=$1::uuid AND actor=$2 AND brand=$3',
 latest:'SELECT * FROM crm_audience_v2.ab_regular_review WHERE test_id=$1::uuid AND actor=$2 AND brand=$3 ORDER BY checked_at DESC,id DESC LIMIT 1',
 list:'SELECT public.crm_ab_snapshot_v2(e.test_id) AS experiment FROM public.crm_ab_experiment_v2 e JOIN crm_audience_v2.ab_scope s USING(test_id) WHERE e.brand=$1 ORDER BY e.prepared_at DESC,e.test_id LIMIT 21',
 campaigns:`SELECT c.id,c.name,c.subject,c.send_at,public.shrigma_campaign_current(c.id)->>'version' AS version,
  b.audience_id,b.audience_revision,a.name AS audience_name
  FROM public.campaigns c JOIN crm_audience_v2.campaign_binding b ON b.campaign_id=c.id
  JOIN crm_audience_v2.audience a ON a.id=b.audience_id
  WHERE b.brand=$1 AND c.attribs#>>'{crm,brand}'=$1 AND c.status::text='draft' AND c.sent=0 AND c.started_at IS NULL
   AND NOT a.archived AND a.version=b.audience_revision
   AND NOT EXISTS(SELECT 1 FROM public.crm_ab_arm_v2 WHERE campaign_id=c.id) ORDER BY c.id DESC LIMIT 100`,
 ready:'SELECT crm_audience_v2.ab_regular_ready($1::text) AS ready',
 lifecycle:'SELECT crm_audience_v2.ab_regular_lifecycle($1::uuid,$2,$3,$4) AS experiment'
});
function publicReview(r){
 if(!r)return null;const i=r.inspection;
 return {mode:'saved-audience',review_id:r.id,version:r.experiment_version,scope_hash:r.scope_hash,audience_review_id:r.audience_review_id,
  checked_at:new Date(r.checked_at).toISOString(),expires_at:new Date(r.expires_at).toISOString(),send_at:i.send_at,
  arms:i.audience.arms.map(a=>({arm:a.arm,campaign_id:a.campaign_id,counts:{allocated:a.allocated,eligible:a.eligible,excluded:a.excluded,revoked:a.revoked,missing:a.missing}}))};
}
function parse(v){
 if(!exact(v,['method','request'])||!['GET','POST'].includes(v.method)||!v.request?.headers||Object.keys(v.request).some(k=>!['headers','body','query'].includes(k)))throw fail('AB_V2_REQUEST');
 const auth=Object.entries(v.request.headers).filter(([k])=>k.toLowerCase()==='authorization');
 if(auth.length!==1||typeof auth[0][1]!=='string'||!/^Bearer [a-z0-9-]{8,128}$/.test(auth[0][1]))throw fail('SEGMENT_UNAUTHORIZED');
 const origin=Object.entries(v.request.headers).filter(([k])=>k.toLowerCase()==='origin');
 if(origin.length>1||origin.length===1&&origin[0][1]!=='https://bandssz.github.io')throw fail('AB_V2_ORIGIN');
 if(v.method==='GET'&&v.request.body!==undefined||v.method==='POST'&&v.request.query!==undefined)throw fail('AB_V2_REQUEST');
 const p=v.method==='GET'?v.request.query:v.request.body;
 if(!p||!['fish','aristo'].includes(p.brand)||JSON.stringify(p).length>32768)throw fail('AB_V2_REQUEST');
 const keys={capabilities:[],list:[],campaigns:[],get:['test_id'],operation:['operation_id','action'],mutate:['operation_id','request_payload']};
 if(!Object.hasOwn(keys,p.method)||!exact(p,['method','brand',...keys[p.method]])||(p.method==='mutate')!==(v.method==='POST'))throw fail('AB_V2_REQUEST');
 if(p.test_id!==undefined&&!uuid(p.test_id)||p.operation_id!==undefined&&!uuid(p.operation_id))throw fail('AB_V2_REQUEST');
 if(p.method==='operation'&&!['prepare','review','schedule','cancel','close'].includes(p.action))throw fail('AB_V2_REQUEST');
 if(p.method==='mutate'){C.request(p.request_payload);if(p.request_payload.brand!==p.brand||p.request_payload.action==='review')throw fail('AB_V2_REQUEST');}
 return {p,key:auth[0][1].slice(7)};
}
function createABPanelAPI({transaction,enabled=false,timeoutMs=10000}={}){
 if(typeof transaction!=='function'||typeof enabled!=='boolean')throw fail('AB_V2_ADAPTER');
 return {async handle(input,{signal}={}){
  let entry;try{entry=parse(input);}catch(e){return response(e.code==='SEGMENT_UNAUTHORIZED'?401:e.code==='AB_V2_ORIGIN'?403:400,{error:e.code||'AB_V2_REQUEST'});}
  const {p,key}=entry,writing=p.method==='mutate';
  try{return await transaction(async tx=>{
   await tx.query(S.SQL.setup);await tx.query("SELECT set_config('TimeZone','UTC',true),set_config('DateStyle','ISO, YMD',true)");
   const who=await S.readAuth(tx.query,key,'read_content');
   const reauth=async(cap='read_content')=>{const current=await S.readAuth(tx.query,key,cap);if(current.actor!==who.actor)throw fail('SEGMENT_UNAUTHORIZED');return current;};
   const send=async(status,body)=>{await reauth();return response(status,body);};
   const snap=async tid=>(await tx.query(SQL.experiment,[tid,p.brand])).rows[0]?.experiment;
   if(p.method==='capabilities'){
    const ready=enabled&&(await tx.query(SQL.ready,[p.brand])).rows[0]?.ready===true;
    return send(200,{contract:C.CONTRACT,brand:p.brand,audience_mode:'saved-audience-v1',enabled:ready,
     configure:ready&&who.caps.includes('draft'),review:ready&&who.caps.includes('validate'),schedule:ready&&who.caps.includes('submit'),
     cancel:who.caps.includes('submit'),close:who.caps.includes('draft'),operation:true,automatic_send:false});
   }
   if(p.method==='operation'){
    const old=(await tx.query(SQL.operation,[who.actor,p.operation_id])).rows[0];
    if(old&&(old.brand!==p.brand||old.action!==p.action))return send(409,{error:'AB_V2_IDENTITY'});
    if(old&&H.digest(old.payload)!==old.payload_hash)throw fail('AB_V2_UNCONFIRMED');
    return send(200,{contract:'crm-ab-email-operation-v2',operation:{operation_id:p.operation_id,actor:actorView(who.actor),brand:p.brand,action:p.action,
     state:old?'completed':'missing',request_payload:old?.payload??null,response:old?.response??null}});
   }
   if(p.method==='list'){
    const all=(await tx.query(SQL.list,[p.brand])).rows;
    return send(200,{contract:C.CONTRACT,brand:p.brand,experiments:all.slice(0,20).map(x=>x.experiment),limit:20,recent_only:true,more:all.length>20});
   }
   if(p.method==='campaigns')return send(200,{contract:C.CONTRACT,brand:p.brand,campaigns:(await tx.query(SQL.campaigns,[p.brand])).rows,limit:100,recent_only:true});
   if(p.method==='get'){
    const experiment=await snap(p.test_id);if(!experiment)return send(404,{error:'AB_V2_NOT_FOUND'});
    const review=(await tx.query(SQL.latest,[p.test_id,who.actor,p.brand])).rows[0],measurement=(await tx.query(SQL.measurement,[p.test_id])).rows[0]?.measurement;
    return send(200,{contract:C.CONTRACT,experiment,review:publicReview(review),measurement});
   }
   const payload=C.request(p.request_payload),action=C.action(payload),cap={prepare:'draft',review:'validate',schedule:'submit',cancel:'submit',close:'draft'}[action];
   await tx.query(SQL.lock,[who.actor,p.operation_id]);await reauth(cap);
   const old=(await tx.query(SQL.operation,[who.actor,p.operation_id])).rows[0];
   if(old){if(old.brand!==p.brand||old.action!==action||old.payload_hash!==H.digest(payload)||H.digest(old.payload)!==old.payload_hash)return send(409,{error:'AB_V2_IDENTITY'});return send(old.response.status,old.response.body);}
   let result;
   if(!enabled&&['prepare','review','schedule'].includes(action))result={status:409,body:{error:'AB_V2_TRANSPORT_UNAVAILABLE'}};
   else if(['review','schedule'].includes(action)&&(await tx.query(A.SQL.tracking)).rows[0]?.ready!==true)result={status:409,body:{error:'AB_V2_TRACKING_UNAVAILABLE'}};
   else{
    // All nested stores share this confirmed outer transaction. A nested
    // uncertain result aborts it, so no partial operation receipt can commit.
    const sameTransaction=async work=>work(tx),nested=async(store,request)=>{
     const out=await store.execute({key,request,signal});
     if(out._http===202||out._http>=500)throw fail('AB_V2_UNCONFIRMED');
     if(out._http===401||out._http===403)throw fail(out._body.error);
     if(out._http>=400)return {status:[409,422].includes(out._http)?out._http:409,body:{error:'AB_V2_'+out._body.error}};
     return out._body;
    };
    const options={transaction:sameTransaction,timeoutMs};
    if(action==='prepare'){
     const store=P.createAudiencePrepare(options),checked=await nested(store,{acao:P.ACTIONS.inspect,brand:p.brand,protocol:payload});
     if(checked.status)result=checked;
     else{const saved=await nested(store,{acao:P.ACTIONS.prepare,brand:p.brand,protocol:payload,intent:checked.intent,operation_id:p.operation_id});result=saved.status?saved:{status:200,body:{experiment:saved.experiment}};}
    }else if(action==='cancel'||action==='close'){
     const scoped=await snap(payload.test_id);
     if(!scoped)result={status:409,body:{error:'AB_V2_NOT_FOUND'}};
     else{const experiment=(await tx.query(SQL.lifecycle,[payload.test_id,payload.expected_version,action,who.actor])).rows[0]?.experiment;
      result=experiment?._error?{status:409,body:{error:experiment._error}}:{status:200,body:{experiment}};}
    }else{
     const scope=(await tx.query(SQL.scope,[payload.test_id,p.brand])).rows[0];
     if(!scope||scope.version!==payload.expected_version)result={status:409,body:{error:'AB_V2_VERSION'}};
     else{
      const admission=A.createABRegularAdmission(options);let row,answer;
      if(action==='review'){
       const reviewed=await nested(R.createAudienceReview(options),{acao:R.ACTIONS.review,brand:p.brand,test_id:payload.test_id,expected_version:payload.expected_version,expected_scope_hash:scope.scope_hash,operation_id:p.operation_id});
       if(reviewed.status)result=reviewed;
       else{answer=await nested(admission,{acao:A.ACTIONS.prepare,brand:p.brand,test_id:payload.test_id,expected_version:payload.expected_version,expected_scope_hash:scope.scope_hash,audience_review_id:reviewed.review.review_id});
        if(answer.status)result=answer;else row=(await tx.query(SQL.review,[answer.review.admission_review_id,who.actor,p.brand])).rows[0];}
      }else{
       row=(await tx.query(SQL.review,[payload.review_id,who.actor,p.brand])).rows[0];
       if(!row||row.test_id!==payload.test_id||row.experiment_version!==payload.expected_version)result={status:409,body:{error:'AB_V2_REVIEW_EXPIRED'}};
       else{answer=await nested(admission,{acao:A.ACTIONS.schedule,brand:p.brand,test_id:payload.test_id,expected_version:payload.expected_version,expected_scope_hash:scope.scope_hash,audience_review_id:row.audience_review_id,admission_review_id:row.id,confirm:'agendar_duas',idempotency_key:p.operation_id});if(answer.status)result=answer;}
      }
      if(!result)result={status:200,body:{experiment:await snap(payload.test_id),review:publicReview(row)}};
     }
    }
   }
   await reauth(cap);if(!result||!result.body)throw fail('AB_V2_UNCONFIRMED');
   await tx.query(SQL.save,[who.actor,p.operation_id,p.brand,action,JSON.stringify(payload),H.digest(payload),JSON.stringify(result)]);await reauth(cap);
   return response(result.status,result.body);
  },{signal,readOnly:false,isolation:'read committed'});}catch(e){
   if(e.code==='SEGMENT_UNAUTHORIZED')return response(401,{error:e.code});
   if(e.code==='SEGMENT_ACCESS_DENIED')return response(403,{error:e.code});
   return response(writing?202:503,{error:'AB_V2_UNCONFIRMED',...(writing?{operation_id:p.operation_id,state:'unconfirmed',automatic_retry:false}:{})});
  }
 }};
}
module.exports={SQL,parse,publicReview,createABPanelAPI};
