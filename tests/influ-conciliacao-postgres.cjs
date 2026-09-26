// Conferência Influs × relatório Shopify e saúde por etapa — contra Postgres real (PGlite).
// Colunas e constraints copiadas da produção em 26/09/2026. Dados sintéticos.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
(async()=>{
 const db=new PGlite();let checks=0;
 await db.exec(`
  CREATE TABLE crm_influ(marca text NOT NULL, influ text NOT NULL, PRIMARY KEY(marca,influ));
  CREATE TABLE crm_cupom(marca text NOT NULL, codigo text NOT NULL, tipo text NOT NULL, influ text,
    PRIMARY KEY(marca,codigo), CONSTRAINT ck_crm_cupom_influ CHECK ((tipo='influ')=(influ IS NOT NULL)));
  CREATE TABLE crm_influ_pedido(marca text NOT NULL, order_id text NOT NULL, dia date, influ text, via text,
    cupom_usado text, todos_cupons text, receita_base numeric, frete numeric, net_payment numeric, reembolsado numeric,
    comissao_pct_aplicada numeric, comissao numeric, pago boolean, status_financeiro text, conflito_influ text,
    coletado_em timestamptz, atualizado_em timestamptz, PRIMARY KEY(marca,order_id));
  CREATE TABLE crm_influ_saude(lane text NOT NULL, marca text NOT NULL, ok boolean, detalhe text, em timestamptz, PRIMARY KEY(lane,marca));
  INSERT INTO crm_influ_saude VALUES('sync_cupom','aristo',true,'ok','2026-09-26 06:50Z'),('sync_cupom','fish',false,'Access denied','2026-09-26 06:50Z');`);
 const sql=fs.readFileSync(path.join(__dirname,'../n8n/influs/conciliacao.sql'),'utf8');
 await db.exec(sql);await db.exec(sql);checks++; // idempotente

 // --- saúde: último sucesso sobrevive à falha seguinte; falha nunca ganha último sucesso -------
 const saude=async(lane,marca)=>(await db.query('SELECT ok,ultimo_ok_em::text u FROM crm_influ_saude WHERE lane=$1 AND marca=$2',[lane,marca])).rows[0];
 assert.equal((await saude('sync_cupom','aristo')).u,'2026-09-26 06:50:00+00');checks++;
 assert.equal((await saude('sync_cupom','fish')).u,null,'falha antiga não vira sucesso');checks++;
 const grava=(m,ok,em)=>db.query(`INSERT INTO crm_influ_saude(lane,marca,ok,detalhe,em) VALUES('sync_cupom',$1,$2,'x',$3)
   ON CONFLICT (lane,marca) DO UPDATE SET ok=EXCLUDED.ok, detalhe=EXCLUDED.detalhe, em=EXCLUDED.em`,[m,ok,em]);
 await grava('aristo',false,'2026-09-27 06:50Z');
 assert.deepEqual(await saude('sync_cupom','aristo'),{ok:false,u:'2026-09-26 06:50:00+00'});checks++;
 await grava('fish',true,'2026-09-27 06:51Z');
 assert.deepEqual(await saude('sync_cupom','fish'),{ok:true,u:'2026-09-27 06:51:00+00'});checks++;
 await db.query(`INSERT INTO crm_influ_saude(lane,marca,ok,detalhe,em) VALUES('coleta_pedidos','fish',true,'ok','2026-09-27 07:17Z')`);
 assert.equal((await saude('coleta_pedidos','fish')).u,'2026-09-27 07:17:00+00');checks++;

 // --- conferência ------------------------------------------------------------------------------
 await db.exec(`
  INSERT INTO crm_influ VALUES('aristo','capivara'),('fish','ff');
  INSERT INTO crm_cupom VALUES('aristo','CAPIVARA','influ','capivara'),('fish','CAPIVARA','pendente',NULL),
    ('aristo','PRIMEIRACOMPRA','crm',NULL),('fish','FF','influ','ff'),('aristo','SOLTINHO','nao_influ',NULL);
  INSERT INTO crm_influ_pedido(marca,order_id,dia,influ,via,cupom_usado,todos_cupons,receita_base,pago,status_financeiro,atualizado_em) VALUES
   ('aristo','1','2026-09-01','capivara','cupom','CAPIVARA','CAPIVARA',100.10,true,'PAID','2026-09-26 07:16Z'),
   ('aristo','2','2026-09-02','capivara','cupom','CAPIVARA','CAPIVARA',50.00,true,'PARTIALLY_REFUNDED','2026-09-26 07:16Z'),
   ('aristo','3','2026-09-02','capivara','cupom','CAPIVARA','CAPIVARA',80.00,false,'EXPIRED','2026-09-26 07:16Z'),
   ('aristo','4','2026-09-03','capivara','cupom','CAPIVARA','CAPIVARA',20.00,false,'PENDING','2026-09-26 07:16Z'),
   ('aristo','5','2026-08-31','capivara','cupom','CAPIVARA','CAPIVARA',999,true,'PAID','2026-09-26 07:16Z'),
   ('fish','9','2026-09-02','ff','cupom','FF','FF',70,true,'PAID','2026-09-26 07:17Z'),
   ('fish','10','2026-09-02','(desconhecido)','cupom','NOVO','NOVO',30,true,'PAID','2026-09-26 07:17Z'),
   ('aristo','20','2026-09-02','(desconhecido)','cupom','SOLTINHO','SOLTINHO',40,true,'PAID','2026-09-26 07:16Z');
  INSERT INTO crm_influ_shopify_relatorio(marca,dia,codigo,pedidos,vendas_liquidas) VALUES
   ('aristo','2026-09-01','CAPIVARA',1,100.10),('aristo','2026-09-02','CAPIVARA',2,130.00),('aristo','2026-09-03','CAPIVARA',1,20.00),
   ('aristo','2026-09-02','PRIMEIRACOMPRA',10,1500),('aristo','2026-08-31','CAPIVARA',1,999),
   ('fish','2026-09-02','FF',1,65.00),('fish','2026-09-02','NOVO',1,30),('aristo','2026-09-02','SOLTINHO',2,80);`);
 const conf=async(a,b)=>Object.fromEntries((await db.query('SELECT * FROM crm_influ_conciliacao_v1($1,$2)',[a,b])).rows.map(r=>[r.marca+'|'+r.codigo,r]));
 let c=await conf('2026-09-01','2026-09-03');
 assert.equal(c['aristo|CAPIVARA'].situacao,'relatorio_indisponivel','sem cobertura registrada a diferença é desconhecida');checks++;
 assert.equal(c['aristo|CAPIVARA'].diferenca,null);checks++;
 await db.exec(`INSERT INTO crm_influ_shopify_relatorio_cobertura(marca,dia) SELECT m,d::date FROM unnest(ARRAY['aristo','fish']) m, generate_series('2026-09-01'::date,'2026-09-02'::date,'1 day') d`);
 c=await conf('2026-09-01','2026-09-03');
 assert.equal(c['aristo|CAPIVARA'].situacao,'relatorio_parcial','um dia sem coleta não vira zero');checks++;
 await db.exec(`INSERT INTO crm_influ_shopify_relatorio_cobertura(marca,dia) VALUES('aristo','2026-09-03'),('fish','2026-09-03')`);
 c=await conf('2026-09-01','2026-09-03');
 const cap=c['aristo|CAPIVARA'];
 assert.equal(cap.situacao,'explicada_nao_pagos');checks++;
 assert.equal(cap.relatorio_pedidos,4);assert.equal(cap.pagos,2);assert.equal(cap.nao_pagos,2);checks++;
 assert.equal(Number(cap.receita_paga),150.10,'subtotal pago, sem somar não pagos');checks++;
 assert.equal(Number(cap.receita_nao_paga),100);checks++;
 assert.equal(Number(cap.diferenca),0);checks++;
 assert.deepEqual(cap.status_nao_pagos,{EXPIRED:1,PENDING:1});checks++;
 assert.equal(cap.relatorio_cobertura,'completa');checks++;
 assert.equal(c['aristo|PRIMEIRACOMPRA'].situacao,'fora_da_lente','cupom de CRM não é tratado como perda');checks++;
 assert.equal(c['aristo|SOLTINHO'].situacao,'fora_da_lente','reclassificado: linha antiga no ledger não vira diferença a investigar');checks++;
 assert.equal(c['fish|FF'].situacao,'diferenca_de_valor');assert.equal(Number(c['fish|FF'].diferenca),-5);checks++;
 assert.equal(c['fish|NOVO'].tipo,null,'cupom sem cadastro fica sem tipo, não vira influ');checks++;
 assert.equal(c['fish|NOVO'].situacao,'igual');checks++;
 assert.equal(c['fish|CAPIVARA'],undefined,'mesmo código em outra marca não herda pedidos');checks++;
 assert.equal(c['aristo|CAPIVARA'].relatorio_pedidos,4,'31/08 fora do período');checks++;

 // --- exportação por pedido --------------------------------------------------------------------
 const ped=(await db.query("SELECT * FROM crm_influ_conciliacao_pedidos_v1('2026-09-01','2026-09-03','aristo')")).rows;
 assert.deepEqual(ped.map(p=>p.order_id),['1','2','20','3','4'],'ordem por dia e pedido');checks++;
 assert.equal(ped.find(p=>p.order_id==='3').pago,false);checks++;
 assert(!Object.keys(ped[0]).some(k=>/nome|email|telefone|endereco|cliente/.test(k)),'sem dado pessoal');checks++;
 const todas=(await db.query("SELECT * FROM crm_influ_conciliacao_pedidos_v1('2026-09-01','2026-09-03','todas')")).rows;
 assert.equal(todas.length,7);checks++;
 assert.equal(todas.find(p=>p.order_id==='10').influ,'(desconhecido)');checks++;

 // --- tabela do relatório recusa código fora do padrão ------------------------------------------
 await assert.rejects(db.query("INSERT INTO crm_influ_shopify_relatorio(marca,dia,codigo) VALUES('aristo','2026-09-01','capivara')"));checks++;
 await assert.rejects(db.query("INSERT INTO crm_influ_shopify_relatorio(marca,dia,codigo) VALUES('xpto','2026-09-01','X')"));checks++;
 console.log(`influ-conciliacao-postgres: ${checks} checks ok`);
})().catch(e=>{console.error(e);process.exit(1);});
