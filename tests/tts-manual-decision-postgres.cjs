'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const SCHEMA=`CREATE TABLE crm_tts_amostra(marca text NOT NULL,application_id text NOT NULL,username text,status text,is_approvable boolean,approve_expira_em timestamptz,
 decisao text,decisao_motivo text,decidido_em timestamptz,decidido_por text,dry_run boolean DEFAULT true,primeiro_visto_em timestamptz NOT NULL DEFAULT now(),atualizado_em timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(marca,application_id));
 CREATE TABLE crm_tts_coleta_log(id bigserial PRIMARY KEY,marca text NOT NULL,fonte text NOT NULL,iniciado_em timestamptz NOT NULL DEFAULT now(),terminado_em timestamptz,linhas integer,ok boolean,erro text);
 CREATE TABLE crm_tts_regra(marca text PRIMARY KEY,modo text NOT NULL,cobranca_modo text NOT NULL DEFAULT 'pausado');
 INSERT INTO crm_tts_regra(marca,modo) VALUES('fish','dry_run'),('aristo','pausado');`;
const MIGRATION=fs.readFileSync(path.join(__dirname,'../n8n/tiktok/manual-decision.sql'),'utf8');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const request=(n,extra={})=>({operation_id:id(n),actor_sha256:'a'.repeat(64),marca:'fish',application_id:String(n),owner:'synthetic-execution-'+n,request_payload:{marca:'fish',application_id:String(n),resultado:'APPROVE',motivo_rejeicao:null,observacao:'synthetic',autor:'synthetic'},...extra});
async function suite(db){
 const store=async(a,p)=>(await db.query('SELECT crm_tts_manual_store_v1($1,$2::jsonb) AS result',[a,JSON.stringify(p)])).rows[0].result;
 const sample=async(n)=>(await db.query('SELECT to_jsonb(a) AS value FROM crm_tts_amostra a WHERE marca=$1 AND application_id=$2',['fish',String(n)])).rows[0].value;
 const add=async(n)=>db.query("INSERT INTO crm_tts_amostra(marca,application_id,status,is_approvable,approve_expira_em,decisao) VALUES('fish',$1,'PENDING',true,clock_timestamp()+interval '1 day','fila_manual')",[String(n)]);
 const claim=async(n)=>{await add(n);const p=request(n);const c=await store('claim',p);assert.equal(c.allowed,true);return {...p,claim_token:c.claim_token};};
 const finish=(p,kind='accepted')=>store('finish',{...p,receipt:{kind,provider_code:kind==='accepted'?0:null,request_id:kind==='accepted'?'synthetic-request':null,reason:kind==='accepted'?'provider_accepted':'transport_uncertain'}});
 await db.exec(SCHEMA);await add(1);const historical=await sample(1);
 await db.exec(MIGRATION);await db.exec(MIGRATION);
 assert.deepEqual(await sample(1),historical);assert.equal((await store('claim',request(1))).code,'disabled');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM crm_tts_manual_operation_v1')).rows[0].n,0);
 // Enable only isolated fixtures. A historical application remains ineligible even without a log.
 await db.exec("UPDATE crm_tts_manual_control_v1 SET eligible_from=clock_timestamp(),enabled=true");
 assert.equal((await store('claim',request(1))).code,'legacy_reconciliation_required');
 let p=await claim(2);let replay=await store('claim',p);assert.equal(replay.allowed,false);assert.equal(replay.code,'operation_exists');
 assert.equal((await store('claim',{...p,operation_id:id(200)})).code,'resource_reserved');
 assert.deepEqual(await store('claim',{...p,actor_sha256:'b'.repeat(64)}),{allowed:false,code:'resource_reserved'});
 assert.deepEqual(await store('claim',{...p,request_payload:{...p.request_payload,observacao:'changed'}}),{allowed:false,code:'resource_reserved'});
 assert.equal((await store('get',{...p,actor_sha256:'b'.repeat(64)})).operation.state,'missing');
 assert.equal((await store('get',p)).operation.state,'reserved');
 for(const changed of [{owner:'other'},{claim_token:id(999)},{operation_id:id(999)}])assert.equal((await store('dispatch',{...p,...changed})).code,'operation_not_owned');
 assert.equal((await store('dispatch',p)).allowed,true);assert.equal((await store('dispatch',p)).allowed,false);
 assert.equal((await finish(p,'blocked')).code,'receipt_state_invalid');
 // Provider acceptance and sample/log/receipt are one transaction, including rollback on lost storage.
 await db.exec(`CREATE FUNCTION synthetic_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.state='accepted' THEN RAISE EXCEPTION 'synthetic receipt failure';END IF;RETURN NEW;END$$;
 CREATE TRIGGER synthetic_failure BEFORE UPDATE ON crm_tts_manual_operation_v1 FOR EACH ROW EXECUTE FUNCTION synthetic_receipt_failure();`);
 const before=await sample(2);await assert.rejects(finish(p),/synthetic receipt failure/);assert.deepEqual(await sample(2),before);
 assert.equal((await store('get',p)).operation.state,'in_flight');assert.equal((await db.query('SELECT count(*)::int AS n FROM crm_tts_coleta_log')).rows[0].n,0);
 await db.exec('DROP TRIGGER synthetic_failure ON crm_tts_manual_operation_v1');
 // Collector may already have a later status. An accepted review cannot regress it.
 await db.exec("UPDATE crm_tts_amostra SET status='COMPLETED' WHERE application_id='2'");
 const accepted=await finish(p);assert.equal(accepted.recorded,true);assert.equal(accepted.receipt.operation.response.status,200);
 assert.equal((await sample(2)).status,'COMPLETED');assert.equal((await sample(2)).decisao,'manual_aprovada');
 assert.equal((await finish(p)).code,'already_recorded');assert.equal((await finish(p,'outcome_unknown')).code,'receipt_mismatch');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM crm_tts_coleta_log')).rows[0].n,1);
 // A receipt loss never grants dispatch again; only an exact GET observes the durable result.
 assert.equal((await store('claim',p)).receipt.operation.state,'accepted');assert.equal((await store('dispatch',p)).allowed,false);
 p=await claim(3);await store('dispatch',p);await finish(p,'outcome_unknown');assert.equal((await finish(p)).recorded,false);
 assert.equal((await store('claim',{...p,operation_id:id(300)})).code,'resource_reserved');assert.equal((await store('get',p)).operation.state,'outcome_unknown');
 p=await claim(4);await db.exec("UPDATE crm_tts_manual_control_v1 SET enabled=false WHERE marca='fish'");assert.equal((await store('dispatch',p)).code,'disabled_or_cohort_changed');
 assert.equal((await store('get',p)).operation.state,'blocked');await db.exec("UPDATE crm_tts_manual_control_v1 SET enabled=true WHERE marca='fish'");
 assert.equal((await store('dispatch',p)).allowed,false,'pause then resume does not recycle a reservation');
 p=await claim(5);await db.exec("UPDATE crm_tts_amostra SET is_approvable=false WHERE application_id='5'");assert.equal((await store('dispatch',p)).code,'source_changed_or_expired');
 p=await claim(6);await db.exec("UPDATE crm_tts_regra SET modo='ativo' WHERE marca='fish'");assert.equal((await store('dispatch',p)).code,'automatic_decisions_not_fenced');await db.exec("UPDATE crm_tts_regra SET modo='dry_run' WHERE marca='fish'");
 p=await claim(7);await db.exec("UPDATE crm_tts_amostra SET approve_expira_em=clock_timestamp()-interval '1 second' WHERE application_id='7'");assert.equal((await store('dispatch',p)).code,'source_changed_or_expired');
 await add(8);await db.exec("INSERT INTO crm_tts_coleta_log(marca,fonte,ok,erro) VALUES('fish','acao_painel',false,'APPROVE 8: -1 synthetic old timeout')");assert.equal((await store('claim',request(8))).code,'legacy_reconciliation_required');
 await add(9);await db.exec("UPDATE crm_tts_amostra SET dry_run=false WHERE application_id='9'");assert.equal((await store('claim',request(9))).code,'legacy_reconciliation_required');
 await add(10);assert.equal((await store('claim',{...request(10),operation_id:id(2)})).code,'idempotency_conflict');
 for(const payload of [{...request(10).request_payload,application_id:10},{...request(10).request_payload,resultado:null},{...request(10).request_payload,extra:1},{...request(10).request_payload,autor:''},{...request(10).request_payload,motivo_rejeicao:'OTHER'}])await assert.rejects(store('claim',{...request(10),request_payload:payload}),/INVALID_PAYLOAD/);
 for(const receipt of [{kind:null,provider_code:null,request_id:null,reason:''},{kind:'accepted',provider_code:0,request_id:null,reason:''},{kind:'accepted',provider_code:'0',request_id:'x',reason:''}])await assert.rejects(store('finish',{...p,receipt}),/INVALID_RECEIPT/);
 // Rejected review preserves the explicit reason and is never recorded as shipment approval.
 await add(11);p=request(11);p.request_payload={...p.request_payload,resultado:'REJECT',motivo_rejeicao:'NOT_MATCH'};const c=await store('claim',p);p.claim_token=c.claim_token;await store('dispatch',p);await finish(p);
 assert.equal((await sample(11)).status,'REJECT_CANCELLED');assert.match((await sample(11)).decisao_motivo,/NOT_MATCH/);
 // Migration is idempotent and preserves disabled/active controls, every reservation, and audit rows.
 const counts=await db.query('SELECT count(*)::int AS n FROM crm_tts_manual_operation_v1');await db.exec(MIGRATION);assert.deepEqual(await db.query('SELECT count(*)::int AS n FROM crm_tts_manual_operation_v1'),counts);
 assert.equal((await store('get',request(3))).operation.state,'outcome_unknown');
 await db.exec('CREATE ROLE synthetic_unprivileged; SET ROLE synthetic_unprivileged');await assert.rejects(store('get',request(2)),/permission denied/);await db.exec('RESET ROLE');
 console.log('PASS TikTok manual decision SQL: disabled installation, cohort/legacy boundary, permanent reservation, exact principal/operation, single dispatch, uncertain outcome, atomic receipt, monotonic sample state and restricted execution. Synthetic only.');
}
module.exports={SCHEMA,MIGRATION,id,request,suite};
if(require.main===module)(async()=>{const {PGlite}=require(process.env.TTS_PGLITE_MODULE||process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');const db=new PGlite();try{await suite(db);}finally{await db.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
