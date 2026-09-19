/* Real isolated PostgreSQL: upgrade existing functions, preserve guards/audit, race preconditions. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
(async()=>{
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite();
 try{
  const store=read('n8n/growth/campaign-store.sql'),provider=read('n8n/growth/campaign-provider.sql');
  // Reconstitute the already-installed pre-cancellation release without removing any other guard.
  const priorStore=store.replaceAll("'agendar','cancelar'","'agendar'");
  const start=provider.indexOf(" IF a='cancel' THEN"),end=provider.indexOf(" IF c.status::text<>'draft'",start);
  assert.ok(start>0&&end>start);
  const priorProvider=(provider.slice(0,start)+provider.slice(end)).replace("'update','schedule','cancel'","'update','schedule'").replace(" WHEN a='cancel' THEN 'cancelar'",'');
  await db.exec(read('tests/campaign-provider-schema.sql'));await db.exec(priorStore);await db.exec(priorProvider);await db.exec(read('n8n/growth/campaign-write-guard.sql'));
  await db.exec("INSERT INTO shrigma_campaign_operation(actor,operation_key,request_hash,brand,action) VALUES('prior','prior-uncertain-key','"+'a'.repeat(64)+"','fish','salvar')");
  const guards=async()=>JSON.stringify((await db.query("SELECT tgname,pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname")).rows);
  const beforeGuards=await guards(),beforeAudit=(await db.query('SELECT * FROM shrigma_campaign_operation')).rows;
  const migration=read('n8n/growth/campaign-cancel.sql');await db.exec(migration);await db.exec(migration);
  assert.equal(await guards(),beforeGuards);assert.deepEqual((await db.query('SELECT * FROM shrigma_campaign_operation')).rows,beforeAudit);
  const call=async(action,p)=>(await db.query('SELECT shrigma_campaign_provider($1::text,$2::jsonb) AS r',[action,JSON.stringify(p)])).rows[0].r;
  const claim=async(key,brand='fish')=>(await db.query("SELECT shrigma_campaign_store('claim',$1::jsonb) AS r",[JSON.stringify({actor:'cancel-test',key,hash:'b'.repeat(64),brand,action:'cancelar'})])).rows[0].r;
  const c=await call('get',{id:100}),op=await claim('cancel-isolated-0001');
  await assert.rejects(call('cancel',{id:100,expectedVersion:c.version,operationId:op.id}),/CAMPAIGN_LOCKED/);
  async function state(status,sent=0,started=null,future=true){
   await db.exec('BEGIN');await db.query("SELECT set_config('shrigma.campaign_writer','100',true)");
   await db.query("UPDATE campaigns SET status=$1,sent=$2,started_at=$3::timestamptz,send_at=clock_timestamp()+CASE WHEN $4 THEN interval '1 day' ELSE interval '-1 minute' END WHERE id=100",[status,sent,started,future]);await db.exec('COMMIT');
  }
  for(const [status,sent,started,future] of [['running',0,null,true],['scheduled',1,null,true],['scheduled',0,'2026-01-01T00:00:00Z',true],['scheduled',0,null,false],['cancelled',0,null,true]]){
   await state(status,sent,started,future);const row=await call('get',{id:100});
   await assert.rejects(call('cancel',{id:100,expectedVersion:row.version,operationId:op.id}),/CAMPAIGN_LOCKED/);
  }
  await state('scheduled');const scheduled=await call('get',{id:100});
  await assert.rejects(call('cancel',{id:100,expectedVersion:'stale',operationId:op.id}),/VERSION_CONFLICT/);
  const wrong=await claim('cancel-isolated-brand','aristo');
  await assert.rejects(call('cancel',{id:100,expectedVersion:scheduled.version,operationId:wrong.id}),/CAMPAIGN_SCOPE/);
  const cancelled=await call('cancel',{id:100,expectedVersion:scheduled.version,operationId:op.id});
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.sent,0);assert.equal(cancelled.started_at,null);assert.equal(cancelled.send_at,scheduled.send_at);assert.notEqual(cancelled.version,scheduled.version);
  assert.equal(await guards(),beforeGuards);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM shrigma_campaign_operation WHERE id=$1",[op.id])).rows[0].n,1);
  await assert.rejects(call('cancel',{id:100,expectedVersion:scheduled.version,operationId:op.id}),/VERSION_CONFLICT/);
  // An unexpected installation must fail rather than silently replacing its constraint.
  await db.exec("ALTER TABLE shrigma_campaign_operation DROP CONSTRAINT shrigma_campaign_operation_action_check; ALTER TABLE shrigma_campaign_operation ADD CONSTRAINT shrigma_campaign_operation_action_check CHECK(action IN ('salvar','validar','agendar','cancelar','unexpected'))");
  await assert.rejects(db.exec(migration),/CANCEL_ACTION_CONSTRAINT_DRIFT/);await db.exec('ROLLBACK');
  console.log('PASS cancellation upgrade/idempotence, original reservations and six guards, version/brand/state/date/worker preconditions; zero transport.');
 }finally{await db.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
