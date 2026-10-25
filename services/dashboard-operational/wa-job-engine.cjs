'use strict';
const crypto=require('node:crypto'),INTERNAL='5541999060777';
const fail=code=>{throw Object.assign(Error(code),{code});},hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function create({database,authorizeTask,connection,sourceRevision,enabled=false}={}){
 if(typeof enabled!=='boolean'||!/^[a-f0-9]{40}$/.test(sourceRevision||''))fail('WA_JOB_CONFIGURATION_INVALID');
 const wired=[database,authorizeTask,connection].every(x=>typeof x==='function');if(enabled&&!wired)fail('WA_JOB_CONFIGURATION_INVALID');
 let accepting=true,active=null;
 const authority=task=>{const a=authorizeTask(task);if(!a||a.userId!==task.owner_id||typeof a.ownerId!=='string'||!a.ownerId||!/^[a-f0-9]{64}$/.test(a.revision||''))fail('WA_JOB_AUTHORITY_REFUSED');return {userId:a.userId,ownerId:a.ownerId,revision:a.revision};};
 const checkAuthority=(held,before)=>{const next=authority(held);if(hash(next)!==hash(before))fail('WA_JOB_AUTHORITY_CHANGED');return next;};
 async function heldRow(c,held){
  const row=(await c.query("SELECT t.*,c.state campaign_state,c.source_revision head_source,c.revision head_revision,p.state parent_state FROM crm_worker.tasks_v1 t JOIN crm_worker.campaigns_v1 c ON c.id=t.campaign_id LEFT JOIN crm_worker.tasks_v1 p ON p.id=t.parent_id WHERE t.id=$1 AND t.lease_token=$2 AND t.attempt=$3 AND t.source_revision=$4 AND t.state='leased' AND t.lease_until>clock_timestamp() FOR UPDATE OF t,c",[held.id,held.lease_token,held.attempt,sourceRevision])).rows[0];
  if(!row||row.campaign_state!=='scheduled'||row.head_source!==sourceRevision||row.head_revision!==held.campaign_revision||row.brand!==held.brand||row.owner_id!==held.owner_id||hash(row.payload)!==hash(held.payload)||row.kind==='wa.message'&&row.parent_state!=='accepted')fail('WA_JOB_FENCE_REFUSED');
  if(!(await c.query("SELECT 1 FROM crm_worker.tasks_v1 WHERE campaign_id=$1 AND campaign_revision=$2 AND brand=$3 AND owner_id=$4 AND kind='wa.test' AND state='accepted'",[held.campaign_id,held.campaign_revision,held.brand,held.owner_id])).rowCount)fail('WA_JOB_TEST_REQUIRED');return row;
 }
 async function finish(held,state,providerId=null,safeCode=null){
  try{return await database('executor',async c=>{const changed=await c.query("UPDATE crm_worker.tasks_v1 SET state=$5,provider_id=$6,safe_code=$7,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND attempt=$3 AND source_revision=$4 AND state IN ('leased','sending') RETURNING id",[held.id,held.lease_token,held.attempt,sourceRevision,state,providerId,safeCode]);if(changed.rowCount!==1)fail('WA_JOB_RECONCILIATION_REQUIRED');const attempt=await c.query("UPDATE crm_worker.attempts_v1 SET state=$5,provider_id=$6,safe_code=$7,finished_at=clock_timestamp() WHERE task_id=$1 AND lease_token=$2 AND attempt=$3 AND source_revision=$4 AND state IN ('leased','sending')",[held.id,held.lease_token,held.attempt,sourceRevision,state,providerId,safeCode]);if(attempt.rowCount!==1)fail('WA_JOB_RECONCILIATION_REQUIRED');return {ok:true,taskId:held.id,kind:held.kind,state,providerId,customerSends:0};});}catch{return {ok:false,taskId:held.id,kind:held.kind,state:'reconcile',code:'WA_JOB_RECONCILIATION_REQUIRED',customerSends:0};}
 }
 async function claim(){return database('executor',async c=>{
  // Expired effect attempts remain uncertain. No reclaim or automatic replay.
  const expired=await c.query("UPDATE crm_worker.tasks_v1 SET state='uncertain',safe_code='WA_JOB_LEASE_EXPIRED',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE kind IN ('wa.schedule','wa.message') AND source_revision=$1 AND state IN ('leased','sending') AND lease_until<=clock_timestamp() RETURNING id,attempt",[sourceRevision]);
  for(const row of expired.rows)await c.query("UPDATE crm_worker.attempts_v1 SET state='uncertain',safe_code='WA_JOB_LEASE_EXPIRED',finished_at=clock_timestamp() WHERE task_id=$1 AND attempt=$2 AND state IN ('leased','sending')",[row.id,row.attempt]);
  const row=(await c.query("SELECT t.* FROM crm_worker.tasks_v1 t JOIN crm_worker.campaigns_v1 c ON c.id=t.campaign_id LEFT JOIN crm_worker.tasks_v1 p ON p.id=t.parent_id WHERE t.kind IN ('wa.schedule','wa.message') AND t.state='pending' AND t.run_at<=clock_timestamp() AND t.source_revision=$1 AND c.source_revision=t.source_revision AND c.revision=t.campaign_revision AND c.brand=t.brand AND c.owner_id=t.owner_id AND c.state='scheduled' AND (t.kind='wa.schedule' OR p.kind='wa.schedule' AND p.state='accepted' AND p.source_revision=t.source_revision AND p.campaign_revision=t.campaign_revision AND p.brand=t.brand AND p.owner_id=t.owner_id) ORDER BY t.run_at,t.id LIMIT 1 FOR UPDATE OF t,c SKIP LOCKED",[sourceRevision])).rows[0];if(!row)return null;
  const token=crypto.randomUUID(),held=(await c.query("UPDATE crm_worker.tasks_v1 SET state='leased',lease_token=$2,lease_until=clock_timestamp()+interval '90 seconds',attempt=attempt+1,updated_at=clock_timestamp() WHERE id=$1 AND state='pending' RETURNING *",[row.id,token])).rows[0];if(!held)fail('WA_JOB_CLAIM_REFUSED');await c.query("INSERT INTO crm_worker.attempts_v1(task_id,attempt,lease_token,source_revision,state) VALUES($1,$2,$3,$4,'leased')",[held.id,held.attempt,token,sourceRevision]);return held;
 });}
 async function execute(){
  const held=await claim();if(!held)return {ok:true,idle:true,customerSends:0};let started=false;
  try{
   const before=authority(held);
   if(held.kind==='wa.schedule'){
    if(!Array.isArray(held.payload.recipients)||!held.payload.recipients.length||held.payload.recipients.some(x=>x.telefone!==INTERNAL))fail('WA_JOB_INTERNAL_ONLY');
    await database('executor',async c=>{await heldRow(c,held);checkAuthority(held,before);});return finish(held,'accepted',null,'WA_SCHEDULE_RELEASED');
   }
   if(held.payload.recipient?.telefone!==INTERNAL||held.payload.audienceSnapshotTaskId!==held.parent_id)fail('WA_JOB_INTERNAL_ONLY');
   const beforePost=async()=>{checkAuthority(held,before);await database('executor',async c=>{await heldRow(c,held);checkAuthority(held,before);const task=await c.query("UPDATE crm_worker.tasks_v1 SET state='sending',updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND attempt=$3 AND source_revision=$4 AND state='leased' AND lease_until>clock_timestamp() RETURNING id",[held.id,held.lease_token,held.attempt,sourceRevision]);if(task.rowCount!==1)fail('WA_JOB_FENCE_REFUSED');const attempt=await c.query("UPDATE crm_worker.attempts_v1 SET state='sending' WHERE task_id=$1 AND lease_token=$2 AND attempt=$3 AND source_revision=$4 AND state='leased'",[held.id,held.lease_token,held.attempt,sourceRevision]);if(attempt.rowCount!==1)fail('WA_JOB_FENCE_REFUSED');});started=true;};
   // The native private adapter must await this hook after its sender GET.
   const conn=connection({task:held,authority:before,beforePost});if(conn?.beforePostEnforced!==true||typeof conn.sendInternal!=='function'||conn.connectionRef!==held.payload.connectionRef||conn.revision!==held.payload.connectionRevision)fail('WA_JOB_CONNECTION_REFUSED');
   const result=await conn.sendInternal({sender:held.payload.sender,template:held.payload.message});if(!started||typeof result?.providerId!=='string'||!/^wamid\.[A-Za-z0-9+/_=-]{1,500}$/.test(result.providerId))fail('WA_JOB_PROVIDER_RECEIPT_UNCONFIRMED');return finish(held,'accepted',result.providerId);
  }catch(error){const refused=error?.code==='WA_META_MESSAGE_REFUSED',state=started&&!refused?'uncertain':'refused',code=state==='uncertain'?'WA_JOB_RECONCILIATION_REQUIRED':/^(?:WA_[A-Z0-9_]{1,70})$/.test(error?.code||'')?error.code:'WA_JOB_UNAVAILABLE';return finish(held,state,null,code);}
 }
 return Object.freeze({status:()=>({schema:'wa-job-engine-prepared-v1',enabled,accepting,configured:wired,handlers:2,commercial:false,internalOnly:true,sourceRevision}),tick(){if(!enabled||!accepting)return Promise.resolve({ok:true,disabled:true,customerSends:0});if(active)return Promise.resolve({ok:true,busy:true,customerSends:0});active=execute().finally(()=>{active=null;});return active;},async stop(){accepting=false;if(active)await active;return {ok:true,accepting:false};}});
}
module.exports={create,INTERNAL};
