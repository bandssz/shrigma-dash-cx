'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,D,F}=require('./graph-worker-credential-fixture.cjs');
test('compiled credential preparation is exactly one DO with existing server timeout and no client plaintext or LOGIN transition',t=>{
 const f=fixture(t),m=D.atomicPrepare(f.metadata(),f.inputs),sql=m.sql;
 assert.match(sql,/^DO \$credential_prepare\$/);assert.match(sql,/END \$credential_prepare\$;$/);assert.doesNotMatch(sql,/^BEGIN;|^COMMIT;|^SET /m);assert.equal((sql.match(/DO \$credential_prepare\$/g)||[]).length,1);
 assert.match(sql,/gen_random_bytes\(32\)/);assert.match(sql,/cipher-algo=aes256,compress-algo=0,disable-mdc=0/);assert.match(sql,/ALTER ROLE %I NOLOGIN PASSWORD %L/);assert.equal(/ALTER ROLE [^\n]*\bLOGIN\b|PASSWORD\s+'[^']+'/.test(sql),false,'NO_LOGIN_OR_CLIENT_PASSWORD');
 assert.match(sql,/WHEN query_canceled OR assert_failure/);assert.match(sql,/WHEN OTHERS/);assert.doesNotMatch(sql,/SQLERRM|GET STACKED DIAGNOSTICS|RAISE NOTICE|RAISE LOG|set_config\('statement_timeout'/);
 assert.ok(sql.indexOf("hashtextextended('maintenance-cart-install'")<sql.indexOf("hashtextextended('crm-graph-install'"));assert.ok(sql.indexOf("hashtextextended('crm-graph-install'")<sql.indexOf("hashtextextended('crm-graph-worker-access'"));
 assert.ok(sql.indexOf('GRAPH_CREDENTIAL_PREFLIGHT_DRIFT')<sql.indexOf('gen_random_bytes(32)'));assert.ok(sql.indexOf('GRAPH_CREDENTIAL_RECEIPT_ACL')<sql.indexOf('gen_random_bytes(32)'));
 assert.doesNotMatch(D.AUTH_SQL,/rolcanlogin/);assert.match(D.AUTH_SQL,/'role_oid',r.oid,'role',r.rolname,'verifier',r.rolpassword/);
 assert.doesNotMatch(D.METADATA_SQL,/FROM crm_worker_access_admin_v1\.receipt/);assert.match(D.RECEIPT_SQL,/encode\(ciphertext,'base64'\)/);assert.doesNotMatch(D.RECEIPT_SQL,/rolpassword/);
});
test('metadata requires exact NOLOGIN, no previous credential, graph OFF and open CART, current official crypto and no unreviewed hooks',t=>{
 const changes=[m=>{m.search_schemas='{pg_catalog,public}';},m=>{m.search_schemas=['public','pg_catalog'];},m=>{m.event_triggers=[{enabled:'O'}];},m=>{m.auth.password_null=false;},m=>{m.auth.scram=true;},m=>{m.receipt_schema={};},m=>{m.worker_identity.role.login=true;},m=>{m.worker_identity.role.memberships=1;},m=>{m.worker_identity.oid='17002';},m=>{m.worker_identity.settings=['search_path=public'];},m=>{m.off.epochs='1';},m=>{m.off.cart_off=false;},m=>{m.graph.graph_control.enabled=true;},m=>{m.graph.maintenance_control.mode='closed';},m=>{m.graph.public_create_schemas=['public'];},m=>{m.hooks.pgaudit_log='role';},m=>{m.hooks.auto_explain_log_min_duration='0';},m=>{m.hooks.shared_preload_libraries='unknown';},m=>{m.crypto.version='other';},m=>{m.crypto.functions[0].extension_member=false;},m=>{m.crypto.functions[1].symbol='unreviewed';},m=>{m.crypto.functions[1].definer=true;},m=>{m.crypto.functions[0].binary='elsewhere';},m=>{m.statement_timeout_ms=0;},m=>{m.statement_timeout_ms=30001;},m=>{m.transaction_isolation='repeatable read';},m=>{m.transaction_read_only='on';},m=>{m.server_version_num=170009;},m=>{m.superuser=false;},m=>{m.database_inventory.pop();}];
 for(const change of changes){const f=fixture(t),m=f.metadata();change(m);assert.throws(()=>D.atomicPrepare(m,f.inputs),/GRAPH_/);}
});
test('public descriptor has strict bytes, nonce, key fingerprint and canonical validation binding',t=>{
 for(const change of [k=>{k.public_key_b64='invalid';},k=>{k.key_sha256=F.h(9);},k=>{k.key_fingerprint='short';},k=>{k.validation_receipt_hash=F.h(9);},k=>{k.nonce='bad';},k=>{k.private_key='forbidden';}]){
  const f=fixture(t);change(f.inputs.publicKey);assert.throws(()=>D.atomicPrepare(f.metadata(),f.inputs),/PUBLIC_KEY/);
 }
});

test('catalog qualification protects variadic builtins in metadata and credential paths without altering literals',t=>{
 const f=fixture(t),sql=D.atomicPrepare(f.metadata(),f.inputs).sql;
 assert.equal(/(?<![.\w])(?:jsonb_build_object|jsonb_build_array|format)\(/.test(sql),false,'NO_UNQUALIFIED_VARIADIC_BUILTINS');
 assert.match(sql,/pg_catalog\.format\('ALTER ROLE %I NOLOGIN PASSWORD %L'/);
 assert.match(D.METADATA_SQL,/pg_catalog\.to_json\(pg_catalog\.current_schemas\(true\)\) AS search_schemas/);
 assert.match(D.AUTH_SQL,/pg_catalog\.jsonb_build_object\('role_oid',r\.oid,'role',r\.rolname,'verifier',r\.rolpassword\)/);
 assert.equal(D.catalogSQL("jsonb_build_object('format(secret)', 'jsonb_build_object(secret)')"),"pg_catalog.jsonb_build_object('format(secret)', 'jsonb_build_object(secret)')");
 assert.equal(D.catalogSQL("public.format('x') -- format(secret)\npg_catalog.format('x')"),"public.format('x') -- format(secret)\npg_catalog.format('x')");
});
