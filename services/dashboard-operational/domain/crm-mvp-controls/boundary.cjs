'use strict';
const VERSION = 'crm-mvp-controls-proposed-v4';
const closed = reason => Object.freeze({state:'closed',reason,authorizesSend:false,operational:false});
// Dependencies are trusted server objects loaded by Root from the manifest pins.
// No transport, persistence fallback, provider call, or send function exists here.
function create({enabled=false,kernel,deliverability,adapter,clock}={}) {
  const ready = enabled === true && kernel && deliverability && typeof clock === 'function' &&
    adapter?.contractVersion === VERSION && ['inspectOperation','reserveOperation','recordOutcome'].every(k=>typeof adapter[k]==='function');
  const pure=require('./decision.cjs').createDecision({kernel,deliverability});
  const decide=input=>{try{return pure({...input,now:clock()});}catch{return closed('clock_unavailable');}};
  // Ephemeral duplicate guard only, never presented as a durable journal.
  const attempted=new Set(),outcomePending=new Set();
  const key=i=>JSON.stringify([i.brand,i.operationId,i.attemptId]);
  const uncertain=(reason,i)=>Object.freeze({...closed(reason),brand:i.brand,operationId:i.operationId,attemptId:i.attemptId,action:'consult_original',newAttemptAllowed:false,automaticReplay:false});
  const capture=input=>{
    try {
      if(!input||typeof input!=='object'||Array.isArray(input))return null;
      const result={};
      for(const k of ['brand','operationId','attemptId']){
        const field=Object.getOwnPropertyDescriptor(input,k);
        if(!field||!Object.hasOwn(field,'value')||typeof field.value!=='string')return null;
        result[k]=field.value;
      }
      if(!['fish','aristo'].includes(result.brand)||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(result.operationId)||result.attemptId!==result.operationId)return null;
      return Object.freeze(result);
    }catch{return null;}
  };
  const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  const scopeFields=Object.freeze(['brand','operationId','distributionId','selectionHash','membersHash','memberCount','campaignId','campaignVersion','ledgerRevision','evidenceRevision','evidenceHash','expiresAt']);
  const scopeSnapshot=raw=>{
    try {
      if(!raw||typeof raw!=='object'||Array.isArray(raw)||![Object.prototype,null].includes(Object.getPrototypeOf(raw)))return null;
      const keys=Reflect.ownKeys(raw);
      if(keys.length!==scopeFields.length||keys.some(k=>typeof k!=='string'||!scopeFields.includes(k)))return null;
      const result={};
      for(const k of scopeFields){
        const field=Object.getOwnPropertyDescriptor(raw,k);
        if(!field||!Object.hasOwn(field,'value')||!field.enumerable)return null;
        result[k]=field.value;
      }
      if(!['fish','aristo'].includes(result.brand)||typeof result.operationId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(result.operationId)||typeof result.distributionId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(result.distributionId))return null;
      if(['selectionHash','membersHash','evidenceHash'].some(k=>!hash(result[k]))||['memberCount','campaignId','campaignVersion','ledgerRevision','evidenceRevision','expiresAt'].some(k=>!Number.isSafeInteger(result[k])||result[k]<=0)||result.memberCount>100000)return null;
      return Object.freeze(result);
    }catch{return null;}
  };
  const sameScope=(a,b)=>{
    const left=scopeSnapshot(a),right=scopeSnapshot(b);
    return !!left&&!!right&&scopeFields.every(k=>left[k]===right[k]);
  };
  const completeReservation=r=>{
    const scope=scopeSnapshot(r?.scope);
    return !!scope&&r.reservation===true&&r.reservedMemberCount===scope.memberCount&&r.reservedMembersHash===scope.membersHash&&r.capacityEvidenceHash===scope.evidenceHash;
  };
  const matches=(r,i)=>r?.brand===i.brand&&r.operationId===i.operationId&&r.attemptId===i.attemptId;
  const validReceipt=(r,i)=>matches(r,i)&&r.durable===true&&hash(r.receiptHash)&&completeReservation(r)&&r.scope?.brand===i.brand&&r.scope?.operationId===i.operationId&&Number.isSafeInteger(r.revision)&&r.revision>0&&['reserved','uncertain','accepted','rejected_before_send'].includes(r.state);
  const confirmed=(r,i)=>Object.freeze({state:r.state,brand:i.brand,operationId:i.operationId,attemptId:i.attemptId,reservationPreserved:true,action:'consult_original',authorizesSend:false,operational:false});
  async function consult(input) {
    const i=capture(input);
    if(!ready||!i)return closed('integration_unavailable');
    try {
      const r=await adapter.inspectOperation(i);
      return validReceipt(r,i)?confirmed(r,i):uncertain('original_operation_unconfirmed',i);
    }catch{return uncertain('lookup_unknown',i);}
  }
  return Object.freeze({decide,
    async reserve(input) {
      const i=capture(input);
      if(!ready||!i)return closed('integration_unavailable');
      try {
        const prior=await adapter.inspectOperation(i);
        if(attempted.has(key(i)))return consult(i);
        if(matches(prior,i)&&prior.state!=='registered')return consult(i);
        if(!matches(prior,i)||prior.state!=='registered'||prior.reservationAttempted!==false||prior.durable!==true||!Number.isSafeInteger(prior.revision)||prior.revision<1||!hash(prior.receiptHash))return closed('registered_operation_unconfirmed');
        attempted.add(key(i));
        // Root MUST execute evaluate against fresh evidence within its atomic CAS
        // transaction and return a durable receipt bound to that exact decision.
        let evaluated, evaluationCount=0;
        const r=await adapter.reserveOperation(Object.freeze({brand:i.brand,operationId:i.operationId,attemptId:i.attemptId,expectedOperationRevision:prior.revision,evaluate:live=>{
          evaluationCount++;
          if(evaluationCount!==1){evaluated=closed('multiple_evaluations');return evaluated;}
          if(live?.operationId!==i.operationId||live?.selection?.plan?.brand!==i.brand){evaluated=closed('scope_changed');return evaluated;}
          evaluated=decide(live);
          return evaluated;
        }}));
        if(evaluationCount!==1||evaluated?.state!=='eligible-for-reservation'||!sameScope(r?.scope,evaluated.scope)||!matches(r,i)||r.state!=='reserved'||r.atomic!==true||r.idempotent!==true||r.durable!==true||!completeReservation(r)||!r.scope||r.scope.brand!==i.brand||r.scope.operationId!==i.operationId||!hash(r.receiptHash)||!Number.isSafeInteger(r.revision)||r.revision<1)return uncertain('reservation_ack_unknown_consult_original',i);
        return Object.freeze({state:'reserved',operationId:i.operationId,attemptId:i.attemptId,authorizesSend:false,operational:false});
      }catch{return uncertain('reservation_ack_unknown_consult_original',i);}
    },consult,
    async recordOutcome(input,outcome) {
      const i=capture(input);
      // Previous attempt accounting is independent of today's selection gate.
      if(!ready||!i||!['unknown','accepted','rejected_before_send'].includes(outcome))return closed('integration_unavailable');
      const operationKey=key(i),target=outcome==='unknown'?'uncertain':outcome;
      if(outcomePending.has(operationKey))return consult(i);
      outcomePending.add(operationKey);
      let mayHaveWritten=false;
      try {
        const prior=await adapter.inspectOperation(i);
        if(!validReceipt(prior,i))return uncertain('original_operation_unconfirmed',i);
        if(prior.state===target)return confirmed(prior,i);
        if(['accepted','rejected_before_send'].includes(prior.state))return uncertain('terminal_outcome_conflict',i);
        if(prior.outcomeWriteState!=='idle')return uncertain('outcome_write_pending_consult_original',i);
        const expectedRevision=prior.revision,priorScope=scopeSnapshot(prior.scope);
        mayHaveWritten=true;
        const r=await adapter.recordOutcome(Object.freeze({...i,outcome,expectedOperationRevision:expectedRevision}));
        if(!validReceipt(r,i)||r.state!==target||r.revision!==expectedRevision+1||r.outcomeWriteState!=='idle'||!sameScope(r.scope,priorScope))return uncertain('outcome_ack_unknown',i);
        outcomePending.delete(operationKey);
        return confirmed(r,i);
      }catch{return uncertain(mayHaveWritten?'outcome_ack_unknown':'lookup_unknown',i);}
      finally {
        // Failed lookup made no write. Lost/malformed write ACK retains the fence.
        if(!mayHaveWritten)outcomePending.delete(operationKey);
      }
    }
  });
}
module.exports=Object.freeze({VERSION,ENABLED:false,create});
