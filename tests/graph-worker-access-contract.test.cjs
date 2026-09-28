'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const A=require('../tools/graph-worker-access/contract.cjs'),F=require('./graph-worker-access-fixture.cjs');
test('base, access and the two explicit TX orders preserve immutable base evidence and never authorize LOGIN or execution',()=>{
 for(const order of ['base','access','tx','access-tx','tx-access']){
  const input=F.inputs(order),original=F.clone(input),result=A.validateOperational(input);
  assert.deepEqual(result.order,['base',...order==='base'?[]:order.split('-')]);assert.equal(result.worker_login,order.includes('access'));
  assert.equal(result.structural_valid,true);assert.equal(result.policy_valid,order.includes('access'));assert.equal(result.online_auth_verified,false);assert.equal(result.login_authorized,false);assert.equal(result.execution_authorized,false);assert.equal(result.connection_isolated,false);assert.deepEqual(input,original);
 }
});
test('original plan, source manifest, receipt, metadata and fresh NOLOGIN OID pins are required',()=>{
 const mutations=[
  a=>{a.plan.hash=F.h('f');},a=>{a.plan.migration.sql+=' changed';},a=>{a.plan.sources['tools/graph-install/deploy.cjs']=F.h('f');},
  a=>{a.install_verified.worker_login=true;},a=>{a.install_verified.baseline.graph_shape=F.m('f');},
  a=>{a.metadata.worker_role.login=true;},a=>{a.metadata.graph_seal='{}';},a=>{a.role_identity.oid='17002';},
  a=>{delete a.reviewed;},a=>{a.reviewed.identity_hash=F.h('f');},a=>{a.reviewed.sources={};}
 ];
 for(const mutate of mutations){const input=F.inputs('access');mutate(input.baseAnchor);assert.throws(()=>A.validateOperational(input),/GRAPH_WORKER_ACCESS_/);}
});
test('LOGIN without its anchored transition and receipts is rejected even when graph seal matches the current role',()=>{
 const input=F.inputs('access');input.accessReceipt=null;input.accessPlan=null;input.accessReview=null;assert.throws(()=>A.validateOperational(input),/CURRENT_CHAIN/);
 const x=F.inputs('base'),g=JSON.parse(x.metadata.graph_seal);g.worker_role.login=true;x.metadata.worker_role.login=true;x.metadata.worker_role_identity.role.login=true;x.metadata.graph_seal=JSON.stringify(g);assert.throws(()=>A.validateOperational(x),/ROLE/);
});
test('only the same fresh OID and unchanged flags, settings and memberships can cross the authentication boundary',()=>{
 const changes=[
  r=>{r.oid='17002';},r=>{r.role.superuser=true;},r=>{r.role.createdb=true;},r=>{r.role.createrole=true;},r=>{r.role.inherit=true;},r=>{r.role.replication=true;},r=>{r.role.bypassrls=true;},r=>{r.role.memberships=1;},r=>{r.role.name='postgres';},r=>{r.settings=['search_path=public'];},r=>{r.database_settings=[{database_oid:'16384',settings:['role=postgres']}];},r=>{r.connection_limit=4;},r=>{r.valid_until='2027-01-01';}
 ];
 for(const change of changes){const input=F.inputs('access');change(input.accessReceipt.after.role_identity);F.repinAccess(input);input.metadata=F.metadata(input.accessReceipt.after);assert.throws(()=>A.validateOperational(input),/ROLE|ACCESS_DIFFERENCE/);}
 const x=F.inputs('access');x.metadata.worker_role_identity.oid='17002';assert.throws(()=>A.validateOperational(x),/CURRENT_CHAIN/);
});
test('receipt chain rejects altered predecessors, extra fields, reordered branches and substituted authentication proof',()=>{
 const changes=[
  x=>{x.accessReceipt.after.graph_seal.worker_access_extension.previous_graph_seal_hash=F.h('f');},
  x=>{x.accessReceipt.after.graph_seal.worker_access_extension.base_receipt_hash=F.h('f');},
  x=>{x.accessReceipt.after.graph_seal.worker_access_extension.base_plan_hash=F.h('f');},
  x=>{x.accessReceipt.after.graph_seal.worker_access_extension.auth_proof_hash=F.h('f');},
  x=>{x.accessReceipt.auth_proof_hash=F.h('f');},
  x=>{x.accessReceipt.after.graph_seal.worker_access_extension.extra=true;},
  x=>{x.accessReceipt.after.graph_seal.worker_access_extension.previous_role.login=true;},
  x=>{x.accessReceipt.after.graph_seal.worker_access_extension.role_oid='17002';},
  x=>{x.accessReceipt.after.graph_seal.worker_access_extension.credential_version='';},
  x=>{x.accessReceipt.after.graph_seal.graph_shape=F.m('f');},
  x=>{x.txReceipt.before=F.fixture().base;},
  x=>{x.txReceipt.extension.previous_maintenance_shape=F.m('f');},
  x=>{x.txReceipt.after.maintenance_seal.previous.nonce=F.id(99);},
  x=>{delete x.txReceipt.after.graph_seal.worker_access_extension;},
  x=>{x.txReceipt.after.graph_seal.worker_access_extension.credential_version='substitute';},
  x=>{x.txReceipt.after.graph_seal.public_shape=F.m('f');}
 ];
 for(const change of changes){const input=F.inputs();change(input);assert.throws(()=>A.validateOperational(input),/GRAPH_WORKER_ACCESS_/);}
 const omitted=F.inputs('tx-access');omitted.txReceipt=null;assert.throws(()=>A.validateOperational(omitted),/CHAIN_ORDER/);
});
test('current schema/paired-seal/role drift never gets adopted by operational readback',()=>{
 const changes=[x=>{x.graph_shape=F.m('f');},x=>{x.public_shape=F.m('f');},x=>{x.maintenance_shape=F.m('f');},x=>{x.maintenance_legacy_shape=F.m('a');},x=>{x.worker_role.login=false;},x=>{x.database='other';},x=>{x.graph_seal='{}';},x=>{x.maintenance_seal='{}';}];
 for(const change of changes){const input=F.inputs();change(input.metadata);assert.throws(()=>A.validateOperational(input),/GRAPH_WORKER_ACCESS_/);}
});
test('audited CONNECT/TEMP in other databases is accepted without claiming isolation; every application privilege is denied',()=>{
 const s=F.scope();assert.equal(A.validateConnectionScope(s,'17001',{database_inventory:F.inventory(),diagnostic_read_exceptions:[]}),s);assert.equal(s.database_audits[0].connect,true);assert.equal(s.database_audits[0].temporary,true);
 for(const field of ['create','non_system_read','non_system_write','non_system_create','non_system_definer_execute','foreign_server_usage']){
  const input=F.inputs('access');input.accessReceipt.connection_scope.database_audits[0][field]=true;
  input.accessReceipt.after.graph_seal.worker_access_extension.connection_scope_hash=F.sha(input.accessReceipt.connection_scope);
  input.metadata=F.metadata(input.accessReceipt.after);F.repinAccess(input);assert.throws(()=>A.validateOperational(input),/DATABASE_CREATE|OTHER_DATABASE_APPLICATION_ACCESS/);
 }
});
test('connection policy, catalog receipts, complete audit fields, role and scope hash must remain exact',()=>{
 const changes=[s=>{s.database='other';},s=>{s.role='postgres';},s=>{s.role_oid='17002';},s=>{s.policy='allow-everything';},s=>{s.database_audits.reverse();},s=>{s.database_audits[0].oid='05';},s=>{s.database_audits[0].catalog_hash='unknown';},s=>{delete s.database_audits[0].foreign_server_usage;},s=>{s.database_audits[0].non_system_read=0;},s=>{s.database_audits[1].connect=false;},s=>{s.database_audits.splice(1,1);},s=>{s.database_audits.push(F.clone(s.database_audits[0]));},s=>{s.extra=true;}];
 for(const change of changes){const s=F.scope();change(s);assert.throws(()=>A.validateConnectionScope(s,'17001',{database_inventory:F.inventory(),diagnostic_read_exceptions:[]}),/GRAPH_WORKER_ACCESS_/);}
 const input=F.inputs('access');input.accessReceipt.connection_scope.database_audits[0].catalog_hash=F.h('f');F.repinAccess(input);assert.throws(()=>A.validateOperational(input),/SCOPE_HASH/);
});
test('access receipt, full plan, SQL and nonsecret body are independently pinned before accepting a LOGIN chain',()=>{
 const changes=[x=>{x.accessReceipt.plan_hash=F.h('f');},x=>{x.accessReceipt.sql_hash=F.h('f');},x=>{x.accessPlan.migration.sql+=' changed';},x=>{x.accessPlan.migration.body+=' changed';},x=>{x.accessPlan.before.role_identity.oid='17002';},x=>{x.accessReview.receipt_hash=F.h('f');},x=>{x.accessReview.sources={};},x=>{x.accessPlan=null;},x=>{x.accessReview=null;}];
 for(const change of changes){const input=F.inputs('access');change(input);assert.throws(()=>A.validateOperational(input),/GRAPH_WORKER_ACCESS_/);}
 const wrongBody=F.inputs('access');wrongBody.accessReceipt.after.graph_seal.worker_access_extension.ddl=F.h('f');F.repinAccess(wrongBody);wrongBody.metadata=F.metadata(wrongBody.accessReceipt.after);assert.throws(()=>A.validateOperational(wrongBody),/ACCESS_PREDECESSOR/);
});
test('omitting another database is refused against the independent complete inventory even after receipt rehash',()=>{
 const input=F.inputs('access');input.accessReceipt.connection_scope.database_audits.shift();input.accessReceipt.after.graph_seal.worker_access_extension.connection_scope_hash=F.sha(input.accessReceipt.connection_scope);F.repinAccess(input);input.metadata=F.metadata(input.accessReceipt.after);assert.throws(()=>A.validateOperational(input),/DATABASE_INVENTORY_DRIFT/);
});
test('only individually pinned diagnostic views may be excluded from foreign application reads',()=>{
 const exception={relation_oid:'16943',extension_oid:'16940',extension_name:'pg_stat_statements',extension_version:'1.11',definition_hash:F.h('a'),acl_hash:F.h('b'),dependency_hash:F.h('c')};
 const s=F.scope();s.database_audits[0].diagnostic_read_exceptions=[exception];const review={database_inventory:F.inventory(),diagnostic_read_exceptions:[{database_oid:'5',...exception}]};
 assert.equal(A.validateConnectionScope(s,'17001',review),s);
 for(const field of ['relation_oid','extension_oid','extension_version','definition_hash','acl_hash','dependency_hash']){
  const changed=F.clone(s);changed.database_audits[0].diagnostic_read_exceptions[0][field]+='1';assert.throws(()=>A.validateConnectionScope(changed,'17001',review),/DIAGNOSTIC_REVIEW_DRIFT/);
 }
 const unreviewed={...review,diagnostic_read_exceptions:[]};assert.throws(()=>A.validateConnectionScope(s,'17001',unreviewed),/DIAGNOSTIC_REVIEW_DRIFT/);
 const generic=F.clone(review);generic.diagnostic_read_exceptions[0].extension_name='unrelated_extension';assert.throws(()=>A.validateConnectionScope(s,'17001',generic),/DIAGNOSTIC_EXCEPTION/);
 const version=F.clone(review);version.diagnostic_read_exceptions[0].extension_version='1.12';assert.throws(()=>A.validateConnectionScope(s,'17001',version),/DIAGNOSTIC_EXCEPTION/);
 const excess=F.clone(review);excess.diagnostic_read_exceptions.push({...excess.diagnostic_read_exceptions[0],relation_oid:'16944'},{...excess.diagnostic_read_exceptions[0],relation_oid:'16945'});assert.throws(()=>A.validateConnectionScope(s,'17001',excess),/DIAGNOSTIC_REVIEW/);
 const stillApp=F.clone(s);stillApp.database_audits[0].non_system_read=true;assert.throws(()=>A.validateConnectionScope(stillApp,'17001',review),/OTHER_DATABASE_APPLICATION_ACCESS/);
});
