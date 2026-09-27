'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createDelivery}=require('../n8n/growth/journey-graph-delivery.cjs');
const id=n=>'40000000-0000-4000-8000-'+String(n).padStart(12,'0'),copy=x=>structuredClone(x);
function setup(brand='fish',overrides={}){
 const address=brand==='fish'?'contato@fishermans.com.br':'contato@oaristocrata.com',name=brand==='fish'?'Fishermans':'O Aristocrata';
 const now=Date.parse('2026-09-27T12:00:00.000Z'),request={brand,intent_id:id(1),expected_entry_version:3};
 const tx={template_id:9000,subscriber_email:'synthetic@example.invalid',from_email:name+' <'+address+'>',headers:[{'Reply-To':address}],data:{checkout_url:'https://'+(brand==='fish'?'fishermans.com.br':'oaristocrata.com')+'/cart/synthetic'},content_type:'html'};
 const grant={should_send:true,dispatch_id:id(2),claim_token:id(3),reason:'claimed',payload:{...copy(tx),content_type:'html',headers:[...tx.headers,{'X-SES-CONFIGURATION-SET':brand==='fish'?'cs-fishermans-tx':'cs-aristocrata-tx'},{'X-SES-MESSAGE-TAGS':'crm_dispatch_id='+id(2)+', crm_test=false'}]},context:{brand,toque:'t05',piece:'carrinho-30min',chave:'cart_t05_at',subscriber_id:1,email:tx.subscriber_email,ref:'2026-09-27T11:30:00.000Z',template_id:9000,tx:copy(tx),graph_intent_id:request.intent_id,graph_expires_at:'2026-09-27T12:00:05.000Z'}};
 const calls={claim:0,transport:0,finish:[],apply:[]},dispatch={contract:'journey_graph_cart_dispatch_v1',brand,intent_id:id(1),entry_id:id(4),revision:1,node_id:'message',attempt_key:'synthetic',dispatch_id:id(2),transport_state:'in_flight'};
 const settings={clock:()=>now,claim:async()=>{calls.claim++;return calls.claim===1?copy(grant):{should_send:false,dispatch_id:id(2),claim_token:null,payload:null,context:null,reason:dispatch.transport_state};},inspect:async()=>copy(dispatch),
  sendTx:async(payload,options)=>{calls.transport++;assert.deepEqual(payload,grant.payload);assert.equal(options.retry,false);assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);return {statusCode:200,body:{data:true}};},
  finish:async input=>{calls.finish.push(copy(input));assert.deepEqual(input.context,grant.context);assert.equal(input.claim_token,grant.claim_token);dispatch.transport_state=input.outcome;},
  applyReceipt:async(p,identity)=>{calls.apply.push({p,identity});assert.equal(p.entry_id,dispatch.entry_id);assert.equal(p.expected_version,3);return {contract:'journey_graph_store_v1',brand,entry_id:dispatch.entry_id,intent_id:id(1),dispatch_id:id(2),transport_state:dispatch.transport_state,authorizes_send:false};}};
 return {now,request,grant,calls,dispatch,settings,api:createDelivery({...settings,...overrides})};
}
test('both brands use the reserved native payload and exact original finish context, then only inspect on replay',async()=>{
 for(const brand of ['fish','aristo']){
  const x=setup(brand);const r=await x.api.deliver(x.request);assert.equal(r.state,'accepted');assert.equal(r.receipt_applied,true);assert.equal(r.transport_started,true);assert.equal(x.calls.transport,1);assert.equal(x.calls.finish.length,1);
  await x.api.reconcile(x.request);await x.api.deliver(x.request);assert.equal(x.calls.transport,1);assert.equal(x.calls.finish.length,1);assert.equal(JSON.stringify(r).includes('synthetic@'),false);assert.equal(JSON.stringify(r).includes('claim_token'),false);
 }
});
test('lost reservation acknowledgement never reaches HTTP; reconciliation never claims again',async()=>{
 const x=setup(),api=createDelivery({...x.settings,claim:async()=>{x.calls.claim++;throw Object.assign(Error('GRAPH_MESSAGE_OUTCOME_UNKNOWN'),{code:'GRAPH_MESSAGE_OUTCOME_UNKNOWN'});}});
 await assert.rejects(api.deliver(x.request),/OUTCOME_UNKNOWN/);assert.equal((await api.reconcile(x.request)).state,'in_flight');assert.equal(x.calls.claim,1);assert.equal(x.calls.transport,0);assert.equal(x.calls.finish.length,0);
});
test('expired grant or foreign brand never starts transport or invents a finish outcome',async()=>{
 const x=setup();const expired=createDelivery({...x.settings,clock:()=>x.now+5000});assert.equal((await expired.deliver(x.request)).state,'reserved_expired');assert.equal(x.calls.transport,0);assert.equal(x.calls.finish.length,0);
 const other=setup('aristo'),foreign=createDelivery({...other.settings,claim:async()=>copy(x.grant)});await assert.rejects(foreign.deliver(other.request),/CLAIM_UNCONFIRMED/);assert.equal(other.calls.transport,0);
});
test('native refusal, ambiguous response and network failure preserve original classifications without retry',async()=>{
 for(const [response,expected] of [[{statusCode:422,body:{data:true}},'rejected'],[{statusCode:500,body:{data:true}},'outcome_unknown'],[{statusCode:200,body:'invalid'},'outcome_unknown'],[null,'outcome_unknown']]){
  const x=setup(),api=createDelivery({...x.settings,sendTx:async()=>{x.calls.transport++;if(response===null)throw Error('synthetic network failure');return response;}});
  const result=await api.deliver(x.request);assert.equal(result.state,expected);assert.equal(x.calls.finish[0].outcome,expected);assert.equal(x.calls.transport,1);await api.reconcile(x.request);assert.equal(x.calls.transport,1);
 }
});
test('transport timeout aborts locally and records unknown once; late completion does not produce another finish',async()=>{
 const x=setup();let signal,complete;const api=createDelivery({...x.settings,timeoutMs:10,sendTx:async(_p,o)=>{x.calls.transport++;signal=o.signal;return new Promise(r=>{complete=r;});}});
 assert.equal((await api.deliver(x.request)).state,'outcome_unknown');assert.equal(signal.aborted,true);complete({statusCode:200,body:{data:true}});await new Promise(r=>setImmediate(r));assert.equal(x.calls.finish.length,1);assert.equal(x.calls.transport,1);
});
test('lost finish response is resolved from durable state; a failure before finish stays in-flight without resending',async()=>{
 for(const committed of [false,true]){
  const x=setup(),api=createDelivery({...x.settings,finish:async input=>{x.calls.finish.push(copy(input));if(committed)x.dispatch.transport_state=input.outcome;throw Error('synthetic lost finish');}});
  assert.equal((await api.deliver(x.request)).state,committed?'accepted':'in_flight');await api.reconcile(x.request);assert.equal(x.calls.transport,1);assert.equal(x.calls.finish.length,1);
 }
});
test('receipt or readback failure exposes a pending result, never private transport data or a retry',async()=>{
 const x=setup(),api=createDelivery({...x.settings,applyReceipt:async()=>{throw Error('synthetic receipt commit lost');}});const r=await api.deliver(x.request);assert.equal(r.state,'accepted');assert.equal(r.receipt_applied,false);assert.equal(x.calls.transport,1);
 const y=setup(),unreadable=createDelivery({...y.settings,inspect:async()=>{throw Error('synthetic private database error');}});const lost=await unreadable.deliver(y.request);assert.equal(lost.state,'unconfirmed');assert.equal(lost.receipt_applied,false);assert.equal(JSON.stringify(lost).includes('private'),false);assert.equal(y.calls.transport,1);
});
