'use strict';
// Disposable proof only. No HTTP, SMTP, native process, production URL or real identities.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {patchSource,section}=require('../n8n/growth/ab-listmonk-cohort-patch.cjs');
const AB=require('../growth-ab-experiment-contract.js');
const SCHEMA_SHA256='9d94ea32ee76aab91f6fc5c1179539513a8a955984951570ed537b1916230a8f';
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const sha=s=>createHash('sha256').update(s).digest('hex');
function verifySchema(schema){if(typeof schema!=='string'||sha(schema)!==SCHEMA_SHA256)throw Error('AB_NATIVE_SCHEMA_DRIFT');return schema;}
function postgresTarget(env){
 let u;try{u=new URL(env.TEST_DATABASE_URL);}catch{throw Error('Explicit disposable local native-roles database required');}
 if(env.AB_NATIVE_ROLES_ISOLATED!=='1'||u.protocol!=='postgres:'||!['localhost','127.0.0.1'].includes(u.hostname)||u.pathname!=='/ab_native_roles_test'||u.search||u.hash)throw Error('Explicit disposable local native-roles database required');
 return u.href;
}
async function proof(db,{schema,source,pglite=false}){
 verifySchema(schema);const native=patchSource(source),checks=[];
 const exec=q=>db.exec(q),query=(q,p)=>db.query(q,p),one=async(q,p)=>(await query(q,p)).rows[0];
 assert.equal(Number((await one("SELECT count(*) n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')")).n),0,'Refuse nonempty database before any schema DDL');
 assert.equal(Number((await one("SELECT count(*) n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'")).n),0,'Refuse existing public functions');
 assert.equal(Number((await one("SELECT count(*) n FROM pg_roles WHERE rolname IN ('ab_native_api','ab_native_worker','ab_native_unauthorized')")).n),0,'Refuse existing fixture roles');
 // Local WASM has no pgcrypto package. SHA256/gen_random_uuid are native PG functions;
 // the PostgreSQL runner executes the EXACT complete schema, including pgcrypto.
 const extension='CREATE EXTENSION IF NOT EXISTS pgcrypto;';assert.equal(schema.split(extension).length,2);
 await exec(pglite?schema.replace(extension,'-- PGlite-only: pgcrypto extension unavailable; not used by this proof.'):schema);
 await exec(read('tests/ab-native-roles-fixture.sql'));
 for(const file of ['n8n/access/panel-operator.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-provider.sql','n8n/growth/campaign-write-guard.sql',
  'n8n/growth/ab-experiment-core.sql','n8n/growth/ab-experiment-selection.sql','n8n/growth/ab-experiment-coordinator.sql','n8n/growth/ab-experiment-api.sql'])await exec(read(file));
 await exec(`INSERT INTO shrigma_panel_permission_v1 VALUES('synthetic-manager','growth','["read_content","draft","validate","submit"]'),('synthetic-reader','growth','["read_content"]')`);
 await exec(read('tests/ab-native-roles-grants.sql'));
 const role=async(name,fn)=>{assert.ok(['ab_native_api','ab_native_worker','ab_native_unauthorized'].includes(name));await exec('SET ROLE '+name);try{return await fn();}finally{await exec('RESET ROLE');}};
 const api=(method,p={brand:'fish'},key='synthetic-manager-key')=>role('ab_native_api',async()=> (await one('SELECT crm_ab_api_v2($1,$2,$3) x',[key,method,JSON.stringify(p)])).x);
 let seq=100;
 const mutate=(p,id=uuid(++seq))=>api('mutate',{brand:p.brand,operation_id:id,request_payload:p});
 const states=async(ids)=>(await query('SELECT id,status,sent,started_at FROM campaigns WHERE id=ANY($1) ORDER BY id',[ids])).rows;
 const deny=async(name,sql,params=[])=>{await assert.rejects(role(name,()=>query(sql,params)),e=>e.code==='42501');};
 const roles=(await query("SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,rolcanlogin FROM pg_roles WHERE rolname LIKE 'ab_native_%' ORDER BY rolname")).rows;
 assert.equal(roles.length,3);for(const r of roles)for(const [k,v]of Object.entries(r))if(k!=='rolname')assert.equal(v,false,k);
 const functions=(await query("SELECT p.proname,p.prosecdef,has_function_privilege('ab_native_unauthorized',p.oid,'EXECUTE') AS unauthorized FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'crm_ab_%_v2'")).rows;
 assert.equal(functions.length,15);assert.ok(functions.every(f=>!f.prosecdef&&!f.unauthorized));
 const tables=(await query("SELECT tablename,has_table_privilege('ab_native_unauthorized',quote_ident(tablename),'SELECT,INSERT,UPDATE,DELETE') allowed FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'crm_ab_%_v2'")).rows;
 assert.equal(tables.length,6);assert.ok(tables.every(t=>!t.allowed));
 assert.equal((await api('capabilities')).body.enabled,false);
 assert.equal((await api('capabilities')).body.automatic_send,false);
 assert.equal((await api('capabilities',{brand:'fish'},'synthetic-invalid-key')).status,401);
 assert.equal((await api('capabilities',{brand:'fish'},'synthetic-reader-key')).body.configure,false);
 assert.deepEqual((await api('list')).body.experiments,[]);
 checks.push('complete_native_schema_and_four_modules_installed_off','restricted_roles_and_no_public_access','real_panel_helper_and_off_capabilities');
 for(const sql of ["UPDATE crm_ab_runtime_v2 SET enabled=true","UPDATE subscribers SET status='enabled' WHERE id=1001","UPDATE subscriber_lists SET status='confirmed' WHERE subscriber_id=1002","DELETE FROM crm_ab_action_v2","UPDATE campaigns SET body='changed' WHERE id=100","CREATE TABLE public.forbidden(id int)"])await deny('ab_native_api',sql);
 for(const sql of ["SELECT * FROM crm_dash_chave","SELECT * FROM crm_ab_action_v2","UPDATE crm_ab_member_v2 SET revoked_at=now()","UPDATE crm_ab_runtime_v2 SET enabled=true","SELECT crm_ab_api_v2('synthetic-manager-key','list','{\"brand\":\"fish\"}')","UPDATE campaigns SET subject='changed' WHERE id=100"])await deny('ab_native_worker',sql);
 await deny('ab_native_unauthorized',"SELECT crm_ab_api_v2('synthetic-manager-key','list','{\"brand\":\"fish\"}')");
 checks.push('api_and_worker_negative_privilege_tests');
 const protocol=async(brand,id)=>{const ids=brand==='fish'?[100,101]:[200,201],arms=[];for(const [i,cid]of ids.entries())arms.push({arm:['a','b'][i],campaign_id:cid,expected_version:(await one('SELECT shrigma_campaign_current($1) x',[cid])).x.version});return {contract:AB.CONTRACT,test_id:uuid(id),brand,channel:'email',name:'Synthetic native roles',hypothesis:'Synthetic complete messages',arms,allocation:{method:'random-permutation-v1',a_basis_points:5000},rule:{method:AB.RULE,metric:'unique_tracked_click_per_allocated',window_hours:24,minimum_per_arm:100,minimum_effect_pp:.1,alpha:.05}};};
 const enable=()=>query('UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256=$1,verified_at=clock_timestamp()',[native.patched_sha256]);
 const p=await protocol('fish',1),before=await states([100,101]);
 assert.equal((await mutate(p)).body.error,'AB_V2_TRANSPORT_UNAVAILABLE');
 assert.equal(Number((await one('SELECT count(*) n FROM crm_ab_member_v2')).n),0);
 await enable();
 // Invoker row locks require the narrow lock-column grant. Denial must roll back
 // the call, not become a fabricated definite operation receipt.
 await exec('REVOKE UPDATE(singleton) ON crm_ab_runtime_v2 FROM ab_native_api');
 const lockDeniedId=uuid(++seq);await assert.rejects(mutate(p,lockDeniedId),e=>e.code==='42501');
 assert.equal(Number((await one('SELECT count(*) n FROM crm_ab_action_v2 WHERE operation_id=$1',[lockDeniedId])).n),0);
 await exec('GRANT UPDATE(singleton) ON crm_ab_runtime_v2 TO ab_native_api');
 checks.push('invoker_lock_privilege_required_and_denial_atomic');
 // Fault after experiment/arms creation proves no partial allocation escapes.
 await exec(`CREATE FUNCTION ab_native_fail_prepare() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'AB_V2_SYNTHETIC_PREPARE';END$$;CREATE TRIGGER ab_native_fail_prepare BEFORE INSERT ON crm_ab_member_v2 FOR EACH STATEMENT EXECUTE FUNCTION ab_native_fail_prepare()`);
 const prepareId=uuid(++seq),rejectedPrepare=await mutate(p,prepareId);
 assert.equal(rejectedPrepare.body.error,'AB_V2_SYNTHETIC_PREPARE');
 for(const table of ['crm_ab_experiment_v2','crm_ab_arm_v2','crm_ab_member_v2'])assert.equal(Number((await one('SELECT count(*) n FROM '+table)).n),0);
 await exec('DROP TRIGGER ab_native_fail_prepare ON crm_ab_member_v2;DROP FUNCTION ab_native_fail_prepare()');
 assert.deepEqual(await mutate(p,prepareId),rejectedPrepare);
 const successId=uuid(++seq),saved=await mutate(p,successId);assert.equal(saved.status,200,JSON.stringify(saved));assert.deepEqual(saved.body.experiment.arms.map(a=>a.allocated),[500,500]);
 assert.deepEqual(await mutate(p,successId),saved);assert.deepEqual(await states([100,101]),before);
 assert.equal(Number((await one('SELECT count(*) n FROM crm_ab_member_v2')).n),1000);
 const receipt=(await api('operation',{brand:'fish',operation_id:successId,action:'prepare'})).body.operation;
 assert.deepEqual(receipt.response,saved);assert.equal((await api('operation',{brand:'fish',operation_id:successId,action:'prepare'},'synthetic-reader-key')).body.operation.state,'missing');
 checks.push('atomic_prepare_rollback_and_replay','fixed_disjoint_cohort_no_native_schedule','actor_bound_read_receipt');
 // CRM06 prerequisite runs the actual provider review with a synthetic owner.
 // This does not pretend to validate email rendering or recreate the CRM06 UI.
 const sourceReviews=async(ids)=>{const out={};for(const [i,cid]of ids.entries()){
  const current=(await one('SELECT shrigma_campaign_current($1) c',[cid])).c;
  const op=(await one("SELECT shrigma_campaign_store('claim',$1) o",[JSON.stringify({actor:'synthetic-source-review',key:'synthetic-review-'+uuid(++seq),hash:'a'.repeat(64),brand:current.definition.brand,action:'validar'})])).o;
  const result=(await one("SELECT shrigma_campaign_provider('review',$1) r",[JSON.stringify({id:cid,expectedVersion:current.version,operationId:op.id})])).r;
  await query("SELECT shrigma_campaign_store('finish',$1)",[JSON.stringify({id:op.id,lease:op.lease,providerId:cid,state:'succeeded',response:{status:200,body:result}})]);
  out[['a','b'][i]]=result.validation.audience.review_id;
 }return out;};
 const request=(brand,tid,action,extra={})=>({contract:AB.CONTRACT,test_id:uuid(tid),brand,expected_version:1,action,...extra});
 const r=await mutate(request('fish',1,'review',{source_reviews:await sourceReviews([100,101])}));assert.equal(r.status,200,JSON.stringify(r));
 assert.deepEqual(r.body.review.arms.map(a=>a.counts.eligible),[500,500]);
 assert.doesNotMatch(JSON.stringify(r),/subscriber_id|fingerprint|seed/);
 await exec(`CREATE FUNCTION ab_native_fail_second() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.id=101 AND NEW.status='scheduled' THEN RAISE EXCEPTION 'AB_V2_SYNTHETIC_SCHEDULE';END IF;RETURN NEW;END$$;CREATE TRIGGER zz_ab_native_fail_second BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION ab_native_fail_second()`);
 const schedule=request('fish',1,'schedule',{review_id:r.body.review.review_id,confirm:'schedule_both'}),scheduleId=uuid(++seq),rejectedSchedule=await mutate(schedule,scheduleId);
 assert.equal(rejectedSchedule.body.error,'AB_V2_SYNTHETIC_SCHEDULE');assert.deepEqual(await states([100,101]),before);
 assert.equal((await one('SELECT state FROM crm_ab_experiment_v2 WHERE test_id=$1',[uuid(1)])).state,'prepared');
 await exec('DROP TRIGGER zz_ab_native_fail_second ON campaigns;DROP FUNCTION ab_native_fail_second()');
 assert.deepEqual(await mutate(schedule,scheduleId),rejectedSchedule);
 const scheduled=await mutate(schedule);assert.equal(scheduled.status,200,JSON.stringify(scheduled));assert.deepEqual((await states([100,101])).map(c=>c.status),['scheduled','scheduled']);
 checks.push('real_source_reviews_under_native_schema','restricted_api_atomic_schedule_rollback_and_replay');
 // Separate brand exercises OFF cancellation without changing the Fish worker case.
 const pa=await protocol('aristo',2);assert.equal((await mutate(pa)).status,200);
 const ra=await mutate(request('aristo',2,'review',{source_reviews:await sourceReviews([200,201])}));assert.equal(ra.status,200,JSON.stringify(ra));
 assert.equal((await mutate(request('aristo',2,'schedule',{review_id:ra.body.review.review_id,confirm:'schedule_both'}))).status,200);
 await exec('UPDATE crm_ab_runtime_v2 SET enabled=false');
 assert.equal((await api('capabilities',{brand:'aristo'})).body.schedule,false);
 const cancel=request('aristo',2,'cancel',{expected_version:2,confirm:'cancel_both'}),cancelId=uuid(++seq),cancelled=await mutate(cancel,cancelId);
 assert.equal(cancelled.status,200,JSON.stringify(cancelled));assert.deepEqual((await states([200,201])).map(c=>c.status),['cancelled','cancelled']);assert.deepEqual(await mutate(cancel,cancelId),cancelled);
 assert.equal((await one('SELECT enabled FROM crm_ab_runtime_v2')).enabled,false);
 checks.push('restricted_api_cancel_both_while_runtime_off');
 // Move only synthetic fixture dates under the owner to exercise due native SQL
 // without sleeping two hours. Permission checks and native queries remain real.
 await enable();await query("SELECT set_config('shrigma.ab_schedule_v2',$1,false)",[uuid(1)]);
 for(const cid of [100,101]){await query("SELECT set_config('shrigma.campaign_writer',$1,false)",[String(cid)]);await query("UPDATE campaigns SET send_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[cid]);}
 await exec("SELECT set_config('shrigma.campaign_writer','',false);SELECT set_config('shrigma.ab_schedule_v2','',false);UPDATE crm_ab_experiment_v2 SET window_start=clock_timestamp()-interval '1 minute',window_end=clock_timestamp()+interval '1 day' WHERE brand='fish'");
 const count=section(native.source,'next-campaigns').text,batch=section(native.source,'next-campaign-subscribers').text;
 await role('ab_native_worker',()=>query(count,[[],[]]));
 const counts=(await query('SELECT id,to_send,max_subscriber_id FROM campaigns WHERE id IN(100,101) ORDER BY id')).rows;
 assert.deepEqual(counts.map(c=>c.to_send),[500,500]);
 const delivered=[];for(const c of counts){
  const rows=await role('ab_native_worker',()=>query(batch,[c.id,'regular',0,c.max_subscriber_id,[3,17],1000]));
  assert.equal(rows.rows.length,500);delivered.push(...rows.rows.map(r=>r.id));
  if(c.id===100){
   await exec('REVOKE UPDATE(finished_at,transport_interrupted_at) ON crm_ab_arm_v2 FROM ab_native_worker');
   await deny('ab_native_worker',"UPDATE campaigns SET sent=$1,status='finished' WHERE id=$2",[rows.rows.length,c.id]);
   assert.deepEqual((await one('SELECT status,sent FROM campaigns WHERE id=$1',[c.id])),{status:'running',sent:0});
   await exec('GRANT UPDATE(finished_at,transport_interrupted_at) ON crm_ab_arm_v2 TO ab_native_worker');
  }
  await role('ab_native_worker',()=>query("UPDATE campaigns SET sent=$1,status='finished' WHERE id=$2",[rows.rows.length,c.id]));
 }
 assert.equal(new Set(delivered).size,1000);assert.equal(Number((await one('SELECT count(*) n FROM crm_ab_arm_v2 WHERE test_id=$1 AND finished_at IS NOT NULL',[uuid(1)])).n),2);
 assert.equal((await api('get',{brand:'fish',test_id:uuid(1)})).body.measurement.integrity.transport_continuous,false,'OFF/ON evidence stays irreversible');
 await exec('UPDATE crm_ab_runtime_v2 SET enabled=false');
 checks.push('restricted_worker_complete_official_count_and_batch_queries','restricted_worker_finish_trigger_grant_required_and_denial_atomic','irreversible_off_on_evidence');
 const version=(await one('SELECT version() v')).v;
 return {status:'PASS',engine:pglite?'PGlite local precursor; pgcrypto extension line omitted':'PostgreSQL exact native schema',postgres_version:version,schema_sha256:SCHEMA_SHA256,query_sha256:native.patched_sha256,
  checks,cohort:[500,500],worker_selected:[500,500],source_reviews:'real provider; synthetic content precondition',role_profile:'trusted backend invoker and worker selection/progress only; not a complete Listmonk application grant recipe',runtime_enabled:false,native_process_started:false,transport_calls:0,real_recipients:0};
}
async function main(env=process.env,mode=process.argv[2]){
 if(!env.AB_NATIVE_SCHEMA||!env.AB_UPSTREAM_SOURCE)throw Error('AB_NATIVE_SCHEMA and AB_UPSTREAM_SOURCE required');
 const opts={schema:fs.readFileSync(env.AB_NATIVE_SCHEMA,'utf8'),source:fs.readFileSync(env.AB_UPSTREAM_SOURCE,'utf8'),pglite:mode==='--pglite'};
 verifySchema(opts.schema);patchSource(opts.source);
 let db,client;
 if(mode==='--pglite'){
  if(env.TEST_DATABASE_URL)throw Error('PGlite mode does not accept a database URL');
  const {PGlite}=require('@electric-sql/pglite');db=new PGlite();
 }else if(mode==='--postgres'){
  const {Client}=require('pg');client=new Client({connectionString:postgresTarget(env)});await client.connect();
  assert.equal((await client.query('SELECT current_database() name')).rows[0].name,'ab_native_roles_test');db={exec:q=>client.query(q),query:(q,p)=>client.query(q,p)};
 }else throw Error('Use --pglite or --postgres');
 try{return await proof(db,opts);}finally{if(client)await client.end();else await db.close();}
}
module.exports={SCHEMA_SHA256,verifySchema,postgresTarget,proof,main};
if(require.main===module)main().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(JSON.stringify({status:'FAIL',code:e.code||null,message:e.message}));process.exitCode=1;});
