'use strict';
const assert=require('node:assert/strict'),T=require('./data.cjs'),A=require('../../services/dashboard-operational/domain/crm-mvp-controls-integration/atomic-reservation.cjs');
const SCENARIOS=Object.freeze(['roundtrip-outcome','capacity-race','facts-revocation','partial-rollback','fence-ack','reservation-ack']);
async function runScenario({scenario,clients,D}){assert(SCENARIOS.includes(scenario));assert(Array.isArray(clients)&&clients.length===2&&clients[0]!==clients[1]);const p=await T.prepared(D),domains=clients.map(client=>D.domainSession.create({enabled:true,client})),options=domains.map(d=>T.options(D,d,p));
 const verifyRegistration=async i=>i,verifyOutcome=async i=>({brand:i.brand,operationId:i.operationId,attemptId:i.attemptId,outcome:i.outcome,evidenceHash:T.E});
 const foundations=domains.map(d=>D.foundation.create({enabled:true,client:d.client,verifyRegistration,verifyOutcome,clock:()=>T.N}));
 const stores=options.map((o,n)=>A.create({...o,foundation:foundations[n]}));
 // Only new reservation data are seeded. Existing foundation/facts API setup is
 // outside the reservation transaction, under the supplied Root domain session.
 for(const id of [T.uuid(7),T.uuid(8)])await domains[0].withDomainSession(()=>foundations[0].registerOriginal({brand:'fish',operationId:id,attemptId:id,principalRefHash:T.H,registrationEvidenceHash:T.E}));
 await D.factStore.create(options[0]).publish(T.batch(p.facts));
 async function facts(){return domains[1].withDomainSession(async()=>{await domains[1].client.query(D.FS.BEGIN_READ);try{const keys=p.facts.map(f=>({kind:f.kind,fact_key:D.F.key(f.kind,f.body)})),r=await domains[1].client.query(D.FS.HEADS,['fish',JSON.stringify(keys)]);assert.equal(r.rows.length,6);return new Map(r.rows.map(row=>{const r=D.F.row(row);return [r.kind,r.body];}));}finally{await domains[1].client.query(D.FS.ROLLBACK);}});}
 const identity=n=>({brand:'fish',operationId:T.uuid(n),attemptId:T.uuid(n)});
 if(scenario==='roundtrip-outcome'){
  await assert.rejects(A.create({...options[0],verifyLiveContext:async()=>{throw Error('synthetic reader');}}).reserveOperation(T.reserve(D)));assert.equal((await stores[0].inspectOperation(identity(7))).reservationAttempted,false);
  await assert.rejects(stores[0].reserveOperation({...T.reserve(D),brand:'aristo'}));await assert.rejects(stores[0].reserveOperation({...T.reserve(D),attemptId:T.uuid(8)}));
  const boundary=D.boundary.create({enabled:true,kernel:D.kernel,deliverability:D.deliverability,adapter:stores[0],clock:()=>T.N});assert.equal((await boundary.reserve(identity(7))).state,'reserved');assert.equal((await boundary.reserve(identity(7))).reservationPreserved,true);
  await stores[1].reserveOperation(T.reserve(D,T.uuid(7),()=>{throw Error('duplicate evaluation');}));const r=await stores[0].recordOutcome({...identity(7),outcome:'unknown',expectedOperationRevision:3});assert.equal(r.state,'uncertain');assert.equal(r.revision,4);assert.equal(r.factsOutcomeReconciled,false);const f=await facts();assert.equal(f.get('capacity').reservedCount,1);assert.equal(f.get('capping').reservedCount,1);assert.equal(f.get('claims').claims.length,1);assert.equal((await stores[1].inspectOperation(identity(7))).state,'uncertain');
 }
 if(scenario==='capacity-race'){
  const r=await Promise.allSettled([stores[0].reserveOperation(T.reserve(D,T.uuid(7))),stores[1].reserveOperation(T.reserve(D,T.uuid(8)))]);assert.equal(r.filter(x=>x.status==='fulfilled'&&x.value.state==='reserved').length,1);const winner=r[0].status==='fulfilled'?0:1,loser=winner===0?1:0,id=loser===0?7:8;
  const original=await stores[winner].inspectOperation(identity(id));assert.equal(original.state,'registered');assert.equal(original.reservationAttempted,true);const consult=await stores[winner].reserveOperation(T.reserve(D,T.uuid(id),()=>{throw Error('restart retry');}));assert.equal(consult.newAttemptAllowed,false);
  // Winner's nonpoisoned session reads persisted shared counters.
  await domains[winner].withDomainSession(async()=>{await domains[winner].client.query(D.FS.BEGIN_READ);try{const key=D.F.key('capacity',p.facts.find(f=>f.kind==='capacity').body),r=await domains[winner].client.query(D.FS.HEADS,['fish',JSON.stringify([{kind:'capacity',fact_key:key}])]);assert.equal(D.F.row(r.rows[0]).body.reservedCount,1);}finally{await domains[winner].client.query(D.FS.ROLLBACK);}});
 }
 if(scenario==='facts-revocation'){
  const query=clients[0].query.bind(clients[0]);let starts=0,evaluations=0;
  // Synthetic ordering hook, actual two-session facts update commits before
  // reserve's second BEGIN. No query normalization/extra connection/retry.
  clients[0].query=async(sql,params)=>{if(sql===D.FS.BEGIN_WRITE&&++starts===2){const consent=p.facts.find(f=>f.kind==='consent').body;await D.factStore.create(options[1]).publish(T.batch([{kind:'consent',expectedRevision:9,revision:10,body:{...consent,consentRevision:10,consent:'revoked'}}],{expectedBrandRevision:7,brandRevision:8,eventRef:'c'.repeat(64)}));}return query(sql,params);};
  try{await assert.rejects(stores[0].reserveOperation(T.reserve(D,T.uuid(7),live=>{evaluations++;return D.decision.createDecision(D)(live);})));}finally{clients[0].query=query;}
  assert.equal(evaluations,0);const original=await stores[1].inspectOperation(identity(7));assert.equal(original.state,'registered');assert.equal(original.reservationAttempted,true);const f=await facts();assert.equal(f.get('consent').consent,'revoked');assert.equal(f.get('capacity').reservedCount,0);assert.equal(f.get('claims').claims.length,0);
 }
 if(scenario==='partial-rollback'){
  const query=clients[0].query.bind(clients[0]);clients[0].query=async(sql,params)=>{if(sql===D.FS.UPDATE_BRAND)throw Object.assign(Error('synthetic fault before complete reservation commit'),{code:'23514'});return query(sql,params);};try{await assert.rejects(stores[0].reserveOperation(T.reserve(D)));}finally{clients[0].query=query;}
  const fresh=A.create(options[1]),original=await fresh.inspectOperation(identity(7));assert.equal(original.state,'registered');assert.equal(original.revision,2);assert.equal(original.reservationAttempted,true);assert.equal((await fresh.reserveOperation(T.reserve(D,T.uuid(7),()=>{throw Error('reopened');}))).action,'consult_original');const f=await facts();assert.equal(f.get('claims').claims.length,0);assert.equal(f.get('capacity').reservedCount,0);assert.equal(f.get('capping').reservedCount,0);
 }
 if(scenario==='fence-ack'||scenario==='reservation-ack'){
  const query=clients[0].query.bind(clients[0]);let commits=0,evaluations=0;const target=scenario==='fence-ack'?1:2;
  // Fault hook after an actual COMMIT. Not real wire/network ACK loss.
  clients[0].query=async(sql,params)=>{const r=await query(sql,params);return sql===D.FS.COMMIT&&++commits===target?{}:r;};try{await assert.rejects(stores[0].reserveOperation(T.reserve(D,T.uuid(7),live=>{evaluations++;return D.decision.createDecision(D)(live);})));}finally{clients[0].query=query;}
  assert.equal(domains[0].status().poisoned,true);assert.equal(evaluations,target===1?0:1);await assert.rejects(A.create(options[0]).inspectOperation(identity(7)));const original=await stores[1].inspectOperation(identity(7));assert.equal(original.state,target===1?'registered':'reserved');assert.equal(original.reservationAttempted,true);await stores[1].reserveOperation(T.reserve(D,T.uuid(7),()=>{throw Error('unknown ACK retry');}));const f=await facts();assert.equal(f.get('capacity').reservedCount,target===1?0:1);assert.equal(f.get('capping').reservedCount,target===1?0:1);
 }
 return Object.freeze({scenario,passed:true,sourceOnly:true,operational:false,nativePG17Proof:false,faultHooksSynthetic:['facts-revocation','partial-rollback','fence-ack','reservation-ack'].includes(scenario),nativeNetworkAckProof:false,productionDurabilityProved:false});
}
module.exports=Object.freeze({SCENARIOS,runScenario});
