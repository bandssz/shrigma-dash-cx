'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const SCHEMA=`CREATE TABLE crm_tts_regra (
 marca text PRIMARY KEY, modo text NOT NULL DEFAULT 'dry_run', gmv_auto numeric(12,2) NOT NULL,
 gmv_manual numeric(12,2) NOT NULL, fulfillment_min numeric(5,2) NOT NULL DEFAULT 86,
 fulfillment_zero_ok boolean NOT NULL DEFAULT true, teto_mensal integer NOT NULL,
 teto_escalonamento jsonb,skus_permitidos text[] NOT NULL DEFAULT '{}',sku_regex text,
 atualizado_em timestamptz NOT NULL DEFAULT now(),atualizado_por text,
 cobranca_modo text NOT NULL DEFAULT 'pausado',cobranca_max_dia integer NOT NULL DEFAULT 15,
 cobranca_dias_entre integer NOT NULL DEFAULT 7,cobranca_max_tentativas integer NOT NULL DEFAULT 3);
 INSERT INTO crm_tts_regra(marca,gmv_auto,gmv_manual,teto_mensal,sku_regex,skus_permitidos,teto_escalonamento)
 VALUES('fish',100,10,5,'fixture-sku',ARRAY['fixture'],'[{"teto":6}]'),('aristo',80,20,4,NULL,'{}',NULL);`;
async function suite(db){
 const migration=fs.readFileSync(path.join(__dirname,'../n8n/tiktok/regra-update.sql'),'utf8');
 const row=async(brand='fish')=>(await db.query('SELECT to_jsonb(r) AS rule FROM crm_tts_regra r WHERE marca=$1',[brand])).rows[0]?.rule;
 const patch=async(p,expected=null,brand='fish',author='synthetic')=>(await db.query('SELECT crm_tts_regra_patch_v1($1,$2::jsonb,$3,$4) AS result',[brand,JSON.stringify(p),author,expected])).rows[0].result;
 await db.exec(SCHEMA);const before=await row();await db.exec(migration);await db.exec(migration);assert.deepEqual(await row(),before,'install/reinstall never writes existing rules');
 for(const p of [{gmv_auto:9},{gmv_manual:101},{gmv_auto:2,gmv_manual:3}]){
  const r=await patch(p);assert.equal(r.codigo,'gmv_incompativel');assert.deepEqual(r.regra_atual,before);assert.deepEqual(await row(),before);
 }
 for(const p of [{gmv_auto:null},{gmv_auto:true},{gmv_auto:'200'},[],{unknown:1},{teto_mensal:2.1},{cobranca_dias_entre:0}])assert.equal((await patch(p)).ok,false);
 assert.equal((await patch({modo:'unknown'})).codigo,'modo_invalido');
 for(const field of ['modo','cobranca_modo']){
  const r=await patch({[field]:'ativo'},before.atualizado_em);assert.equal(r.codigo,'ativacao_bloqueada');assert.deepEqual(r.regra_atual,before);
 }
 assert.equal((await patch({modo:'pausado'})).codigo,'versao_obrigatoria');
 assert.equal((await patch({modo:'pausado'},'not a date')).codigo,'versao_invalida');
 assert.equal((await patch({gmv_auto:110},'2000-01-01T00:00:00Z')).codigo,'regra_alterada');
 let good=await patch({gmv_auto:110});assert.equal(good.ok,true);assert.equal(good.regra_atual.gmv_manual,10);
 assert.deepEqual(good.regra_atual.skus_permitidos,['fixture']);assert.equal(good.regra_atual.sku_regex,'fixture-sku');assert.equal(good.regra_atual.cobranca_modo,'pausado');
 const stale=await patch({modo:'pausado',gmv_auto:100},before.atualizado_em);assert.equal(stale.codigo,'regra_alterada');assert.deepEqual(stale.regra_atual,good.regra_atual,'rejection returns latest committed row');
 good=await patch({modo:'pausado'},good.regra_atual.atualizado_em);assert.equal(good.ok,true);assert.equal(good.regra_atual.gmv_auto,110);assert.equal(good.regra_atual.modo,'pausado');
 good=await patch({cobranca_modo:'dry_run'},good.regra_atual.atualizado_em);assert.equal(good.ok,true);assert.equal(good.regra_atual.modo,'pausado');
 good=await patch({gmv_auto:5,gmv_manual:5});assert.equal(good.ok,true);assert.equal(good.regra_atual.gmv_manual,5);
 assert.equal((await patch({gmv_auto:4.999,gmv_manual:5.001})).ok,true,'validation matches persisted cents, no false sub-cent difference');
 assert.equal((await patch({gmv_auto:4.99,gmv_manual:5.01})).codigo,'gmv_incompativel');
 assert.equal((await patch({gmv_auto:1},null,'missing')).regra_atual,null);
 const injection="fixture', modo='ativo'; --";good=await patch({teto_mensal:6},null,'fish',injection);assert.equal(good.regra_atual.modo,'pausado');assert.equal(good.regra_atual.atualizado_por,injection+' (painel)');
 // Preserve a pre-existing active mode on an unrelated patch; cannot request activation.
 await db.exec("UPDATE crm_tts_regra SET modo='ativo' WHERE marca='aristo'");
 const aristo=await patch({gmv_auto:90},null,'aristo');assert.equal(aristo.regra_atual.modo,'ativo');
 assert.equal((await patch({modo:'ativo'},aristo.regra_atual.atualizado_em,'aristo')).codigo,'ativacao_bloqueada');
 // A broken pre-existing counterpart is not silently carried into a successful update.
 await db.exec("UPDATE crm_tts_regra SET fulfillment_min=101 WHERE marca='aristo'");
 assert.equal((await patch({gmv_auto:95},null,'aristo')).codigo,'regra_final_invalida');
 // The single UPDATE and its audit fields roll back together if storage fails.
 await db.exec(`CREATE FUNCTION synthetic_reject_update() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic store failure'; END$$;
 CREATE TRIGGER synthetic_failure BEFORE UPDATE ON crm_tts_regra FOR EACH ROW EXECUTE FUNCTION synthetic_reject_update();`);
 const stable=await row();await assert.rejects(patch({teto_mensal:7}),/synthetic store failure/);assert.deepEqual(await row(),stable);
 await db.exec('CREATE ROLE synthetic_unprivileged; SET ROLE synthetic_unprivileged');
 await assert.rejects(patch({gmv_auto:100}),/permission denied/);await db.exec('RESET ROLE');
 console.log('PASS TikTok regra SQL: full locked rule, partial patches, strict types, fresh rejection, version conflict, activation blocked, unchanged modes, rollback, restricted execution; synthetic only.');
}
module.exports={SCHEMA,suite};
if(require.main===module)(async()=>{const {PGlite}=require(process.env.TTS_PGLITE_MODULE||process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');const db=new PGlite();try{await suite(db);}finally{await db.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
