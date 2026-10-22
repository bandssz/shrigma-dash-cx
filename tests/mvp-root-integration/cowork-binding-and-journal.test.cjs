 'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const C1 = process.env.CRM_C1_FILES_DIRECTORY;
const C2 = process.env.CRM_C2_FILES_DIRECTORY;
assert.equal(typeof C1, 'string'); assert.equal(typeof C2, 'string');
const A = require(path.join(C1, 'ui/affiliates-v2/affiliates-v2.js'));
const {Document, Event} = require(path.join(C1, 'tests/affiliates-v2/mini-dom.cjs'));
const {setup: organic} = require(path.join(C2, 'tests/organic-v2/harness.cjs'));
const flush = async () => { for (let i = 0; i < 25; i++) await new Promise(r => setImmediate(r)); };
const ctx = () => ({contextRevision:'revision-a', sessionRevision:'session-a', effectiveBrand:'qa-brand-a',
 principalReference:'qa-actor-a',role:'write',sourceRevision:'source-a',pendingOperations:[],
 capabilities:{'creator.create':{available:true},'creator.update':{available:true}}});
const envelope = (revision,data) => ({state:'ready',contextRevision:revision,brandId:'qa-brand-a',source:'own_verified',
 coverage:'complete',freshness:'fresh',collectedAt:'2026-10-06T12:00:00Z',cacheAt:null,data,error:null});
function affiliates(options={}) {
 const document=new Document(),element=document.createElement('div');document.body.appendChild(element);
 const state={context:ctx(),count:{begin:0,submit:0,receipt:0}};
 const op=(i,stateName)=>({operationId:i.operationId||'qa-op-original',contextRevision:i.expectedContextRevision,
  state:stateName,binding:{effectiveBrand:'qa-brand-a',kind:'creator.update',recordId:'qa-creator-a'},
  receiptReference:stateName==='confirmed'?'qa-receipt':null,result:null,reason:null});
 const gateway={context:async()=>structuredClone(state.context),read:async q=>envelope(q.expectedContextRevision,
  q.resource==='creator-profile'?{creator:{id:q.filters.creatorId,brandId:'qa-brand-a'}}:
  q.resource==='own-performance'?{period:'2026-10',currency:'BRL',estimatedMinor:null,accruedMinor:null,settledMinor:null}:
  {items:q.resource==='creators'?[{id:'qa-creator-a',brandId:'qa-brand-a',provider:'synthetic',providerId:'fixture-a',
   displayName:'Synthetic QA creator',stage:'review',revision:1,ownerReference:'qa-owner-a'}]:[]}),
  beginMutation:async i=>{state.count.begin++;return options.begin?options.begin(i,op):op(i,'prepared');},
  submit:async i=>{state.count.submit++;return options.submit?options.submit(i,op):op(i,'confirmed');},
  receipt:async i=>{state.count.receipt++;return options.receipt?options.receipt(i,op):op(i,'pending');}};
 const view=A.create({element,document,gateway});
 const q=s=>element.querySelector(s),click=s=>{const n=q(s);assert.ok(n,'missing '+s);n.click();};
 async function update(){click('[data-saf2-act="open-profile"][data-id="qa-creator-a"]');await flush();
  click('[data-saf2-act="open-form"][data-kind="creator.update"]');
  const input=q('[data-saf2-field="ownerReference"]');input.value='qa-owner-b';input.dispatchEvent(new Event('input'));
  click('[data-saf2-act="form-review"]');click('[data-saf2-act="form-confirm"]');await flush();}
 return {view,element,state,q,click,update};
}
test('C1 valid same-context operation is confirmed once; fixture baseline',async()=>{
 const x=affiliates();try{await x.view.sync();await x.update();assert.equal(x.state.count.begin,1);
 assert.equal(x.state.count.submit,1);assert.equal(x.q('[data-saf2-op="qa-op-original"]').getAttribute('data-saf2-op-state'),'confirmed');}finally{x.view.dispose();}
});
test('C1 prepared envelope from another context/brand must never be submitted',async()=>{
 const x=affiliates({begin:(i,op)=>({...op(i,'prepared'),contextRevision:'other-revision',binding:{effectiveBrand:'qa-brand-b'}})});
 try{await x.view.sync();await x.update();assert.equal(x.state.count.submit,0,'mismatched preparation must close before submit');}
 finally{x.view.dispose();}
});
test('C1 confirmed submit from another context/brand must remain uncertain',async()=>{
 const x=affiliates({submit:(i,op)=>({...op(i,'confirmed'),contextRevision:'other-revision',binding:{effectiveBrand:'qa-brand-b'}})});
 try{await x.view.sync();await x.update();assert.equal(x.q('[data-saf2-op="qa-op-original"]').getAttribute('data-saf2-op-state'),'uncertain');}
 finally{x.view.dispose();}
});
test('C1 recovery receipt from another context must not become confirmed',async()=>{
 const x=affiliates({submit:()=>Promise.reject(Error('synthetic ACK loss')),
 receipt:(i,op)=>({...op(i,'confirmed'),contextRevision:'other-revision',binding:{effectiveBrand:'qa-brand-b'}})});
 try{await x.view.sync();await x.update();assert.equal(x.state.count.submit,1);x.click('[data-saf2-act="receipt"][data-op="qa-op-original"]');await flush();
 assert.equal(x.state.count.submit,1);assert.equal(x.q('[data-saf2-op="qa-op-original"]').getAttribute('data-saf2-op-state'),'uncertain');}
 finally{x.view.dispose();}
});
test('C1 journal absent after lost preparation ACK cannot unlock new operation',async()=>{
 const x=affiliates({begin:()=>Promise.reject(Error('synthetic lost prepared ACK'))});
 try{await x.view.sync();await x.update();assert.equal(x.state.count.begin,1);assert.equal(x.state.count.submit,0);
 delete x.state.context.pendingOperations;await x.view.sync();await flush();
 assert.equal(x.q('[data-saf2-act="open-form"][data-kind="creator.create"]').disabled,true,'journal unavailable is not empty or safe retry');}
 finally{x.view.dispose();}
});
test('C2 malformed journal entries cannot be filtered into a confirmed empty journal',async()=>{
 const x=organic({ctx:{pendingOperations:[{kind:'link.create'}]}});
 try{await x.syncNow();assert.equal(x.q('[data-ov-focus="link-review"]').disabled,true,'missing operationId is not proof of empty journal');
 assert.equal(x.calls.beginMutation.length,0);}finally{x.inst.dispose();}
});

