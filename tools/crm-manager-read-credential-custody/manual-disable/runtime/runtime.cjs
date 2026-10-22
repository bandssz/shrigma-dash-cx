'use strict';
// Inert private proposal: factory only, no env/client/socket/timer on import.
const A=require('./activation.cjs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_SQL="SELECT current_database()='listmonk' AS database_ok,session_user='postgres' AND current_user=session_user AS actor_ok,current_setting('server_version_num')::int/10000=17 AS version_ok,inet_server_port()=5432 AS port_ok,current_setting('ssl')='off' AND coalesce((SELECT NOT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),false) AS tls_off,current_setting('transaction_timeout')='500ms' AS budget_ok,pg_backend_pid() AS pid,(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS backend_start";
const PRIOR_SQL='SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND backend_start::text=$2) AS absent';
const MATCH_SQL="SELECT coalesce((SELECT rolpassword=current_setting('shrigma.read.scram',true) FROM pg_authid WHERE rolname='crm_manager_provisioner'),false) AS matched";
const MATCH_GUARD="DO $binding$ BEGIN IF (SELECT rolpassword=current_setting('shrigma.read.scram',true) FROM pg_authid WHERE rolname='crm_manager_provisioner') IS DISTINCT FROM true THEN RAISE EXCEPTION USING MESSAGE='READ_ACTIVATION_REVIEW_REFUSED'; END IF; END $binding$;";
const LEASE_SQL='SELECT pg_try_advisory_xact_lock(1609296685,1) AS acquired';
function refuse(){throw Error('READ_ACTIVATION_RUNTIME_REFUSED');}
function exact(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))refuse();}
function intent(value){
 exact(value,['schema','operationId','credentialIntentId','action','fromPhase']);
 if(value.schema!=='crm-manager-read-runtime-intent-v1'||!UUID.test(value.operationId)||!UUID.test(value.credentialIntentId)||!['stage','activate','disable'].includes(value.action)||value.fromPhase!==(value.action==='stage'?'empty':value.action==='activate'?'staged':value.fromPhase)||value.action==='disable'&&!['staged','active'].includes(value.fromPhase))refuse();
 return Object.freeze({...value});
}
function session(r){
 const row=r?.rows?.[0];exact(row,['database_ok','actor_ok','version_ok','port_ok','tls_off','budget_ok','pid','backend_start']);
 if(r.rows.length!==1||['database_ok','actor_ok','version_ok','port_ok','tls_off','budget_ok'].some(k=>row[k]!==true)||!Number.isSafeInteger(row.pid)||row.pid<1||row.pid>2147483647||typeof row.backend_start!=='string'||row.backend_start.length>80||!/^\d{4}-\d\d-\d\d [\d:.]+[+-]\d\d(?::\d\d)?$/.test(row.backend_start))refuse();
 return Object.freeze({pid:row.pid,backendStart:row.backend_start});
}
function one(r,key){return r?.rows?.length===1&&Object.keys(r.rows[0]).length===1&&r.rows[0][key]===true;}
function envelope(i,state,phase=null,commitAck=false){return Object.freeze({schema:'crm-manager-read-runtime-result-v1',action:i.action,state,phase,coreVerified:phase!==null,credentialBound:i.action!=='disable'&&phase!==null&&['staged','active'].includes(phase),commitAck});}
function plan(i){return A.buildPlan(i.action,i.action==='disable'?{fromPhase:i.fromPhase}:{});}
function flatten(result){return (Array.isArray(result)?result:[result]).flatMap(r=>Array.isArray(r?.rows)?r.rows:[]);}
function createRuntime({connect,journal}){
 if(typeof connect!=='function'||!journal||['create','append','load','readDurable'].some(k=>typeof journal[k]!=='function'))refuse();
 let busy=false;
 async function lock(fn){if(busy)refuse();busy=true;try{return await fn();}finally{busy=false;}}
 async function close(db){try{await db?.end();}catch{}}
 async function identity(db){await db.query("SET transaction_timeout='500ms'");return session(await db.query(SESSION_SQL));}
 async function observe(db,p,{verifier,prior}={}){
  await identity(db);await db.query(p.readOnlyBegin.text);
  try{
   await db.query(p.commands[2].text);
   const policy=A.admitPolicy((await db.query(p.policyQuery.text))?.rows?.[0]?.policy);if(policy.phase!=='supported')refuse();
   if(prior&&!one(await db.query(PRIOR_SQL,[prior.pid,prior.backendStart]),'absent'))refuse();
   if(!one(await db.query(LEASE_SQL),'acquired'))refuse();
   await db.query(p.scopeQuery.text,p.scopeQuery.values);
   const rows=flatten(await db.query(p.readback.text));if(rows.length!==3)refuse();
   let matched=false;
   if(verifier!==undefined){const q=A.passwordQuery(verifier);if(!one(await db.query(q.text,q.values),'accepted'))refuse();matched=one(await db.query(MATCH_SQL),'matched');}
   return {snapshot:{profileSha256:rows[0].profile_sha256,objects:rows[1],state:rows[2].state},matched};
  }finally{try{await db.query('ROLLBACK');}catch{}}
 }
 async function execute(value,{verifier}={}){return lock(async()=>{
  const i=intent(value),p=plan(i);if(['stage','activate'].includes(i.action))A.validateVerifier(verifier);else if(verifier!==undefined)refuse();
  // Exclusive creation + fsync precedes all PG I/O. Existing intent is NEVER executed again.
  try{journal.create(i);}catch{refuse();}let db,dispatched=false,acked=false;
  try{
   db=await connect();const before=await observe(db,p,{verifier:i.action==='activate'?verifier:undefined});
   A.admitSnapshot(before.snapshot,p.before);if(i.action==='activate'&&!before.matched)refuse();
   const backend=await identity(db);
   // No filesystem I/O inside the bounded PG transaction: fence before BEGIN.
   journal.append(i.operationId,{kind:'dispatch',backend});dispatched=true;
   // Every same-transaction guard executes after the durable fence.
   for(const q of p.commands)await db.query(q.text,q.values);
   if(A.admitPolicy((await db.query(p.policyQuery.text))?.rows?.[0]?.policy).phase!=='supported')refuse();
   if(i.action!=='disable'){
    const q=A.passwordQuery(verifier);if(!one(await db.query(q.text,q.values),'accepted'))refuse();
    if(i.action==='activate')await db.query(MATCH_GUARD);
   }
   await db.query(p.mutating.text);const ack=await db.query(p.commit.text);
   if(ack?.command!=='COMMIT')refuse();
   // ACK persistence failure keeps a durable dispatch and requires READ ONLY reconciliation.
   journal.append(i.operationId,{kind:'commit_ack'});
   acked=true;
   await close(db);db=null;
   const result=await reconcileInner(i,{verifier});return result;
  }catch{
   return envelope(i,dispatched?'outcome_unknown':'not_dispatched',null,acked);
  }finally{await close(db);}
 });}
 async function reconcileInner(i,{verifier}={}){
  let history;try{history=journal.readDurable(i.operationId);}catch{return envelope(i,'outcome_unknown');}if(JSON.stringify(history.intent)!==JSON.stringify(i))refuse();
  if(['stage','activate'].includes(i.action))A.validateVerifier(verifier);else if(verifier!==undefined)refuse();
  const p=plan(i),dispatch=history.events.find(e=>e.kind==='dispatch');let db;
  try{
   db=await connect();const observed=await observe(db,p,{verifier:i.action==='disable'?undefined:verifier,prior:dispatch?.backend});
   let phase=null;for(const candidate of [p.after,p.before]){try{A.admitSnapshot(observed.snapshot,candidate);phase=candidate;break;}catch{}}
   if(!phase||i.action!=='disable'&&['staged','active'].includes(phase)&&!observed.matched)return envelope(i,'outcome_unknown');
   const state=phase===p.after?'confirmed':dispatch?'before_verified':'not_dispatched';
   // Proven state only; never claim an ACK that was not persisted.
   const commitAck=history.events.some(e=>e.kind==='commit_ack');
   journal.append(i.operationId,{kind:'readback',state,phase});return envelope(i,state,phase,commitAck);
  }catch{return envelope(i,'outcome_unknown');}finally{await close(db);}
 }
 async function reconcile(value,options={}){return lock(()=>reconcileInner(intent(value),options));}
 return Object.freeze({execute,reconcile});
}
module.exports=Object.freeze({createRuntime,intent,SESSION_SQL,PRIOR_SQL,MATCH_SQL,MATCH_GUARD,LEASE_SQL});
