'use strict';
// Relatório Shopify por cupom: janela, expressão da consulta, falhas e SQL contra PGlite com a migração real.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const R=require('../n8n/influs/relatorio-shopify-workflow.cjs');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const CHAVE='chave-sintetica-de-teste-0001';
const janela=(input,now='2026-09-26T15:00:00Z')=>{
 const RealDate=Date;class FakeDate extends RealDate{constructor(...a){super(...(a.length?a:[now]));}static now(){return new RealDate(now).getTime();}}
 return JSON.parse(JSON.stringify(vm.runInNewContext(`(()=>{${R.janelaCode(CHAVE)}})()`,{$json:input,Date:FakeDate,Intl,String})[0].json));
};
const monta=(marca,resp,J={desde:'2026-09-01',ate:'2026-09-03'})=>vm.runInNewContext(`(()=>{${R.montaCode(marca)}})()`,
 {$:name=>({first:()=>({json:name==='Janela'?J:resp})}),JSON,String,Number})[0].json;

test('agendado cobre 45 dias até ontem em Brasília; manual respeita a chave e nunca inclui hoje',()=>{
 assert.deepEqual(janela({}),{desde:'2026-08-12',ate:'2026-09-25'});
 assert.deepEqual(janela({},'2026-09-27T02:30:00Z'),{desde:'2026-08-12',ate:'2026-09-25'},'23:30 de 26/09 em Brasília ainda é dia 26');
 assert.deepEqual(janela({body:{k:CHAVE,desde:'2026-05-19',ate:'2026-09-30'}}),{desde:'2026-05-19',ate:'2026-09-25'});
 assert.throws(()=>janela({body:{k:'errada'}}),/chave invalida/);
 assert.throws(()=>janela({body:{k:CHAVE,desde:'2026-09-25',ate:'2026-09-01'}}),/janela invalida/);
 assert.throws(()=>R.janelaCode('curta'),/chave/);
});

test('consulta ShopifyQL agrupa por código e dia, sem cupom vazio, no período pedido',()=>{
 const expr=R.jsonBody();const body=JSON.parse(vm.runInNewContext(expr.slice(4,-3),{JSON,$json:{desde:'2026-09-01',ate:'2026-09-25'}}));
 assert.equal(body.variables.q,`FROM sales SHOW orders, gross_sales, discounts, returns, net_sales WHERE discount_code IS NOT NULL GROUP BY discount_code TIMESERIES day SINCE 2026-09-01 UNTIL 2026-09-25 LIMIT ${R.LIMITE}`);
 assert.match(body.query,/shopifyqlQuery\(query: \$q\)/);
});

test('erro de permissão, parse ou limite vira saúde ok=false e não grava relatório',()=>{
 for(const resp of [{errors:[{message:'Access denied'}]},{data:{shopifyqlQuery:{parseErrors:['bad'],tableData:null}}},{data:{}},
   {data:{shopifyqlQuery:{parseErrors:[],tableData:{rows:Array(R.LIMITE).fill({day:'2026-09-01',discount_code:'X',orders:'1'})}}}}]){
  const {sql}=monta('fish',resp);
  assert.match(sql,/'relatorio_shopify','fish',false/);assert.doesNotMatch(sql,/crm_influ_shopify_relatorio /);
 }
});

test('workflow novo: agenda 04:35, backfill por POST, credenciais existentes e nenhuma credencial embutida',()=>{
 const w=R.buildWorkflow({chave:CHAVE,webhookPath:'crm-influ-relatorio-shopify-0a1b2c3d'});
 assert.deepEqual(w.nodes.map(n=>n.name),['Diario 04:35','POST backfill','Janela','ShopifyQL aristo','Monta aristo','Grava aristo','ShopifyQL fish','Monta fish','Grava fish']);
 assert.equal(w.nodes.find(n=>n.name==='ShopifyQL fish').credentials.httpHeaderAuth.id,'Xv9XgNyJ1wyJFCTJ');
 assert.equal(w.nodes.find(n=>n.name==='ShopifyQL aristo').parameters.url,`https://gwx20u-vw.myshopify.com/admin/api/${R.API_VERSION}/graphql.json`);
 assert.doesNotMatch(JSON.stringify(w),/shpat_|X-Shopify-Access-Token/);
 assert.deepEqual(w.connections.Janela.main[0].map(x=>x.node),['ShopifyQL aristo','ShopifyQL fish']);
 assert.equal(w.nodes.find(n=>n.name==='POST backfill').webhookId,'crm-influ-relatorio-shopify-0a1b2c3d','sem webhookId o n8n não registra a URL de produção');
 assert.throws(()=>R.buildWorkflow({chave:CHAVE,webhookPath:'qualquer'}),/webhook/);
});

