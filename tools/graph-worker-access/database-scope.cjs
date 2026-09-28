'use strict';
// Catalog reads only. Callbacks must make fresh queries on isolated READ ONLY
// sessions; the private integrator retains raw evidence. No logger or endpoint.
const {sha,canonical}=require('../maintenance-cart-deploy/deploy.cjs');
const A=require('./contract.cjs');
const ROLE='crm_graph_worker';
const same=(a,b)=>canonical(a)===canonical(b),clone=x=>JSON.parse(JSON.stringify(x));
const oid=x=>typeof x==='string'&&/^[1-9][0-9]{0,9}$/.test(x)&&BigInt(x)<=4294967295n;
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function check(value,code){if(!value)throw Error('GRAPH_DATABASE_SCOPE_'+code);}
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,fields)=>object(x)&&same(Object.keys(x).sort(),fields.slice().sort());
const ROLE_SQL=`(SELECT pg_catalog.jsonb_build_object('oid',r.oid::text,'role',pg_catalog.jsonb_build_object('name',r.rolname,'login',r.rolcanlogin,'superuser',r.rolsuper,'createdb',r.rolcreatedb,'createrole',r.rolcreaterole,'inherit',r.rolinherit,'replication',r.rolreplication,'bypassrls',r.rolbypassrls,'memberships',(SELECT pg_catalog.count(*) FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)),'settings',r.rolconfig,'valid_until',r.rolvaliduntil::text,'connection_limit',r.rolconnlimit,'database_settings',(SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('database_oid',s.setdatabase::text,'settings',s.setconfig) ORDER BY s.setdatabase),'[]'::jsonb) FROM pg_catalog.pg_db_role_setting s WHERE s.setrole=r.oid)) FROM pg_catalog.pg_roles r WHERE r.rolname='${ROLE}')`;
const SESSION_SQL=`pg_catalog.jsonb_build_object('database',pg_catalog.current_database(),'database_oid',(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()),'role',current_user,'role_oid',(SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user),'superuser',(SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user),'server_version_num',pg_catalog.current_setting('server_version_num')::integer,'read_only',pg_catalog.current_setting('transaction_read_only'),'isolation',pg_catalog.current_setting('transaction_isolation'),'statement_timeout_ms',(SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='statement_timeout'),'search_schemas',pg_catalog.current_schemas(true),'pid',pg_catalog.pg_backend_pid())`;
const INVENTORY_SQL=`SELECT ${SESSION_SQL} AS session,${ROLE_SQL} AS worker_identity,(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',d.oid::text,'name',d.datname) ORDER BY d.oid) FROM pg_catalog.pg_database d WHERE NOT d.datistemplate AND d.datallowconn) AS inventory;`;
const DATABASE_BODY=`WITH worker AS (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${ROLE}'),
schemas AS (SELECT * FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'),
relations AS (SELECT c.*,n.nspname,n.nspacl,n.nspowner FROM pg_catalog.pg_class c JOIN schemas n ON n.oid=c.relnamespace WHERE c.relkind IN('r','p','v','m','f','S')),
diagnostics AS (SELECT c.*,e.oid AS extension_oid,e.extname,e.extversion,e.extowner,e.extnamespace,d.deptype FROM relations c LEFT JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid AND d.objsubid=0 AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.deptype='e' LEFT JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid WHERE c.relname IN('pg_stat_statements','pg_stat_statements_info'))
SELECT ${SESSION_SQL} AS session,${ROLE_SQL} AS worker_identity,
pg_catalog.jsonb_build_object(
 'database',pg_catalog.current_database(),'database_oid',(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()),'role_oid',(SELECT oid::text FROM worker),'role_flags',(${ROLE_SQL})->'role',
 'role_settings',(${ROLE_SQL})-'role'-'oid',
 'database_acl',(SELECT pg_catalog.jsonb_build_object('owner',datdba::text,'acl',datacl::text) FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()),
 'connect',pg_catalog.has_database_privilege('${ROLE}',pg_catalog.current_database(),'CONNECT'),'temporary',pg_catalog.has_database_privilege('${ROLE}',pg_catalog.current_database(),'TEMP'),'create',pg_catalog.has_database_privilege('${ROLE}',pg_catalog.current_database(),'CREATE'),
 'schemas',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',oid::text,'name',nspname,'owner',nspowner::text,'acl',nspacl::text,'usage',pg_catalog.has_schema_privilege('${ROLE}',oid,'USAGE'),'create',pg_catalog.has_schema_privilege('${ROLE}',oid,'CREATE')) ORDER BY oid) FROM schemas),'[]'::jsonb),
 'relations',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',c.oid::text,'schema',c.nspname,'name',c.relname,'kind',c.relkind,'owner',c.relowner::text,'acl',c.relacl::text,'usage',pg_catalog.has_schema_privilege('${ROLE}',c.relnamespace,'USAGE'),'table_read',CASE WHEN c.relkind='S' THEN pg_catalog.has_sequence_privilege('${ROLE}',c.oid,'SELECT,USAGE') ELSE pg_catalog.has_table_privilege('${ROLE}',c.oid,'SELECT') END,'table_write',CASE WHEN c.relkind='S' THEN pg_catalog.has_sequence_privilege('${ROLE}',c.oid,'UPDATE,USAGE') ELSE pg_catalog.has_table_privilege('${ROLE}',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') END,'column_read',CASE WHEN c.relkind='S' THEN false ELSE pg_catalog.has_any_column_privilege('${ROLE}',c.oid,'SELECT') END,'column_write',CASE WHEN c.relkind='S' THEN false ELSE pg_catalog.has_any_column_privilege('${ROLE}',c.oid,'INSERT,UPDATE,REFERENCES') END,'columns',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('number',a.attnum,'name',a.attname,'acl',a.attacl::text) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb)) ORDER BY c.oid) FROM relations c),'[]'::jsonb),
 'functions',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',p.oid::text,'schema',n.nspname,'name',p.proname,'owner',p.proowner::text,'acl',p.proacl::text,'security_definer',p.prosecdef,'usage',pg_catalog.has_schema_privilege('${ROLE}',n.oid,'USAGE'),'execute',pg_catalog.has_function_privilege('${ROLE}',p.oid,'EXECUTE'),'definition_hash',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex'),'config',p.proconfig) ORDER BY p.oid) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND ((n.nspname !~ '^pg_' AND n.nspname<>'information_schema') OR p.prosecdef)),'[]'::jsonb),
 'foreign_servers',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',oid::text,'name',srvname,'owner',srvowner::text,'acl',srvacl::text,'usage',pg_catalog.has_server_privilege('${ROLE}',oid,'USAGE')) ORDER BY oid) FROM pg_catalog.pg_foreign_server),'[]'::jsonb),
 'large_objects',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',l.oid::text,'owner',l.lomowner::text,'acl',l.lomacl::text,'read',l.lomowner=(SELECT oid FROM worker) OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(l.lomacl,'{}'::aclitem[])) a WHERE a.grantee IN(0,(SELECT oid FROM worker)) AND a.privilege_type='SELECT'),'write',l.lomowner=(SELECT oid FROM worker) OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(l.lomacl,'{}'::aclitem[])) a WHERE a.grantee IN(0,(SELECT oid FROM worker)) AND a.privilege_type='UPDATE')) ORDER BY l.oid) FROM pg_catalog.pg_largeobject_metadata l),'[]'::jsonb),
 'lo_compat_privileges',pg_catalog.current_setting('lo_compat_privileges'),
 'memberships',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('roleid',roleid::text,'member',member::text,'grantor',grantor::text,'admin_option',admin_option,'inherit_option',inherit_option,'set_option',set_option) ORDER BY roleid,member,grantor) FROM pg_catalog.pg_auth_members WHERE member=(SELECT oid FROM worker) OR roleid=(SELECT oid FROM worker)),'[]'::jsonb),
 'diagnostics',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('relation_oid',c.oid::text,'schema',c.nspname,'name',c.relname,'kind',c.relkind,'owner',c.relowner::text,'schema_owner',c.nspowner::text,'schema_owner_name',pg_catalog.pg_get_userbyid(c.nspowner),'schema_acl',c.nspacl::text,'acl',c.relacl::text,'definition',CASE WHEN c.relkind='v' THEN pg_catalog.pg_get_viewdef(c.oid,true) END,'extension_oid',c.extension_oid::text,'extension_name',c.extname,'extension_version',c.extversion,'extension_owner',c.extowner::text,'extension_namespace',c.extnamespace::text,'namespace',c.relnamespace::text,'dependency_type',c.deptype,'functions',coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',p.oid::text,'name',p.proname,'namespace',p.pronamespace::text,'arguments',pg_catalog.oidvectortypes(p.proargtypes),'owner',p.proowner::text,'language',l.lanname,'binary',p.probin,'symbol',p.prosrc,'security_definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl::text,'definition_hash',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex'),'extension_member',EXISTS(SELECT 1 FROM pg_catalog.pg_depend pd WHERE pd.classid='pg_catalog.pg_proc'::regclass AND pd.objid=p.oid AND pd.objsubid=0 AND pd.refclassid='pg_catalog.pg_extension'::regclass AND pd.refobjid=c.extension_oid AND pd.deptype='e')) ORDER BY p.oid) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE p.oid IN(SELECT rd.refobjid FROM pg_catalog.pg_rewrite rw JOIN pg_catalog.pg_depend rd ON rd.classid='pg_catalog.pg_rewrite'::regclass AND rd.objid=rw.oid AND rd.refclassid='pg_catalog.pg_proc'::regclass WHERE rw.ev_class=c.oid)),'[]'::jsonb)) ORDER BY c.oid) FROM diagnostics c),'[]'::jsonb)
) AS catalog`;
const DATABASE_SQL=`SELECT session,worker_identity,catalog FROM (${DATABASE_BODY}) AS audited_database;`;
async function read(callback){try{return await callback();}catch{throw Error('GRAPH_DATABASE_SCOPE_READ_UNCONFIRMED');}}
function inventory(value){
 check(Array.isArray(value)&&value.length>0&&value.length<=128,'INVENTORY');let previous=0n;const names=new Set();
 for(const item of value){check(exact(item,['oid','name'])&&oid(item.oid)&&BigInt(item.oid)>previous&&typeof item.name==='string'&&item.name.length>0&&Buffer.byteLength(item.name)<=63&&!/[\0\r\n]/.test(item.name)&&!names.has(item.name),'INVENTORY');previous=BigInt(item.oid);names.add(item.name);}
 check(names.has('listmonk'),'TARGET_DATABASE');return value;
}
function session(value,database){check(object(value)&&value.database===database&&oid(value.database_oid)&&value.role==='postgres'&&oid(value.role_oid)&&value.superuser===true&&value.server_version_num===170010&&value.read_only==='on'&&value.isolation==='read committed'&&value.statement_timeout_ms===20000&&same(value.search_schemas,['pg_catalog','public'])&&Number.isSafeInteger(value.pid)&&value.pid>0,'SESSION');}
function worker(value,role_oid,worker_login){
 check(oid(role_oid)&&typeof worker_login==='boolean'&&exact(value,['oid','role','settings','valid_until','connection_limit','database_settings'])&&value.oid===role_oid,'WORKER_IDENTITY');
 check(exact(value.role,['name','login','superuser','createdb','createrole','inherit','replication','bypassrls','memberships'])&&value.role.name===ROLE&&value.role.login===worker_login&&value.role.memberships===0&&['superuser','createdb','createrole','inherit','replication','bypassrls'].every(k=>value.role[k]===false)&&value.settings===null&&value.valid_until===null&&value.connection_limit===-1&&same(value.database_settings,[]),'WORKER_FLAGS');
}
function normalizeCatalog(catalog,worker_login){
 check(typeof worker_login==='boolean'&&object(catalog)&&object(catalog.role_flags)&&catalog.role_flags.login===worker_login,'LOGIN_OBSERVATION');
 const result=clone(catalog);result.role_flags.login=false;return result;
}
function classifyDiagnostics(catalog,admin_oid){
 const result=[];const seen=new Set();
 for(const d of catalog.diagnostics){
  const relation=catalog.relations.find(r=>r.oid===d.relation_oid);
  if(!relation||!relation.usage||!(relation.table_read||relation.column_read))continue;
  const symbol=d.name==='pg_stat_statements'?'pg_stat_statements_1_11':d.name==='pg_stat_statements_info'?'pg_stat_statements_info':null;
  check(symbol&&d.schema==='public'&&d.kind==='v'&&d.owner===admin_oid&&(d.schema_owner===admin_oid||(d.schema_owner_name==='pg_database_owner'&&catalog.database_acl.owner===admin_oid))&&d.extension_owner===admin_oid&&d.extension_name==='pg_stat_statements'&&d.extension_version==='1.11'&&oid(d.extension_oid)&&d.extension_namespace===d.namespace&&d.dependency_type==='e'&&typeof d.definition==='string'&&d.definition.length>0&&Array.isArray(d.functions)&&d.functions.length===1&&!seen.has(d.name)&&!relation.table_write&&!relation.column_write,'DIAGNOSTIC_CATALOG');
  const f=d.functions[0];check(oid(f.oid)&&f.name===d.name&&f.namespace===d.namespace&&f.arguments===(d.name==='pg_stat_statements'?'boolean':'')&&f.owner===admin_oid&&f.language==='c'&&f.binary==='$libdir/pg_stat_statements'&&f.symbol===symbol&&f.security_definer===false&&f.config===null&&f.extension_member===true&&digest(f.definition_hash),'DIAGNOSTIC_FUNCTION');
  check(relation.schema===d.schema&&relation.name===d.name&&relation.owner===d.owner&&relation.kind===d.kind&&relation.acl===d.acl,'DIAGNOSTIC_RELATION');
  seen.add(d.name);result.push({database_oid:catalog.database_oid,relation_oid:d.relation_oid,extension_oid:d.extension_oid,extension_name:'pg_stat_statements',extension_version:'1.11',definition_hash:sha(d.definition),acl_hash:sha({schema_acl:d.schema_acl,relation_acl:d.acl,columns:relation.columns}),dependency_hash:sha({owner:d.owner,schema_owner:d.schema_owner,schema_owner_name:d.schema_owner_name,extension_owner:d.extension_owner,extension_namespace:d.extension_namespace,dependency_type:d.dependency_type,functions:d.functions})});
 }
 check(result.length===0||result.length===2,'DIAGNOSTIC_PAIR');return result;
}
function validateCatalog(value,identity){
 check(exact(value,['database','database_oid','role_oid','role_flags','role_settings','database_acl','connect','temporary','create','schemas','relations','functions','foreign_servers','large_objects','lo_compat_privileges','memberships','diagnostics'])&&object(value.database_acl)&&oid(value.database_acl.owner)&&value.role_oid===identity.oid&&same(value.role_flags,identity.role)&&same(value.role_settings,{settings:identity.settings,valid_until:identity.valid_until,connection_limit:identity.connection_limit,database_settings:identity.database_settings})&&['connect','temporary','create'].every(k=>typeof value[k]==='boolean')&&value.lo_compat_privileges==='off','CATALOG');
 for(const key of ['schemas','relations','functions','foreign_servers','large_objects','memberships','diagnostics'])check(Array.isArray(value[key]),'CATALOG_ARRAY');
 check(value.memberships.length===0,'MEMBERSHIPS');
 for(const r of value.schemas)check(oid(r.oid)&&['usage','create'].every(k=>typeof r[k]==='boolean'),'SCHEMA');
 for(const r of value.relations)check(oid(r.oid)&&['usage','table_read','table_write','column_read','column_write'].every(k=>typeof r[k]==='boolean')&&Array.isArray(r.columns),'RELATION');
 for(const r of value.functions)check(oid(r.oid)&&['security_definer','usage','execute'].every(k=>typeof r[k]==='boolean')&&digest(r.definition_hash),'FUNCTION');
 for(const r of value.foreign_servers)check(oid(r.oid)&&typeof r.usage==='boolean','FOREIGN_SERVER');
 for(const r of value.large_objects)check(oid(r.oid)&&typeof r.read==='boolean'&&typeof r.write==='boolean','LARGE_OBJECT');
}
async function inspectDatabaseScope({io,role_oid,worker_login}){
 check(io&&typeof io.inventory==='function'&&typeof io.readDatabase==='function','IO');
 const before=await read(()=>io.inventory(INVENTORY_SQL));check(exact(before,['session','worker_identity','inventory']),'INVENTORY_RESULT');session(before.session,'listmonk');worker(before.worker_identity,role_oid,worker_login);inventory(before.inventory);check(before.session.database_oid===before.inventory.find(d=>d.name==='listmonk').oid,'INVENTORY_IDENTITY');
 const observations=[],audits=[],exceptions=[];
 for(const database of before.inventory){
  const row=await read(()=>io.readDatabase({database:database.name,sql:DATABASE_SQL}));check(exact(row,['session','worker_identity','catalog']),'DATABASE_RESULT');session(row.session,database.name);worker(row.worker_identity,role_oid,worker_login);
  check(row.session.database_oid===database.oid&&row.session.role_oid===before.session.role_oid&&same(row.worker_identity,before.worker_identity),'DATABASE_IDENTITY');
  const c=row.catalog;validateCatalog(c,row.worker_identity);check(c.database===database.name&&c.database_oid===database.oid,'DATABASE_CATALOG');
  const diagnostics=classifyDiagnostics(c,before.session.role_oid);exceptions.push(...diagnostics);const exempt=new Set(diagnostics.map(d=>d.relation_oid));
  const summary={oid:database.oid,name:database.name,connect:c.connect,temporary:c.temporary,create:c.create,catalog_hash:sha(normalizeCatalog(c,worker_login)),non_system_read:c.relations.some(r=>r.usage&&(r.table_read||r.column_read)&&!exempt.has(r.oid))||c.large_objects.some(r=>r.read),non_system_write:c.relations.some(r=>r.usage&&(r.table_write||r.column_write))||c.large_objects.some(r=>r.write),non_system_create:c.schemas.some(s=>s.create),non_system_definer_execute:c.functions.some(f=>f.usage&&f.execute&&f.security_definer),foreign_server_usage:c.foreign_servers.some(s=>s.usage),diagnostic_read_exceptions:diagnostics.map(({database_oid,...d})=>d)};
  audits.push(summary);observations.push(row);
 }
 const after=await read(()=>io.inventory(INVENTORY_SQL));check(exact(after,['session','worker_identity','inventory']),'INVENTORY_RESULT');session(after.session,'listmonk');worker(after.worker_identity,role_oid,worker_login);inventory(after.inventory);check(after.session.database_oid===after.inventory.find(d=>d.name==='listmonk').oid,'INVENTORY_IDENTITY');
 check(same(before.inventory,after.inventory)&&same(before.worker_identity,after.worker_identity)&&before.session.role_oid===after.session.role_oid,'INVENTORY_DRIFT');
 const connection_scope={database:'listmonk',role:ROLE,role_oid,policy:A.SCOPE_POLICY,database_audits:audits};
 const proposal={connection_scope,scope_hash:sha(connection_scope),database_inventory:clone(before.inventory),diagnostic_read_exceptions:exceptions};
 return {proposal,observations,inventory_before:before,inventory_after:after};
}
async function auditDatabaseScope({reviewedDiagnostics,...options}){
 check(Array.isArray(reviewedDiagnostics)&&[0,2].includes(reviewedDiagnostics.length),'REVIEW_REQUIRED');const pins=clone(reviewedDiagnostics);
 const inspected=await inspectDatabaseScope(options);
 check(same(inspected.proposal.diagnostic_read_exceptions,pins),'DIAGNOSTIC_REVIEW_DRIFT');
 A.validateConnectionScope(inspected.proposal.connection_scope,options.role_oid,inspected.proposal);
 return inspected.proposal;
}
module.exports={INVENTORY_SQL,DATABASE_SQL,inspectDatabaseScope,auditDatabaseScope,normalizeCatalog,classifyDiagnostics};
