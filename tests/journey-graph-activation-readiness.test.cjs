'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const F=require('./journey-graph-lifecycle-prepare-fixture.cjs');
const {createLifecyclePreparer}=require('../n8n/growth/journey-graph-lifecycle-prepare.cjs');
const {createLifecyclePublisher}=require('../n8n/growth/journey-graph-lifecycle-publication.cjs');
const Readiness=require('../n8n/growth/journey-graph-activation-readiness.cjs');
const Browser=require('../growth-journey-graph-api.js');
async function fixture(t,brand){
 const f=await F.fixture(t,brand);await f.db.exec(F.read('n8n/growth/journey-graph-lifecycle-publication.sql'));
 await f.db.exec('CREATE ROLE crm_audience_api LOGIN NOINHERIT;CREATE ROLE crm_graph_worker LOGIN NOINHERIT');
 await f.db.exec(F.read('n8n/growth/journey-graph-lifecycle-runtime-access.sql'));
 await f.db.exec(F.read('n8n/growth/journey-graph-worker-lease.sql'));
 await f.db.exec(F.read('n8n/growth/journey-graph-activation-readiness.sql'));
 const pool={async connect(){return {async query(sql,args){const r=await f.db.query(sql,args);if(sql.startsWith('BEGIN ISOLATION LEVEL'))await f.db.query('SET LOCAL ROLE crm_audience_api');return r;},release(){}};}};
 const options={...f.options,pool,runtimeAccess:true,activationReadiness:true},preparer=createLifecyclePreparer(options),publisher=createLifecyclePublisher(options);
 const review=await preparer.review(f.reviewRequest,{authorization:F.authorization}),prepared=await preparer.prepare(f.request(review),{authorization:F.authorization});
 const published=await publisher.publish({action:'publish',brand,journey_id:f.original.journey_id,expected_version:1,request_id:F.id(4001),prepared_revision:2,prepared_hash:prepared.receipt.prepared_hash,confirm:'publicar'},{authorization:F.authorization});
 const status=()=>publisher.status({action:'status',brand,journey_id:f.original.journey_id},{authorization:F.authorization});
 return {...f,options,preparer,publisher,published,status};
}
for(const brand of ['fish','aristo'])test(brand+': restricted authenticated publication status explains real missing dependencies without writes',async t=>{
 const f=await fixture(t,brand),before=(await f.db.query('SELECT to_jsonb(j) AS row FROM crm_graph_candidate.journey j')).rows;
 const s=await f.status(),r=s.activation_readiness;
 assert.equal(r.state,'blocked');assert.deepEqual(r.blockers,['graph_control_off','maintenance_closed','worker_deployment_off','cache_identity_unverified','native_clone_not_ready','execution_runtime_missing']);
 assert.equal(Browser.validActivationReadiness(r,s.server,s.receipt),true);assert.equal(r.authorizes_activate,false);assert.equal(r.authorizes_enrollment,false);assert.equal(r.authorizes_send,false);
 assert.doesNotMatch(JSON.stringify(r),/worker_sha|runtime_sha|instance_id|panel:|synthetic-manager-key|<html|lease_database/);
 assert.deepEqual((await f.db.query('SELECT to_jsonb(j) AS row FROM crm_graph_candidate.journey j')).rows,before);
 assert.equal(await f.count('entry'),0);assert.equal(await f.count('intent'),0);assert.equal(await f.count('graph_worker_lease_v1'),0);
 for(const sql of ['UPDATE crm_graph_candidate.graph_worker_deployment_v1 SET enabled=true','DELETE FROM crm_graph_candidate.graph_worker_lease_v1','SELECT crm_graph_candidate.graph_worker_readiness_v1()']){
  await f.db.query('BEGIN');await f.db.query('SET LOCAL ROLE crm_audience_api');await assert.rejects(f.db.query(sql),/permission denied/);await f.db.query('ROLLBACK');
 }
 const normal=createLifecyclePublisher({...f.options,activationReadiness:false});assert.equal(Object.hasOwn(await normal.status({action:'status',brand,journey_id:f.original.journey_id},{authorization:F.authorization}),'activation_readiness'),false);
 await f.db.query('UPDATE crm_graph_candidate.control SET enabled=true');const again=await f.status();assert.equal(again.activation_readiness.blockers.includes('graph_control_off'),false);assert.equal(again.server.paused,true);
 await f.db.query('UPDATE crm_dash_chave SET ativo=false');await assert.rejects(f.status(),{code:'GRAPH_PUBLICATION_ACCESS'});
});
test('readiness rejects publication drift, malformed authority, expired data and foreign identity',async t=>{
 const f=await fixture(t,'fish'),s=await f.status(),r=s.activation_readiness,expected=Object.fromEntries(['brand','journey_id','version','published_revision','publication_hash'].map(k=>[k,r[k]]));
 const variants=[{...r,authorizes_activate:true},{...r,state:'ready'},{...r,blockers:[]},{...r,blockers:['injected']},{...r,expires_at:new Date(Date.now()-1).toISOString()},{...r,brand:'aristo'},{...r,pins:{instance_id:F.id(5)}}];
 for(const v of variants){assert.throws(()=>Readiness.validate(v,expected),/GRAPH_PUBLICATION_READINESS_INVALID/);assert.equal(Browser.validActivationReadiness(v,s.server,s.receipt),false);}
 const cacheReady={...r,blockers:r.blockers.filter(x=>x!=='cache_identity_unverified')};
 assert.equal(Browser.validActivationReadiness(cacheReady,s.server,s.receipt),true);
 await assert.rejects(f.db.query('SELECT crm_graph_candidate.lifecycle_activation_readiness_v1($1,$2,$3,$4,$5)',[s.server.journey_id,'fish',s.server.version,2,'0'.repeat(64)]),/GRAPH_PUBLICATION_DRIFT/);
 assert.equal(await f.count('lifecycle_publication_v1'),1);assert.equal(await f.count('entry'),0);
});
test('confirmed native clone clears only the message blocker; administrative target is not physical cache proof',async t=>{
 const f=await fixture(t,'fish'),N=require('../n8n/growth/journey-graph-native.cjs');
 await f.db.exec("ALTER TABLE public.templates ADD COLUMN is_default boolean NOT NULL DEFAULT false;ALTER TABLE public.templates ADD COLUMN updated_at timestamptz DEFAULT clock_timestamp();CREATE SEQUENCE public.synthetic_readiness_native START 1000;ALTER TABLE public.templates ALTER COLUMN id SET DEFAULT nextval('public.synthetic_readiness_native');");
 await f.db.exec(F.read('n8n/growth/journey-graph-native.sql'));
 await f.db.query("UPDATE crm_graph_candidate.graph_worker_deployment_v1 SET cache_target='synthetic-readiness-cache'");
 const query=f.db.query.bind(f.db),cache=new Map();let creates=0;
 const provider=N.createNativeProvider({query,cacheTarget:'synthetic-readiness-cache',nativeCreate:async p=>{creates++;const r=await query('INSERT INTO public.templates(name,type,subject,body,body_source,is_default) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[p.name,p.type,p.subject,p.body,p.body_source,p.is_default]);cache.set(r.rows[0].id,r.rows[0]);return {status:200,body:{data:r.rows[0]}};},nativeRead:async id=>({status:200,body:{data:cache.get(id)}})});
 const release=(await query('SELECT id,material_sha256 FROM crm_graph_candidate.message_release_v1 WHERE id=$1',[f.published.receipt.release_id])).rows[0];
 const pending=await provider.prepare('panel:manager',{request_id:F.id(7001),brand:'fish',release_id:release.id,expected_material_sha256:release.material_sha256});
 assert.ok((await f.status()).activation_readiness.blockers.includes('native_clone_not_ready'));
 await provider.create('fish',pending.native_id);const s=await f.status();
 assert.equal(s.activation_readiness.blockers.includes('native_clone_not_ready'),false);assert.ok(s.activation_readiness.blockers.includes('cache_identity_unverified'));assert.ok(s.activation_readiness.blockers.includes('worker_deployment_off'));
 assert.equal(creates,1);await f.status();assert.equal(creates,1);assert.equal(s.server.paused,true);assert.equal(await f.count('entry'),0);assert.equal(await f.count('intent'),0);
});
