'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const Performance=require('../n8n/growth/ses-health-performance.cjs');
const fixture=fs.readFileSync(path.join(__dirname,'fixtures/ses-health-live-20260928.sql'),'utf8');
const liveDefinition=fs.readFileSync(path.join(__dirname,'fixtures/ses-health-definition-20260928.sql'),'utf8');
const checkedMigration=fs.readFileSync(path.join(__dirname,'../n8n/growth/ses-health-performance.sql'),'utf8');
const withoutCheckedAt=value=>{const copy=structuredClone(value);delete copy.checked_at;return copy;};
const payload=async(db,view)=>(await db.query(`SELECT payload FROM ${view}`)).rows[0].payload;
const byBrand=(value,brand)=>value.brands.find(x=>x.marca===brand);
const sha=value=>createHash('sha256').update(value).digest('hex');
const viewState=async db=>(await db.query(`SELECT pg_catalog.pg_get_userbyid(c.relowner) owner,
 c.relacl::text acl,pg_catalog.pg_get_viewdef(c.oid,true) definition
 FROM pg_catalog.pg_class c WHERE c.oid='public.shrigma_growth_email_ses_health_v1'::regclass`)).rows[0];

test('candidate-first SES health definition preserves the complete live payload',async t=>{
 assert.ok(liveDefinition,'public SES health view snapshot is required');
 const candidate=Performance.patchDefinition(liveDefinition);
 assert.equal(candidate.view,'public.shrigma_growth_email_ses_health_v1');
 assert.equal(candidate.source_sha256,'039880495056b8e0d52ccdee53d42e47d852a5fc3e9f903ee427736d8075e260');
 assert.equal(candidate.patched_sha256,'2dbd6eb1250748cdd13c0b6f8487c7651623ed39a35aa972351a09390242beed');
 assert.equal(candidate.transport_changes,false);

 const db=new PGlite();t.after(()=>db.close());
 await db.exec('BEGIN');
 await db.exec(fixture);
 await db.exec(`CREATE VIEW public.ses_health_baseline AS ${liveDefinition}`);
 await db.exec(`CREATE VIEW public.ses_health_candidate AS ${candidate.definition}`);
 // The observed live baseline emits VALUES order. PGlite otherwise selects a
 // merge join and demonstrates the exact ordering regression fixed by the patch.
 await db.exec('SET enable_mergejoin=off');
 const baseline=await payload(db,'public.ses_health_baseline');
 const proposed=await payload(db,'public.ses_health_candidate');
 assert.deepEqual(withoutCheckedAt(proposed),withoutCheckedAt(baseline));

 assert.equal(baseline.schema_version,1);
 assert.equal(baseline.pending_ingest_15min,1);
 assert.equal(baseline.conflicts,1);
 assert.deepEqual(baseline.collector,{
  last_poll_ok_at:baseline.collector.last_poll_ok_at,last_poll_count:7,
  last_error_at:baseline.collector.last_error_at,last_error_code:'FIXTURE_ERROR'
 });
 assert.deepEqual({visible:baseline.queue.visible,inflight:baseline.queue.inflight,delayed:baseline.queue.delayed},{visible:11,inflight:2,delayed:3});
 assert.deepEqual(byBrand(baseline,'fish'),{
  marca:'fish',finalizacao_pendente:1,entregue_sem_gravacao:2,resultado_incerto:1,
  sem_confirmacao_15min:3,falhas_24h:2,reclamacoes_24h:1
 });
 assert.deepEqual(byBrand(baseline,'aristo'),{
  marca:'aristo',finalizacao_pendente:1,entregue_sem_gravacao:0,resultado_incerto:1,
  sem_confirmacao_15min:1,falhas_24h:2,reclamacoes_24h:1
 });
 assert.deepEqual(byBrand(baseline,'olivas'),{
  marca:'olivas',finalizacao_pendente:1,entregue_sem_gravacao:1,resultado_incerto:1,
  sem_confirmacao_15min:0,falhas_24h:1,reclamacoes_24h:0
 });

 // The live predicate is strict at 24 hours. This assertion is evaluated in
 // the transaction that seeded now(), so the exact-boundary bounce is excluded
 // while the dispatch one second inside the window is counted.
 assert.equal(byBrand(baseline,'fish').falhas_24h,2);
 await db.exec('COMMIT');

 await db.exec("DELETE FROM public.shrigma_email_consumer_health WHERE key='ses-events'");
 await db.exec('BEGIN');
 const noHealthBaseline=await payload(db,'public.ses_health_baseline');
 const noHealthProposed=await payload(db,'public.ses_health_candidate');
 assert.deepEqual(withoutCheckedAt(noHealthProposed),withoutCheckedAt(noHealthBaseline));
 assert.deepEqual(noHealthBaseline.collector,{last_poll_ok_at:null,last_poll_count:null,last_error_at:null,last_error_code:null});
 assert.deepEqual(noHealthBaseline.queue,{checked_at:null,visible:null,inflight:null,delayed:null,error_at:null});
 await db.exec('ROLLBACK');
});

