'use strict';
// A disposable loopback PostgreSQL fixture. No production URL is accepted.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const G = require('../tools/graph-install/deploy.cjs');
const F = require('./journey-graph-install-fixture.cjs');
const A = require('../tools/graph-worker-access/contract.cjs');
const S = require('../tools/graph-worker-access/database-scope.cjs');
const C = require('../tools/maintenance-cart-deploy/deploy.cjs');
const run = promisify(execFile);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function connectionOptions() {
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.GRAPH_WORKER_CREDENTIAL_TEST_ISOLATED, '1');
  const u = new URL(process.env.TEST_DATABASE_URL || 'postgres://invalid');
  assert.equal(u.protocol, 'postgres:');
  assert.equal(u.hostname, '127.0.0.1');
  assert.equal(u.username, 'postgres');
  assert.equal(u.password, 'synthetic-admin-password');
  assert.equal(u.pathname, '/listmonk');
  assert.equal(u.search, ''); assert.equal(u.hash, '');
  assert.match(u.port, /^[0-9]{4,5}$/);
  assert.ok(Number(u.port) >= 1024 && Number(u.port) <= 65535);
  assert.match(process.env.POSTGRES_CONTAINER || '', /^[a-f0-9]{64}$/);
  return {connectionString:u.toString(),statement_timeout:20000,
    connectionTimeoutMillis:3000,application_name:'synthetic-worker-credential',options:'-c search_path=pg_catalog,public'};
}
async function installGraph(client) {
  const query = client.query.bind(client);
  const db = {query,exec:query,close:async()=>{}};
  const pool = {connect:async()=>({query,release(){}})};
  assert.equal((await query('SHOW server_version_num')).rows[0].server_version_num, '170010');
  assert.deepEqual((await query(`SELECT current_database() database,current_user role,
    NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') empty,
    NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('crm_graph_worker','credential_fixture_saved_worker')) no_role`)).rows[0],
  {database:'listmonk',role:'postgres',empty:true,no_role:true});
  // Historical fixtures intentionally create unqualified public tables. Their
  // bootstrap is isolated from the dedicated credential session policy.
  await query('SET search_path=public');
  const fixture = await F.installBase({after(){}},{db,pool});
  // Existing graph fixtures emulate digest in PGlite. This proof requires real
  // pgcrypto, installed BEFORE composing/sealing the graph's public shape.
  await query('DROP FUNCTION public.digest(bytea,text); CREATE EXTENSION pgcrypto WITH SCHEMA public; SET search_path=pg_catalog,public;');
  const graphBefore = (await query(G.METADATA_SQL)).rows[0];
  const migration = G.atomicInstall(F.ROOT, graphBefore, F.NONCE);
  const result = await query(migration.sql);
  assert.equal(result.command, 'DO');
  const graph = (await query(G.METADATA_SQL)).rows[0];
  assert.equal(graph.worker_role.login, false);
  assert.deepEqual(graph.graph_control, {singleton:true,enabled:false});
  assert.equal(graph.maintenance_control.enabled, true);
  assert.equal(graph.maintenance_control.mode, 'open');
  assert.equal(graph.maintenance_control.version, 2);
  // Exact-arity public overloads outrank unqualified variadic pg_catalog
  // functions. A shared schema writer must never intercept the plaintext.
  await query(`CREATE FUNCTION public.jsonb_build_object(text,text,text,text,text,text,text,text)
    RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'CREDENTIAL_FIXTURE_PUBLIC_JSON_CALLED';END$$;
    CREATE FUNCTION public.jsonb_build_object(text,oid,text,name,text,text)
    RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'CREDENTIAL_FIXTURE_PUBLIC_AUTH_CALLED';END$$;
    CREATE FUNCTION public.format(text,text,text)
    RETURNS text LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'CREDENTIAL_FIXTURE_PUBLIC_FORMAT_CALLED';END$$;`);
  await query(`INSERT INTO public.subscribers(id,uuid,email,status,attribs)
    SELECT 2,'40000000-0000-4000-8000-000000000010','optout@example.invalid','blocklisted',
      jsonb_set(jsonb_set(attribs,'{fish,mkt_consent}','"unsubscribed"'),'{aristo,mkt_consent}','"unsubscribed"')
    FROM public.subscribers WHERE id=1;
    INSERT INTO public.subscriber_lists SELECT 2,list_id,'unsubscribed' FROM public.subscriber_lists WHERE subscriber_id=1;`);
  // Existing, synthetic legacy/TX dispatches are unrelated to the new worker.
  // Their presence proves the dedicated login cannot claim another producer's
  // dispatch merely because it has the graph runtime's narrow column grants.
  for (const [index,brand] of ['fish','aristo'].entries()) {
    const legacy='40000000-0000-4000-8000-00000000000'+(index*2+1);
    const tx='40000000-0000-4000-8000-00000000000'+(index*2+2);
    await query(`INSERT INTO public.shrigma_email_dispatch
      (dispatch_id,brand,flow,piece,dedupe_key,is_test,transport_state,claim_token)
      VALUES($1,$3,'carrinho','carrinho-30min','synthetic-credential-legacy',false,'in_flight',$1),
      ($2,$3,'pedido','confirmacao','synthetic-credential-tx',false,'in_flight',$2)`,[legacy,tx,brand]);
  }
  assert.deepEqual((await query(G.METADATA_SQL)).rows[0],graph);
  return {fixture,db,query,graph,migration,rows:await F.rowSnapshot(db)};
}
function predecessor(graph, workerIdentity, migration) {
  const plan = {contract:'crm-graph-install-v1',migration,sources:G.sources(F.ROOT)};
  plan.hash = C.sha(plan);
  const install_verified = {contract:plan.contract,plan_hash:plan.hash,sql_hash:C.sha(migration.sql),
    installed:true,readback_verified:true,execution_enabled:false,worker_login:false,activation_available:false,
    baseline:Object.fromEntries(['graph_shape','maintenance_shape','public_shape','worker_role','maintenance_legacy_shape'].map(k=>[k,graph[k]]))};
  const baseAnchor = {plan,install_verified,metadata:graph,role_identity:workerIdentity,
    reviewed:{plan_hash:plan.hash,receipt_hash:C.sha(install_verified),metadata_hash:C.sha(graph),
      identity_hash:C.sha(workerIdentity),sources:plan.sources}};
  const result = {baseAnchor,txReceipt:null};
  A.validateOperational({...result,metadata:{...graph,worker_role_identity:workerIdentity}});
  return result;
}
async function scopeReview(options, metadata) {
  const {Client} = require('pg');
  const freshRead=async(database,sql)=>{
    assert.ok(metadata.database_inventory.some(d=>d.name===database),'SCOPE_DATABASE');
    assert.ok(sql===S.INVENTORY_SQL||sql===S.DATABASE_SQL,'SCOPE_SQL');
    const u=new URL(options.connectionString);u.pathname='/'+database;
    const client=new Client({...options,connectionString:u.toString(),
      options:'-c search_path=pg_catalog,public -c default_transaction_read_only=on'});
    let unexpected=false,connected=false;client.on('error',()=>{unexpected=true;});
    try {await client.connect();connected=true;const result=await client.query(sql);
      assert.equal(unexpected,false,'SCOPE_CONNECTION');assert.equal(result.rows.length,1,'SCOPE_RESULT');return result.rows[0];
    } finally {if(connected)await client.end();}
  };
  // Execute the production catalog reader itself on fresh, read-only sessions.
  // In particular, target and foreign database column ACLs must use real PG17
  // semantics; these are not summaries generated by a parallel fixture query.
  const result=await S.auditDatabaseScope({role_oid:metadata.worker_identity.oid,
    worker_login:metadata.worker_identity.role.login,reviewedDiagnostics:[],
    io:{inventory:sql=>freshRead('listmonk',sql),readDatabase:({database,sql})=>freshRead(database,sql)}});
  assert.deepEqual(result.database_inventory,metadata.database_inventory);
  return result;
}
async function rawLogs(container) {
  assert.match(container, /^[a-f0-9]{64}$/);
  const result = await run('docker',['logs',container],{encoding:'buffer',timeout:15000,maxBuffer:16*1024*1024});
  return Buffer.concat([result.stdout,result.stderr]);
}
function checkLogs(server, client, {markers,secrets,errorCodes}) {
  // Client stderr must not satisfy server coverage. All supplied values are
  // held only in memory; failure messages deliberately contain no raw output.
  assert.ok(Buffer.isBuffer(server) && Buffer.isBuffer(client), 'SERVER_LOG_MISSING');
  // Always inspect captured bytes before judging completeness, including when
  // an earlier fixture error prevented one of the expected coverage markers.
  const both = Buffer.concat([server,client]);
  for (const secret of secrets) assert.ok(secret && !both.includes(secret), 'CREDENTIAL_LOG_LEAK');
  assert.doesNotMatch(both.toString(), /ALTER ROLE\s+crm_graph_worker\s+(?:NOLOGIN\s+)?PASSWORD\s+'[a-f0-9]{64}'/, 'EXPANDED_CREDENTIAL_LOG_LEAK');
  assert.doesNotMatch(both.toString(), /SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*/, 'VERIFIER_LOG_LEAK');
  assert.ok(server.length>0,'SERVER_LOG_MISSING');
  assert.ok(markers.length > 0 && markers.every(x=>x && server.includes(x)), 'SERVER_LOG_COVERAGE');
  for (const code of new Set(errorCodes)) {
    assert.match(code,/^[A-Z_]+$/);
    const count = (server.toString().match(new RegExp('ERROR:[^\\r\\n]*\\b'+code+'\\b','g'))||[]).length;
    assert.ok(count>=errorCodes.filter(x=>x===code).length, 'SERVER_ERROR_COVERAGE');
  }
  return {server_log_bytes:server.length,server_log_sha256:sha(server),marker_count:markers.length};
}
function assertScramMatches(password, verifier) {
  assert.match(password,/^[a-f0-9]{64}$/);
  const match = /^SCRAM-SHA-256\$([0-9]+):([A-Za-z0-9+/]+=*)\$([A-Za-z0-9+/]+=*):([A-Za-z0-9+/]+=*)$/.exec(verifier);
  assert.ok(match, 'SCRAM_FORMAT');
  const iterations = Number(match[1]);
  assert.ok(iterations >= 4096 && iterations <= 1000000, 'SCRAM_ITERATIONS');
  const salted = crypto.pbkdf2Sync(password,Buffer.from(match[2],'base64'),iterations,32,'sha256');
  const client = crypto.createHmac('sha256',salted).update('Client Key').digest();
  const stored = crypto.createHash('sha256').update(client).digest();
  const server = crypto.createHmac('sha256',salted).update('Server Key').digest();
  assert.ok(crypto.timingSafeEqual(stored,Buffer.from(match[3],'base64')), 'SCRAM_STORED_KEY');
  assert.ok(crypto.timingSafeEqual(server,Buffer.from(match[4],'base64')), 'SCRAM_SERVER_KEY');
  salted.fill(0); client.fill(0); stored.fill(0); server.fill(0);
}
module.exports = {connectionOptions,installGraph,predecessor,scopeReview,rawLogs,checkLogs,assertScramMatches};
