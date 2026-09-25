const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const C=require('../n8n/creators/partner-base-collector.cjs'),{order,money,refund}=require('./fixtures/partner-base-synthetic.cjs');
test('SQL financeiro: refresh, ordem temporal, isolamento, reconciliação e pagamento desligado',async()=>{
 const db=new PGlite();try{
 await db.exec(`CREATE TABLE crm_partner_program_v1(marca text PRIMARY KEY,rate numeric);INSERT INTO crm_partner_program_v1 VALUES('aristo',0.07),('fish',0.07);
 CREATE TABLE crm_partner_candidate_v1(id text PRIMARY KEY,name text,state text);INSERT INTO crm_partner_candidate_v1 VALUES('c','Synthetic','aprovado_piloto');
 CREATE TABLE crm_partner_link_v1(ref text PRIMARY KEY,candidate_id text,marca text,state text,version int,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 INSERT INTO crm_partner_link_v1(ref,candidate_id,marca,state,version) VALUES('p-synthetic','c','aristo','ativo',1);
 CREATE FUNCTION crm_partner_link_url_v1(text,text) RETURNS text LANGUAGE sql AS $$ SELECT 'https://example.invalid/' $$;
 CREATE TABLE crm_organico_attribution_order_v2(marca text,order_id text,dia date,model text,utm_source text,utm_content text,receita_liquida numeric);
 INSERT INTO crm_organico_attribution_order_v2 VALUES('aristo','1','2026-09-10','last_click','parceiro','p-synthetic',120),('fish','2','2026-09-10','last_click','parceiro','p-synthetic',120);`);
 const sql=fs.readFileSync(path.join(__dirname,'../n8n/creators/partner-commission-base.sql'),'utf8');await db.exec(sql);await db.exec(sql);
 const pending=async()=>(await db.query("SELECT crm_partner_base_pendente_v1('2026-09-01','2026-09-24') AS r")).rows[0].r;
 const read=async()=>(await db.query("SELECT crm_partner_link_read_v1('2026-09-01','2026-09-24') AS r")).rows[0].r;
 const ingest=async rows=>(await db.query('SELECT crm_partner_base_ingest_v1($1::jsonb) AS r',[JSON.stringify({rows})])).rows[0].r;
 const make=(o=order(),stamp=new Date().toISOString())=>({...C.linhaDeBase(o,'aristo',stamp),order_id:'1'});
 assert.deepEqual((await pending()).map(r=>r.order_id),['1']);
 assert.equal((await read()).partner_orders[0].comissao,null);assert.equal((await read()).partner_orders[0].comissao_fechada,false);
 const paid=make();assert.equal((await ingest([paid])).rows,1);assert.equal((await pending()).length,0);
 let r=await read();assert.equal(r.commission_payable,false);assert.equal(r.partner_orders[0].comissao,7);assert.equal(r.partner_orders[0].comissao_fechada,true);
 assert.equal((await ingest([paid])).ignored_older,1);
 const refunded=make(order({updatedAt:'2026-09-11T15:00:00Z',displayFinancialStatus:'PARTIALLY_REFUNDED',totalRefundedSet:money(30),refunds:[refund({items:30})]}),new Date(Date.now()-1000).toISOString());
 assert.equal((await ingest([refunded])).rows,1,'source revision outranks ingest arrival time');
 assert.equal((await ingest([{...paid,coletado_em:new Date().toISOString()}])).ignored_older,1,'older Shopify revision cannot restore paid amount');
 assert.equal((await read()).partner_orders[0].comissao,4.9);
 for(const [i,o] of [
  order({totalRefundedSet:money(20),refunds:[refund({amount:20})]}),
  order({totalRefundedSet:money(20),refunds:[refund({shipping:20})]}),
  order({totalRefundedSet:money(33),refunds:[refund({items:30,itemTax:3})]}),
  order({taxesIncluded:true,totalRefundedSet:money(33),refunds:[refund({items:30,itemTax:3})]}),
  order({test:true}),order({displayFinancialStatus:'PENDING'})
 ].entries()){
  const row=make({...o,updatedAt:`2026-09-${12+i}T15:00:00Z`});await ingest([row]);
  const stored=(await db.query('SELECT base_elegivel,base_exata FROM crm_partner_commission_base_v1')).rows[0],expected=C.baseElegivel(row);
  assert.equal(Number(stored.base_elegivel),expected.base_elegivel);assert.equal(stored.base_exata,expected.base_exata);
 }
 await db.exec("UPDATE crm_partner_commission_base_v1 SET coletado_em=now()-interval '25 hours'");
 assert.equal((await pending()).length,1,'late refunds are refreshed');assert.equal((await read()).partner_orders[0].comissao,null);
 await db.exec("UPDATE crm_partner_commission_base_v1 SET base_exata=true,detalhes_completos=false,coletado_em=now(),fonte_atualizada_em=NULL");
 assert.equal((await pending()).length,1);assert.equal((await read()).partner_orders[0].comissao_fechada,false,'legacy rows cannot close');
 await assert.rejects(ingest([paid,paid]),/Duplicate/);
 await assert.rejects(ingest([{...paid,marca:'fish',order_id:'2'}]),/registered partner/);
 await assert.rejects(ingest([{...paid,subtotal_apos_descontos:null}]),/Invalid financial/);
 await assert.rejects(ingest([{...paid,coletado_em:null}]),/timestamp/);
 await assert.rejects(ingest([{...paid,moeda:'USD'}]),/scope/);
 await db.exec("DELETE FROM crm_organico_attribution_order_v2 WHERE marca='aristo' AND order_id='1'");
 assert.equal((await pending()).length,1,'existing snapshot survives exclusion from attribution');
 const full=make(order({updatedAt:'2026-09-23T15:00:00Z',displayFinancialStatus:'REFUNDED',totalRefundedSet:money(120),refunds:[refund({items:100,shipping:20})]}));
 assert.equal((await ingest([full])).rows,1);
 assert.equal(Number((await db.query('SELECT base_elegivel FROM crm_partner_commission_base_v1')).rows[0].base_elegivel),0);
 assert.equal((await read()).partner_orders.length,0,'refund history must not restore old attributed revenue');
 assert.equal((await db.query('SELECT partner_ref FROM crm_partner_commission_base_v1')).rows[0].partner_ref,'p-synthetic');
 await db.exec("INSERT INTO crm_partner_link_v1(ref,candidate_id,marca,state,version) VALUES('p-other','c','aristo','ativo',1);INSERT INTO crm_organico_attribution_order_v2 VALUES('aristo','1','2026-09-10','last_click','parceiro','p-other',120)");
 await assert.rejects(ingest([full]),/partner cannot change/);
 assert.equal((await read()).partner_orders[0].comissao,null,'old snapshot cannot pay a different partner');
 await assert.rejects(db.query("SELECT crm_partner_base_pendente_v1('2026-09-24','2026-09-01')"),/window/);
 await db.exec("INSERT INTO crm_organico_attribution_order_v2 SELECT 'aristo',g::text,'2026-09-09'::date,'last_click','parceiro','p-synthetic',120 FROM generate_series(100,301) g");
 const firstBatch=await pending();assert.equal(firstBatch.length,200);
 for(const p of firstBatch)await db.query('SELECT crm_partner_base_failure_v1($1::jsonb)',[JSON.stringify(p)]);
 const secondBatch=await pending();assert.ok(secondBatch.some(p=>!firstBatch.some(f=>f.order_id===p.order_id)),'failed old batch cannot starve untouched orders');
 await assert.rejects(db.query('SELECT crm_partner_base_failure_v1($1::jsonb)',[JSON.stringify({marca:'fish',order_id:'999999'})]),/scope/);
 assert.equal((await read()).commission_payable,false);
 }finally{await db.close();}
});
