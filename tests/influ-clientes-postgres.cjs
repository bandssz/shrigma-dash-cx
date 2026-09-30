// Clientes novos por creator: 1º pedido na loja conta como novo; recompra à parte; sem índice nunca vira novo.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
(async()=>{
 const db=new PGlite();let checks=0;
 await db.exec(`CREATE TABLE crm_influ_pedido(marca text,order_id text,dia date,influ text,pago boolean,receita_base numeric);
  CREATE TABLE crm_attribution_order_v2(brand text,order_id text,payload jsonb);
  INSERT INTO crm_influ_pedido VALUES
   ('aristo','1','2026-09-02','capivara',true,100),('aristo','2','2026-09-03','capivara',true,100),
   ('aristo','3','2026-09-04','capivara',true,100),('aristo','4','2026-09-05','capivara',false,100),
   ('aristo','5','2026-08-30','capivara',true,100),('aristo','6','2026-09-06',NULL,true,100),
   ('aristo','7','2026-09-07','capivara',true,100),('fish','8','2026-09-08','pedro',true,50);
  INSERT INTO crm_attribution_order_v2 VALUES
   ('aristo','gid://shopify/Order/1','{"customer_order_index":1}'),('aristo','gid://shopify/Order/2','{"customer_order_index":3}'),
   ('aristo','gid://shopify/Order/4','{"customer_order_index":1}'),('aristo','gid://shopify/Order/5','{"customer_order_index":1}'),
   ('aristo','gid://shopify/Order/6','{"customer_order_index":1}'),('aristo','gid://shopify/Order/7','{"customer_order_index":"x"}'),
   ('fish','gid://shopify/Order/8','{"customer_order_index":1}'),('aristo','gid://shopify/Order/8','{"customer_order_index":2}');`);
 const sql=fs.readFileSync(path.join(__dirname,'../n8n/influs/clientes-novos.sql'),'utf8');await db.exec(sql);await db.exec(sql);checks++;
 const r=(await db.query("SELECT * FROM crm_influ_clientes_v1('2026-09-01','2026-09-30') ORDER BY marca,influ")).rows;
 assert.equal(r.length,2,'pedido sem creator fica fora');checks++;
 const cap=r.find(x=>x.influ==='capivara');
 assert.deepEqual([cap.pedidos,cap.novos,cap.recorrentes,cap.sem_indice],[4,1,1,2],'pago no período; 3 fora do ledger e 7 com índice inválido = sem índice');checks++;
 const pe=r.find(x=>x.influ==='pedro');
 assert.deepEqual([pe.pedidos,pe.novos,pe.recorrentes],[1,1,0],'o casamento respeita a marca');checks++;
 const W=require('../n8n/influs/api-clientes-patch.cjs');
 const fresh={id:W.WORKFLOW_ID,versionId:'v1',activeVersionId:'v1',nodes:[{name:'Monta SQL',parameters:{jsCode:'x\n'+W.ANCORA+'y'}}]};
 const out=W.patchWorkflow(fresh,{expectedVersionId:'v1'});
 assert.match(out.nodes[0].parameters.jsCode,/'clientes'/);assert.equal(fresh.nodes[0].parameters.jsCode.includes("'clientes'"),false,'não muta o original');checks++;
 assert.throws(()=>W.patchWorkflow(out,{expectedVersionId:'v1'}),/ja aplicado/);assert.throws(()=>W.patchWorkflow(fresh,{expectedVersionId:'v2'}),/Versao/);checks++;
 console.log(`influ-clientes-postgres: ${checks} checks ok`);
})().catch(e=>{console.error(e);process.exit(1);});
