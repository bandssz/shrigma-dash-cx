'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const J = require('../influs-tts-actions.js');
const endpoint = 'https://example.invalid/tiktok-action';
const request = {brand:'fish',application_id:'12345678901234567890',result:'APPROVE'};
const receipt = (patch={}) => ({status:200,body:{ok:true,linhas:[{application_id:request.application_id,status:'AWAITING_SHIPMENT',decisao:'manual_aprovada'}]},...patch});
function storage() { const data = new Map(); return {data,getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)}; }
function locks() { const held = new Set(); return {request:async (name,options,work)=>{assert.equal(options.ifAvailable,true);assert.equal(options.mode,'exclusive');if(held.has(name))return work(null);held.add(name);try{return await work({name});}finally{held.delete(name);}}}; }
const journal = (s=storage(),l=locks(),extra={}) => J.create({storage:s,locks:l,endpoint,...extra});

test('reserves with durable readback before HTTP and stores no request credentials or author',async()=>{
 const s=storage(),j=journal(s);let calls=0;
 const result=await j.run({...request,k:'secret-fixture',autor:'Fixture author',body:'must not persist'},async()=>{calls++;assert.equal(j.inspect(request).state,'pending');return receipt();});
 assert.equal(calls,1);assert.equal(result.ok,true);assert.equal(j.inspect(request).state,'confirmed');
 const stored=[...s.data.values()][0];assert.doesNotMatch(stored,/secret-fixture|Fixture author|must not persist/);
 assert.deepEqual(Object.keys(JSON.parse(stored)).sort(),['application_id','brand','endpoint','result','state','version']);
 await assert.rejects(j.run(request,async()=>{calls++;return receipt();}),{code:'TTS_DECISION_RECORDED'});assert.equal(calls,1);
});
test('two tabs sharing a lock cannot submit twice, change decision or bypass through another endpoint',async()=>{
 const s=storage(),l=locks(),a=journal(s,l),b=journal(s,l,{endpoint:'https://other.invalid/action'});let finish,started;const began=new Promise(r=>started=r);let calls=0;
 const first=a.run(request,async()=>{calls++;started();await new Promise(r=>finish=r);return receipt();});await began;
 await assert.rejects(b.run({...request,result:'REJECT'},async()=>{calls++;return receipt();}),{code:'TTS_OUTCOME_UNKNOWN'});
 finish();await first;
 await assert.rejects(b.run({...request,result:'REJECT'},async()=>{calls++;return receipt();}),{code:'TTS_DECISION_RECORDED'});assert.equal(calls,1);
});
test('timeout, empty body, wrong identity, missing status and refusal stay blocked after reload',async()=>{
 for(const answer of [()=>{throw Error('network secret');},()=>({status:200,body:null}),()=>receipt({body:{ok:true,linhas:[{application_id:'other',status:'AWAITING_SHIPMENT',decisao:'manual_aprovada'}]}}),()=>({body:receipt().body}),()=>({status:403,body:{ok:false}}),()=>({status:200,body:{ok:false}})]){
  const s=storage();let calls=0;const a=journal(s);
  await assert.rejects(a.run(request,async()=>{calls++;return answer();}),{code:'TTS_OUTCOME_UNKNOWN'});assert.equal(a.inspect(request).state,'unknown');
  const reloaded=journal(s);await assert.rejects(reloaded.run({...request,result:'REJECT',k:'different'},async()=>{calls++;return receipt();}),{code:'TTS_OUTCOME_UNKNOWN'});assert.equal(calls,1);
  assert.doesNotMatch([...s.data.values()].join(''),/secret|different/);
 }
});
test('a persisted in-flight reservation survives page death before a receipt',async()=>{
 const s=storage(),l=locks(),first=journal(s,l);let started;const began=new Promise(r=>started=r);
 void first.run(request,async()=>{started();await new Promise(()=>{});});await began;
 const reopened=journal(s,locks());assert.equal(reopened.inspect(request).state,'pending');let calls=0;
 await assert.rejects(reopened.run(request,async()=>{calls++;return receipt();}),{code:'TTS_OUTCOME_UNKNOWN'});assert.equal(calls,0);
});
test('without Web Locks or a durable readable journal no transport can start',async()=>{
 const broken=[{storage:storage(),locks:null},{storage:null,locks:locks()},{storage:{getItem(){throw Error();},setItem(){}},locks:locks()},{storage:{getItem:()=>null,setItem(){throw Error();}},locks:locks()},{storage:{getItem:()=>null,setItem(){}},locks:locks()}];
 for(const options of broken){let calls=0;const j=J.create({endpoint,...options});await assert.rejects(j.run(request,async()=>{calls++;return receipt();}));assert.equal(calls,0);}
});
test('a failed final persistence leaves the original pending reservation and never clears it',async()=>{
 const s=storage(),put=s.setItem;let writes=0;s.setItem=(key,value)=>{if(++writes>1)throw Error('quota');put(key,value);};const j=journal(s);
 await assert.rejects(j.run(request,async()=>receipt()),{code:'TTS_OUTCOME_UNKNOWN'});assert.equal(j.inspect(request).state,'pending');
 const reopened=journal(s);await assert.rejects(reopened.run(request,async()=>{throw Error('must not run');}),{code:'TTS_OUTCOME_UNKNOWN'});
});
test('malformed journal fails closed; changing endpoint or adding URL credentials cannot create a bypass',async()=>{
 const s=storage();s.setItem(J.PREFIX+request.brand+':'+request.application_id,'broken');const j=journal(s);assert.equal(j.inspect(request).state,'blocked');
 await assert.rejects(j.run(request,async()=>receipt()),{code:'TTS_JOURNAL_INVALID'});
 for(const url of ['https://key@example.invalid/write','https://example.invalid/write?k=secret','https://example.invalid/write#secret','http://example.invalid/write'])assert.equal(journal(storage(),locks(),{endpoint:url}).available(),false);
});
test('identity is separate by brand, canonicalized for leading zeros, and opposite receipts cannot confirm',async()=>{
 const s=storage(),j=journal(s);await j.run(request,async()=>receipt());
 await assert.rejects(j.run({...request,application_id:'000'+request.application_id},async()=>receipt()),{code:'TTS_DECISION_RECORDED'});
 assert.equal(j.inspect({...request,brand:'aristo'}),null);
 const fresh=journal();await assert.rejects(fresh.run({...request,result:'REJECT'},async()=>receipt()),{code:'TTS_OUTCOME_UNKNOWN'});
});