test('SQL grava dia×cupom, marca cobertura, remove linha que sumiu da Shopify e alimenta a conferência',async()=>{
 const db=new PGlite();
 await db.exec(`CREATE TABLE crm_influ(marca text, influ text, PRIMARY KEY(marca,influ));
  CREATE TABLE crm_cupom(marca text, codigo text, tipo text, influ text, PRIMARY KEY(marca,codigo));
  CREATE TABLE crm_influ_pedido(marca text, order_id text, dia date, influ text, cupom_usado text, todos_cupons text,
    receita_base numeric, frete numeric, reembolsado numeric, comissao numeric, pago boolean, status_financeiro text, atualizado_em timestamptz, PRIMARY KEY(marca,order_id));
  CREATE TABLE crm_influ_saude(lane text, marca text, ok boolean, detalhe text, em timestamptz, PRIMARY KEY(lane,marca));`);
 await db.exec(fs.readFileSync(path.join(__dirname,'../n8n/influs/conciliacao.sql'),'utf8'));
 await db.exec(`INSERT INTO crm_influ_shopify_relatorio(marca,dia,codigo,pedidos,vendas_liquidas) VALUES('aristo','2026-09-02','ANTIGO',1,10),('aristo','2026-08-31','FORA',1,10);
  INSERT INTO crm_cupom VALUES('aristo','CAPIVARA','influ',NULL);`.replace("'influ',NULL","'pendente',NULL"));
 const rows=[{day:'2026-09-01',discount_code:'capivara',orders:'17',gross_sales:'2582.6',discounts:'-154.91',returns:'0',net_sales:'2427.69'},
  {day:'2026-09-02',discount_code:'CAPIVARA',orders:'2',gross_sales:'300',discounts:'-20',returns:'-194.58',net_sales:'85.42'},
  {day:'2026-09-02',discount_code:'',orders:'5',net_sales:'500'}];
 const {sql}=monta('aristo',{data:{shopifyqlQuery:{parseErrors:[],tableData:{rows}}}});
 const out=(await db.exec(sql)).at(-1).rows[0];
 assert.equal(Number(out.gravados),2);assert.equal(Number(out.removidos),1);
 const rel=(await db.query("SELECT codigo,dia::text,pedidos,vendas_liquidas::text v FROM crm_influ_shopify_relatorio ORDER BY dia,codigo")).rows;
 assert.deepEqual(rel,[{codigo:'FORA',dia:'2026-08-31',pedidos:1,v:'10.00'},{codigo:'CAPIVARA',dia:'2026-09-01',pedidos:17,v:'2427.69'},{codigo:'CAPIVARA',dia:'2026-09-02',pedidos:2,v:'85.42'}],'fora da janela fica intacto; código em maiúsculas');
 assert.equal((await db.query("SELECT count(*)::int n FROM crm_influ_shopify_relatorio_cobertura WHERE marca='aristo'")).rows[0].n,3);
 const s=(await db.query("SELECT ok,itens,ultimo_ok_em IS NOT NULL t FROM crm_influ_saude WHERE lane='relatorio_shopify'")).rows[0];
 assert.deepEqual(s,{ok:true,itens:2,t:true});
 const c=(await db.query("SELECT * FROM crm_influ_conciliacao_v1('2026-09-01','2026-09-03')")).rows[0];
 assert.equal(c.codigo,'CAPIVARA');assert.equal(c.relatorio_pedidos,19);assert.equal(Number(c.relatorio_vendas_liquidas),2513.11);
 assert.equal(c.situacao,'ausente_no_painel','relatório com venda e painel sem pedido é sinalizado, não escondido');
 // dia sem nenhuma venda: cobertura marcada, zero medido
 const vazio=monta('aristo',{data:{shopifyqlQuery:{parseErrors:[],tableData:{rows:[]}}}},{desde:'2026-09-04',ate:'2026-09-04'});
 await db.exec(vazio.sql);
 assert.equal((await db.query("SELECT count(*)::int n FROM crm_influ_shopify_relatorio_cobertura WHERE dia='2026-09-04'")).rows[0].n,1);
});
