'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const {install,id}=require('./journey-graph-cart-fixture.cjs');
const {buildWorkerRoleSql,ROLE}=require('../n8n/growth/journey-graph-worker-role.cjs');
const {createWorker,ACTOR}=require('../n8n/growth/journey-graph-worker.cjs');
const read=name=>fs.readFileSync(require.resolve(name),'utf8');
async function setup({db,pool,workerPool,brand='fish',outcome='accepted',prepareRole=true}={}){
 if(pool&&!workerPool)throw Error('isolated worker pool required');
 const cleanup=[];const x=await install({after:f=>cleanup.push(f)},db,pool,{cacheIdentity:false});
 await x.db.exec(read('../n8n/growth/journey-graph-dispatch-receipt.sql'));
 const f=await x.prepare(brand);
 // The base fixture supplies an immutable release/cache clone and a historical
 // epoch. Stop its seed participant; the role proof below captures a NEW source.
 await x.query("UPDATE crm_graph_candidate.entry SET stopped_reason='suppressed',version=version+1 WHERE id=$1",[f.entry.id]);
 await x.query("INSERT INTO subscribers(id,uuid,email,status,attribs) SELECT 2,$1,'second@example.invalid',status,attribs FROM subscribers WHERE id=1",[id(2)]);
 await x.query('INSERT INTO subscriber_lists SELECT 2,list_id,status FROM subscriber_lists WHERE subscriber_id=1');
 // Synthetic secret fixture: exercise only EXECUTE of the fixed definer boundary.
 // No secret value from the environment or production is read.
 await x.db.exec(`CREATE TABLE public.shrigma_email_hmac_key(value text);INSERT INTO public.shrigma_email_hmac_key VALUES('synthetic');REVOKE ALL ON public.shrigma_email_hmac_key FROM PUBLIC;
 CREATE OR REPLACE FUNCTION public.shrigma_email_recipient_key(email text) RETURNS TABLE(recipient_key text,key_version text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT md5(lower(email)||value),'fixture' FROM public.shrigma_email_hmac_key$$;
 REVOKE ALL ON FUNCTION public.shrigma_email_recipient_key(text) FROM PUBLIC;`);
 const fingerprint=(await x.query("SELECT encode(sha256(convert_to(pg_get_functiondef('public.shrigma_email_recipient_key(text)'::regprocedure),'UTF8')),'hex') h")).rows[0].h;
 const sql=buildWorkerRoleSql({sendLogSequence:'public.synthetic_cart_send_log',recipientKeySha256:fingerprint});
 if(prepareRole){
  // Production installs the restricted role before the additive cache identity
  // migration. Preserve that order so the migration can grant only its bounded
  // issue function to the already-existing worker role.
  await x.db.exec('BEGIN;'+sql+'COMMIT;');
  await x.db.exec(read('../n8n/growth/journey-graph-cart-admission.sql'));
  await x.db.exec(read('../n8n/growth/journey-graph-cache-identity.sql'));
  const identity='a'.repeat(64),runtime='b'.repeat(64),instance=id(70001),token=id(70002),action=id(70003);
  await x.query(`INSERT INTO crm_graph_candidate.cache_identity_deployment_v1
   (cache_target,enabled,executable_sha256,runtime_sha256,expected_role,heartbeat_seconds,lease_seconds,action_key)
   VALUES($1,true,$2,$3,session_user,30,120,$4)`,[x.cacheTarget,identity,runtime,action]);
  const snapshots=(await x.query(`SELECT jsonb_agg(jsonb_build_object('template_id',n.clone_template_id)||n.snapshot ORDER BY n.clone_template_id) value
   FROM crm_graph_candidate.native_template_v1 n WHERE n.cache_target=$1 AND n.state='ready'`,[x.cacheTarget])).rows[0].value;
  const heartbeat=(await x.query('SELECT crm_graph_candidate.cache_identity_heartbeat_v1($1,$2,$3,$4,$5,$6::jsonb) value',
   [x.cacheTarget,instance,token,identity,runtime,JSON.stringify(snapshots)])).rows[0].value;
  assert.equal(heartbeat.ready,true);assert.equal(heartbeat.template_count,snapshots.length);
 }
 const rawQuery=x.query;
 const asWorker=async()=>{if(!pool)await rawQuery('SET ROLE '+ROLE);},asAdmin=async()=>{if(!pool)await rawQuery('RESET ROLE');};
 const rolePool=pool?{
  async connect(){const c=await workerPool.connect();try{await c.query('SET ROLE '+ROLE);}catch(e){c.release(e);throw e;}return {query:c.query.bind(c),release:e=>c.release(e)};},
  async query(q,p){const c=await this.connect();try{return await c.query(q,p);}finally{c.release();}}
 }:{query:rawQuery,connect:async()=>({query:rawQuery,release(){}})};
 let posts=0;
 const options={pool:rolePool,enabled:true,actor:ACTOR,cacheTarget:x.cacheTarget,collectorWorkflowIds:{fish:'syntheticFish',aristo:'syntheticAristo'},readSource:f.settings.readSource,
  authorizeWorker:async({query,actor})=>actor===ACTOR&&(await query('SELECT current_user r')).rows[0].r===ROLE,
  sendTx:async(_payload,o)=>{posts++;assert.equal(o.retry,false);if(outcome==='outcome_unknown')throw Error('synthetic acknowledgement lost');return {statusCode:200,body:{data:true}};}};
 const worker=createWorker(options);
 async function captureAndEnroll(){
  const now=(await rawQuery(`SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') t`)).rows[0].t;
  const item=(await rawQuery(`SELECT jsonb_build_object('subscriber_id',id,'ref',attribs->$1->>'cart_abandoned_at','cart_hash',encode(sha256(convert_to(attribs->$1->>'cart_id','UTF8')),'hex'),'material_hash',encode(sha256(convert_to(crm_graph_candidate.source_material_v1(attribs->$1,attribs->>'first_name')::text,'UTF8')),'hex')) item FROM subscribers WHERE id=2`,[brand])).rows[0].item;
  if(!pool)await asWorker();
  const handoff={version:'journey_graph_source_v1',brand,reconciled:true,observed_at:now,items:[item],workflow_id:brand==='fish'?'syntheticFish':'syntheticAristo',execution_id:'987',batch_index:0,authorizes_enrollment:false,authorizes_send:false};
  const receipt=await worker.captureHandoff(handoff);assert.deepEqual(await worker.captureHandoff(handoff),receipt);assert.equal(receipt.authorizes_enrollment,false);assert.equal(receipt.authorizes_send,false);
  if(!pool)await asAdmin();
  const source_ref=receipt.source_refs[0],e=(await rawQuery('SELECT e.* FROM crm_graph_candidate.cart_admission_receipt_v1 r JOIN crm_graph_candidate.entry e ON e.id=r.entry_id WHERE r.source_ref=$1',[source_ref])).rows[0];
  assert.ok(e?.id);e.entry_id=e.id;
  if(!pool)await asWorker();
  return e;
 }
 return {isReal:!!pool,x,f,sql,rolePool,worker,options,captureAndEnroll,asWorker,asAdmin,posts:()=>posts,async close(){if(!pool){await rawQuery('ROLLBACK');await asAdmin();}for(const fn of cleanup)await fn();}};
}
async function assertForbidden(a){
 const q=a.rolePool.query.bind(a.rolePool);if(!a.isReal)await a.asWorker();
 const queries=[
  "UPDATE crm_graph_candidate.control SET enabled=true",
  "UPDATE crm_graph_candidate.control SET singleton=false",
  "UPDATE crm_maintenance_candidate.control SET mode='closed'",
  "UPDATE crm_maintenance_candidate.control SET singleton=false",
  "UPDATE crm_graph_candidate.cart_control_v1 SET enabled=true",
  "UPDATE crm_graph_candidate.cart_control_v1 SET brand='outside' WHERE brand='fish'",
  "UPDATE crm_graph_candidate.journey SET paused=false",
  "UPDATE crm_graph_candidate.journey SET id=gen_random_uuid()",
  "UPDATE public.subscriber_lists SET status='confirmed' WHERE subscriber_id=2",
  "UPDATE public.subscriber_lists SET subscriber_id=3 WHERE subscriber_id=2",
  "UPDATE public.subscribers SET email='changed@example.invalid' WHERE id=2",
  "UPDATE public.subscribers SET status='enabled' WHERE id=2",
  "UPDATE public.subscribers SET attribs=jsonb_set(attribs,'{fish,mkt_consent}','\"subscribed\"') WHERE id=2",
  "UPDATE public.subscribers SET attribs=jsonb_set(attribs,'{aristo,mkt_consent}','\"subscribed\"') WHERE id=2",
  "UPDATE public.subscribers SET attribs=jsonb_set(attribs,'{fish,cart_id}','\"changed\"') WHERE id=2",
  "UPDATE public.subscribers SET attribs=attribs||'{\"olivas\":{}}'::jsonb WHERE id=2",
  "UPDATE public.templates SET subject='changed'",
  'DELETE FROM crm_graph_candidate.cart_owner_v1',
  'INSERT INTO crm_graph_candidate.cart_epoch_v1 DEFAULT VALUES',
  'INSERT INTO crm_graph_candidate.entry DEFAULT VALUES',
  'CREATE TABLE crm_graph_candidate.forbidden(id int)',
  'SELECT * FROM public.shrigma_email_hmac_key',
  "SELECT crm_graph_candidate.cart_epoch_close_v1('fish','30000000-0000-4000-8000-000000000001')",
  "SELECT crm_graph_candidate.cart_enroll_v1('fish','30000000-0000-4000-8000-000000000001')",
  "SELECT crm_graph_candidate.native_prepare_v1('panel:synthetic','{}','synthetic-instance')",
  "SELECT crm_graph_candidate.release_prepare_v1('panel:synthetic','{}','{}','{}')"
 ];
 for(const sql of queries)await assert.rejects(q(sql),e=>e.code==='42501'||/^GRAPH_WORKER_/.test(e.message),sql);
 const locks=["SELECT * FROM crm_graph_candidate.control FOR SHARE","SELECT * FROM crm_graph_candidate.cart_control_v1 FOR SHARE","SELECT * FROM crm_graph_candidate.journey FOR UPDATE","SELECT * FROM crm_maintenance_candidate.control FOR SHARE","SELECT * FROM public.subscriber_lists FOR SHARE"];
 for(const sql of locks)await q(sql);
}
async function assertLegacyOff(a,brand){
 await a.asAdmin();
 await a.x.query('UPDATE crm_graph_candidate.control SET enabled=false');await a.x.query('UPDATE crm_graph_candidate.cart_control_v1 SET enabled=false');
 const ref=new Date(Date.parse(a.x.ref)-120000).toISOString(),email='legacy@example.invalid';
 await a.x.query("INSERT INTO subscribers(id,uuid,email,status,attribs) SELECT 3,$1,$2,status,jsonb_set(attribs,ARRAY[$3,'cart_abandoned_at'],to_jsonb($4::text)) FROM subscribers WHERE id=1",[id(3),email,brand,ref]);
 await a.x.query('INSERT INTO subscriber_lists SELECT 3,list_id,status FROM subscriber_lists WHERE subscriber_id=1');
 const url=(await a.x.query('SELECT attribs->$1->>\'cart_url\' u FROM subscribers WHERE id=3',[brand])).rows[0].u,tid=brand==='fish'?60:95;
 const b={brand,toque:'t05',piece:'carrinho-30min',chave:'cart_t05_at',subscriber_id:3,email,ref,template_id:tid,tx:{template_id:tid,subscriber_email:email,from_email:brand==='fish'?'Fishermans <contato@fishermans.com.br>':'O Aristocrata <contato@oaristocrata.com>',headers:[{'Reply-To':brand==='fish'?'contato@fishermans.com.br':'contato@oaristocrata.com'}],data:{checkout_url:url+'?utm_source=email&utm_medium=fluxo&utm_campaign='+brand+'-carrinho&utm_content=carrinho-30min'}}};
 const r=(await a.x.query('SELECT * FROM public.shrigma_email_claim_cart($1)',[b])).rows[0];assert.equal(r.should_send,true);await a.x.query('SELECT * FROM public.shrigma_email_finish_cart($1,$2,$3,$4)',[r.dispatch_id,r.claim_token,'rejected',r.context]);
}
async function assertLedgerForbidden(a,brand){
 await a.asAdmin();
 const ids=[id(90001),id(90002)];
 await a.x.query("INSERT INTO shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,is_test,transport_state,claim_token) VALUES($1,$3,'carrinho','carrinho-30min','synthetic-legacy',false,'in_flight',$1),($2,$3,'pedido','confirmacao','synthetic-tx',false,'in_flight',$2)",[...ids,brand]);
 await a.asWorker();const q=a.rolePool.query.bind(a.rolePool);
 for(const dispatchId of ids)await assert.rejects(q("UPDATE shrigma_email_dispatch SET transport_state='rejected',outcome_at=clock_timestamp() WHERE dispatch_id=$1",[dispatchId]),/GRAPH_WORKER_DISPATCH_/);
 await assert.rejects(q("UPDATE shrigma_email_dispatch SET transport_state='in_flight',outcome_at=NULL,accepted_at=NULL,send_log_id=NULL WHERE dispatch_id IN(SELECT dispatch_id FROM crm_graph_candidate.cart_delivery_v1)"),/GRAPH_WORKER_DISPATCH_TRANSITION/);
 await assert.rejects(q("INSERT INTO shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,is_test,transport_state,claim_token) VALUES($1,$2,'carrinho','carrinho-30min','synthetic-invented',false,'in_flight',$1)",[id(90003),brand]),/GRAPH_WORKER_DISPATCH_PERMIT/);
 await assert.rejects(q("INSERT INTO shrigma_send_log(email,brand,kind,flow,channel,piece,template_id,ref,subscriber_id) VALUES('second@example.invalid',$1,'tx','pedido','email','confirmacao',60,$2,2)",[brand,a.x.ref]),/GRAPH_WORKER_LOG_SCOPE/);
 await a.asAdmin();assert.deepEqual((await a.x.query('SELECT transport_state FROM shrigma_email_dispatch WHERE dispatch_id=ANY($1::uuid[]) ORDER BY dispatch_id',[ids])).rows.map(r=>r.transport_state),['in_flight','in_flight']);
}
async function assertDeferredGuards(a,brand){
 const q=a.rolePool.query.bind(a.rolePool),row=(await q('SELECT i.id,e.id entry_id,e.version FROM crm_graph_candidate.intent i JOIN crm_graph_candidate.entry e ON e.id=i.entry_id WHERE e.id<>$1',[a.f.entry.id])).rows[0];assert.ok(row);
 const c=await a.rolePool.connect();try{
  await c.query('BEGIN');
  await c.query("INSERT INTO crm_graph_candidate.cart_permit_v1 SELECT $1,$2,txid_current(),repeat('a',64),repeat('b',64),repeat('c',64),$3,clock_timestamp()+interval '1 minute'",[row.id,brand,a.f.preparedClone.clone_template_id]);
  await c.query("INSERT INTO shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,is_test,transport_state,claim_token) SELECT $1,$2,'carrinho','carrinho-30min',jsonb_build_array('email',to_char(ref AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),subscriber_id,false)::text,false,'in_flight',$1 FROM crm_graph_candidate.cart_owner_v1 WHERE entry_id=$3",[id(90101),brand,row.entry_id]);
  await assert.rejects(c.query('COMMIT'),/GRAPH_WORKER_DISPATCH_LINK/);await c.query('ROLLBACK');
 }finally{c.release();}
 assert.equal((await q('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);assert.equal((await q('SELECT count(*)::int n FROM crm_graph_candidate.cart_permit_v1')).rows[0].n,0);
 const {createMessageClaim}=require('../n8n/growth/journey-graph-message.cjs');
 const claim=createMessageClaim({...a.f.settings,pool:a.rolePool}),grant=await claim.claim({brand,intent_id:row.id,expected_entry_version:row.version});assert.equal(grant.should_send,true);
 const b=grant.context;
 await assert.rejects(q("INSERT INTO shrigma_send_log(email,brand,kind,flow,channel,piece,template_id,ref,subscriber_id) VALUES($1,$2,'tx','carrinho','email','carrinho-30min',$3,$4,$5)",[b.email,brand,b.template_id,b.ref,b.subscriber_id]),/GRAPH_WORKER_LOG_LINK/);
 assert.equal((await q('SELECT count(*)::int n FROM shrigma_send_log')).rows[0].n,0);
 // Complete the original reservation through its original finisher. No HTTP is
 // performed by this deferred-constraint test and no new grant is requested.
 await q('SELECT * FROM public.shrigma_email_finish_cart($1,$2,$3,$4)',[grant.dispatch_id,grant.claim_token,'rejected',b]);
}
module.exports={setup,assertForbidden,assertLegacyOff,assertLedgerForbidden,assertDeferredGuards};
