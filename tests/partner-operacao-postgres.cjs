// Parceiros do site — decisões de 26/09: domínio, link × cupom, link inativo não conta, fechamento e pagamento.
// PGlite com as migrações reais (pilot → partner-link → commission-base → partner-operacao). Dados sintéticos.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const P=require('../n8n/creators/partner-operacao.cjs');
const sql=f=>fs.readFileSync(path.join(__dirname,'../n8n/creators',f),'utf8');
(async()=>{
 const db=new PGlite();let checks=0;
 await db.exec(`CREATE TABLE crm_influ(marca text,influ text,PRIMARY KEY(marca,influ));
  CREATE TABLE crm_influ_pedido(marca text,order_id text,influ text,dia date,via text,pago boolean,receita_base numeric);
  CREATE FUNCTION shrigma_panel_operator_v1(text,text) RETURNS jsonb LANGUAGE sql AS $$ SELECT CASE WHEN $1='synthetic-creators-key' AND $2='influs' THEN '{"who":"actor1","caps":["creators_edit"]}'::jsonb ELSE NULL END $$;`);
 await db.exec(sql('pilot.sql'));
 await db.exec('CREATE TABLE crm_organico_attribution_order_v2(marca text,order_id text,dia date,model text,utm_source text,utm_content text,receita_liquida numeric);');
 await db.exec(sql('partner-link.sql'));await db.exec(sql('partner-commission-base.sql'));
 await db.exec(P.SQL);await db.exec(P.SQL);checks++; // idempotente
 const def=(await db.query("SELECT pg_get_functiondef('public.crm_creator_pilot_write_v1(jsonb)'::regprocedure) d")).rows[0].d;
 await db.exec(P.patchWrite(def));assert.throws(()=>P.patchWrite(P.patchWrite(def)),/já existe/);assert.throws(()=>P.patchWrite('CREATE FUNCTION public.crm_creator_pilot_write_v1 x'),/marcador/);checks++;

 const prog=(await db.query('SELECT marca,link_base,commission_payable,link_cupom FROM crm_partner_program_v1 ORDER BY marca')).rows;
 assert.deepEqual(prog.map(p=>[p.marca,p.link_base,p.commission_payable,p.link_cupom]),[['aristo','https://oaristocrata.com/',true,'ambos'],['fish','https://fishermans.com.br/',true,'ambos']]);checks++;

 let n=1;const rid=()=>`20000000-0000-4000-8000-${String(n++).padStart(12,'0')}`;const K='synthetic-creators-key';
 const run=async p=>(await db.query('SELECT crm_creator_pilot_write_v1($1::jsonb) AS r',[JSON.stringify(p)])).rows[0].r;
 const cid='10000000-0000-4000-8000-00000000000a';
 assert((await run({k:K,acao:'piloto_salvar',kind:'candidato',request_id:rid(),expected_version:0,data:{id:cid,marca:'aristo',name:'Parceira sintética',source:'manual',state:'aprovado_piloto',handle:'@p',note:''}})).ok);
 const gerado=await run({k:K,acao:'piloto_salvar',kind:'link',request_id:rid(),expected_version:0,data:{marca:'aristo',candidate_id:cid,state:'pausado'}});
 assert(gerado.ok);const ref=gerado.ref;
 // o link é criado pausado e só é ativado depois; o evento do gatilho carrega o horário real
 await db.exec(`UPDATE crm_partner_link_evento_v1 SET em='2026-09-01 12:00-03' WHERE ref='${ref}'`);
 const ativo=await run({k:K,acao:'piloto_salvar',kind:'link',request_id:rid(),expected_version:1,data:{marca:'aristo',candidate_id:cid,state:'ativo'}});
 assert.match(ativo.url,/^https:\/\/oaristocrata\.com\/\?utm_source=parceiro/);checks++;
 await db.exec(`UPDATE crm_partner_link_evento_v1 SET em='2026-09-05 10:00-03' WHERE ref='${ref}' AND state='ativo'`);
 await run({k:K,acao:'piloto_salvar',kind:'link',request_id:rid(),expected_version:2,data:{marca:'aristo',candidate_id:cid,state:'pausado'}});
 await db.exec(`UPDATE crm_partner_link_evento_v1 SET em='2026-09-20 18:00-03' WHERE ref='${ref}' AND state='pausado' AND em>'2026-09-02'`);
 assert.equal((await db.query(`SELECT count(*)::int n FROM crm_partner_link_evento_v1 WHERE ref='${ref}'`)).rows[0].n,3,'cada troca de estado vira um evento');checks++;

 // pedidos: 03/09 (pausado, não conta), 05/09 (ativado no dia), 10/09 (ativo, também com cupom), 20/09 (pausado às 18h, conta), 21/09 (não conta)
 const pedidos=[['A1','2026-09-03'],['A2','2026-09-05'],['A3','2026-09-10'],['A4','2026-09-20'],['A5','2026-09-21'],['A6','2026-08-28']];
 for(const [o,d] of pedidos)await db.query("INSERT INTO crm_organico_attribution_order_v2 VALUES('aristo',$1,$2,'last_click','parceiro',$3,100)",['gid://shopify/Order/'+o,d,ref]);
 await db.exec("INSERT INTO crm_influ_pedido VALUES('aristo','A3','capivara','2026-09-10','cupom',true,90)");
 const base=(o,v)=>db.query("INSERT INTO crm_partner_commission_base_v1(marca,order_id,dia,moeda,subtotal_apos_descontos,base_elegivel,base_exata,detalhes_completos,partner_ref,coletado_em) VALUES('aristo',$1,'2026-09-05','BRL',$2,$2,true,true,$3,now())",['gid://shopify/Order/'+o,v,ref]);
 await base('A2',80);await base('A3',50);
 const ler=async(a,b)=>(await db.query('SELECT crm_creator_pilot_read_v1($1,$2) AS p',[a,b])).rows[0].p;
 let p=await ler('2026-09-01','2026-09-30');let o=p.partner_orders[0];
 assert.equal(o.pedidos,3,'só pedidos de dias com link ativo');assert.equal(o.pedidos_link_inativo,2);checks++;
 assert.equal(o.pedidos_com_cupom,1,'o pedido com cupom de influ aparece como sobreposição');checks++;
 assert.equal(o.comissao,null,'falta base de um pedido: sem número de comissão');assert.equal(o.comissao_fechada,false);assert.equal(o.pedidos_sem_base,1);checks++;
 await base('A4',20);p=await ler('2026-09-01','2026-09-30');o=p.partner_orders[0];
 assert.equal(Number(o.comissao),10.5,'7% de 150');assert.equal(o.comissao_fechada,true);assert.equal(p.commission_payable,true);assert.equal(p.link_cupom,'ambos');checks++;
 const f=p.fechamento.find(x=>x.competencia==='2026-09');assert.equal(f.pedidos,3);assert.equal(Number(f.comissao),10.5);assert.equal(f.prazo,'2026-10-05');checks++;
 p=await ler('2026-08-01','2026-09-30');assert.equal(p.fechamento.find(x=>x.competencia==='2026-08'),undefined,'agosto: link pausado, nada a fechar');checks++;

 // pagamento: validação, versão, máscara na leitura e nada de CPF/Pix no log de operações
 const pag=(d,v=0)=>run({k:K,acao:'piloto_salvar',kind:'pagamento',request_id:rid(),expected_version:v,data:{marca:'aristo',candidate_id:cid,titular:'Parceira Sintética',cpf:'529.982.247-25',pix_tipo:'email',pix_chave:'Parceira@Exemplo.com',...d}});
 assert.match((await pag({cpf:'111.111.111-11'})).erro,/CPF/);assert.match((await pag({cpf:'529.982.247-24'})).erro,/CPF/);checks++;
 assert.match((await pag({pix_tipo:'telefone',pix_chave:'123'})).erro,/Pix/);assert.match((await pag({pix_tipo:'aleatoria',pix_chave:'nao-e-uuid'})).erro,/Pix/);checks++;
 assert.match((await pag({marca:'fish'})).erro,/marca/);checks++;
 const ok=await pag({});assert(ok.ok);assert.equal(ok.version,1);assert.equal(ok.pix_final,'.com');assert.equal(JSON.stringify(ok).includes('52998224725'),false);checks++;
 assert.match((await pag({},0)).erro,/mudou/);const tel=await pag({pix_tipo:'telefone',pix_chave:'(41) 99906-0777'},1);assert(tel.ok);checks++;
 const guardado=(await db.query('SELECT cpf,pix_chave FROM crm_partner_payment_v1')).rows[0];assert.deepEqual(guardado,{cpf:'52998224725',pix_chave:'+5541999060777'});checks++;
 p=await ler('2026-09-01','2026-09-30');const m=p.pagamentos[0];
 assert.equal(m.cpf_mascarado,'***.982.247-**');assert.equal(m.pix_final,'0777');assert.equal(m.version,2);assert.equal(JSON.stringify(p).includes('52998224725'),false);assert.equal(JSON.stringify(p).includes('99906'),false);checks++;
 const log=JSON.stringify((await db.query('SELECT request,response FROM crm_creator_pilot_operation_v1')).rows);
 assert.equal(log.includes('529.982.247-25'),false);assert.equal(log.includes('Parceira@Exemplo.com'),false);assert.equal(log.includes('99906-0777'),false);checks++;
 // repetir exatamente a mesma operação devolve o mesmo recibo, sem regravar
 const rep={k:K,acao:'piloto_salvar',kind:'pagamento',request_id:rid(),expected_version:2,data:{marca:'aristo',candidate_id:cid,titular:'Parceira Sintética',cpf:'52998224725',pix_tipo:'cpf',pix_chave:'52998224725'}};
 const r1=await run(rep),r2=await run(rep);assert.deepEqual(r1,r2);assert.match((await run({...rep,data:{...rep.data,cpf:'39053344705'}})).erro,/diferentes/);checks++;
 console.log(`partner-operacao-postgres: ${checks} checks ok`);
})().catch(e=>{console.error(e);process.exit(1);});
