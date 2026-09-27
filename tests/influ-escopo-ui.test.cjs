'use strict';
// Escopo dos creators no painel: barras combinado × feito, texto escapado, links só do Instagram,
// formulários enviam o que a Marcela digitou (sem inventar quantidade) e marcações sem @ podem ser ligadas.
const test=require('node:test'),assert=require('node:assert/strict');const {parseHTML}=require('linkedom');
const E=require('../influ-escopo.js');
const creator=o=>({marca:'aristo',influ:'carlos',nome:'<b>Carlos</b>',ativo:true,modelo:'permuta',instagram:'carlos.silva',
 escopo:{marca:'aristo',influ:'carlos',vigente_desde:'2026-10-01',stories:4,reels:2,feed:0,tiktok:0,obs:''},
 feito:{story:1,reels:2,feed:0,tiktok:0},
 conteudos:[{id:'ig:1',tipo:'reels',permalink:'https://www.instagram.com/reel/abc/',miniatura:'https://scontent.cdninstagram.com/x.jpg',publicado_em:'2026-10-03T15:00:00Z',fonte:'ig_tags',ignorado:false},
  {id:'ig:2',tipo:'reels',permalink:'javascript:alert(1)',miniatura:'http://inseguro/x.jpg',publicado_em:'2026-10-04T15:00:00Z',fonte:'ig_tags',ignorado:false}],...o});
function setup({creators,sem=[],pode=true,marca='aristo'}={}){
 const {document}=parseHTML('<div id="h"></div>');const posts=[];
 const fetchImpl=async(u,o)=>{const b=JSON.parse(o.body);posts.push(b);
  return {ok:true,json:async()=>b.acao==='ler'?{ok:true,pode_escrever:pode,mes:b.mes,coleta:{ultima:'2026-10-05T09:10:00Z'},creators,sem_cadastro:sem}:{ok:true,mensagem:'Escopo salvo.'}};};
 const c=E.create({document,endpoint:()=>'https://x/y',key:()=>'k',getMarca:()=>marca,fetchImpl,uuid:()=>'u-1'});
 return {document,posts,c,host:document.getElementById('h')};
}
const tick=async(n=3)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};

test('cartão mostra combinado × feito, escapa texto e só linka Instagram',async()=>{
 const t=setup({creators:[creator(),creator({influ:'ana',nome:'Ana',escopo:null,feito:{story:0,reels:1,feed:0,tiktok:0},conteudos:[]})]});
 t.c.mount(t.host);await tick();
 const h=t.host.innerHTML;assert.ok(!h.includes('<b>Carlos</b>'));assert.match(t.host.textContent,/2 \/ 2/);assert.match(t.host.textContent,/1 \/ 4/);
 const links=[...t.host.querySelectorAll('.es-cont')].map(a=>a.getAttribute('href'));assert.deepEqual(links,['https://www.instagram.com/reel/abc/','#']);
 assert.equal(t.host.querySelectorAll('.es-cont img').length,1,'miniatura sem https não carrega');
 assert.equal(t.host.querySelectorAll('.es-lista')[0].querySelectorAll('.es-card').length,1,'só quem tem escopo fica em cima');
 assert.match(t.host.textContent,/Sem escopo definido\s*1/);assert.match(t.host.textContent,/1 já entregaram algo/);
 assert.equal(t.posts[0].acao,'ler');assert.equal(t.posts[0].k,'k');
});

test('salvar escopo envia os números digitados e relê',async()=>{
 const t=setup({creators:[creator()]});t.c.mount(t.host);await tick();
 t.host.querySelector('.es-card [data-es=escopo]').onclick();
 const fm=t.host.querySelector('[data-es-form=escopo]');assert.ok(fm);
 fm.querySelector('[name=reels]').value='3';fm.querySelector('[name=obs]').value='outubro';
 fm.onsubmit({preventDefault(){}});await tick();
 const s=t.posts.find(p=>p.acao==='escopo_salvar');assert.equal(s.data.marca,'aristo');assert.equal(s.data.influ,'carlos');
 assert.equal(s.data.reels,'3');assert.equal(s.data.stories,'4');assert.equal(s.data.obs,'outubro');assert.equal(s.data.instagram,'carlos.silva');
 assert.equal(t.posts.at(-1).acao,'ler');assert.match(t.host.textContent,/Escopo salvo\./);
});

test('marcar story manda id único e tipo story por padrão',async()=>{
 const t=setup({creators:[creator()]});t.c.mount(t.host);await tick();
 t.host.querySelector('.es-card [data-es=story]').onclick();
 const fm=t.host.querySelector('[data-es-form=story]');fm.onsubmit({preventDefault(){}});await tick();
 const s=t.posts.find(p=>p.acao==='conteudo_marcar');assert.equal(s.data.tipo,'story');assert.equal(s.data.id,'u-1');assert.match(s.data.dia,/^\d{4}-\d{2}-\d{2}$/);
});

test('marcação sem @ ligado pode ser ligada a um creator da mesma marca',async()=>{
 const t=setup({creators:[creator(),creator({marca:'fish',influ:'joao',nome:'João'})],sem:[{marca:'aristo',username:'fulano_',n:3}]});
 t.c.mount(t.host);await tick();
 const o=t.host.querySelector('.es-orfao');assert.ok(o);
 const opts=[...o.querySelectorAll('option')].map(x=>x.value).filter(Boolean);assert.deepEqual(opts,['carlos'],'só creators da marca da marcação');
 o.querySelector('[data-es=vincular]').onclick();await tick();assert.equal(t.posts.filter(p=>p.acao==='vincular').length,0,'sem escolher não envia');
 t.host.querySelector('.es-orfao option[value=carlos]').setAttribute('selected','');t.host.querySelector('.es-orfao [data-es=vincular]').onclick();await tick();
 const v=t.posts.find(p=>p.acao==='vincular');assert.deepEqual(v.data,{marca:'aristo',influ:'carlos',instagram:'fulano_'});
});

test('chave de leitura não mostra botões de edição; filtro de marca respeitado',async()=>{
 const t=setup({creators:[creator(),creator({marca:'fish',influ:'joao',nome:'João'})],pode:false,marca:'fish'});t.c.mount(t.host);await tick();
 assert.equal(t.host.querySelectorAll('[data-es=escopo],[data-es=story]').length,0);assert.match(t.host.textContent,/chave só de leitura/);
 assert.equal(t.host.querySelectorAll('.es-card').length,1);assert.match(t.host.textContent,/João/);assert.ok(!/Carlos/.test(t.host.textContent));
});

test('navegação de mês relê o mês pedido',async()=>{
 const t=setup({creators:[]});t.c.mount(t.host);await tick();const m0=t.posts[0].mes;
 t.host.querySelector('[data-es=mes][data-n="-1"]').onclick();await tick();
 const [a,b]=m0.split('-').map(Number),esperado=new Date(Date.UTC(a,b-2,1)).toISOString().slice(0,7);assert.equal(t.posts.at(-1).mes,esperado);
});
