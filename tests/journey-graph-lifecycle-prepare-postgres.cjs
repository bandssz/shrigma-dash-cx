'use strict';
// Real independent PostgreSQL sessions, synthetic data and no transport.
const assert=require('node:assert/strict'),{Pool}=require('pg');
const F=require('./journey-graph-lifecycle-prepare-fixture.cjs');
const {createLifecyclePreparer}=require('../n8n/growth/journey-graph-lifecycle-prepare.cjs');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.GRAPH_LIFECYCLE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const pool=new Pool({connectionString:uri,max:8,statement_timeout:20000,connectionTimeoutMillis:5000,application_name:'graph-lifecycle-proof'});
pool.on('error',()=>{});
const db={query:(q,p)=>pool.query(q,p),exec:q=>pool.query(q)};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{const proof={postgres:'17.10',brands:[],concurrent_receipt:false,atomic_rollback:false,closed_connection_reconciled:false,real_lock_expiry:false,late_auth_rollback:false,originals_preserved:false,control_off:false,sends:0};try{
 assert.equal((await db.query("SELECT current_setting('server_version_num') v")).rows[0].v,'170010');
 const f=await F.fixture({after:()=>{}},'fish',{db,pool});
 const nativeBefore=(await db.query('SELECT * FROM templates ORDER BY id')).rows;
 const originals=[f.original];
 for(const brand of ['fish','aristo']){
  const original=brand==='fish'?f.original:await f.runtime.create({request_id:F.id(2),actor:'panel:manager',brand,definition:{...f.definition,brand,nodes:f.definition.nodes.map(n=>n.type==='message'?{...n,binding:'email.template.95'}:n)}});
  if(brand==='aristo')originals.push(original);
  const review=await f.api.review({action:'review',brand,journey_id:original.journey_id,expected_version:original.version},{authorization:F.authorization});
  assert.equal(review.state,'reviewed');
  const request={action:'prepare',brand,journey_id:original.journey_id,expected_version:original.version,request_id:F.id(brand==='fish'?10:11),review_hash:review.review.review_hash,confirm:'preparar'};
  const results=await Promise.all([f.api.prepare(request,{authorization:F.authorization}),createLifecyclePreparer(f.options).prepare(request,{authorization:F.authorization})]);
  assert.deepEqual(results[1],results[0]);assert.equal(results[0].state,'prepared');assert.equal(results[0].prepared.readiness.eligibility_available,false);
  const historical=await createLifecyclePreparer(f.options).operation({action:'operation',brand,request_id:request.request_id},{authorization:F.authorization});assert.deepEqual(historical,results[0]);
  proof.brands.push({brand,prepared:true,recovered:true});
 }
 assert.equal(await f.count('lifecycle_prepare_operation_v1'),2);proof.concurrent_receipt=true;

 const failed=f.request(await f.review()),before=await f.count('lifecycle_prepared_v1');
 await db.exec("CREATE FUNCTION fixture_graph_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'SYNTHETIC_RECEIPT_FAILURE';END$$;CREATE TRIGGER fixture_graph_receipt_failure BEFORE INSERT ON crm_graph_candidate.lifecycle_prepare_operation_v1 FOR EACH ROW EXECUTE FUNCTION fixture_graph_receipt_failure()");
 await assert.rejects(f.prepare(failed),{code:'GRAPH_PREPARE_UNAVAILABLE'});
 assert.equal(await f.count('lifecycle_prepared_v1'),before);assert.equal((await f.operation(failed)).state,'unconfirmed');
 await db.exec('DROP TRIGGER fixture_graph_receipt_failure ON crm_graph_candidate.lifecycle_prepare_operation_v1;DROP FUNCTION fixture_graph_receipt_failure()');proof.atomic_rollback=true;

 const lost=f.request(await f.review());let closed=false;
 f.control.after=async(sql,args,connection)=>{if(sql==='COMMIT'&&!closed){closed=true;await connection.end();throw Error('synthetic lost commit acknowledgement');}};
 await assert.rejects(f.prepare(lost),{code:'GRAPH_PREPARE_OUTCOME_UNKNOWN',request_id:lost.request_id});f.control.after=null;
 assert.equal(closed,true);assert.ok(f.control.discards>0);const receipt=await f.operation(lost,createLifecyclePreparer(f.options));assert.equal(receipt.state,'prepared');assert.equal(await f.count('lifecycle_prepared_v1'),before+1);proof.closed_connection_reconciled=true;

 const expired=f.request(await f.review()),locker=await pool.connect();let waitingPid,blocked=false;
 try{
  await locker.query('BEGIN');await locker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['graph-lifecycle-operation:'+expired.request_id]);
  await db.query("UPDATE crm_dash_chave SET expira_em=clock_timestamp()+interval '120 milliseconds' WHERE chave='manager'");
  f.control.before=async(sql,args,connection)=>{if(sql.startsWith('SELECT pg_catalog.pg_advisory_xact_lock'))waitingPid=connection.processID;};
  const pending=f.prepare(expired).then(value=>({value}),error=>({error}));
  for(let i=0;i<80;i++){
   const state=(await db.query("SELECT (SELECT wait_event_type='Lock' FROM pg_stat_activity WHERE pid=$1) AS blocked,(SELECT expira_em<=clock_timestamp() FROM crm_dash_chave WHERE chave='manager') AS expired",[waitingPid||0])).rows[0];
   blocked=blocked||state.blocked===true;if(blocked&&state.expired)break;await delay(5);
  }
  assert.equal(blocked,true);await locker.query('COMMIT');const result=await pending;assert.equal(result.error?.code,'GRAPH_PREPARE_ACCESS');proof.real_lock_expiry=true;
 }finally{f.control.before=null;await locker.query('ROLLBACK');locker.release();await db.query("UPDATE crm_dash_chave SET expira_em=NULL WHERE chave='manager'");}
 assert.equal((await f.operation(expired)).state,'unconfirmed');assert.equal(await f.count('lifecycle_prepared_v1'),before+1);

 const revoked=f.request(await f.review());let changed=false;
 f.control.after=async sql=>{if(!changed&&sql.startsWith('SELECT crm_graph_candidate.release_prepare_v1')){changed=true;await db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"read_content\",\"validate\"]' WHERE principal_id='manager'");}};
 await assert.rejects(f.prepare(revoked),{code:'GRAPH_PREPARE_ACCESS'});f.control.after=null;
 assert.equal(changed,true);assert.equal(await f.count('lifecycle_prepared_v1'),before+1);assert.equal((await f.operation(revoked)).state,'unconfirmed');proof.late_auth_rollback=true;
 assert.deepEqual((await db.query('SELECT * FROM templates ORDER BY id')).rows,nativeBefore);
 for(const original of originals){const row=(await db.query('SELECT head_revision,published_revision,paused FROM crm_graph_candidate.journey WHERE id=$1',[original.journey_id])).rows[0];assert.deepEqual(row,{head_revision:1,published_revision:null,paused:true});}
 assert.equal(await f.count('entry'),0);assert.equal(await f.count('intent'),0);proof.originals_preserved=true;
 assert.equal((await db.query('SELECT enabled FROM crm_graph_candidate.control')).rows[0].enabled,false);proof.control_off=true;
 console.log(JSON.stringify(proof));
}finally{await pool.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
