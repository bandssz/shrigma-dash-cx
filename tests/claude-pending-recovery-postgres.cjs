/* Recuperação segura de tentativas pendentes · prova SQL em PGlite isolado (sem rede,
   sem credenciais, sem transporte nativo). Cadeia igual à do gateway: esquema de teste,
   campaign-store.sql, campaign-recovery.sql, campaign-provider.sql e, por cima, a
   proposta n8n/growth/campaign-pending-recovery.sql (aplicada duas vezes).
   - gate SQL desligado: nenhum lease, agendar/cancelar idênticos, encerramento recusado;
   - gate ligado: lápide sob o lock do claim + FOR UPDATE do provider; cerca no recibo;
   - CREATE/salvar/validar nunca por TTL; operação antiga sem lease nunca por TTL.
   Rodar com QA_PG=1 (CAMPAIGN_PGLITE_MODULE). */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const {createService,hash}=require('../n8n/growth/campaign-service');
const {createStore}=require('../n8n/growth/campaign-store');
const {createProvider}=require('../n8n/growth/campaign-provider');
const AUTH={actor:'pending-recovery-fixture',caps:['read_content','draft','validate','submit']};

(async()=>{
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
 const db=new PGlite();
 try{
  for(const f of ['tests/campaign-provider-schema.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-recovery.sql','n8n/growth/campaign-template-ownership.sql','n8n/growth/campaign-provider.sql'])await db.exec(read(f));
  await db.exec("UPDATE campaigns SET body='<p>Fixture</p>{{ UnsubscribeURL }}',altbody='Fixture {{ UnsubscribeURL }}'; INSERT INTO crm_familia_campanha(marca,utm_campaign,familia) VALUES('fish','week','week')");
  const md5=async()=>(await db.query("SELECT proname,md5(prosrc) m FROM pg_proc WHERE proname IN ('shrigma_campaign_store','shrigma_campaign_provider','shrigma_campaign_recovery') ORDER BY proname")).rows;
  const before=await md5();
  assert.deepEqual(before.map(r=>r.m),['fe3a35e75c8d0830f1b289fa806e52fc','1e2c0a2bacd82f4dcf8d6797cbf1842c','b77d960aca32c2c93dfe15e82922d7ff'],'cadeia igual à pinada pelo gateway');
  await db.exec(read('n8n/growth/campaign-pending-recovery.sql'));await db.exec(read('n8n/growth/campaign-pending-recovery.sql'));
  assert.deepEqual(await md5(),before,'store/provider/recovery intactos (md5 pinados pelo gateway)');
  assert.equal((await db.query('SELECT enabled FROM shrigma_campaign_pending_recovery_config')).rows[0].enabled,false,'gate SQL nasce desligado');

  const reviewIds=new Map();
  const call=async(action,p)=>(await db.query('SELECT shrigma_campaign_provider($1::text,$2::jsonb) AS r',[action,JSON.stringify(action==='schedule'?{audienceReviewId:reviewIds.get(p.id),...p}:p)])).rows[0].r;
  const store=async(action,p)=>(await db.query('SELECT shrigma_campaign_store($1::text,$2::jsonb) AS r',[action,JSON.stringify(p)])).rows[0].r;
  const abandon=async p=>(await db.query('SELECT shrigma_campaign_abandon($1::jsonb) AS r',[JSON.stringify({actor:AUTH.actor,brand:'fish',...p})])).rows[0].r;
  const row=async key=>(await db.query('SELECT * FROM shrigma_campaign_operation WHERE operation_key=$1',[key])).rows;
  async function fixture(id,status){
   await db.query(`INSERT INTO campaigns(id,name,subject,from_email,body,altbody,content_type,headers,status,tags,type,messenger,template_id,sent,attribs,send_at)
    SELECT $1,name,subject,from_email,body,altbody,content_type,headers,'draft',tags,type,messenger,template_id,0,attribs,NULL FROM campaigns WHERE id=100`,[id]);
   await db.query("INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES($1,3,'Fish')",[id]);
   await db.query("UPDATE campaigns SET status=$2,send_at=clock_timestamp()+interval '1 day' WHERE id=$1",[id,status]);
   const c=await call('get',{id});
   if(status==='draft')reviewIds.set(id,(await db.query('SELECT fixture_audience_review($1) AS v',[id])).rows[0].v.audience.review_id);
   return c;
  }
  const command=(action,c,key)=>({acao:'campanha_'+action,brand:'fish',id:c.id,expected_version:c.version,confirm:action,...(action==='agendar'?{audience_review_id:reviewIds.get(c.id)}:{}),idempotency_key:key});
  const claim=(req,actor=AUTH.actor)=>store('claim',{actor,key:req.idempotency_key,hash:hash(req),brand:req.brand,action:req.acao.replace('campanha_','')});
  const expire=key=>db.query("UPDATE shrigma_campaign_operation SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_key=$1",[key]);
  const noop=async()=>{throw Error('Unexpected native transport');};
  let providerWrites=0;
  const service=createService({store:createStore({query:(q,p)=>db.query(q,p)}),provider:createProvider({query:async(q,p)=>{if(['schedule','cancel'].includes(p?.[0]))providerWrites++;return db.query(q,p);},nativeCreate:noop,validateContent:noop})});
  let id=600;

  // 0) Gate SQL desligado: comportamento atual. Sem lease; agendar e cancelar normais; encerrar recusado.
  let c=await fixture(id++,'draft'),req=command('agendar',c,'off-schedule-key-0001'),op;
  const off=await service.handle(AUTH,{...req});assert.equal(off.status,200);assert.equal(off.body.campaign.status,'scheduled');
  assert.equal((await row(req.idempotency_key))[0].lease_expires_at,null,'desligado: nenhum lease emitido');
  let s0=await fixture(id++,'scheduled');const offCancel=await service.handle(AUTH,command('cancelar',s0,'off-cancel-key-00001'));assert.equal(offCancel.status,200);assert.equal(offCancel.body.campaign.status,'cancelled');
  const legacyPending=await fixture(id++,'draft'),legacyReq=command('agendar',legacyPending,'legacy-pending-key-01');await claim(legacyReq);
  await assert.rejects(abandon({key:'off-missing-key-00001',action:'agendar'}),/ABANDON_DISABLED/);
  assert.equal((await row('off-missing-key-00001')).length,0);

  await db.exec('UPDATE shrigma_campaign_pending_recovery_config SET enabled=true,updated_at=clock_timestamp()');

  // 1) Chave sem registro: lápide terminal; repetir devolve a mesma; POST atrasado recusa sem efeito.
  c=await fixture(id++,'draft');req=command('agendar',c,'missing-tombstone-0001');
  const t1=await abandon({key:req.idempotency_key,action:'agendar'});
  assert.equal(t1.policy,'crm-campaign-abandon-v1');assert.equal(t1.abandoned,true);assert.equal(t1.created,true);
  assert.equal(t1.operation.state,'rejected');assert.equal(t1.operation.response.body.error,'OPERATION_ABANDONED');assert.equal(t1.operation.response.body.operation_id,t1.operation.id);
  assert.ok(!('lease' in t1.operation),'lápide não expõe o token');
  const t1b=await abandon({key:req.idempotency_key,action:'agendar'});assert.equal(t1b.operation.id,t1.operation.id);assert.equal(t1b.created,false);assert.equal((await row(req.idempotency_key)).length,1);
  let writes=providerWrites;const late=await service.handle(AUTH,req);
  assert.equal(late.status,409);assert.equal(late.body.error,'IDEMPOTENCY_CONFLICT');assert.equal(providerWrites,writes,'POST atrasado não chega ao provider');
  assert.deepEqual(await call('get',{id:c.id}),c,'campanha intacta');
  const polled=await service.handle(AUTH,{acao:'campanha_operacao',brand:'fish',idempotency_key:req.idempotency_key});
  assert.equal(polled.status,200);assert.equal(polled.body.operation.state,'rejected');assert.equal(polled.body.operation.response.body.error,'OPERATION_ABANDONED');

  // 2) Pending com lease válido: recusa, nada muda.
  c=await fixture(id++,'draft');req=command('agendar',c,'pending-active-key-001');op=await claim(req);
  const pendingRow=(await row(req.idempotency_key))[0];assert.ok(pendingRow.lease_expires_at>new Date(),'ligado: lease emitido no claim');
  await assert.rejects(abandon({key:req.idempotency_key,action:'agendar'}),/ABANDON_LEASE_ACTIVE/);
  assert.deepEqual((await row(req.idempotency_key))[0],pendingRow);

  // 3) Lease vencido: a cerca recusa o efeito tardio e desfaz o status; lápide; efeito/replay posteriores recusados.
  await expire(req.idempotency_key);
  await assert.rejects(call('schedule',{id:c.id,expectedVersion:c.version,operationId:op.id}),/OPERATION_LEASE_EXPIRED/);
  assert.deepEqual(await call('get',{id:c.id}),c,'status scheduled desfeito junto com o recibo');
  const t3=await abandon({key:req.idempotency_key,action:'agendar'});assert.equal(t3.abandoned,true);assert.equal(t3.created,false);assert.equal(t3.operation.id,op.id);
  await assert.rejects(call('schedule',{id:c.id,expectedVersion:c.version,operationId:op.id}),/CAMPAIGN_OPERATION_INVALID/);
  await assert.rejects(store('finish',{id:op.id,lease:op.lease,state:'succeeded',providerId:c.id,response:{status:200,body:{}}}),/CAMPAIGN_STORE_FINALIZED/);
  writes=providerWrites;const replay=await service.handle(AUTH,req);assert.equal(replay.status,409);assert.equal(replay.body.error,'OPERATION_ABANDONED');assert.equal(providerWrites,writes);
  assert.deepEqual(await call('get',{id:c.id}),c);
  await assert.rejects(db.query("UPDATE shrigma_campaign_operation SET state='succeeded' WHERE id=$1",[op.id]),/OPERATION_ABANDONED/,'lápide imutável');

  // 4) Cancelar: mesma prova; campanha continua agendada.
  c=await fixture(id++,'scheduled');req=command('cancelar',c,'pending-cancel-key-001');op=await claim(req);await expire(req.idempotency_key);
  await assert.rejects(call('cancel',{id:c.id,expectedVersion:c.version,operationId:op.id}),/OPERATION_LEASE_EXPIRED/);
  assert.equal((await abandon({key:req.idempotency_key,action:'cancelar'})).abandoned,true);
  await assert.rejects(call('cancel',{id:c.id,expectedVersion:c.version,operationId:op.id}),/CAMPAIGN_OPERATION_INVALID/);
  assert.equal((await call('get',{id:c.id})).status,'scheduled');assert.deepEqual(await call('get',{id:c.id}),c);

  // 5) O efeito venceu a corrida: o encerramento devolve 'succeeded' e não abandona.
  c=await fixture(id++,'draft');req=command('agendar',c,'effect-won-key-000001');op=await claim(req);
  assert.equal((await call('schedule',{id:c.id,expectedVersion:c.version,operationId:op.id})).status,'scheduled');
  await expire(req.idempotency_key);
  const won=await abandon({key:req.idempotency_key,action:'agendar'});assert.equal(won.abandoned,false);assert.equal(won.operation.state,'succeeded');

  // 6) Identidade: marca, ação e ator errados recusam e não gravam.
  c=await fixture(id++,'draft');req=command('agendar',c,'identity-check-key-01');op=await claim(req);await expire(req.idempotency_key);
  const snap=(await row(req.idempotency_key))[0];
  await assert.rejects(abandon({key:req.idempotency_key,action:'agendar',brand:'aristo'}),/ABANDON_IDENTITY_MISMATCH/);
  await assert.rejects(abandon({key:req.idempotency_key,action:'cancelar'}),/ABANDON_IDENTITY_MISMATCH/);
  await assert.rejects(abandon({key:req.idempotency_key,action:'agendar',actor:'outro-operador'}),/ABANDON_IDENTITY_MISMATCH/);
  assert.deepEqual(await row(req.idempotency_key),[snap],'nenhuma lápide para outro ator');

  // 7) CREATE/salvar e validar nunca por TTL, mesmo com prazo forçado.
  const create={acao:'campanha_salvar',brand:'fish',definition:{},idempotency_key:'create-pending-key-01'};const cop=await claim(create);
  assert.equal((await row(create.idempotency_key))[0].lease_expires_at,null,'salvar não recebe lease');
  await db.query("UPDATE shrigma_campaign_operation SET lease_expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[cop.id]);
  await assert.rejects(abandon({key:create.idempotency_key,action:'salvar'}),/ABANDON_ACTION_UNSUPPORTED/);
  await assert.rejects(abandon({key:create.idempotency_key,action:'agendar'}),/ABANDON_ACTION_UNSUPPORTED/);
  await assert.rejects(abandon({key:'never-claimed-create-1',action:'salvar'}),/ABANDON_ACTION_UNSUPPORTED/);
  await assert.rejects(abandon({key:'never-claimed-review-1',action:'validar'}),/ABANDON_ACTION_UNSUPPORTED/);
  assert.equal((await row(create.idempotency_key))[0].state,'pending');assert.equal((await row('never-claimed-create-1')).length,0);

  // 8) Pending sem lease (anterior ao gate): sem prova, continua em conciliação.
  await assert.rejects(abandon({key:legacyReq.idempotency_key,action:'agendar'}),/ABANDON_LEASE_UNKNOWN/);
  // 9) Estado final incerto: nada muda (liberação por versão continua sendo o caminho).
  c=await fixture(id++,'draft');req=command('agendar',c,'unknown-final-key-001');op=await claim(req);
  await store('finish',{id:op.id,lease:op.lease,state:'outcome_unknown',providerId:c.id,response:{status:502,body:{error:'OUTCOME_UNKNOWN'}}});await expire(req.idempotency_key);
  const unk=await abandon({key:req.idempotency_key,action:'agendar'});assert.equal(unk.abandoned,false);assert.equal(unk.operation.state,'outcome_unknown');

  // 10) Guardas diretas: lápide só pela função; lease nunca escolhido pelo chamador.
  await assert.rejects(db.query("INSERT INTO shrigma_campaign_operation(actor,operation_key,request_hash,brand,action,state,response,abandoned_at) VALUES('x','direct-tombstone-0001',repeat('b',64),'fish','agendar','rejected','{\"status\":409,\"body\":{}}',now())"),/OPERATION_ABANDON_GUARD/);
  await db.query("INSERT INTO shrigma_campaign_operation(actor,operation_key,request_hash,brand,action,lease_expires_at) VALUES('x','direct-lease-key-0001',repeat('b',64),'fish','salvar',now()+interval '9 days')");
  assert.equal((await row('direct-lease-key-0001'))[0].lease_expires_at,null);
  await assert.rejects(db.query("UPDATE shrigma_campaign_operation SET abandoned_at=now(),state='rejected',response='{}' WHERE operation_key=$1",[snap.operation_key]),/OPERATION_ABANDON_GUARD/);

  // 11) Gate desligado de novo: não emite lease e recusa encerrar; lápides existentes continuam válidas.
  await db.exec('UPDATE shrigma_campaign_pending_recovery_config SET enabled=false');
  await assert.rejects(abandon({key:'missing-tombstone-0001',action:'agendar'}),/ABANDON_DISABLED/);
  c=await fixture(id++,'draft');req=command('agendar',c,'off-again-key-000001');await claim(req);assert.equal((await row(req.idempotency_key))[0].lease_expires_at,null);
  console.log('PASS pending recovery (PGlite): gate off unchanged; tombstone for missing/expired pending under claim lock + provider FOR UPDATE; fenced late effect; replay/late POST refused; succeeded wins; identity; CREATE/validar/legacy never by TTL. No transport.');
 }finally{await db.close();}
})().catch(e=>{console.error(e.message,e.where||'',e.stack);process.exitCode=1;});
