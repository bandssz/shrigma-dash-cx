'use strict';
// Candidaturas do site no painel: números e CPM do servidor, links só de perfil válido, texto escapado,
// capa do print, visor, filtro "para analisar", aprovar (cupom + link), recusar e envio do produto.
const test=require('node:test'),assert=require('node:assert/strict');const {parseHTML}=require('linkedom');
const P=require('../partner-candidaturas.js');
const app=o=>({id:'a1',candidate_id:'c1',marca:'aristo',nome:'<b>Carlos</b>',email:'c@x.com',whatsapp:'5541999060777',instagram:'carlos.silva',tiktok:'x" onclick="y',seguidores:12000,nicho:'barba',
 cidade:'Curitiba',uf:'PR',views_stories:1500,views_reels:null,preco_story:150,preco_reels:null,cpm_story:100,cpm_reels:null,mensagem:'oi',termo_versao:1,aceite_em:'2026-09-27T12:00:00Z',
 criado_em:'2026-09-27T12:00:00Z',estado:'novo',prints:[{id:'f1',ordem:1,mime:'image/jpeg'}],...o});
function setup(apps,marca='aristo'){
 const {document}=parseHTML('<html><body><div id="h"></div><button data-candidate-edit="c1" id="edit">e</button></body></html>');const posts=[];
 globalThis.CSS=globalThis.CSS||{escape:s=>s};
 const fetchImpl=async(u,o)=>{const b=JSON.parse(o.body);posts.push(b);return {ok:true,json:async()=>b.acao==='ler'?{ok:true,termos:[{marca:'aristo',versao:1,publicado_em:'2026-09-27'}],candidaturas:apps}:{ok:true,mime:'image/jpeg',base64:'QUJD'}};};
 const c=P.create({document,endpoint:()=>'https://x/y',key:()=>'k',getMarca:()=>marca,fetchImpl});return {document,posts,c,host:document.getElementById('h')};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('cartão mostra números, CPM e links seguros',async()=>{
 const t=setup([app(),app({id:'a2',candidate_id:'c2',estado:'recusado',nome:'Outro'})]);t.c.mount(t.host);await tick();await tick();
 const h=t.host.innerHTML;assert.equal(t.host.querySelector('h3').textContent,'<b>Carlos</b>');assert.equal(t.host.querySelector('h3 b'),null,'nome escapado, não vira HTML');assert.match(h,/12\.000/);assert.match(t.host.textContent,/CPM R\$\s?100,00/);
 assert.match(h,/instagram\.com\/carlos\.silva/);assert.ok(!h.includes('tiktok.com'),'handle inválido não vira link');assert.match(h,/wa\.me\/5541999060777/);
 assert.equal(t.host.querySelectorAll('.pc-card').length,1,'para analisar: só novas/em análise');assert.match(h,/formulário aberto/);
 t.host.querySelector('[data-f=todas]').onclick();assert.equal(t.host.querySelectorAll('.pc-card').length,2);
});
test('capa: primeiro print das candidaturas em análise carrega sozinho; clicar abre o visor com todos',async()=>{
 const t=setup([app({prints:[{id:'f1',ordem:1,mime:'image/jpeg'},{id:'f2',ordem:2,mime:'image/jpeg'}]}),app({id:'a2',candidate_id:'c2',estado:'recusado',prints:[{id:'f9',ordem:1,mime:'image/jpeg'}]})]);
 t.c.mount(t.host);for(let i=0;i<6;i++)await tick();
 assert.deepEqual(t.posts.map(p=>p.acao+(p.id?':'+p.id:'')),['ler','print:f1'],'só a capa da candidatura aberta; recusada e segundo print ficam para depois');
 assert.ok(t.host.querySelector('.pc-foto img').getAttribute('src').startsWith('data:image/jpeg;base64,QUJD'));
 assert.match(t.host.querySelector('.pc-foto .pc-n').textContent,/2/,'mostra quantos prints há');
 t.host.querySelector('[data-pc=prints]').onclick();for(let i=0;i<6;i++)await tick();
 assert.deepEqual(t.posts.slice(2),[{acao:'print',id:'f2',k:'k'}]);const v=t.document.querySelector('.pc-visor');assert.ok(v,'visor aberto');
 assert.equal(v.querySelectorAll('img').length,2);v.querySelector('[data-fechar]').click?.();
});
test('ressalvas viram etiqueta com title, sem parágrafo explicativo',async()=>{
 const t=setup([app()]);t.c.mount(t.host);await tick();await tick();
 const em=t.host.querySelector('.pc-num em');assert.match(em.getAttribute('title'),/CPM = preço declarado/);
 assert.match(t.host.querySelector('.pc-meta .tag.bom').getAttribute('title'),/Aceitou o termo v1/);
 assert.ok(!/pelos números que ele declarou/.test(t.host.textContent));
 assert.match(t.host.querySelector('.painel-cab .tag.bom').getAttribute('title'),/O Aristocrata: termo v1/);
});
test('marca sem termo publicado avisa formulário fechado',async()=>{
 const t=setup([],'fish');t.c.mount(t.host);await tick();await tick();assert.match(t.host.innerHTML,/formulário fechado em Fishermans/);
});

// Fluxo de decisão: servidor de aprovação sintético.
function setupDecisao(apps,{falhaPrimeira=false}={}){
 const {document}=parseHTML('<html><body><div id="h"></div><p data-pilot-status>Acesso de operação recusado.</p></body></html>');const posts=[];
 globalThis.CSS=globalThis.CSS||{escape:s=>s};
 const parceiros=[];let falhou=!falhaPrimeira;
 const cands=[{id:'c1',marca:'aristo',name:'Carlos',handle:'@carlos.silva',source:'formulario_site',source_reference:'',state:'novo',note:'',version:1}];
 const piloto={candidates:cands,saves:[],save:async(kind,data,version)=>{piloto.saves.push({kind,data,version});piloto.candidates=[{...cands[0],state:data.state,version:version+1}];},reload:()=>{}};
 const fetchImpl=async(u,o)=>{const b=JSON.parse(o.body);posts.push({u,...b});let j;
  if(u.includes('aprovacao')){
   if(b.acao==='ler')j={ok:true,pode_escrever:true,descontos:{aristo:0.06,fish:0.05},parceiros};
   else if(b.acao==='aprovar'){if(!falhou){falhou=true;j={erro:'Shopify: fora do ar',campo:'codigo'};}
    else{parceiros.push({candidate_id:b.data.candidate_id,marca:'aristo',cupom:b.data.codigo,ref:'p-0000abcd',url:'https://oaristocrata.com/?utm_content=p-0000abcd',link_estado:'ativo',desconto:0.06,envio_estado:'pendente',envio_rastreio:''});j={ok:true,mensagem:'Parceiro aprovado: cupom '+b.data.codigo+' e link ativos.'};}}
   else if(b.acao==='envio'){Object.assign(parceiros[0],{envio_estado:b.data.estado,envio_rastreio:b.data.rastreio,envio_em:'2026-09-28T15:00:00Z'});j={ok:true};}
  }else j=b.acao==='ler'?{ok:true,termos:[{marca:'aristo',versao:1,publicado_em:'2026-09-27'}],candidaturas:apps}:{ok:true,mime:'image/jpeg',base64:'QUJD'};
  return {ok:true,json:async()=>j};};
 const c=P.create({document,endpoint:()=>'https://x/candidatura',key:()=>'leitura',chaveEscrita:()=>'gestao',getMarca:()=>'aristo',fetchImpl,aprovacaoEndpoint:()=>'https://x/aprovacao',piloto:()=>piloto});
 return {document,posts,c,piloto,host:document.getElementById('h')};
}
const espera=async()=>{for(let i=0;i<8;i++)await tick();};
test('sugestão do cupom sai do @, sem acento nem símbolo',()=>{
 assert.equal(P.sugerido('joão.pesca_brutal'),'JOAOPESCABRUTAL');assert.equal(P.sugerido('a'.repeat(40)).length,20);
});
test('aprovar: cupom sugerido, erro mantém o mesmo pedido, sucesso vai para Aprovados com cupom e link',async()=>{
 const t=setupDecisao([app({nome:'Carlos'})],{falhaPrimeira:true});t.c.mount(t.host);await espera();
 t.host.querySelector('[data-pc=aprovar]').onclick();
 const inp=t.host.querySelector('input[name=codigo]');assert.equal(inp.value,'CARLOSSILVA');assert.match(t.host.textContent,/6% de desconto/);
 inp.value='carlos 10';t.host.querySelector('[data-pc=confirma-aprovar]').onclick();await espera();
 const a1=t.posts.filter(p=>p.acao==='aprovar');assert.equal(a1.length,1);assert.equal(a1[0].data.codigo,'CARLOS10');assert.equal(a1[0].k,'gestao','aprovar usa a chave de gestão');
 assert.match(t.host.querySelector('.pc-aviso.ruim').textContent,/fora do ar/);assert.equal(t.host.querySelector('input[name=codigo]').getAttribute('aria-invalid'),'true');
 t.host.querySelector('[data-pc=confirma-aprovar]').onclick();await espera();
 const a2=t.posts.filter(p=>p.acao==='aprovar');assert.equal(a2[1].request_id,a2[0].request_id,'repetir depois de erro usa o mesmo pedido');
 assert.equal(t.host.querySelector('[data-f=aprovados]').classList.contains('ativo'),true);
 const card=t.host.querySelector('.pc-card.pc-aprovado');assert.ok(card);assert.match(card.textContent,/CARLOS10/);assert.match(card.textContent,/envio pendente/);
 assert.match(card.querySelector('a[href^="https://wa.me/5541999060777?text="]').getAttribute('href'),/CARLOS10/,'mensagem pronta com cupom e link');
 assert.equal(t.host.querySelector('[data-f=abertas] .pc-cont').textContent,'0');
});
test('recusar sai de Para analisar na hora, sem esperar outra leitura',async()=>{
 const t=setupDecisao([app({nome:'Carlos'})]);t.c.mount(t.host);await espera();
 t.host.querySelector('[data-pc=recusar]').onclick();assert.match(t.host.querySelector('[data-gaveta=recusar]').textContent,/Recusar a candidatura/);
 t.host.querySelector('[data-pc=confirma-recusar]').onclick();await espera();
 assert.deepEqual([t.piloto.saves[0].kind,t.piloto.saves[0].data.state,t.piloto.saves[0].version],['candidato','recusado',1]);
 assert.equal(t.host.querySelectorAll('.pc-card').length,0);assert.equal(t.host.querySelector('[data-f=abertas] .pc-cont').textContent,'0');
 t.host.querySelector('[data-f=todas]').onclick();assert.match(t.host.querySelector('.pc-card .tag').textContent,/recusada/);
});
test('recusar sem permissão mostra o motivo na própria linha',async()=>{
 const t=setupDecisao([app({nome:'Carlos'})]);t.piloto.save=async()=>{};t.c.mount(t.host);await espera();
 t.host.querySelector('[data-pc=recusar]').onclick();t.host.querySelector('[data-pc=confirma-recusar]').onclick();await espera();
 assert.match(t.host.querySelector('.pc-aviso.ruim').textContent,/recusado/);assert.equal(t.host.querySelectorAll('.pc-card').length,1);
});
test('envio: marcar enviado com rastreio e voltar para pendente',async()=>{
 const t=setupDecisao([app({nome:'Carlos'})]);t.c.mount(t.host);await espera();
 t.host.querySelector('[data-pc=aprovar]').onclick();t.host.querySelector('[data-pc=confirma-aprovar]').onclick();await espera();
 t.host.querySelector('[data-pc=envio]').onclick();t.host.querySelector('input[name=rastreio]').value=' BR123 ';t.host.querySelector('[data-pc=confirma-envio]').onclick();await espera();
 const e=t.posts.find(p=>p.acao==='envio');assert.deepEqual([e.data.estado,e.data.rastreio,e.k],['enviado','BR123','gestao']);
 assert.match(t.host.querySelector('.pc-card').textContent,/produto enviado · BR123/);assert.equal(t.host.querySelector('.pc-ponto'),null,'sem envio pendente');
});
