/* Isolated PostgreSQL engine: no network, credentials, real campaigns or sends.
   PGlite is a single connection; this does not claim a live worker race proof. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const {createService,hash}=require('../n8n/growth/campaign-service');
const {createStore}=require('../n8n/growth/campaign-store');
const {createProvider}=require('../n8n/growth/campaign-provider');
const AUTH={actor:'atomic-fixture',caps:['read_content','submit']};
const migration=read('n8n/growth/campaign-atomic-receipt.sql');
const provider=read('tests/fixtures/campaign-provider-pre-audience.sql');
const cancelStart=provider.indexOf('  -- CAMPAIGN_ATOMIC_CANCEL_RECEIPT_V1:'),cancelEnd=provider.indexOf('  RETURN current_row;',cancelStart)+'  RETURN current_row;'.length;
const scheduleStart=provider.indexOf(' current_row:=public.shrigma_campaign_current(c.id);\n IF a=\'schedule\' THEN\n  -- CAMPAIGN_ATOMIC_SCHEDULE_RECEIPT_V1:'),scheduleEnd=provider.indexOf(' RETURN current_row;',scheduleStart)+' RETURN current_row;'.length;
assert.ok(cancelStart>0&&cancelEnd>cancelStart&&scheduleStart>cancelEnd&&scheduleEnd>scheduleStart,'recognized public receipt blocks');
// Reconstitute the prior public implementation from the current public source.
// No production exports or private snapshots are dependencies of this test.
const prior=provider.slice(0,cancelStart)+
 '  UPDATE public.shrigma_campaign_operation SET provider_id=c.id,updated_at=clock_timestamp() WHERE id=op.id;\n  PERFORM set_config(\'shrigma.campaign_writer\',coalesce(previous_writer,\'\'),true);\n  RETURN public.shrigma_campaign_current(c.id);'+
 provider.slice(cancelEnd,scheduleStart)+
 ' UPDATE public.shrigma_campaign_operation SET provider_id=c.id,updated_at=clock_timestamp() WHERE id=op.id;\n PERFORM set_config(\'shrigma.campaign_writer\',coalesce(previous_writer,\'\'),true);\n RETURN public.shrigma_campaign_current(c.id);'+provider.slice(scheduleEnd);
assert.ok(!prior.includes('CAMPAIGN_ATOMIC_'));

(async()=>{
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
 for(const install of ['upgrade','fresh']){
  const db=new PGlite();
  try{
   await db.exec(read('tests/campaign-provider-schema.sql'));
   await db.exec("UPDATE campaigns SET body='<p>Fixture</p>{{ UnsubscribeURL }}',altbody='Fixture {{ UnsubscribeURL }}'; INSERT INTO crm_familia_campanha(marca,utm_campaign,familia) VALUES('fish','week','week')");
   await db.exec(read('n8n/growth/campaign-store.sql'));await db.exec(install==='upgrade'?prior:provider);await db.exec(read('n8n/growth/campaign-write-guard.sql'));
   await db.exec(`INSERT INTO shrigma_campaign_operation(actor,operation_key,request_hash,brand,action,state,provider_id,response)
    VALUES('legacy','legacy-schedule-pending','${'a'.repeat(64)}','fish','agendar','pending',100,NULL),
    ('legacy','legacy-cancel-uncertain','${'b'.repeat(64)}','fish','cancelar','outcome_unknown',100,'{"status":502,"body":{"error":"OUTCOME_UNKNOWN"}}')`);
   const audit=async()=>JSON.stringify((await db.query("SELECT * FROM shrigma_campaign_operation WHERE actor='legacy' ORDER BY operation_key")).rows);
   const guards=async()=>JSON.stringify((await db.query("SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname")).rows);
   const oldAudit=await audit(),oldGuards=await guards();assert.equal(JSON.parse(oldGuards).length,6);
   await db.exec(migration);await db.exec(migration);
   await db.exec(read('n8n/growth/campaign-audience.sql'));await db.exec(read('n8n/growth/campaign-audience.sql'));
   assert.equal(await audit(),oldAudit,'migration cannot reinterpret old pending/uncertain operations');assert.equal(await guards(),oldGuards,'six guards preserved');
   const installed=(await db.query("SELECT prosrc FROM pg_proc WHERE oid='shrigma_campaign_provider(text,jsonb)'::regprocedure")).rows[0].prosrc;
   for(const marker of ['CAMPAIGN_ATOMIC_SCHEDULE_RECEIPT_V1','CAMPAIGN_ATOMIC_CANCEL_RECEIPT_V1'])assert.equal(installed.split(marker).length-1,1);
   const reviewIds=new Map();
   const call=async(action,p)=>(await db.query('SELECT shrigma_campaign_provider($1::text,$2::jsonb) AS r',[action,JSON.stringify(action==='schedule'?{audienceReviewId:reviewIds.get(p.id),...p}:p)])).rows[0].r;
   const store=async(action,p)=>(await db.query('SELECT shrigma_campaign_store($1::text,$2::jsonb) AS r',[action,JSON.stringify(p)])).rows[0].r;
   async function fixture(id,status='draft',changes={}){
    await db.query(`INSERT INTO campaigns(id,name,subject,from_email,body,altbody,content_type,headers,status,tags,type,messenger,template_id,sent,attribs,send_at)
     SELECT $1,name,subject,from_email,body,altbody,content_type,headers,'draft',tags,type,messenger,template_id,0,attribs,NULL FROM campaigns WHERE id=100`,[id]);
    {
     await db.exec('BEGIN');await db.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(id)]);
     await db.query("INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES($1,3,'Fish')",[id]);
     await db.query("UPDATE campaigns SET status=$2,sent=$3,started_at=$4::timestamptz,send_at=clock_timestamp()+($5::int*interval '1 minute') WHERE id=$1",[id,status,changes.sent??0,changes.started_at??null,changes.minutes??1440]);await db.exec('COMMIT');
    }
    const c=await call('get',{id});
    if(status==='draft'){const v=(await db.query('SELECT fixture_audience_review($1) AS v',[id])).rows[0].v;reviewIds.set(id,v.audience.review_id);}return c;
   }
   const command=(action,c,key)=>({acao:'campanha_'+action,brand:'fish',id:c.id,expected_version:c.version,confirm:action,...(action==='agendar'?{audience_review_id:reviewIds.get(c.id)}:{}),idempotency_key:key});
   const claim=req=>store('claim',{actor:AUTH.actor,key:req.idempotency_key,hash:hash(req),brand:req.brand,action:req.acao.replace('campanha_','')});
   const get=req=>store('get',{actor:AUTH.actor,key:req.idempotency_key});
   const noop=async()=>{throw Error('Unexpected native transport');};
   function service(query){return createService({store:createStore({query}),provider:createProvider({query,nativeCreate:noop,validateContent:noop})});}
   let id=300;
   for(const action of ['agendar','cancelar']){
    const native=action==='agendar'?'schedule':'cancel',beforeStatus=action==='agendar'?'draft':'scheduled',afterStatus=action==='agendar'?'scheduled':'cancelled';
    // Process crash: SQL commits, the process never attempts finish. A new
    // process polls/replays the same operation without another provider write.
    let c=await fixture(id++,beforeStatus),req=command(action,c,'atomic-crash-'+action+'-001'),op=await claim(req);
    const changed=await call(native,{id:c.id,expectedVersion:c.version,operationId:op.id});
    const completed=await get(req),receipt={status:200,body:{campaign:Object.fromEntries(Object.entries(changed).filter(([k])=>k!=='audience')),operation_id:op.id,...(action==='agendar'?{audience:changed.audience}:{})}};
    assert.equal(completed.state,'succeeded');assert.equal(completed.providerId,c.id);assert.deepEqual(completed.response,receipt);assert.equal(changed.status,afterStatus);
    assert.equal(changed.sent,0);assert.equal(changed.started_at,null);assert.equal(changed.send_at,c.send_at);assert.notEqual(changed.version,c.version);assert.ok(!Object.hasOwn(completed,'lease'));
    let providerReads=0;
    const replayService=service(async(q,p)=>{if(q.includes('shrigma_campaign_provider')){providerReads++;throw Error('Replay must use receipt');}return db.query(q,p);});
    assert.deepEqual(await replayService.handle(AUTH,req),receipt);assert.equal(providerReads,0);
    const polled=await replayService.handle(AUTH,{acao:'campanha_operacao',brand:'fish',idempotency_key:req.idempotency_key});assert.deepEqual(polled.body.operation.response,receipt);
    assert.deepEqual(await store('finish',{id:op.id,lease:op.lease,state:'succeeded',providerId:c.id,response:receipt}),{ok:true});
    await assert.rejects(store('finish',{id:op.id,lease:op.lease,state:'outcome_unknown',providerId:c.id,response:{status:502,body:{error:'OUTCOME_UNKNOWN'}}}),/CAMPAIGN_STORE_FINALIZED/);
    await assert.rejects(store('finish',{id:op.id,lease:op.lease,state:'succeeded',providerId:c.id,response:{...receipt,body:{...receipt.body,extra:'different'}}}),/CAMPAIGN_STORE_FINALIZED/);
    await assert.rejects(call(native,{id:c.id,expectedVersion:c.version,operationId:op.id}),/CAMPAIGN_OPERATION_INVALID/);
    assert.deepEqual((await get(req)).response,receipt);assert.equal((await get(req)).state,'succeeded');

    // A transport error after the SQL statement committed runs the original
    // service catch path. Its attempted uncertain finish cannot erase success.
    c=await fixture(id++,beforeStatus);req=command(action,c,'atomic-timeout-'+action+'-001');let writes=0;
    const withLostReceipt=service(async(q,p)=>{const r=await db.query(q,p);if(q.includes('shrigma_campaign_provider')&&p[0]===native){writes++;throw Error('Fixture: provider response lost after commit');}return r;});
    const uncertain=await withLostReceipt.handle(AUTH,req);assert.equal(uncertain.status,502);assert.equal(uncertain.body.error,'OUTCOME_UNKNOWN');
    const durable=await get(req);assert.equal(durable.state,'succeeded');assert.equal(durable.response.body.campaign.status,afterStatus);
    assert.deepEqual(await withLostReceipt.handle(AUTH,req),durable.response);assert.equal(writes,1);
    const conflict=await withLostReceipt.handle(AUTH,{...req,expected_version:'different'});assert.equal(conflict.body.error,'IDEMPOTENCY_CONFLICT');assert.equal(writes,1);

    // Trigger fires after the campaign status UPDATE and before receipt commit.
    // Raising here must roll both changes back and leave the existing claim.
    c=await fixture(id++,beforeStatus);req=command(action,c,'atomic-rollback-'+action+'-001');op=await claim(req);
    await db.exec(`CREATE FUNCTION fixture_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$
     DECLARE s text;BEGIN
      IF NEW.id='${op.id}'::uuid AND NEW.state='succeeded' THEN
       SELECT status INTO s FROM campaigns WHERE id=NEW.provider_id;
       IF s<>'${afterStatus}' THEN RAISE EXCEPTION 'FIXTURE_STATUS_NOT_CHANGED'; END IF;
       RAISE EXCEPTION 'FIXTURE_RECEIPT_FAILURE';
      END IF;RETURN NEW;END $$;
     CREATE TRIGGER fixture_receipt_failure BEFORE UPDATE ON shrigma_campaign_operation FOR EACH ROW EXECUTE FUNCTION fixture_receipt_failure()`);
    await assert.rejects(call(native,{id:c.id,expectedVersion:c.version,operationId:op.id}),/FIXTURE_RECEIPT_FAILURE/);
    assert.deepEqual(await call('get',{id:c.id}),c,'status and version roll back with receipt');
    const pending=await get(req);assert.equal(pending.state,'pending');assert.equal(pending.providerId,null);assert.equal(pending.response,null);
    await db.exec('DROP TRIGGER fixture_receipt_failure ON shrigma_campaign_operation; DROP FUNCTION fixture_receipt_failure()');
    assert.equal(await guards(),oldGuards);
   }
   // Guard failures cannot accidentally create a successful receipt.
   for(const spec of [
    {action:'agendar',status:'draft',version:'stale',error:/VERSION_CONFLICT/},
    {action:'agendar',status:'draft',invalidate:true,error:/VALIDATION_STALE/},
    {action:'agendar',status:'draft',minutes:5,error:/SCHEDULE_TOO_SOON/},
    {action:'cancelar',status:'draft',error:/CAMPAIGN_LOCKED/},
    {action:'cancelar',status:'scheduled',sent:1,error:/CAMPAIGN_LOCKED/},
    {action:'cancelar',status:'scheduled',started_at:'2026-01-01T00:00:00Z',error:/CAMPAIGN_LOCKED/},
    {action:'cancelar',status:'scheduled',minutes:-1,error:/CAMPAIGN_LOCKED/}
   ]){
    const c=await fixture(id++,spec.status,spec),req=command(spec.action,c,'atomic-precondition-'+id),op=await claim(req);
    if(spec.invalidate)await store('validation_invalidate',{providerId:c.id});
    await assert.rejects(call(spec.action==='agendar'?'schedule':'cancel',{id:c.id,expectedVersion:spec.version||c.version,operationId:op.id}),spec.error);
    assert.equal((await get(req)).state,'pending');assert.equal((await get(req)).response,null);assert.deepEqual(await call('get',{id:c.id}),c);
   }
   assert.equal(await audit(),oldAudit);assert.equal(await guards(),oldGuards);
   // Migration drift aborts without changing the installed function or audit.
   await db.exec(prior.replace('  UPDATE public.shrigma_campaign_operation SET provider_id=c.id,updated_at=clock_timestamp() WHERE id=op.id;',
    '  /* fixture drift */ UPDATE public.shrigma_campaign_operation SET provider_id=c.id,updated_at=clock_timestamp() WHERE id=op.id;'));
   const driftBefore=(await db.query("SELECT prosrc FROM pg_proc WHERE oid='shrigma_campaign_provider(text,jsonb)'::regprocedure")).rows[0].prosrc;
   await assert.rejects(db.exec(migration),/ATOMIC_RECEIPT_PROVIDER_DRIFT_0/);await db.exec('ROLLBACK');
   assert.equal((await db.query("SELECT prosrc FROM pg_proc WHERE oid='shrigma_campaign_provider(text,jsonb)'::regprocedure")).rows[0].prosrc,driftBefore);assert.equal(await audit(),oldAudit);
   console.log('PASS atomic receipt '+install+': migration twice, legacy audit/six guards, crash/timeout/poll/replay, identical/divergent finish, rollback and preconditions; no transport.');
  }finally{await db.close();}
 }
})().catch(e=>{console.error(e.message,e.where||'');process.exitCode=1;});
