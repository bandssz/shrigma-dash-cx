'use strict';
// Candidaturas do site no painel: números e CPM do servidor, links só de perfil válido, texto escapado,
// prints só quando pedidos, filtro "para analisar" e atalho para o cadastro.
const test=require('node:test'),assert=require('node:assert/strict');const {parseHTML}=require('linkedom');
const P=require('../partner-candidaturas.js');
const app=o=>({id:'a1',candidate_id:'c1',marca:'aristo',nome:'<b>Carlos</b>',email:'c@x.com',whatsapp:'5541999060777',instagram:'carlos.silva',tiktok:'x" onclick="y',seguidores:12000,nicho:'barba',
 cidade:'Curitiba',uf:'PR',views_stories:1500,views_reels:null,preco_story:150,preco_reels:null,cpm_story:100,cpm_reels:null,mensagem:'oi',termo_versao:1,aceite_em:'2026-09-27T12:00:00Z',
 criado_em:'2026-09-27T12:00:00Z',estado:'novo',prints:[{id:'f1',ordem:1,mime:'image/jpeg'}],...o});
function setup(apps,marca='aristo'){
 const {document}=parseHTML('<div id="h"></div><button data-candidate-edit="c1" id="edit">e</button>');const posts=[];
 globalThis.CSS=globalThis.CSS||{escape:s=>s};
 const fetchImpl=async(u,o)=>{const b=JSON.parse(o.body);posts.push(b);return {ok:true,json:async()=>b.acao==='ler'?{ok:true,termos:[{marca:'aristo',versao:1,publicado_em:'2026-09-27'}],candidaturas:apps}:{ok:true,mime:'image/jpeg',base64:'QUJD'}};};
 const c=P.create({document,endpoint:()=>'https://x/y',key:()=>'k',getMarca:()=>marca,fetchImpl});return {document,posts,c,host:document.getElementById('h')};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('cartão mostra números, CPM e links seguros',async()=>{
 const t=setup([app(),app({id:'a2',candidate_id:'c2',estado:'recusado',nome:'Outro'})]);t.c.mount(t.host);await tick();await tick();
 const h=t.host.innerHTML;assert.ok(!h.includes('<b>Carlos</b>'));assert.match(h,/12\.000/);assert.match(t.host.textContent,/CPM R\$\s?100,00/);
 assert.match(h,/instagram\.com\/carlos\.silva/);assert.ok(!h.includes('tiktok.com'),'handle inválido não vira link');assert.match(h,/wa\.me\/5541999060777/);
 assert.equal(t.host.querySelectorAll('.pc-card').length,1,'para analisar: só novas/em análise');assert.match(h,/formulário aberto/);
 t.host.querySelector('[data-f=todas]').onclick();assert.equal(t.host.querySelectorAll('.pc-card').length,2);
});
test('prints só carregam quando pedidos; atalho abre o cadastro',async()=>{
 const t=setup([app()]);t.c.mount(t.host);await tick();await tick();assert.equal(t.posts.length,1);
 t.host.querySelector('[data-pc=prints]').onclick();await tick();await tick();await tick();
 assert.deepEqual(t.posts[1],{acao:'print',id:'f1',k:'k'});assert.ok(t.host.querySelector('.pc-foto img').getAttribute('src').startsWith('data:image/jpeg;base64,QUJD'));
 let aberto=false;t.document.getElementById('edit').onclick=()=>{aberto=true};t.document.getElementById('edit').click=function(){this.onclick()};
 t.host.querySelector('[data-pc=abrir]').onclick();assert.equal(aberto,true);
});
test('marca sem termo publicado avisa formulário fechado',async()=>{
 const t=setup([],'fish');t.c.mount(t.host);await tick();await tick();assert.match(t.host.innerHTML,/formulário fechado em Fishermans/);
});
