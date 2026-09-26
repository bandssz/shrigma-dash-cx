'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),J=require('../growth-email-test');
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
function setup({store,locks,mode='accepted',endpoint='https://example.invalid/templates',actor='panel:fixture',previewBody=null,operations=null,key=()=> 'do-not-persist-this-key'}={}){
 const data=new Map();store||={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};let held=false;locks||={request:async(k,o,f)=>{if(held)return f(null);held=true;try{return await f({});}finally{held=false;}}};
 const calls=[],ops=operations||new Map();let seq=0;const client=J.create({endpoint,key,storage:store,locks,crypto:{randomUUID:()=>id(++seq)},fetch:async(url,o)=>{calls.push({url,method:o.method,...(o.body?{body:JSON.parse(o.body)}:{})});assert.equal(o.headers.Authorization,'Bearer do-not-persist-this-key');assert.equal(o.redirect,'error');assert.equal(new URL(url).searchParams.has('k'),false);
  if(o.method==='POST'){const p=JSON.parse(o.body);assert.equal(JSON.parse(store.getItem(J.SLOT)).operations.at(-1).phase,'pending');assert.equal(p.k,undefined);const {acao,...payload}=p;if(mode==='missing')throw Error('lost');ops.set(p.idempotency_key,{idempotency_key:p.idempotency_key,actor,state:mode,http_accepted:mode==='accepted',request_payload:payload,request_sha256:'a'.repeat(64),request_hash_schema:'postgres-jsonb-text-sha256-v1',draft_id:p.draft_id,version:p.expected_version,ses:{},...mode==='rejected'?{code:'recipient_opted_out'}:{}});throw Error('POST response lost');}
  const q=new URL(url).searchParams;if(q.get('acao')==='email_teste_previa')return {status:200,json:async()=>(previewBody||{contract:J.CONTRACT,eligible:true})};const identity=q.get('idempotency_key');return {status:200,json:async()=>({contract:J.CONTRACT,operation:ops.get(identity)||{idempotency_key:identity,actor,state:'missing',request_payload:null}})};
 }});return {client,store,locks,calls,ops};
}
const input={draft_id:'d_fixture',expected_version:1,confirm:'enviar_teste'};
test('client persists before one POST and exact lookup resolves a lost acceptance without claiming delivery',async()=>{const s=setup();const r=await s.client.run(input);assert.equal(r.phase,'confirmed');assert.equal(r.operation.http_accepted,true);assert.deepEqual(r.operation.ses,{});assert.deepEqual(s.calls.map(c=>c.method),['GET','POST','GET']);assert.doesNotMatch(s.store.getItem(J.SLOT),/do-not-persist-this-key|Authorization/);await assert.rejects(s.client.run(input),{code:'TEST_ALREADY_ATTEMPTED'});await s.client.reconcile(id(1));assert.equal(s.calls.filter(c=>c.method==='POST').length,1);});
test('unknown receipt survives reload, actor/endpoint change and repeated explicit run without another POST',async()=>{const s=setup({mode:'missing'});await assert.rejects(s.client.run(input),{code:'TEST_UNKNOWN'});const same=setup({store:s.store,locks:s.locks});await assert.rejects(same.client.run(input),{code:'TEST_ALREADY_ATTEMPTED'});await assert.rejects(same.client.reconcile(id(1)),{code:'TEST_UNKNOWN'});const other=setup({store:s.store,endpoint:'https://different.invalid/templates'});await assert.rejects(other.client.reconcile(id(1)),{code:'TEST_ORIGIN'});assert.equal(s.calls.filter(c=>c.method==='POST').length,1);assert.equal(same.calls.filter(c=>c.method==='POST').length,0);});
test('definite refusal stays a refusal and optional SES data never changes HTTP acceptance',async()=>{const s=setup({mode:'rejected'});const r=await s.client.run(input);assert.equal(r.phase,'rejected');assert.equal(r.operation.http_accepted,false);s.ops.get(id(1)).ses={delivery:'2099-01-01T00:00:00Z'};const q=await s.client.reconcile(id(1));assert.equal(q.operation.http_accepted,false);assert.equal(q.phase,'rejected');});
test('storage failure, malformed input or missing Web Locks stop before any POST',async()=>{const s=setup({store:{getItem:()=>null,setItem:()=>{throw Error('quota');}}});await assert.rejects(s.client.run(input),{code:'TEST_STORAGE'});assert.equal(s.calls.filter(c=>c.method==='POST').length,0);for(const extra of [{recipient:'other@example.invalid'},{confirm:'yes'},{cc:['a@b.invalid']}])await assert.rejects(s.client.run({...input,...extra}),{code:'TEST_INPUT'});const t=setup({locks:{}});await assert.rejects(t.client.run(input),{code:'TEST_LOCK'});assert.equal(t.calls.length,0);});
test('current key and endpoint are fixed throughout the in-flight attempt',async()=>{let value='do-not-persist-this-key';const s=setup({key:()=>value});const r=s.client.run(input);value='different';await r;assert.equal(s.calls.filter(c=>c.method==='POST').length,1);});
test('two clients sharing origin lock cannot prepare concurrent POSTs; the loser preserves the winner journal',async()=>{
 let release;const gate=new Promise(r=>release=r);let held=false;
 const locks={request:async(k,o,fn)=>{if(held)return fn(null);held=true;try{await gate;return await fn({});}finally{held=false;}}};
 const a=setup({locks}),b=setup({locks,store:a.store});const pending=a.client.run(input);
 await assert.rejects(b.client.run(input),{code:'TEST_BUSY'});release();await pending;
 assert.equal(a.calls.filter(c=>c.method==='POST').length,1);assert.equal(b.calls.length,0);
 assert.equal(b.client.inspect().operations[0].phase,'confirmed');
});
test('unknown HTTP with matched SES delivery remains distinct; corrupt or mismatched receipt cannot replace a known result',async()=>{
 const s=setup({mode:'outcome_unknown'});assert.equal((await s.client.run(input)).phase,'unknown');
 const op=s.ops.get(id(1));op.ses={delivery:'2099-01-01T00:00:00Z',arbitrary:'ignored'};
 const r=await s.client.reconcile(id(1));assert.equal(r.phase,'confirmed');assert.equal(r.operation.http_accepted,false);assert.deepEqual(r.operation.ses,{delivery:'2099-01-01T00:00:00Z'});
 op.actor='panel:different';await assert.rejects(s.client.reconcile(id(1)),{code:'TEST_UNKNOWN'});assert.equal(s.client.inspect().operations[0].phase,'confirmed');
 op.actor='panel:fixture';op.request_hash_schema='unknown';await assert.rejects(s.client.reconcile(id(1)),{code:'TEST_UNKNOWN'});
 assert.equal(s.calls.filter(c=>c.method==='POST').length,1);
});
test('corrupt journal fails closed before either preflight or POST',async()=>{const s=setup();s.store.setItem(J.SLOT,'{invalid');await assert.rejects(s.client.run(input),{code:'TEST_STORAGE'});assert.equal(s.calls.length,0);assert.equal(s.client.inspect().blocked,true);});
const nativePreview=(patch={})=>({contract:J.CONTRACT,render_policy:J.NATIVE_POLICY,preview_token:'b'.repeat(64),source_hash:'c'.repeat(64),eligible:true,code:'ready',draft_id:input.draft_id,version:input.expected_version,recipient:'felipebandeira@oaristocrata.com',brand:'fish',body_html:'<p>Fixture</p>',rendered_subject:'✅ FINAL — Fixture',...patch});
const nativeInput=(preview=nativePreview())=>({...input,render_policy:preview.render_policy,preview_token:preview.preview_token});
test('native preview token persists before the single POST; policy stays local and exact v1 receipt can confirm it',async()=>{
 const s=setup({previewBody:nativePreview()});const preview=await s.client.preview(input);assert.equal(preview.render_policy,J.NATIVE_POLICY);assert.equal(s.store.getItem(J.SLOT),null);
 const r=await s.client.run(nativeInput(preview));assert.equal(r.phase,'confirmed');const post=s.calls.find(c=>c.method==='POST').body;assert.equal(post.preview_token,preview.preview_token);assert.equal(post.render_policy,undefined);assert.equal(Object.keys(post).length,6,'five request fields plus action');
 const op=JSON.parse(s.store.getItem(J.SLOT)).operations[0];assert.equal(op.render_policy,J.NATIVE_POLICY);assert.equal(op.request_payload.preview_token,preview.preview_token);assert.equal(r.operation.request_payload.preview_token,preview.preview_token);assert.equal(op.source_hash,undefined);assert.equal(op.body_html,undefined);
 await s.client.reconcile(op.id);assert.equal(s.calls.filter(c=>c.method==='POST').length,1);
});
test('native input without an eligible matching preview, missing policy/token or downgraded four-field request stops before a journal or POST',async()=>{
 const s=setup({previewBody:nativePreview()});await assert.rejects(s.client.run(nativeInput()),{code:'TEST_PREVIEW'});assert.equal(s.calls.length,0);assert.equal(s.store.getItem(J.SLOT),null);
 await s.client.preview(input);
 for(const p of [{...input,preview_token:'b'.repeat(64)},{...input,render_policy:J.NATIVE_POLICY},{...nativeInput(),render_policy:'unrecognized'},{...nativeInput(),preview_token:'malformed'}])await assert.rejects(s.client.run(p),{code:'TEST_INPUT'});
 await assert.rejects(s.client.run({...nativeInput(),preview_token:'d'.repeat(64)}),{code:'TEST_PREVIEW'});await assert.rejects(s.client.run(input),{code:'TEST_PREVIEW'});assert.equal(s.calls.filter(c=>c.method==='POST').length,0);assert.equal(s.store.getItem(J.SLOT),null);
});
test('malformed or foreign native preview fails closed, while an ineligible native preview has no token and permits no send',async()=>{
 for(const patch of [{render_policy:'unknown'},{preview_token:null},{source_hash:'bad'},{draft_id:'d_different'},{version:2},{recipient:'other@example.invalid'},{brand:'other'},{body_html:null},{rendered_subject:'No prefix'}]){const s=setup({previewBody:nativePreview(patch)});await assert.rejects(s.client.preview(input),{code:'TEST_PREVIEW'});assert.equal(s.calls.filter(c=>c.method==='POST').length,0);assert.equal(s.store.getItem(J.SLOT),null);}
 const s=setup({previewBody:{contract:J.CONTRACT,render_policy:J.NATIVE_POLICY,eligible:false,code:'recipient_opted_out'}});assert.equal((await s.client.preview(input)).eligible,false);await assert.rejects(s.client.run(nativeInput()),{code:'TEST_PREVIEW'});
});
test('native unknown attempt survives reload with token and is only reconciled; altered token in a receipt cannot replace it',async()=>{
 const s=setup({mode:'outcome_unknown',previewBody:nativePreview()});await s.client.preview(input);const result=await s.client.run(nativeInput());assert.equal(result.phase,'unknown');
 const reload=setup({store:s.store,locks:s.locks,operations:s.ops});const op=reload.client.inspect().operations[0];assert.equal(op.render_policy,J.NATIVE_POLICY);assert.equal(op.request_payload.preview_token,'b'.repeat(64));assert.equal((await reload.client.reconcile(op.id)).phase,'unknown');assert.equal(reload.calls.filter(c=>c.method==='POST').length,0);
 s.ops.get(op.id).request_payload.preview_token='d'.repeat(64);await assert.rejects(reload.client.reconcile(op.id),{code:'TEST_UNKNOWN'});assert.equal(reload.client.inspect().operations[0].request_payload.preview_token,'b'.repeat(64));assert.equal(reload.client.inspect().operations[0].phase,'unknown');
 await assert.rejects(reload.client.run(input),{code:'TEST_ALREADY_ATTEMPTED'});assert.equal(reload.calls.filter(c=>c.method==='POST').length,0);
});
test('mixed legacy/native journal remains readable; unsupported policy or inconsistent persisted token blocks before any request',async()=>{
 const s=setup({previewBody:nativePreview()});await s.client.preview(input);await s.client.run(nativeInput());const native=JSON.parse(s.store.getItem(J.SLOT));
 const legacy=setup();await legacy.client.run({...input,draft_id:'d_other'});const old=JSON.parse(legacy.store.getItem(J.SLOT));old.operations[0].id=id(99);old.operations[0].request_payload.idempotency_key=id(99);old.operations[0].receipt.idempotency_key=id(99);old.operations[0].receipt.request_payload.idempotency_key=id(99);native.operations.push(old.operations[0]);s.store.setItem(J.SLOT,JSON.stringify(native));assert.equal(s.client.inspect().blocked,false);assert.equal(s.client.inspect().operations.length,2);
 for(const change of [op=>delete op.render_policy,op=>{op.render_policy='unknown';},op=>{op.request_payload.preview_token='bad';}]){const bad=structuredClone(native);change(bad.operations[0]);s.store.setItem(J.SLOT,JSON.stringify(bad));const read=setup({store:s.store});assert.equal(read.client.inspect().blocked,true);await assert.rejects(read.client.run(input),{code:'TEST_STORAGE'});assert.equal(read.calls.length,0);}
});
