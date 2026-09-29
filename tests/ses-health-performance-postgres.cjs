'use strict';
// Explicitly isolated PostgreSQL proof: migration, ACLs, drift and read-lock race.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{Client}=require('pg'),{createHash}=require('node:crypto');
const P=require('../n8n/growth/ses-health-performance.cjs'),root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const u=new URL(process.env.TEST_DATABASE_URL||'http://invalid');
if(process.env.CRM_HEALTH_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.port==='5432'||!u.port||u.pathname!=='/crm_growth_health_test')throw Error('ISOLATED_DATABASE_REQUIRED');
const args={connectionString:u.href,statement_timeout:10000},a=new Client(args),b=new Client(args),c=new Client(args);
const source=read('tests/fixtures/ses-health-definition-20260928.sql'),candidate=P.patchDefinition(source),migration=P.buildMigration(source);
const digest=s=>createHash('sha256').update(s).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{await a.connect();await b.connect();await c.connect();try{
 assert.equal((await a.query("SELECT current_setting('server_version_num') AS v")).rows[0].v,'170010');
 await a.query(read('tests/fixtures/ses-health-live-20260928.sql'));
 await a.query('CREATE VIEW public.shrigma_growth_email_ses_health_v1 AS '+source);
 await a.query('CREATE ROLE synthetic_health_reader NOLOGIN; GRANT SELECT ON public.shrigma_growth_email_ses_health_v1 TO synthetic_health_reader');
 const metadata=async()=> (await a.query("SELECT pg_get_viewdef(oid,true) AS definition,relowner,relacl::text AS acl FROM pg_class WHERE oid='public.shrigma_growth_email_ses_health_v1'::regclass")).rows[0];
 const before=await metadata();assert.equal(digest(before.definition),P.SOURCE_SHA256);
 const readLock='PERFORM 1 FROM public.shrigma_growth_email_ses_health_v1 LIMIT 0;';
 assert.equal(migration.split(readLock).length,2);
 const instrumented=migration.replace(readLock,readLock+"\n PERFORM pg_catalog.pg_sleep(2);");
 const migratorPid=(await a.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 await a.query('BEGIN');const held=a.query(instrumented);
 let locks=[];
 for(let i=0;i<100;i++){
  locks=(await b.query(`SELECT c.relname,l.mode,l.granted FROM pg_catalog.pg_locks l
   JOIN pg_catalog.pg_class c ON c.oid=l.relation WHERE l.pid=$1`,[migratorPid])).rows;
  if(locks.some(x=>x.relname==='shrigma_growth_email_ses_health_v1'&&x.mode==='AccessShareLock'&&x.granted))break;
  await pause(20);
 }
 assert.ok(locks.some(x=>x.relname==='shrigma_growth_email_ses_health_v1'&&x.mode==='AccessShareLock'&&x.granted));
 assert.ok(locks.some(x=>x.relname==='shrigma_email_dispatch'&&x.mode==='AccessShareLock'&&x.granted));
 await b.query("SET lock_timeout='500ms'");
 const ddl=b.query("ALTER VIEW public.shrigma_growth_email_ses_health_v1 SET (security_barrier=true)");
 const sourceWrite=c.query('UPDATE public.shrigma_email_dispatch SET brand=brand WHERE false');
 const [ddlResult,writeResult]=await Promise.allSettled([ddl,sourceWrite]);
 assert.equal(ddlResult.status,'rejected');assert.equal(ddlResult.reason.code,'55P03');
 assert.equal(writeResult.status,'fulfilled');assert.equal(writeResult.value.rowCount,0);
 await held;await a.query('ROLLBACK');assert.deepEqual(await metadata(),before);
 await a.query('BEGIN');await a.query('SELECT payload FROM public.shrigma_growth_email_ses_health_v1');
 await assert.rejects(b.query(migration),e=>e.code==='55P03');
 await a.query('ROLLBACK');assert.deepEqual(await metadata(),before);
 await a.query('BEGIN');
 const baseline=(await a.query('SELECT payload FROM public.shrigma_growth_email_ses_health_v1')).rows[0].payload;delete baseline.checked_at;
 await a.query(migration);
 const changed=(await a.query('SELECT payload FROM public.shrigma_growth_email_ses_health_v1')).rows[0].payload;delete changed.checked_at;
 assert.deepEqual(changed,baseline);
 const after=await metadata();assert.equal(after.relowner,before.relowner);assert.equal(after.acl,before.acl);
 await a.query('COMMIT');
 await assert.rejects(a.query(migration),e=>/SES_HEALTH_SOURCE_DRIFT/.test(e.message));assert.deepEqual(await metadata(),after);
 console.log(JSON.stringify({postgres:'17.10',candidate_sha256:candidate.patched_sha256,installed_definition_sha256:digest(after.definition),migration_sha256:digest(migration),payload_equal_except_checked_at:true,owner_preserved:true,acl_preserved:true,view_access_share_observed:true,concurrent_ddl_timeout_55P03:true,source_write_compatible:true,read_lock_timeout_55P03:true,drift_refused:true,sends:0,production_changes:0}));
}finally{await a.end();await b.end();await c.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
