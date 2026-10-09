'use strict';
// New v3 isolated PostgreSQL17 scenario only. No persistent data directory,
// production connection, replay of NextCampaigns or helper invocation.
const test=require('node:test'),a=require('node:assert/strict'),path=require('node:path');
const modulePath=process.env.CATALOG_PGLITE_MODULE;
test('v3 fixed dependency SQL resolves types worker ACL JSON shapes and bounded activity on isolated PostgreSQL17',{skip:!modulePath},async()=>{
 const {PGlite}=require(modulePath),C=require(path.join(process.env.SCHEDULER_STATE_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational'),'native-scheduler-state.cjs')),db=new PGlite();
 const sql=v=>{const guard="pg_catalog.current_database()='listmonk'";a.equal(v.split(guard).length,2);return v.replace(guard,"pg_catalog.current_database()='template1'");};
 try{
  await db.exec(`CREATE SCHEMA crm_audience_v2;
 CREATE TABLE crm_audience_v2.regular_worker_deployment(singleton boolean PRIMARY KEY,enabled boolean,worker_sha256 text,runtime_sha256 text,query_sha256 text,database_role name,approved_at timestamptz,approved_by text,topology_receipt_sha256 text);
 CREATE TABLE crm_audience_v2.regular_worker_lease(singleton boolean PRIMARY KEY,instance_id uuid,worker_sha256 text,runtime_sha256 text,database_role name,heartbeat_at timestamptz,expires_at timestamptz,suspended boolean,suspension_reason text);
 CREATE TABLE crm_audience_v2.selection_runtime(singleton boolean PRIMARY KEY,enabled boolean,candidate_query_sha256 text,verified_at timestamptz);
 CREATE ROLE isolated_worker;
 INSERT INTO crm_audience_v2.regular_worker_deployment VALUES(true,true,repeat('a',64),repeat('b',64),'${C.EXPECTED_SELECTION_QUERY}','isolated_worker',now(),'synthetic-fixture',repeat('c',64));
 INSERT INTO crm_audience_v2.regular_worker_lease VALUES(true,'a1111111-1111-4111-8111-111111111111',repeat('a',64),repeat('b',64),'isolated_worker',now(),now()+interval '1 minute',false,NULL);
 INSERT INTO crm_audience_v2.selection_runtime VALUES(true,true,'${C.EXPECTED_SELECTION_QUERY}',now());`);
  // Missing dependencies are returned as bounded metadata before shape SQL.
  let d=C.validateDependencies((await db.query(sql(C.DEPENDENCY_SQL))).rows[0].payload);a.equal(d.workerRoleKnown,true);a.equal(C.shapesGate(d),'relation-missing');a(d.functions.every(f=>!f.present));
  const type=t=>typeof t==='number'?({16:'boolean',23:'integer',25:'text',1184:'timestamptz',2950:'uuid',3802:'jsonb'})[t]:t==='enum'?'text':'varchar(100)[]';
  for(const [name,cols] of Object.entries(C.SCANNER_COLUMNS))await db.exec('CREATE TABLE public.'+name+'('+Object.entries(cols).map(([n,t])=>n+' '+type(t)).join(',')+');');
  await db.exec(`CREATE TABLE crm_audience_v2.campaign_binding(cid integer);
 CREATE FUNCTION crm_audience_v2.selection_worker_context(integer) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$BEGIN RAISE EXCEPTION 'helper must never execute'; END$$;
 CREATE FUNCTION crm_audience_v2.selection_regular_matches(jsonb,integer) RETURNS boolean LANGUAGE plpgsql STABLE AS $$BEGIN RAISE EXCEPTION 'helper must never execute'; END$$;
 CREATE FUNCTION crm_audience_v2.campaign_binding_effective(integer) RETURNS SETOF crm_audience_v2.campaign_binding LANGUAGE plpgsql STABLE AS $$BEGIN RAISE EXCEPTION 'helper must never execute'; END$$;
 REVOKE ALL ON FUNCTION crm_audience_v2.selection_worker_context(integer),crm_audience_v2.selection_regular_matches(jsonb,integer),crm_audience_v2.campaign_binding_effective(integer) FROM PUBLIC;
 GRANT USAGE ON SCHEMA public,crm_audience_v2 TO isolated_worker;
 GRANT SELECT ON public.campaigns,public.templates,public.campaign_media,public.campaign_lists,public.lists,public.subscriber_lists,public.subscribers TO isolated_worker;
 GRANT UPDATE(sent,to_send,status,max_subscriber_id,started_at) ON public.campaigns TO isolated_worker;
 GRANT EXECUTE ON FUNCTION crm_audience_v2.selection_worker_context(integer),crm_audience_v2.selection_regular_matches(jsonb,integer),crm_audience_v2.campaign_binding_effective(integer) TO isolated_worker;`);
  d=C.validateDependencies((await db.query(sql(C.DEPENDENCY_SQL))).rows[0].payload);a.equal(C.shapesGate(d),'observed');a(d.relations.every(r=>r.columns.every(c=>c.typeCompatible&&c.workerSelect)));a(d.functions.every(f=>f.present&&f.signatureCompatible&&f.workerExecute));a.equal(d.functions.find(f=>f.name==='selection_worker_context').volatility,'volatile');
  // Fixture values are disposable. Only booleans/counts ever leave PG.
  const cols=['id','uuid','name','subject','from_email','body','content_type','headers','status','tags','type','messenger','sent','to_send','archive','attribs','send_at'];
  const put=async(id,attrs,headers,tags=['x'],extra={})=>{const values=[id,'11111111-1111-4111-8111-111111111111','fixture','fixture','fixture','fixture','html',JSON.stringify(headers),'scheduled',tags,'regular','smtp',0,1,false,JSON.stringify(attrs),'2020-01-01T00:00:00Z'];for(const [k,v] of Object.entries(extra))values[cols.indexOf(k)]=v;await db.query('INSERT INTO public.campaigns('+cols.join(',')+') VALUES('+values.map((_,i)=>'$'+(i+1)).join(',')+')',values);};
  await put(171,{},[{'X-Shape':'value'},null,{'X-Null':null}]);await put(174,[],{'X-Bad':'shape'},[null]);await put(175,null,null,null);await put(176,{},[{'X-Number':1}]);await put(177,{},[],[],{body:null});await put(178,{},[],[],{send_at:'infinity'});
  await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
   C.validateCatalog((await db.query(sql(C.CATALOG_SQL))).rows);a.equal(C.validateState((await db.query(sql(C.READ_SQL))).rows[0].payload).runtimeMeasured,false);
   d=C.validateDependencies((await db.query(sql(C.DEPENDENCY_SQL))).rows[0].payload);
   let s=C.validateShapes((await db.query(sql(C.SHAPES_SQL))).rows[0].payload);a.equal(s.observedCount,5);a.equal(s.dueCount,5);a.equal(s.attribsTopLevelIncompatible,1);a.equal(s.headersIncompatible,2);a.equal(s.tagsIncompatible,1);a.equal(s.scalarNullIncompatible,1);a.equal(s.targets.find(t=>t.id===171).headersCompatible,true);a.equal(s.targets.find(t=>t.id===174).headersCompatible,false);a.equal(s.helperContextEvaluated,false);a(!JSON.stringify(s).includes('X-Shape'));
   // No helper can have been invoked: every helper raises unconditionally.
   const act=C.validateActivity((await db.query(sql(C.ACTIVITY_SQL))).rows[0].payload);a.equal(act.connectionCount,0);a.equal(act.scannerPrefixMatchCount,0);a.equal(act.maxPrefixAgeSeconds,null);
  }finally{await db.exec('ROLLBACK');}
  // Fixed type/schema/worker-ACL changes are observed, not repaired.
  await db.exec('REVOKE SELECT ON public.subscribers FROM isolated_worker; REVOKE UPDATE(status) ON public.campaigns FROM isolated_worker; REVOKE EXECUTE ON FUNCTION crm_audience_v2.selection_regular_matches(jsonb,integer) FROM isolated_worker;');
  d=C.validateDependencies((await db.query(sql(C.DEPENDENCY_SQL))).rows[0].payload);a(d.relations.find(r=>r.name==='subscribers').columns.every(c=>c.workerSelect===false));a.equal(d.relations.find(r=>r.name==='campaigns').columns.find(c=>c.name==='status').workerUpdate,false);a.equal(d.functions.find(f=>f.name==='selection_regular_matches').workerExecute,false);
  await db.exec("UPDATE crm_audience_v2.regular_worker_deployment SET database_role='nonexistent_fixture_role';");d=C.validateDependencies((await db.query(sql(C.DEPENDENCY_SQL))).rows[0].payload);a.equal(d.workerRoleKnown,false);a(d.functions.every(f=>f.workerExecute===null));a(d.relations.every(r=>r.columns.every(c=>c.workerSelect===null)));a.equal(d.activityCapability.visible,false);
  await db.exec("UPDATE crm_audience_v2.regular_worker_deployment SET database_role='isolated_worker'; ALTER TABLE public.campaigns ALTER COLUMN headers TYPE text USING headers::text;");d=C.validateDependencies((await db.query(sql(C.DEPENDENCY_SQL))).rows[0].payload);a.equal(C.shapesGate(d),'schema-incompatible');
  await db.exec("ALTER TABLE public.campaigns ALTER COLUMN headers TYPE jsonb USING headers::jsonb;");
  await put(179,{},[{'Long':'x'.repeat(65536)}]);let s=C.validateShapes((await db.query(sql(C.SHAPES_SQL))).rows[0].payload);a.equal(s.headersUnknown,1);
  await db.exec("INSERT INTO public.campaigns(id,uuid,name,subject,from_email,body,content_type,headers,status,tags,type,messenger,sent,to_send,archive,attribs,send_at) SELECT g,'11111111-1111-4111-8111-111111111111','fixture','fixture','fixture','fixture','html','[]'::jsonb,'scheduled',ARRAY[]::varchar(100)[],'regular','smtp',0,1,false,'{}'::jsonb,now()-interval '1 day' FROM generate_series(200,1200) g;");
  s=C.validateShapes((await db.query(sql(C.SHAPES_SQL))).rows[0].payload);a.equal(s.truncated,true);a.equal(s.observedCount,1000);a.equal(s.targets[0].id,171);a.equal(s.targets[1].id,174);
  // Column ACLs cover extra camps.* columns although Unsafe ignores unmapped names.
  await db.exec('ALTER TABLE public.campaigns ADD COLUMN ignored_extra text; REVOKE SELECT ON public.campaigns FROM isolated_worker; GRANT SELECT('+Object.keys(C.SCANNER_COLUMNS.campaigns).join(',')+') ON public.campaigns TO isolated_worker;');
  d=C.validateDependencies((await db.query(sql(C.DEPENDENCY_SQL))).rows[0].payload);a.equal(d.relations.find(r=>r.name==='campaigns').allCampaignColumnsSelect,false);a(d.relations.find(r=>r.name==='campaigns').columns.every(c=>c.workerSelect));
  // Wrong result cardinality/signature is metadata, never a helper probe.
  await db.exec('DROP FUNCTION crm_audience_v2.selection_worker_context(integer); CREATE FUNCTION crm_audience_v2.selection_worker_context(integer) RETURNS SETOF jsonb LANGUAGE plpgsql STABLE AS $$BEGIN RAISE EXCEPTION \'never execute\'; END$$;');
  d=C.validateDependencies((await db.query(sql(C.DEPENDENCY_SQL))).rows[0].payload);a.equal(d.functions.find(f=>f.name==='selection_worker_context').signatureCompatible,false);
 }finally{await db.close();}
});
