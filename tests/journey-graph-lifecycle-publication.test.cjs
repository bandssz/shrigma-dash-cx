'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../n8n/growth/journey-graph-lifecycle-contract.cjs');
const Catalog=require('../n8n/growth/journey-graph-catalog.cjs');
const {createLifecyclePublisher}=require('../n8n/growth/journey-graph-lifecycle-publication.cjs');
const {fixture,id,authorization,read}=require('./journey-graph-lifecycle-prepare-fixture.cjs');
async function setup(t){
 const f=await fixture(t);await f.db.exec(read('n8n/growth/journey-graph-lifecycle-publication.sql'));
 const api=createLifecyclePublisher(f.options),review=await f.review(),prepared=await f.prepare(f.request(review));
 let seq=500;const request=(over={})=>({action:'publish',brand:f.brand,journey_id:f.original.journey_id,expected_version:f.original.version,request_id:id(seq++),prepared_revision:prepared.prepared.proposed_revision,prepared_hash:prepared.receipt.prepared_hash,confirm:'publicar',...over});
 const publish=(p,target=api,auth=authorization)=>target.publish(p,{authorization:auth});
 const operation=(p,target=api,auth=authorization)=>target.operation({action:'operation',brand:p.brand,request_id:p.request_id},{authorization:auth});
 return {...f,api,prepared,request,publish,operation};
}
test('contract permits the normal version 1 to immutable revision 2 publication',()=>{
 assert.doesNotThrow(()=>C.validateRequest({action:'publish',brand:'fish',journey_id:id(1),expected_version:1,request_id:id(2),prepared_revision:2,prepared_hash:'a'.repeat(64),confirm:'publicar'}));
 assert.throws(()=>C.validateRequest({action:'activate',brand:'fish',journey_id:id(1),expected_version:1,request_id:id(2),published_revision:2,publication_hash:'a'.repeat(64),admission_review_hash:'b'.repeat(64),confirm:'ativar'}),{code:'GRAPH_LIFECYCLE_INPUT'});
});
test('publishes a paused immutable revision in the same journey and preserves all prior rows',async t=>{
 const f=await setup(t),p=f.request();await f.db.query("INSERT INTO crm_graph_candidate.entry(id,journey_id,revision,brand,source_ref,event_key,source_identity_hash,identity,state,created_at,updated_at) VALUES($1,$2,1,$3,$4,repeat('a',64),repeat('b',64),'{}','{}',now(),now())",[id(901),f.original.journey_id,f.brand,id(902)]);const done=await f.publish(p);
 assert.equal(done.state,'published_paused');assert.equal(done.receipt.version,2);assert.equal(done.receipt.published_revision,2);assert.equal(done.receipt.paused,true);
 assert.equal(done.receipt.authorizes_activate,false);assert.equal(done.receipt.authorizes_enrollment,false);assert.equal(done.receipt.authorizes_send,false);
 const journey=(await f.db.query('SELECT * FROM crm_graph_candidate.journey WHERE id=$1',[f.original.journey_id])).rows[0];assert.deepEqual({version:journey.version,head:journey.head_revision,published:journey.published_revision,paused:journey.paused},{version:2,head:2,published:2,paused:true});
 const revisions=await f.db.query('SELECT revision FROM crm_graph_candidate.revision WHERE journey_id=$1 ORDER BY revision',[f.original.journey_id]);assert.deepEqual(revisions.rows.map(x=>x.revision),[1,2]);
 assert.ok(f.calls.includes('LOCK TABLE public.shrigma_flow_definition,public.templates,public.shrigma_template_email_registry IN SHARE MODE'));assert.equal(await f.count('entry'),1);assert.equal((await f.db.query('SELECT revision FROM crm_graph_candidate.entry')).rows[0].revision,1);assert.equal(await f.count('intent'),0);assert.equal((await f.db.query('SELECT enabled FROM crm_graph_candidate.control')).rows[0].enabled,false);
 assert.deepEqual(await f.publish(p),done);assert.deepEqual(await f.operation(p),done);const status=await f.api.status({action:'status',brand:f.brand,journey_id:f.original.journey_id},{authorization});assert.equal(status.state,'published_paused');assert.deepEqual(status.definition,f.prepared.prepared.definition);assert.deepEqual(status.catalog,f.prepared.prepared.operational_catalog);assert.deepEqual(status.receipt,done.receipt);assert.equal(await f.count('lifecycle_publication_v1'),1);
});
test('prepare and publication share one request-id namespace under the same operation lock',async t=>{
 const f=await setup(t),prepareId=f.prepared.receipt.request_id;
 await assert.rejects(f.publish(f.request({request_id:prepareId})),{code:'GRAPH_PUBLICATION_REPLAY_MISMATCH'});
 const p=f.request();await f.publish(p);await assert.rejects(f.prepare({...f.prepared.request_payload,request_id:p.request_id}),{code:'GRAPH_PREPARE_REPLAY_MISMATCH'});
 assert.ok(f.calls.filter(x=>x.startsWith('SELECT pg_catalog.pg_advisory_xact_lock')).every((x,i)=>true));
});
test('server derives revision CAS from the locked prepared snapshot rather than trusting a hash',async t=>{
 for(const over of [{expected_version:2},{prepared_revision:3},{prepared_hash:'0'.repeat(64)}]){const f=await setup(t),p=f.request(over);await assert.rejects(f.publish(p),e=>['GRAPH_PUBLICATION_VERSION','GRAPH_PUBLICATION_NOT_FOUND'].includes(e.code));assert.equal(await f.count('lifecycle_publication_v1'),0);assert.equal(await f.count('revision'),1);}
});
test('fresh control, source, catalog and checkout drift fail before creating a revision',async t=>{
 for(const drift of ['control','source','catalog','checkout']){const f=await setup(t),p=f.request();let api=f.api;if(drift==='control')await f.db.query('UPDATE crm_graph_candidate.control SET enabled=false');if(drift==='source')await f.db.query("UPDATE templates SET subject=subject||' mudou' WHERE id=60");if(drift==='catalog')api=createLifecyclePublisher({...f.options,catalogFor:async options=>{const c=await Catalog.catalogFor(options);c.fields[0].available=!c.fields[0].available;return c;}});if(drift==='checkout')api=createLifecyclePublisher({...f.options,checkoutSha:'b'.repeat(40)});await assert.rejects(f.publish(p,api),e=>['GRAPH_PUBLICATION_DRIFT','GRAPH_PUBLICATION_CORRUPT'].includes(e.code));assert.equal(await f.count('revision'),1);assert.equal(await f.count('lifecycle_publication_v1'),0);}
});
test('late authorization loss and receipt write failure roll back journey and revision',async t=>{
 for(const authLoss of [false,true]){const f=await setup(t),p=f.request();f.control.before=async sql=>{if(authLoss&&sql.startsWith('INSERT INTO crm_graph_candidate.lifecycle_publication_v1'))await f.db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"read_content\"]' WHERE principal_id='manager'");if(!authLoss&&sql.startsWith('INSERT INTO crm_graph_candidate.lifecycle_publication_operation_v1'))throw Error('synthetic receipt failure');};await assert.rejects(f.publish(p),{code:authLoss?'GRAPH_PUBLICATION_ACCESS':'GRAPH_PUBLICATION_UNAVAILABLE'});f.control.before=null;assert.equal(await f.count('revision'),1);assert.equal((await f.db.query('SELECT version FROM crm_graph_candidate.journey')).rows[0].version,1);assert.equal(await f.count('lifecycle_publication_v1'),0);}
});
test('lost COMMIT acknowledgement returns unknown and authenticated operation reconciles without POST replay',async t=>{
 const f=await setup(t),p=f.request();let once=true,lost;f.control.after=sql=>{if(sql==='COMMIT'&&once){once=false;throw Error('lost ack');}};try{await f.publish(p);assert.fail('expected unknown');}catch(e){lost=e;}assert.equal(lost.code,'GRAPH_PUBLICATION_OUTCOME_UNKNOWN');assert.equal(lost.request_id,p.request_id);f.control.after=null;const found=await f.operation(p);assert.equal(found.state,'published_paused');assert.equal(await f.count('lifecycle_publication_v1'),1);assert.equal(await f.count('revision'),2);
});
test('status reports an unpublished journey as draft without prepared material',async t=>{const f=await setup(t),status=await f.api.status({action:'status',brand:f.brand,journey_id:f.original.journey_id},{authorization});assert.equal(status.state,'draft');assert.equal(status.server.published_revision,null);assert.equal(Object.hasOwn(status,'definition'),false);assert.equal(Object.hasOwn(status,'catalog'),false);});
test('operation is read-only, actor scoped, and absence never creates a publication',async t=>{
 const f=await setup(t),p=f.request();assert.equal((await f.operation(p)).state,'unconfirmed');assert.equal(await f.count('revision'),1);await f.publish(p);await assert.rejects(f.operation(p,f.api,'Bearer synthetic-other-key'),{code:'GRAPH_PUBLICATION_NOT_FOUND'});const before=f.calls.length;await f.operation(p);assert.equal(f.calls.slice(before).some(x=>/^INSERT|^UPDATE/.test(x)),false);
});
