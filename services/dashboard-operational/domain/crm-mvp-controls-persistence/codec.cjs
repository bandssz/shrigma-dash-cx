'use strict';
const {createHash}=require('node:crypto');
const MAX=Number.MAX_SAFE_INTEGER;
const ID=['brand','operationId','attemptId'];
const SCOPE=['brand','operationId','distributionId','selectionHash','membersHash','memberCount','campaignId','campaignVersion','ledgerRevision','evidenceRevision','evidenceHash','expiresAt'];
const BODY=['brand','operationId','attemptId','principalRefHash','registrationEvidenceHash','revision','state','reservationAttempted','outcomeWriteState','registeredAt','updatedAt','scope','reservation','reservedMemberCount','reservedMembersHash','capacityEvidenceHash'];
const COLUMNS=['brand','operation_id','attempt_id','principal_ref_hash','registration_evidence_hash','revision','state','reservation_attempted','outcome_write_state','registered_at','updated_at','scope','reservation','reserved_member_count','reserved_members_hash','capacity_evidence_hash','receipt_hash'];
const ROW_MAP=['brand','operationId','attemptId','principalRefHash','registrationEvidenceHash','revision','state','reservationAttempted','outcomeWriteState','registeredAt','updatedAt','scope','reservation','reservedMemberCount','reservedMembersHash','capacityEvidenceHash','receiptHash'];
const INTENT_COLUMNS=['brand','operation_id','attempt_id','expected_operation_revision','target_outcome','evidence_hash','prior_scope_hash','created_at','phase'];
const UUID4=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const positive=v=>Number.isSafeInteger(v)&&v>0;
const epoch=v=>Number.isSafeInteger(v)&&v>=0;
function exact(raw,keys){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||![Object.prototype,null].includes(Object.getPrototypeOf(raw)))fail('CRM_CONTROLS_DTO_REFUSED');
 const names=Reflect.ownKeys(raw);if(names.length!==keys.length||names.some(k=>typeof k!=='string'||!keys.includes(k)))fail('CRM_CONTROLS_DTO_REFUSED');
 const out={};for(const k of keys){const d=Object.getOwnPropertyDescriptor(raw,k);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail('CRM_CONTROLS_DTO_REFUSED');out[k]=d.value;}return out;
}
function identity(v){if(!['fish','aristo'].includes(v.brand)||typeof v.operationId!=='string'||!UUID4.test(v.operationId)||v.attemptId!==v.operationId)fail('CRM_CONTROLS_DTO_REFUSED');return v;}
function request(raw,kind){
 const extra={inspect:[],register:['principalRefHash','registrationEvidenceHash'],consume:['expectedOperationRevision'],outcome:['outcome','expectedOperationRevision'],reserve:['expectedOperationRevision','evaluate']}[kind];
 if(!extra)fail('CRM_CONTROLS_DTO_REFUSED');const out=identity(exact(raw,[...ID,...extra]));
 if(extra.includes('expectedOperationRevision')&&!positive(out.expectedOperationRevision))fail('CRM_CONTROLS_DTO_REFUSED');
 if(kind==='register'&&(!hash(out.principalRefHash)||!hash(out.registrationEvidenceHash)))fail('CRM_CONTROLS_DTO_REFUSED');
 if(kind==='outcome'&&!['unknown','accepted','rejected_before_send'].includes(out.outcome))fail('CRM_CONTROLS_DTO_REFUSED');
 if(kind==='reserve'&&typeof out.evaluate!=='function')fail('CRM_CONTROLS_DTO_REFUSED');return Object.freeze(out);
}
function scope(raw,owner){
 const s=exact(raw,SCOPE);if(!['fish','aristo'].includes(s.brand)||typeof s.operationId!=='string'||!UUID4.test(s.operationId)||typeof s.distributionId!=='string'||!UUID.test(s.distributionId)||['selectionHash','membersHash','evidenceHash'].some(k=>!hash(s[k]))||['memberCount','campaignId','campaignVersion','ledgerRevision','evidenceRevision','expiresAt'].some(k=>!positive(s[k]))||s.memberCount>100000||owner&&(s.brand!==owner.brand||s.operationId!==owner.operationId))fail('CRM_CONTROLS_RECEIPT_REFUSED');return Object.freeze(s);
}
function body(raw){
 const r=identity(exact(raw,BODY));
 if(!hash(r.principalRefHash)||!hash(r.registrationEvidenceHash)||!positive(r.revision)||!epoch(r.registeredAt)||!epoch(r.updatedAt)||r.updatedAt<r.registeredAt||!['registered','reserved','uncertain','accepted','rejected_before_send'].includes(r.state)||typeof r.reservationAttempted!=='boolean'||typeof r.reservation!=='boolean'||!['idle','pending','uncertain'].includes(r.outcomeWriteState))fail('CRM_CONTROLS_RECEIPT_REFUSED');
 if(r.state==='registered'){
  if(r.revision!==(r.reservationAttempted?2:1)||r.scope!==null||r.reservation!==false||r.reservedMemberCount!==null||r.reservedMembersHash!==null||r.capacityEvidenceHash!==null||r.outcomeWriteState!=='idle')fail('CRM_CONTROLS_RECEIPT_REFUSED');
 }else{
  if(['accepted','rejected_before_send'].includes(r.state)&&r.outcomeWriteState!=='idle')fail('CRM_CONTROLS_RECEIPT_REFUSED');
  r.scope=scope(r.scope,r);
  if(!r.reservationAttempted||!r.reservation||r.reservedMemberCount!==r.scope.memberCount||r.reservedMembersHash!==r.scope.membersHash||r.capacityEvidenceHash!==r.scope.evidenceHash)fail('CRM_CONTROLS_RECEIPT_REFUSED');
 }
 return Object.freeze(r);
}
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeHash=s=>digest(SCOPE.map(k=>scope(s)[k]));
const receiptHash=r=>{const b=body(r);return digest(['crm-controls-receipt-v1',...BODY.map(k=>k==='scope'&&b.scope!==null?SCOPE.map(n=>b.scope[n]):b[k])]);};
function integer(value,allowZero=false){
 if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value))fail('CRM_CONTROLS_RECEIPT_REFUSED');
 const n=BigInt(value);if(n>BigInt(MAX)||n<(allowZero?0n:1n))fail('CRM_CONTROLS_RECEIPT_REFUSED');return Number(n);
}
function decode(row){
 const x=exact(row,COLUMNS),raw={};for(let i=0;i<COLUMNS.length;i++)raw[ROW_MAP[i]]=x[COLUMNS[i]];
 for(const k of ['revision','registeredAt','updatedAt'])raw[k]=integer(raw[k],k!=='revision');
 if(raw.reservedMemberCount!==null)raw.reservedMemberCount=integer(raw.reservedMemberCount);
 const expected=raw.receiptHash;delete raw.receiptHash;const b=body(raw);if(!hash(expected)||receiptHash(b)!==expected)fail('CRM_CONTROLS_RECEIPT_REFUSED');return Object.freeze({...b,receiptHash:expected});
}
function encode(raw){const b=body(raw),r={...b,receiptHash:receiptHash(b)},row={};for(let i=0;i<COLUMNS.length;i++){let v=r[ROW_MAP[i]];if(['revision','registeredAt','updatedAt','reservedMemberCount'].includes(ROW_MAP[i])&&v!==null)v=String(v);row[COLUMNS[i]]=v;}return row;}
function receipt(raw,durable){return Object.freeze({...raw,durable:durable===true,authorizesSend:false,operational:false,sourceOnly:true});}
function registrationVerification(raw,input){const v=request(raw,'register');if(ID.concat(['principalRefHash','registrationEvidenceHash']).some(k=>v[k]!==input[k]))fail('CRM_CONTROLS_VERIFICATION_REFUSED');return v;}
function outcomeVerification(raw,input){const v=identity(exact(raw,[...ID,'outcome','evidenceHash']));if(ID.concat(['outcome']).some(k=>v[k]!==input[k])||!hash(v.evidenceHash))fail('CRM_CONTROLS_VERIFICATION_REFUSED');return Object.freeze(v);}
function intent(row){
 const x=exact(row,INTENT_COLUMNS);identity({brand:x.brand,operationId:x.operation_id,attemptId:x.attempt_id});
 x.expected_operation_revision=integer(x.expected_operation_revision);x.created_at=integer(x.created_at,true);
 if(!['unknown','accepted','rejected_before_send'].includes(x.target_outcome)||!hash(x.evidence_hash)||!hash(x.prior_scope_hash)||!['pending','finished'].includes(x.phase))fail('CRM_CONTROLS_RECEIPT_REFUSED');return Object.freeze(x);
}
function change(r,delta){const next={};for(const k of BODY)next[k]=Object.hasOwn(delta,k)?delta[k]:r[k];return body(next);}
module.exports=Object.freeze({MAX,ID:Object.freeze(ID),SCOPE:Object.freeze(SCOPE),BODY:Object.freeze(BODY),COLUMNS:Object.freeze(COLUMNS),INTENT_COLUMNS:Object.freeze(INTENT_COLUMNS),hash,positive,epoch,exact,request,scope,body,scopeHash,receiptHash,integer,decode,encode,receipt,registrationVerification,outcomeVerification,intent,change});
