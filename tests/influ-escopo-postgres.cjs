// Escopo dos creators: marcações do Instagram casadas pelo @, story marcado à mão, feito × combinado no mês,
// quem marcou a marca sem cadastro, permissão de escrita. PGlite, dados sintéticos.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const W=require('../n8n/influs/escopo-workflow.cjs');
(async()=>{
 const db=new PGlite();let checks=0;
 await db.exec(`CREATE TABLE crm_influ(marca text,influ text,nome text,handle text,ativo boolean,modelo text,PRIMARY KEY(marca,influ));
  INSERT INTO crm_influ VALUES('aristo','buzzo10','Arthur Buzzo','',true,'fixo'),('aristo','capivara','Capivara','@Capivara',true,'hibrido'),('fish','pedro','Pedro','',true,'fixo');
  CREATE FUNCTION shrigma_panel_operator_v1(text,text) RETURNS jsonb LANGUAGE sql AS $$ SELECT CASE WHEN $1='gestor' THEN '{"label":"Marcela","caps":["creators_edit"]}'::jsonb WHEN $1='leitor' THEN '{"label":"L","caps":[]}'::jsonb END $$;`);
 const sql=fs.readFileSync(path.join(__dirname,'../n8n/influs/escopo.sql'),'utf8');await db.exec(sql);await db.exec(sql);checks++;
 const ing=async p=>(await db.query('SELECT crm_influ_conteudo_ingest_v1($1::jsonb) r',[JSON.stringify(p)])).rows[0].r;
 const pan=async p=>(await db.query('SELECT crm_influ_escopo_painel_v1($1::jsonb) r',[JSON.stringify(p)])).rows[0].r;
 const m=(id,user,tipo,ts)=>({id,username:user,media_product_type:tipo,media_type:'VIDEO',timestamp:ts,permalink:'https://www.instagram.com/reel/x'+id+'/',thumbnail_url:'https://scontent.cdninstagram.com/'+id});
 let r=await ing({marca:'aristo',conta:'oaristocrata.br',midias:[m('10001','capivara','REELS','2026-10-03T12:00:00+0000'),m('10002','SouArthurBuzzo','FEED','2026-10-04T12:00:00+0000'),m('10003','capivara','REELS','2026-09-20T12:00:00+0000'),{id:'x',username:'a',timestamp:'2026-10-01'}]});
 assert.equal(r.midias,3);checks++;
 r=await ing({marca:'aristo',conta:'oaristocrata.br',midias:[m('10001','capivara','REELS','2026-10-03T12:00:00+0000')]});
 assert.equal((await db.query('SELECT count(*)::int n FROM crm_influ_conteudo_v1')).rows[0].n,3,'repetir a coleta não duplica');checks++;
 let L=await pan({k:'leitor',acao:'ler',mes:'2026-10'});
 const cap=L.creators.find(c=>c.influ==='capivara');assert.equal(cap.instagram,'capivara');assert.equal(cap.feito.reels,1,'só outubro');checks++;
 assert.deepEqual(L.sem_cadastro.map(s=>s.username),['souarthurbuzzo'],'quem marcou e não tem @ cadastrado');checks++;
 assert.match((await pan({k:'leitor',acao:'escopo_salvar',data:{marca:'aristo',influ:'buzzo10'}})).erro,/só lê/);
 assert.match((await pan({k:'x',acao:'ler'})).erro,/chave/);checks++;
 assert.match((await pan({k:'gestor',acao:'escopo_salvar',data:{marca:'aristo',influ:'buzzo10',instagram:'@com espaço',desde:'2026-10'}})).erro,/Instagram/);
 assert.equal((await pan({k:'gestor',acao:'escopo_salvar',data:{marca:'aristo',influ:'buzzo10',instagram:'@SouArthurBuzzo',desde:'2026-10',stories:'4',reels:'2',feed:'1',tiktok:'0'}})).ok,true);
 L=await pan({k:'gestor',acao:'ler',mes:'2026-10'});const bz=L.creators.find(c=>c.influ==='buzzo10');
 assert.equal(bz.feito.feed,1,'marcação antiga casa quando o @ é cadastrado');assert.equal(bz.escopo.stories,4);assert.equal(L.sem_cadastro.length,0);checks++;
 const id=()=>require('node:crypto').randomUUID();
 assert.match((await pan({k:'gestor',acao:'conteudo_marcar',data:{marca:'aristo',influ:'buzzo10',tipo:'story',dia:'2020-01-01',id:id()}})).erro,/janela/);
 // "Hoje" é o dia em São Paulo, como no servidor: entre 21h e 24h o dia UTC já virou e seria recusado como futuro.
 const hoje=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date()),sid=id();
 assert.equal((await pan({k:'gestor',acao:'conteudo_marcar',data:{marca:'aristo',influ:'buzzo10',tipo:'story',dia:hoje,link:'',id:sid}})).ok,true);
 await pan({k:'gestor',acao:'conteudo_marcar',data:{marca:'aristo',influ:'buzzo10',tipo:'story',dia:hoje,id:sid}});
 L=await pan({k:'gestor',acao:'ler'});assert.equal(L.creators.find(c=>c.influ==='buzzo10').feito.story,1,'mesmo id não conta duas vezes');checks++;
 assert.equal((await pan({k:'gestor',acao:'conteudo_ignorar',data:{marca:'aristo',influ:'buzzo10',id:'manual:'+sid,ignorar:true}})).ok,true);
 L=await pan({k:'gestor',acao:'ler'});assert.equal(L.creators.find(c=>c.influ==='buzzo10').feito.story,0);checks++;
 await ing({marca:'fish',conta:'fishermans.com.br',midias:[m('20001','pedro.pesca','REELS',new Date().toISOString())]});
 assert.equal((await pan({k:'gestor',acao:'vincular',mes:hoje.slice(0,7),data:{marca:'fish',influ:'pedro',instagram:'@Pedro.Pesca'}})).ok,true);
 L=await pan({k:'gestor',acao:'ler'});const pe=L.creators.find(c=>c.influ==='pedro');assert.equal(pe.feito.reels,1);assert.equal(pe.escopo.reels,0,'vincular não inventa quantidade');checks++;
 // Workflow: só contas das marcas; pareamento por índice.
 const sep=new Function('$json',W.SEPARA)({data:[{instagram_business_account:{id:'1',username:'oaristocrata.br'}},{instagram_business_account:{id:'2',username:'olivasdocampo'}},{}]});
 assert.deepEqual(sep.map(x=>x.json),[{id:'1',conta:'oaristocrata.br',marca:'aristo'}]);
 assert.throws(()=>W.buildPainel({webhookPath:'x'}));assert.equal(W.buildPainel({webhookPath:'influs-escopo-0123456789abcdef'}).settings.saveDataErrorExecution,'none');checks++;
 console.log(`influ-escopo-postgres: ${checks} checks ok`);
})().catch(e=>{console.error(e);process.exit(1);});
