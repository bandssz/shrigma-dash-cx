'use strict';
// Opt-in PostgreSQL 17.10 proof. It uses only a disposable loopback database;
// SMTP and every other remote transport remain absent.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto'),{Pool}=require('pg');
const F=require('./ab-audience-regular-fixture.cjs'),Admission=require('../n8n/growth/ab-audience-regular-admission.cjs');

const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const sourcePath=process.env.LISTMONK_CAMPAIGNS_SQL;
if(!sourcePath)throw Error('LISTMONK_CAMPAIGNS_SQL_REQUIRED');
const source=fs.readFileSync(sourcePath,'utf8'),querySHA=createHash('sha256').update(source).digest('hex');
assert.equal(querySHA,'3dc9433187c4ee16f0516503c6cc3efae63e9a607f9a15748e52a43217c6f7de');
function section(name){const begin=source.indexOf('-- name: '+name),end=source.indexOf('-- name:',begin+9);assert.ok(begin>=0&&end>begin);return source.slice(begin,end);}
const nextCampaigns=section('next-campaigns'),nextSubscribers=section('next-campaign-subscribers');
const sql=fs.readFileSync(path.resolve(__dirname,'../n8n/growth/ab-audience-regular.sql'),'utf8');
const pool=new Pool({connectionString:uri,max:12,statement_timeout:30000,connectionTimeoutMillis:5000,application_name:'ab-regular-proof'});
const db={query:(q,p)=>pool.query(q,p),exec:q=>pool.query(q),transaction:async work=>{const c=await pool.connect();try{await c.query('BEGIN');const out=await work(c);await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const callService=fixture=>{const service=Admission.createABRegularAdmission({transaction:fixture.transaction,timeoutMs:10000});return async request=>{const r=await service.execute({key:'synthetic-manager-key',request});return {status:r._http,body:r._body};};};
const prepareRequest=(fixture,brand)=>{const p=fixture.cases[brand];return {acao:Admission.ACTIONS.prepare,brand,test_id:p.protocol.test_id,expected_version:p.saved.experiment.version,expected_scope_hash:p.saved.scope_hash,audience_review_id:p.review.review_id};};
const scheduleRequest=(p,review,key)=>({...p,acao:Admission.ACTIONS.schedule,admission_review_id:review.body.review.admission_review_id,confirm:'agendar_duas',idempotency_key:key});
async function refreshReview(f,brand){const r=await f.review(f.cases[brand]);assert.equal(r._http,201,JSON.stringify(r));f.cases[brand].review=r._body.review;}
async function heartbeat(f){const r=(await db.query('SELECT crm_audience_v2.regular_worker_heartbeat($1::uuid,$2,$3) result',[f.instance,f.worker,f.runtime])).rows[0].result;assert.equal(r.ready,true,JSON.stringify(r));}
async function scanCampaigns(){return db.transaction(async tx=>{await tx.query("SET LOCAL statement_timeout='10s';SET LOCAL lock_timeout='500ms'");const quarantine=(await tx.query('SELECT crm_audience_v2.regular_delivery_quarantine($1::integer[]) result',[[]])).rows[0].result;assert.ok(Array.isArray(quarantine));return tx.query(nextCampaigns,[[],[]]);});}
async function waitUntilDue(f){for(;;){const row=(await db.query('SELECT min(send_at) at,clock_timestamp() now FROM campaigns WHERE id=ANY($1)',[[100,101,200,201]])).rows[0],left=new Date(row.at)-new Date(row.now);if(left<=0)return;await heartbeat(f);console.log(JSON.stringify({stage:'waiting_until_due',remaining_ms:left}));await sleep(Math.min(30000,left+20));}}
async function claim(f,campaign,row,outcome){const did=randomUUID(),snapshot=row.crm_delivery_snapshot,result=(await db.query(`SELECT crm_audience_v2.regular_delivery_claim_live(
 $1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10::jsonb,$11) result`,[f.instance,campaign,row.id,did,f.worker,f.runtime,campaign<200?'contato@fishermans.com.br':'contato@oaristocrata.com',row.email,'c'.repeat(64),JSON.stringify(snapshot),'fixture'])).rows[0].result;
 assert.equal(result.should_send,true,JSON.stringify(result));await db.query('SELECT crm_audience_v2.regular_delivery_finish($1,$2,$3::uuid,$4::uuid,$5)',[campaign,row.id,did,result.claim_token,outcome]);return did;}

(async()=>{const proof={postgres:'17.10',query_sha256:querySHA,catalog_refresh_before_wait:false,contexts_valid_before_wait:false,atomic_pair:false,lost_ack_reconciled:false,concurrent_idempotency:false,revoked_excluded:false,optout_excluded:false,arms_disjoint:false,unknown_pauses_pair:false,single_admission_denied:false,finished_pair_guarded:false,premature_close_denied:false,sends:0,remote_hosts:0};try{
 assert.equal((await db.query("SELECT current_setting('server_version_num') v")).rows[0].v,'170010');
 const f=await F.setup(db,{sendAfterSeconds:930,renewableCatalogBeforeBinding:true,beforeWorkerReady:async({db})=>db.exec(sql)});assert.equal(f.catalogRenewal.length,2);assert.ok(f.catalogRenewal.every(x=>x.fresh));proof.catalog_refresh_before_wait=true;await db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"draft\",\"validate\",\"read_content\",\"submit\"]' WHERE principal_id='manager'");
 const call=callService(f);

 // Freeze one member out of arm A and make a different arm-B member a real
 // base-list opt-out. A new immutable review records exclusions; no allocation
 // row is moved to compensate.
 const members=(await db.query('SELECT subscriber_id,arm FROM crm_ab_member_v2 WHERE test_id=$1 ORDER BY subscriber_id',[f.cases.fish.protocol.test_id])).rows;
 const revoked=members.find(x=>x.arm==='a'),optout=members.find(x=>x.arm==='b'&&x.subscriber_id!==revoked.subscriber_id);assert.ok(revoked&&optout);
 await db.query("UPDATE crm_ab_member_v2 SET revoked_at=clock_timestamp(),revoked_reason='fixture-proof' WHERE test_id=$1 AND subscriber_id=$2",[f.cases.fish.protocol.test_id,revoked.subscriber_id]);
 await db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1 AND list_id=17",[optout.subscriber_id]);
 await refreshReview(f,'fish');

 // The old single-campaign admission API cannot schedule either scoped arm.
 const singleID=randomUUID(),runtime=(await db.query("SELECT crm_audience_v2.regular_admission_runtime('fish') runtime")).rows[0].runtime,material=(await db.query('SELECT crm_audience_v2.regular_delivery_material(100) material')).rows[0].material,current=(await db.query('SELECT public.shrigma_campaign_current(100) current')).rows[0].current,binding=(await db.query('SELECT * FROM crm_audience_v2.campaign_binding WHERE campaign_id=100')).rows[0];
 await db.query(`INSERT INTO crm_audience_v2.regular_admission_review(id,actor,brand,campaign_id,campaign_version,binding_version,binding_hash,material,material_hash,runtime,eligible_count,checked_at,expires_at)
  VALUES($1,'manager','fish',100,$2,$3,$4,$5::jsonb,$6,$7::jsonb,1,clock_timestamp(),clock_timestamp()+interval '30 seconds')`,[singleID,current.version,binding.binding_version,binding.binding_hash,JSON.stringify(material),'d'.repeat(64),JSON.stringify(runtime)]);
 await assert.rejects(db.query("SELECT crm_audience_v2.regular_admission_schedule($1,'manager')",[singleID]),e=>e.message.includes('AB_REGULAR_PAIR_ADMISSION_REQUIRED'));proof.single_admission_denied=true;

 const fishPrepare=prepareRequest(f,'fish'),fishReview=await call(fishPrepare);assert.equal(fishReview.status,200,JSON.stringify(fishReview));const fishSchedule=scheduleRequest(fishPrepare,fishReview,'fish-pair-schedule-0001');
 // A test-only failure on the second control proves that the first control,
 // pair row and both native schedules roll back together.
 await db.exec(`CREATE FUNCTION fixture_fail_second_arm() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.campaign_id=101 THEN RAISE EXCEPTION 'FIXTURE_SECOND_ARM';END IF;RETURN NEW;END$$;
  CREATE TRIGGER fixture_fail_second_arm BEFORE INSERT ON crm_audience_v2.regular_delivery_campaign FOR EACH ROW EXECUTE FUNCTION fixture_fail_second_arm();`);
 const failed=await call(fishSchedule);assert.equal(failed.status,202,JSON.stringify(failed));assert.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id IN(100,101)')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.ab_regular_pair WHERE test_id=$1',[f.cases.fish.protocol.test_id])).rows[0].n,0);assert.equal((await db.query("SELECT count(*)::int n FROM campaigns WHERE id IN(100,101) AND status='draft'")).rows[0].n,2);proof.atomic_pair=true;
 await db.exec('DROP TRIGGER fixture_fail_second_arm ON crm_audience_v2.regular_delivery_campaign;DROP FUNCTION fixture_fail_second_arm()');
 f.control.afterCommit=()=>{throw Error('fixture lost ACK');};const uncertain=await call(fishSchedule);assert.equal(uncertain.status,202);f.control.afterCommit=null;const recovered=await call({acao:Admission.ACTIONS.operation,brand:'fish',idempotency_key:fishSchedule.idempotency_key});assert.equal(recovered.status,200,JSON.stringify(recovered));proof.lost_ack_reconciled=true;

 const aristoPrepare=prepareRequest(f,'aristo'),aristoReview=await call(aristoPrepare);assert.equal(aristoReview.status,200,JSON.stringify(aristoReview));const aristoSchedule=scheduleRequest(aristoPrepare,aristoReview,'aristo-pair-schedule-0001'),race=await Promise.all([call(aristoSchedule),call(aristoSchedule)]);assert.equal(race[0].status,200);assert.deepEqual(race[1],race[0]);assert.equal((await db.query("SELECT count(*)::int n FROM crm_audience_v2.ab_regular_request WHERE operation_key='aristo-pair-schedule-0001'")).rows[0].n,1);proof.concurrent_idempotency=true;

 const contexts=(await db.query('SELECT id,crm_audience_v2.selection_worker_context(id) IS NOT NULL AS valid FROM campaigns WHERE id=ANY($1) ORDER BY id',[[100,101,200,201]])).rows;assert.equal(contexts.length,4);assert.ok(contexts.every(x=>x.valid));proof.contexts_valid_before_wait=true;

 await waitUntilDue(f);await heartbeat(f);const scanned=await scanCampaigns();assert.equal(scanned.rows.length,4);const selected={};
 for(const cid of [100,101,200,201]){const c=(await db.query('SELECT type,last_subscriber_id,max_subscriber_id FROM campaigns WHERE id=$1',[cid])).rows[0],lists=(await db.query('SELECT array_agg(list_id ORDER BY list_id) ids FROM campaign_lists WHERE campaign_id=$1',[cid])).rows[0].ids;selected[cid]=(await db.query(nextSubscribers,[cid,c.type,c.last_subscriber_id,c.max_subscriber_id,lists,100])).rows;}
 const fishA=new Set(selected[100].map(x=>x.id)),fishB=new Set(selected[101].map(x=>x.id));assert.equal(fishA.has(revoked.subscriber_id)||fishB.has(revoked.subscriber_id),false);assert.equal(fishA.has(optout.subscriber_id)||fishB.has(optout.subscriber_id),false);assert.equal([...fishA].some(x=>fishB.has(x)),false);proof.revoked_excluded=true;proof.optout_excluded=true;proof.arms_disjoint=true;

 // One uncertain outcome on Fish must suspend and pause both arms.
 assert.ok(selected[100].length);await claim(f,100,selected[100][0],'outcome_unknown');assert.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id IN(100,101) AND suspended')).rows[0].n,2);assert.equal((await db.query("SELECT count(*)::int n FROM campaigns WHERE id IN(100,101) AND status='paused'")).rows[0].n,2);proof.unknown_pauses_pair=true;

 // Aristo can finish independently. Every selected subscriber is claimed and
 // durably accepted before the native status transition.
 for(const cid of [200,201]){for(const row of selected[cid])await claim(f,cid,row,'accepted');await db.query("UPDATE campaigns SET status='finished',updated_at=clock_timestamp() WHERE id=$1",[cid]);}
 assert.equal((await db.query('SELECT count(*)::int n FROM crm_ab_arm_v2 WHERE test_id=$1 AND finished_at IS NOT NULL',[f.cases.aristo.protocol.test_id])).rows[0].n,2);proof.finished_pair_guarded=true;
 await assert.rejects(db.query("UPDATE crm_ab_experiment_v2 SET state='closed',version=version+1 WHERE test_id=$1",[f.cases.aristo.protocol.test_id]));proof.premature_close_denied=true;
 console.log(JSON.stringify(proof));
 }finally{await pool.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
