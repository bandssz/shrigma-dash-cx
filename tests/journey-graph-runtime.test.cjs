'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {createGraphRuntime,ENABLED}=require('../n8n/growth/journey-graph-runtime.cjs');
const {fixture,faultPool,id}=require('./fixtures/journey-graph-runtime.cjs');
const sql=fs.readFileSync(path.join(__dirname,'../n8n/growth/journey-graph-store.sql'),'utf8');
async function setup(t,brand='fish'){
 const db=new PGlite();t.after(()=>db.close());await db.exec(sql);
 const pool={async connect(){return {query:db.query.bind(db),release(){}};}};
 return {db,pool,...fixture(pool,brand)};
}
const count=async(f,table)=>Number((await f.query('SELECT count(*) n FROM crm_graph_candidate.'+table)).rows[0].n);

test('exclusive installation rejects any schema collision without resetting state',async t=>{
 const f=await setup(t);assert.equal(ENABLED,false);
 assert.equal((await f.query('SELECT enabled FROM crm_graph_candidate.control')).rows[0].enabled,false);
 await f.query('UPDATE crm_graph_candidate.control SET enabled=true');
 await assert.rejects(f.db.exec(sql),/already exists/);await f.db.exec('ROLLBACK');
 assert.equal((await f.query('SELECT enabled FROM crm_graph_candidate.control')).rows[0].enabled,true);
 const other=new PGlite();t.after(()=>other.close());await other.exec('CREATE SCHEMA crm_graph_candidate; CREATE TABLE crm_graph_candidate.keep(value int); INSERT INTO crm_graph_candidate.keep VALUES(7)');
 await assert.rejects(other.exec(sql),/already exists/);await other.exec('ROLLBACK');
 assert.deepEqual((await other.query('SELECT * FROM crm_graph_candidate.keep')).rows,[{value:7}]);
 assert.equal((await other.query("SELECT to_regclass('crm_graph_candidate.control') AS t")).rows[0].t,null);
});
test('publication is paused, resume is disabled by default; confirmation, version and catalog drift are checked',async t=>{
 const f=await setup(t);let j=await f.api.create(f.request({definition:f.graph}));
 await assert.rejects(f.api.pause(f.request({journey_id:j.journey_id,expected_version:j.version,paused:false,confirm:'retomar'})),{code:'GRAPH_EXECUTION_DISABLED'});
 await assert.rejects(f.api.publish(f.request({journey_id:j.journey_id,expected_version:j.version,confirm:'yes'})),{code:'GRAPH_CONFIRM_REQUIRED'});
 f.catalog.messages[0].release='synthetic-release-2';
 await assert.rejects(f.api.publish(f.request({journey_id:j.journey_id,expected_version:j.version,confirm:'publicar'})),{code:'GRAPH_CATALOG_CHANGED'});
 f.catalog.messages[0].release='synthetic-release-1';j=await f.api.publish(f.request({journey_id:j.journey_id,expected_version:j.version,confirm:'publicar'}));
 assert.equal(j.paused,true);assert.equal(j.authorizes_send,false);
 await assert.rejects(f.enroll(j),{code:'GRAPH_EXECUTION_DISABLED'});
 await assert.rejects(f.api.save(f.request({journey_id:j.journey_id,expected_version:1,definition:f.graph})),{code:'GRAPH_VERSION_CONFLICT'});
});
test('immutable revisions pin existing entries while new publication pauses and uses a new revision',async t=>{
 const f=await setup(t);const j=await f.ready(),entry=await f.enroll(j);
 const definition=f.copy(f.graph);definition.nodes[1].seconds=120;
 let next=await f.api.save(f.request({journey_id:j.journey_id,expected_version:j.version,definition}));assert.equal(next.published_revision,1);
 next=await f.api.publish(f.request({journey_id:j.journey_id,expected_version:next.version,confirm:'publicar'}));assert.equal(next.paused,true);assert.equal(next.published_revision,2);
 assert.equal((await f.step(entry)).kind,'paused');
 next=await f.api.pause(f.request({journey_id:j.journey_id,expected_version:next.version,paused:false,confirm:'retomar'}));
 assert.equal((await f.enroll(next)).entry_id,entry.entry_id);
 let e=await f.step(entry);f.setTime('2026-09-25T12:01:00.000Z');e=await f.step(e);assert.equal(e.node_id,'condition');assert.equal(e.revision,1);
 f.proof.event_id='another-synthetic-event';const newer=await f.enroll(next);assert.equal(newer.revision,2);
 await assert.rejects(f.query('UPDATE crm_graph_candidate.revision SET content_hash=$1',[ '0'.repeat(64)]),/GRAPH_IMMUTABLE/);
 await assert.rejects(f.query('DELETE FROM crm_graph_candidate.revision'),/GRAPH_IMMUTABLE/);
 await assert.rejects(f.query('UPDATE crm_graph_candidate.journey SET published_revision=999'),/foreign key constraint/);
});
test('source identity is server-derived, fresh and deduplicated; divergent immutable payload and cross-brand requests fail',async t=>{
 const f=await setup(t);const j=await f.ready(),entry=await f.enroll(j);
 assert.equal((await f.enroll(j)).entry_id,entry.entry_id);assert.equal(await count(f,'entry'),1);
 f.proof.source_revision='changed-event';await assert.rejects(f.enroll(j),{code:'GRAPH_SOURCE_CHANGED'});f.proof.source_revision='immutable-cart-revision-1';
 f.proof.subject_id=id(901);await assert.rejects(f.step(entry),{code:'GRAPH_SOURCE_CHANGED'});f.proof.subject_id=id(900);
 f.proof.brand='aristo';await assert.rejects(f.step(entry),{code:'GRAPH_SOURCE_IDENTITY'});f.proof.brand='fish';
 await assert.rejects(f.api.step({...f.request({entry_id:entry.entry_id,expected_version:entry.version}),brand:'aristo'}),{code:'GRAPH_NOT_FOUND'});
 await assert.rejects(f.api.step({...f.request({entry_id:entry.entry_id,expected_version:entry.version}),facts:{'purchase.confirmed':false}}),{code:'GRAPH_INPUT_SHAPE'});
 for(const change of [{complete:false},{observed_at:'2026-09-25T12:01:00.000Z'},{observed_at:'2026-09-25T11:54:59.000Z',occurred_at:'2026-09-25T11:00:00.000Z'}]){f.overrideSource(()=>({...f.proof,...change}));await assert.rejects(f.step(entry),{code:'GRAPH_SOURCE_UNCONFIRMED'});}
 assert.equal(await count(f,'intent'),0);
});
test('unknown purchase never chooses No and expiry remains absolute after restart',async t=>{
 const f=await setup(t);const j=await f.ready();let e=await f.atCondition(j);delete f.proof.facts['purchase.confirmed'];
 e=await f.step(e);assert.equal(e.kind,'wait_data');assert.equal(e.node_id,'condition');assert.equal(e.next_due_at,'2026-09-25T12:01:30.000Z');
 f.setTime('2026-09-25T12:03:00.000Z');f.proof.facts['purchase.confirmed']={value:false,complete:true,observed_at:f.now()};
 e=await f.step(e,createGraphRuntime(f.settings));assert.equal(e.kind,'blocked');assert.equal(e.reason,'data_deadline_expired');assert.equal(await count(f,'intent'),0);
});
test('deterministic waits and purchased exit survive a new adapter instance',async t=>{
 const f=await setup(t,'aristo');const j=await f.ready();let e=await f.enroll(j);e=await f.step(e);
 f.setTime('2026-09-25T12:00:59.999Z');e=await f.step(e,createGraphRuntime(f.settings));assert.equal(e.kind,'wait');assert.equal(e.next_due_at,'2026-09-25T12:01:00.000Z');
 f.setTime('2026-09-25T12:01:00.000Z');e=await f.step(e);f.proof.facts['purchase.confirmed'].value=true;e=await f.step(e);assert.equal(e.node_id,'paid');
 e=await f.step(e);assert.equal(e.state,'completed');assert.equal(await count(f,'intent'),0);
});
test('intent is atomic, contains no contact/event data, cannot send and cannot be created twice',async t=>{
 const f=await setup(t);const j=await f.ready();let e=await f.atMessage(j);e=await f.step(e);assert.equal(e.kind,'message_intent');assert.equal(e.authorizes_send,false);
 const rows=(await f.query('SELECT * FROM crm_graph_candidate.intent')).rows;assert.equal(rows.length,1);assert.equal(rows[0].authorizes_send,false);
 const serialized=JSON.stringify((await f.query('SELECT response FROM crm_graph_candidate.operation')).rows)+JSON.stringify(rows);
 assert.ok(!serialized.includes('synthetic-private-event'));assert.ok(!serialized.includes('Synthetic'));assert.ok(!serialized.includes(id(900)));
 assert.equal((await f.step(e,createGraphRuntime(f.settings))).kind,'await_transport');assert.equal(await count(f,'intent'),1);
 await assert.rejects(f.query('UPDATE crm_graph_candidate.intent SET authorizes_send=true'),/GRAPH_IMMUTABLE/);
 await assert.rejects(f.query("INSERT INTO crm_graph_candidate.intent(entry_id,node_id,attempt_key,brand,channel,binding,release,created_at) VALUES($1,'other','other','aristo','email','cart.email','release',now())",[e.entry_id]),/foreign key constraint/);
});
test('fresh withdrawal or suppression stops before intent and cannot be reopened',async t=>{
 for(const [field,value,reason]of [['consent',false,'consent_withdrawn'],['suppressed',true,'suppressed'],['eligible',false,'source_ineligible']]){
  const f=await setup(t);const j=await f.ready();let e=await f.atMessage(j);f.proof[field]=value;e=await f.step(e);assert.equal(e.kind,'stopped');assert.equal(e.reason,reason);assert.equal(await count(f,'intent'),0);
  f.proof[field]=!value;assert.equal((await f.step(e)).kind,'stopped');
 }
});
test('failure between state and intent rolls back all rows; exact retry creates one intent',async t=>{
 const f=await setup(t);const j=await f.ready(),e=await f.atMessage(j),req=f.request({entry_id:e.entry_id,expected_version:e.version});
 const prior=await count(f,'transition'),control={before:q=>q.startsWith('INSERT INTO crm_graph_candidate.intent')};
 const api=createGraphRuntime({...f.settings,pool:faultPool(f.pool,control)});
 await assert.rejects(api.step(req),/synthetic pre-commit failure/);
 assert.equal(await count(f,'intent'),0);assert.equal(await count(f,'transition'),prior);
 assert.equal((await f.query('SELECT version FROM crm_graph_candidate.entry WHERE id=$1',[e.entry_id])).rows[0].version,e.version);
 control.before=null;const result=await api.step(req);assert.equal(result.kind,'message_intent');assert.deepEqual(await f.api.step(req),result);assert.equal(await count(f,'intent'),1);
 await assert.rejects(f.api.step({...req,expected_version:req.expected_version+1}),{code:'GRAPH_REPLAY_MISMATCH'});
});
test('committed result lost to caller stays unknown until same durable identity is consulted by retry',async t=>{
 const f=await setup(t);const j=await f.ready(),e=await f.atMessage(j),req=f.request({entry_id:e.entry_id,expected_version:e.version});let once=true;
 const api=createGraphRuntime({...f.settings,pool:faultPool(f.pool,{after:q=>q==='COMMIT'&&once?(once=false,true):false})});
 await assert.rejects(api.step(req),{code:'GRAPH_OUTCOME_UNKNOWN',request_id:req.request_id});
 assert.equal(await count(f,'intent'),1);const recovered=await createGraphRuntime(f.settings).step(req);assert.equal(recovered.kind,'message_intent');assert.equal(recovered.authorizes_send,false);assert.equal(await count(f,'intent'),1);
 assert.deepEqual(recovered,(await f.query('SELECT response FROM crm_graph_candidate.operation WHERE request_id=$1',[req.request_id])).rows[0].response);
});
test('unconfirmed rollback discards the connection; a later borrower cannot commit a partial transition',async t=>{
 const f=await setup(t),j=await f.ready(),e=await f.atMessage(j),req=f.request({entry_id:e.entry_id,expected_version:e.version});
 let discards=0,cleanup=Promise.resolve(),fail=true;
 // PGlite has one embedded session: model PoolClient destruction by aborting it
 // before any subsequent borrower; the real PG test checks socket destruction.
 const pool={async connect(){await cleanup;return {async query(q,a){if(fail&&(q==='ROLLBACK'||q.startsWith('INSERT INTO crm_graph_candidate.intent')))throw Error('synthetic broken connection');return f.db.query(q,a);},release(error){if(error){discards++;cleanup=f.db.exec('ROLLBACK');}}};}};
 const api=createGraphRuntime({...f.settings,pool});await assert.rejects(api.step(req),{code:'GRAPH_OUTCOME_UNKNOWN'});assert.equal(discards,1);
 fail=false;const recovered=await api.step(req);assert.equal(recovered.kind,'message_intent');assert.equal(await count(f,'intent'),1);
 assert.equal((await f.query('SELECT count(*)::int n FROM crm_graph_candidate.transition WHERE entry_id=$1 AND entry_version=$2',[e.entry_id,e.version+1])).rows[0].n,1);
});
