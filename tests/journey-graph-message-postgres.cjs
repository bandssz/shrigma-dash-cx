/* Independent transactions in disposable PostgreSQL; synthetic contacts, no HTTP. */
'use strict';
const assert=require('node:assert/strict'),{Pool}=require('pg'),fs=require('node:fs');
const {fixture}=require('./journey-graph-material-fixture.cjs'),{id}=require('./journey-graph-source-fixture.cjs');
const N=require('../n8n/growth/journey-graph-native.cjs'),{createMessagePreflight}=require('../n8n/growth/journey-graph-message.cjs');
(async()=>{
 const u=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');assert.equal(process.env.GRAPH_TEST_DATABASE_ISOLATED,'1');assert.ok(['localhost','127.0.0.1'].includes(u.hostname));assert.equal(u.pathname,'/journey_graph_message_test');assert.equal(u.username,'synthetic');assert.equal(u.password,'');assert.equal(u.port,'5432');assert.equal(u.search,'');assert.equal(u.hash,'');
 const pool=new Pool({connectionString:u.toString(),max:6,statement_timeout:10000,connectionTimeoutMillis:3000,application_name:'graph-message-synthetic-proof'});let blocker,pending;
 try{
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','crm_graph_candidate') AND c.relkind IN ('r','p','v')")).rows[0].n,0);
  const db={exec:q=>pool.query(q),query:(q,a)=>pool.query(q,a),close:async()=>{}},x=await fixture({after(){}},db,pool);
  await pool.query('ALTER TABLE templates ADD COLUMN is_default boolean NOT NULL DEFAULT false;ALTER TABLE templates ADD COLUMN updated_at timestamptz DEFAULT clock_timestamp();');
  await pool.query(fs.readFileSync(require.resolve('../n8n/growth/journey-graph-native.sql'),'utf8'));let seq=9100;
  for(const brand of ['fish','aristo']){
   const f=await x.prepare(brand,true),e=await f.atMessage(),intent=await f.api.step(f.request({entry_id:e.entry_id,expected_version:e.version})),cacheTarget='synthetic-instance';
   const options={query:x.query,cacheTarget,nativeRead:async()=>{throw Error('NO_HTTP');},nativeCreate:async b=>({status:200,body:{data:(await x.query('INSERT INTO templates(id,name,type,subject,body,body_source) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[seq++,b.name,b.type,b.subject,b.body,b.body_source])).rows[0]}})};
   const n=N.createNativeProvider(options),receipt=await n.prepare('panel:synthetic',{request_id:id(seq++),brand,release_id:f.release.id,expected_material_sha256:f.release.material_sha256});await n.create(brand,receipt.native_id);
   let during=async()=>{};
   const api=createMessagePreflight({pool,cacheTarget,readSource:f.settings.readSource,resolveNative:async({query,...a})=>{await during();return N.createNativeProvider({...options,query}).resolve(a.brand,a.release_id,a.material_sha256);}}),request={brand,intent_id:intent.intent_id};
   assert.equal((await api.prepare(request)).authorizes_send,false);
   const baseList=brand==='fish'?17:16;
   during=async()=>{await pool.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=$1",[baseList]);};
   await assert.rejects(api.prepare(request),/SOURCE_CHANGED/);await pool.query("UPDATE subscriber_lists SET status='confirmed' WHERE list_id=$1",[baseList]);during=async()=>{};
   // Lock the native guard recheck with a prior edit transaction. The callback
   // cannot return a stale ready receipt if the row changes before it proceeds.
   const ready=await n.inspect(brand,receipt.native_id);blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('UPDATE templates SET updated_at=clock_timestamp() WHERE id=$1',[ready.clone_template_id]);
   pending=api.prepare(request).then(value=>({value}),error=>({error}));
   let locked=false;for(let k=0;k<70&&!locked;k++){locked=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='graph-message-synthetic-proof' AND wait_event_type='Lock' AND query LIKE 'SELECT crm_graph_candidate.native_resolve_v1%') yes")).rows[0].yes;if(!locked)await new Promise(r=>setTimeout(r,20));}assert.equal(locked,true);
   await pool.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=$1",[baseList]);await blocker.query('COMMIT');blocker.release();blocker=null;const outcome=await pending;pending=null;assert.match(outcome.error?.code||'',/SOURCE_CHANGED/);await pool.query("UPDATE subscriber_lists SET status='confirmed' WHERE list_id=$1",[baseList]);
   assert.equal((await x.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
   console.log('PASS '+brand+': native snapshot to private preflight; concurrent optout before and during locked clone resolution blocks, no dispatch.');
  }
 }finally{if(blocker){try{await blocker.query('ROLLBACK');}finally{blocker.release();}}if(pending)await pending;await pool.end();}
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