test('Root C1 preparation independently rejects wrong revision, wrong brand and missing binding',async()=>{
 for(const change of [r=>({...r,contextRevision:'other-revision'}),r=>({...r,binding:{effectiveBrand:'qa-brand-b'}}),r=>({...r,binding:{}}),r=>({...r,binding:{effectiveBrand:'qa-brand-a',brandId:'qa-brand-b'}}),r=>({...r,contextRevision:undefined})]) {
  const x=affiliates({begin:(i,op)=>change(op(i,'prepared'))});
  try{await x.view.sync();await x.update();assert.equal(x.state.count.begin,1);assert.equal(x.state.count.submit,0);
   assert.equal(x.q('[data-saf2-act="open-form"][data-kind="creator.create"]').disabled,true);
   assert.equal(x.q('[data-saf2-field="ownerReference"]').value,'qa-owner-b');
   assert.equal(x.q('[data-saf2-op="qa-op-original"]'),null,'unbound operation is not presented as the current-brand journal');
  }finally{x.view.dispose();}
 }
});
test('Root C1 submitted ACK independently rejects wrong revision, brand, ID and absent binding',async()=>{
 for(const change of [r=>({...r,contextRevision:'other-revision'}),r=>({...r,binding:{effectiveBrand:'qa-brand-b'}}),r=>({...r,binding:{}}),r=>({...r,operationId:'foreign-operation'})]) {
  const x=affiliates({submit:(i,op)=>change(op(i,'confirmed'))});
  try{await x.view.sync();await x.update();assert.equal(x.state.count.submit,1);
   assert.equal(x.q('[data-saf2-op="qa-op-original"]').getAttribute('data-saf2-op-state'),'uncertain');
   assert.equal(x.q('[data-saf2-field="ownerReference"]'),null,'waiting draft cannot offer a second submission');
   assert.equal(x.q('[data-saf2-act="open-form"][data-kind="creator.create"]').disabled,true);
  }finally{x.view.dispose();}
 }
});
test('Root C1 receipt rejects wrong revision, brand, ID and absent binding without replay',async()=>{
 for(const change of [r=>({...r,contextRevision:'other-revision'}),r=>({...r,binding:{effectiveBrand:'qa-brand-b'}}),r=>({...r,binding:{}}),r=>({...r,operationId:'foreign-operation'})]) {
  const x=affiliates({submit:()=>Promise.reject(Error('synthetic lost ACK')),receipt:(i,op)=>change(op(i,'confirmed'))});
  try{await x.view.sync();await x.update();x.click('[data-saf2-act="receipt"][data-op="qa-op-original"]');await flush();
   assert.equal(x.state.count.begin,1);assert.equal(x.state.count.submit,1);assert.equal(x.state.count.receipt,1);
   assert.equal(x.q('[data-saf2-op="qa-op-original"]').getAttribute('data-saf2-op-state'),'uncertain');
  }finally{x.view.dispose();}
 }
});
test('Root C1 valid brand binding aliases support same original operation recovery',async()=>{
 for(const field of ['effectiveBrand','brandId','brand']) {
  const x=affiliates({begin:(i,op)=>({...op(i,'prepared'),binding:{[field]:'qa-brand-a'}}),
   submit:()=>Promise.reject(Error('synthetic lost ACK')),receipt:(i,op)=>({...op(i,'confirmed'),binding:{[field]:'qa-brand-a'}})});
  try{await x.view.sync();await x.update();x.click('[data-saf2-act="receipt"][data-op="qa-op-original"]');await flush();
   assert.equal(x.q('[data-saf2-op="qa-op-original"]').getAttribute('data-saf2-op-state'),'confirmed');
   assert.equal(x.state.count.begin,1);assert.equal(x.state.count.submit,1);assert.equal(x.state.count.receipt,1);
  }finally{x.view.dispose();}
 }
});
test('Root C1 context change during preparation keeps original ID and never submits',async()=>{
 let release;
 const x=affiliates({begin:(i,op)=>new Promise(resolve=>{release=()=>resolve(op(i,'prepared'));})});
 try{await x.view.sync();await x.update();x.state.context.contextRevision='revision-b';await x.view.sync();release();await flush();
  assert.equal(x.state.count.submit,0);assert.equal(x.q('[data-saf2-op="qa-op-original"]').getAttribute('data-saf2-op-state'),'uncertain');
  x.click('[data-saf2-act="receipt"][data-op="qa-op-original"]');await flush();
  assert.equal(x.state.count.receipt,1);assert.equal(x.state.count.begin,1);assert.equal(x.state.count.submit,0);
 }finally{x.view.dispose();}
});
test('Root C1 context change during receipt cannot confirm stale response or repeat mutation',async()=>{
 let release,request;
 const x=affiliates({submit:()=>Promise.reject(Error('synthetic lost ACK')),
  receipt:(i,op)=>new Promise(resolve=>{request=structuredClone(i);release=()=>resolve(op(i,'confirmed'));})});
 try{await x.view.sync();await x.update();x.click('[data-saf2-act="receipt"][data-op="qa-op-original"]');await flush();
  x.state.context.contextRevision='revision-b';await x.view.sync();release();await flush();
  assert.deepEqual(request,{operationId:'qa-op-original',expectedContextRevision:'revision-a'});
  assert.equal(x.q('[data-saf2-op="qa-op-original"]').getAttribute('data-saf2-op-state'),'uncertain');
  assert.equal(x.state.count.begin,1);assert.equal(x.state.count.submit,1);assert.equal(x.state.count.receipt,1);
 }finally{x.view.dispose();}
});
test('Root C1 missing or malformed journal never unlocks a lost preparation or loses draft',async()=>{
 for(const journal of [undefined,null,{},[{kind:'creator.update'}],['qa-valid-id',{kind:'creator.update'}],new Array(1)]) {
  const x=affiliates({begin:()=>Promise.reject(Error('synthetic lost preparation ACK'))});
  try{await x.view.sync();await x.update();x.state.context.pendingOperations=journal;await x.view.sync();await flush();
   assert.equal(x.q('[data-saf2-act="open-form"][data-kind="creator.create"]').disabled,true);
   assert.equal(x.q('[data-saf2-field="ownerReference"]').value,'qa-owner-b');
   assert.equal(x.state.count.begin,1);assert.equal(x.state.count.submit,0);
   if(Array.isArray(journal)&&journal[0]==='qa-valid-id')assert.ok(x.q('[data-saf2-act="receipt"][data-op="qa-valid-id"]'));
  }finally{x.view.dispose();}
 }
});
test('Root C1 complete empty journal permits admitted intent, missing journal closes it',async()=>{
 const x=affiliates();try{await x.view.sync();assert.equal(x.q('[data-saf2-act="open-form"][data-kind="creator.create"]').disabled,false);
  delete x.state.context.pendingOperations;await x.view.sync();assert.equal(x.q('[data-saf2-act="open-form"][data-kind="creator.create"]').disabled,true);
  assert.equal(x.state.count.begin,0);assert.equal(x.state.count.submit,0);
 }finally{x.view.dispose();}
});
