'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const C=require('../n8n/growth/journey-graph-cart.cjs');

const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=c=>c.repeat(64);
const ref='2026-10-01T03:00:00.000Z';
const expires='2026-10-01T03:00:09.000Z';
const intent=uuid(11),dispatch=uuid(12),claim=uuid(13),instance=uuid(14);
const checkout='https://fishermans.com.br/cart/synthetic?discount=SAFE&utm_source=email&utm_medium=fluxo&utm_campaign=fish-carrinho&utm_content=carrinho-30min';
const baseMessage={template_id:71,subscriber_email:'recipient@example.invalid',from_email:'Fishermans <contato@fishermans.com.br>',headers:[{'Reply-To':'contato@fishermans.com.br'}],data:{checkout_url:checkout}};
const context={brand:'fish',toque:'t05',piece:'carrinho-30min',chave:'cart_t05_at',subscriber_id:7,email:'recipient@example.invalid',ref,template_id:71,tx:{...baseMessage,content_type:'html'},graph_intent_id:intent,graph_expires_at:expires};
const payload={...baseMessage,headers:[...baseMessage.headers,{'X-SES-CONFIGURATION-SET':'cs-fishermans-tx'},{'X-SES-MESSAGE-TAGS':`crm_dispatch_id=${dispatch}, crm_test=false`}],content_type:'html'};
const guard={contract:'journey_graph_cache_guard_v1',cache_target:'listmonk-primary',instance_id:instance,template_id:71,subscriber_id:7,native_sha256:hash('a'),snapshot_sha256:hash('b'),dispatch_id:dispatch,token:hash('c'),expires_at:expires};
const claimRow=()=>({should_send:true,dispatch_id:dispatch,claim_token:claim,payload:structuredClone(payload),context:structuredClone(context),reason:'claimed'});
const preflight={brand:'fish',intent_id:intent,source_checkout_url:'https://fishermans.com.br/cart/synthetic?discount=SAFE',message:{template_id:71,data:{checkout_url:checkout}},recipient:{subscriber_id:7},ref};

test('bridge binds a successful native claim to one exact cache guard',async()=>{
 const calls=[];
 const bridge=C.createCartBridge({cacheTarget:'listmonk-primary',query:async(sql,args)=>{
  calls.push({sql,args});
  if(calls.length===1)return {rows:[{result:claimRow()}]};
  if(calls.length===2)return {rows:[{result:guard}]};
  throw Error('unexpected query');
 }});
 const result=await bridge.claim({brand:'fish',intent_id:intent,expected_entry_version:3,preflight});
 assert.deepEqual(result.payload.graph_guard,guard);
 assert.match(calls[0].sql,/cart_claim_v1/);
 assert.match(calls[1].sql,/cache_identity_issue_v1/);
 assert.deepEqual(calls[1].args,['fish',intent,dispatch,'listmonk-primary']);
 assert.equal(calls.length,2);
});

test('losing claim never issues a cache action and uncertain issuance is not replayed',async()=>{
 let calls=0;
 const loser=C.createCartBridge({cacheTarget:'listmonk-primary',query:async()=>{
  calls++;
  return {rows:[{result:{should_send:false,dispatch_id:null,claim_token:null,payload:null,context:null,reason:'in_flight'}}]};
 }});
 assert.equal((await loser.claim({brand:'fish',intent_id:intent,expected_entry_version:3,preflight})).should_send,false);
 assert.equal(calls,1);

 calls=0;
 const uncertain=C.createCartBridge({cacheTarget:'listmonk-primary',query:async()=>{
  calls++;
  if(calls===1)return {rows:[{result:claimRow()}]};
  throw Error('synthetic commit acknowledgement loss');
 }});
 await assert.rejects(uncertain.claim({brand:'fish',intent_id:intent,expected_entry_version:3,preflight}),e=>e.code==='GRAPH_CART_OUTCOME_UNKNOWN');
 assert.equal(calls,2);
});

test('guard shape, target, template, dispatch and expiry are fail closed',()=>{
 assert.deepEqual(C.validateGraphGuard(guard,dispatch,71,7),guard);
 for(const mutate of [
  x=>delete x.token,
  x=>x.extra=true,
  x=>x.cache_target='bad target',
  x=>x.template_id=72,
  x=>x.subscriber_id=8,
  x=>x.dispatch_id=uuid(99),
  x=>x.snapshot_sha256='bad',
  x=>x.expires_at='not-a-time'
 ]){
  const bad=structuredClone(guard);mutate(bad);
  assert.throws(()=>C.validateGraphGuard(bad,dispatch,71,7),/GRAPH_CACHE_GUARD_UNCONFIRMED/);
 }
 const missing=claimRow();
 assert.throws(()=>C.validateClaim(missing),/GRAPH_CART_CLAIM_UNCONFIRMED/);
 missing.payload.graph_guard=guard;
 assert.equal(C.validateClaim(missing).should_send,true);
});

test('migration is OFF, reuses the cart delivery ledger and readiness consumes the live cache proof',()=>{
 const root=path.join(__dirname,'..');
 const sql=fs.readFileSync(path.join(root,'n8n/growth/journey-graph-cache-identity.sql'),'utf8');
 const readiness=fs.readFileSync(path.join(root,'n8n/growth/journey-graph-activation-readiness.sql'),'utf8');
 const tx=fs.readFileSync(path.join(root,'tools/listmonk-regular-build/overlay/graph-cache/cmd/tx.go'),'utf8');
 assert.match(sql,/enabled boolean NOT NULL DEFAULT false/);
 assert.match(sql,/ALTER TABLE crm_graph_candidate\.cart_delivery_v1/);
 assert.doesNotMatch(sql,/CREATE TABLE[^;]*dispatch/i);
 assert.match(sql,/cache_identity_consume_v1/);
 assert.match(readiness,/cache_identity_readiness_v1/);
 assert.doesNotMatch(readiness,/blockers:=blockers\|\|'"cache_identity_unverified"'::jsonb;\s*IF \(SELECT count/s);
 const consume=tx.indexOf('guardedGraphPush');
 const direct=tx.indexOf('pushErr = push()',consume);
 assert.ok(consume>=0&&direct>consume,'guarded and legacy push paths must both remain explicit');
 assert.match(tx,/StatusUnprocessableEntity, "GRAPH_CACHE_GUARD_REJECTED"/);
 assert.match(tx,/StatusServiceUnavailable, "GRAPH_CACHE_GUARD_UNCERTAIN"/);
});
