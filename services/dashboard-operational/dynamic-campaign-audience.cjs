'use strict';
const crypto=require('node:crypto');
const fail=(code,status=409)=>{throw Object.assign(Error(code),{code,status});};
const sha=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key=value=>{const h=sha(value);return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};
function create({paidFacts,database,authorize,sourceRevision,now=Date.now}){
 if(!/^[a-f0-9]{40}$/.test(sourceRevision||''))fail('PAID_QUEUE_REVISION_REQUIRED',503);
 const bindingOf=c=>c?.attribs?.shrigma?.audience_binding;
 const supported=c=>bindingOf(c)?.source==='paid';
 function user(context,brand,write=false){return authorize(context,brand,write);}
 function bind(context,brand,selection){
  if(typeof selection!=='string'||!selection.startsWith('purchase:'))return null;user(context,brand,true);
  return paidFacts.savedDefinition(context,brand,selection.slice(9),true);
 }
 function validate(context,brand,campaign){
  user(context,brand,true);const b=bindingOf(campaign);if(!b||b.source!=='paid')fail('PAID_CAMPAIGN_BINDING_REQUIRED');
  const current=paidFacts.savedDefinition(context,brand,b.id,true);
  if(current.definitionHash!==b.definitionHash||current.revision!==b.revision||current.baseListId!==b.baseListId||campaign.definition.list_ids.length!==1||campaign.definition.list_ids[0]!==b.baseListId)fail('PAID_PUBLIC_VERSION_CHANGED');
  return current;
 }
 function admitted(context,brand){try{user(context,brand);return true;}catch(e){if(e.status===403)return false;throw e;}}
 const campaignKey=(u,brand,id)=>key(['dynamic-email-v1',brand,id]);
 const contentHash=c=>sha({version:c.version,definition:c.definition,headers:c.headers,media:c.media,content_type:c.content_type,type:c.type,messenger:c.messenger});
 const summary=r=>({count:r.count,recipientHash:r.recipientHash,checkedAt:r.checkedAt,sourceUpdatedAt:r.coverage.until});
 async function row(context,brand,campaign){const u=user(context,brand);return database('producer',async c=>(await c.query("SELECT * FROM crm_worker.campaigns_v1 WHERE id=$1 AND brand=$2 AND definition->>'channel'='email'",[campaignKey(u,brand,campaign.id),brand])).rows[0],false);}
 async function decorateMany(context,brand,campaigns){
  const ids=campaigns.filter(supported).map(c=>String(c.id));if(!ids.length)return campaigns;
  if(!admitted(context,brand))return campaigns.map(c=>supported(c)?{...c,schedule_mode:'internal_dynamic',workerEnabled:false,restricted:true}:c);
  const records=await database('producer',async c=>(await c.query("SELECT c.definition,c.state,t.id resolution_id,t.payload->'resolution' resolution,t.updated_at resolved_at FROM crm_worker.campaigns_v1 c LEFT JOIN LATERAL (SELECT id,payload,updated_at FROM crm_worker.tasks_v1 WHERE campaign_id=c.id AND campaign_revision=c.revision AND source_revision=c.source_revision AND kind='audience.resolve' AND state='accepted' ORDER BY updated_at DESC LIMIT 1) t ON true WHERE c.brand=$1 AND c.definition->>'channel'='email' AND c.definition->>'nativeCampaignId'=ANY($2::text[])",[brand,ids])).rows,false);
  return campaigns.map(c=>{if(!supported(c))return c;const r=records.find(r=>r.definition.nativeCampaignId===c.id);return {...c,schedule_mode:'internal_dynamic',workerEnabled:false,...(r?.state==='scheduled'?{native_status:c.status,status:'scheduled',dynamic_schedule:r.definition.scheduleSummary}:{}),...(r?.resolution?{dynamic_resolution:{taskId:r.resolution_id,...r.resolution,recordedAt:new Date(r.resolved_at).toISOString()}}:{})};});
 }
 async function decorate(context,brand,campaign){return (await decorateMany(context,brand,[campaign]))[0];}
 async function assertEditable(context,brand,campaign){if(supported(campaign)&&(await row(context,brand,campaign))?.state==='scheduled')fail('PAID_CAMPAIGN_CANCEL_BEFORE_EDIT');}
 async function schedule(context,brand,campaign,sendAt){
  const u=user(context,brand,true),b=validate(context,brand,campaign);
  if(campaign.status!=='draft'||campaign.sent!==0||campaign.started_at)fail('PAID_CAMPAIGN_DRAFT_REQUIRED');
  if(!Number.isFinite(Date.parse(sendAt))||Date.parse(sendAt)<now()+20*60000||Date.parse(sendAt)>now()+7*86400000)fail('PAID_CAMPAIGN_DATE_INVALID',400);
  const r=await paidFacts.resolveSaved(context,brand,b.id,{workspace:true,forceRefresh:true});validate(context,brand,campaign);if(r.count<1)fail('PAID_CAMPAIGN_AUDIENCE_EMPTY');
  const id=campaignKey(u,brand,campaign.id),taskId=crypto.randomUUID();
  await database('producer',async c=>{
   await c.query("INSERT INTO crm_worker.campaigns_v1(id,brand,owner_id,revision,name,definition,state,source_revision) VALUES($1,$2,$3,1,$4,$5::jsonb,'draft',$6) ON CONFLICT(id) DO NOTHING",[id,brand,'dynamic-email:'+u.id,campaign.definition.name,JSON.stringify({channel:'email',nativeCampaignId:campaign.id,binding:b,createdBy:u.id}),sourceRevision]);
   const head=(await c.query('SELECT * FROM crm_worker.campaigns_v1 WHERE id=$1 AND brand=$2 FOR UPDATE',[id,brand])).rows[0];if(!head||head.state==='scheduled')fail('PAID_CAMPAIGN_ALREADY_QUEUED');
   const identity=sha(['dynamic-email-schedule-v1',brand,campaign.id,head.revision+1,b.revision,b.definitionHash,sendAt]);
   if((await c.query('SELECT 1 FROM crm_worker.tasks_v1 WHERE identity=$1',[identity])).rowCount)fail('PAID_CAMPAIGN_ALREADY_QUEUED');
   const definition={channel:'email',nativeCampaignId:campaign.id,binding:b,sendAt,nativeCampaignVersion:campaign.version,nativeContentHash:contentHash(campaign),scheduleSummary:summary(r)};
   await c.query("UPDATE crm_worker.campaigns_v1 SET revision=revision+1,definition=$2::jsonb,state='scheduled',source_revision=$3,updated_at=clock_timestamp() WHERE id=$1",[id,JSON.stringify(definition),sourceRevision]);
   await c.query("INSERT INTO crm_worker.tasks_v1(id,campaign_id,brand,owner_id,kind,identity,source_revision,campaign_revision,payload,state,run_at) VALUES($1,$2,$3,$4,'email.schedule',$5,$6,$7,$8::jsonb,'pending',$9)",[taskId,id,brand,head.owner_id,identity,sourceRevision,head.revision+1,JSON.stringify({channel:'email',nativeCampaignId:campaign.id,binding:b,nativeCampaignVersion:campaign.version,nativeContentHash:contentHash(campaign),countAtSchedule:summary(r),executionEnabled:false,scheduledBy:u.id}),sendAt]);
  });
  return {campaign:await decorate(context,brand,campaign),dynamicSchedule:{taskId,...summary(r),workerEnabled:false,nativeStatus:'draft'}};
 }
 async function cancel(context,brand,campaign){
  const u=user(context,brand,true),id=campaignKey(u,brand,campaign.id);
  await database('producer',async c=>{const r=(await c.query('SELECT * FROM crm_worker.campaigns_v1 WHERE id=$1 AND brand=$2 FOR UPDATE',[id,brand])).rows[0];if(!r||r.definition.channel!=='email')fail('PAID_CAMPAIGN_NOT_QUEUED',404);
   if((await c.query("SELECT 1 FROM crm_worker.tasks_v1 WHERE campaign_id=$1 AND state IN ('sending','uncertain')",[id])).rowCount)fail('PAID_CAMPAIGN_RECONCILIATION_REQUIRED');
   await c.query("UPDATE crm_worker.tasks_v1 SET state='cancelled',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE campaign_id=$1 AND state IN ('pending','leased')",[id]);await c.query("UPDATE crm_worker.attempts_v1 a SET state='cancelled',finished_at=clock_timestamp() FROM crm_worker.tasks_v1 t WHERE a.task_id=t.id AND a.attempt=t.attempt AND t.campaign_id=$1 AND t.state='cancelled' AND a.state='leased'",[id]);await c.query("UPDATE crm_worker.campaigns_v1 SET state='cancelled',updated_at=clock_timestamp() WHERE id=$1",[id]);
  });return {workerEnabled:false};
 }
 async function resolveQa(context,brand,campaign){
  const u=user(context,brand,true),b=validate(context,brand,campaign),id=campaignKey(u,brand,campaign.id),taskId=crypto.randomUUID(),token=crypto.randomUUID();
  const previous=await row(context,brand,campaign);if(!previous||previous.state!=='scheduled'||previous.source_revision!==sourceRevision)fail('PAID_CAMPAIGN_QUEUE_UNAVAILABLE');if(previous.definition.nativeCampaignVersion!==campaign.version||previous.definition.nativeContentHash!==contentHash(campaign))fail('PAID_CAMPAIGN_CONTENT_CHANGED');
  const receipt=await database('producer',async c=>(await c.query("SELECT id,payload FROM crm_worker.tasks_v1 WHERE campaign_id=$1 AND campaign_revision=$2 AND source_revision=$3 AND kind='audience.resolve' AND state='accepted' ORDER BY updated_at DESC LIMIT 1",[id,previous.revision,sourceRevision])).rows[0],false);
  if(receipt?.payload?.resolution)return {brand,campaignId:campaign.id,taskId:receipt.id,resolution:receipt.payload.resolution,deduplicated:true,workerEnabled:false,customerSends:0,effects:false};
  await paidFacts.freshSource(context,brand,b.definition.days,true,true);validate(context,brand,campaign);
  const held=await database('executor',async c=>{const head=(await c.query("SELECT * FROM crm_worker.campaigns_v1 WHERE id=$1 AND brand=$2 AND state='scheduled' FOR UPDATE SKIP LOCKED",[id,brand])).rows[0];if(!head||head.source_revision!==sourceRevision)fail('PAID_CAMPAIGN_QUEUE_UNAVAILABLE');if(head.definition.nativeCampaignVersion!==campaign.version||head.definition.nativeContentHash!==contentHash(campaign))fail('PAID_CAMPAIGN_CONTENT_CHANGED');
   const identity=sha(['audience-resolution-qa',brand,campaign.id,head.revision,sourceRevision]);
   let t=(await c.query("INSERT INTO crm_worker.tasks_v1(id,campaign_id,brand,owner_id,kind,identity,source_revision,campaign_revision,payload,state,run_at,lease_token,lease_until,attempt) VALUES($1,$2,$3,$4,'audience.resolve',$5,$6,$7,$8::jsonb,'leased',clock_timestamp(),$9,clock_timestamp()+interval '90 seconds',1) ON CONFLICT(identity) DO NOTHING RETURNING *",[taskId,id,brand,head.owner_id,identity,sourceRevision,head.revision,JSON.stringify({binding:b,effects:false,resolvedBy:u.id}),token])).rows[0];
   if(!t){const existing=(await c.query('SELECT *,lease_until<clock_timestamp() lease_expired FROM crm_worker.tasks_v1 WHERE identity=$1 FOR UPDATE',[identity])).rows[0];if(existing?.state==='accepted'&&existing.payload?.resolution)return {replay:true,id:existing.id,resolution:existing.payload.resolution};if(existing?.state!=='leased'||existing.lease_expired!==true)fail('PAID_CAMPAIGN_RESOLUTION_RECONCILE');
    // Resolution has no external effects: an expired possession may be reclaimed in the same generation.
    await c.query("UPDATE crm_worker.attempts_v1 SET state='refused',safe_code='RESOLUTION_LEASE_EXPIRED',finished_at=clock_timestamp() WHERE task_id=$1 AND attempt=$2 AND state='leased'",[existing.id,existing.attempt]);
    t=(await c.query("UPDATE crm_worker.tasks_v1 SET lease_token=$2,lease_until=clock_timestamp()+interval '90 seconds',attempt=attempt+1,updated_at=clock_timestamp() WHERE id=$1 AND state='leased' AND lease_until<clock_timestamp() RETURNING *",[existing.id,token])).rows[0];if(!t)fail('PAID_CAMPAIGN_RESOLUTION_RECONCILE');}
   await c.query("INSERT INTO crm_worker.attempts_v1(task_id,attempt,lease_token,source_revision,state) VALUES($1,$2,$3,$4,'leased')",[t.id,t.attempt,token,sourceRevision]);return t;
  });
  if(held.replay)return {brand,campaignId:campaign.id,taskId:held.id,resolution:held.resolution,deduplicated:true,workerEnabled:false,customerSends:0,effects:false};
  let result,error;try{const r=await paidFacts.resolveSaved(context,brand,b.id,{workspace:true,refresh:false});validate(context,brand,campaign);result=summary(r);}catch(e){error=e;}
  const state=error?'refused':'accepted',code=error?'PAID_CAMPAIGN_RESOLUTION_UNCONFIRMED':null;
  await database('executor',async c=>{const r=await c.query("UPDATE crm_worker.tasks_v1 SET state=$3,payload=payload||$4::jsonb,safe_code=$5,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND state='leased' AND lease_until>clock_timestamp() RETURNING id",[held.id,token,state,JSON.stringify({resolution:result||null,effects:false}),code]);if(r.rowCount!==1)fail('PAID_CAMPAIGN_RESOLUTION_RECONCILE');await c.query('UPDATE crm_worker.attempts_v1 SET state=$3,safe_code=$4,finished_at=clock_timestamp() WHERE task_id=$1 AND lease_token=$2',[held.id,token,state,code]);});
  if(error)throw error;return {brand,campaignId:campaign.id,taskId:held.id,resolution:result,workerEnabled:false,customerSends:0,effects:false};
 }
 return Object.freeze({bind,admitted,supported,validate,decorate,decorateMany,assertEditable,schedule,cancel,resolveQa});
}
module.exports={create};
