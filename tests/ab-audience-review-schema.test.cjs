'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{PGlite}=require('@electric-sql/pglite');
const F=require('./ab-audience-review-fixture.cjs'),Prepare=require('./ab-audience-prepare-fixture.cjs'),R=require('../n8n/growth/ab-audience-review.cjs'),H=require('../n8n/growth/segment-audience-review.cjs');
const DDL=F.read('n8n/growth/ab-audience-review.sql');let serial=80000;
const pgError=(code,message)=>e=>e?.code===code&&e.message===message;
async function dbFor(t){const db=new PGlite();t.after(()=>db.close());return db;}
async function fixture(t){const db=await dbFor(t),x=await F.setup(db),p=await x.prepared(),r=await x.review(p);assert.equal(r.status,201,'valid fixture review must exist before testing a guard');assert.equal(r.body.review.status,'confirmed');return {...x,preparedReview:p,first:r.body.review};}
const objects=async db=>(await db.query(`SELECT (SELECT oid::text FROM pg_class WHERE oid=to_regclass('crm_audience_v2.ab_review')) AS review,
 (SELECT oid::text FROM pg_class WHERE oid=to_regclass('crm_audience_v2.ab_review_request')) AS receipt,
 (SELECT oid::text FROM pg_class WHERE oid=to_regclass('crm_audience_v2.ab_review_review_sequence_seq')) AS sequence,
 (SELECT oid::text FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.ab_review_guard()')) AS guard`)).rows[0];
const rows=async db=>({review:(await db.query('SELECT * FROM crm_audience_v2.ab_review ORDER BY review_sequence')).rows,receipt:(await db.query('SELECT * FROM crm_audience_v2.ab_review_request ORDER BY actor,operation_key')).rows});
async function record(x){const row=(await x.db.query('SELECT * FROM crm_audience_v2.ab_review ORDER BY review_sequence DESC LIMIT 1')).rows[0];assert.ok(row);return row;}
function fresh(row){const value=structuredClone(row);value.review_id=F.uuid(++serial);value.evidence.review.review_id=value.review_id;return value;}
function params(row){return [row.review_id,row.test_id,row.brand,row.actor,JSON.stringify(row.evidence),H.digest(row.evidence)];}

