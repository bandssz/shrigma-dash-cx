 'use strict';
// Prepared only: requires Root's existing EMPTY disposable fixture database.
// Creates no database/server and refuses original names/ports. Never run on live SQL.
const {test}=require('node:test'),a=require('node:assert/strict');
const enabled=process.env.BOUNDED_NATIVE_FIXTURE_ISOLATED==='1';
test('PG17.10 two-connection boundary: unowned writes pass, control/status phantom writers block, same-op commit is coherent',async()=>{
 a.equal(enabled,true,'Explicit disposable native fixture opt-in required; no skip acceptance');
 const u=new URL(process.env.BOUNDED_NATIVE_FIXTURE_URL||'http://invalid');
 a.equal(u.protocol,'postgresql:');a.equal(u.hostname,'127.0.0.1');a.equal(u.pathname,'/bounded_transition_fixture');a(u.port&&u.port!=='5432');a.equal(u.username,'postgres');a.equal(u.password,'');
 a.equal(process.version,'v22.23.3');a.equal(process.getuid(),1000);a.equal(process.platform,'linux');a.equal(process.arch,'x64');
 a.equal(require('pg/package.json').version,'8.23.1');
 const {Client}=require('pg'),F=require('./bounded-fixtures.cjs'),left=new Client({connectionString:u.href}),right=new Client({connectionString:u.href});
 let inTransaction=false,proofIdentities;
 try{
  await left.connect();await right.connect();
  a.equal((await left.query("SELECT current_setting('server_version_num')::integer AS v")).rows[0].v,170010);
  a.equal((await left.query('SELECT session_user AS role')).rows[0].role,'postgres');
  a.equal((await left.query("SELECT count(*)::int n FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND relkind IN('r','p')")).rows[0].n,0);
  const db={exec:s=>left.query(s),query:(s,p)=>left.query(s,p)};
  await F.initialize(db);await db.exec(`DELETE FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=173; UPDATE crm_audience_v2.regular_delivery_campaign SET enabled=false WHERE campaign_id=175; INSERT INTO crm_audience_v2.campaign_binding_revision VALUES(173,1,'{"synthetic":"released-historical"}');`);
  const legacySql="SELECT jsonb_build_object('campaign',(SELECT to_jsonb(c) FROM public.campaigns c WHERE id=173),'history',(SELECT jsonb_agg(to_jsonb(h)) FROM crm_audience_v2.campaign_binding_revision h WHERE campaign_id=173),'controls',(SELECT count(*) FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=173)) AS legacy";
  const legacyBefore=(await db.query(legacySql)).rows[0].legacy;
  const before=await F.snapshot(db),prepared=F.B.prepare(F.request()),env=F.envelope(prepared,before),steps=prepared.transactionStatements;
  {const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),dir=path.resolve(__dirname,'../../tools/listmonk-regular-build/coherent-transition'),digest=n=>crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,n))).digest('hex');proofIdentities={builderSha256:digest('builder.cjs'),templatesSha256:digest('templates.cjs'),sourceBundleSha256:digest('source-bundle.json'),nativeBoundarySha256:digest('native-boundary.sql'),sourceInputPins:F.request().sourceInputs.map(x=>({logicalPath:x.path,bytes:x.bytes,sha256:x.sha256})),syntheticTransitionStatementSha256:prepared.transactionSqlSha256};}
  await left.query(steps[0]);inTransaction=true;await left.query(steps[1]);await left.query(steps[2]);await left.query(steps[3],[env]);
  const marker=" SELECT jsonb_build_object(\n 'serverVersionNum'",cut=steps[4].indexOf(marker);a(cut>0);
  // Execute the actual generated admission+lock prefix without mutation, then
  // drive genuinely separate-session writers before the exact atomic statement.
  await left.query(steps[4].slice(0,cut)+'\nEND $coherent_transition$;');
  await right.query("SET statement_timeout='250ms'; SET lock_timeout='100ms'");
  await right.query("UPDATE public.templates SET body='concurrent template'; UPDATE public.campaigns SET body='concurrent third party' WHERE id=999");
  await a.rejects(right.query('UPDATE crm_audience_v2.regular_delivery_campaign SET enabled=true WHERE campaign_id=175'),e=>e.code==='55P03');
  await a.rejects(right.query("UPDATE public.campaigns SET status='scheduled' WHERE id=881"),e=>e.code==='55P03');
  await left.query(steps[4]);const after=await F.snapshot(db);a.deepEqual(after.ownedActiveCampaignIds,[171,172,174]);a.deepEqual(after.ownedRowState,before.ownedRowState);a.deepEqual(after.lease,before.lease);a.deepEqual(after.selectionRuntime,before.selectionRuntime);a.equal(after.function.oid,before.function.oid);a.deepEqual(after.function.proacl,before.function.proacl);a.deepEqual((await db.query(legacySql)).rows[0].legacy,legacyBefore);await left.query(steps[6]);await left.query(steps[7]);inTransaction=false;
  a.equal((await right.query('SELECT body FROM public.templates')).rows[0].body,'concurrent template');a.equal((await right.query('SELECT body FROM public.campaigns WHERE id=999')).rows[0].body,'concurrent third party');
 }finally{
  let rollbackError;try{if(inTransaction)await left.query('ROLLBACK');}catch(e){rollbackError=e;}
  const ended=await Promise.allSettled([right.end(),left.end()]);
  if(rollbackError||ended.some(r=>r.status!=='fulfilled'))throw Error('DISPOSABLE_CLIENT_CLEANUP_NOT_CONFIRMED');
 }
 const fs=require('node:fs'),path=require('node:path'),receipt=process.env.BOUNDED_NATIVE_TEST_RECEIPT;
 a(receipt&&path.isAbsolute(receipt)&&!fs.existsSync(receipt),'Fresh absolute fixture receipt required');
 fs.writeFileSync(receipt,JSON.stringify({...proofIdentities,schema:'shrigma-portable-transition-native-fixture-v1',purpose:'synthetic-two-connection-transition',synthetic:true,scenariosPassed:true,accepted:false,status:'CLIENTS_ENDED_SERVER_END_PENDING',postgresVersion:'17.10',nodeVersion:process.version,uid:process.getuid(),pgVersion:'8.23.1',clientsEnded:true,fixtureServerEnded:false,originalPerformanceAccepted:false,originalAuthorityAccepted:false,originalOperational:false,originalDispatchProved:false},null,2)+'\n');
});
