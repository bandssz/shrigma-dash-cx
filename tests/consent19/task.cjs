'use strict';
// Fixed task for the existing operational tick. No scheduler, queue, lease,
// claim or journal is created here. Adapters own original campaign admission,
// API16 custody and encrypted metadata on the existing CREATE record.
const crypto=require('node:crypto');
const INTERVAL_MS=600000;
const positive=n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647;
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s);
const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&Object.getPrototypeOf(o)===Object.prototype;
const hash=o=>crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const safe=e=>/^(CONSENT_[A-Z_]{1,70})$/.test(e?.code||'')?e.code:'CONSENT_PENDING';
function checkedPlan(p,record){
 if(!plain(p)||p.schema!=='crm-campaign-consent-job-plan-v1'||p.brand!==record.brand||!['aristo','fish'].includes(p.brand)||p.campaign_id!==record.campaignId||!positive(p.campaign_id)||!uuid(p.campaign_uuid)||!uuid(p.created_operation_id)||!plain(p.frozen)||!positive(p.frozen.id)||!uuid(p.frozen.uuid)||!['single','double'].includes(p.frozen.optin)||p.frozen.status!=='active'||!Array.isArray(p.origins)||!p.origins.length||p.origins.length>100||p.origins.some(x=>!plain(x)||!positive(x.id)||!uuid(x.uuid)||x.id===p.frozen.id)||new Set(p.origins.map(x=>x.id)).size!==p.origins.length||new Set(p.origins.map(x=>x.uuid)).size!==p.origins.length||typeof p.original_receipt_sha256!=='string'||!/^[a-f0-9]{64}$/.test(p.original_receipt_sha256)||!Array.isArray(p.member_ids)||p.member_ids.length>10000||p.member_ids.some(x=>!positive(x))||new Set(p.member_ids).size!==p.member_ids.length)fail('CONSENT_PLAN_UNCONFIRMED');
 return JSON.parse(JSON.stringify(p));
}
function checkedMember(m,p,id){
 if(!plain(m)||m.id!==id||!uuid(m.uuid)||m.frozen_id!==p.frozen.id||m.frozen_uuid!==p.frozen.uuid||!['confirmed','unconfirmed','unsubscribed','absent'].includes(m.frozen_status)||!Array.isArray(m.origins)||m.origins.length!==p.origins.length||new Set(m.origins.map(x=>x?.id)).size!==m.origins.length)fail('CONSENT_MEMBER_UNCONFIRMED');
 for(const o of p.origins){const r=m.origins.find(x=>x?.id===o.id);if(!r||r.uuid!==o.uuid||!['confirmed','unconfirmed','unsubscribed','absent'].includes(r.status))fail('CONSENT_MEMBER_UNCONFIRMED');}
 return m;
}
function createTask({store,source,now=Date.now,enabled=false}){
 if(!store||!source||!['list','prior','backup','confirm','pending'].every(k=>typeof store[k]==='function')||!['binding','plan','member','unsubscribe'].every(k=>typeof source[k]==='function')||typeof now!=='function')throw Error('CONSENT_TASK_CONFIG');
 let active=null,nextAt=0,closed=false;
 const guard=()=>{if(closed||enabled!==true)fail('CONSENT_TASK_DISABLED');};
 async function campaign(record,result){
  guard();const binding=await source.binding(record);guard();
  const plan=checkedPlan(await source.plan(record,binding),record);
  // Immutable scope comes from original source receipts, never browser lists.
  const scope=hash([plan.brand,plan.campaign_id,plan.campaign_uuid,plan.created_operation_id,plan.frozen,plan.origins,plan.original_receipt_sha256]);
  for(const id of plan.member_ids){
   guard();const before=checkedMember(await source.member(plan,id,binding),plan,id);
   // Deletion is not inferred to be an unsubscribe. It remains a pending edge.
   if(before.frozen_status==='absent'){result.pending++;continue;}
   if(before.frozen_status!=='unsubscribed')continue;
   for(const origin of before.origins){
    guard();const key=hash([scope,id,before.uuid,origin.id,origin.uuid]);
    if(origin.status==='absent')continue;
    if(origin.status==='unsubscribed'){
     // An earlier PUT can have succeeded with its response lost. Reconcile its
     // existing backup by the current GET; never issue another mutation.
     const prior=await store.prior(record,key);
     if(prior){if(prior.key!==key||prior.scope!==scope||prior.subscriberId!==id||prior.subscriberUuid!==before.uuid||prior.originId!==origin.id||prior.originUuid!==origin.uuid)fail('CONSENT_BACKUP_UNCONFIRMED');if(await store.confirm(record,{key,scope,confirmedAt:now(),status:'unsubscribed'})!==true)fail('CONSENT_RECORD_UNCONFIRMED');}
     continue;
    }
    // The store must commit authenticated backup metadata before this returns.
    // Repetition returns the original backup; it never replaces the before-image.
    const backup={schema:'crm-campaign-consent-backup-v1',key,scope,brand:plan.brand,campaignId:plan.campaign_id,campaignUuid:plan.campaign_uuid,frozenId:plan.frozen.id,frozenUuid:plan.frozen.uuid,subscriberId:id,subscriberUuid:before.uuid,originId:origin.id,originUuid:origin.uuid,beforeStatus:origin.status,plannedStatus:'unsubscribed',capturedAt:now(),returnPolicy:'disable-task-preserve-optouts'};
    if(await store.backup(record,backup)!==true)fail('CONSENT_BACKUP_UNCONFIRMED');
    guard();
    // Original source rechecks campaign/list/member ownership immediately before
    // its narrow PUT unsubscribe. No add/remove, status-global or opt-in action.
    await source.unsubscribe(plan,{id,uuid:before.uuid,originId:origin.id,originUuid:origin.uuid,expectedOriginStatus:origin.status},binding);
    guard();const after=checkedMember(await source.member(plan,id,binding),plan,id),confirmed=after.origins.find(x=>x.id===origin.id);
    if(after.uuid!==before.uuid||after.frozen_status!=='unsubscribed'||confirmed.status!=='unsubscribed')fail('CONSENT_EFFECT_UNCONFIRMED');
    if(await store.confirm(record,{key,scope,confirmedAt:now(),status:'unsubscribed'})!==true)fail('CONSENT_RECORD_UNCONFIRMED');
    result.changed++;
   }
  }
 }
 async function run(){
  const result={schema:'crm-campaign-consent-task-v1',campaigns:0,changed:0,pending:0,customerFieldsExported:false};
  guard();const records=await store.list();if(!Array.isArray(records)||records.length>1000)fail('CONSENT_CAMPAIGNS_UNCONFIRMED');
  for(const record of records){guard();try{if(!plain(record)||!['aristo','fish'].includes(record.brand)||!positive(record.campaignId))fail('CONSENT_CAMPAIGN_UNCONFIRMED');await campaign(record,result);result.campaigns++;}catch(e){if(closed)throw e;result.pending++;try{await store.pending(record,{code:safe(e),at:now()});}catch{/* A full/unconfirmed metadata row must not stop other admitted campaigns. */}}}
  return Object.freeze(result);
 }
 function tick(){
  if(closed||enabled!==true)return Promise.resolve(null);if(active)return active;
  const time=now();if(!Number.isSafeInteger(time)||time<0)return Promise.reject(Error('CONSENT_CLOCK_INVALID'));if(time<nextAt)return Promise.resolve(null);nextAt=time+INTERVAL_MS;
  active=run().finally(()=>{active=null;});return active;
 }
 function close(){closed=true;return active?.catch(()=>{})||Promise.resolve();}
 return Object.freeze({tick,close});
}
module.exports={createTask,checkedPlan,checkedMember,INTERVAL_MS};
