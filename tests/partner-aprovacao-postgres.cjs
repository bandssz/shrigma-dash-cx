// Aprovação do parceiro do site: um clique cria cupom + link, cadastra em crm_influ/crm_cupom, envio pendente,
// e o pedido com o cupom do próprio parceiro não comissiona duas vezes. PGlite com as migrações reais. Dados sintéticos.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const P=require('../n8n/creators/partner-operacao.cjs'),W=require('../n8n/creators/partner-aprovacao-workflow.cjs');
const sql=f=>fs.readFileSync(path.join(__dirname,'../n8n/creators',f),'utf8');
const jpg=Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),crypto.randomBytes(300)]).toString('base64');
(async()=>{
 const db=new PGlite();let checks=0;
 await db.exec(`CREATE TABLE crm_influ(marca text NOT NULL CHECK(marca IN ('aristo','fish','olivas')),influ text NOT NULL,nome text NOT NULL DEFAULT '',handle text NOT NULL DEFAULT '',
   comissao_pct numeric,ativo boolean NOT NULL DEFAULT true,desde date,obs text NOT NULL DEFAULT '',atualizado_em timestamptz NOT NULL DEFAULT now(),seguidores integer,porte text,
   modelo text CHECK(modelo IS NULL OR modelo IN ('fixo','comissao','permuta','hibrido','encerrado')),contato text,
   nicho text CHECK(nicho IS NULL OR (nicho=lower(btrim(regexp_replace(nicho,'\\s+',' ','g'))) AND length(nicho) BETWEEN 2 AND 40)),PRIMARY KEY(marca,influ));
  CREATE TABLE crm_cupom(marca text NOT NULL,codigo text NOT NULL CHECK(codigo=upper(codigo)),tipo text NOT NULL,influ text,desconto_pct numeric,desde date,ate date,
   shopify_node_id text NOT NULL DEFAULT '',usos_lifetime integer,atualizado_em timestamptz NOT NULL DEFAULT now(),obs text NOT NULL DEFAULT '',PRIMARY KEY(marca,codigo),
   CHECK((tipo='influ')=(influ IS NOT NULL)),FOREIGN KEY(marca,influ) REFERENCES crm_influ(marca,influ));
  CREATE TABLE crm_cupom_log(id bigserial,em timestamptz NOT NULL DEFAULT now(),marca text NOT NULL,codigo text NOT NULL,campo text NOT NULL,de text,para text,autor text NOT NULL DEFAULT '',origem text NOT NULL DEFAULT '');
  CREATE TABLE crm_influ_pedido(marca text,order_id text,influ text,dia date,via text,pago boolean,receita_base numeric);
  CREATE FUNCTION shrigma_panel_operator_v1(text,text) RETURNS jsonb LANGUAGE sql AS $$ SELECT CASE WHEN $2<>'influs' THEN NULL
   WHEN $1='chave-gestao' THEN '{"who":"marcela","label":"Marcela","caps":["creators_edit"]}'::jsonb WHEN $1='chave-leitura' THEN '{"who":"leitor","label":"Leitor","caps":[]}'::jsonb END $$;`);
 await db.exec(sql('pilot.sql'));
 await db.exec('CREATE TABLE crm_organico_attribution_order_v2(marca text,order_id text,dia date,model text,utm_source text,utm_content text,receita_liquida numeric);');
 await db.exec(sql('partner-link.sql'));await db.exec(sql('partner-commission-base.sql'));await db.exec(P.SQL);await db.exec(sql('partner-comissao.sql'));
 await db.exec(sql('partner-candidatura.sql'));
 await db.exec(sql('partner-aprovacao.sql'));await db.exec(sql('partner-aprovacao.sql'));checks++; // idempotente
 assert.deepEqual((await db.query('SELECT marca,cupom_desconto::text d FROM crm_partner_program_v1 ORDER BY 1')).rows.map(r=>[r.marca,r.d]),[['aristo','0.06'],['fish','0.05']]);checks++;
 assert.equal((await db.query("SELECT crm_partner_codigo_sugerido_v1('joão.pesca_brutal') s")).rows[0].s,'JOAOPESCABRUTAL');checks++;

 // Candidatura real pelo formulário
 const texto='Termo sintético. '.repeat(20),sha=crypto.createHash('sha256').update(texto).digest('hex');
 await db.query("INSERT INTO crm_partner_terms_v1(marca,versao,titulo,texto,sha256,publicado_em) VALUES('fish',1,'Termo',$1,$2,now())",[texto,sha]);
 const envia=async(ig,extra={})=>(await db.query('SELECT crm_partner_candidatura_v1($1::jsonb) r',[JSON.stringify({acao:'enviar',marca:'fish',request_id:crypto.randomUUID(),ip:'203.0.113.'+ig.length,navegador:'t',
  data:{nome:'Pescador '+ig,email:ig+'@x.com',whatsapp:'41999060777',instagram:ig,seguidores:'1000',nicho:'Pesca  Esportiva',views_stories:'100',aceite:true,termo_versao:1,termo_sha256:sha,prints:[{mime:'image/jpeg',base64:jpg}],...extra}})])).rows[0].r;
 assert.equal((await envia('rio.bravo')).ok,true);assert.equal((await envia('outro_perfil')).ok,true);
 const cand=async ig=>(await db.query("SELECT id FROM crm_partner_candidate_v1 WHERE handle=$1",['@'+ig])).rows[0].id;
 const cid=await cand('rio.bravo'),cid2=await cand('outro_perfil');
 const ap=async p=>(await db.query('SELECT crm_partner_aprovacao_v1($1::jsonb) r',[JSON.stringify(p)])).rows[0].r;
 const G='chave-gestao',R1=crypto.randomUUID();

 // Permissão e validação
 assert.match((await ap({k:'x',acao:'ler'})).erro,/chave/);
 assert.equal((await ap({k:'chave-leitura',acao:'ler'})).pode_escrever,false);
 assert.match((await ap({k:'chave-leitura',acao:'preparar',request_id:R1,data:{candidate_id:cid,codigo:'RIOBRAVO'}})).erro,/só lê/);
 assert.equal((await ap({k:G,acao:'preparar',request_id:R1,data:{candidate_id:cid,codigo:'rio bravo'}})).campo,'codigo');
 await db.exec("INSERT INTO crm_influ(marca,influ) VALUES('fish','riobravo');INSERT INTO crm_cupom(marca,codigo,tipo) VALUES('fish','USADO','crm')");
 assert.match((await ap({k:G,acao:'preparar',request_id:R1,data:{candidate_id:cid,codigo:'usado'}})).erro,/já está cadastrado/);checks++;

 // Preparar reserva; outro candidato não pega o mesmo código; mesmo pedido devolve a mesma reserva
 const prep=await ap({k:G,acao:'preparar',request_id:R1,data:{candidate_id:cid,codigo:'riobravo'}});
 assert.deepEqual([prep.ok,prep.marca,prep.codigo,Number(prep.desconto)],[true,'fish','RIOBRAVO',0.05]);
 assert.deepEqual(await ap({k:G,acao:'preparar',request_id:R1,data:{candidate_id:cid,codigo:'OUTRO'}}),prep);
 assert.match((await ap({k:G,acao:'preparar',request_id:crypto.randomUUID(),data:{candidate_id:cid2,codigo:'RIOBRAVO'}})).erro,/reservado/);checks++;

 // Erro da Shopify volta como está e não grava nada
 const err=await ap({k:G,acao:'concluir',request_id:R1,data:{erro:'A loja Fishermans ainda não deixa o sistema criar cupom.',campo:'codigo'}});
 assert.match(err.erro,/ainda não deixa/);assert.equal((await db.query("SELECT count(*)::int n FROM crm_partner_parceiro_v1")).rows[0].n,0);
 assert.match((await ap({k:G,acao:'concluir',request_id:R1,data:{node_id:'x',origem:'criado'}})).erro,/incompleta/);checks++;

 // Concluir: tudo numa transação
 const ok=await ap({k:G,acao:'concluir',request_id:R1,data:{node_id:'gid://shopify/DiscountCodeNode/123',origem:'criado'}});
 assert.equal(ok.ok,true);assert.equal(ok.influ,'riobravo-2','slug que já existe ganha sufixo');assert.match(ok.ref,/^p-[0-9a-f]{8}$/);
 assert.match(ok.url,new RegExp('^https://fishermans\\.com\\.br/\\?utm_source=parceiro&utm_medium=parceiro-site&utm_campaign=fish-parceiros&utm_content='+ok.ref+'$'));
 const inf=(await db.query("SELECT * FROM crm_influ WHERE marca='fish' AND influ='riobravo-2'")).rows[0];
 assert.deepEqual([inf.handle,inf.modelo,Number(inf.comissao_pct),inf.ativo,inf.nicho,inf.seguidores],['@rio.bravo','comissao',0.05,true,'pesca esportiva',1000]);
 const cp=(await db.query("SELECT * FROM crm_cupom WHERE codigo='RIOBRAVO'")).rows[0];
 assert.deepEqual([cp.tipo,cp.influ,Number(cp.desconto_pct),cp.shopify_node_id],['influ','riobravo-2',0.05,'gid://shopify/DiscountCodeNode/123']);
 assert.equal((await db.query("SELECT state FROM crm_partner_candidate_v1 WHERE id=$1",[cid])).rows[0].state,'aprovado_piloto');
 assert.equal((await db.query("SELECT state FROM crm_partner_link_v1 WHERE ref=$1",[ok.ref])).rows[0].state,'ativo');
 assert.equal((await db.query("SELECT count(*)::int n FROM crm_partner_link_evento_v1 WHERE ref=$1 AND state='ativo'",[ok.ref])).rows[0].n,1,'o gatilho registra o link ativo');
 assert.equal((await db.query("SELECT count(*)::int n FROM crm_cupom_log WHERE codigo='RIOBRAVO' AND origem='parceiros-aprovacao'")).rows[0].n,1);checks++;
 const rep=await ap({k:G,acao:'concluir',request_id:R1,data:{node_id:'gid://shopify/DiscountCodeNode/999',origem:'criado'}});
 assert.equal(rep.repetido,true);assert.equal(rep.ref,ok.ref);assert.equal((await ap({k:G,acao:'preparar',request_id:R1,data:{}})).repetido,true);
 assert.match((await ap({k:G,acao:'preparar',request_id:crypto.randomUUID(),data:{candidate_id:cid,codigo:'NOVO'}})).erro,/já foi aprovado/);checks++;

 // Leitura e envio
 let L=await ap({k:'chave-leitura',acao:'ler'});const x=L.parceiros.find(p=>p.candidate_id===cid);
 assert.deepEqual([x.cupom,x.envio_estado,x.link_estado,x.url],['RIOBRAVO','pendente','ativo',ok.url]);assert.equal(Number(L.descontos.aristo),0.06);
 assert.match((await ap({k:'chave-leitura',acao:'envio',data:{candidate_id:cid,estado:'enviado'}})).erro,/só lê/);
 assert.equal((await ap({k:G,acao:'envio',data:{candidate_id:cid,estado:'enviado',rastreio:' BR123 '}})).ok,true);
 L=await ap({k:G,acao:'ler'});const y=L.parceiros.find(p=>p.candidate_id===cid);assert.deepEqual([y.envio_estado,y.envio_rastreio],['enviado','BR123']);assert.ok(y.envio_em);
 await ap({k:G,acao:'envio',data:{candidate_id:cid,estado:'pendente'}});
 assert.deepEqual(Object.values((await db.query("SELECT envio_estado,envio_rastreio,envio_em FROM crm_partner_parceiro_v1 WHERE candidate_id=$1",[cid])).rows[0]),['pendente','',null]);checks++;

 // Link × cupom do próprio parceiro: comissiona uma vez (pelo cupom)
 const hoje=(await db.query("SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date d")).rows[0].d.toISOString().slice(0,10);
 for(const o of ['F1','F2'])await db.query("INSERT INTO crm_organico_attribution_order_v2 VALUES('fish',$1,$2,'last_click','parceiro',$3,100)",['gid://shopify/Order/'+o,hoje,ok.ref]);
 await db.query("INSERT INTO crm_influ_pedido VALUES('fish','F2','riobravo-2',$1,'cupom',true,90)",[hoje]);
 for(const o of ['F1','F2'])await db.query("INSERT INTO crm_partner_commission_base_v1(marca,order_id,dia,moeda,subtotal_apos_descontos,base_elegivel,base_exata,detalhes_completos,partner_ref,coletado_em) VALUES('fish',$1,$2,'BRL',90,90,true,true,$3,now())",['gid://shopify/Order/'+o,hoje,ok.ref]);
 const rd=(await db.query('SELECT crm_partner_link_read_v1($1::date,$1::date) r',[hoje])).rows[0].r;
 const po=rd.partner_orders.find(p=>p.ref===ok.ref);assert.deepEqual([po.pedidos,po.pedidos_pelo_proprio_cupom,Number(po.comissao)],[1,1,4.5]);
 const fe=rd.fechamento.find(f=>f.ref===ok.ref);assert.equal(fe.pedidos,1);assert.equal(Number(fe.comissao),4.5);checks++;

 // Workflow: Monta leva a chave só para o banco; Decide e Confere traduzem a Shopify
 const run=(js,json,nodes)=>new Function('$json','$',js)(json,n=>({first:()=>({json:nodes[n]})}));
 const monta=run(W.MONTA,{body:{k:G,acao:'aprovar',request_id:R1,data:{candidate_id:cid,codigo:'X'}}},{})[0].json;
 assert.equal(JSON.parse(monta.args[0]).acao,'preparar');assert.throws(()=>run(W.MONTA,{body:{acao:'apagar'}},{}),/acao/);
 const nodes={Monta:{k0:G},Executa:{r:{request_id:R1,marca:'fish',codigo:'RIOBRAVO',desconto:'0.05'}}};
 assert.equal(run(W.DECIDE,{data:{codeDiscountNodeByCode:null}},nodes)[0].json.criar,true);
 const igual={data:{codeDiscountNodeByCode:{id:'gid://shopify/DiscountCodeNode/5',codeDiscount:{__typename:'DiscountCodeBasic',customerGets:{value:{__typename:'DiscountPercentage',percentage:0.05},items:{__typename:'AllDiscountItems',allItems:true}}}}}};
 let dec=JSON.parse(run(W.DECIDE,igual,nodes)[0].json.args[0]);assert.deepEqual([dec.acao,dec.k,dec.data.origem,dec.data.node_id],['concluir',G,'existente','gid://shopify/DiscountCodeNode/5']);
 igual.data.codeDiscountNodeByCode.codeDiscount.customerGets.value.percentage=0.1;
 dec=JSON.parse(run(W.DECIDE,igual,nodes)[0].json.args[0]);assert.match(dec.data.erro,/outra regra.*5%/);
 nodes.Decide={prep:nodes.Executa.r};
 const conf=r=>JSON.parse(run(W.CONFERE,r,nodes)[0].json.args[0]).data;
 assert.match(conf({errors:[{message:'Access denied',extensions:{code:'ACCESS_DENIED'}}]}).erro,/Crie o cupom RIOBRAVO na Shopify \(5% em todos/);
 assert.match(conf({data:{discountCodeBasicCreate:{codeDiscountNode:null,userErrors:[{message:'Code must be unique.'}]}}}).erro,/unique/);
 assert.deepEqual(conf({data:{discountCodeBasicCreate:{codeDiscountNode:{id:'gid://shopify/DiscountCodeNode/7'},userErrors:[]}}}),{node_id:'gid://shopify/DiscountCodeNode/7',origem:'criado'});
 const wf=W.buildWorkflow({webhookPath:'parceiros-aprovacao-0123456789abcdef'});
 assert.equal(JSON.stringify(wf.nodes.filter(n=>n.type.endsWith('httpRequest')).map(n=>n.parameters.jsonBody)).includes('k0'),false,'a chave nunca vai para a Shopify');
 assert.equal(wf.settings.saveDataSuccessExecution,'none');checks++;
 console.log(`partner-aprovacao-postgres: ${checks} verificações ok`);
})().catch(e=>{console.error(e);process.exit(1);});
