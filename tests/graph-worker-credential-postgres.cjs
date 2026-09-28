'use strict';
// Exact production renderers on disposable PostgreSQL 17.10. NOLOGIN credential
// preparation and a separate explicit LOGIN transition/authentication are tested
// only in this fixture. No HTTP, real customers, production or raw log output.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('../tools/graph-worker-credential/deploy.cjs');
const O = require('../tools/graph-worker-credential/operator.cjs');
const X = require('../tools/graph-worker-access/finalize.cjs');
const B = require('../tools/graph-admin-session/dbgate-6.cjs');
const G = require('../tools/graph-install/deploy.cjs');
const GF = require('./journey-graph-install-fixture.cjs');
const F = require('./graph-worker-credential-pg-fixture.cjs');
let stage = 'isolation';
async function run() {
  const options = F.connectionOptions();
  const fixtureLog=Buffer.from('LOG: marker\nERROR: P0001: GRAPH_CREDENTIAL_FAILED\n');
  const logPins={markers:['marker'],secrets:[Buffer.from('synthetic-log-guard')],errorCodes:['GRAPH_CREDENTIAL_FAILED']};
  F.checkLogs(fixtureLog,Buffer.alloc(0),logPins);
  assert.throws(()=>F.checkLogs(Buffer.alloc(0),fixtureLog,logPins));
  assert.throws(()=>F.checkLogs(fixtureLog,Buffer.alloc(0),{...logPins,errorCodes:['GRAPH_CREDENTIAL_FAILED','GRAPH_CREDENTIAL_FAILED']}));
  assert.throws(()=>F.checkLogs(fixtureLog,Buffer.from('synthetic-log-guard'),logPins));
  const {Client} = require('pg');
  const client = new Client(options), independent = new Client(options);
  const outputs = [], errorCodes = [], markers = [], secrets = [], connectionErrors = [];
  let temp, connected=false, independentConnected=false, worker, workerConnected=false, verdict;
  const one = async (sql, connection=client) => {
    const rows = (await connection.query(sql)).rows;assert.equal(rows.length,1);return rows[0];
  };
  const metadata = connection => one(D.METADATA_SQL,connection);
  const db = connection => ({query:connection.query.bind(connection)});
  const capture = error => outputs.push(Buffer.from(JSON.stringify(Object.fromEntries(
    Object.getOwnPropertyNames(error).filter(k=>typeof error[k]==='string').map(k=>[k,error[k]])))));
  const connectionError = error => {capture(error);connectionErrors.push(true);};
  client.on('error',connectionError);independent.on('error',connectionError);
  const refused = async (sql, code, connection=client, unprepared=true) => {
    const before = await metadata(connection), rows = await GF.rowSnapshot(db(connection));
    let failed=false;
    try {await connection.query(sql);} catch(error) {capture(error);assert.equal(error.message,code);failed=true;}
    assert.ok(failed,'EXPECTED_REFUSAL');errorCodes.push(code);
    assert.equal((await one('SELECT 1 AS healthy',connection)).healthy,1);
    assert.deepEqual(await metadata(connection),before);
    assert.deepEqual(await GF.rowSnapshot(db(connection)),rows);
    if(unprepared)assert.equal(before.auth.password_null,true);
    const marker='GRAPH_CREDENTIAL_CASE_'+crypto.randomUUID().replaceAll('-','');markers.push(marker);
    await connection.query("SELECT '"+marker+"';");
  };
  try {
    await client.connect();connected=true;await independent.connect();independentConnected=true;
    assert.notEqual((await one('SELECT pg_backend_pid() pid')).pid,(await one('SELECT pg_backend_pid() pid',independent)).pid);
    stage='graph_fixture';
    const installed = await F.installGraph(client);
    const initial = await metadata();
    const predecessor = F.predecessor(initial.graph,initial.worker_identity,installed.migration);
    const scopeReview = await F.scopeReview(options,initial);
    temp = await fs.mkdtemp(path.join(os.tmpdir(),'graph-worker-credential-'));
    await fs.chmod(temp,0o700);
    const keyDir = path.join(temp,'operator');
    const publicKey = await O.generate(keyDir);
    assert.deepEqual(await O.publicEnvelope(keyDir),publicKey);
    const inputs = {predecessor,scopeReview,publicKey};
    const migration = D.atomicPrepare(initial,inputs);
    assert.match(migration.sql,/^DO \$credential_prepare\$/);
    assert.doesNotMatch(migration.sql,/^\s*(?:BEGIN|COMMIT|SET LOCAL);/m);
    markers.push(publicKey.nonce);
    // The ordinary fixture setup is not the log experiment. Only the credential
    // scenarios below enable all statements, errors and verbose server context.
    const logging = "SET log_statement='all'; SET log_min_error_statement='error'; SET log_error_verbosity='verbose';";
    await client.query(logging);await independent.query(logging);

    stage='read_only_transaction_boundary';
    await independent.query('SET default_transaction_read_only=on');
    try {
      const first=await one(B.WORKER_IDENTITY_SQL,independent),second=await one(B.WORKER_IDENTITY_SQL,independent);
      assert.equal(first.transaction_read_only,'on');assert.equal(second.transaction_read_only,'on');
      assert.equal(first.pid,second.pid);assert.notEqual(first.transaction_id,second.transaction_id);
      assert.equal(first.transaction_isolation,'read committed');assert.deepEqual(first.search_schemas,['pg_catalog','public']);
    } finally {await independent.query('SET default_transaction_read_only=off');}
    assert.deepEqual(await metadata(independent),initial);

    stage='oid_drift';
    await client.query(`ALTER ROLE crm_graph_worker RENAME TO credential_fixture_saved_worker;
      CREATE ROLE crm_graph_worker NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`);
    try {
      assert.notEqual((await metadata()).worker_identity.oid,initial.worker_identity.oid);
      await refused(migration.sql,'GRAPH_CREDENTIAL_PREFLIGHT_DRIFT');
    } finally {
      await client.query('DROP ROLE crm_graph_worker; ALTER ROLE credential_fixture_saved_worker RENAME TO crm_graph_worker;');
    }
    assert.deepEqual(await metadata(),initial);

    stage='shape_and_controls';
    for (const [change,restore] of [
      ['ALTER TABLE crm_graph_candidate.revision DISABLE TRIGGER graph_immutable','ALTER TABLE crm_graph_candidate.revision ENABLE TRIGGER graph_immutable'],
      ['UPDATE crm_graph_candidate.control SET enabled=true','UPDATE crm_graph_candidate.control SET enabled=false'],
      ["UPDATE crm_maintenance_candidate.control SET enabled=false,mode='closed'","UPDATE crm_maintenance_candidate.control SET enabled=true,mode='open'"]
    ]) {
      await client.query(change);
      try {await refused(migration.sql,'GRAPH_CREDENTIAL_PREFLIGHT_DRIFT');}
      finally {await client.query(restore);}
      assert.deepEqual(await metadata(),initial);
    }

    stage='timeout_guard';
    for (const timeout of [0,30001]) {
      await client.query('SET statement_timeout='+timeout);
      try {
        assert.throws(()=>D.atomicPrepare({...initial,statement_timeout_ms:timeout},inputs),/GRAPH_CREDENTIAL_STATEMENT_TIMEOUT/);
        await refused(migration.sql,'GRAPH_CREDENTIAL_STATEMENT_TIMEOUT');
      } finally {await client.query('SET statement_timeout=20000');}
    }
    assert.deepEqual(await metadata(),initial);

    stage='audit_hooks';
    for (const [setting,value] of [['pgaudit.log','role'],['auto_explain.log_min_duration','0']]) {
      // Custom GUCs stay known after RESET; fresh sessions isolate each case.
      const hook = new Client(options);hook.on('error',connectionError);await hook.connect();
      try {
        await hook.query(logging);await hook.query(`SET ${setting}='${value}'`);
        assert.throws(()=>D.atomicPrepare({...initial,hooks:{...initial.hooks,
          [setting==='pgaudit.log'?'pgaudit_log':'auto_explain_log_min_duration']:value}},inputs),/GRAPH_CREDENTIAL_AUDIT_HOOKS/);
        await refused(migration.sql,'GRAPH_CREDENTIAL_PREFLIGHT_DRIFT',hook);
      } finally {await hook.end();}
    }
    assert.deepEqual(await metadata(),initial);

    stage='search_path_guard';
    await client.query('SET search_path=public,pg_catalog');
    try {
      const reordered=await metadata();
      assert.throws(()=>D.atomicPrepare(reordered,inputs),/GRAPH_CREDENTIAL_/);
      await refused(migration.sql,'GRAPH_CREDENTIAL_PREFLIGHT_DRIFT');
    } finally {await client.query('SET search_path=pg_catalog,public');}
    assert.deepEqual(await metadata(),initial);

    stage='ddl_event_hook';
    await client.query(`CREATE FUNCTION public.credential_fixture_event_hook() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN IF TG_TAG IN('CREATE SCHEMA','CREATE TABLE') THEN RAISE EXCEPTION 'CREDENTIAL_FIXTURE_EVENT_CALLED';END IF;END$$;
      CREATE EVENT TRIGGER credential_fixture_ddl ON ddl_command_start EXECUTE FUNCTION public.credential_fixture_event_hook();`);
    try {
      const hooked=await metadata();assert.throws(()=>D.atomicPrepare(hooked,inputs),/GRAPH_CREDENTIAL_/);
      await refused(migration.sql,'GRAPH_CREDENTIAL_PREFLIGHT_DRIFT');
    } finally {await client.query('DROP EVENT TRIGGER credential_fixture_ddl; DROP FUNCTION public.credential_fixture_event_hook();');}
    assert.deepEqual(await metadata(),initial);

    stage='existing_schema';
    await client.query('CREATE SCHEMA '+D.SCHEMA+'; CREATE TABLE '+D.SCHEMA+'.unrelated(value integer);');
    try {await refused(migration.sql,'GRAPH_CREDENTIAL_PREFLIGHT_DRIFT');}
    finally {await client.query('DROP SCHEMA '+D.SCHEMA+' CASCADE');}
    assert.deepEqual(await metadata(),initial);

    stage='default_acl';
    await client.query('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC');
    try {await refused(migration.sql,'GRAPH_CREDENTIAL_PREFLIGHT_DRIFT');}
    finally {await client.query('ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM PUBLIC');}
    assert.deepEqual(await metadata(),initial);

    stage='late_error_rollback';
    const marker = '-- credential prepared; before receipt';
    assert.equal(migration.sql.split(marker).length,2);
    for (const [injection,code] of [
      ['PERFORM missing_credential_fixture_function();','GRAPH_CREDENTIAL_FAILED'],
      ['ASSERT false;','GRAPH_CREDENTIAL_CANCELLED']
    ]) {
      await refused(migration.sql.replace(marker,injection+'\n'+marker),code);
      assert.deepEqual(await metadata(),initial);
    }
    stage='real_statement_cancellation';
    await client.query('SET statement_timeout=500');
    try {
      const bounded = D.atomicPrepare(await metadata(),inputs);
      const start = Date.now();
      await refused(bounded.sql.replace(marker,'PERFORM pg_sleep(2);\n'+marker),'GRAPH_CREDENTIAL_CANCELLED');
      assert.ok(Date.now()-start<5000);
    } finally {await client.query('SET statement_timeout=20000');}
    assert.deepEqual(await metadata(),initial);
    assert.deepEqual(await GF.rowSnapshot(installed.db),installed.rows);

    stage='lost_ack_and_independent_receipt';
    const identity = {target:{database:'listmonk',role:'postgres',isolated:true},
      utility:{ids:['synthetic-private-query'],version:'synthetic-v1',node_hash:D.sha('synthetic-only')},
      workflows:G.WORKFLOWS.map(id=>({id,version:'synthetic-v1',hash:D.sha(id),pg_ids:['synthetic-private-query']}))};
    const snapshot = async connection => ({metadata:await metadata(connection),identity,
      session_pid:(await one('SELECT pg_backend_pid() pid',connection)).pid});
    let writes=0;
    const io = {snapshot:()=>snapshot(client),sql:async sql=>{
      writes++;assert.equal(sql,migration.sql);
      const result = await client.query(sql);assert.equal(result.command,'DO');
      throw Error('SYNTHETIC_ACK_LOST_AFTER_COMMIT');
    },independentReadback:async()=>({...await snapshot(independent),receipt:await one(D.RECEIPT_SQL,independent)})};
    const store = new D.FileStore(path.join(temp,'evidence'));
    const preparer = new D.Preparer({root:GF.ROOT,io,store});
    const beforeSnapshot = await preparer.snapshot();
    const plan = await preparer.prepare({snapshot_sha256:D.sha(beforeSnapshot),...inputs});
    await assert.rejects(preparer.provision(plan.plan_hash),/GRAPH_CREDENTIAL_WRITE_UNCONFIRMED/);
    assert.equal(writes,1);assert.equal(store.has('provision-verified'),false);
    await assert.rejects(preparer.provision(plan.plan_hash),/GRAPH_CREDENTIAL_UNCERTAIN_RECONCILE/);
    assert.equal(writes,1);
    const verified = await preparer.reconcile();
    assert.equal(verified.credential_prepared,true);assert.equal(verified.independent_commit_verified,true);
    assert.equal(verified.worker_login,false);assert.equal(verified.execution_enabled,false);
    assert.equal(writes,1);
    const after = await metadata(independent), receipt = await one(D.RECEIPT_SQL,independent);
    D.expectedAfter(initial,after);D.validateReceipt(receipt,initial,after,migration);
    assert.deepEqual(after.graph,initial.graph);assert.deepEqual(after.worker_identity,initial.worker_identity);
    assert.deepEqual(await GF.rowSnapshot(installed.db),installed.rows);
    assert.equal((await one("SELECT NOT rolcanlogin no_login FROM pg_roles WHERE rolname='crm_graph_worker'",independent)).no_login,true);

    stage='decrypt_and_scram_binding';
    const recovery = Object.fromEntries(['ciphertext','nonce','key_sha256','key_fingerprint','validation_receipt_hash'].map(k=>[k,receipt[k]]));
    const payload = await O.decryptReceipt(keyDir,recovery);
    assert.equal(payload.nonce,publicKey.nonce);assert.equal(payload.role,'crm_graph_worker');assert.equal(payload.database,'listmonk');
    const verifier = (await one("SELECT rolpassword verifier FROM pg_authid WHERE rolname='crm_graph_worker'",independent)).verifier;
    F.assertScramMatches(payload.password,verifier);
    secrets.push(Buffer.from(payload.password),Buffer.from(verifier));
    assert.equal(receipt.ciphertext_sha256,crypto.createHash('sha256').update(Buffer.from(receipt.ciphertext,'base64')).digest('hex'));
    const tampered=Buffer.from(receipt.ciphertext,'base64');tampered[tampered.length-1]^=1;
    await assert.rejects(O.decryptReceipt(keyDir,{...recovery,ciphertext:tampered.toString('base64')}),/GRAPH_WORKER_CREDENTIAL_OPERATOR_/);
    await client.query('SET ROLE crm_graph_worker');
    try {await assert.rejects(client.query('SELECT * FROM '+D.SCHEMA+'.receipt'),e=>e.code==='42501');}
    finally {await client.query('RESET ROLE');}

    stage='replay_refused';
    let replay=false;
    try {await client.query(migration.sql);} catch(error) {capture(error);assert.equal(error.message,'GRAPH_CREDENTIAL_PREFLIGHT_DRIFT');replay=true;}
    assert.ok(replay);assert.deepEqual(await metadata(),after);assert.deepEqual(await one(D.RECEIPT_SQL),receipt);
    assert.deepEqual(await GF.rowSnapshot(installed.db),installed.rows);

    stage='explicit_finalization_plan';
    const preparedPlan=store.read('plan');
    const preparedProof={plan:preparedPlan,verified,receipt,reviewed:{plan_hash:preparedPlan.hash,
      verified_hash:D.sha(verified),receipt_hash:D.sha(receipt),sources:preparedPlan.sources}};
    const recoveryProof={contract:'crm-graph-worker-recovery-v1',role:'crm_graph_worker',database:'listmonk',
      ...Object.fromEntries(['nonce','key_sha256','key_fingerprint','validation_receipt_hash','ciphertext_sha256'].map(k=>[k,receipt[k]])),
      receipt_hash:D.sha(receipt),recovered_in_memory:true};
    const finalScope=await F.scopeReview(options,after);
    const finalStore=new X.FileStore(path.join(temp,'finalization'));
    let finalWrites=0, scopeReads=0;
    const finalIO={snapshot:async()=>({...await snapshot(client),receipt:await one(D.RECEIPT_SQL)}),
      independentReadback:async()=>({...await snapshot(independent),receipt:await one(D.RECEIPT_SQL,independent)}),
      scopeAudit:async({worker_login})=>{scopeReads++;const current=await metadata(independent);
        assert.equal(current.worker_identity.role.login,worker_login);return F.scopeReview(options,current);},
      sql:async sql=>{finalWrites++;assert.equal(finalStore.has('finalize-intent'),true);
        assert.equal(sql,finalStore.read('plan').migration.accessPlan.migration.sql);
        assert.equal((await client.query(sql)).command,'DO');throw Error('SYNTHETIC_LOGIN_ACK_LOST_AFTER_COMMIT');}};
    const finalizer=new X.Finalizer({root:GF.ROOT,io:finalIO,store:finalStore});
    const finalSummary=await finalizer.prepare({snapshot_sha256:D.sha(await finalIO.snapshot()),preparedProof,
      scopeReview:finalScope,recovery:recoveryProof});
    const finalPlan=finalStore.read('plan'), finalSQL=finalPlan.migration.accessPlan.migration.sql;
    assert.match(finalSQL,/^DO \$worker_access\$/);
    assert.doesNotMatch(finalSQL,/\bPASSWORD\s|CREATE\s+ROLE|GRANT\s|BEGIN;|COMMIT;/);
    assert.equal(finalSQL.includes(receipt.ciphertext),false);assert.equal(finalSQL.includes(payload.password),false);
    assert.equal(finalSummary.login_enabled,false);assert.equal(finalSummary.online_auth_verified,false);

    stage='finalizer_fresh_cross_database_scope';
    const otherURL=new URL(options.connectionString);otherURL.pathname='/postgres';
    const other=new Client({...options,connectionString:otherURL.toString()});other.on('error',connectionError);await other.connect();
    try {
      await other.query('CREATE TABLE public.credential_scope_fixture(value integer); GRANT SELECT(value) ON public.credential_scope_fixture TO crm_graph_worker;');
      assert.deepEqual(await one("SELECT has_table_privilege('crm_graph_worker','public.credential_scope_fixture','SELECT') table_read,has_column_privilege('crm_graph_worker','public.credential_scope_fixture','value','SELECT') column_read",other),
        {table_read:false,column_read:true});
      await assert.rejects(finalizer.finalize(finalSummary.plan_hash),/GRAPH_WORKER_(?:FINALIZE_LIVE_SCOPE_DRIFT|ACCESS_OTHER_DATABASE_APPLICATION_ACCESS)/);
      assert.equal(finalWrites,0);assert.equal(finalStore.has('finalize-intent'),false);
      assert.deepEqual(await metadata(),after);
    } finally {await other.query('DROP TABLE public.credential_scope_fixture');await other.end();}
    assert.deepEqual(await F.scopeReview(options,after),finalScope);

    stage='finalizer_receipt_timestamp_drift';
    await client.query(`UPDATE ${D.SCHEMA}.receipt SET completed_at=completed_at+interval '1 second'`);
    try {
      await assert.rejects(finalizer.finalize(finalSummary.plan_hash),/GRAPH_WORKER_FINALIZE_PREFLIGHT_DRIFT/);
      assert.equal(finalWrites,0);assert.equal(finalStore.has('finalize-intent'),false);
      await refused(finalSQL,'GRAPH_WORKER_FINALIZE_RECEIPT_DRIFT',client,false);
    } finally {await client.query(`UPDATE ${D.SCHEMA}.receipt SET completed_at=completed_at-interval '1 second'`);}
    assert.deepEqual(await one(D.RECEIPT_SQL),receipt);assert.deepEqual(await metadata(),after);

    stage='finalizer_late_alter_rollback';
    const sealMarker="EXECUTE pg_catalog.format('COMMENT ON SCHEMA crm_graph_candidate IS %L',";
    assert.equal(finalSQL.split(sealMarker).length,2);
    assert.ok(finalSQL.indexOf('ALTER ROLE crm_graph_worker LOGIN;')<finalSQL.indexOf(sealMarker));
    await refused(finalSQL.replace(sealMarker,"RAISE EXCEPTION 'GRAPH_WORKER_FINALIZE_SYNTHETIC_LATE';\n "+sealMarker),
      'GRAPH_WORKER_FINALIZE_SYNTHETIC_LATE',client,false);
    assert.deepEqual(await metadata(),after);assert.deepEqual(await one(D.RECEIPT_SQL),receipt);
    assert.equal((await metadata()).worker_identity.role.login,false);

    stage='finalizer_lost_ack_independent_commit';
    await assert.rejects(finalizer.finalize(finalSummary.plan_hash),/GRAPH_WORKER_FINALIZE_WRITE_UNCONFIRMED/);
    assert.equal(finalWrites,1);assert.equal(finalStore.has('finalize-verified'),false);
    await assert.rejects(finalizer.finalize(finalSummary.plan_hash),/GRAPH_WORKER_FINALIZE_UNCERTAIN_RECONCILE/);
    assert.equal(finalWrites,1);
    const finalized=await finalizer.reconcile();
    assert.equal(finalized.login_enabled,true);assert.equal(finalized.independent_commit_verified,true);
    assert.equal(finalized.online_auth_verified,false);assert.equal(finalized.execution_enabled,false);assert.equal(finalized.service_created,false);
    assert.equal(finalWrites,1);assert.ok(scopeReads>=4);
    const finalMetadata=await metadata(independent);
    assert.deepEqual(X.normalizeMetadata(finalMetadata),finalPlan.migration.expected_metadata);
    assert.deepEqual(finalMetadata.auth,after.auth);assert.deepEqual(finalMetadata.off,after.off);
    assert.deepEqual(finalMetadata.graph.graph_control,{singleton:true,enabled:false});
    assert.deepEqual(finalMetadata.graph.maintenance_control,after.graph.maintenance_control);
    assert.deepEqual(await GF.rowSnapshot(installed.db),installed.rows);assert.deepEqual(await one(D.RECEIPT_SQL),receipt);

    stage='real_worker_password_authentication';
    const authURL=new URL(options.connectionString);
    // No inherited admin connectionString: pg must authenticate the dedicated
    // username/password supplied only in memory, never inside SQL or argv.
    const workerOptions={host:'127.0.0.1',port:Number(authURL.port),database:'listmonk',user:'crm_graph_worker',
      password:payload.password,statement_timeout:20000,connectionTimeoutMillis:3000,
      application_name:'synthetic-worker-auth',options:'-c search_path=pg_catalog,public'};
    const wrongPassword=(payload.password[0]==='0'?'1':'0')+payload.password.slice(1);
    secrets.push(Buffer.from(wrongPassword));
    const wrong=new Client({...workerOptions,password:wrongPassword});wrong.on('error',connectionError);
    try {await assert.rejects(wrong.connect(),error=>{capture(error);return error.code==='28P01';});}
    finally {await wrong.end();}
    worker=new Client(workerOptions);worker.on('error',connectionError);await worker.connect();workerConnected=true;
    const authenticated=await one('SELECT session_user,current_user,pg_backend_pid() pid',worker);
    assert.equal(authenticated.session_user,'crm_graph_worker');assert.equal(authenticated.current_user,'crm_graph_worker');
    assert.notEqual(authenticated.pid,(await one('SELECT pg_backend_pid() pid')).pid);
    assert.notEqual(authenticated.pid,(await one('SELECT pg_backend_pid() pid',independent)).pid);

    stage='authenticated_worker_permission_boundaries';
    const protectedRows=async()=>one(`SELECT pg_catalog.jsonb_build_object(
      'subscribers',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.subscribers s),
      'subscriptions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY subscriber_id,list_id) FROM public.subscriber_lists s),
      'cart_control',(SELECT jsonb_agg(to_jsonb(s) ORDER BY brand) FROM crm_graph_candidate.cart_control_v1 s)) AS value`);
    const beforeProtected=await protectedRows();
    const deny=async(sql,values=[])=>{
      let blocked=false;try {await worker.query(sql,values);}catch(error){capture(error);
        assert.ok(error.code==='42501'||/^GRAPH_WORKER_/.test(error.message),'WORKER_DENIAL_CODE');blocked=true;}
      assert.ok(blocked,'WORKER_BOUNDARY_MISSING');assert.equal((await one('SELECT 1 AS healthy',worker)).healthy,1);
    };
    for(const sql of [
      'UPDATE crm_graph_candidate.control SET enabled=true',
      "UPDATE crm_maintenance_candidate.control SET mode='closed'",
      'UPDATE crm_graph_candidate.cart_control_v1 SET enabled=true',
      'UPDATE crm_graph_candidate.journey SET paused=false',
      "UPDATE public.subscriber_lists SET status='confirmed'",
      "UPDATE public.subscribers SET status='enabled'",
      `UPDATE public.subscribers SET attribs=jsonb_set(attribs,'{fish,mkt_consent}','"subscribed"')`,
      `UPDATE public.subscribers SET attribs=jsonb_set(attribs,'{aristo,mkt_consent}','"subscribed"')`,
      'SELECT * FROM '+D.SCHEMA+'.receipt',
      'SELECT * FROM public.graph_install_fixture_secret'
    ])await deny(sql);
    const unrelated=(await client.query("SELECT dispatch_id FROM public.shrigma_email_dispatch WHERE dedupe_key IN('synthetic-credential-legacy','synthetic-credential-tx') ORDER BY dispatch_id")).rows;
    assert.equal(unrelated.length,4);
    for(const {dispatch_id} of unrelated)await deny("UPDATE public.shrigma_email_dispatch SET transport_state='rejected',outcome_at=clock_timestamp() WHERE dispatch_id=$1",[dispatch_id]);
    assert.deepEqual(await protectedRows(),beforeProtected);assert.deepEqual(await GF.rowSnapshot(installed.db),installed.rows);
    assert.deepEqual(await metadata(),finalMetadata);assert.deepEqual(await one(D.RECEIPT_SQL),receipt);

    stage='finalizer_replay_refused';
    await refused(finalSQL,'GRAPH_WORKER_FINALIZE_PREFLIGHT_DRIFT',client,false);
    assert.equal(finalWrites,1);assert.deepEqual(await metadata(),finalMetadata);
    await worker.end();workerConnected=false;payload.password='';workerOptions.password='';
    stage='private_server_log_scan';
    const finalMarker = 'GRAPH_CREDENTIAL_LOG_END_'+crypto.randomUUID().replaceAll('-','');markers.push(finalMarker);
    await client.query("SELECT '"+finalMarker+"';");
    const logs = await F.rawLogs(process.env.POSTGRES_CONTAINER);
    assert.ok(logs.includes('statement: DO $credential_prepare$'));
    assert.ok(logs.includes('statement: DO $worker_access$'));
    const logProof = F.checkLogs(logs,Buffer.concat(outputs),{markers,secrets,errorCodes});
    assert.equal(connectionErrors.length,0);
    verdict={status:'PASSED_POSTGRES_17_10_PREPARE_AND_LOGIN_ISOLATED',prepared_nologin_verified:true,login_enabled:true,
      online_auth_verified:true,wrong_password_rejected:true,worker_boundaries_verified:true,execution_enabled:false,
      independent_commit_verified:true,preparation_writes:writes,finalization_writes:finalWrites,
      normal_and_failure_logs_verified:true,server_log_bytes:logProof.server_log_bytes,
      plaintext_logged:false,production_access:false};
  } finally {
    if(workerConnected)await worker.end();
    if(independentConnected)await independent.end();if(connected)await client.end();
    if(temp)await fs.rm(temp,{recursive:true,force:true});
    for(const secret of secrets)secret.fill(0);
  }
  console.log(JSON.stringify(verdict));
}
run().catch(error=>{
  const code = typeof error?.message==='string' && /^(?:GRAPH_CREDENTIAL_|GRAPH_WORKER_CREDENTIAL_OPERATOR_|GRAPH_WORKER_FINALIZE_|GRAPH_WORKER_ACCESS_|GRAPH_DATABASE_SCOPE_)[A-Z_]+$/.test(error.message)
    ? error.message : 'GRAPH_CREDENTIAL_TEST_UNCONFIRMED';
  console.error(JSON.stringify({status:'FAILED',stage,code}));process.exitCode=1;
});
