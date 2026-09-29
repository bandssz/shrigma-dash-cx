'use strict';
const assert=require('node:assert/strict'),{Pool}=require('pg');
const F=require('./journey-graph-lifecycle-prepare-fixture.cjs');
const {createLifecyclePanelAPI}=require('../n8n/growth/journey-graph-lifecycle-panel-api.cjs');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.GRAPH_LIFECYCLE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const owner=new Pool({connectionString:uri,max:8,statement_timeout:20000,connectionTimeoutMillis:5000}),db={query:(q,p)=>owner.query(q,p),exec:q=>owner.query(q)};
let apiPool;
(async()=>{const proof={postgres:'17.10',role:null,brands:[],concurrent_receipt:false,atomic_rollback:false,lost_ack_reconciled:false,native_write_denied:false,originals_preserved:false,control_off:false,sends:0};try{
 assert.equal((await db.query("SELECT current_setting('server_version_num') v")).rows[0].v,'170010');
 const f=await F.fixture({after(){}},'fish',{db,pool:owner}),nativeBefore=(await db.query('SELECT * FROM templates ORDER BY id')).rows;
 await db.exec(F.read('n8n/growth/journey-graph-lifecycle-publication.sql'));
 await db.exec('CREATE ROLE crm_audience_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4');
 await db.exec(F.read('n8n/growth/journey-graph-lifecycle-runtime-access.sql'));
 const restricted=new URL(uri);restricted.username='crm_audience_api';restricted.password='';
 apiPool=new Pool({connectionString:restricted.href,max:4,statement_timeout:10000,connectionTimeoutMillis:3000,application_name:'graph-lifecycle-restricted-proof'});apiPool.on('error',()=>{});
 proof.role=(await apiPool.query('SELECT current_user AS role')).rows[0].role;assert.equal(proof.role,'crm_audience_api');
 const api=createLifecyclePanelAPI({pool:apiPool,checkoutSha:F.checkoutSha,enabled:true});
 const call=(p,method=['operation','status'].includes(p.action)?'GET':'POST',target=api)=>target.handle({method,request:{headers:{Authorization:F.authorization},...(method==='GET'?{query:p}:{body:p})}});
 let seq=1000;
 const journey=async(brand)=>f.runtime.create({request_id:F.id(seq++),actor:'panel:manager',brand,definition:{...f.definition,brand,nodes:f.definition.nodes.map(n=>n.type==='message'?{...n,binding:'email.template.'+(brand==='fish'?60:95)}:n)}});
 async function prepare(j){const reviewed=await call({action:'review',brand:j.brand,journey_id:j.journey_id,expected_version:j.version});assert.equal(reviewed.status,200,JSON.stringify(reviewed));assert.equal(reviewed.body.state,'reviewed');const p={action:'prepare',brand:j.brand,journey_id:j.journey_id,expected_version:j.version,request_id:F.id(seq++),review_hash:reviewed.body.review.review_hash,confirm:'preparar'},r=await call(p);assert.equal(r.status,200,JSON.stringify(r));return {p,r};}
 const publish=(j,r)=>({action:'publish',brand:j.brand,journey_id:j.journey_id,expected_version:j.version,request_id:F.id(seq++),prepared_revision:j.revision+1,prepared_hash:r.body.receipt.prepared_hash,confirm:'publicar'});
 for(const brand of ['fish','aristo']){
  const j=brand==='fish'?f.original:await journey(brand),{r}=await prepare(j),p=publish(j,r);
  const results=await Promise.all([call(p),call(p)]);assert.equal(results[0].status,200,JSON.stringify(results[0]));assert.deepEqual(results[0],results[1]);
  const got=await call({action:'operation',brand,request_id:p.request_id});assert.deepEqual(got,results[0]);
  const status=await call({action:'status',brand,journey_id:j.journey_id});assert.equal(status.body.state,'published_paused');assert.equal(status.body.server.paused,true);assert.equal(status.body.server.revision,2);
  proof.brands.push({brand,prepared:true,published_paused:true,recovered:true});
 }
 assert.equal(await f.count('lifecycle_publication_v1'),2);proof.concurrent_receipt=true;
 const rollbackJourney=await journey('fish'),rollbackPrep=await prepare(rollbackJourney),failed=publish(rollbackJourney,rollbackPrep.r);
 await db.exec("CREATE FUNCTION fixture_publication_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'SYNTHETIC_PUBLICATION_FAILURE';END$$;CREATE TRIGGER fixture_publication_failure BEFORE INSERT ON crm_graph_candidate.lifecycle_publication_operation_v1 FOR EACH ROW EXECUTE FUNCTION fixture_publication_failure()");
 const failedResult=await call(failed);assert.equal(failedResult.status,503);assert.equal((await call({action:'operation',brand:'fish',request_id:failed.request_id})).body.state,'unconfirmed');
 assert.equal(await f.count('lifecycle_publication_v1'),2);assert.deepEqual((await db.query('SELECT version,head_revision,published_revision FROM crm_graph_candidate.journey WHERE id=$1',[rollbackJourney.journey_id])).rows[0],{version:1,head_revision:1,published_revision:null});
 await db.exec('DROP TRIGGER fixture_publication_failure ON crm_graph_candidate.lifecycle_publication_operation_v1;DROP FUNCTION fixture_publication_failure()');proof.atomic_rollback=true;
 let dropped=false;
 const lostPool={async connect(){const client=await apiPool.connect();return {async query(sql,args){const result=await client.query(sql,args);if(sql==='COMMIT'&&!dropped){dropped=true;await client.end();throw Error('Synthetic lost COMMIT acknowledgement');}return result;},release:e=>client.release(e)};}};
 const lostAPI=createLifecyclePanelAPI({pool:lostPool,checkoutSha:F.checkoutSha,enabled:true}),lost=publish(rollbackJourney,rollbackPrep.r);
 const unknown=await call(lost,'POST',lostAPI);assert.equal(unknown.status,202,JSON.stringify(unknown));assert.equal(dropped,true);
 const recovered=await call({action:'operation',brand:'fish',request_id:lost.request_id});assert.equal(recovered.status,200);assert.equal(recovered.body.receipt.paused,true);assert.equal(await f.count('lifecycle_publication_v1'),3);proof.lost_ack_reconciled=true;
 for(const sql of ['UPDATE public.templates SET subject=subject','UPDATE public.shrigma_flow_definition SET published=published','UPDATE public.shrigma_template_email_registry SET brand=brand','UPDATE public.crm_dash_chave SET ativo=false','UPDATE crm_graph_candidate.journey SET paused=false'])await assert.rejects(apiPool.query(sql),e=>e.code==='42501');
 proof.native_write_denied=true;
 assert.deepEqual((await db.query('SELECT * FROM templates ORDER BY id')).rows,nativeBefore);assert.equal((await db.query('SELECT count(*)::int n FROM crm_graph_candidate.revision WHERE revision=1')).rows[0].n,3);proof.originals_preserved=true;
 assert.equal((await db.query('SELECT enabled FROM crm_graph_candidate.control')).rows[0].enabled,false);assert.equal(await f.count('entry'),0);assert.equal(await f.count('intent'),0);proof.control_off=true;
 console.log(JSON.stringify(proof));
}finally{await apiPool?.end();await owner.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
