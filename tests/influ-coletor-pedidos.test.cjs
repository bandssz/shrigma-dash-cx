'use strict';
// Coletor de pedidos por cupom: código gerado roda num VM com a resposta sintética da Shopify e o SQL
// produzido roda num Postgres real (PGlite). Nenhuma chamada externa.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const P=require('../n8n/influs/coletor-pedidos-patch.cjs');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');

const janelaJson=(input={})=>vm.runInNewContext(`(()=>{${P.JANELA}})()`,{$json:input,Date})[0].json;
function monta(marca,page,{runIndex=0,janela={desde:'2026-09-01',ate:'2026-09-27'}}={}){
 const nodes={[marca==='aristo'?'Shopify aristo':'Shopify fish']:page,Janela:janela};
 const $=name=>({first:()=>({json:nodes[name]})});
 return vm.runInNewContext(`(()=>{${P.montaCode(marca)}})()`,{$,$runIndex:runIndex,Intl,Date,JSON,String,Number})[0].json;
}
const order=(id,created,status,codes,sub)=>({id:'gid://shopify/Order/'+id,createdAt:created,displayFinancialStatus:status,discountCodes:codes,
 currentSubtotalPriceSet:{shopMoney:{amount:String(sub)}},totalShippingPriceSet:{shopMoney:{amount:'10'}},netPaymentSet:{shopMoney:{amount:String(sub)}},totalRefundedSet:{shopMoney:{amount:'0'}}});
const page=(nodes,hasNextPage=false)=>({data:{orders:{pageInfo:{hasNextPage,endCursor:hasNextPage?'c2':null},nodes}}});

async function banco(){
 const db=new PGlite();
 await db.exec(`
  CREATE TABLE crm_influ(marca text, influ text, comissao_pct numeric, PRIMARY KEY(marca,influ));
  CREATE TABLE crm_cupom(marca text, codigo text, tipo text, influ text, PRIMARY KEY(marca,codigo));
  CREATE TABLE crm_influ_termo(marca text, influ text, vigente_desde date, modelo text, comissao_pct numeric, PRIMARY KEY(marca,influ,vigente_desde));
  CREATE TABLE crm_influ_pedido(marca text NOT NULL, order_id text NOT NULL, dia date, influ text, via text,
    cupom_usado text, todos_cupons text, receita_base numeric, frete numeric, net_payment numeric, reembolsado numeric,
    comissao_pct_aplicada numeric, comissao numeric, pago boolean, status_financeiro text, conflito_influ text,
    coletado_em timestamptz, atualizado_em timestamptz, PRIMARY KEY(marca,order_id));
  CREATE TABLE crm_influ_saude(lane text, marca text, ok boolean, detalhe text, em timestamptz, itens integer, PRIMARY KEY(lane,marca));
  INSERT INTO crm_influ VALUES('aristo','capivara',0.10),('aristo','maeda',0.05),('aristo','semtermo',0.07);
  INSERT INTO crm_cupom VALUES('aristo','CAPIVARA','influ','capivara'),('aristo','MAEDA','influ','maeda'),
    ('aristo','SEMTERMO','influ','semtermo'),('aristo','PRIMEIRACOMPRA','crm',NULL),('aristo','NOVO','pendente',NULL);
  -- maeda era permuta em agosto (sem %), comissão 5% a partir de setembro
  INSERT INTO crm_influ_termo VALUES('aristo','maeda','2026-05-01','permuta',NULL),('aristo','maeda','2026-09-01','comissao',0.05),
    ('aristo','capivara','2026-08-01','hibrido',0.10);`);
 return db;
}

test('janela usa UTC explícito de Brasília com fim exclusivo e recusa datas trocadas',()=>{
 assert.deepEqual((({desde,ate,q_ini,q_fim})=>({desde,ate,q_ini,q_fim}))(janelaJson({desde:'2026-09-01',ate:'2026-09-25'})),
  {desde:'2026-09-01',ate:'2026-09-25',q_ini:'2026-09-01T03:00:00Z',q_fim:'2026-09-26T03:00:00Z'});
 assert.equal(janelaJson({desde:'2026-08-31',ate:'2026-08-31'}).q_fim,'2026-09-01T03:00:00Z','virada de mês');
 assert.throws(()=>janelaJson({desde:'2026-09-10',ate:'2026-09-01'}),/janela invalida/);
 const rolante=janelaJson({});assert.match(rolante.desde,/^\d{4}-\d{2}-\d{2}$/);assert.match(rolante.q_fim,/T03:00:00Z$/);
});

