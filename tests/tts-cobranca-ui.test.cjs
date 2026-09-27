'use strict';
// Aba Cobrança v2: estado por marca, pendências com a ação certa para cada estado, aprovação em dois toques,
// leitura sem botões de gravar, escape de texto vindo do banco e workflow do painel.
const test=require('node:test'),assert=require('node:assert/strict');
const {parseHTML}=require('linkedom');
const C=require('../tts-cobranca.js'),W=require('../n8n/tiktok/cobranca-painel-workflow.cjs'),S=require('../n8n/tiktok/cobranca-v2-workflow.cjs');

const ler=(over={})=>({ok:true,pode_escrever:true,autor:'Marcela',
 modelos:[{marca:'fish',etapa:'vitrine_sem_video',tentativa:1,texto:'Opa{nome}! <b>linha</b>',ativo:true,aprovado:false,atualizado_em:'2026-09-26 10:00:00.123456+00'},
  {marca:'fish',etapa:'vitrine_sem_video',tentativa:2,texto:'Segundo toque',ativo:true,aprovado:true,aprovado_por:'Marcela',aprovado_em:'2026-09-26T10:00:00Z',atualizado_em:'2026-09-26 10:01:00+00'},
  {marca:'aristo',etapa:'amostra_sem_video',tentativa:1,texto:'Aristo',ativo:true,aprovado:false,atualizado_em:'2026-09-26 10:02:00+00'}],
 regras:[{marca:'fish',cobranca_modo:'dry_run',pronta:true,hoje:0,max_dia:15,parada:false},{marca:'aristo',cobranca_modo:'pausado',pronta:false,hoje:0,max_dia:15,parada:false}],
 envios:[{marca:'fish',etapa:'vitrine_sem_video',username:'bia',tentativa:1,estado:'bloqueado',motivo:'im_resposta_criador',texto:'oi',humano:true,suprimido:false,reservado_em:'2026-09-26T16:20:00Z'},
  {marca:'fish',etapa:'vitrine_sem_video',username:'caio',tentativa:1,estado:'incerto',motivo:'transporte_resultado_incerto',texto:'oi',humano:true,suprimido:false,transporte_em:'2026-09-26T16:21:00Z'},
  {marca:'fish',etapa:'amostra_sem_video',username:'ana',tentativa:1,estado:'aceito',motivo:'api_aceitou',texto:'oi',humano:false,suprimido:false,concluido_em:'2026-09-26T16:22:00Z'}],
 simulacoes:[{marca:'fish',etapa:'vitrine_sem_video',username:'<img src=x>',tentativa:1,texto:'Opa!',simulado_em:'2026-09-26T16:20:00Z',aprovado:false}],
 supressoes:[],resolucoes:[],...over});
function setup(payload=ler(),marca='fish'){
 const {document}=parseHTML('<div id="h"></div>');const posts=[];
 const fetchImpl=async(url,opt)=>{const b=JSON.parse(opt.body);posts.push(b);return {ok:true,json:async()=>b.acao==='ler'?payload:{ok:true,mensagem:'Feito.'}};};
 let changes=0;const cob=C.create({document,endpoint:()=>'https://n8n.example/webhook/x',key:()=>'chave-sintetica',getMarca:()=>marca,fetchImpl,onChange:()=>changes++});
 return {document,posts,cob,changes:()=>changes,host:document.getElementById('h')};
}
const tick=()=>new Promise(r=>setImmediate(r));

