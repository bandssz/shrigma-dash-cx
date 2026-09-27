'use strict';
// Disposable CI only: exact loopback database, synthetic manager, no source or transport.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {createDraftApi}=require('../n8n/growth/journey-graph-draft-api.cjs'),{fixture,id,faultPool}=require('./fixtures/journey-graph-runtime.cjs');
async function run(){
 const url=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');assert.equal(process.env.GRAPH_TEST_DATABASE_ISOLATED,'1');assert.ok(['localhost','127.0.0.1'].includes(url.hostname));assert.equal(url.pathname,'/journey_graph_api_test');assert.equal(url.username,'synthetic');assert.equal(url.password,'');assert.equal(url.port,'5432');assert.equal(url.search,'');assert.equal(url.hash,'');
 const {Pool}=require('pg'),pool=new Pool({connectionString:url.toString(),max:6,connectionTimeoutMillis:3000,statement_timeout:10000,application_name:'synthetic-graph-api-proof'});let blocker;
 try{
  assert.equal((await pool.query('SHOW server_version_num')).rows[0].server_version_num,'170010');
  assert.equal((await pool.query("SELECT to_regnamespace('crm_graph_candidate') AS s,to_regclass('public.crm_dash_chave') AS a")).rows[0].s,null);assert.equal((await pool.query("SELECT to_regclass('public.crm_dash_chave') AS a")).rows[0].a,null);
  for(const file of ['tests/fixtures/journey-graph-auth.sql','n8n/access/panel-operator.sql','n8n/growth/journey-graph-store.sql'])await pool.query(fs.readFileSync(path.join(__dirname,'..',file),'utf8'));
  const authSource=fs.readFileSync(path.join(__dirname,'../n8n/access/panel-short-keys.sql'),'utf8'),authStart=authSource.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_panel_operator_v1(k text,a text)'),authEnd=authSource.indexOf('REVOKE ALL ON FUNCTION public.shrigma_panel_operator_v1(text,text) FROM PUBLIC;',authStart);
  assert.ok(authStart>=0&&authEnd>authStart);await pool.query(authSource.slice(authStart,authEnd)+'REVOKE ALL ON FUNCTION public.shrigma_panel_operator_v1(text,text) FROM PUBLIC;');
  await pool.query("INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash,chave_hash_curta) VALUES('manager','growth','Synthetic',$1,$2)",['synthetic-manager-key','synshort'].map(k=>createHash('sha256').update(k).digest('hex')));
  await pool.query("INSERT INTO shrigma_panel_permission_v1 VALUES('manager','growth','[\"draft\",\"read_content\"]')");
  const f=fixture(pool),catalogFor=async()=>JSON.parse(JSON.stringify(f.catalog)),api=createDraftApi({pool,catalogFor});
  const call=(request,target=api)=>target.handle({method:['create','save'].includes(request.action)?'POST':'GET',authorization:'Bearer synshort',request});
  const request={action:'create',brand:'fish',request_id:id(3000),definition:f.graph};
  const both=await Promise.all([call(request),call(request,createDraftApi({pool,catalogFor}))]);assert.deepEqual(both[0],both[1]);assert.equal(both[0].status,201);const j=both[0].body.receipt;
  assert.deepEqual(await api.handle({method:'POST',authorization:'Bearer synthetic-manager-key',request}),both[0]);
  assert.equal(Number((await pool.query('SELECT count(*) n FROM crm_graph_candidate.journey')).rows[0].n),1);
  const save={action:'save',brand:'fish',journey_id:j.journey_id,expected_version:1,definition:{...f.graph,name:'Concurrent draft'}};
  const saved=await Promise.all([call({...save,request_id:id(3001)}),call({...save,request_id:id(3002)})]);assert.deepEqual(saved.map(r=>r.status).sort(),[200,409]);
  console.log('PASS API concurrent replay and save: one creation, one version winner, long and short keys resolve the same manager and receipt.');

  const pending={...request,request_id:id(3003)};
  blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[pending.request_id]);
  const blockerPid=(await blocker.query('SELECT pg_backend_pid() id')).rows[0].id;
  const promise=call(pending).then(value=>({value}),error=>({error}));let locked=false;
  for(let i=0;i<80&&!locked;i++){locked=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='synthetic-graph-api-proof' AND pid<>$1 AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%') AS locked",[blockerPid])).rows[0].locked;if(!locked)await new Promise(r=>setTimeout(r,20));}
  assert.ok(locked,'write demonstrably waits on the request lock');
  const lookup=await call({action:'operation',brand:'fish',request_id:pending.request_id});assert.equal(lookup.status,202);assert.equal(lookup.body.state,'unconfirmed');assert.equal(lookup.body.retry_same_request_only,true);
  await pool.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"read_content\"]' WHERE principal_id='manager'");
  await blocker.query('COMMIT');blocker.release();blocker=null;const denied=await promise;if(denied.error)throw denied.error;assert.equal(denied.value.status,403);
  assert.equal(Number((await pool.query('SELECT count(*) n FROM crm_graph_candidate.operation WHERE request_id=$1',[pending.request_id])).rows[0].n),0);
  await pool.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"draft\",\"read_content\"]' WHERE principal_id='manager'");assert.equal((await call(pending)).status,201);
  console.log('PASS API permission revoked while waiting: fresh transactional authorization rejects mutation; in-flight reconciliation stays unconfirmed.');

  let commits=0;const lost=createDraftApi({pool:faultPool(pool,{after:q=>q==='COMMIT'&&++commits===2}),catalogFor}),last={...request,request_id:id(3004)};
  const unknown=await call(last,lost);assert.equal(unknown.status,202);assert.equal(unknown.body.state,'unconfirmed');
  const operation=await call({action:'operation',brand:'fish',request_id:last.request_id});assert.equal(operation.status,200);assert.equal(operation.body.state,'succeeded');
  assert.deepEqual((await call(last)).body.receipt,operation.body.receipt);
  assert.equal(Number((await pool.query('SELECT count(*) n FROM crm_graph_candidate.journey')).rows[0].n),3);
  assert.equal(Number((await pool.query('SELECT count(*) n FROM crm_graph_candidate.entry')).rows[0].n),0);assert.equal(Number((await pool.query('SELECT count(*) n FROM crm_graph_candidate.intent')).rows[0].n),0);
  assert.equal((await pool.query('SELECT enabled FROM crm_graph_candidate.control')).rows[0].enabled,false);
  console.log('PASS API lost response: original receipt recovered, no new identity, no participants/intents and global OFF preserved.');
 }finally{if(blocker){try{await blocker.query('ROLLBACK');}finally{blocker.release();}}await pool.end();}
}
run().catch(e=>{console.error('FAIL graph draft API:',e.code||'',e.message);process.exitCode=1;});
