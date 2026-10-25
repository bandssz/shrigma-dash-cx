'use strict';
// Shopify reads share the admitted queue. No scheduler, memory lock or send path.
const crypto=require('node:crypto');
const fail=code=>{throw Object.assign(Error(code),{code,status:409});};
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuid=v=>{const h=hash(v);return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};
function create({database,sourceRevision,now=Date.now}){
 async function run({brand,days,authorize,work,publish}){
  if(typeof database!=='function'||!/^[a-f0-9]{40}$/.test(sourceRevision||''))fail('SOURCE_REFRESH_QUEUE_UNAVAILABLE');
  if(!['fish','aristo'].includes(brand)||!Number.isInteger(days)||days<1||days>365)fail('SOURCE_REFRESH_INPUT_INVALID');
  const requestedAt=new Date(now()).toISOString(),headId=uuid(['source.refresh',brand]),owner='source-refresh:'+brand,deadline=Date.now()+120000;
  async function project(task,result){
   return database('executor',async c=>{
    const head=(await c.query('SELECT revision FROM crm_worker.campaigns_v1 WHERE id=$1 FOR UPDATE',[headId])).rows[0];
    const row=(await c.query("SELECT id FROM crm_worker.tasks_v1 WHERE id=$1 AND source_revision=$2 AND campaign_revision=$3 AND state='accepted' FOR UPDATE",[task.id,sourceRevision,head?.revision])).rows[0];
    if(!row)fail('SOURCE_REFRESH_GENERATION_CHANGED');authorize();publish(result);return result;
   });
  }
  while(Date.now()<deadline){
   authorize();const token=crypto.randomUUID();
   const held=await database('producer',async c=>{
    await c.query("INSERT INTO crm_worker.campaigns_v1(id,brand,owner_id,revision,name,definition,state,source_revision) VALUES($1,$2,$3,1,'Shopify', $4::jsonb,'draft',$5) ON CONFLICT(id) DO NOTHING",[headId,brand,owner,JSON.stringify({channel:'source',operation:'source.refresh'}),sourceRevision]);
    const head=(await c.query('SELECT * FROM crm_worker.campaigns_v1 WHERE id=$1 FOR UPDATE SKIP LOCKED',[headId])).rows[0];if(!head)return null;
    if(head.brand!==brand||head.owner_id!==owner||head.definition?.channel!=='source'||head.definition?.operation!=='source.refresh')fail('SOURCE_REFRESH_HEAD_MISMATCH');
    // A locked task is executing, even if its uncommitted heartbeat is invisible.
    let last=(await c.query("SELECT id FROM crm_worker.tasks_v1 WHERE campaign_id=$1 ORDER BY campaign_revision DESC LIMIT 1",[headId])).rows[0];
    if(last){
     last=(await c.query('SELECT *,lease_until<=clock_timestamp() expired FROM crm_worker.tasks_v1 WHERE id=$1 FOR UPDATE SKIP LOCKED',[last.id])).rows[0];if(!last)return null;
     if(last.state==='leased'&&!last.expired)return null;
     if(last.state==='accepted'&&last.source_revision===sourceRevision&&last.payload.days>=days&&new Date(last.updated_at).toISOString()>=requestedAt&&last.payload.result)return {replay:true,id:last.id,result:last.payload.result};
     if(last.state==='leased'){
      await c.query("UPDATE crm_worker.attempts_v1 SET state='refused',safe_code='SOURCE_REFRESH_LEASE_EXPIRED',finished_at=clock_timestamp() WHERE task_id=$1 AND attempt=$2 AND state='leased'",[last.id,last.attempt]);
      if(last.source_revision===sourceRevision&&last.payload.days>=days){
       const t=(await c.query("UPDATE crm_worker.tasks_v1 SET lease_token=$2,lease_until=clock_timestamp()+interval '90 seconds',attempt=attempt+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",[last.id,token])).rows[0];
       await c.query("INSERT INTO crm_worker.attempts_v1(task_id,attempt,lease_token,source_revision,state) VALUES($1,$2,$3,$4,'leased')",[t.id,t.attempt,token,sourceRevision]);return t;
      }
      await c.query("UPDATE crm_worker.tasks_v1 SET state='refused',safe_code='SOURCE_REFRESH_REVISION_CHANGED',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1",[last.id]);
     }
    }
    const generation=head.revision+1,window={days,from:new Date(now()-days*86400000).toISOString(),until:new Date(now()).toISOString()},taskId=crypto.randomUUID();
    await c.query('UPDATE crm_worker.campaigns_v1 SET revision=$2,source_revision=$3,updated_at=clock_timestamp() WHERE id=$1',[headId,generation,sourceRevision]);
    const t=(await c.query("INSERT INTO crm_worker.tasks_v1(id,campaign_id,brand,owner_id,kind,identity,source_revision,campaign_revision,payload,state,run_at,lease_token,lease_until,attempt) VALUES($1,$2,$3,$4,'source.refresh',$5,$6,$7,$8::jsonb,'leased',clock_timestamp(),$9,clock_timestamp()+interval '90 seconds',1) RETURNING *",[taskId,headId,brand,owner,hash(['source.refresh',brand,generation,sourceRevision]),sourceRevision,generation,JSON.stringify({days,window,requestedAt}),token])).rows[0];
    await c.query("INSERT INTO crm_worker.attempts_v1(task_id,attempt,lease_token,source_revision,state) VALUES($1,1,$2,$3,'leased')",[taskId,token,sourceRevision]);return t;
   });
   if(!held){await new Promise(r=>setTimeout(r,250));continue;}if(held.replay)return project(held,held.result);
   const settled=await database('executor',async c=>{
    const task=(await c.query("SELECT * FROM crm_worker.tasks_v1 WHERE id=$1 AND lease_token=$2 AND source_revision=$3 AND state='leased' AND lease_until>clock_timestamp() FOR UPDATE SKIP LOCKED",[held.id,token,sourceRevision])).rows[0];if(!task)fail('SOURCE_REFRESH_POSSESSION_LOST');
    const guard=async()=>{authorize();const r=await c.query("UPDATE crm_worker.tasks_v1 SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=$1 AND lease_token=$2 AND source_revision=$3 AND state='leased' RETURNING id",[task.id,token,sourceRevision]);if(r.rowCount!==1)fail('SOURCE_REFRESH_POSSESSION_LOST');};
    let result,error;try{await guard();result=await work({window:task.payload.window,guard});await guard();}catch(e){error=e;}
    const state=error?'refused':'accepted',code=error?'SOURCE_REFRESH_UNCONFIRMED':null;
    await c.query("UPDATE crm_worker.tasks_v1 SET state=$3,payload=payload||$4::jsonb,safe_code=$5,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2",[task.id,token,state,JSON.stringify({result:result||null}),code]);
    await c.query('UPDATE crm_worker.attempts_v1 SET state=$3,safe_code=$4,finished_at=clock_timestamp() WHERE task_id=$1 AND lease_token=$2',[task.id,token,state,code]);
    return {result,error};
   });
   if(settled.error)throw settled.error;return project(held,settled.result);
  }
  fail('SOURCE_REFRESH_BUSY');
 }
 return Object.freeze({run});
}
module.exports={create};
