'use strict';
const C=require('./codec.cjs'),SQL=require('./sql.cjs');
const VERSION='crm-mvp-controls-persistence-foundation-v1';
// Connection ownership belongs to Root. This WeakMap is only a session-use guard,
// never an operation journal, reservation store, fallback or durability proof.
const sessions=new WeakMap();
const CODES=new Set(['CRM_CONTROLS_OFF','CRM_CONTROLS_DTO_REFUSED','CRM_CONTROLS_RECEIPT_REFUSED','CRM_CONTROLS_VERIFICATION_REFUSED','CRM_CONTROLS_LOOKUP_UNKNOWN','CRM_CONTROLS_SESSION_UNAVAILABLE','CRM_CONTROLS_CLIENT_BUSY','CRM_CONTROLS_CAS_REFUSED','CRM_CONTROLS_ACK_UNKNOWN','CRM_CONTROLS_TRANSACTION_REFUSED','CRM_CONTROLS_OUTCOME_CONFLICT','CRM_CONTROLS_PENDING_CONSULT_ONLY','CRM_CONTROLS_CLOCK_REFUSED']);
function error(code,identity,sqlstate=null){const clean=typeof sqlstate==='string'&&/^[0-9A-Z]{5}$/.test(sqlstate)?sqlstate:null;const e=Object.assign(new Error(code),{code,sqlstate:clean});if(identity)e.identity=Object.freeze({brand:identity.brand,operationId:identity.operationId,attemptId:identity.attemptId});return e;}
const stateCode=e=>typeof e?.code==='string'&&/^[0-9A-Z]{5}$/.test(e.code)?e.code:null;
const fatal=e=>e?.code==='40001'||e?.code==='57014'||stateCode(e)?.startsWith('08')||['ECONNRESET','EPIPE','ETIMEDOUT','ENOTCONN'].includes(e?.code);
const sanitize=(e,i,fallback='CRM_CONTROLS_TRANSACTION_REFUSED')=>error(CODES.has(e?.code)?e.code:fallback,i,e?.sqlstate||stateCode(e));
function create({enabled=false,client,verifyRegistration,verifyOutcome,clock}={}){
 const ready=enabled===true&&client&&typeof client==='object'&&typeof client.query==='function'&&typeof verifyRegistration==='function'&&typeof verifyOutcome==='function'&&typeof clock==='function';
 let session;if(ready){session=sessions.get(client);if(!session){session={busy:false,poisoned:false};sessions.set(client,session);}}
 const time=prior=>{let n;try{n=clock();}catch{throw error('CRM_CONTROLS_CLOCK_REFUSED');}if(!C.epoch(n)||prior!==undefined&&n<prior)throw error('CRM_CONTROLS_CLOCK_REFUSED');return n;};
 const idParams=i=>[i.brand,i.operationId,i.attemptId];
 const request=(raw,kind)=>{try{return C.request(raw,kind);}catch(e){throw sanitize(e,null,'CRM_CONTROLS_DTO_REFUSED');}};
 async function use(i,work){
  if(!ready)throw error('CRM_CONTROLS_OFF',i);
  if(session.poisoned)throw error('CRM_CONTROLS_SESSION_UNAVAILABLE',i);
  if(session.busy)throw error('CRM_CONTROLS_CLIENT_BUSY',i);
  session.busy=true;try{return await work();}catch(e){throw sanitize(e,i);}finally{session.busy=false;}
 }
 async function query(sql,params,command){
  const r=await client.query(sql,params);
  if(!r||r.command!==command||!Array.isArray(r.rows)||r.rows.length>1||r.rows.some((_,n)=>!Object.hasOwn(r.rows,n))||![null,0,1].includes(r.rowCount)||r.rowCount!==null&&r.rowCount!==r.rows.length)throw error('CRM_CONTROLS_TRANSACTION_REFUSED');
  return r.rows;
 }
 async function tx(write,work){
  let started=false,finishAttempted=false;
  try{
   started=true;
   const begin=await client.query(write?SQL.BEGIN_WRITE:SQL.BEGIN_READ);
   if(begin?.command!=='BEGIN'){session.poisoned=true;throw error('CRM_CONTROLS_ACK_UNKNOWN');}
   const value=await work();finishAttempted=true;
   const finish=await client.query(write?SQL.COMMIT:SQL.ROLLBACK);
   if(finish?.command!==(write?'COMMIT':'ROLLBACK')){session.poisoned=true;throw error('CRM_CONTROLS_ACK_UNKNOWN');}
   return value;
  }catch(e){
   if(finishAttempted||fatal(e)||!CODES.has(e?.code)&&!stateCode(e))session.poisoned=true;
   if(started&&!finishAttempted){
    try{const r=await client.query(SQL.ROLLBACK);if(r?.command!=='ROLLBACK'){session.poisoned=true;throw error('CRM_CONTROLS_ACK_UNKNOWN');}}
    catch(rollback){session.poisoned=true;throw error('CRM_CONTROLS_ACK_UNKNOWN',null,stateCode(rollback));}
   }
   if(finishAttempted)throw error('CRM_CONTROLS_ACK_UNKNOWN',null,stateCode(e));
   throw e;
  }
 }
 async function load(i,lock){const rows=await query(lock?SQL.LOCK:SQL.READ,idParams(i),'SELECT');return rows.length?C.decode(rows[0]):null;}
 const sameIdentity=(r,i)=>C.ID.every(k=>r[k]===i[k]);
 const matchRow=(r,i)=>{if(!r||!sameIdentity(r,i))throw error('CRM_CONTROLS_RECEIPT_REFUSED');return r;};
 const one=(rows,i)=>{if(rows.length!==1)throw error('CRM_CONTROLS_CAS_REFUSED');return matchRow(C.decode(rows[0]),i);};
 const publicReceipt=r=>C.receipt(r,true);
 async function registerOriginal(raw){
  const i=request(raw,'register');return use(i,async()=>{
   try{C.registrationVerification(await verifyRegistration(i),i);}catch{throw error('CRM_CONTROLS_VERIFICATION_REFUSED');}
   const r=await tx(true,async()=>{
    const existing=await load(i,true);
    if(existing){matchRow(existing,i);if(existing.principalRefHash!==i.principalRefHash||existing.registrationEvidenceHash!==i.registrationEvidenceHash)throw error('CRM_CONTROLS_VERIFICATION_REFUSED');return existing;}
    const now=time(),body=C.body({brand:i.brand,operationId:i.operationId,attemptId:i.attemptId,principalRefHash:i.principalRefHash,registrationEvidenceHash:i.registrationEvidenceHash,revision:1,state:'registered',reservationAttempted:false,outcomeWriteState:'idle',registeredAt:now,updatedAt:now,scope:null,reservation:false,reservedMemberCount:null,reservedMembersHash:null,capacityEvidenceHash:null});
    const rows=await query(SQL.INSERT,[...idParams(i),i.principalRefHash,i.registrationEvidenceHash,String(now),C.receiptHash(body)],'INSERT');
    if(rows.length){const inserted=one(rows,i);if(inserted.receiptHash!==C.receiptHash(body))throw error('CRM_CONTROLS_RECEIPT_REFUSED');return inserted;}
    const duplicate=matchRow(await load(i,true),i);if(duplicate.principalRefHash!==i.principalRefHash||duplicate.registrationEvidenceHash!==i.registrationEvidenceHash)throw error('CRM_CONTROLS_VERIFICATION_REFUSED');return duplicate;
   });return publicReceipt(r);
  });
 }
 async function inspectOperation(raw){
  const i=request(raw,'inspect');return use(i,async()=>{
   let r;try{r=await tx(false,()=>load(i,false));if(r)matchRow(r,i);}catch(e){throw error('CRM_CONTROLS_LOOKUP_UNKNOWN',i,e?.sqlstate||stateCode(e));}
   return r?publicReceipt(r):Object.freeze({...i,state:'absent',durable:false,authorizesSend:false,operational:false,sourceOnly:true});
  });
 }
 async function consumeReservationAttempt(raw){
  const i=request(raw,'consume');return use(i,async()=>{
   const r=await tx(true,async()=>{
    const prior=matchRow(await load(i,true),i);
    if(prior.state==='registered'&&prior.reservationAttempted&&i.expectedOperationRevision<C.MAX&&prior.revision===i.expectedOperationRevision+1)return prior;
    if(prior.state!=='registered'||prior.reservationAttempted||prior.revision!==i.expectedOperationRevision||prior.revision>=C.MAX)throw error('CRM_CONTROLS_CAS_REFUSED');
    const now=time(prior.updatedAt),next=C.change(prior,{reservationAttempted:true,revision:prior.revision+1,updatedAt:now});
    const consumed=one(await query(SQL.CONSUME,[...idParams(i),String(i.expectedOperationRevision),String(now),C.receiptHash(next),prior.receiptHash],'UPDATE'),i);
    if(consumed.receiptHash!==C.receiptHash(next))throw error('CRM_CONTROLS_RECEIPT_REFUSED');return consumed;
   });return publicReceipt(r);
  });
 }
 async function recordOutcome(raw){
  const i=request(raw,'outcome');return use(i,async()=>{
   const target=i.outcome==='unknown'?'uncertain':i.outcome;
   // First transaction commits an irreversible durable pending intent. The local
   // continuation is call-owned and never exposed or accepted from a caller.
   const fence=await tx(true,async()=>{
    const prior=matchRow(await load(i,true),i);
    if(prior.state==='registered'||!prior.reservation)throw error('CRM_CONTROLS_RECEIPT_REFUSED');
    if(prior.state===target)return {confirmed:prior};
    if(['accepted','rejected_before_send'].includes(prior.state))throw error('CRM_CONTROLS_OUTCOME_CONFLICT');
    if(prior.outcomeWriteState!=='idle')throw error('CRM_CONTROLS_PENDING_CONSULT_ONLY');
    if(prior.revision!==i.expectedOperationRevision||prior.revision>=C.MAX)throw error('CRM_CONTROLS_CAS_REFUSED');
    let verification;try{verification=C.outcomeVerification(await verifyOutcome(i,C.receipt(prior,false)),i);}catch{throw error('CRM_CONTROLS_VERIFICATION_REFUSED');}
    const now=time(prior.updatedAt),scopeHash=C.scopeHash(prior.scope),pending=C.change(prior,{outcomeWriteState:'pending',updatedAt:now});
    const intents=await query(SQL.INSERT_INTENT,[...idParams(i),String(prior.revision),i.outcome,verification.evidenceHash,scopeHash,String(now)],'INSERT');
    if(intents.length!==1)throw error('CRM_CONTROLS_PENDING_CONSULT_ONLY');
    const intent=C.intent(intents[0]);
    if(intent.brand!==i.brand||intent.operation_id!==i.operationId||intent.attempt_id!==i.attemptId||intent.expected_operation_revision!==prior.revision||intent.target_outcome!==i.outcome||intent.created_at!==now||intent.phase!=='pending')throw error('CRM_CONTROLS_RECEIPT_REFUSED');
    const row=one(await query(SQL.PENDING,[...idParams(i),String(prior.revision),String(now),C.receiptHash(pending),prior.receiptHash],'UPDATE'),i);
    if(row.receiptHash!==C.receiptHash(pending)||intent.evidence_hash!==verification.evidenceHash||intent.prior_scope_hash!==scopeHash)throw error('CRM_CONTROLS_RECEIPT_REFUSED');
    return {prior,pending:row,intent};
   });
   if(fence.confirmed)return publicReceipt(fence.confirmed);
   const r=await tx(true,async()=>{
    const current=matchRow(await load(i,true),i),rows=await query(SQL.LOCK_INTENT,[...idParams(i),String(i.expectedOperationRevision)],'SELECT');
    if(rows.length!==1)throw error('CRM_CONTROLS_PENDING_CONSULT_ONLY');const intent=C.intent(rows[0]);
    if(current.receiptHash!==fence.pending.receiptHash||current.outcomeWriteState!=='pending'||current.revision!==i.expectedOperationRevision||intent.phase!=='pending'||C.INTENT_COLUMNS.some(k=>intent[k]!==fence.intent[k])||C.scopeHash(current.scope)!==intent.prior_scope_hash)throw error('CRM_CONTROLS_PENDING_CONSULT_ONLY');
    const now=time(current.updatedAt),next=C.change(current,{state:target,revision:current.revision+1,outcomeWriteState:'idle',updatedAt:now});
    const finished=one(await query(SQL.FINISH,[...idParams(i),String(i.expectedOperationRevision),target,String(now),C.receiptHash(next),current.receiptHash,JSON.stringify(current.scope)],'UPDATE'),i);
    const end=await query(SQL.FINISH_INTENT,[...idParams(i),String(i.expectedOperationRevision),i.outcome,intent.evidence_hash,intent.prior_scope_hash],'UPDATE');
    if(end.length!==1||C.intent(end[0]).phase!=='finished'||finished.receiptHash!==C.receiptHash(next))throw error('CRM_CONTROLS_RECEIPT_REFUSED');return finished;
   });return publicReceipt(r);
  });
 }
 function reserveOperation(raw){const i=request(raw,'reserve');return Promise.resolve(Object.freeze({brand:i.brand,operationId:i.operationId,attemptId:i.attemptId,state:'closed',reason:'complete_reservation_contract_unavailable',action:'consult_original',authorizesSend:false,operational:false,sourceOnly:true,durable:false,newAttemptAllowed:false,automaticReplay:false}));}
 return Object.freeze({contractVersion:VERSION,sourceOnly:true,operational:false,capabilities:Object.freeze({completeReservation:false,send:false}),registerOriginal,inspectOperation,consumeReservationAttempt,recordOutcome,reserveOperation});
}
module.exports=Object.freeze({VERSION,ENABLED:false,sourceOnly:true,operational:false,create});