test('guarded migration replaces the exact public baseline and preserves owner and ACL',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(fixture);
 const candidate=Performance.patchDefinition(liveDefinition);
 await db.exec(`CREATE VIEW public.ses_health_expected_candidate AS ${candidate.definition}`);
 const expectedDefinition=(await db.query("SELECT pg_catalog.pg_get_viewdef('public.ses_health_expected_candidate'::regclass,true) definition")).rows[0].definition;
 await db.exec('CREATE ROLE ses_health_owner NOLOGIN; CREATE ROLE ses_health_reader NOLOGIN');
 await db.exec(`CREATE VIEW public.shrigma_growth_email_ses_health_v1 AS ${liveDefinition}`);
 await db.exec(`GRANT SELECT ON public.shrigma_email_dispatch,public.shrigma_email_coverage,
  public.shrigma_email_status,public.shrigma_email_event_ingest,
  public.shrigma_email_consumer_health TO ses_health_owner`);
 await db.exec('ALTER VIEW public.shrigma_growth_email_ses_health_v1 OWNER TO ses_health_owner');
 await db.exec('GRANT SELECT ON public.shrigma_growth_email_ses_health_v1 TO ses_health_reader');
 await db.exec('SET enable_mergejoin=off');
 const beforeState=await viewState(db),beforePayload=await payload(db,'public.shrigma_growth_email_ses_health_v1');
 const migration=Performance.buildMigration(liveDefinition);
 assert.equal(migration,checkedMigration);

 await db.exec(migration);
 const afterState=await viewState(db),afterPayload=await payload(db,'public.shrigma_growth_email_ses_health_v1');
 assert.deepEqual(withoutCheckedAt(afterPayload),withoutCheckedAt(beforePayload));
 assert.equal(afterState.owner,beforeState.owner);
 assert.equal(afterState.acl,beforeState.acl);
 assert.deepEqual(afterPayload.brands.map(x=>x.marca),['fish','aristo','olivas']);
 const readbackSha=sha(afterState.definition);
 t.diagnostic(`pg_get_viewdef sha256 ${readbackSha}`);
 assert.equal(afterState.definition,expectedDefinition);

 await assert.rejects(db.exec(migration),/SES_HEALTH_SOURCE_DRIFT/);
 assert.equal((await viewState(db)).definition,afterState.definition);
});

test('guarded migration rejects a changed public baseline without overwriting it',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(fixture);
 const changed=`${liveDefinition.trim().replace(/;$/,'')}\nOFFSET 0`;
 await db.exec(`CREATE VIEW public.shrigma_growth_email_ses_health_v1 AS ${changed}`);
 const before=await viewState(db);
 assert.notEqual(sha(before.definition),Performance.SOURCE_SHA256);
 await assert.rejects(db.exec(Performance.buildMigration(liveDefinition)),/SES_HEALTH_SOURCE_DRIFT/);
 const after=await viewState(db);
 assert.deepEqual(after,before);
});
