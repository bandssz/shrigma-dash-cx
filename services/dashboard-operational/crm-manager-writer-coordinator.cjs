'use strict';
// PRIVATE dormant proposal. Explicit one-operation invocation, bounded forward
// progress only. No retries/timers/env/HTTP; journal mutations are synchronous.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const {CAPS}=require('./crm-manager-writer-policy.cjs');
const OUTPUT=Object.freeze(Object.fromEntries(['ready','pending','expired','revoked'].map(s=>[s,Object.freeze({state:s})])));
function createWriterCoordinator(options){
 const keys=['journal','client','attest','now'];if(!options||Object.getPrototypeOf(options)!==Object.prototype||Reflect.ownKeys(options).length!==4||!keys.every(k=>Object.getOwnPropertyDescriptor(options,k)?.enumerable&&Object.hasOwn(Object.getOwnPropertyDescriptor(options,k),'value')))throw new Error('CRM_WRITER_BRIDGE_REFUSED');
 const {journal,client,attest,now}=options;
 if(!journal||!client||typeof attest!=='function'||typeof now!=='function')throw new Error('CRM_WRITER_BRIDGE_REFUSED');
 let active=null;
 const clock=()=>{const value=now();let promise=false;try{Promise.prototype.then.call(value,()=>{},()=>{});promise=true;}catch{}if(promise)throw new Error('CRM_WRITER_BRIDGE_REFUSED');if(value&&['object','function'].includes(typeof value)&&'then'in value){Promise.resolve(value).catch(()=>{});throw new Error('CRM_WRITER_BRIDGE_REFUSED');}if(!Number.isSafeInteger(value)||value<0||value>8640000000000000-1209600000)throw new Error('CRM_WRITER_BRIDGE_REFUSED');return value;};
 const same=(before,after)=>before.kind===after.kind&&before.phase===after.phase&&after.current;
 const result=s=>s.phase==='revoked'?OUTPUT.revoked:s.phase==='expired'?OUTPUT.expired:s.phase==='promoted'&&s.current?OUTPUT.ready:OUTPUT.pending;
 async function revoke(id){
  const s=journal.state(id);if(s.phase==='revoked')return OUTPUT.revoked;
  const q=journal.request(id),r=await client.status(q);
  if(journal.state(id).phase!=='revoke_pending')return result(journal.state(id));
  const proof=r.found?r.receipt:await client.revoke(q);
  if(journal.state(id).phase!=='revoke_pending')return result(journal.state(id));
  journal.confirmRevoked(id,proof);return OUTPUT.revoked;
 }
 async function compensate(id){return revoke(journal.compensate(id));}
 function afterAwait(expected,id){const actual=journal.state(id);if(same(expected,actual))return null;
  // A concurrent runner may have advanced this same durable operation. Never
  // compensate its healthy winner just because our ACK arrived later.
  const closed=['promoted','expired','revoked'].includes(actual.phase);
  return{outcome:!actual.current&&!closed?compensate(id):result(actual)};
 }
 async function drive(id){
  for(let n=0;n<8;n++){
   clock();const s=journal.state(id);
   if(s.kind==='revoke')return revoke(id); // Old lifecycle revokes survive reinvite.
   if(s.phase==='revoked'||s.phase==='expired')return result(s);
   // A historical promoted generation is closed: running it after a healthy
   // renewal must never tombstone the newer generation. Identity mutations
   // stageRevoke in their own SQLite transaction instead.
   if(s.phase==='promoted')return s.expiresAt<=clock()?OUTPUT.expired:result(s);
   if(!s.current)return compensate(id);
   if(s.phase==='queued'){
    const q=journal.beginPrepare(id),r=await client.prepare(q);
    {const changed=afterAwait({...s,phase:'prepare_uncertain'},id);if(changed)return changed.outcome;}
    journal.recordPrepared(id,r);
   }else if(s.phase==='prepare_uncertain'){
    const q=journal.request(id),r=await client.status(q);
    {const changed=afterAwait(s,id);if(changed)return changed.outcome;}
    if(r.found)journal.recordPrepared(id,r.receipt);
    else{journal.beginPrepare(id);const receipt=await client.prepare(q);{const changed=afterAwait(s,id);if(changed)return changed.outcome;}journal.recordPrepared(id,receipt);}
   }else if(s.phase==='prepared'){
    if(s.candidateExpiresAt<=clock()){journal.expire(id);return OUTPUT.expired;}
    journal.beginCommit(id);
    const after=journal.state(id),r=await client.status(journal.request(id),{requireFound:true});
    {const changed=afterAwait(after,id);if(changed)return changed.outcome;}
    if(journal.state(id).candidateExpiresAt<=clock())return OUTPUT.pending;
    const q=journal.commitRequest(id),receipt=await client.commit({operationId:q.operationId,proof:r.receipt,expectedRequest:q});
    {const changed=afterAwait(after,id);if(changed)return changed.outcome;}
    journal.recordCommitted(id,receipt);
   }else if(s.phase==='commit_uncertain'){
    const q=journal.commitRequest(id),r=await client.status(q);
    {const changed=afterAwait(s,id);if(changed)return changed.outcome;}
    if(r.found)journal.recordCommitted(id,r.receipt);
    else{
     // A not-found status after the lease cannot establish that an uncertain
     // commit never executed. Keep its durable ID; never expire/drop it here.
     if(s.candidateExpiresAt<=clock())return OUTPUT.pending;
     const prepared=await client.status(journal.request(id),{requireFound:true});
     {const changed=afterAwait(s,id);if(changed)return changed.outcome;}
     if(journal.state(id).candidateExpiresAt<=clock())return OUTPUT.pending;
     const receipt=await client.commit({operationId:q.operationId,proof:prepared.receipt,expectedRequest:q});
     {const changed=afterAwait(s,id);if(changed)return changed.outcome;}
     journal.recordCommitted(id,receipt);
    }
   }else if(['committed','attested'].includes(s.phase)){
    if(s.expiresAt<=clock())return compensate(id);
    let proof;try{proof=await attest(journal.candidate(id));}catch{return compensate(id);}
    {const changed=afterAwait(s,id);if(changed)return changed.outcome;}
    const q=journal.request(id);
    if(!proof||Object.getPrototypeOf(proof)!==Object.prototype||Reflect.ownKeys(proof).length!==3||proof.owner!==q.owner||proof.principalId!==q.principalId||!Array.isArray(proof.caps)||Reflect.ownKeys(proof.caps).length!==5||!CAPS.every((cap,i)=>proof.caps[i]===cap)||journal.state(id).expiresAt<=clock())return compensate(id);
    journal.recordAttestation(id,proof);
    // Promotion is synchronous in the same continuation as the fresh proof.
    // Restart in `attested` must obtain a new active attestation above.
    try{journal.promote(id);}catch(e){
     // The corporate promoter emits this only for a lost READ dependency on
     // the same proven, reservation-free lifecycle. Other errors stay pending.
     if(e?.code==='CRM_WRITER_READ_DEPENDENCY_LOST')return compensate(id);
     throw e;
    }return result(journal.state(id));
   }else return OUTPUT.pending;
  }
  return OUTPUT.pending;
 }
 function run(id){if(typeof id!=='string'||!UUID.test(id))return Promise.resolve(OUTPUT.pending);if(active)return active.id===id?active.promise:Promise.resolve(OUTPUT.pending);
  let promise;promise=Promise.resolve().then(()=>drive(id)).catch(()=>OUTPUT.pending).finally(()=>{if(active?.promise===promise)active=null;});active={id,promise};return promise;
 }
 return Object.freeze({run});
}
module.exports={createWriterCoordinator};
