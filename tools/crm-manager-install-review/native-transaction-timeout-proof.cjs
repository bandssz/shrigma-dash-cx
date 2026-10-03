"use strict";
// Import is inert. SQL is admitted only on the native fixture's guarded DB.
const assert=require('node:assert/strict');
const F=require('./native-fixture.cjs');
const EXPECTED='4f5b8bdec729d2924c043da6bd3c0f8f2ce01a82af614187cefa1322ecef11c9';
const OPTIONS='-c search_path=pg_catalog -c statement_timeout=4000 -c lock_timeout=500 -c idle_in_transaction_session_timeout=5000 -c transaction_timeout=500';
const IDENTITY="SELECT current_database() AS database,current_user AS role,session_user AS session_role,current_setting('server_version_num')::int/10000 AS major,inet_server_port() AS port,current_setting('application_name') AS app,current_setting('cluster_name') AS cluster,pg_backend_pid() AS pid,current_setting('transaction_timeout') AS transaction_timeout,current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout,current_setting('idle_in_transaction_session_timeout') AS idle_timeout,current_setting('idle_session_timeout') AS idle_session_timeout";
function timedConfig(){return {...F.clientConfig(),options:OPTIONS,query_timeout:5000,statement_timeout:4000,lock_timeout:500,idle_in_transaction_session_timeout:5000};}
function projection(p){return {host:p.host,port:p.port,database:p.database,user:p.user,password:p.password,ssl:p.ssl,application_name:p.application_name,options:p.options};}
function construct(Client,timed){const config=timed?timedConfig():F.clientConfig(),client=new Client(config);assert.deepEqual(projection(client.connectionParameters),projection(config));const fatal=[];client.on('error',error=>{if(error?.code==='25P04'&&error?.severity==='FATAL')fatal.push('25P04');});return {client,fatal};}
async function connectTimed(Client){const state=construct(Client,true);try{await state.client.connect();const row=(await state.client.query(IDENTITY)).rows[0];const pid=row.pid;assert.equal(Number.isInteger(pid)&&pid>0,true);assert.deepEqual({...row,pid:undefined},{database:'listmonk',role:'postgres',session_role:'postgres',major:17,port:5432,app:'shrigma-manager-v3-private-fixture',cluster:'shrigma-native-v3-disposable-only',pid:undefined,transaction_timeout:'500ms',statement_timeout:'4s',lock_timeout:'500ms',idle_timeout:'5s',idle_session_timeout:'0'});return {...state,pid};}catch(error){try{await state.client.end();}catch{}throw error;}}
async function end(state){if(!state)return;try{await state.client.end();}catch{}}
async function restored(db,baseline){assert.deepEqual(await F.legacySnapshot(db),baseline);const row=(await db.query("SELECT (SELECT count(*)::int FROM pg_roles WHERE rolname IN ('crm_manager_function_owner_v1','crm_manager_provisioner')) AS roles,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'shrigma_crm_manager_%') AS relations,(SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'shrigma_crm_manager_%') AS functions,to_regclass('public.transaction_timeout_rolled_back_probe') IS NULL AS probe_absent")).rows[0];assert.deepEqual(row,{roles:0,relations:0,functions:0,probe_absent:true});}
function committed(result){const all=Array.isArray(result)?result:[result];assert.equal(all.at(-1)?.command,'COMMIT');}
async function profile(client){const result=await client.query('BEGIN;SET LOCAL search_path=pg_catalog;'+F.source('profile.sql')+'ROLLBACK;');const rows=F.flattenRows(result);assert.equal(rows.length,1);assert.equal(rows[0].profile_sha256,EXPECTED);}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function proveTransactionTimeout500(t,{Client,db,baseline}){
 // This membership check rejects an arbitrary DB adapter before any transport.
 assert.deepEqual(await F.legacySnapshot(db),baseline);await restored(db,baseline);
 await t.test('exact install and empty rollback commit under session transaction budget 500ms',async()=>{
  let timed;
  try{
   timed=await connectTimed(Client);
   // No transaction is open while waiting here: the 500ms clock is not a
   // connection deadline. No connection-wide idle timeout is added to the executor profile.
   await wait(650);assert.equal((await timed.client.query('SELECT 1::int AS n')).rows[0].n,1);
   committed(await timed.client.query(F.source('installer.sql')));
   await F.assertInstalled(db);assert.deepEqual(await F.legacySnapshot(db),baseline);await profile(timed.client);
   committed(await timed.client.query(F.source('rollback.sql')));
   await restored(db,baseline);
   assert.equal((await timed.client.query("SELECT current_setting('transaction_timeout') AS timeout")).rows[0].timeout,'500ms');
  }finally{await end(timed);}
 });
 // Do not mask a failed positive proof with later mutations or cleanup DDL.
 await restored(db,baseline);
 await t.test('FATAL transaction timeout rolls back synthetic DDL and releases a contested legacy lock',async()=>{
  let timed,witness;
  try{
   timed=await connectTimed(Client);witness=construct(Client,false);await witness.client.connect();
   const wi=(await witness.client.query("SELECT current_database() AS database,current_user AS role,session_user AS session_role,current_setting('server_version_num')::int/10000 AS major,inet_server_port() AS port,current_setting('cluster_name') AS cluster,pg_backend_pid() AS pid")).rows[0];
   const witnessPid=wi.pid;assert.equal(Number.isInteger(witnessPid)&&witnessPid>0,true);assert.deepEqual({...wi,pid:undefined},{database:'listmonk',role:'postgres',session_role:'postgres',major:17,port:5432,cluster:'shrigma-native-v3-disposable-only',pid:undefined});
   assert.equal((await db.query("SELECT to_regclass('public.transaction_timeout_rolled_back_probe') IS NULL AS absent")).rows[0].absent,true);
   await timed.client.query('BEGIN;LOCK TABLE public.crm_dash_chave IN ACCESS EXCLUSIVE MODE;CREATE TABLE public.transaction_timeout_rolled_back_probe(id integer)');
   let settled=false;
   const competing=witness.client.query('SELECT count(*)::int AS n FROM public.crm_dash_chave').then(result=>{settled=true;return {result};},error=>{settled=true;return {failed:true};});
   // Observe an actual lock wait, not only elapsed wall time. This bounded
   // handshake must fit the native 500ms budget; slow CI fails without relaxing it.
   const until=Date.now()+250;let waiting=false;
   while(Date.now()<until&&!waiting&&!settled){waiting=(await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock') AS waiting",[witnessPid])).rows[0].waiting;if(!waiting)await wait(5);}
   assert.equal(waiting,true);assert.equal(settled,false);
   const aborted=await timed.client.query('SELECT pg_sleep(1);COMMIT').then(()=>({committed:true}),error=>({code:error?.code,severity:error?.severity}));
   assert.deepEqual(aborted,{code:'25P04',severity:'FATAL'});
   const released=await competing;assert.equal(released.failed,undefined);assert.equal(released.result.rows[0].n,baseline.rows.length);
   // Lock release can precede removal of backend metadata. Only this read-only
   // observation is polled; it neither extends the transaction budget nor
   // retries the timed SQL, and does not claim a physical 500ms release bound.
   const cleanupUntil=Date.now()+1000;let gone;
   do{gone=(await db.query('SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS session_gone,NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1) AS locks_gone',[timed.pid])).rows[0];if(gone.session_gone&&gone.locks_gone)break;await wait(5);}while(Date.now()<cleanupUntil);
   assert.deepEqual(gone,{session_gone:true,locks_gone:true});
   await restored(db,baseline);
  }finally{await end(timed);await end(witness);}
 });
 await restored(db,baseline);
}
module.exports={proveTransactionTimeout500};
