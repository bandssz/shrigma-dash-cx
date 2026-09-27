// Parceiros do site — comissão de 5% (27/09/2026). PGlite com as migrações reais, dados sintéticos.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const P=require('../n8n/creators/partner-operacao.cjs');
const sql=f=>fs.readFileSync(path.join(__dirname,'../n8n/creators',f),'utf8');
async function base(){
 const db=new PGlite();
 await db.exec(`CREATE TABLE crm_influ(marca text,influ text,PRIMARY KEY(marca,influ));
  CREATE TABLE crm_influ_pedido(marca text,order_id text,influ text,dia date,via text,pago boolean,receita_base numeric);
  CREATE FUNCTION shrigma_panel_operator_v1(text,text) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
  CREATE TABLE crm_organico_attribution_order_v2(marca text,order_id text,dia date,model text,utm_source text,utm_content text,receita_liquida numeric);`);
 for(const f of ['pilot.sql','partner-link.sql','partner-commission-base.sql'])await db.exec(sql(f));
 await db.exec(P.SQL);return db;
}
(async()=>{
 let db=await base();
 const rates=async()=>(await db.query('SELECT marca,rate::float r,version FROM crm_partner_program_v1 ORDER BY marca')).rows;
 const antes=await rates();assert.deepEqual(antes.map(x=>x.r),[0.07,0.07]);
 await db.exec(sql('partner-comissao.sql'));await db.exec(sql('partner-comissao.sql'));
 const depois=await rates();assert.deepEqual(depois.map(x=>x.r),[0.05,0.05]);
 assert.deepEqual(depois.map(x=>x.version),antes.map(x=>x.version+1),'versão sobe uma vez só');
 await assert.rejects(db.query('UPDATE crm_partner_program_v1 SET rate=0.5'),/rate_ck/);
 await assert.rejects(db.query('UPDATE crm_partner_program_v1 SET rate=0'),/rate_ck/);
 assert.equal((await db.query("SELECT crm_creator_pilot_read_v1('2026-09-01','2026-09-30') AS p")).rows[0].p.programs[0].rate,0.05);
 // Com base de comissão já coletada, a mudança de taxa é recusada (precisaria de vigência por data).
 db=await base();
 await db.query("INSERT INTO crm_partner_commission_base_v1(marca,order_id,dia,moeda,subtotal_apos_descontos,base_elegivel,base_exata,detalhes_completos,partner_ref,coletado_em) VALUES('aristo','gid://shopify/Order/1','2026-09-05','BRL',10,10,true,true,'p-00000000',now())");
 await assert.rejects(db.exec(sql('partner-comissao.sql')),/vigência/);
 console.log('partner-comissao-postgres: ok');
})().catch(e=>{console.error(e);process.exit(1);});
