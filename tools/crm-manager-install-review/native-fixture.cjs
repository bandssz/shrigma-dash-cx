'use strict';
// Private native fixture. No environment, transport or SQL runs on import.
// Only createNativeFixture with the exact guarded native client admits a DB.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const PINS={"installer.sql": "33a412f3d8b8fc4293010e2aec95dc5a8ba3f1296f86000d50e79cfb87ec0bd9", "rollback.sql": "dace1eab926186c4aa277d89c92813ce0ac06cc5fd971c0569f2cd9ef0734d4f", "profile.sql": "a20c51e10dfff6c781b94158ed392a38c1ec64d30966281ecd2ede72e52f62e9", "scope.sql": "add1d1d91e0b6d5d15600c8a2e40875edf725d9afc54d76433751f5003831030", "auth.sql": "57d47b4ff130179f897eabd1c3a843f39373dcc4d9592a71e485443992867124", "operator.sql": "7b1ab4bb657c6109337355c9a615c0fe5ff6a9837e69ef181ab1806d307446e8", "short.sql": "7337b1e60b06648c28e126586b015dada7165eeb89d040ac6cc46b1f9d983682", "read.sql": "8dd2f1a904626795fbdd8914c366170fb8127f66598db71f0a56163c8a7a17c1"};
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const OWNER='crm_manager_function_owner_v1',SERVICE='crm_manager_provisioner';
const tables=['shrigma_crm_manager_issuer_v1','shrigma_crm_manager_subject_v1','shrigma_crm_manager_operation_v1','shrigma_crm_manager_generation_v1'];
const owned=new WeakSet();
function source(name){assert.ok(Object.hasOwn(PINS,name));const raw=fs.readFileSync(path.join(__dirname,'sql',name));assert.equal(sha(raw),PINS[name]);return raw.toString('utf8');}
function flattenRows(results){return(Array.isArray(results)?results:[results]).flatMap(r=>r.rows||[]);}
function clientConfig(){return {host:'127.0.0.1',port:5438,database:'listmonk',user:'postgres',password:'synthetic-native-v3-only',ssl:false,application_name:'shrigma-manager-v3-private-fixture',options:'-c statement_timeout=8000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=10000',connectionTimeoutMillis:2000,query_timeout:10000,statement_timeout:8000,lock_timeout:3000,idle_in_transaction_session_timeout:10000};}
function requireNativeClient(client){const p=client.connectionParameters;assert.deepEqual({host:p.host,port:p.port,database:p.database,user:p.user,password:p.password,ssl:p.ssl,application_name:p.application_name,options:p.options},clientConfigProjection());}
function clientConfigProjection(){const{host,port,database,user,password,ssl,application_name,options}=clientConfig();return{host,port,database,user,password,ssl,application_name,options};}
async function createNativeFixture(Client){
 const client=new Client(clientConfig());requireNativeClient(client);
 const db={exec:sql=>client.query(sql),query:(sql,args)=>client.query(sql,args),close:()=>client.end()};
 try{
  await client.connect();
  const identity=(await db.query("SELECT current_database() AS database,current_user AS role,session_user AS session_role,current_setting('server_version_num')::int/10000 AS major,inet_server_port() AS port,current_setting('application_name') AS app,current_setting('cluster_name') AS cluster")).rows[0];
  assert.deepEqual(identity,{database:'listmonk',role:'postgres',session_role:'postgres',major:17,port:5432,app:'shrigma-manager-v3-private-fixture',cluster:'shrigma-native-v3-disposable-only'});
  const initial=(await db.query("SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','S','f')) AS relations,(SELECT count(*)::int FROM pg_roles WHERE rolname IN ('central_leitor','crm_manager_function_owner_v1','crm_manager_provisioner')) AS fixture_roles,(SELECT count(*)::int FROM pg_default_acl) AS default_acls,(SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace) AS public_functions,(SELECT count(*)::int FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('public','information_schema')) AS extra_schemas")).rows[0];
  assert.deepEqual(initial,{relations:0,fixture_roles:0,default_acls:0,public_functions:0,extra_schemas:0});
  await db.exec(`
   REVOKE CREATE ON SCHEMA public FROM PUBLIC;
   CREATE ROLE central_leitor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
   CREATE TABLE public.crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL CHECK(painel IN ('cx','growth','influs','organico','todos')),dono text NOT NULL,ativo boolean NOT NULL DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer NOT NULL DEFAULT 0,chave_hash text,chave_hash_curta text,expira_em timestamptz,criado_em timestamptz NOT NULL DEFAULT now());
   CREATE UNIQUE INDEX crm_dash_chave_curta_uq ON public.crm_dash_chave(chave_hash_curta) WHERE chave_hash_curta IS NOT NULL;
   CREATE TABLE public.shrigma_template_key_v2(active boolean,key_hash text,actor text,capabilities jsonb);
   CREATE TABLE public.dash_payload_cache(painel text PRIMARY KEY,payload jsonb,gerado_em timestamptz);
   REVOKE ALL ON public.crm_dash_chave,public.shrigma_template_key_v2,public.dash_payload_cache FROM PUBLIC;
  `);
  await db.exec(source('auth.sql'));
  await db.exec(source('operator.sql'));
  await db.exec(source('short.sql'));
  await db.exec(source('read.sql'));
  await db.query('INSERT INTO public.crm_dash_chave(chave,painel,dono,chave_hash,chave_hash_curta) VALUES($1,$2,$3,$4,$5)',
   ['synthetic-legacy-admin','todos','legacy-admin@example.test',sha('synthetic-legacy-only'),sha('synthetic-legacy-short')]);
  await db.exec(`INSERT INTO public.shrigma_panel_permission_v1 VALUES('synthetic-legacy-admin','growth','["crm_campaign_write","crm_send"]'),('synthetic-legacy-admin','influs','["all"]');
   INSERT INTO public.dash_payload_cache VALUES('growth','{"synthetic":true}',now());
   GRANT USAGE ON SCHEMA public TO central_leitor;
   GRANT SELECT ON public.crm_dash_chave,public.shrigma_panel_permission_v1,public.dash_payload_cache TO central_leitor;
   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO central_leitor;
  `);
  owned.add(db);return db;
 }catch(e){try{await client.end();}catch{}throw e;}
}
async function scope(db){assert.equal(owned.has(db),true);const r=await db.exec(source('scope.sql'));const rows=flattenRows(r);assert.equal(rows.length,1);const body=rows[0].body;assert.equal(body.schema,'crm-manager-auth-scope-metadata-v1');assert.equal(body.contextVerified,true);assert.equal(body.reports.length,3);return body;}
async function legacySnapshot(db){
 assert.equal(owned.has(db),true);
 return {
  rows:(await db.query('SELECT * FROM public.crm_dash_chave ORDER BY chave')).rows,
  permissions:(await db.query('SELECT * FROM public.shrigma_panel_permission_v1 ORDER BY principal_id,area')).rows,
  cache:(await db.query('SELECT * FROM public.dash_payload_cache ORDER BY painel')).rows,
  columns:(await db.query("SELECT a.attrelid,a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,pg_get_expr(d.adbin,d.adrelid,true) AS default_expr FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid IN ('public.crm_dash_chave'::regclass,'public.shrigma_panel_permission_v1'::regclass) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attrelid,a.attnum")).rows,
  constraints:(await db.query("SELECT conrelid,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('public.crm_dash_chave'::regclass,'public.shrigma_panel_permission_v1'::regclass) ORDER BY conrelid,conname")).rows,
  indexes:(await db.query("SELECT indexrelid,pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid IN ('public.crm_dash_chave'::regclass,'public.shrigma_panel_permission_v1'::regclass) ORDER BY indexrelid")).rows,
  oldTriggers:(await db.query("SELECT g.oid,g.tgrelid,g.tgisinternal,g.tgenabled,g.tgdeferrable,g.tginitdeferred,g.tgtype,pg_get_triggerdef(g.oid) AS definition FROM pg_trigger g JOIN pg_constraint c ON c.oid=g.tgconstraint WHERE g.tgrelid IN ('public.crm_dash_chave'::regclass,'public.shrigma_panel_permission_v1'::regclass) AND c.conrelid='public.shrigma_panel_permission_v1'::regclass ORDER BY g.oid")).rows,
  tableOwners:(await db.query("SELECT oid,relowner FROM pg_class WHERE oid IN ('public.crm_dash_chave'::regclass,'public.shrigma_panel_permission_v1'::regclass,'public.dash_payload_cache'::regclass,'public.shrigma_template_key_v2'::regclass) ORDER BY oid")).rows,
  // Exclude only the documented NEW owner's additive grants; existing grantees
  // must retain exactly their relation/column privileges and grant options.
  relationAcl:(await db.query("SELECT c.oid,a.grantor,a.grantee,a.privilege_type,a.is_grantable FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid IN ('public.crm_dash_chave'::regclass,'public.shrigma_panel_permission_v1'::regclass,'public.dash_payload_cache'::regclass,'public.shrigma_template_key_v2'::regclass) AND a.grantee IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname='crm_manager_function_owner_v1') ORDER BY c.oid,a.grantee,a.privilege_type")).rows,
  columnAcl:(await db.query("SELECT c.attrelid,c.attnum,a.grantor,a.grantee,a.privilege_type,a.is_grantable FROM pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a WHERE c.attrelid IN ('public.crm_dash_chave'::regclass,'public.shrigma_panel_permission_v1'::regclass) AND c.attnum>0 AND NOT c.attisdropped AND a.grantee IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname='crm_manager_function_owner_v1') ORDER BY c.attrelid,c.attnum,a.grantee,a.privilege_type")).rows,
  defaults:(await db.query('SELECT * FROM pg_default_acl ORDER BY oid')).rows,
  functions:(await db.query("SELECT oid,proowner,prosrc,proacl,proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname NOT LIKE 'shrigma_crm_manager_%' ORDER BY oid")).rows,
  schemaAcl:(await db.query("SELECT n.oid,a.grantor,a.grantee,a.privilege_type,a.is_grantable FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='public' AND a.grantee IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname='crm_manager_function_owner_v1') AND a.grantee IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname='crm_manager_provisioner') ORDER BY a.grantee,a.privilege_type")).rows,
  dbAcl:(await db.query('SELECT datacl FROM pg_database WHERE datname=current_database()')).rows,
  roles:(await db.query("SELECT oid,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolconnlimit FROM pg_roles WHERE rolname NOT IN ('crm_manager_function_owner_v1','crm_manager_provisioner') ORDER BY oid")).rows
 };
}
const asService=async(db,fn)=>{assert.equal(owned.has(db),true);await db.exec('SET SESSION AUTHORIZATION '+SERVICE);try{return await fn();}finally{await db.exec('SET SESSION AUTHORIZATION postgres');}};
async function assertInstalled(db){assert.equal(owned.has(db),true);
  const roles=(await db.query("SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolconnlimit FROM pg_roles WHERE rolname IN ($1,$2) ORDER BY rolname",[OWNER,SERVICE])).rows;
  const flags={rolcanlogin:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolinherit:false,rolreplication:false,rolbypassrls:false};
  assert.deepEqual(roles,[{rolname:OWNER,...flags,rolconnlimit:-1},{rolname:SERVICE,...flags,rolconnlimit:2}]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ($1,$2))',[OWNER,SERVICE])).rows[0].n,0);
  for(const t of tables){
   assert.equal((await db.query('SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid=$1::regclass',['public.'+t])).rows[0].owner,OWNER);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM public.'+t)).rows[0].n,0);
   assert.equal((await db.query("SELECT has_table_privilege('central_leitor',$1,'SELECT') AS allowed",['public.'+t])).rows[0].allowed,false);
  }
  assert.equal((await db.query("SELECT has_table_privilege('central_leitor','public.crm_dash_chave','SELECT') AS allowed")).rows[0].allowed,true);
  const fns=(await db.query("SELECT proname,pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'shrigma_crm_manager_%' ORDER BY proname")).rows;
  assert.equal(fns.length,7);assert.equal(fns.every(f=>f.owner===OWNER),true);
  for(const r of [OWNER,SERVICE])assert.equal((await db.query("SELECT has_schema_privilege($1,'public','CREATE') AS allowed",[r])).rows[0].allowed,false);
  assert.deepEqual((await db.query("SELECT pg_get_userbyid(a.grantee) AS role,a.privilege_type,a.is_grantable FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE n.nspname='public' AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ($1,$2)) ORDER BY role,a.privilege_type",[OWNER,SERVICE])).rows,
   [{role:OWNER,privilege_type:'USAGE',is_grantable:false},{role:SERVICE,privilege_type:'USAGE',is_grantable:false}]);
  assert.deepEqual((await db.query("SELECT has_table_privilege($1,'public.crm_dash_chave','SELECT') AS s,has_table_privilege($1,'public.crm_dash_chave','INSERT') AS i,has_table_privilege($1,'public.crm_dash_chave','UPDATE') AS u,has_table_privilege($1,'public.crm_dash_chave','DELETE') AS d",[OWNER])).rows[0],{s:true,i:true,u:true,d:false});
  assert.deepEqual((await db.query("SELECT has_table_privilege($1,'public.shrigma_panel_permission_v1','SELECT') AS s,has_table_privilege($1,'public.shrigma_panel_permission_v1','INSERT') AS i,has_table_privilege($1,'public.shrigma_panel_permission_v1','UPDATE') AS u,has_table_privilege($1,'public.shrigma_panel_permission_v1','DELETE') AS d",[OWNER])).rows[0],{s:true,i:true,u:false,d:true});
  const columns=(await db.query("SELECT attname,has_column_privilege($1,attrelid,attname,'UPDATE') AS owner_update,has_column_privilege($2,attrelid,attname,'UPDATE') AS service_update FROM pg_attribute WHERE attrelid='public.shrigma_panel_permission_v1'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum",[OWNER,SERVICE])).rows;
  columns.forEach(c=>{assert.equal(c.owner_update,c.attname==='principal_id');assert.equal(c.service_update,false);});
  await asService(db,async()=>{
   for(const t of ['crm_dash_chave','shrigma_panel_permission_v1',...tables]){
    for(const privilege of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal((await db.query('SELECT has_table_privilege(session_user,$1,$2) AS allowed',['public.'+t,privilege])).rows[0].allowed,false);
    await assert.rejects(db.query('SELECT * FROM public.'+t),e=>e.code==='42501');
   }
   for(const signature of ['prepare_v1(jsonb)','commit_v1(jsonb)','revoke_v1(jsonb)','status_v1(jsonb)'])assert.equal((await db.query("SELECT has_function_privilege(session_user,$1,'EXECUTE') AS allowed",['public.shrigma_crm_manager_'+signature])).rows[0].allowed,true);
   for(const signature of ['canonical_v1(jsonb)','error_v1(jsonb,uuid,uuid,text)','apply_v1(jsonb,text)'])assert.equal((await db.query("SELECT has_function_privilege(session_user,$1,'EXECUTE') AS allowed",['public.shrigma_crm_manager_'+signature])).rows[0].allowed,false);
   await assert.rejects(db.query('CREATE TABLE public.forbidden_positive_fixture(id int)'),e=>e.code==='42501');
  });
  const delta=(await db.query("SELECT g.tgisinternal,g.tgenabled,g.tgdeferrable,g.tginitdeferred,g.tgtype,p.proname,c.conrelid='public.shrigma_crm_manager_generation_v1'::regclass AS new_fk FROM pg_trigger g JOIN pg_constraint c ON c.oid=g.tgconstraint JOIN pg_proc p ON p.oid=g.tgfoid WHERE g.tgrelid='public.crm_dash_chave'::regclass AND c.conrelid='public.shrigma_crm_manager_generation_v1'::regclass ORDER BY p.proname")).rows;
  assert.deepEqual(delta,[{tgisinternal:true,tgenabled:'O',tgdeferrable:false,tginitdeferred:false,tgtype:9,proname:'RI_FKey_noaction_del',new_fk:true},{tgisinternal:true,tgenabled:'O',tgdeferrable:false,tginitdeferred:false,tgtype:17,proname:'RI_FKey_noaction_upd',new_fk:true}]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='public.crm_dash_chave'::regclass")).rows[0].n,4);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='public.shrigma_panel_permission_v1'::regclass")).rows[0].n,2);
  assert.equal((await db.query("SELECT current_setting('transaction_read_only')='off' AS clean")).rows[0].clean,true);
}
module.exports={source,sha,OWNER,SERVICE,tables,clientConfig,createNativeFixture,legacySnapshot,scope,flattenRows,assertInstalled};
