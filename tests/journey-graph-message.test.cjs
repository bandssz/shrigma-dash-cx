'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./journey-graph-material-fixture.cjs'),{id}=require('./journey-graph-source-fixture.cjs');
const {createMessagePreflight}=require('../n8n/growth/journey-graph-message.cjs');
async function prepared(t,brand='fish'){
 const x=await fixture(t),f=await x.prepare(brand,true),e=await f.atMessage(),intent=await f.api.step(f.request({entry_id:e.entry_id,expected_version:e.version}));
 const native={contract:'journey_graph_native_v1',native_id:id(9000),brand,release_id:f.release.id,material_sha256:f.release.material_sha256,native_sha256:'b'.repeat(64),cache_target:'synthetic-instance',state:'ready',clone_template_id:9000,cache_ack_at:'2026-01-01T00:00:00.000Z'};
 let mutate=()=>{};const calls=[];
 const resolveNative=async a=>{calls.push(a);const r=structuredClone(native);await mutate(r);return r;};
 const settings={pool:x.pool,readSource:f.settings.readSource,resolveNative,cacheTarget:'synthetic-instance'},api=createMessagePreflight(settings);
 return {...x,f,intent,native,calls,settings,api,request:{brand,intent_id:intent.intent_id},change(fn){mutate=fn;}};
}
test('both brands prepare pinned private payload using fresh facts; no intent reset, dispatch or receipt write',async t=>{
 for(const brand of ['fish','aristo']){
  const x=await prepared(t,brand),before=JSON.stringify((await x.query('SELECT * FROM crm_graph_candidate.entry')).rows),ops=(await x.query('SELECT count(*)::int n FROM crm_graph_candidate.operation')).rows[0].n;
  const p=await x.api.prepare(x.request);assert.equal(p.authorizes_send,false);assert.equal(p.transport,false);assert.equal(p.message.template_id,9000);assert.equal(p.message.subscriber_email,'synthetic@example.invalid');assert.equal(p.recipient.subject_id,id(1));assert.equal(p.ref,x.ref);assert.equal(p.message.subject,undefined);assert.equal(p.message.altbody,undefined);assert.equal(p.message.headers[0]['Reply-To'],brand==='fish'?'contato@fishermans.com.br':'contato@oaristocrata.com');assert.equal(new URL(p.message.data.checkout_url).searchParams.get('utm_campaign'),brand+'-carrinho');assert.ok(Date.parse(p.expires_at)>Date.parse(p.checked_at));
  assert.equal(JSON.stringify((await x.query('SELECT * FROM crm_graph_candidate.entry')).rows),before);assert.equal((await x.query('SELECT count(*)::int n FROM crm_graph_candidate.operation')).rows[0].n,ops);assert.equal((await x.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
  assert.equal(x.calls.length,1);assert.equal(x.calls[0].release_id,x.f.release.id);assert.equal(typeof x.calls[0].query,'function');
  await x.query('UPDATE templates SET subject=$1 WHERE id=$2',['Original changed after publication',brand==='fish'?60:95]);assert.equal((await x.api.prepare(x.request)).material_sha256,p.material_sha256);
 }
});
test('disabled, paused, wrong brand and malformed input never resolve native content',async t=>{
 const x=await prepared(t);await assert.rejects(x.api.prepare({...x.request,brand:'aristo'}),/NOT_FOUND/);await assert.rejects(x.api.prepare({...x.request,template_id:5}),/INPUT/);
 await x.query('UPDATE crm_graph_candidate.control SET enabled=false');await assert.rejects(x.api.prepare(x.request),/DISABLED/);await x.query('UPDATE crm_graph_candidate.control SET enabled=true');await x.query('UPDATE crm_graph_candidate.journey SET paused=true');await assert.rejects(x.api.prepare(x.request),/NOT_PENDING/);assert.equal(x.calls.length,0);
});
test('native clone cache, brand, hash, readiness and receipt shape cannot be substituted',async t=>{
 const x=await prepared(t);
 for(const mutate of [n=>n.brand='aristo',n=>n.release_id=id(777),n=>n.material_sha256='0'.repeat(64),n=>n.cache_target='other-instance',n=>n.state='creating',n=>n.clone_template_id=null,n=>n.native_id='not-uuid',n=>n.cache_ack_at='2099-01-01T00:00:00Z',n=>n.snapshot={},n=>n.native_sha256='short']){x.change(mutate);await assert.rejects(x.api.prepare(x.request),/NATIVE_UNCONFIRMED|EXPIRED/);}
});
test('fresh absence/consent is mandatory again despite prior intent; source identity changes fail',async t=>{
 const x=await prepared(t);
 for(const mutate of [p=>p.subject_id=id(44),p=>p.event_id='changed',p=>p.source_revision='changed',p=>p.occurred_at='2026-01-01T00:00:00.000Z',p=>p.source_ref=id(44),p=>p.facts['purchase.observed_for_cart'].value=true,p=>delete p.facts['purchase.observed_for_cart'],p=>p.facts['contact.email_allowed'].value=false]){
  const api=createMessagePreflight({...x.settings,readSource:async a=>{const p=await x.f.settings.readSource(a);mutate(p);return p;}});await assert.rejects(api.prepare(x.request),/SOURCE_CHANGED|DATA_UNCONFIRMED/);
 }
 await x.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=17");await assert.rejects(x.api.prepare(x.request),/SOURCE_CHANGED|DATA_UNCONFIRMED/);
});
test('native eligibility is reread after clone resolution; failure never leaks database payload',async t=>{
 const x=await prepared(t);x.change(async()=>{await x.query("UPDATE subscribers SET attribs=jsonb_set(attribs,'{fish,last_order_at}',$1::jsonb)",[JSON.stringify(x.ref)]);});await assert.rejects(x.api.prepare(x.request),/SOURCE_CHANGED/);
 const bad=createMessagePreflight({...x.settings,pool:{connect:async()=>({query:async()=>{throw Object.assign(Error('synthetic private query'),{code:'42P01'});},release(){}})}});await assert.rejects(bad.prepare(x.request),e=>e.code==='GRAPH_MESSAGE_UNCONFIRMED'&&!e.message.includes('private'));
});
test('time consumed after source observation invalidates preparation, without resetting its attempt',async t=>{
 const x=await prepared(t);const api=createMessagePreflight({...x.settings,readSource:async a=>{const p=await x.f.settings.readSource(a);p.facts['purchase.observed_for_cart'].observed_at=new Date(Date.parse(a.now)-5001).toISOString();return p;}});await assert.rejects(api.prepare(x.request),/DATA_UNCONFIRMED/);
});

test('optout during native resolution and elapsed preparation budget are refused',async t=>{
 const x=await prepared(t);x.change(async()=>{await x.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=17");});await assert.rejects(x.api.prepare(x.request),/SOURCE_CHANGED/);x.change(()=>{});
 let clockReads=0;
 const api=createMessagePreflight({...x.settings,pool:{connect:async()=>({query:async(q,a)=>{const r=await x.query(q,a);if(q.startsWith("SELECT to_char(date_trunc('milliseconds'")){clockReads++;if(clockReads>1)r.rows[0].now=new Date(Date.parse(r.rows[0].now)+5001).toISOString();}return r;},release(){}})}});
 await assert.rejects(api.prepare(x.request),/EXPIRED/);
});
test('unconfirmed rollback discards connection and never returns private payload',async t=>{
 const x=await prepared(t);let discarded;
 const api=createMessagePreflight({...x.settings,pool:{connect:async()=>({query:async(q,a)=>{if(q==='ROLLBACK')throw Error('synthetic rollback lost');return x.query(q,a);},release(e){discarded=e;}})}});
 await assert.rejects(api.prepare(x.request),/UNCONFIRMED/);assert.ok(discarded);await x.query('ROLLBACK');
});

test('source, graph intent, immutable clone and preflight integrate on both brands through real SQL',async t=>{
 const fs=require('node:fs'),N=require('../n8n/growth/journey-graph-native.cjs');
 for(const brand of ['fish','aristo']){
  const x=await prepared(t,brand);await x.db.exec("ALTER TABLE templates ADD COLUMN is_default boolean NOT NULL DEFAULT false;ALTER TABLE templates ADD COLUMN updated_at timestamptz DEFAULT clock_timestamp();");
  await x.db.exec(fs.readFileSync(require.resolve('../n8n/growth/journey-graph-native.sql'),'utf8'));
  const cacheTarget='synthetic-instance';let posts=0;
  const options={query:x.query,cacheTarget,nativeRead:async()=>{throw Error('unexpected HTTP read');},nativeCreate:async b=>{posts++;const row=(await x.query('INSERT INTO templates(id,name,type,subject,body,body_source) VALUES(9000,$1,$2,$3,$4,$5) RETURNING *',[b.name,b.type,b.subject,b.body,b.body_source])).rows[0];return {status:200,body:{data:row}};}};
  const native=N.createNativeProvider(options),receipt=await native.prepare('panel:synthetic',{request_id:id(9990),brand,release_id:x.f.release.id,expected_material_sha256:x.f.release.material_sha256});
  const settings={...x.settings,resolveNative:({query,...a})=>N.createNativeProvider({...options,query}).resolve(a.brand,a.release_id,a.material_sha256)};
  await assert.rejects(createMessagePreflight(settings).prepare(x.request),/NOT_READY/);
  const ready=await native.create(brand,receipt.native_id);assert.equal(ready.state,'ready');assert.equal(posts,1);
  const p=await createMessagePreflight(settings).prepare(x.request);assert.equal(p.native_id,receipt.native_id);assert.equal(p.message.template_id,9000);assert.equal(p.transport,false);
  await assert.rejects(x.query("UPDATE templates SET body='changed' WHERE id=9000"),/IMMUTABLE/);
  await x.query("UPDATE templates SET subject='Changed editable original' WHERE id=$1",[brand==='fish'?60:95]);assert.equal((await createMessagePreflight(settings).prepare(x.request)).message.template_id,9000);
  await x.query('ALTER TABLE templates DISABLE TRIGGER graph_native_template_guard_v1');await assert.rejects(createMessagePreflight(settings).prepare(x.request),/GUARD_UNAVAILABLE/);
  assert.equal(posts,1);assert.equal((await x.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
 }
});
