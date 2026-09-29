'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createLifecyclePreparer}=require('../n8n/growth/journey-graph-lifecycle-prepare.cjs');
const {createLifecyclePublisher}=require('../n8n/growth/journey-graph-lifecycle-publication.cjs');
const {fixture,id,authorization,read}=require('./journey-graph-lifecycle-prepare-fixture.cjs');
function restrictedPool(db){return {async connect(){return {async query(sql,args){const r=await db.query(sql,args);if(sql.startsWith('BEGIN ISOLATION LEVEL'))await db.query('SET LOCAL ROLE crm_audience_api');return r;},release(){}};}};}
async function setup(t){
 const f=await fixture(t);await f.db.exec(read('n8n/growth/journey-graph-lifecycle-publication.sql'));
 await f.db.exec('CREATE ROLE crm_audience_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS');
 await f.db.exec(read('n8n/growth/journey-graph-lifecycle-runtime-access.sql'));
 const options={...f.options,pool:restrictedPool(f.db),runtimeAccess:true},preparer=createLifecyclePreparer(options),publisher=createLifecyclePublisher(options);
 return {...f,options,preparer,publisher};
}
test('restricted API role prepares and publishes through bounded helpers without native write grants',async t=>{
 const f=await setup(t),review=await f.preparer.review(f.reviewRequest,{authorization}),prepareRequest={action:'prepare',brand:f.brand,journey_id:f.original.journey_id,expected_version:1,request_id:id(701),review_hash:review.review.review_hash,confirm:'preparar'},prepared=await f.preparer.prepare(prepareRequest,{authorization});
 const publishRequest={action:'publish',brand:f.brand,journey_id:f.original.journey_id,expected_version:1,request_id:id(702),prepared_revision:2,prepared_hash:prepared.receipt.prepared_hash,confirm:'publicar'},published=await f.publisher.publish(publishRequest,{authorization});
 assert.equal(published.state,'published_paused');assert.equal(published.actor,'panel:manager');assert.equal(published.receipt.version,2);
 const status=await f.publisher.status({action:'status',brand:f.brand,journey_id:f.original.journey_id},{authorization});assert.equal(status.state,'published_paused');assert.equal(status.server.revision,2);
 const role=(await f.db.query("SELECT rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='crm_audience_api'")).rows[0];assert.deepEqual(role,{rolinherit:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false});
 const memberships=(await f.db.query("SELECT count(*)::int n FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.member JOIN pg_roles g ON g.oid=m.roleid WHERE p.rolname='crm_audience_api' OR g.rolname='crm_audience_api'")).rows[0].n;assert.equal(memberships,0);
 for(const [table,column] of [['templates','subject'],['shrigma_flow_definition','published'],['shrigma_template_email_registry','brand']])assert.equal((await f.db.query("SELECT has_column_privilege('crm_audience_api',$1,$2,'UPDATE') ok",['public.'+table,column])).rows[0].ok,false,table);
 assert.equal((await f.db.query("SELECT has_table_privilege('crm_audience_api','crm_graph_candidate.journey','UPDATE') ok")).rows[0].ok,false);
 assert.equal((await f.db.query("SELECT has_table_privilege('crm_audience_api','crm_graph_candidate.lifecycle_publication_v1','INSERT') ok")).rows[0].ok,false);
 assert.equal((await f.db.query("SELECT has_function_privilege('crm_audience_api','crm_graph_candidate.lifecycle_publication_commit_v1(text,jsonb,jsonb,jsonb)','EXECUTE') ok")).rows[0].ok,true);
 assert.equal(await f.count('entry'),0);assert.equal(await f.count('intent'),0);
});
test('fixed helper drift survives P0001 mapping only after a confirmed rollback',async t=>{
 const f=await setup(t),review=await f.preparer.review(f.reviewRequest,{authorization}),prepared=await f.preparer.prepare({action:'prepare',brand:f.brand,journey_id:f.original.journey_id,expected_version:1,request_id:id(711),review_hash:review.review.review_hash,confirm:'preparar'},{authorization});await f.db.query('UPDATE crm_graph_candidate.control SET enabled=false');
 await assert.rejects(f.publisher.publish({action:'publish',brand:f.brand,journey_id:f.original.journey_id,expected_version:1,request_id:id(712),prepared_revision:2,prepared_hash:prepared.receipt.prepared_hash,confirm:'publicar'},{authorization}),{code:'GRAPH_PUBLICATION_DRIFT'});assert.equal(await f.count('revision'),1);assert.equal(await f.count('lifecycle_publication_v1'),0);
});
test('restricted role cannot bypass helpers to edit journey, native sources, credentials or immutable receipts',async t=>{
 const f=await setup(t);
 for(const sql of ["UPDATE crm_graph_candidate.journey SET paused=false","UPDATE public.templates SET subject=subject","UPDATE public.shrigma_flow_definition SET published=published","UPDATE public.shrigma_template_email_registry SET brand=brand","UPDATE public.crm_dash_chave SET ativo=false","DELETE FROM crm_graph_candidate.lifecycle_review_v1"]){await f.db.query('BEGIN');await f.db.query('SET LOCAL ROLE crm_audience_api');await assert.rejects(f.db.query(sql),/permission denied|GRAPH_IMMUTABLE/);await f.db.query('ROLLBACK');}
});
test('commit helper rejects malformed and null authority fields without a partial revision',async t=>{
 const f=await setup(t);await f.db.query('BEGIN');await f.db.query('SET LOCAL ROLE crm_audience_api');await assert.rejects(f.db.query('SELECT crm_graph_candidate.lifecycle_publication_commit_v1($1,$2::jsonb,$3::jsonb,$4::jsonb)',['panel:manager',JSON.stringify({action:'publish'}),JSON.stringify({}),JSON.stringify({})]),/GRAPH_PUBLICATION_INPUT/);await f.db.query('ROLLBACK');assert.equal(await f.count('revision'),1);assert.equal(await f.count('lifecycle_publication_v1'),0);
});
test('runtime access installation refuses unsafe role attributes, memberships and collisions',async t=>{
 const f=await fixture(t);await f.db.exec(read('n8n/growth/journey-graph-lifecycle-publication.sql'));await f.db.exec('CREATE ROLE crm_audience_api LOGIN INHERIT');await assert.rejects(f.db.exec(read('n8n/growth/journey-graph-lifecycle-runtime-access.sql')),/GRAPH_LIFECYCLE_ACCESS_PRECONDITION/);
});

test('runtime access installation rejects native column write grants',async t=>{const f=await fixture(t);await f.db.exec(read('n8n/growth/journey-graph-lifecycle-publication.sql'));await f.db.exec('CREATE ROLE crm_audience_api LOGIN NOINHERIT');await f.db.exec('GRANT UPDATE(subject) ON public.templates TO crm_audience_api');await assert.rejects(f.db.exec(read('n8n/growth/journey-graph-lifecycle-runtime-access.sql')),/GRAPH_LIFECYCLE_ACCESS_PRECONDITION/);});
