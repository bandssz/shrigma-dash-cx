/* Cobrança automática com modelo aprovado, de ponta a ponta, em PostgreSQL isolado (PGlite) e dados sintéticos.
 * Roda o SQL real (ddl + safety + auto + regra-update) e o código real dos nodes gerados por cobranca-v2-workflow.cjs,
 * na ordem em que o workflow os liga, com um transporte TikTok falso. Nada de rede. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),vm=require('node:vm');
const {PGlite}=require(process.env.TTS_PGLITE_MODULE||process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {buildSender}=require('../n8n/tiktok/cobranca-v2-workflow.cjs');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');

const LEGACY_PREFIX=`const helpers = this.helpers;
const APP_KEY = 'fixture'; const APP_SECRET = 'fixture-secret';
const BASE = 'https://open-api.tiktokglobalshop.com';
function assinar(path, params, body) { return 'fixture'; }
const tokens = {};
for (const it of $('Pegar tokens (Token Manager)').all()) { const j = it.json || {}; if (j.loja && j.access_token) tokens[j.loja] = j.access_token; }
async function chamar(marca, method, pathComQuery, body) { return helpers.fake(marca, method, pathComQuery, body); }
`;
const fresh={id:'37W8obVhxFccuHgv',versionId:'v1',activeVersionId:'v1',settings:{timezone:'America/Sao_Paulo',availableInMCP:false},connections:{},nodes:[
 {name:'Dias úteis 13h20',type:'n8n-nodes-base.scheduleTrigger',parameters:{}},
 {name:'POST cobranca',type:'n8n-nodes-base.webhook',parameters:{}},
 {name:'Valida chave',type:'n8n-nodes-base.code',parameters:{jsCode:'return [];'}},
 {name:'Pegar tokens (Token Manager)',type:'n8n-nodes-base.executeWorkflow',parameters:{}},
 {name:'Monta alvos (SQL)',type:'n8n-nodes-base.code',parameters:{jsCode:''}},
 {name:'Busca alvos',type:'n8n-nodes-base.postgres',parameters:{}},
 {name:'Cobra (dry_run até a regra dizer ativo)',type:'n8n-nodes-base.code',parameters:{jsCode:LEGACY_PREFIX+'const alvos = $input.all().map(i => i.json);\nreturn [];'}},
 {name:'Grava log',type:'n8n-nodes-base.postgres',parameters:{},credentials:{postgres:{id:'pg',name:'Postgres fixture'}}},
 {name:'200',type:'n8n-nodes-base.respondToWebhook',parameters:{}},
]};

(async()=>{
 const w=buildSender(fresh,{expectedVersionId:'v1'});
 assert.throws(()=>buildSender({...fresh,activeVersionId:'v0'},{expectedVersionId:'v1'}),/fresco/);
 const bad=JSON.parse(JSON.stringify(fresh));bad.nodes[6].parameters.jsCode=bad.nodes[6].parameters.jsCode.replace("const APP_SECRET = 'fixture-secret'","const APP_SECRET = '__SERVER_ONLY_X'");
 assert.throws(()=>buildSender(bad,{expectedVersionId:'v1'}),/segredo/);
 const by=n=>{const x=w.nodes.find(y=>y.name===n);assert.ok(x,n);return x;};
 for(const legacy of ['Monta alvos (SQL)','Busca alvos','Cobra (dry_run até a regra dizer ativo)','Grava log'])assert.equal(w.nodes.some(n=>n.name===legacy),false,'sender legado removido: '+legacy);
 assert.equal(JSON.stringify(w).includes('crm_tts_cobranca (marca'),false,'nenhum INSERT no log legado');
 assert.ok(!by('Envia').parameters.jsCode.includes('for (let'),'envio sem laço de nova tentativa');
 const edges=Object.entries(w.connections).flatMap(([f,c])=>c.main.flatMap((o,i)=>o.map(t=>`${f}#${i}>${t.node}`)));
 for(const e of ['Loop#1>Tipo','Tipo#1>Reserva (SQL)','Reserva (SQL)#0>Conversa','Depois da conversa#1>Libera envio (SQL)','Libera envio (SQL)#0>Envia','Resultado#0>Loop','Loop#0>Resumo'])assert.ok(edges.includes(e),e);
 assert.equal(edges.filter(e=>e.endsWith('>Envia')).length,1,'Envia só depois de Libera envio');

 const db=new PGlite();
 const q=async(s,p=[])=>(await db.query(s,p)).rows;
 const one=async(s,p=[])=>(await q(s,p))[0];
 await db.exec(read('n8n/tiktok/ddl_crm_tts.sql'));
 await db.exec(read('n8n/tiktok/regra-update.sql'));
 // Operador de painel sintético: chave "gestor" grava, "leitor" só lê.
 await db.exec(`CREATE FUNCTION shrigma_panel_operator_v1(k text,a text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE WHEN a='influs' AND k='gestor-fixture' THEN '{"who":"panel:x","label":"Marcela","caps":["creators_edit"]}'::jsonb
   WHEN a='influs' AND k='leitor-fixture' THEN '{"who":"panel:y","label":"Leitura","caps":[]}'::jsonb END $$;`);
 await db.exec("UPDATE crm_tts_regra SET cobranca_modo='pausado'");
 await db.exec(read('n8n/tiktok/cobranca-safety.sql'));
 const auto=read('n8n/tiktok/cobranca-auto.sql');
 await db.exec("UPDATE crm_tts_regra SET cobranca_modo='ativo' WHERE marca='fish'");
 await assert.rejects(db.exec(auto),/ativa/);await db.exec('ROLLBACK');
 await db.exec("UPDATE crm_tts_regra SET cobranca_modo='pausado'");
 await db.exec(auto);await db.exec(auto);

 const T=['vitrine_sem_video','amostra_sem_video'];
 for(const b of ['fish','aristo'])for(const e of T)for(const t of [1,2,3])
  await q(`INSERT INTO crm_tts_cobranca_modelo(marca,etapa,tentativa,texto) VALUES($1,$2,$3,$4)`,[b,e,t,`Opa{nome}! Toque ${t} de ${e}: e o {produto}?`]);
 const source='2026-09-20T10:00:00Z';
 async function pessoa(b,u,etapa='vitrine_sem_video',nick='Carlos Silva'){
  if(etapa==='vitrine_sem_video'){
   await q(`INSERT INTO crm_tts_colaboracao(marca,tipo,colab_id,product_id,product_title) VALUES($1,'target',$2,'p','Linha Multifilamento X8 0,30mm 150m 4.9 Estrelas 9mil Avaliações') ON CONFLICT DO NOTHING`,[b,'col-'+u]);
   await q(`INSERT INTO crm_tts_convite(marca,colab_id,username,creator_open_id,nickname,showcase_product_count,content_product_count,atualizado_em) VALUES($1,$2,$3,$4,$5,1,0,$6)`,[b,'col-'+u,u,'open-'+u,nick,source]);
  }else{
   await q(`INSERT INTO crm_tts_amostra(marca,application_id,username,creator_open_id,status,product_title,atualizado_em) VALUES($1,$2,$3,$4,'SHIPPED','Sabonete Natural Masculino O Aristocrata 150g 4.9 Estrelas',$5)`,[b,'app-'+u,u,'open-'+u,source]);
  }
 }
 await pessoa('fish','ana');await pessoa('fish','bia');await pessoa('fish','caio');await pessoa('fish','duda','amostra_sem_video','loja do pescador');
 await pessoa('aristo','eva','amostra_sem_video');

 const painel=async(k,acao,data)=>(await one('SELECT crm_tts_cobranca_painel_v1($1::jsonb) AS r',[JSON.stringify({k,acao,data})])).r;
 const regra=async(b,p)=>{const r=await one('SELECT to_jsonb(g) AS g FROM crm_tts_regra g WHERE marca=$1',[b]);
  return (await one('SELECT crm_tts_regra_patch_v1($1,$2::jsonb,$3,$4) AS r',[b,JSON.stringify(p),'Marcela',r.g.atualizado_em])).r;};

 // ---- Execução do workflow: mesmos SQL e códigos gerados, ligados na ordem do grafo ----
 const expr=(e,$json)=>new Function('$json','return ('+e.replace(/^=\{\{/, '').replace(/\}\}$/,'')+')')($json);
 const pg=async(name,$json)=>{const n=by(name);const args=n.parameters.options.queryReplacement?expr(n.parameters.options.queryReplacement,$json):[];
  const r=await db.query(n.parameters.query,args);return r.rows.map(x=>JSON.parse(JSON.stringify(x)));};
 const code=async(name,items,fake)=>{const ctx=vm.createContext({setTimeout:(f)=>f(),Date,JSON,Number,String,Array,Object,encodeURIComponent,Promise,Error,Math,parseInt});
  const fn=vm.runInContext('(async function($input,$){'+by(name).parameters.jsCode+'\n})',ctx);
  const tokens=[{json:{loja:'fishermans',access_token:'t'}},{json:{loja:'aristocrata',access_token:'t'}}];
  return (await fn.call({helpers:{fake}},{all:()=>items.map(json=>({json}))},()=>({all:()=>tokens}))).map(i=>JSON.parse(JSON.stringify(i.json)));};
 const calls=[];
 let script={};
 const fake=async(marca,method,p,body)=>{calls.push({marca,method,p,body});
  const u=body?.creator_open_id?.replace('open-','')||Object.keys(script).find(k=>p.includes('conv-'+k));const s=script[u]||{};
  if(p.startsWith('/affiliate_seller/202508/conversations'))return s.open||{code:0,data:{conversation_id:'conv-'+u,creator_im_id:'im-'+u,username:u,is_new:true,unread_count:0}};
  if(method==='GET'){if(s.readThrow)throw Error('timeout');return s.read||{code:0,data:{messages:[]}};}
  if(s.sendThrow)throw Error('timeout');return s.send||{code:0,data:{message_id:'m-'+u}};};
 async function run(){
  const prep=await pg('Prepara fila (SQL)',{});
  const fila=await code('Fila',prep);const res=[];
  for(const item of fila){
   if(item._route==='vazio'){res.push({estado:'vazio'});continue;}
   if(item._route==='simula'){const r=(await pg('Simula (SQL)',item))[0];res.push({...item,estado:r.result.simulated?'simulado':'?'});continue;}
   const reserva=await pg('Reserva (SQL)',item);
   const [c]=await code('Conversa',reserva,fake);
   if(c._route==='fim'){res.push(c);continue;}
   if(c._route==='conclui'){const r=(await pg('Conclui (SQL)',c))[0];assert.equal(r.result.recorded,true,JSON.stringify(r));res.push(c);continue;}
   const lib=await pg('Libera envio (SQL)',c);
   const [e]=await code('Envia',lib,fake);
   if(e._route==='conclui'){const r=(await pg('Conclui (SQL)',e))[0];assert.equal(r.result.recorded,true);}
   res.push(e);
  }
  return res;
 }
 const estado=async(b,u)=>(await one('SELECT estado,motivo,tentativa FROM crm_tts_cobranca_intencao_v2 WHERE marca=$1 AND username=$2 ORDER BY reservado_em DESC LIMIT 1',[b,u]));
 const sends=()=>calls.filter(c=>c.method==='POST'&&c.p.includes('/202412/conversations/'));

 // 1) Pausado: fila vazia, nada chamado.
 assert.deepEqual((await run()).map(r=>r.estado),['vazio']);

 // 2) Simulação com modelo ainda não aprovado: só simulação, nenhuma reserva, nenhuma chamada.
 await db.exec("UPDATE crm_tts_regra SET cobranca_modo='dry_run'");
 let r=await run();
 assert.deepEqual(r.map(x=>x.estado).sort(),Array(5).fill('simulado'));
 assert.equal(calls.length,0);assert.equal((await one('SELECT count(*)::int n FROM crm_tts_cobranca_intencao_v2')).n,0);
 let ler=await painel('leitor-fixture','ler');
 assert.equal(ler.pode_escrever,false);assert.equal(ler.simulacoes.length,5);
 const sim=ler.simulacoes.find(s=>s.username==='ana');
 assert.equal(sim.texto,'Opa, Carlos! Toque 1 de vitrine_sem_video: e o Linha Multifilamento X8 0,30mm 150m?');assert.equal(sim.aprovado,false);
 assert.equal(ler.simulacoes.find(s=>s.username==='duda').etapa,'amostra_sem_video');
 assert.ok(ler.simulacoes.find(s=>s.username==='duda').texto.startsWith('Opa! '),'apelido de loja não vira nome');
 assert.equal(JSON.stringify(ler).includes('gestor-fixture'),false);assert.equal(JSON.stringify(ler).includes('panel:'),false);

 // 3) Ligar sem modelo aprovado e sem sender conferido: recusado.
 assert.equal((await regra('fish',{cobranca_modo:'ativo'})).codigo,'ativacao_bloqueada');
 assert.equal((await regra('fish',{modo:'ativo'})).codigo,'ativacao_bloqueada','decisão automática de amostra continua sem ativação');
 // Aprovação: leitor não aprova; chaves inválidas e marcadores desconhecidos recusados; versão velha recusada.
 const mod=(b,e,t)=>ler.modelos.find(m=>m.marca===b&&m.etapa===e&&m.tentativa===t);
 assert.match((await painel('leitor-fixture','modelo_salvar',{marca:'fish',etapa:'vitrine_sem_video',tentativa:1,texto:'x'.repeat(30),esperado:mod('fish','vitrine_sem_video',1).atualizado_em})).erro,/só lê/);
 assert.match((await painel('outra','ler')).erro,/chave/);
 assert.match((await painel('gestor-fixture','modelo_salvar',{marca:'fish',etapa:'vitrine_sem_video',tentativa:1,texto:'Oi {apelido}, tudo certo por aí?',esperado:mod('fish','vitrine_sem_video',1).atualizado_em})).erro,/\{nome\}/);
 assert.match((await painel('gestor-fixture','modelo_salvar',{marca:'fish',etapa:'vitrine_sem_video',tentativa:1,texto:'Oi {nome}, tudo certo por aí?',esperado:'2000-01-01'})).erro,/mudou/);
 for(const e of T)for(const t of [1,2,3]){const m=mod('fish',e,t);
  const x=await painel('gestor-fixture','modelo_salvar',{marca:'fish',etapa:e,tentativa:t,texto:m.texto,esperado:m.atualizado_em});assert.equal(x.ok,true,JSON.stringify(x));}
 assert.equal((await regra('fish',{cobranca_modo:'ativo'})).codigo,'ativacao_bloqueada','sender ainda não conferido');
 await q(`INSERT INTO crm_tts_cobranca_config_v2 VALUES(1,'37W8obVhxFccuHgv','v2-fixture',now(),'teste')`);
 assert.equal((await regra('aristo',{cobranca_modo:'ativo'})).codigo,'ativacao_bloqueada','aristo sem modelo aprovado');
 assert.equal((await regra('fish',{cobranca_modo:'ativo'})).ok,true);

 // 4) Primeiro dia ativo (fish; aristo segue simulando). Teto 3/dia.
 await db.exec("UPDATE crm_tts_regra SET cobranca_max_dia=3 WHERE marca='fish'");
 script={bia:{open:{code:0,data:{conversation_id:'conv-bia',creator_im_id:'im-bia',username:'bia',is_new:false,unread_count:0}},
  read:{code:0,data:{messages:[{message_body:{type:'TEXT',sender_id:'im-bia',create_time:Math.floor(Date.now()/1000)-20*86400,content:'{"content":"mandei o vídeo no zap"}'}}]}}}};
 r=await run();
 const porU=Object.fromEntries(r.map(x=>[x.username,x.estado]));
 assert.equal(porU.duda,'aceito','amostra vem primeiro');assert.equal(porU.ana,'aceito');assert.equal(porU.bia,'bloqueado');
 assert.equal(porU.caio,undefined,'teto 3: caio fica para amanhã');assert.equal(porU.eva,'simulado');
 assert.equal(sends().length,2);
 assert.deepEqual(JSON.parse(sends()[0].body.content),{content:'Opa! Toque 1 de amostra_sem_video: e o Sabonete Natural Masculino O Aristocrata?'});
 assert.equal((await estado('fish','bia')).motivo,'im_resposta_criador');
 const pulo=await one("SELECT motivo,ultimo_texto,ultima_msg_de FROM crm_tts_cobranca_pulo WHERE username='bia'");
 assert.deepEqual(pulo,{motivo:'respondeu',ultimo_texto:'mandei o vídeo no zap',ultima_msg_de:'criador'});
 // Rodar de novo no mesmo dia não repete ninguém e respeita o teto.
 calls.length=0;r=await run();assert.equal(sends().length,0);assert.deepEqual(r.filter(x=>x.marca==='fish').map(x=>x.estado),[]);

 // 5) A Marcela responde a bia e devolve à régua: a resposta antiga passa a contar como vista.
 ler=await painel('gestor-fixture','ler');
 const bia=ler.envios.find(e=>e.username==='bia');assert.equal(bia.humano,true);
 assert.match((await painel('gestor-fixture','resolver',{marca:'fish',etapa:bia.etapa,username:'bia',tentativa:1,estado:'aceito',decisao:'liberar'})).erro,/estado mudou/);
 assert.equal((await painel('gestor-fixture','resolver',{marca:'fish',etapa:bia.etapa,username:'bia',tentativa:1,estado:'bloqueado',decisao:'liberar',obs:'respondi no chat'})).ok,true);
 assert.equal((await one("SELECT count(*)::int n FROM crm_tts_cobranca_pulo WHERE username='bia'")).n,0);
 assert.equal((await one("SELECT decisao,por FROM crm_tts_cobranca_resolucao_v2 WHERE username='bia'")).por,'Marcela');
 // Dia seguinte (desloca a data das reservas de ontem).
 const ontem=async()=>{await db.exec("UPDATE crm_tts_cobranca_intencao_v2 SET dia_reserva=dia_reserva-1,reservado_em=reservado_em-interval '1 day'");};
 await ontem();
 script.caio={sendThrow:true};
 calls.length=0;r=await run();
 const d2=Object.fromEntries(r.filter(x=>x.marca==='fish').map(x=>[x.username,x.estado]));
 assert.equal(d2.bia,'aceito','resposta vista não bloqueia mais');
 assert.equal(d2.caio,'incerto');
 assert.equal((await estado('fish','caio')).motivo,'transporte_resultado_incerto');

 // 6) Incerto depois do envio: a marca para até a Marcela conferir. Nada é reenviado sozinho.
 await pessoa('fish','fabi');await ontem();
 await db.exec("UPDATE crm_tts_cobranca_intencao_v2 SET reservado_em=reservado_em-interval '8 days' WHERE username IN ('ana','duda','bia')");
 calls.length=0;r=await run();
 assert.equal(sends().length,0,'marca parada');assert.ok(r.every(x=>x.marca!=='fish'||x.motivo==='marca_parada_envio_incerto'),JSON.stringify(r));
 assert.equal((await painel('gestor-fixture','ler')).regras.find(g=>g.marca==='fish').parada,true);
 assert.match((await painel('gestor-fixture','resolver',{marca:'fish',etapa:'vitrine_sem_video',username:'caio',tentativa:1,estado:'incerto',decisao:'liberar'})).erro,/não chegou a ser enviado/);
 assert.equal((await painel('gestor-fixture','resolver',{marca:'fish',etapa:'vitrine_sem_video',username:'caio',tentativa:1,estado:'incerto',decisao:'chegou'})).ok,true);
 await db.exec("UPDATE crm_tts_regra SET cobranca_max_dia=10 WHERE marca='fish'");
 calls.length=0;script={};r=await run();
 const d3=Object.fromEntries(r.filter(x=>x.marca==='fish').map(x=>[x.username+':'+x.tentativa,x.estado]));
 assert.equal(d3['fabi:1'],'aceito');assert.equal(d3['duda:2'],'aceito','segundo toque depois do intervalo');
 assert.equal(d3['caio:2'],undefined,'caio respeita o intervalo desde o toque confirmado');

 // 7) Aprovação retirada: nada sai com o texto antigo, nem de revisão já gerada.
 ler=await painel('gestor-fixture','ler');
 const m1=ler.modelos.find(m=>m.marca==='fish'&&m.etapa==='vitrine_sem_video'&&m.tentativa===2);
 const rev=await one("SELECT id FROM crm_tts_cobranca_revisao_v2 WHERE marca='fish' AND etapa='vitrine_sem_video' AND tentativa=2 LIMIT 1");
 assert.equal((await painel('gestor-fixture','modelo_revogar',{marca:'fish',etapa:'vitrine_sem_video',tentativa:2,esperado:m1.atualizado_em})).ok,true);
 if(rev)assert.equal((await one('SELECT crm_tts_cobranca_motivo_v2($1) AS m',[rev.id])).m,'modelo_nao_aprovado');
 await ontem();await db.exec("UPDATE crm_tts_cobranca_intencao_v2 SET reservado_em=reservado_em-interval '8 days'");
 calls.length=0;r=await run();
 assert.ok(!r.some(x=>x.marca==='fish'&&x.etapa==='vitrine_sem_video'&&x.tentativa===2),'toque 2 de vitrine não sai sem aprovação');

 // 8) Tirar da régua e devolver.
 const duda=(await painel('gestor-fixture','ler')).envios.find(e=>e.username==='duda');
 assert.equal((await painel('gestor-fixture','resolver',{marca:'fish',etapa:duda.etapa,username:'duda',tentativa:duda.tentativa,estado:duda.estado,decisao:'suprimir',obs:'pediu para parar'})).ok,true);
 ler=await painel('gestor-fixture','ler');const sup=ler.supressoes.find(s=>s.username==='duda');assert.ok(sup);
 await ontem();await db.exec("UPDATE crm_tts_cobranca_intencao_v2 SET reservado_em=reservado_em-interval '8 days'");
 r=await run();assert.ok(!r.some(x=>x.username==='duda'));
 assert.equal((await painel('gestor-fixture','reativar',{marca:'fish',creator_open_id:sup.creator_open_id})).ok,true);

 // 9) Bloqueio técnico sem transporte volta sozinho; reserva velha presa também, sempre auditado.
 await pessoa('fish','gil');script.gil={open:{code:500}};
 await ontem();await db.exec("UPDATE crm_tts_cobranca_intencao_v2 SET reservado_em=reservado_em-interval '8 days'");
 r=await run();assert.equal((await estado('fish','gil')).motivo,'im_abertura_invalida');
 await db.exec("UPDATE crm_tts_cobranca_intencao_v2 SET concluido_em=now()-interval '8 days',reservado_em=reservado_em-interval '8 days',dia_reserva=dia_reserva-8 WHERE username='gil'");
 script={};r=await run();assert.equal(r.find(x=>x.username==='gil')?.estado,'aceito');
 assert.ok((await one("SELECT count(*)::int n FROM crm_tts_cobranca_resolucao_v2 WHERE username='gil' AND decisao='auto_liberar'")).n>=1);
 // Humano não volta sozinho.
 assert.equal((await one("SELECT count(*)::int n FROM crm_tts_cobranca_resolucao_v2 WHERE decisao='auto_liberar' AND motivo_antes='im_resposta_criador'")).n,0);
 console.log('tts-cobranca-auto-postgres: ok');
})().catch(e=>{console.error(e);process.exit(1);});
