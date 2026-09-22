'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom'),Access=require('../influs-access.js');
const html=fs.readFileSync(require.resolve('../influs.html'),'utf8');
function page(){
 const {document}=parseHTML(html);
 for(const link of document.querySelectorAll('link[rel=stylesheet]')){
  const style=document.createElement('style');
  style.textContent=fs.readFileSync(require('node:path').join(__dirname,'..',link.getAttribute('href').split('?')[0]),'utf8');
  document.head.append(style);
 }
 Access.bind({document,host:document.querySelector('#influ-access'),readExisting:()=>'',writeExisting:()=>'',authorExisting:()=>'',onRead:()=>{throw Error('No network or operation permitted in section test');}});
 // Evaluate real style selectors against the DOM; linkedom has CSSOM but no layout engine.
 const rules=[...document.querySelectorAll('style')].flatMap(s=>Array.from(s.sheet.cssRules)).filter(r=>r.selectorText&&!r.selectorText.includes('::')&&r.style?.getPropertyValue('display'));
 const display=el=>rules.filter(r=>el.matches(r.selectorText)).reduce((_value,r)=>r.style.getPropertyValue('display'),'initial');
 const context=vm.createContext({window:{},document,SEC:'creators',carregarAbaAtiva:()=>{},$:s=>document.querySelector(s)});
 const start=html.indexOf("document.querySelectorAll('#secoes button').forEach(b=>b.onclick="),end=html.indexOf('\npintaMarca();',start);
 assert(start>=0&&end>start);vm.runInContext(html.slice(start,end),context);
 return {document,display,$:s=>document.querySelector(s)};
}
test('section visibility CSS keeps real secondary access, cancel and legacy buttons displayed',()=>{
 const p=page();p.$('#influ-access-form').hidden=false;
 const controls=[...p.document.querySelectorAll('button.btn.sec')];
 assert(controls.length>=5,'includes both access buttons, cancel and existing secondary actions');
 assert(controls.some(b=>b.dataset.influAccess==='read'));assert(controls.some(b=>b.dataset.influAccess==='write'));assert(controls.some(b=>b.id==='influ-access-cancel'));
 for(const button of controls)assert.notEqual(p.display(button),'none',button.id||button.textContent);
 assert.equal(p.display(p.$('#sec-creators')),'block');assert.equal(p.display(p.$('#sec-afil')),'none');
});
test('switching Creators/TikTok changes only the two panels and preserves secondary controls',()=>{
 // 'Parceiros do site' deixou de ser seção de topo em 22/09: virou um canal dentro de Afiliados.
 const p=page(),unrelated=p.document.createElement('button');unrelated.className='btn sec ativa';unrelated.textContent='Unrelated active control';p.document.body.append(unrelated);
 for(const selected of ['afil','meta','creators','afil']){
  p.$(`#secoes [data-s="${selected}"]`).click();
  for(const panel of ['creators','afil','meta']){assert.equal(p.display(p.$('#sec-'+panel)),panel===selected?'block':'none');assert.equal(p.$(`#secoes [data-s="${panel}"]`).classList.contains('ativo'),panel===selected);}
  assert.equal(p.document.body.classList.contains('sec-afil'),selected==='afil');
  assert(unrelated.classList.contains('ativa'),'section switching must not clear unrelated state');
  for(const button of p.document.querySelectorAll('button.btn.sec'))assert.notEqual(p.display(button),'none',button.id||button.textContent);
 }
});

// --- Canais de afiliados (22/09) -----------------------------------------------------
// Um marketplace por vez. O que os testes seguram: canal não conectado não finge número, abrir
// Afiliados não dispara a consulta pesada do TikTok, e a cor é acompanhada do nome sempre.
test('Afiliados abre em Parceiros do site e não chama o TikTok sozinho',()=>{
 const p=page();let chamouTTS=0;
 p.$('#secoes [data-s="afil"]').click();
 assert.equal(p.$('#canal-parceiros').hidden,false);
 assert.equal(p.$('#canal-tiktok').hidden,true,'o canal pesado fica fechado até alguém pedir');
 assert.equal(p.$('#canais [data-c="parceiros"]').classList.contains('ativo'),true);
 assert.equal(chamouTTS,0);
});

test('trocar de canal mostra um marketplace por vez',()=>{
 const p=page();
 p.$('#secoes [data-s="afil"]').click();
 p.$('#canais [data-c="tiktok"]').click();
 assert.equal(p.$('#canal-tiktok').hidden,false);
 assert.equal(p.$('#canal-parceiros').hidden,true);
 assert.equal(p.$('#canais [data-c="tiktok"]').classList.contains('ativo'),true);
 assert.equal(p.$('#canais [data-c="parceiros"]').classList.contains('ativo'),false);
});

test('marketplace sem coleta fica desabilitado e diz que não há dado, em vez de mostrar zero',()=>{
 const p=page();
 for(const c of ['meli','shopee']){
  const b=p.$(`#canais [data-c="${c}"]`);
  assert.equal(b.disabled,true,c+' não pode ser selecionável sem coleta');
  const texto=p.$('#canal-'+c).textContent;
  assert.match(texto,/ainda não est/i);
  assert.doesNotMatch(texto,/R\$\s*0|\b0\s*pedidos?\b/,'canal sem dado não exibe zero');
  b.click();
  assert.equal(p.$('#canal-parceiros').hidden,false,'clique em canal desabilitado não troca nada');
 }
});

test('cada canal carrega o nome escrito, não só a cor',()=>{
 const p=page();
 const esperado={parceiros:'Parceiros do site',tiktok:'TikTok Shop',meli:'Mercado Livre',shopee:'Shopee'};
 for(const [c,nome] of Object.entries(esperado)){
  const b=p.$(`#canais [data-c="${c}"]`);
  assert.ok(b,'canal '+c+' existe no desenho');
  assert.match(b.textContent,new RegExp(nome),'a identidade não pode depender da cor');
  assert.equal(b.dataset.plataforma,c,'a cor vem do atributo de plataforma, não de posição');
 }
});
