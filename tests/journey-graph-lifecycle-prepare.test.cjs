'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const C=require('../n8n/growth/journey-graph-lifecycle-contract.cjs');
const R=require('../n8n/growth/journey-graph-release.cjs');
const {createLifecyclePreparer,ENABLED,SESSION_SQL}=require('../n8n/growth/journey-graph-lifecycle-prepare.cjs');
const {fixture,id,read,authorization}=require('./journey-graph-lifecycle-prepare-fixture.cjs');
for(const brand of ['fish','aristo']){
 test(brand+': real catalog/release material is durably prepared; original runtime head and native source stay intact',async t=>{
  const f=await fixture(t,brand),before=await f.get(),native=(await f.db.query('SELECT * FROM templates ORDER BY id')).rows;
  const reviewed=await f.review();assert.equal(reviewed.state,'reviewed');assert.equal(await f.count('lifecycle_review_v1'),1);assert.equal(await f.count('message_release_v1'),0);
  const p=f.request(reviewed),result=await f.prepare(p),v=result.prepared;assert.equal(result.state,'prepared');assert.equal(ENABLED,false);assert.equal(f.api.enabled,false);
  assert.equal(v.message.release_id,result.receipt.release_id);assert.equal(C.digest(v),result.receipt.prepared_hash);assert.equal(C.digest({definition:v.definition,catalog:v.operational_catalog}),v.content_hash);
  const release=(await f.db.query('SELECT * FROM crm_graph_candidate.message_release_v1')).rows[0];
  assert.deepEqual(v.material,R.prepareMaterial(release.source,{purchasePolicy:R.PURCHASE_POLICY.version}));assert.deepEqual(v.material,release.material);
  const hash=(await f.db.query("SELECT encode(sha256(convert_to(material::text,'UTF8')),'hex') hash FROM crm_graph_candidate.message_release_v1")).rows[0].hash;
  assert.equal(v.message.material_sha256,hash);assert.notEqual(v.message.material_plan_hash,hash,'canonical JSON and PostgreSQL jsonb hashes are deliberately distinct');
  assert.equal(v.readiness.material_complete,true);assert.equal(v.readiness.runtime_graph_valid,false);assert.equal(v.readiness.eligibility_available,false);assert.equal(v.readiness.native_cache_bound,false);assert.equal(v.revision_reserved,false);
  assert.equal(v.operational_catalog.fields.find(x=>x.key==='contact.email_allowed').available,false);assert.equal(v.operational_catalog.fields.find(x=>x.key==='purchase.observed_for_cart').max_age_seconds,5);
  assert.ok(v.blockers.some(x=>x.code==='runtime_fields_unavailable'));for(const target of [v,result.receipt])for(const k of ['authorizes_publish','authorizes_activate','authorizes_enrollment','authorizes_send'])assert.equal(target[k],false);
  assert.deepEqual(await f.get(),before);assert.deepEqual((await f.db.query('SELECT * FROM templates ORDER BY id')).rows,native);
  assert.equal(await f.count('revision'),1);assert.equal(await f.count('entry'),0);assert.equal(await f.count('intent'),0);assert.equal(await f.count('operation'),1);assert.equal((await f.db.query('SELECT enabled FROM crm_graph_candidate.control')).rows[0].enabled,false);
  assert.deepEqual(await f.operation(p,createLifecyclePreparer(f.options)),result);assert.deepEqual(await f.prepare(p),result);assert.equal(await f.count('lifecycle_prepared_v1'),1);assert.equal(await f.count('message_release_request_v1'),1);
  // Prepared id is deliberately absent from the runtime revision/publication namespace.
  assert.deepEqual((await f.db.query('SELECT head_revision,published_revision,paused FROM crm_graph_candidate.journey')).rows,[{head_revision:1,published_revision:null,paused:true}]);
 });
 test(brand+': CAS, actor, revoked submit, forged review and current source drift refuse preparation before material writes',async t=>{
  const f=await fixture(t,brand),r=await f.review(),p=f.request(r);
  await assert.rejects(f.prepare({...p,review_hash:'0'.repeat(64)}),{code:'GRAPH_PREPARE_REVIEW'});
  await assert.rejects(f.api.prepare(p,{authorization:'Bearer synthetic-other-key'}),{code:'GRAPH_PREPARE_REVIEW'});
  await f.db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"read_content\",\"validate\"]' WHERE principal_id='manager'");await assert.rejects(f.prepare(p),{code:'GRAPH_PREPARE_ACCESS'});
  await f.db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"read_content\",\"validate\",\"submit\"]' WHERE principal_id='manager'");
  await f.db.query('UPDATE templates SET subject=$1 WHERE id=$2',['Mudou',brand==='fish'?60:95]);await assert.rejects(f.prepare(p),{code:'GRAPH_PREPARE_DRIFT'});
  assert.equal(await f.count('lifecycle_prepared_v1'),0);assert.equal(await f.count('message_release_v1'),0);
  await f.runtime.save({request_id:id(900),actor:'panel:manager',brand,journey_id:f.original.journey_id,expected_version:1,definition:f.definition});await assert.rejects(f.prepare(p),{code:'GRAPH_PREPARE_VERSION'});
 });
}
test('checkout and control row incarnation are pinned; restoring OFF does not silently revive an older review',async t=>{
 const f=await fixture(t),r=await f.review(),p=f.request(r);
 await assert.rejects(f.prepare(p,createLifecyclePreparer({...f.options,checkoutSha:'b'.repeat(40)})),{code:'GRAPH_PREPARE_REVIEW'});
 await f.db.query('UPDATE crm_graph_candidate.control SET enabled=true');await assert.rejects(f.prepare(p),{code:'GRAPH_PREPARE_CONTROL'});
 await f.db.query('UPDATE crm_graph_candidate.control SET enabled=false');await assert.rejects(f.prepare(p),{code:'GRAPH_PREPARE_DRIFT'});assert.equal(await f.count('message_release_v1'),0);
});
test('review TTL and source slot changes cannot be revived with a caller-supplied timestamp or hash',async t=>{
 const f=await fixture(t),r=await f.review(),p=f.request(r);f.offset(30001);await assert.rejects(f.prepare(p),{code:'GRAPH_PREPARE_REVIEW_EXPIRED'});f.offset(0);
 await assert.rejects(f.prepare({...p,checked_at:new Date().toISOString()}),{code:'GRAPH_LIFECYCLE_INPUT'});
 await f.db.query("UPDATE shrigma_flow_definition SET published_version=published_version+1 WHERE brand='fish'");await assert.rejects(f.prepare(p),{code:'GRAPH_PREPARE_DRIFT'});assert.equal(await f.count('message_release_v1'),0);
});
test('uncertain commit is reconciled only by an explicit authenticated read, including after new draft/control state',async t=>{
 const f=await fixture(t),p=f.request(await f.review());let commits=0;
 f.control.after=sql=>{if(sql==='COMMIT'&&++commits===1)throw Error('synthetic lost acknowledgement');};
 await assert.rejects(f.prepare(p),{code:'GRAPH_PREPARE_OUTCOME_UNKNOWN',request_id:p.request_id});assert.equal(commits,1);f.control.after=null;
 assert.equal(await f.count('lifecycle_prepared_v1'),1);const first=await f.operation(p);
 await f.runtime.save({request_id:id(900),actor:'panel:manager',brand:'fish',journey_id:f.original.journey_id,expected_version:1,definition:{...f.definition,name:'Changed after commit'}});
 await f.db.query('UPDATE crm_graph_candidate.control SET enabled=true');
 await f.db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"read_content\"]' WHERE principal_id='manager'");
 const before=f.calls.length;assert.deepEqual(await f.operation(p,createLifecyclePreparer(f.options)),first);assert.equal(first.prepared.base.version,1);assert.equal(f.calls.slice(before).some(sql=>/INSERT|UPDATE|release_prepare_v1/.test(sql)),false);
 await assert.rejects(f.prepare(p),{code:'GRAPH_PREPARE_ACCESS'});await f.db.query("UPDATE crm_dash_chave SET revogada_em=now() WHERE chave='manager'");await assert.rejects(f.operation(p),{code:'GRAPH_PREPARE_ACCESS'});
});
test('lost review acknowledgement supplies its durable hash for explicit readback without repeating review writes',async t=>{
 const f=await fixture(t);let once=true,lost;
 f.control.after=sql=>{if(sql==='COMMIT'&&once){once=false;throw Error('Synthetic lost review ACK');}};
 try{await f.review();assert.fail('Expected uncertain acknowledgement');}catch(e){lost=e;}
 assert.equal(lost.code,'GRAPH_PREPARE_OUTCOME_UNKNOWN');assert.match(lost.review_hash,/^[a-f0-9]{64}$/);assert.equal(lost.brand,'fish');f.control.after=null;
 const before=f.calls.length,r=await f.api.reviewRecord({brand:lost.brand,review_hash:lost.review_hash},{authorization});assert.equal(r.state,'reviewed');assert.equal(r.review.review_hash,lost.review_hash);assert.equal(await f.count('lifecycle_review_v1'),1);assert.equal(f.calls.slice(before).some(sql=>/INSERT|UPDATE/.test(sql)),false);
 assert.equal((await f.api.reviewRecord({brand:'aristo',review_hash:lost.review_hash},{authorization})).state,'unconfirmed');
 assert.equal((await f.api.reviewRecord({brand:'fish',review_hash:lost.review_hash},{authorization:'Bearer synthetic-other-key'})).state,'unconfirmed');
 const next=createLifecyclePreparer({...f.options,checkoutSha:'b'.repeat(40)});assert.deepEqual(await next.reviewRecord({brand:lost.brand,review_hash:lost.review_hash},{authorization}),r,'historical read remains valid after a code checkout changes');
});
test('unknown absence, actor and brand isolation never recreate a release or disclose another receipt',async t=>{
 const f=await fixture(t),p=f.request(await f.review());const absent=await f.operation(p);assert.equal(absent.state,'unconfirmed');assert.equal(absent.automatic_retry,false);assert.equal(await f.count('message_release_v1'),0);
 const done=await f.prepare(p);await assert.rejects(f.operation({...p,brand:'aristo'}),{code:'GRAPH_PREPARE_NOT_FOUND'});await assert.rejects(f.operation(p,f.api,'Bearer synthetic-other-key'),{code:'GRAPH_PREPARE_NOT_FOUND'});
 await assert.rejects(f.prepare({...p,expected_version:2}),{code:'GRAPH_PREPARE_REPLAY_MISMATCH'});
 await assert.rejects(f.prepare({...p,request_id:id(800)}),{code:'GRAPH_PREPARE_REVIEW_CONSUMED'});assert.deepEqual(await f.operation(p),done);assert.equal(await f.count('message_release_request_v1'),1);
});
test('failure after release and before receipt rolls back the whole preparation without touching the runtime',async t=>{
 const f=await fixture(t),p=f.request(await f.review());f.control.before=sql=>{if(sql.startsWith('INSERT INTO crm_graph_candidate.lifecycle_prepare_operation_v1'))throw Error('raw synthetic credential SQL');};
 await assert.rejects(f.prepare(p),e=>e.code==='GRAPH_PREPARE_UNAVAILABLE'&&!e.message.includes('credential'));f.control.before=null;
 for(const table of ['message_release_v1','message_release_request_v1','lifecycle_prepared_v1','lifecycle_prepare_operation_v1'])assert.equal(await f.count(table),0,table);
 assert.equal(await f.count('revision'),1);assert.equal((await f.operation(p)).state,'unconfirmed');
});
test('an unconfirmed rollback discards the exclusive connection instead of allowing a future borrower to commit it',async t=>{
 const f=await fixture(t),p=f.request(await f.review());let broken=true,cleanup=Promise.resolve(),discards=0;
 const pool={async connect(){await cleanup;return {async query(sql,args){if(broken&&(sql==='ROLLBACK'||sql.startsWith('INSERT INTO crm_graph_candidate.lifecycle_prepare_operation_v1')))throw Error('Synthetic broken socket');return f.db.query(sql,args);},release(error){if(error){discards++;cleanup=f.db.query('ROLLBACK');}}};}};
 await assert.rejects(f.prepare(p,createLifecyclePreparer({...f.options,pool})),{code:'GRAPH_PREPARE_OUTCOME_UNKNOWN',request_id:p.request_id});assert.equal(discards,1);await cleanup;broken=false;
 assert.equal((await f.operation(p)).state,'unconfirmed');assert.equal(await f.count('message_release_v1'),0);assert.equal(await f.count('lifecycle_prepared_v1'),0);
});
test('expiry while material is being prepared rolls back release and receipt as one unit',async t=>{
 const f=await fixture(t),p=f.request(await f.review());
 f.control.after=sql=>{if(sql.startsWith('SELECT crm_graph_candidate.release_prepare_v1'))f.offset(30001);};
 await assert.rejects(f.prepare(p),{code:'GRAPH_PREPARE_REVIEW_EXPIRED'});f.control.after=null;f.offset(0);
 assert.equal(await f.count('message_release_v1'),0);assert.equal(await f.count('lifecycle_prepared_v1'),0);
});
test('key and review expiry at the final session check still abort all prepared rows before COMMIT',async t=>{
 for(const keyExpiry of [false,true]){
  const f=await fixture(t),p=f.request(await f.review());let written=false,fenced=false;
  f.control.after=async sql=>{
   if(sql.startsWith('INSERT INTO crm_graph_candidate.lifecycle_prepare_operation_v1'))written=true;
   if(written&&!fenced&&sql===SESSION_SQL){fenced=true;if(keyExpiry)await f.db.query("UPDATE crm_dash_chave SET expira_em=clock_timestamp()-interval '1 millisecond' WHERE chave='manager'");else f.offset(30001);}
  };
  await assert.rejects(f.prepare(p),{code:keyExpiry?'GRAPH_PREPARE_ACCESS':'GRAPH_PREPARE_REVIEW_EXPIRED'});f.control.after=null;assert.equal(fenced,true);assert.equal(await f.count('message_release_v1'),0);assert.equal(await f.count('lifecycle_prepared_v1'),0);assert.equal(await f.count('lifecycle_prepare_operation_v1'),0);
 }
});
test('permission is checked after the operation lock and again after material generation',async t=>{
 for(const late of [false,true]){
  const f=await fixture(t),p=f.request(await f.review());let changed=false;
  f.control.after=async sql=>{if(!changed&&(late?sql.startsWith('SELECT crm_graph_candidate.release_prepare_v1'):sql.startsWith('SELECT pg_catalog.pg_advisory_xact_lock'))){changed=true;await f.db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"read_content\",\"validate\"]' WHERE principal_id='manager'");}};
  await assert.rejects(f.prepare(p),{code:'GRAPH_PREPARE_ACCESS'});f.control.after=null;assert.equal(changed,true);assert.equal(await f.count('message_release_v1'),0);assert.equal(await f.count('lifecycle_prepared_v1'),0);
 }
});
test('wall-clock key expiry during lock wait or after material generation rolls back despite shared helper now()',async t=>{
 for(const late of [false,true]){
  const f=await fixture(t),p=f.request(await f.review());let waited=false;
  // Expiry is set after BEGIN, so transaction-start now() remains earlier.
  f.control.after=async sql=>{if(!waited&&(late?sql.startsWith('SELECT crm_graph_candidate.release_prepare_v1'):sql.startsWith('SELECT pg_catalog.pg_advisory_xact_lock'))){waited=true;await f.db.query("UPDATE crm_dash_chave SET expira_em=clock_timestamp()+interval '20 milliseconds' WHERE chave='manager'");await new Promise(resolve=>setTimeout(resolve,60));const old=(await f.db.query("SELECT public.shrigma_panel_operator_v1('synthetic-manager-key','growth') auth")).rows[0].auth;assert.equal(old.who,'panel:manager','legacy now() alone still accepts the expired key');}};
  await assert.rejects(f.prepare(p),{code:'GRAPH_PREPARE_ACCESS'});f.control.after=null;assert.equal(waited,true);assert.equal(await f.count('message_release_v1'),0);assert.equal(await f.count('lifecycle_prepared_v1'),0);
 }
});
test('current long and short manager keys bind to the same review, actor and receipt',async t=>{
 const f=await fixture(t),r=await f.api.review(f.reviewRequest,{authorization:'Bearer synshort'}),p=f.request(r),done=await f.api.prepare(p,{authorization:'Bearer synshort'});
 assert.deepEqual(await f.operation(p),done);assert.deepEqual(await f.api.reviewRecord({brand:'fish',review_hash:r.review.review_hash},{authorization}),r);assert.equal((await f.db.query('SELECT actor FROM crm_graph_candidate.lifecycle_prepare_operation_v1')).rows[0].actor,'panel:manager');
});
test('a credential hash matching multiple active principals is rejected instead of adopting the helper first row',async t=>{
 const f=await fixture(t),r=await f.review(),p=f.request(r);
 await f.db.query("UPDATE crm_dash_chave SET chave_hash_curta=(SELECT chave_hash_curta FROM crm_dash_chave WHERE chave='manager') WHERE chave='other'");
 await assert.rejects(f.api.prepare(p,{authorization:'Bearer synshort'}),{code:'GRAPH_PREPARE_ACCESS'});assert.equal(await f.count('message_release_v1'),0);
});
test('expiry during historical receipt/read/replay cannot return an authenticated result',async t=>{
 for(const action of ['operation','prepare','reviewRecord']){
  const f=await fixture(t),r=await f.review(),p=f.request(r);await f.prepare(p);let waited=false;
  await f.db.query("UPDATE crm_dash_chave SET expira_em=clock_timestamp()+interval '120 milliseconds' WHERE chave='manager'");
  f.control.after=async sql=>{if(!waited&&(action==='reviewRecord'?sql.startsWith('SELECT * FROM crm_graph_candidate.lifecycle_review_v1'):sql.startsWith('SELECT o.*'))){waited=true;await new Promise(resolve=>setTimeout(resolve,200));}};
  const call=action==='operation'?f.operation(p):action==='prepare'?f.prepare(p):f.api.reviewRecord({brand:'fish',review_hash:r.review.review_hash},{authorization});
  await assert.rejects(call,{code:'GRAPH_PREPARE_ACCESS'});f.control.after=null;assert.equal(waited,true);assert.equal(await f.count('lifecycle_prepared_v1'),1);
 }
});
test('server timeout must already be bounded, READ COMMITTED is checked, and neither can be replaced by a JS timer',async t=>{
 const f=await fixture(t),p=f.request(await f.review());
 for(const setting of ['0','31s']){await f.db.query('SET statement_timeout=\''+setting+'\'');const before=f.calls.length;await assert.rejects(f.prepare(p),{code:'GRAPH_PREPARE_SESSION'});assert.equal(f.calls.slice(before).some(s=>s.startsWith('BEGIN')),false);}
 await f.db.query("SET statement_timeout='20s'");await f.db.query("SET default_transaction_isolation='repeatable read'");await assert.rejects(f.prepare(p),{code:'GRAPH_PREPARE_SESSION'});await f.db.query("SET default_transaction_isolation='read committed'");
 let changed=false;f.control.after=async sql=>{if(!changed&&sql.startsWith('SELECT pg_catalog.pg_advisory_xact_lock')){changed=true;await f.db.query("SET LOCAL statement_timeout='0'");}};
 await assert.rejects(f.prepare(p),{code:'GRAPH_PREPARE_SESSION'});assert.equal(await f.count('message_release_v1'),0);
});
test('durable rows reject edits/deletes, and re-installation cannot overwrite preparation or enable runtime',async t=>{
 const f=await fixture(t),p=f.request(await f.review());await f.prepare(p);
 for(const table of ['lifecycle_review_v1','lifecycle_prepared_v1','lifecycle_prepare_operation_v1'])for(const sql of ['UPDATE crm_graph_candidate.'+table+' SET brand=brand','DELETE FROM crm_graph_candidate.'+table])await assert.rejects(f.db.query(sql),/GRAPH_IMMUTABLE/);
 await assert.rejects(f.db.exec(read('n8n/growth/journey-graph-lifecycle-prepare.sql')),/already exists/);assert.equal(await f.count('lifecycle_prepared_v1'),1);assert.equal((await f.db.query('SELECT enabled FROM crm_graph_candidate.control')).rows[0].enabled,false);
});
test('corrupt canonical receipt or PostgreSQL material digest is rejected on readback',async t=>{
 for(const material of [false,true]){
  const f=await fixture(t),p=f.request(await f.review());await f.prepare(p);
  if(material){await f.db.query('ALTER TABLE crm_graph_candidate.message_release_v1 DISABLE TRIGGER graph_release_immutable');await f.db.query("UPDATE crm_graph_candidate.message_release_v1 SET material_sha256=repeat('0',64)");}
  else{await f.db.query('ALTER TABLE crm_graph_candidate.lifecycle_prepared_v1 DISABLE TRIGGER lifecycle_prepared_immutable');await f.db.query("UPDATE crm_graph_candidate.lifecycle_prepared_v1 SET prepared_hash=repeat('0',64)");}
  await assert.rejects(f.operation(p),{code:'GRAPH_PREPARE_CORRUPT'});
 }
});
test('readback rejects a receipt that changes the pinned base version even when the prepared hash is untouched',async t=>{
 const f=await fixture(t),p=f.request(await f.review());await f.prepare(p);
 await f.db.query('ALTER TABLE crm_graph_candidate.lifecycle_prepare_operation_v1 DISABLE TRIGGER lifecycle_prepare_operation_immutable');
 await f.db.query("UPDATE crm_graph_candidate.lifecycle_prepare_operation_v1 SET response=jsonb_set(response,'{base_version}','99')");
 await assert.rejects(f.operation(p),{code:'GRAPH_PREPARE_CORRUPT'});
});
test('a structurally unsupported review returns human blockers and persists no review, material or prepared revision',async t=>{
 const f=await fixture(t),definition={...f.definition,nodes:f.definition.nodes.filter(n=>n.type!=='message'),edges:[{from:'entry',port:'next',to:'end'}]};
 await f.runtime.save({request_id:id(910),actor:'panel:manager',brand:'fish',journey_id:f.original.journey_id,expected_version:1,definition});
 const result=await f.api.review({...f.reviewRequest,expected_version:2},{authorization});assert.equal(result.state,'blocked');assert.ok(result.review.blockers.some(b=>b.code==='message_count'&&b.message.length>30));
 assert.equal(await f.count('lifecycle_review_v1'),0);assert.equal(await f.count('message_release_v1'),0);assert.equal(await f.count('lifecycle_prepared_v1'),0);
});
test('inputs never accept actor, publication, enrollment, native ids or a fabricated checkout pin',async t=>{
 const f=await fixture(t),p=f.request(await f.review());const before=f.calls.length;
 for(const extra of [{actor:'panel:manager'},{catalog:{}},{native_id:60},{checkout_sha:'b'.repeat(40)},{source_ref:id(3)}])await assert.rejects(f.prepare({...p,...extra}),{code:'GRAPH_LIFECYCLE_INPUT'});
 await assert.rejects(f.api.prepare({...p,action:'publish'},{authorization}));await assert.rejects(f.api.prepare(p,{authorization:'not-a-header'}),{code:'GRAPH_PREPARE_ACCESS'});assert.equal(f.calls.length,before);
 assert.deepEqual(Object.keys(f.api),['enabled','review','reviewRecord','prepare','operation']);assert.equal(await f.count('message_release_v1'),0);
});
