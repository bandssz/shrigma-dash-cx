'use strict';
// Candidaturas do site no painel: números e CPM do servidor, links só de perfil válido, texto escapado,
// prints só quando pedidos, filtro "para analisar" e atalho para o cadastro.
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
 let aberto=false;t.document.getElementById('edit').onclick=()=>{aberto=true};t.document.getElementById('edit').click=function(){this.onclick()};
 t.host.querySelector('[data-pc=abrir]').onclick();assert.equal(aberto,true);
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
