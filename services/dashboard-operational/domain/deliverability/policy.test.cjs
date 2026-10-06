'use strict';
// Synthetic classified events/private callback fixtures only. This proves the
// domain transition, not any provider authentication, durable store or dispatch.
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('./policy.cjs');
const A='a'.repeat(64),B='b'.repeat(64),ACTOR='c'.repeat(64),CONTEXT=Object.freeze({fixture:'trusted-classifier'});
const BASE=1791302400000;
function fixture({brand='fish',limit=3,authorize=true,verify,authorizer}={}){
 let at=BASE;
 const policy=P.createPolicy({brand,softBounceAttempts:limit,providers:['provider_a','provider_b'],clock:()=>at,
  verifyClassifiedEvent:verify||((raw,context)=>{if(context?.fixture!==CONTEXT.fixture)throw Error('SYNTHETIC_PRIVATE_PROVIDER_DETAIL');return raw;}),
  ...(authorize?{authorizePolicyChange:authorizer||((request,context)=>{if(context?.fixture!=='trusted-master')throw Error('SYNTHETIC_PRIVATE_ACTOR');return {brand:request.brand,actorRef:ACTOR};})}:{})});
 const event=(extra={})=>({schema:P.EVENT_VERSION,providerId:'provider_a',brand,recipientRef:A,eventId:'synthetic-event-1',attemptId:'synthetic-dispatch-1',classification:'soft_bounce',occurredAt:at,...extra});
 const add=async(state,extra={})=>{at++;const token=await policy.admitEvent(event(extra),CONTEXT);return policy.apply(state,token);};
 const change=async(state,limit,operationId='11111111-1111-4111-8111-111111111111')=>{at++;const token=await policy.admitPolicyChange({operationId,softBounceAttempts:limit},{fixture:'trusted-master'});return policy.apply(state,token);};
 return {policy,event,add,change,tick:(n=1)=>{at+=n;},get now(){return at;}};
}
test('first verified hard bounce suppresses only its brand/recipient and keeps the original history',async()=>{
 const f=fixture(),initial=f.policy.initialState(),result=await f.add(initial,{classification:'hard_bounce'});
 assert.equal(result.decision.houseSuppressed,true);assert.equal(result.decision.reason,'hard_bounce');assert.equal(result.decision.hardBounceAttemptCount,1);
 assert.equal(f.policy.inspect(result.state,B).houseSuppressed,false);assert.equal(initial.records.length,0);assert.equal(result.state.records.length,1);
 assert.equal(result.requiresPersistence,true);assert.equal(result.durableCommitConfirmed,false);assert.equal(result.providerSuppressionConfirmed,false);
 assert.equal(result.authorizesSend,false);assert.equal(result.workerSuspensionChanged,false);assert.equal(result.trackingChanged,false);
 assert.ok(Object.isFrozen(result.state)&&Object.isFrozen(result.state.records)&&Object.isFrozen(result.state.records[0]));
});
test('soft limit counts original unique attempts across provider events rather than webhook deliveries',async()=>{
 const f=fixture({limit:3});let s=f.policy.initialState();
 let r=await f.add(s);s=r.state;assert.equal(r.decision.softBounceAttemptCount,1);assert.equal(r.decision.houseSuppressed,false);
 r=await f.add(s,{eventId:'synthetic-event-2'});s=r.state;assert.equal(r.decision.softBounceAttemptCount,1);
 r=await f.add(s,{providerId:'provider_b',eventId:'synthetic-event-1'});s=r.state;assert.equal(r.decision.softBounceAttemptCount,1);
 r=await f.add(s,{eventId:'synthetic-event-3',attemptId:'synthetic-dispatch-2'});s=r.state;assert.equal(r.decision.softBounceAttemptCount,2);assert.equal(r.decision.houseSuppressed,false);
 r=await f.add(s,{eventId:'synthetic-event-4',attemptId:'synthetic-dispatch-3'});assert.equal(r.decision.softBounceAttemptCount,3);assert.equal(r.decision.reason,'soft_threshold');assert.equal(r.state.records.length,5);
});
test('same immutable event is idempotent and changed event binding conflicts without changing state',async()=>{
 const f=fixture(),e=f.event(),token=await f.policy.admitEvent(e,CONTEXT),first=f.policy.apply(f.policy.initialState(),token);
 f.tick();const again=f.policy.apply(first.state,token);assert.equal(again.status,'duplicate');assert.equal(again.requiresPersistence,false);assert.deepEqual(again.state,first.state);
 const conflict=await f.policy.admitEvent({...e,recipientRef:B,attemptId:'synthetic-other-attempt',classification:'hard_bounce'},CONTEXT);
 assert.throws(()=>f.policy.apply(first.state,conflict),e=>e.code==='DELIVERABILITY_EVENT_CONFLICT'&&e.message==='DELIVERABILITY_EVENT_CONFLICT');
 assert.equal(first.state.records.length,1);assert.equal(f.policy.inspect(first.state,B).houseSuppressed,false);
});
test('delivered events and out-of-order hard evidence never clear soft counts or sticky suppression',async()=>{
 const f=fixture({limit:2});let r=await f.add(f.policy.initialState());
 r=await f.add(r.state,{eventId:'synthetic-delivered',classification:'delivered'});assert.equal(r.decision.softBounceAttemptCount,1);
 r=await f.add(r.state,{eventId:'synthetic-soft-2',attemptId:'synthetic-dispatch-2'});const originalBlockedAt=r.decision.blockedAt;assert.equal(r.decision.houseSuppressed,true);
 r=await f.add(r.state,{eventId:'synthetic-hard-late',classification:'hard_bounce',occurredAt:BASE-86400000});assert.equal(r.decision.reason,'hard_bounce');assert.equal(r.decision.blockedAt,originalBlockedAt);
 r=await f.add(r.state,{eventId:'synthetic-delivery-after-hard',attemptId:'synthetic-dispatch-3',classification:'delivered'});
 assert.equal(r.decision.reason,'hard_bounce');assert.equal(r.decision.softBounceAttemptCount,2);assert.equal(r.state.records.length,5);
});
test('independent attempts of another recipient do not increase the first recipient counter',async()=>{
 const f=fixture({limit:2});let r=await f.add(f.policy.initialState());
 r=await f.add(r.state,{recipientRef:B,eventId:'synthetic-b-1'});assert.equal(r.decision.softBounceAttemptCount,1);assert.equal(r.decision.houseSuppressed,false);
 r=await f.add(r.state,{recipientRef:B,eventId:'synthetic-b-2',attemptId:'synthetic-dispatch-2'});assert.equal(r.decision.houseSuppressed,true);
 assert.equal(f.policy.inspect(r.state,A).softBounceAttemptCount,1);assert.equal(f.policy.inspect(r.state,A).houseSuppressed,false);
});
test('foreign brand evidence, foreign owned tokens and foreign state are refused',async()=>{
 const fish=fixture(),aristo=fixture({brand:'aristo'});
 await assert.rejects(fish.policy.admitEvent(fish.event({brand:'aristo'}),CONTEXT),e=>e.code==='DELIVERABILITY_EVENT_UNCONFIRMED');
 const t=await aristo.policy.admitEvent(aristo.event(),CONTEXT);
 assert.throws(()=>fish.policy.apply(fish.policy.initialState(),t),e=>e.code==='DELIVERABILITY_ADMISSION_REQUIRED');
 const own=await fish.policy.admitEvent(fish.event(),CONTEXT);
 assert.throws(()=>fish.policy.apply(aristo.policy.initialState(),own),e=>e.code==='DELIVERABILITY_STATE_SCOPE');
});
test('JSON authentication flags, forged tokens and provider-specific unknown classifications are never admission',async()=>{
 const f=fixture();await assert.rejects(f.policy.admitEvent({...f.event(),verified:true},{}),e=>e.code==='DELIVERABILITY_EVENT_UNCONFIRMED'&&!e.message.includes('PRIVATE'));
 assert.throws(()=>f.policy.apply(f.policy.initialState(),{schema:'crm-deliverability-admission-v1',brand:'fish',type:'event'}),e=>e.code==='DELIVERABILITY_ADMISSION_REQUIRED');
 for(const classification of ['Permanent','Transient','unknown','delivery_delay','complaint'])await assert.rejects(f.policy.admitEvent(f.event({classification}),CONTEXT),e=>e.code==='DELIVERABILITY_EVENT_UNCONFIRMED');
 await assert.rejects(f.policy.admitEvent(f.event({providerId:'unapproved_provider'}),CONTEXT),e=>e.code==='DELIVERABILITY_EVENT_UNCONFIRMED');
});
test('expired admission needs reverification and the immutable event still deduplicates afterwards',async()=>{
 const f=fixture(),e=f.event(),t=await f.policy.admitEvent(e,CONTEXT),r=f.policy.apply(f.policy.initialState(),t);
 f.tick(P.LIMITS.admissionTtlMs);assert.throws(()=>f.policy.apply(r.state,t),e=>e.code==='DELIVERABILITY_ADMISSION_REQUIRED');
 const fresh=await f.policy.admitEvent(e,CONTEXT);const duplicate=f.policy.apply(r.state,fresh);assert.equal(duplicate.status,'duplicate');assert.equal(duplicate.state.records.length,1);
});
test('authorized limit reduction blocks accumulated attempts; increase never clears old suppression',async()=>{
 const f=fixture({limit:4});let r=await f.add(f.policy.initialState());r=await f.add(r.state,{eventId:'synthetic-soft-2',attemptId:'synthetic-dispatch-2'});
 assert.equal(r.decision.houseSuppressed,false);const before=r.state.records.slice();r=await f.change(r.state,2);
 assert.equal(f.policy.inspect(r.state,A).reason,'soft_threshold');assert.deepEqual(r.state.records.slice(0,2),before);
 r=await f.change(r.state,100,'22222222-2222-4222-8222-222222222222');assert.equal(f.policy.inspect(r.state,A).houseSuppressed,true);assert.equal(f.policy.inspect(r.state,A).softBounceAttempts,100);
 const hard=await f.add(r.state,{recipientRef:B,eventId:'synthetic-hard-b',classification:'hard_bounce'});r=await f.change(hard.state,99,'33333333-3333-4333-8333-333333333333');assert.equal(f.policy.inspect(r.state,B).reason,'hard_bounce');
});
test('configuration authority is required and the original operation deduplicates without reverting later settings',async()=>{
 const none=fixture({authorize:false});await assert.rejects(none.change(none.policy.initialState(),2),e=>e.code==='DELIVERABILITY_CONFIG_NOT_ADMITTED');
 const f=fixture();await assert.rejects(f.policy.admitPolicyChange({operationId:'11111111-1111-4111-8111-111111111111',softBounceAttempts:2},{fixture:'untrusted'}),e=>e.code==='DELIVERABILITY_CONFIG_NOT_ADMITTED');
 let r=await f.change(f.policy.initialState(),2);r=await f.change(r.state,4,'22222222-2222-4222-8222-222222222222');
 const duplicate=await f.change(r.state,2);assert.equal(duplicate.status,'duplicate');assert.equal(f.policy.inspect(duplicate.state,A).softBounceAttempts,4);assert.equal(duplicate.state.records.length,2);
 const conflict=await f.policy.admitPolicyChange({operationId:'11111111-1111-4111-8111-111111111111',softBounceAttempts:5},{fixture:'trusted-master'});
 assert.throws(()=>f.policy.apply(r.state,conflict),e=>e.code==='DELIVERABILITY_EVENT_CONFLICT');
});
test('configuration input cannot change after its exact request was authorized asynchronously',async()=>{
 let complete,seen;
 const f=fixture({authorizer:request=>{seen=request;return new Promise(resolve=>{complete=resolve;});}});
 const input={operationId:'11111111-1111-4111-8111-111111111111',softBounceAttempts:2};const pending=f.policy.admitPolicyChange(input,{fixture:'trusted-master'});
 assert.ok(Object.isFrozen(seen));input.operationId='22222222-2222-4222-8222-222222222222';input.softBounceAttempts=100;complete({brand:'fish',actorRef:ACTOR});
 const r=f.policy.apply(f.policy.initialState(),await pending);assert.equal(f.policy.inspect(r.state,A).softBounceAttempts,2);
 const duplicate=f.policy.admitPolicyChange({operationId:'11111111-1111-4111-8111-111111111111',softBounceAttempts:2},{fixture:'trusted-master'});complete({brand:'fish',actorRef:ACTOR});assert.equal(f.policy.apply(r.state,await duplicate).status,'duplicate');
});
test('persisted JSON replay preserves history and blocks; another constructor value cannot silently reset it',async()=>{
 const f=fixture({limit:1}),r=await f.add(f.policy.initialState()),saved=JSON.parse(JSON.stringify(r.state)),restart=fixture({limit:100});restart.tick(f.now-BASE);
 assert.deepEqual(restart.policy.inspect(saved,A),f.policy.inspect(r.state,A));assert.equal(restart.policy.inspect(saved,A).softBounceAttempts,1);assert.equal(restart.policy.inspect(saved,A).houseSuppressed,true);
 const later=await restart.add(saved,{eventId:'synthetic-delivery-restart',classification:'delivered'});assert.equal(later.decision.houseSuppressed,true);assert.deepEqual(later.state.records[0],saved.records[0]);
});
test('history edits, truncation, sparse arrays and accessor payloads refuse without mutation or raw values',async()=>{
 const f=fixture(),r=await f.add(f.policy.initialState());
 const altered=JSON.parse(JSON.stringify(r.state));altered.records[0].classification='delivered';assert.throws(()=>f.policy.inspect(altered,A),e=>e.code==='DELIVERABILITY_STATE_CORRUPT');
 const truncated=JSON.parse(JSON.stringify(r.state));truncated.records=[];truncated.revision=0;assert.throws(()=>f.policy.inspect(truncated,A),e=>e.code==='DELIVERABILITY_STATE_CORRUPT');
 const sparse={...r.state,records:new Array(1)};assert.throws(()=>f.policy.inspect(sparse,A),e=>e.code==='DELIVERABILITY_FIELDS');
 let accessed=false;const e=f.event();Object.defineProperty(e,'recipientRef',{enumerable:true,get(){accessed=true;return A;}});
 await assert.rejects(f.policy.admitEvent(e,CONTEXT),e=>e.code==='DELIVERABILITY_FIELDS');assert.equal(accessed,false);
 await assert.rejects(f.policy.admitEvent(f.event({eventId:'synthetic-address@example.invalid'}),CONTEXT),e=>!e.message.includes('example.invalid'));
 assert.equal(r.state.records.length,1);assert.equal(JSON.stringify(r.state).includes('synthetic-event-1'),false);assert.equal(JSON.stringify(r.state).includes('synthetic-dispatch-1'),false);
});
test('thresholds must be explicit valid integers and no default operational verifier is created',()=>{
 for(const softBounceAttempts of [undefined,0,-1,1.5,101,NaN])assert.throws(()=>P.createPolicy({brand:'fish',softBounceAttempts,providers:['provider_a'],verifyClassifiedEvent:()=>null}),e=>e.code==='DELIVERABILITY_CONFIG');
 assert.throws(()=>P.createPolicy({brand:'fish',softBounceAttempts:3,providers:['provider_a']}),e=>e.code==='DELIVERABILITY_FIELDS');
 const f=fixture({limit:100});assert.equal(f.policy.inspect(f.policy.initialState(),A).authorizesSend,false);
});
