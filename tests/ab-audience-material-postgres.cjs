'use strict';
// One empty, disposable loopback database. No production credential lookup.
const assert=require('node:assert/strict'),{Pool}=require('pg');
const F=require('./ab-audience-material-read-fixture.cjs'),R=require('../n8n/growth/ab-audience-material-read.cjs'),S=require('../n8n/growth/segment-audience-store.cjs');
const connectionString=process.env.TEST_DATABASE_URL;
if(process.env.AB_MATERIAL_TEST_DATABASE_ISOLATED!=='1'||!connectionString)throw Error('ISOLATED_DATABASE_REQUIRED');
const url=new URL(connectionString);if(url.protocol!=='postgresql:'||url.hostname!=='127.0.0.1'||url.pathname!=='/ab_audience_material_test'||!url.port||url.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const pool=new Pool({connectionString,max:8,statement_timeout:20000,connectionTimeoutMillis:5000}),clients=[];
const db={query:(q,v)=>pool.query(q,v),exec:q=>pool.query(q),transaction:async work=>{const c=await pool.connect();let destroy=false;try{await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');const v=await work(c);await c.query('COMMIT');return v;}catch(e){try{await c.query('ROLLBACK');}catch{destroy=true;}throw e;}finally{c.release(destroy);}}};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{try{
 const meta=(await db.query("SELECT current_database() db,current_setting('server_version_num')::int version,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','v','m','S')) existing")).rows[0];assert.equal(meta.db,'ab_audience_material_test');assert.equal(meta.version,170010);assert.equal(meta.existing,0);
 const x=await F.setup(db),first=await x.read(),aristo=await x.read('aristo');assert.equal(first.materials.length,2);assert.equal(aristo.materials.length,2);
 const a=await pool.connect(),blocker=await pool.connect(),relation=await pool.connect(),media=await pool.connect();clients.push(a,blocker,relation,media);
 const pids=await Promise.all(clients.map(c=>c.query('SELECT pg_backend_pid() pid').then(r=>r.rows[0].pid)));assert.equal(new Set(pids).size,4);
 const blocked=async pid=>{const end=Date.now()+300;while(Date.now()<end){if((await db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type==='Lock')return true;await pause(5);}return false;};
 await blocker.query('BEGIN');await blocker.query("UPDATE templates SET body='<article>{{ template \"content\" . }}</article>' WHERE id=1");
 await a.query('BEGIN ISOLATION LEVEL READ COMMITTED');await a.query(S.SQL.setup);await a.query("SELECT set_config('TimeZone','UTC',true),set_config('DateStyle','ISO, YMD',true)");
 const reading=R.readCampaignMaterials({query:(q,v)=>a.query(q,v),brand:'fish',campaignIds:[101,100]});assert.equal(await blocked(pids[0]),true);
 await relation.query('BEGIN');await relation.query("SELECT set_config('shrigma.campaign_writer','100',true)");let relationDone=false;
 const inserting=relation.query("INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(100,101,'Synthetic leaf')").then(r=>{relationDone=true;return r;});
 assert.equal(await blocked(pids[2]),true);await blocker.query('COMMIT');
 const current=await reading;assert.equal(current.materials[0].snapshot.template.body,'<article>{{ template "content" . }}</article>');assert.notEqual(current.materials[0].material_hash,first.materials[0].material_hash);assert.equal(current.materials[0].snapshot.lists.length,1);assert.equal(relationDone,false);
 await media.query('BEGIN');let mediaDone=false;const updatingMedia=media.query("UPDATE media SET filename='replacement.pdf' WHERE id=1").then(r=>{mediaDone=true;return r;});assert.equal(await blocked(pids[3]),true);assert.equal(mediaDone,false);
 // Reader has returned, but all row/relationship locks still belong to caller.
 await a.query('COMMIT');await inserting;await relation.query('COMMIT');await updatingMedia;await media.query('COMMIT');
 const later=await x.read();assert.equal(later.materials[0].snapshot.lists.length,2);assert.equal(later.materials[0].snapshot.media[0].media.filename,'replacement.pdf');assert.notEqual(later.materials[0].material_hash,current.materials[0].material_hash);
 const legacy=await x.current(100);await db.query("UPDATE campaigns SET updated_at=clock_timestamp()+interval '1 second' WHERE id=100");const onlyClock=await x.read();assert.notEqual((await x.current(100)).version,legacy.version);assert.deepEqual(onlyClock.materials,later.materials);
 await a.query('BEGIN');await a.query(S.SQL.setup);await a.query("SELECT set_config('TimeZone','America/Sao_Paulo',true)");await assert.rejects(R.readCampaignMaterials({query:(q,v)=>a.query(q,v),brand:'fish',campaignIds:[100]}),e=>e.code==='AB_MATERIAL_READ_BOUNDARY');await a.query('ROLLBACK');
 await db.query('UPDATE media SET meta=$1::jsonb WHERE id=1',['{"precise":1.00000000000000001}']);await assert.rejects(x.read(),e=>e.code==='AB_MATERIAL_READ_UNCONFIRMED');
 assert.deepEqual((await db.query('SELECT DISTINCT status,sent,started_at FROM campaigns WHERE id IN(100,101,200,201)')).rows,[{status:'draft',sent:0,started_at:null}]);assert.equal((await db.query('SELECT enabled FROM crm_ab_runtime_v2')).rows[0].enabled,false);
 console.log(JSON.stringify({ok:true,postgres_version:meta.version,independent_connections:4,template_update_wait_uses_committed_content:true,new_relation_waits_outside_snapshot:true,media_write_waits_until_caller_commit:true,hash_changes_for_dependencies:true,native_timestamp_md5_changes_material_stable:true,non_utc_session_rejected:true,decimal_rounding_rejected_before_json_parse:true,runtime_off:true,transport:false}));
}finally{for(const c of clients){try{await c.query('ROLLBACK');}catch{}c.release();}await pool.end();}})().catch(e=>{console.error('AB_MATERIAL_POSTGRES_PROOF_FAILED',e.code||e.name,e.message);process.exitCode=1;});
