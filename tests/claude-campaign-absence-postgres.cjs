/* R1 · prova no SQL (PGlite isolado, sem rede/credenciais/envio): quando o
   servidor PROVA que agendar/cancelar não gravou nada.
   - recibo 'outcome_unknown' é final: finish só grava sobre 'pending' e o
     provider agenda/cancela somente com a operação 'pending' sob FOR UPDATE;
   - com o recibo final, a campanha na MESMA versão do pedido prova ausência;
   - 'pending' e operação inexistente (404) NÃO provam: um efeito ainda pode vir.
   Rodar com QA_PG=1 (CAMPAIGN_PGLITE_MODULE). */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const {createService,hash}=require('../n8n/growth/campaign-service');
const {createStore}=require('../n8n/growth/campaign-store');
const {createProvider}=require('../n8n/growth/campaign-provider');
const AUTH={actor:'absence-fixture',caps:['read_content','submit']};

(async()=>{
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
 const db=new PGlite();
 try{
  await db.exec(read('tests/campaign-provider-schema.sql'));
  await db.exec("UPDATE campaigns SET body='<p>Fixture</p>{{ UnsubscribeURL }}',altbody='Fixture {{ UnsubscribeURL }}'; INSERT INTO crm_familia_campanha(marca,utm_campaign,familia) VALUES('fish','week','week')");
  await db.exec(read('tests/fixtures/campaign-store-pre-recovery.sql'));await db.exec(read('tests/fixtures/campaign-provider-pre-audience.sql'));
  await db.exec(read('n8n/growth/campaign-write-guard.sql'));await db.exec(read('n8n/growth/campaign-atomic-receipt.sql'));await db.exec(read('n8n/growth/campaign-audience.sql'));
  const reviewIds=new Map();
  const call=async(action,p)=>(await db.query('SELECT shrigma_campaign_provider($1::text,$2::jsonb) AS r',[action,JSON.stringify(action==='schedule'?{audienceReviewId:reviewIds.get(p.id),...p}:p)])).rows[0].r;
  const store=async(action,p)=>(await db.query('SELECT shrigma_campaign_store($1::text,$2::jsonb) AS r',[action,JSON.stringify(p)])).rows[0].r;
  async function fixture(id,status){
   await db.query(`INSERT INTO campaigns(id,name,subject,from_email,body,altbody,content_type,headers,status,tags,type,messenger,template_id,sent,attribs,send_at)
    SELECT $1,name,subject,from_email,body,altbody,content_type,headers,'draft',tags,type,messenger,template_id,0,attribs,NULL FROM campaigns WHERE id=100`,[id]);
   await db.exec('BEGIN');await db.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(id)]);
   await db.query("INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES($1,3,'Fish')",[id]);
   await db.query("UPDATE campaigns SET status=$2,send_at=clock_timestamp()+interval '1 day' WHERE id=$1",[id,status]);await db.exec('COMMIT');
   const c=await call('get',{id});
   if(status==='draft')reviewIds.set(id,(await db.query('SELECT fixture_audience_review($1) AS v',[id])).rows[0].v.audience.review_id);
   return c;
  }
  const command=(action,c,key)=>({acao:'campanha_'+action,brand:'fish',id:c.id,expected_version:c.version,confirm:action,...(action==='agendar'?{audience_review_id:reviewIds.get(c.id)}:{}),idempotency_key:key});
  const claim=req=>store('claim',{actor:AUTH.actor,key:req.idempotency_key,hash:hash(req),brand:req.brand,action:req.acao.replace('campanha_','')});
  const uncertain=(op,c)=>store('finish',{id:op.id,lease:op.lease,state:'outcome_unknown',providerId:c.id,response:{status:502,body:{error:'OUTCOME_UNKNOWN',message:'Resultado remoto incerto.',provider_id:c.id,operation_id:op.id}}});
  const noop=async()=>{throw Error('Unexpected native transport');};
  let providerWrites=0;
  const service=createService({store:createStore({query:(q,p)=>db.query(q,p)}),provider:createProvider({query:async(q,p)=>{if(['schedule','cancel'].includes(p?.[0]))providerWrites++;return db.query(q,p);},nativeCreate:noop,validateContent:noop})});
  // Regra do painel (growth-campaign-api.js releaseUnapplied), aplicada às respostas reais do serviço.
  async function provesAbsence(req,action,status){
   const op=(await service.handle(AUTH,{acao:'campanha_operacao',brand:'fish',idempotency_key:req.idempotency_key}));
   if(op.status!==200||op.body.operation.state!=='outcome_unknown'||op.body.operation.action!==action||(op.body.operation.operation_key!==undefined&&op.body.operation.operation_key!==req.idempotency_key))return false;
   const cur=await service.handle(AUTH,{acao:'campanha_obter',brand:'fish',id:req.id});
   return cur.status===200&&cur.body.campaign.version===req.expected_version&&cur.body.campaign.status===status;
  }
  let id=500;
  for(const [action,native,before,after] of [['agendar','schedule','draft','scheduled'],['cancelar','cancel','scheduled','cancelled']]){
   // 1) Efeito não chegou a gravar; o recibo foi finalizado como incerto.
   let c=await fixture(id++,before),req=command(action,c,'absence-final-'+action+'-0001'),op=await claim(req);
   assert.deepEqual(await uncertain(op,c),{ok:true});
   await assert.rejects(call(native,{id:c.id,expectedVersion:c.version,operationId:op.id}),/CAMPAIGN_OPERATION_INVALID/,'recibo final impede o efeito tardio');
   await assert.rejects(store('finish',{id:op.id,lease:op.lease,state:'succeeded',providerId:c.id,response:{status:200,body:{}}}),/CAMPAIGN_STORE_FINALIZED/);
   const writes=providerWrites,replay=await service.handle(AUTH,req);assert.equal(replay.status,502);assert.equal(replay.body.error,'OUTCOME_UNKNOWN');assert.equal(providerWrites,writes,'a mesma chave devolve o recibo, sem novo efeito');
   assert.deepEqual(await call('get',{id:c.id}),c,'campanha intacta: mesma versão do pedido');
   assert.equal(await provesAbsence(req,action,before),true);

   // 2) Efeito gravou com o recibo atômico: 'outcome_unknown' não chega a existir.
   c=await fixture(id++,before);req=command(action,c,'absence-commit-'+action+'-001');op=await claim(req);
   const changed=await call(native,{id:c.id,expectedVersion:c.version,operationId:op.id});assert.equal(changed.status,after);assert.notEqual(changed.version,c.version);
   await assert.rejects(uncertain(op,c),/CAMPAIGN_STORE_FINALIZED/);assert.equal(await provesAbsence(req,action,before),false);

   // 3) Recibo legado incerto com efeito gravado: a versão mudou, então não prova ausência.
   c=await fixture(id++,before);req=command(action,c,'absence-legacy-'+action+'-001');op=await claim(req);
   await db.exec('BEGIN');await db.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(c.id)]);await db.query('UPDATE campaigns SET status=$2,updated_at=clock_timestamp() WHERE id=$1',[c.id,after]);await db.exec('COMMIT');
   assert.deepEqual(await uncertain(op,c),{ok:true});assert.equal(await provesAbsence(req,action,before),false,'versão diferente mantém o registro travado');

   // 4) 'pending' não é final: o efeito ainda pode acontecer depois da consulta.
   c=await fixture(id++,before);req=command(action,c,'absence-pending-'+action+'-01');op=await claim(req);
   assert.equal((await service.handle(AUTH,{acao:'campanha_operacao',brand:'fish',idempotency_key:req.idempotency_key})).body.operation.state,'pending');assert.equal(await provesAbsence(req,action,before),false);
   assert.equal((await call(native,{id:c.id,expectedVersion:c.version,operationId:op.id})).status,after,'efeito ainda possível em pending');

   // 5) 404 não prova: um POST atrasado com a mesma chave ainda grava depois.
   c=await fixture(id++,before);req=command(action,c,'absence-missing-'+action+'-01');
   const missing=await service.handle(AUTH,{acao:'campanha_operacao',brand:'fish',idempotency_key:req.idempotency_key});assert.equal(missing.status,404);assert.equal(missing.body.error,'OPERATION_NOT_FOUND');
   const late=await service.handle(AUTH,req);assert.equal(late.status,200);assert.equal(late.body.campaign.status,after,'POST atrasado ainda tem efeito');
  }
  console.log('PASS absence proof: outcome_unknown final + same campaign version proves no schedule/cancel; commit, legacy change, pending and 404 never prove. No transport.');
 }finally{await db.close();}
})().catch(e=>{console.error(e.message,e.where||'');process.exitCode=1;});