test('painel mostra estado da marca, pendências certas e mensagens sem escapar HTML',async()=>{
 const t=setup();t.cob.mount(t.host);await tick();await tick();
 const h=t.host.innerHTML;
 assert.equal(t.posts[0].acao,'ler');assert.equal(t.posts[0].k,'chave-sintetica');assert.equal(t.changes(),1);
 assert.match(h,/simulação/);assert.match(h,/1<\/strong> de 2 mensagens aprovadas/);
 assert.ok(!h.includes('<b>linha</b>')&&h.includes('&lt;b&gt;linha&lt;/b&gt;'));assert.ok(!h.includes('<img src=x>'));
 assert.ok(!h.includes('Aristo'),'filtro de marca');
 const bia=[...t.host.querySelectorAll('[data-username="bia"]')].map(b=>b.dataset.decisao).sort();
 assert.deepEqual(bia,['liberar','suprimir']);
 const caio=[...t.host.querySelectorAll('[data-username="caio"]')].map(b=>b.dataset.decisao).sort();
 assert.deepEqual(caio,['chegou','nao_chegou'],'enviado sem confirmação: só conferir no Seller Center');
 assert.equal(t.cob.pronta('fish'),true);assert.equal(t.cob.pronta('aristo'),false);
});
test('aprovar pede dois toques e manda texto e versão exatos',async()=>{
 const t=setup();t.cob.mount(t.host);await tick();await tick();
 let b=t.host.querySelector('[data-cob="aprovar"]');b.onclick();assert.equal(t.posts.length,1,'primeiro toque só arma');assert.match(b.textContent,/Aprovar\?/);
 b.onclick();await tick();await tick();
 const p=t.posts[1];assert.equal(p.acao,'modelo_salvar');assert.deepEqual(p.data,{marca:'fish',etapa:'vitrine_sem_video',tentativa:1,esperado:'2026-09-26 10:00:00.123456+00',texto:'Opa{nome}! <b>linha</b>'});
 assert.equal(t.posts[2].acao,'ler');
 t.host.querySelector('[data-username="caio"][data-decisao="chegou"]').onclick();t.host.querySelector('[data-username="caio"][data-decisao="chegou"]').onclick();await tick();await tick();
 assert.deepEqual(t.posts[3].data,{marca:'fish',etapa:'vitrine_sem_video',username:'caio',tentativa:1,estado:'incerto',decisao:'chegou'});
});
test('editar e salvar aprova o texto novo; chave de leitura não vê botões de gravar',async()=>{
 const t=setup();t.cob.mount(t.host);await tick();await tick();
 t.host.querySelector('[data-cob="editar"]').onclick();
 const ta=t.host.querySelector('.cob-texto');ta.value='Texto novo {nome}';
 const s=t.host.querySelector('[data-cob="salvar"]');s.onclick();s.onclick();await tick();await tick();
 assert.equal(t.posts[1].data.texto,'Texto novo {nome}');
 const r=setup(ler({pode_escrever:false}));r.cob.mount(r.host);await tick();await tick();
 assert.equal(r.host.querySelectorAll('.cob-btn').length,0);assert.match(r.host.innerHTML,/só lê/);
});
test('erro de leitura mostra tentar de novo; todas as marcas mostram a marca na linha',async()=>{
 const {document}=parseHTML('<div id="h"></div>');
 const cob=C.create({document,endpoint:()=>'x',key:()=>'k',getMarca:()=>'todas',fetchImpl:async()=>({ok:false,json:async()=>({erro:'Entre com a chave do painel de Influs.'})})});
 cob.mount(document.getElementById('h'));await tick();await tick();assert.match(document.getElementById('h').innerHTML,/Tentar de novo/);
 const t=setup(ler(),'todas');t.cob.mount(t.host);await tick();await tick();assert.match(t.host.innerHTML,/Aristo/);assert.match(t.host.innerHTML,/O Aristocrata/);
});
test('workflow do painel: caminho fixo, ações fechadas, parâmetro nativo, nada salvo da execução',()=>{
 assert.throws(()=>W.buildWorkflow({webhookPath:'x'}));
 const w=W.buildWorkflow({webhookPath:'tts-cobranca-painel-0123456789abcdef'});
 assert.equal(w.settings.saveDataSuccessExecution,'none');assert.equal(w.settings.saveDataErrorExecution,'none');
 assert.equal(w.nodes.find(n=>n.name==='Executa').parameters.options.queryReplacement,'={{ $json.args }}');
 const run=body=>new Function('$json',W.MONTA.replace(/^\/\/.*\n/,''))({body});
 assert.throws(()=>run({acao:'enviar'}),/acao/);assert.throws(()=>run({acao:'ler',x:'y'.repeat(5000)}),/grande/);
 assert.deepEqual(run({acao:'ler',k:'a'})[0].json.args,[JSON.stringify({acao:'ler',k:'a'})]);
});
test('sender v2 não mantém envio legado nem chamada de mensagem fora do node Envia',()=>{
 const fresh={id:S.WORKFLOW_ID,versionId:'v',activeVersionId:'v',settings:{},connections:{},nodes:[...S.KEEP.map(name=>({name,type:'x',parameters:{}})),
  {name:S.LEGACY,type:'n8n-nodes-base.code',parameters:{jsCode:"const helpers = this.helpers;\nconst APP_SECRET = 's';\nconst BASE = 'https://open-api.tiktokglobalshop.com';\nfunction assinar(){}\nfor (const it of $('Pegar tokens (Token Manager)').all()) {}\nasync function chamar(){}\n"+S.BOUNDARY+';'}},
  {name:'Grava log',type:'n8n-nodes-base.postgres',parameters:{},credentials:{postgres:{id:'pg'}}}]};
 const w=S.buildSender(fresh,{expectedVersionId:'v'});
 const comEnvio=w.nodes.filter(n=>(n.parameters.jsCode||'').includes("/202412/conversations/' + encodeURIComponent"));
 assert.deepEqual(comEnvio.map(n=>n.name),['Envia']);
 assert.ok(w.nodes.find(n=>n.name==='Envia').parameters.jsCode.includes('JSON.stringify({ content: ctx.texto })'));
 assert.ok(w.nodes.every(n=>n.name!==S.LEGACY));
});
