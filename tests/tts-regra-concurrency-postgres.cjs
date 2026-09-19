/* Two independent PostgreSQL sessions, disposable synthetic database only. Never production. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Client}=require('pg');const {SCHEMA}=require('./tts-regra-postgres.cjs');
(async()=>{
 if(process.env.TTS_TEST_DATABASE_ISOLATED!=='1'||!process.env.TEST_DATABASE_URL)throw Error('Explicit isolated test database required');
 const a=new Client({connectionString:process.env.TEST_DATABASE_URL}),b=new Client({connectionString:process.env.TEST_DATABASE_URL});
 const patch=(c,p,expected=null)=>c.query('SELECT crm_tts_regra_patch_v1($1,$2::jsonb,$3,$4) AS result',['fish',JSON.stringify(p),'synthetic',expected]);
 let pending;
 try{
  await a.connect();await b.connect();
  assert.match((await a.query('SELECT current_database() AS name')).rows[0].name,/^tts_regra_test(?:_[a-z0-9]+)?$/,'reserved disposable DB name required');
  assert.equal((await a.query("SELECT to_regclass('public.crm_tts_regra') AS name")).rows[0].name,null,'fixture database must start empty');
  await a.query(SCHEMA);await a.query(fs.readFileSync(path.join(__dirname,'../n8n/tiktok/regra-update.sql'),'utf8'));
  const pid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  async function waitLocked(){
   for(let i=0;i<100;i++){
    const r=await a.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid]);
    if(r.rows[0]?.wait_event_type==='Lock')return;
    await new Promise(resolve=>setTimeout(resolve,20));
   }
   assert.fail('Second independent session did not wait for row lock');
  }
  // Caller B would accept 60 against old 100, but must reject after A commits 50.
  await a.query('BEGIN');assert.equal((await patch(a,{gmv_auto:50})).rows[0].result.ok,true);
  pending=patch(b,{gmv_manual:60});await waitLocked();await a.query('COMMIT');
  let result=(await pending).rows[0].result;pending=null;
  assert.equal(result.codigo,'gmv_incompativel');assert.equal(result.regra_atual.gmv_auto,50);assert.equal(result.regra_atual.gmv_manual,10);
  // Independent valid partial patches merge without losing the first committed field.
  await a.query('BEGIN');assert.equal((await patch(a,{gmv_auto:70})).rows[0].result.ok,true);
  pending=patch(b,{gmv_manual:20});await waitLocked();await a.query('COMMIT');
  result=(await pending).rows[0].result;pending=null;
  assert.equal(result.ok,true);assert.equal(result.regra_atual.gmv_auto,70);assert.equal(result.regra_atual.gmv_manual,20);
  // A mode change from a stale screen waits, then returns the actual new version.
  const old=result.regra_atual.atualizado_em;
  await a.query('BEGIN');const first=(await patch(a,{modo:'pausado'},old)).rows[0].result;
  pending=patch(b,{cobranca_modo:'dry_run'},old);await waitLocked();await a.query('COMMIT');
  result=(await pending).rows[0].result;pending=null;
  assert.equal(result.codigo,'regra_alterada');assert.equal(result.regra_atual.modo,'pausado');assert.equal(result.regra_atual.cobranca_modo,'pausado');assert.equal(result.regra_atual.atualizado_em,first.regra_atual.atualizado_em);
  console.log('PASS PostgreSQL two-session lock contention: invalid partial rejected against fresh row, valid patches merged, stale mode refused; synthetic fixtures only.');
 }finally{
  await a.query('ROLLBACK').catch(()=>{});if(pending)await pending.catch(()=>{});await Promise.allSettled([a.end(),b.end()]);
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