test('review install refuses missing dependencies with exact error and creates no objects; same connection stays healthy',async t=>{
 const db=await dbFor(t);await assert.rejects(db.exec(DDL),pgError('P0001','AB_AUDIENCE_REVIEW_DEPENDENCY'));assert.deepEqual(await objects(db),{review:null,receipt:null,sequence:null,guard:null});assert.equal((await db.query('SELECT 1 AS healthy')).rows[0].healthy,1);
});
test('single-DO installation rolls back all late DDL on error, then succeeds once and rejects collision without altering objects',async t=>{
 const db=await dbFor(t);await Prepare.setup(db);const before=await db.query('SELECT count(*)::int n FROM public.crm_ab_experiment_v2');
 const marker='END $ab_audience_review_install$;';assert.equal(DDL.split(marker).length,2);const broken=DDL.replace(marker,"RAISE EXCEPTION 'FIXTURE_REVIEW_INSTALL_ABORT';\n"+marker);
 await assert.rejects(db.exec(broken),pgError('P0001','FIXTURE_REVIEW_INSTALL_ABORT'));assert.deepEqual(await objects(db),{review:null,receipt:null,sequence:null,guard:null});assert.deepEqual((await db.query('SELECT count(*)::int n FROM public.crm_ab_experiment_v2')).rows,before.rows);assert.equal((await db.query('SELECT 1 AS healthy')).rows[0].healthy,1);
 await db.exec(DDL);const installed=await objects(db);assert.ok(Object.values(installed).every(v=>typeof v==='string'));assert.deepEqual(await rows(db),{review:[],receipt:[]});
 await assert.rejects(db.exec(DDL),pgError('P0001','AB_AUDIENCE_REVIEW_INSTALL_COLLISION'));assert.deepEqual(await objects(db),installed);assert.deepEqual(await rows(db),{review:[],receipt:[]});
});
test('existing review and receipt reject UPDATE/DELETE with the append-only error; PUBLIC has no grants',async t=>{
 const x=await fixture(t),before=await rows(x.db);assert.equal(before.review.length,1);assert.equal(before.receipt.length,1);
 for(const table of ['ab_review','ab_review_request']){
  for(const sql of [`UPDATE crm_audience_v2.${table} SET actor=actor`,`DELETE FROM crm_audience_v2.${table}`])await assert.rejects(x.db.transaction(tx=>tx.query(sql)),pgError('P0001','AUDIENCE_HISTORY_IMMUTABLE'));
  const truncateGuard=(await x.db.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal AND (tgtype & 32)=32",['crm_audience_v2.'+table])).rows[0].n;
  // The initial schema has no TRUNCATE trigger. Never label an untested owner
  // TRUNCATE as denied; if one is installed, exercise it with populated rows.
  if(truncateGuard)await assert.rejects(x.db.transaction(tx=>tx.query('TRUNCATE crm_audience_v2.'+table)),pgError('P0001','AUDIENCE_HISTORY_IMMUTABLE'));
 }
 assert.deepEqual(await rows(x.db),before);
 const publicGrants=(await x.db.query("SELECT count(*)::int n FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid=ANY(ARRAY['crm_audience_v2.ab_review'::regclass,'crm_audience_v2.ab_review_request'::regclass,'crm_audience_v2.ab_review_review_sequence_seq'::regclass]) AND a.grantee=0")).rows[0].n;assert.equal(publicGrants,0);
 assert.equal((await x.review(x.preparedReview)).status,201,'guard rejection must not poison the connection');
});
test('GENERATED ALWAYS rejects arbitrary normal INSERT sequences and valid service writes retain monotonic head ordering',async t=>{
 const x=await fixture(t),row=await record(x),copy=fresh(row),before=await rows(x.db);
 const identity=(await x.db.query("SELECT attidentity FROM pg_attribute WHERE attrelid='crm_audience_v2.ab_review'::regclass AND attname='review_sequence'")).rows[0];assert.equal(identity.attidentity,'a');
 const sql='INSERT INTO crm_audience_v2.ab_review(review_id,test_id,brand,actor,evidence,evidence_hash,review_sequence) VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6,$7)';
 for(const arbitrary of [0,999999999])await assert.rejects(x.db.transaction(tx=>tx.query(sql,[...params(copy),arbitrary])),e=>e.code==='428C9'&&e.message.includes('review_sequence'));
 assert.deepEqual(await rows(x.db),before);const next=await x.review(x.preparedReview);assert.equal(next.status,201);const latest=await record(x);assert.ok(BigInt(latest.review_sequence)>BigInt(row.review_sequence));assert.equal(latest.review_id,next.body.review.review_id);assert.deepEqual((await x.latest(x.preparedReview)).body.review,next.body.review);
 // This is the ordinary INSERT guarantee, not protection against a database
 // owner explicitly using OVERRIDING SYSTEM VALUE or changing the schema.
});
test('real confirmed evidence cannot substitute scope, status, identity, arm counts or validity window',async t=>{
 const x=await fixture(t),base=await record(x),before=await rows(x.db);
 const changes=[r=>r.evidence.review.status='sent',r=>r.evidence.review.snapshot_only=false,r=>r.evidence.scope.base_list_id++,r=>r.evidence.review.scope_hash='a'.repeat(64),r=>r.evidence.review.cohort_hash='a'.repeat(64),r=>r.evidence.review.experiment_version++,r=>r.evidence.review.review_id=F.uuid(++serial),r=>r.evidence.review.brand='aristo',r=>r.evidence.review.extra='untrusted',r=>r.evidence.extra='untrusted',r=>r.evidence.review.arms[0].campaign_id++,r=>r.evidence.review.arms[0].eligible=String(r.evidence.review.arms[0].eligible),r=>r.evidence.review.arms[0].eligible++,r=>r.evidence.review.arms[0].revoked=r.evidence.review.arms[0].excluded+1,r=>r.evidence.review.expires_at=new Date(Date.now()-1000).toISOString(),r=>r.evidence.review.expires_at=new Date(Date.parse(r.evidence.review.checked_at)+300001).toISOString(),r=>r.evidence.review.arms.reverse()];
 for(const change of changes){const candidate=fresh(base);change(candidate);await assert.rejects(x.db.transaction(tx=>tx.query(R.SQL.insert,params(candidate))),pgError('P0001','AB_AUDIENCE_REVIEW_EVIDENCE'));}
 const foreign=fresh(base);foreign.brand='aristo';foreign.evidence.review.brand='aristo';await assert.rejects(x.db.transaction(tx=>tx.query(R.SQL.insert,params(foreign))),pgError('P0001','AB_AUDIENCE_REVIEW_STATE'));
 await x.db.transaction(async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await assert.rejects(tx.query(R.SQL.insert,params(fresh(base))),pgError('P0001','AB_AUDIENCE_REVIEW_ISOLATION'));});
 assert.deepEqual(await rows(x.db),before);assert.equal((await x.latest(x.preparedReview)).body.review.review_id,base.review_id);
});
test('real unavailable evidence requires null decision counts and an allowed reason; receipt shape constraints reject non-objects',async t=>{
 const x=await fixture(t);await x.db.query("UPDATE crm_audience_v2.config SET enabled=false WHERE brand='fish'");const unavailable=await x.review(x.preparedReview);assert.equal(unavailable.status,201);assert.equal(unavailable.body.review.status,'unavailable');const base=await record(x),before=await rows(x.db);
 for(const change of [r=>r.evidence.review.reason='ready_to_send',r=>r.evidence.review.minimum_reached=true,r=>r.evidence.review.eligible_fingerprint='a'.repeat(64),r=>r.evidence.review.arms[0].eligible=0,r=>r.evidence.review.arms[1].missing=0,r=>r.evidence.review.expires_at=new Date(Date.parse(r.evidence.review.checked_at)+1).toISOString()]){const candidate=fresh(base);change(candidate);await assert.rejects(x.db.transaction(tx=>tx.query(R.SQL.insert,params(candidate))),pgError('P0001','AB_AUDIENCE_REVIEW_EVIDENCE'));}
 const original=before.receipt[0],receipt=()=>[original.actor,F.uuid(++serial),original.brand,JSON.stringify(original.payload),original.payload_hash,JSON.stringify(original.response)];
 for(const [index,value,constraint]of [[3,'[]','ab_review_request_payload_check'],[5,'[]','ab_review_request_response_check'],[4,'not-a-hash','ab_review_request_payload_hash_check'],[0,'not-panel','ab_review_request_actor_check']]){const p=receipt();p[index]=value;await assert.rejects(x.db.transaction(tx=>tx.query(R.SQL.receipt,p)),e=>e.code==='23514'&&e.constraint===constraint);}
 assert.deepEqual(await rows(x.db),before);assert.deepEqual((await x.latest(x.preparedReview)).body.review,unavailable.body.review);
});