test('busca Shopify não filtra status e usa a janela com aspas',()=>{
 const expr=P.jsonBody();assert(expr.startsWith('={{ ')&&expr.endsWith(' }}'));
 const J={q_ini:'2026-09-01T03:00:00Z',q_fim:'2026-09-26T03:00:00Z'};
 const body=JSON.parse(vm.runInNewContext(expr.slice(4,-3),{JSON,$json:{after:'abc'},$:()=>({first:()=>({json:J})})}));
 assert.equal(body.variables.q,"created_at:>='2026-09-01T03:00:00Z' created_at:<'2026-09-26T03:00:00Z'");
 assert.equal(body.variables.after,'abc');
 assert.doesNotMatch(body.variables.q,/financial_status/,'não pago também precisa voltar para explicar o relatório');
 assert.match(body.query,/displayFinancialStatus/);
});

test('erro GraphQL grava saúde ok=false e para a paginação em vez de virar zero pedidos',()=>{
 const r=monta('fish',{errors:[{message:'Access denied for orders field'}]},{runIndex:2});
 assert.equal(r.hasNext,false);assert.equal(r.n,0);
 assert.match(r.sql,/'coleta_pedidos','fish',false/);assert.match(r.sql,/pagina 3: \\?"?Access denied/);
 const vazio=monta('fish',{data:{}});assert.match(vazio.sql,/,false,/,'resposta sem orders também é falha');
});

test('saúde ok só na última página, com páginas lidas; páginas intermediárias não declaram sucesso',()=>{
 const meio=monta('aristo',page([order(1,'2026-09-02T12:00:00Z','PAID',['CAPIVARA'],100)],true));
 assert.equal(meio.hasNext,true);assert.doesNotMatch(meio.sql,/crm_influ_saude/);
 const fim=monta('aristo',page([],false),{runIndex:3});
 assert.match(fim.sql,/'coleta_pedidos','aristo',true,'4 pagina\(s\) lidas/);assert.match(fim.sql,/SELECT 0 AS gravados$/);
});

test('SQL gerado: não pago entra com pago=false e sem comissão; % vem do termo na data; histórico não é reescrito',async()=>{
 const db=await banco();
 // pedido de agosto da maeda já apurado sem comissão; e pedido de julho do capivara (antes do primeiro termo) já com 10%
 await db.exec(`INSERT INTO crm_influ_pedido(marca,order_id,dia,influ,via,cupom_usado,todos_cupons,receita_base,comissao_pct_aplicada,comissao,pago,status_financeiro)
   VALUES('aristo','70','2026-07-20','capivara','cupom','CAPIVARA','CAPIVARA',100,0.10,10,true,'PAID')`);
 const r=monta('aristo',page([
  order(10,'2026-09-02T12:00:00Z','PAID',['CAPIVARA'],100),
  order(11,'2026-09-02T13:00:00Z','EXPIRED',['CAPIVARA'],80),
  order(12,'2026-09-03T02:59:59Z','PENDING',['CAPIVARA'],20),          // 23:59 de 02/09 em Brasília
  order(20,'2026-08-20T12:00:00Z','PAID',['MAEDA'],200),              // termo permuta: sem %
  order(21,'2026-09-05T12:00:00Z','PARTIALLY_REFUNDED',['MAEDA'],50), // termo comissão 5%
  order(30,'2026-09-05T12:00:00Z','PAID',['SEMTERMO'],100),           // sem termo: % do cadastro
  order(40,'2026-09-05T12:00:00Z','PAID',['PRIMEIRACOMPRA'],90),      // CRM: fora da lane
  order(41,'2026-09-05T12:00:00Z','PAID',['NOVO'],60),                // pendente: entra sem dono
  order(42,'2026-09-05T12:00:00Z','PAID',['APOSENTADO'],30),          // sem cadastro: desconhecido
  order(70,'2026-07-20T12:00:00Z','PAID',['CAPIVARA'],100),            // antes do primeiro termo
  order(99,'2026-09-05T12:00:00Z','PAID',[],300)]));                  // sem cupom: ignorado
 const out=(await db.exec(r.sql)).at(-1).rows[0];
 assert.equal(Number(out.gravados),9);assert.equal(Number(out.fora_da_lane),1);assert.equal(Number(out.cupom_desconhecido),2,'pendente e desconhecido, como antes');
 const p=Object.fromEntries((await db.query('SELECT * FROM crm_influ_pedido')).rows.map(x=>[x.order_id,x]));
 assert.equal(p['11'].pago,false);assert.equal(p['11'].status_financeiro,'EXPIRED');assert.equal(p['11'].comissao,null);
 assert.equal(p['12'].dia.toISOString().slice(0,10),'2026-09-02','dia comercial de Brasília');
 assert.equal(Number(p['10'].comissao),10);
 assert.equal(p['20'].comissao_pct_aplicada,null,'agosto da maeda segue permuta, sem comissão');assert.equal(p['20'].comissao,null);
 assert.equal(Number(p['21'].comissao_pct_aplicada),0.05);assert.equal(Number(p['21'].comissao),2.5);
 assert.equal(Number(p['30'].comissao_pct_aplicada),0.07,'sem termo mantém a regra anterior');
 assert.equal(p['40'],undefined);assert.equal(p['41'].influ,'(pendente)');assert.equal(p['42'].influ,'(desconhecido)');
 assert.equal(Number(p['70'].comissao_pct_aplicada),0.10,'antes do primeiro termo o % apurado é preservado');
 assert.equal(p['99'],undefined);
 // Recoleta depois de mudar o cadastro: o % atual não invade o mês anterior
 await db.exec("UPDATE crm_influ SET comissao_pct=0.05 WHERE influ='capivara'; UPDATE crm_influ_termo SET comissao_pct=0.10 WHERE influ='capivara'");
 await db.exec("UPDATE crm_influ SET comissao_pct=0.08 WHERE influ='maeda'");
 const again=monta('aristo',page([order(20,'2026-08-20T12:00:00Z','PAID',['MAEDA'],200),order(11,'2026-09-02T13:00:00Z','PAID',['CAPIVARA'],80)]));
 await db.exec(again.sql);
 const q=Object.fromEntries((await db.query("SELECT * FROM crm_influ_pedido WHERE order_id IN ('20','11')")).rows.map(x=>[x.order_id,x]));
 assert.equal(q['20'].comissao,null,'mudar o cadastro não reescreve agosto');
 assert.equal(q['11'].pago,true,'PIX pago depois vira receita na recoleta');assert.equal(Number(q['11'].comissao),8);
 const s=(await db.query('SELECT * FROM crm_influ_saude')).rows;assert.equal(s.length,1);assert(s.every(x=>x.ok&&x.lane==='coleta_pedidos'));
});

test('patch recusa versão diferente ou nós divergentes e troca só Janela, busca e upsert',()=>{
 const base=()=>({id:P.WORKFLOW_ID,versionId:'v1',activeVersionId:'v1',nodes:[
  {name:'Janela',parameters:{jsCode:'// recoleta rolante de 45 dias'}},
  ...['aristo','fish'].flatMap(m=>[
   {name:'Shopify '+m,parameters:{jsonBody:"x (financial_status:paid OR financial_status:partially_refunded OR financial_status:refunded)"}},
   {name:'Monta upsert '+m,parameters:{jsCode:`const MARCA = '${m}'; ON CONFLICT (marca, order_id)`}},
   {name:'Grava '+m,parameters:{query:'={{ $json.sql }}'}},{name:'Cursor '+m,parameters:{jsCode:'cursor'}}]),
  {name:'Resumo',parameters:{query:'SELECT 1'}}],connections:{a:1},settings:{timezone:'America/Sao_Paulo'}});
 assert.throws(()=>P.patchWorkflow(base(),{expectedVersionId:'v0'}),/Versao/);
 const drift=base();drift.nodes[1].parameters.jsonBody='outra busca';assert.throws(()=>P.patchWorkflow(drift,{expectedVersionId:'v1'}),/divergente/);
 const fresh=base(),w=P.patchWorkflow(fresh,{expectedVersionId:'v1'});
 assert.notEqual(w,fresh);assert.equal(fresh.nodes[0].parameters.jsCode,'// recoleta rolante de 45 dias','entrada intacta');
 const muda=w.nodes.filter((n,i)=>JSON.stringify(n)!==JSON.stringify(fresh.nodes[i])).map(n=>n.name);
 assert.deepEqual(muda,['Janela','Shopify aristo','Monta upsert aristo','Shopify fish','Monta upsert fish']);
 assert.deepEqual(w.connections,fresh.connections);assert.deepEqual(w.settings,fresh.settings);
});
