/* Disposable PostgreSQL only. No native HTTP, recipient, production DB or send. */
'use strict';
const assert=require('node:assert/strict'),{Pool}=require('pg'),R=require('../n8n/growth/journey-graph-release.cjs'),{install,id}=require('./journey-graph-release-fixture.cjs');
(async()=>{
 const u=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');assert.equal(process.env.GRAPH_TEST_DATABASE_ISOLATED,'1');assert.ok(['localhost','127.0.0.1'].includes(u.hostname));assert.equal(u.pathname,'/journey_graph_release_test');assert.equal(u.username,'synthetic');assert.equal(u.password,'');assert.equal(u.port,'5432');assert.equal(u.search,'');assert.equal(u.hash,'');
 const pool=new Pool({connectionString:u.toString(),max:6,connectionTimeoutMillis:3000,statement_timeout:10000,application_name:'synthetic-graph-release-proof'});let blocker;
 try{
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','crm_graph_candidate') AND c.relkind IN ('r','p','v')")).rows[0].n,0,'requires empty disposable DB');
  const f=await install({exec:q=>pool.query(q),query:(q,a)=>pool.query(q,a)}),p=await f.request(),actor='panel:synthetic';
  const both=await Promise.all([f.provider.prepare(actor,p),f.provider.prepare(actor,p)]);assert.equal(both[0].id,both[1].id);assert.equal((await pool.query('SELECT count(*)::int n FROM crm_graph_candidate.message_release_request_v1')).rows[0].n,1);
  const separate=await f.provider.prepare(actor,await f.request());assert.equal(separate.id,both[0].id);await assert.rejects(f.provider.prepare('panel:another',p),/REPLAY_MISMATCH/);
  const source=await f.source('fish'),pending=await f.request(),material=R.prepareMaterial(source);blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query("UPDATE templates SET subject='New synthetic source' WHERE id=60");
  const waiting=f.query('SELECT crm_graph_candidate.release_prepare_v1($1,$2,$3,$4) AS result',[actor,pending,source,material]);const rejected=assert.rejects(waiting,/SOURCE_CHANGED/);
  let locked=false;for(let i=0;i<50;i++){locked=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='synthetic-graph-release-proof' AND wait_event_type='Lock' AND query LIKE 'SELECT crm_graph_candidate.release_prepare_v1%') yes")).rows[0].yes;if(locked)break;await new Promise(r=>setTimeout(r,20));}assert.equal(locked,true,'prepare waits for the selected native template lock');
  await blocker.query('COMMIT');blocker.release();blocker=null;await rejected;assert.equal((await pool.query('SELECT count(*)::int n FROM crm_graph_candidate.message_release_v1')).rows[0].n,1);
  const latest=await f.provider.prepare(actor,await f.request());assert.notEqual(latest.id,both[0].id);assert.equal((await f.provider.read('fish',both[0].id)).material.native.subject,'Seu carrinho');
  await pool.query("CREATE FUNCTION crm_graph_candidate.receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic receipt failure';END$$;CREATE TRIGGER receipt_fault BEFORE INSERT ON crm_graph_candidate.message_release_request_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.receipt_fault();UPDATE templates SET subject='Another synthetic revision' WHERE id=60;");
  await assert.rejects(f.provider.prepare(actor,{...await f.request(),request_id:id(900)}),/synthetic receipt failure/);assert.equal((await pool.query('SELECT count(*)::int n FROM crm_graph_candidate.message_release_v1')).rows[0].n,2);assert.equal((await pool.query('SELECT 1 ok')).rows[0].ok,1);
  console.log(JSON.stringify({proof:'journey_graph_release_postgres_v1',concurrent_replay:true,content_dedup:true,source_lock_recheck:true,immutable_snapshot:true,receipt_failure_atomic:true,transport_calls:0}));
 }finally{if(blocker){try{await blocker.query('ROLLBACK');}finally{blocker.release();}}await pool.end();}
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
