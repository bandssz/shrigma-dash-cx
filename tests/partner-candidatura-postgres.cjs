// Candidatura pelo site: termo versionado e imutável, validação no servidor, prints conferidos pelos bytes,
// idempotência por request_id, sem duplicar a mesma pessoa, limite por IP e leitura do painel. PGlite, dados sintéticos.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const W=require('../n8n/creators/partner-candidatura-workflow.cjs');
const sql=f=>fs.readFileSync(path.join(__dirname,'../n8n/creators',f),'utf8');
const jpg=Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),crypto.randomBytes(400)]).toString('base64');
const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),crypto.randomBytes(400)]).toString('base64');
(async()=>{
 const db=new PGlite();let checks=0;
 await db.exec(`CREATE TABLE crm_influ(marca text,influ text,PRIMARY KEY(marca,influ));
  CREATE TABLE crm_influ_pedido(marca text,order_id text,influ text,dia date,via text,pago boolean,receita_base numeric);
  CREATE FUNCTION shrigma_panel_operator_v1(text,text) RETURNS jsonb LANGUAGE sql AS $$ SELECT CASE WHEN $1='synthetic-influs-key' AND $2='influs' THEN '{"who":"x","label":"Gestor","caps":["creators_edit"]}'::jsonb END $$;`);
 await db.exec(sql('pilot.sql'));
 await db.exec(sql('partner-candidatura.sql'));await db.exec(sql('partner-candidatura.sql'));checks++;
 const call=async p=>(await db.query('SELECT crm_partner_candidatura_v1($1::jsonb) AS r',[JSON.stringify(p)])).rows[0].r;
 const painel=async p=>(await db.query('SELECT crm_partner_candidatura_painel_v1($1::jsonb) AS r',[JSON.stringify(p)])).rows[0].r;
 // Sem termo publicado: fechado.
 assert.equal((await call({acao:'termo',marca:'aristo'})).aberto,false);
 const base={nome:'Carlos  Silva',email:'Carlos@Exemplo.com',whatsapp:'(41) 99906-0777',instagram:'@Carlos.Silva',tiktok:'',seguidores:'12000',nicho:'estilo de vida',cidade:'Curitiba',uf:'pr',
  views_stories:'1500',views_reels:'4000',preco_story:'150',preco_reels:'300,50',mensagem:'Uso o sabonete há um ano.',aceite:true,prints:[{mime:'image/jpeg',base64:jpg},{mime:'image/png',base64:png}],origem:{utm_source:'instagram',ref:'bio',x:'ignorado'}};
 const envia=(data,over={})=>call({acao:'enviar',marca:'aristo',request_id:crypto.randomUUID(),ip:'203.0.113.9',navegador:'synthetic',...over,data});
 assert.match((await envia({...base,termo_versao:1,termo_sha256:'x'})).erro,/fechadas/);checks++;
 const texto='Termo sintético de parceria. '.repeat(20),sha=crypto.createHash('sha256').update(texto).digest('hex');
 await db.query("INSERT INTO crm_partner_terms_v1(marca,versao,titulo,texto,sha256,publicado_em) VALUES('aristo',1,'Termo de Parceria',$1,$2,now())",[texto,sha]);
 await assert.rejects(db.query("UPDATE crm_partner_terms_v1 SET texto=texto||'x' WHERE versao=1"),/não muda/);checks++;
 const termo=await call({acao:'termo',marca:'aristo'});
 assert.equal(termo.aberto,true);assert.equal(termo.versao,1);assert.equal(termo.sha256,sha);assert.equal(Number(termo.comissao),0.07);checks++;
 const T={termo_versao:1,termo_sha256:sha};
 for(const [d,re] of [[{aceite:false},/aceita/],[{termo_sha256:'outro'},/atualizado/],[{email:'semarroba'},/E-mail/],[{whatsapp:'123'},/WhatsApp/],
   [{instagram:'',tiktok:''},/Instagram ou TikTok/],[{instagram:'com espaço'},/Instagram/],[{seguidores:''},/seguidores/],[{views_stories:'0',views_reels:''},/views/],
   [{uf:'XX'},/Estado/],[{prints:[]},/prints/],[{prints:[{mime:'image/jpeg',base64:png}]},/imagem válida/],[{prints:[{mime:'image/gif',base64:jpg}]},/imagem válida/],
   [{prints:[{mime:'image/jpeg',base64:'@@@'}]},/imagem válida/],[{prints:[1,2,3,4].map(()=>({mime:'image/jpeg',base64:jpg}))},/1 a 3/]])
  assert.match((await envia({...base,...T,...d})).erro,re,JSON.stringify(d));
 checks++;
 assert.equal((await db.query('SELECT count(*)::int n FROM crm_partner_candidate_v1')).rows[0].n,0,'recusa não deixa nada gravado');checks++;
 const rid=crypto.randomUUID();
 const ok=await envia({...base,...T},{request_id:rid});assert.equal(ok.ok,true);assert.equal(ok.repetida,false);assert.match(ok.protocolo,/^[0-9A-F]{8}$/);checks++;
 assert.deepEqual(await envia({...base,...T,nome:'Outro nome'},{request_id:rid}),ok,'mesmo request_id devolve o mesmo recibo');checks++;
 const rep=await envia({...base,...T,email:'outro@exemplo.com'});assert.equal(rep.repetida,true);assert.equal(rep.protocolo,ok.protocolo,'mesmo Instagram em 30 dias não duplica');checks++;
 const c=(await db.query('SELECT * FROM crm_partner_candidate_v1')).rows;assert.equal(c.length,1);
 assert.deepEqual([c[0].name,c[0].handle,c[0].source,c[0].state,c[0].version],['Carlos Silva','@carlos.silva','formulario_site','novo',1]);checks++;
 const a=(await db.query('SELECT * FROM crm_partner_application_v1')).rows[0];
 assert.equal(a.email,'carlos@exemplo.com');assert.equal(a.whatsapp,'5541999060777');assert.equal(a.uf,'PR');assert.equal(Number(a.preco_reels),300.5);
 assert.equal(a.ip,'203.0.113.9');assert.equal(a.termo_sha256,sha);assert.deepEqual(a.origem,{utm_source:'instagram',ref:'bio'});checks++;
 // Limite por IP: 5 por hora.
 for(let i=0;i<4;i++)assert.equal((await envia({...base,...T,instagram:'perfil'+i,email:`p${i}@exemplo.com`})).ok,true);
 assert.match((await envia({...base,...T,instagram:'perfil9',email:'p9@exemplo.com'})).erro,/Muitos envios/);checks++;
 // Painel
 assert.match((await painel({k:'outra',acao:'ler'})).erro,/chave/);
 const L=await painel({k:'synthetic-influs-key',acao:'ler'});const x=L.candidaturas.find(y=>y.instagram==='carlos.silva');
 assert.equal(Number(x.cpm_story),100);assert.equal(Number(x.cpm_reels),75.13);assert.equal(x.estado,'novo');assert.equal(x.prints.length,2);assert.equal(JSON.stringify(L).includes(jpg.slice(0,40)),false,'lista sem imagem');checks++;
 const img=await painel({k:'synthetic-influs-key',acao:'print',id:x.prints[0].id});assert.equal(img.mime,'image/jpeg');assert.equal(img.base64,jpg);checks++;
 // Monta SQL do workflow: isca e envio rápido não chegam ao banco; IP vem do cabeçalho, não do corpo.
 const monta=j=>new Function('$json',W.MONTA)(j)[0].json;
 let m=monta({body:{acao:'enviar',marca:'aristo',data:{website:'spam',t_ms:9000}},headers:{}});assert.equal(m.args.length,0);
 m=monta({body:{acao:'enviar',marca:'aristo',data:{t_ms:500}},headers:{}});assert.equal(m.args.length,0);
 m=monta({body:{acao:'enviar',marca:'aristo',request_id:'r',ip:'1.1.1.1',data:{t_ms:9000,nome:'x'}},headers:{'x-forwarded-for':'198.51.100.7, 10.0.0.1','user-agent':'UA'}});
 const corpo=JSON.parse(m.args[0]);assert.equal(corpo.ip,'198.51.100.7');assert.equal(corpo.data.t_ms,undefined);assert.equal(corpo.navegador,'UA');checks++;
 assert.throws(()=>monta({body:{acao:'apagar'},headers:{}}),/acao/);assert.match(monta({body:{acao:'ler',k:'x'},headers:{}}).sql,/painel_v1/);checks++;
 const w=W.buildWorkflow({webhookPath:'parceiros-candidatura-0123456789abcdef'});assert.equal(w.settings.saveDataErrorExecution,'none');assert.equal(w.settings.saveDataSuccessExecution,'none');checks++;
 console.log(`partner-candidatura-postgres: ${checks} checks ok`);
})().catch(e=>{console.error(e);process.exit(1);});
