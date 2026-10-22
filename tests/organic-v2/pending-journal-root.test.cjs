 'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {setup} = require('./harness.cjs');
const review = t => t.q('[data-ov-focus="link-review"]');
const phase = t => t.q('[data-ov-op]').getAttribute('data-ov-op');
test('Root C2 malformed journal closes review and never calls begin', async () => {
 for (const journal of [[{kind:'link.create'}],[null],[{}],[''],[{} ,{operationId:''}]]) {
  const t=setup({ctx:{pendingOperations:journal}});
  try {await t.syncNow();assert.equal(review(t).disabled,true);await t.review();
   assert.equal(t.calls.beginMutation.length,0);assert.equal(t.calls.submit.length,0);}
  finally {t.inst.dispose();}
 }
});
test('Root C2 mixed journal keeps valid receipt ID while blocking new intent',async()=>{
 const t=setup({ctx:{pendingOperations:[{kind:'link.create'},{operationId:'qa-op-original',kind:'link.create'}]}});
 t.server.journal.set('qa-op-original',{state:'confirmed',binding:{kind:'link.create',effectiveBrand:'aristo'},result:{brandId:'aristo'}});
 try {await t.syncNow();assert.equal(review(t).disabled,true);
  await t.click('[data-ov-pending] [data-ov-action="receipt"]');
  assert.deepEqual(t.calls.receipt,[{operationId:'qa-op-original',expectedContextRevision:'r1'}]);
  assert.equal(phase(t),'confirmed');assert.equal(t.calls.beginMutation.length,0);assert.equal(t.calls.submit.length,0);
  assert.equal(review(t).disabled,true,'malformed journal remains unavailable after receipt refresh');
 }finally {t.inst.dispose();}
});
test('Root C2 malformed journal after lost preparation keeps lock and draft',async()=>{
 const t=setup();try {await t.syncNow();t.modes.begin='throw';await t.review({destination:'https://example.invalid/qa',origin:'instagram_social',surface:'story',campaign:'preserved-qa-draft',date:'2026-10-05'});
  assert.equal(review(t).disabled,true);t.setCtx({pendingOperations:[{kind:'link.create'}]});await t.syncNow();
  assert.equal(review(t).disabled,true);assert.equal(t.q('[data-ov-draft="campaign"]').value,'preserved-qa-draft');
  await t.review();assert.equal(t.calls.beginMutation.length,1);assert.equal(t.calls.submit.length,0);
 }finally {t.inst.dispose();}
});
test('Root C2 malformed journal after lost outcome ACK preserves same-operation recovery',async()=>{
 const t=setup();try {await t.syncNow();await t.review();t.modes.submit='lose-ack';await t.click('[data-ov-action="op-confirm"]');
  assert.equal(phase(t),'uncertain');t.setCtx({pendingOperations:[{kind:'link.create'}]});await t.syncNow();
  assert.equal(phase(t),'uncertain');assert.equal(review(t).disabled,true);await t.click('[data-ov-op] [data-ov-action="receipt"]');
  assert.deepEqual(t.calls.receipt,[{operationId:'op-1',expectedContextRevision:'r1'}]);assert.equal(phase(t),'confirmed');
  assert.equal(t.calls.beginMutation.length,1);assert.equal(t.calls.submit.length,1);assert.equal(review(t).disabled,true);
 }finally {t.inst.dispose();}
});
test('Root C2 complete valid empty journal allows admitted action; valid pending ID closes',async()=>{
 const t=setup();try {await t.syncNow();assert.equal(review(t).disabled,false);t.setCtx({pendingOperations:['qa-pending']});
  await t.syncNow();assert.equal(review(t).disabled,true);assert.ok(t.q('[data-ov-pending] [data-ov-action="receipt"]'));
  t.setCtx({pendingOperations:[]});await t.syncNow();assert.equal(review(t).disabled,false);
  t.setCtx({capabilities:{}});await t.syncNow();assert.equal(review(t).disabled,true);
 }finally {t.inst.dispose();}
});
