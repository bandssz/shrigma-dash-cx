'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../tools/graph-worker-access/database-scope.cjs');
const {sha}=require('../tools/maintenance-cart-deploy/deploy.cjs');
const copy=x=>JSON.parse(JSON.stringify(x));
const ROLE='900';
function fixture({login=false,diagnostics=false}={}){
 const inventory=[{oid:'100',name:'postgres'},{oid:'200',name:'reporting_fixture'},{oid:'300',name:'listmonk'}];
 const identity={oid:ROLE,role:{name:'crm_graph_worker',login,superuser:false,createdb:false,createrole:false,inherit:false,replication:false,bypassrls:false,memberships:0},settings:null,valid_until:null,connection_limit:-1,database_settings:[]};
 const session=d=>({database:d.name,database_oid:d.oid,role:'postgres',role_oid:'10',superuser:true,server_version_num:170010,read_only:'on',isolation:'read committed',statement_timeout_ms:20000,search_schemas:['pg_catalog','public'],pid:1000+Number(d.oid)});
 const rows=inventory.map(d=>({session:session(d),worker_identity:copy(identity),catalog:{database:d.name,database_oid:d.oid,role_oid:ROLE,role_flags:copy(identity.role),role_settings:{settings:null,valid_until:null,connection_limit:-1,database_settings:[]},database_acl:{owner:'10',acl:null},connect:true,temporary:true,create:false,schemas:[],relations:[],functions:[],foreign_servers:[],large_objects:[],lo_compat_privileges:'off',memberships:[],diagnostics:[]}}));
 if(diagnostics){const c=rows[1].catalog;
  for(const [i,name] of ['pg_stat_statements','pg_stat_statements_info'].entries()){
   const relation={oid:String(410+i),schema:'public',name,kind:'v',owner:'10',acl:'synthetic public SELECT',usage:true,table_read:true,table_write:false,column_read:true,column_write:false,columns:[{number:1,name:'synthetic_column',acl:null}]};
   c.relations.push(relation);
   c.diagnostics.push({relation_oid:relation.oid,schema:'public',name,kind:'v',owner:'10',schema_owner:'10',schema_owner_name:'postgres',schema_acl:'synthetic usage only',acl:relation.acl,definition:'synthetic view definition '+name,extension_oid:'400',extension_name:'pg_stat_statements',extension_version:'1.11',extension_owner:'10',extension_namespace:'2200',namespace:'2200',dependency_type:'e',functions:[{oid:String(420+i),name,namespace:'2200',arguments:i===0?'boolean':'',owner:'10',language:'c',binary:'$libdir/pg_stat_statements',symbol:i===0?'pg_stat_statements_1_11':'pg_stat_statements_info',security_definer:false,config:null,acl:'synthetic execute',definition_hash:sha(name),extension_member:true}]});
  }
 }
 const calls={inventory:0,databases:[]};
 const inventoryRow=()=>({session:session(inventory[2]),worker_identity:copy(identity),inventory:copy(inventory)});
 const io={inventory:async sql=>{assert.equal(sql,S.INVENTORY_SQL);calls.inventory++;return inventoryRow();},readDatabase:async({database,sql})=>{assert.equal(sql,S.DATABASE_SQL);calls.databases.push(database);return copy(rows.find(r=>r.session.database===database));}};
 return {inventory,identity,rows,calls,io,inventoryRow,options:{io,role_oid:ROLE,worker_login:login,reviewedDiagnostics:[]}};
}
test('fresh complete inventory and one actual query per database on every invocation',async()=>{
 const f=fixture(),a=await S.auditDatabaseScope(f.options),b=await S.auditDatabaseScope(f.options);
 assert.deepEqual(a,b);assert.equal(f.calls.inventory,4);assert.equal(f.calls.databases.length,6);
 assert.deepEqual(a.database_inventory,f.inventory);assert.equal(a.scope_hash,sha(a.connection_scope));
 assert.ok(a.connection_scope.database_audits.every(d=>!d.non_system_read&&!d.non_system_write&&!d.create));
});
test('only observed LOGIN is normalized and the before/after scope stays identical',async()=>{
 const off=fixture(),on=fixture({login:true});
 assert.deepEqual(await S.auditDatabaseScope(off.options),await S.auditDatabaseScope(on.options));
 assert.throws(()=>S.normalizeCatalog(off.rows[0].catalog,true),/LOGIN_OBSERVATION/);
 const c=copy(off.rows[0].catalog);c.role_flags.createdb=true;
 assert.notEqual(sha(S.normalizeCatalog(c,false)),sha(S.normalizeCatalog(off.rows[0].catalog,false)));
});
test('column-only table grants and sequence access outside listmonk are rejected',async()=>{
 for(const flags of [{column_read:true},{column_write:true},{kind:'S',table_read:true},{kind:'S',table_write:true}]){
  const f=fixture();f.rows[1].catalog.relations.push({oid:'500',schema:'public',name:'synthetic',kind:'r',owner:'10',acl:null,usage:true,table_read:false,table_write:false,column_read:false,column_write:false,columns:[],...flags});
  await assert.rejects(S.auditDatabaseScope(f.options),/OTHER_DATABASE_APPLICATION_ACCESS/);
 }
});
test('schema CREATE, DB CREATE, foreign server, security definer and large object privileges fail closed',async()=>{
 const changes=[c=>c.schemas.push({oid:'500',usage:true,create:true}),c=>{c.create=true;},c=>c.foreign_servers.push({oid:'500',usage:true}),c=>c.functions.push({oid:'500',security_definer:true,usage:true,execute:true,definition_hash:sha('f')}),c=>c.large_objects.push({oid:'500',read:true,write:false}),c=>c.large_objects.push({oid:'500',read:false,write:true}),c=>{c.lo_compat_privileges='on';}];
 for(const change of changes){const f=fixture();change(f.rows[1].catalog);await assert.rejects(S.auditDatabaseScope(f.options),/GRAPH_/);}
});
test('same grants may be audited in listmonk while source role/graph restrictions stay elsewhere',async()=>{
 const f=fixture();f.rows[2].catalog.relations.push({oid:'500',schema:'public',name:'synthetic',kind:'r',owner:'10',acl:null,usage:true,table_read:true,table_write:true,column_read:true,column_write:true,columns:[]});
 const r=await S.auditDatabaseScope(f.options);assert.equal(r.connection_scope.database_audits[2].non_system_read,true);assert.equal(r.connection_scope.database_audits[2].non_system_write,true);
});
test('changed external catalog/grant is visible in the next fresh invocation',async()=>{
 const f=fixture(),first=await S.auditDatabaseScope(f.options);
 f.rows[1].catalog.database_acl.acl='synthetic changed grant';
 const second=await S.auditDatabaseScope(f.options);assert.notEqual(first.scope_hash,second.scope_hash);
 f.rows[1].catalog.large_objects.push({oid:'600',read:true,write:false});await assert.rejects(S.auditDatabaseScope(f.options),/OTHER_DATABASE_APPLICATION_ACCESS/);
});
test('missing DB result, changed inventory, stale role OID and membership cannot pass',async()=>{
 for(const change of [f=>{const old=f.io.inventory;f.io.inventory=async sql=>{const r=await old(sql);r.session.database_oid='999';return r;};},f=>{f.rows.splice(1,1);},f=>{f.rows[1].worker_identity.oid='901';},f=>{f.rows[1].worker_identity.role.memberships=1;},f=>{f.rows[1].catalog.memberships.push({member:ROLE});},f=>{const old=f.io.inventory;f.io.inventory=async sql=>{const r=await old(sql);if(f.calls.inventory===2)r.inventory.pop();return r;};}]){
  const f=fixture();change(f);await assert.rejects(S.auditDatabaseScope(f.options));
 }
});
test('read-only session, PG17.10, exact target DB and expected login are mandatory',async()=>{
 for(const change of [f=>{f.rows[1].session.read_only='off';},f=>{f.rows[1].session.database='listmonk';},f=>{f.rows[1].session.server_version_num=170009;},f=>{f.rows[1].session.statement_timeout_ms=0;},f=>{f.rows[1].worker_identity.role.login=true;}]){
  const f=fixture();change(f);await assert.rejects(S.auditDatabaseScope(f.options),/GRAPH_DATABASE_SCOPE_/);
 }
});
test('diagnostic inspection is a proposal; strict audit requires reviewed exact pins',async()=>{
 const f=fixture({diagnostics:true}),inspected=await S.inspectDatabaseScope(f.options);
 assert.equal(inspected.observations.length,3);assert.equal(inspected.proposal.diagnostic_read_exceptions.length,2);
 await assert.rejects(S.auditDatabaseScope(f.options),/DIAGNOSTIC_REVIEW_DRIFT/);
 const approved={...f.options,reviewedDiagnostics:copy(inspected.proposal.diagnostic_read_exceptions)};
 const audited=await S.auditDatabaseScope(approved);assert.equal(audited.connection_scope.database_audits[1].non_system_read,false);
 assert.deepEqual(audited.diagnostic_read_exceptions,approved.reviewedDiagnostics);
});
test('changed diagnostic definition, column ACL, symbol, extension owner or fake extension is refused',async()=>{
 const changes=[c=>{c.diagnostics[0].definition+=' altered';},c=>{c.relations[0].columns[0].acl='synthetic changed column grant';},c=>{c.diagnostics[0].functions[0].symbol='evil';},c=>{c.diagnostics[0].extension_owner='999';},c=>{c.diagnostics[0].extension_name='fake';},c=>{c.diagnostics[0].functions[0].extension_member=false;},c=>{c.diagnostics[0].functions[0].security_definer=true;},c=>{c.diagnostics[0].functions.push(copy(c.diagnostics[0].functions[0]));}];
 for(const change of changes){const f=fixture({diagnostics:true}),pins=(await S.inspectDatabaseScope(f.options)).proposal.diagnostic_read_exceptions;change(f.rows[1].catalog);await assert.rejects(S.auditDatabaseScope({...f.options,reviewedDiagnostics:pins}),/GRAPH_DATABASE_SCOPE_/);}
});
test('database-owner schema is accepted only for the actual admin-owned database and pinned separately',async()=>{
 const f=fixture({diagnostics:true});for(const d of f.rows[1].catalog.diagnostics){d.schema_owner='6171';d.schema_owner_name='pg_database_owner';}
 const proposal=await S.inspectDatabaseScope(f.options);await S.auditDatabaseScope({...f.options,reviewedDiagnostics:proposal.proposal.diagnostic_read_exceptions});
 f.rows[1].catalog.database_acl.owner='999';await assert.rejects(S.inspectDatabaseScope(f.options),/DIAGNOSTIC_CATALOG/);
});
test('queries expose only catalogs and qualify sensitive PostgreSQL helpers',()=>{
 assert.match(S.INVENTORY_SQL,/^SELECT /);assert.match(S.DATABASE_SQL,/^SELECT /);
 for(const sql of [S.INVENTORY_SQL,S.DATABASE_SQL]){
  assert.doesNotMatch(sql,/\b(?:INSERT|ALTER|DROP|UPDATE|DELETE)\s+(?:INTO|TABLE|ROLE|SCHEMA|FROM)\b/i);
  assert.doesNotMatch(sql,/(?<!pg_catalog\.)\b(?:jsonb_build_object|jsonb_agg|sha256|encode|format|current_setting)\s*\(/);
 }
 assert.match(S.DATABASE_SQL,/pg_catalog\.has_any_column_privilege/);
 assert.match(S.DATABASE_SQL,/pg_catalog\.pg_largeobject_metadata/);
 assert.doesNotMatch(S.DATABASE_SQL,/\bFROM\s+pg_catalog\.pg_largeobject\b/);
 assert.match(S.DATABASE_SQL,/pg_catalog\.pg_rewrite/);
});
