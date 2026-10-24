'use strict';
// Real disposable PostgreSQL; synthetic work only, never contacts Shopify.
const a=require('node:assert/strict'),fs=require('node:fs'),{Client}=require('/app/native-pg-driver/node_modules/pg'),Q=require('../../services/dashboard-operational/source-refresh-queue.cjs');
let checks=0,reads=0,published=[],commitFailure=false,afterCommitFailure=false;
const check=(x,y=true)=>{a.deepEqual(x,y);checks++;},sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function database(slot,fn,write=true){const c=new Client({host:'127.0.0.1',user:slot==='producer'?'crm_api':'crm_worker',database:'listmonk'});await c.connect();try{await c.query(write?'BEGIN':'BEGIN READ ONLY');const v=await fn(c);if(commitFailure&&slot==='executor'){commitFailure=false;throw Error('SYNTHETIC_COMMIT_FAILURE');}await c.query(write?'COMMIT':'ROLLBACK');if(afterCommitFailure&&slot==='executor'){afterCommitFailure=false;throw Error('SYNTHETIC_AMBIGUOUS_COMMIT');}return v;}catch(e){await c.query('ROLLBACK');throw e;}finally{await c.end();}}
const make=(revision='a'.repeat(40))=>Q.create({database,sourceRevision:revision});
const run=(queue,brand='fish',extra={})=>queue.run({brand,days:30,authorize:()=>{},publish:r=>published.push(r),work:async({window,guard})=>{reads++;await guard();return {ok:true,brand,coverage:window};},...extra});
(async()=>{const root=new Client({host:'127.0.0.1',user:'postgres',database:'postgres'});await root.connect();await root.query('CREATE DATABASE listmonk');await root.end();const admin=new Client({host:'127.0.0.1',user:'postgres',database:'listmonk'});await admin.connect();try{
 await admin.query('CREATE ROLE crm_api LOGIN;CREATE ROLE crm_worker LOGIN;CREATE SCHEMA crm_worker;GRANT USAGE ON SCHEMA crm_worker TO crm_api,crm_worker;ALTER DEFAULT PRIVILEGES IN SCHEMA crm_worker GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO crm_api,crm_worker');
 for(const name of ['crm-worker-v1.sql','crm-worker-v2-audience.sql','crm-worker-v3-source.sql'])await admin.query(fs.readFileSync(__dirname+'/'+name,'utf8'));
 let release,entered=false;const hold=new Promise(r=>release=r),q1=make(),q2=make();
 const first=run(q1,'fish',{work:async({window,guard})=>{reads++;entered=true;await hold;await guard();return {ok:true,brand:'fish',coverage:window};}});
 for(let n=0;n<200&&!entered;n++)await sleep(5);check(entered);
 const second=run(q2);await sleep(150);check(reads,1);release();const results=await Promise.all([first,second]);check(results[0],results[1]);check(reads,1);check(published.length,2);
 check((await admin.query("SELECT count(*)::int n FROM crm_worker.tasks_v1 WHERE kind='source.refresh'")).rows[0].n,1);
 check((await admin.query("SELECT state FROM crm_worker.tasks_v1")).rows[0].state,'accepted');
 await run(make(),'aristo');check(reads,2);check((await admin.query('SELECT count(*)::int n FROM crm_worker.campaigns_v1')).rows[0].n,2);
 // A process disappeared after claim: reclaim the same window/task and increment attempt.
 let t=(await admin.query("SELECT * FROM crm_worker.tasks_v1 WHERE brand='fish' ORDER BY campaign_revision DESC LIMIT 1")).rows[0],window=t.payload.window;
 await admin.query("UPDATE crm_worker.tasks_v1 SET state='leased',lease_token='bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb',lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[t.id]);
 await admin.query("UPDATE crm_worker.attempts_v1 SET state='leased' WHERE task_id=$1",[t.id]);
 await run(make(),'fish',{work:async({window:actual,guard})=>{check(actual,window);await guard();return {ok:true,brand:'fish',coverage:actual};}});
 let reclaimed=(await admin.query('SELECT * FROM crm_worker.tasks_v1 WHERE id=$1',[t.id])).rows[0];check(reclaimed.attempt,2);check(reclaimed.state,'accepted');check((await admin.query('SELECT state FROM crm_worker.attempts_v1 WHERE task_id=$1 ORDER BY attempt',[t.id])).rows.map(r=>r.state),['refused','accepted']);
 // Deadline alone cannot supersede a task row that another executor holds.
 await admin.query("UPDATE crm_worker.tasks_v1 SET state='leased',lease_token='bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb',lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[t.id]);
 const blocker=new Client({host:'127.0.0.1',user:'postgres',database:'listmonk'});await blocker.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM crm_worker.tasks_v1 WHERE id=$1 FOR UPDATE',[t.id]);let lateEntered=false;
 const late=run(make(),'fish',{work:async({window,guard})=>{lateEntered=true;await guard();return {ok:true,brand:'fish',coverage:window};}});await sleep(350);check(lateEntered,false);await blocker.query('ROLLBACK');await blocker.end();await late;check(lateEntered);
 // Old revisions are closed safely, never executed under the new binary.
 await admin.query("UPDATE crm_worker.tasks_v1 SET state='leased',lease_token='bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb',lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[t.id]);
 await run(make('c'.repeat(40)));const old=(await admin.query('SELECT state,safe_code FROM crm_worker.tasks_v1 WHERE id=$1',[t.id])).rows[0];check(old.state,'refused');check(old.safe_code,'SOURCE_REFRESH_REVISION_CHANGED');
 // Failed/ambiguous commit must not project confirmed coverage.
 const before=published.length;commitFailure=true;await a.rejects(run(make('d'.repeat(40))),/SYNTHETIC_COMMIT_FAILURE/);checks++;check(published.length,before);
 // Failed source is recorded refused with no projection.
 await a.rejects(run(make(),'aristo',{work:async()=>{throw Object.assign(Error('SOURCE_DOWN'),{code:'PAID_FACTS_SHOPIFY_UNAVAILABLE'});}}),{code:'PAID_FACTS_SHOPIFY_UNAVAILABLE'});checks++;check(published.length,before);check((await admin.query("SELECT state FROM crm_worker.tasks_v1 WHERE brand='aristo' ORDER BY campaign_revision DESC LIMIT 1")).rows[0].state,'refused');
 afterCommitFailure=true;await a.rejects(run(make(),'aristo'),/SYNTHETIC_AMBIGUOUS_COMMIT/);checks++;check(published.length,before);check((await admin.query("SELECT state FROM crm_worker.tasks_v1 WHERE brand='aristo' ORDER BY campaign_revision DESC LIMIT 1")).rows[0].state,'accepted');
 await run(make(),'aristo',{days:90});const wide=(await admin.query("SELECT * FROM crm_worker.tasks_v1 WHERE brand='aristo' ORDER BY campaign_revision DESC LIMIT 1")).rows[0];check(wide.payload.window.days,90);
 await admin.query("UPDATE crm_worker.tasks_v1 SET state='leased',lease_token='bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb',lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[wide.id]);
 await run(make(),'aristo',{days:30,work:async({window,guard})=>{check(window,wide.payload.window);await guard();return {ok:true,brand:'aristo',coverage:window};}});check((await admin.query('SELECT attempt FROM crm_worker.tasks_v1 WHERE id=$1',[wide.id])).rows[0].attempt,2);
 // Production must fail closed when no native vault/queue is bound.
 await a.rejects(run(Q.create({})),{code:'SOURCE_REFRESH_QUEUE_UNAVAILABLE'});checks++;
 check((await admin.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='crm_worker'")).rows[0].n,3);
 console.log(JSON.stringify({ok:true,checks,realPostgres:true,instances:2,sourceReads:reads,customerWrites:0,providerPosts:0,workerActivated:false}));
 }finally{await admin.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
