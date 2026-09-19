/* Actual isolated PostgreSQL engine (PGlite), synthetic fixtures only.
 * Concurrent calls are submitted together; PGlite queues statements on its embedded connection.
 * Multi-session PostgreSQL contention remains a deployment acceptance check. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {PGlite}=require(process.env.TTS_PGLITE_MODULE||process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {createPostgresStore,executeIntent}=require('../n8n/tiktok/cobranca-safety.cjs');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
(async()=>{
 const db=new PGlite();let count=0;
 const store=createPostgresStore((sql,params)=>db.query(sql,params));
 async function brand(name,limit=10){await db.query(`INSERT INTO crm_tts_regra(marca,gmv_auto,gmv_manual,teto_mensal,cobranca_modo,cobranca_max_dia) VALUES($1,1,1,1,'ativo',$2)`,[name,limit]);}
 async function review(b,{user='synthetic',open='synthetic-open',stage='amostra_sem_video',attempt=1,ref='synthetic-ref'}={}){
  const id='review-'+(++count),source='2026-01-01T00:00:00Z';
  if(stage==='amostra_sem_video')await db.query(`INSERT INTO crm_tts_amostra(marca,application_id,username,creator_open_id,status,atualizado_em) VALUES($1,$2,$3,$4,'CONTENT_PENDING',$5) ON CONFLICT DO NOTHING`,[b,ref,user,open,source]);
  else await db.query(`INSERT INTO crm_tts_convite(marca,colab_id,username,creator_open_id,showcase_product_count,content_product_count,atualizado_em) VALUES($1,$2,$3,$4,1,0,$5) ON CONFLICT DO NOTHING`,[b,ref,user,open,source]);
  await db.query(`INSERT INTO crm_tts_cobranca_modelo(marca,etapa,tentativa,texto) VALUES($1,$2,$3,'Synthetic reviewed template') ON CONFLICT DO NOTHING`,[b,stage,attempt]);
  await db.query(`INSERT INTO crm_tts_cobranca_revisao_v2(id,marca,etapa,username,creator_open_id,referencia,tentativa,texto,modelo_texto,fonte_atualizada_em,revisado_por,valido_ate) VALUES($1,$2,$3,$4,$5,$6,$7,'Synthetic exact approved text','Synthetic reviewed template',$8,'synthetic-reviewer',now()+interval '1 hour')`,[id,b,stage,user,open,ref,attempt,source]);
  return id;
 }
 const one=async(sql,p=[]) =>(await db.query(sql,p)).rows[0];
 try{
  await db.exec(read('n8n/tiktok/ddl_crm_tts.sql'));
  const migration=read('n8n/tiktok/cobranca-safety.sql');
  await assert.rejects(db.exec(migration),/pausada/);await db.exec('ROLLBACK');
  assert.equal((await one("SELECT to_regclass('crm_tts_cobranca_intencao_v2') AS name")).name,null);
  await db.exec("UPDATE crm_tts_regra SET cobranca_modo='pausado'");
  await db.exec(migration);await db.exec(migration);
  assert.equal(/\b(DELETE|TRUNCATE|DROP)\b/i.test(migration),false,'no clearing history or reservations');
  await brand('race');const r=await review('race'),owners=Array.from({length:12},()=>randomUUID());
  const claims=await Promise.all(owners.map(owner=>store.claim(r,owner)));
  assert.equal(claims.filter(c=>c.allowed).length,1);
  const owner=owners[claims.findIndex(c=>c.allowed)];
  const dispatches=await Promise.all([store.dispatch(r,owner),store.dispatch(r,owner)]);
  assert.equal(dispatches.filter(d=>d.allowed).length,1,'one durable transport start');const receipt=dispatches.find(d=>d.allowed);assert.equal(receipt.review_id,r);assert.equal(receipt.owner,owner);assert.equal(receipt.state,'em_transporte');
  assert.equal((await store.finish(r,randomUUID(),'aceito','test')).recorded,false);
  assert.equal((await store.finish(r,owner,'bloqueado','test')).recorded,false,'cannot clear an in-flight reservation');
  assert.equal((await store.finish(r,owner,'incerto','synthetic timeout')).recorded,true);
  assert.equal((await store.finish(r,owner,'aceito','late retry')).recorded,false,'uncertain is not reclassified automatically');
  const r2=await review('race',{attempt:2});assert.equal((await store.claim(r2,randomUUID())).reason,'pessoa_com_reserva_ou_incerto');
  const r3=await review('race',{stage:'vitrine_sem_video'});assert.equal((await store.claim(r3,randomUUID())).reason,'pessoa_com_reserva_ou_incerto');

  await brand('budget',1);const a=await review('budget',{user:'one',open:'one',ref:'one'}),b=await review('budget',{user:'two',open:'two',ref:'two'});
  const budget=await Promise.all([store.claim(a,randomUUID()),store.claim(b,randomUUID())]);assert.equal(budget.filter(c=>c.allowed).length,1);assert.ok(budget.some(c=>c.reason==='teto_diario'));
  await brand('oldbudget',1);const ob=await review('oldbudget');
  await db.exec("INSERT INTO crm_tts_cobranca(marca,etapa,username,tentativa,dry_run,ok) VALUES('oldbudget','amostra_sem_video','other-person',1,false,false)");
  assert.equal((await store.claim(ob,randomUUID())).reason,'teto_diario','legacy real errors also consume conservative daily capacity');

  await brand('legacy');const legacy=await review('legacy');
  await db.exec("INSERT INTO crm_tts_cobranca(marca,etapa,username,tentativa,dry_run,ok) VALUES('legacy','amostra_sem_video','synthetic',1,false,false)");
  assert.equal((await store.claim(legacy,randomUUID())).reason,'historico_legado_requer_conciliacao');
  await brand('simulation');const sim=await review('simulation');
  await db.exec("INSERT INTO crm_tts_cobranca(marca,etapa,username,tentativa,dry_run,ok) VALUES('simulation','amostra_sem_video','synthetic',1,true,true)");
  assert.equal((await store.simulate(sim)).simulated,true);assert.equal((await store.simulate(sim)).simulated,true);
  assert.equal((await one("SELECT count(*)::int n FROM crm_tts_cobranca_intencao_v2 WHERE marca='simulation'")).n,0);
  assert.equal((await store.claim(sim,randomUUID())).allowed,true,'simulation never shadows live key');
  assert.equal((await one("SELECT dry_run FROM crm_tts_cobranca WHERE marca='simulation'")).dry_run,true,'legacy log unchanged');

  for(const [name,change,reason] of [
   ['pause',"UPDATE crm_tts_regra SET cobranca_modo='pausado' WHERE marca=$1",'modo_nao_ativo'],
   ['content',"UPDATE crm_tts_amostra SET status='COMPLETED' WHERE marca=$1",'fonte_nao_elegivel'],
   ['snapshot',"UPDATE crm_tts_amostra SET atualizado_em=now() WHERE marca=$1",'fonte_alterada'],
   ['copy',"UPDATE crm_tts_cobranca_modelo SET texto='Changed' WHERE marca=$1",'modelo_alterado'],
   ['review',"UPDATE crm_tts_cobranca_revisao_v2 SET texto='Changed' WHERE marca=$1",'revisao_alterada'],
   ['optout',"INSERT INTO crm_tts_cobranca_supressao_v2(marca,creator_open_id,motivo) VALUES($1,'synthetic-open','synthetic opt-out')",'supressao'],
  ]){
   await brand(name);const id=await review(name),own=randomUUID();assert.equal((await store.claim(id,own)).allowed,true);await db.query(change,[name]);
   assert.equal((await store.dispatch(id,own)).reason,reason);assert.equal((await one('SELECT estado FROM crm_tts_cobranca_intencao_v2 WHERE revisao_id=$1',[id])).estado,'bloqueado');
   assert.equal((await store.claim(id,randomUUID())).allowed,false,'reservation remains fenced');
  }
  await brand('identity');const identity=await review('identity');
  await db.exec("INSERT INTO crm_tts_convite(marca,colab_id,username,creator_open_id) VALUES('identity','other','synthetic','conflicting-open')");
  assert.equal((await store.claim(identity,randomUUID())).reason,'identidade_ambigua');
  await brand('sequence');const seq=await review('sequence',{attempt:2});assert.equal((await store.claim(seq,randomUUID())).reason,'sequencia_ou_teto_tentativas');
  await brand('expire');const expire=await review('expire');await db.query("UPDATE crm_tts_cobranca_revisao_v2 SET revisado_em=now()-interval '2 hours',valido_ate=now()-interval '1 hour' WHERE id=$1",[expire]);assert.equal((await store.claim(expire,randomUUID())).reason,'revisao_invalida');

  // End-to-end real store with in-memory transport, including loss of response after dispatch.
  await brand('e2e');const e2e=await review('e2e');let sends=0;
  const transport={openConversation:async()=>({code:0,data:{conversation_id:'c',creator_im_id:'creator',username:'synthetic',is_new:true,unread_count:0}}),readMessages:async()=>({code:0,data:{messages:[]},coverage:{complete:true,conversation_id:'c'}}),sendMessage:async()=>{sends++;throw Error('synthetic timeout');}};
  const results=await Promise.all([executeIntent({reviewId:e2e,owner:randomUUID()},{store,transport}),executeIntent({reviewId:e2e,owner:randomUUID()},{store,transport})]);
  assert.equal(sends,1);assert.ok(results.some(r=>r.state==='incerto'));
  const persisted=await one('SELECT estado,transporte_em IS NOT NULL started FROM crm_tts_cobranca_intencao_v2 WHERE revisao_id=$1',[e2e]);assert.equal(persisted.estado,'incerto');assert.equal(persisted.started,true);
  await executeIntent({reviewId:e2e,owner:randomUUID()},{store,transport});assert.equal(sends,1,'uncertain never retries with a new owner');
  await brand('accepted');const accepted=await review('accepted');let acceptedCalls=0;
  const goodTransport={...transport,sendMessage:async()=>{acceptedCalls++;return{code:0,data:{message_id:'synthetic-accepted'}};}};
  assert.equal((await executeIntent({reviewId:accepted,owner:randomUUID()},{store,transport:goodTransport})).state,'aceito');
  assert.equal((await one('SELECT provider_message_id FROM crm_tts_cobranca_intencao_v2 WHERE revisao_id=$1',[accepted])).provider_message_id,'synthetic-accepted');
  const acceptedNext=await review('accepted',{attempt:2});assert.equal((await store.claim(acceptedNext,randomUUID())).reason,'intervalo_pessoa');
  await db.query("UPDATE crm_tts_cobranca_intencao_v2 SET reservado_em=now()-interval '8 days' WHERE revisao_id=$1",[accepted]);
  assert.equal((await store.claim(acceptedNext,randomUUID())).allowed,true,'accepted sequence can advance after interval and a new exact review');
  assert.equal(acceptedCalls,1);
  await db.exec('CREATE ROLE synthetic_unprivileged; SET ROLE synthetic_unprivileged');
  await assert.rejects(db.query("SELECT crm_tts_cobranca_claim_v2('none',$1::uuid)",[randomUUID()]),/permission denied/);
  await assert.rejects(db.query('SELECT * FROM crm_tts_cobranca_intencao_v2'),/permission denied/);
  await db.exec('RESET ROLE');
  assert.equal((await one('SELECT count(*)::int n FROM crm_tts_cobranca')).n,3,'all legacy logs preserved');
  console.log('PASS TikTok cobrança SQL: paused install, durable claim/dispatch, overlapping attempts, budget, legacy fence, review/source/opt-out rechecks, simulation separation, timeout non-retryable; no real transport.');
 }finally{await db.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
