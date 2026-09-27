'use strict';
// Tabelas do painel: rótulo da coluna em cada célula (cartão no celular) e 20 linhas por vez sem mudar a ordem.
const test=require('node:test'),assert=require('node:assert/strict');const {parseHTML}=require('linkedom');
const T=require('../painel-tabelas.js');
const tabela=n=>`<main><div class="rolagem"><table class="comparativo"><thead><tr><th>Dia</th><th></th><th class="num">Pedidos</th></tr></thead><tbody>${
 Array.from({length:n},(_,i)=>`<tr><td>${i+1}</td><td><span class="tag">x</span></td><td>${i}</td></tr>`).join('')}</tbody></table></div></main>`;

test('cada célula recebe o título da coluna; coluna sem título fica vazia',()=>{
 const {document}=parseHTML(tabela(3));T.aplicar(document.querySelector('main'),document);
 const td=[...document.querySelectorAll('tbody tr:first-child td')].map(x=>x.getAttribute('data-label'));
 assert.deepEqual(td,['Dia','','Pedidos']);assert.ok(document.querySelector('table').classList.contains('tab-cartao'));
});

test('lista curta não ganha botão; lista longa mostra 20 e revela mais 20 por clique',()=>{
 const curto=parseHTML(tabela(24)).document;T.aplicar(curto.querySelector('main'),curto);
 assert.equal(curto.querySelector('.tab-mais'),null);assert.equal([...curto.querySelectorAll('tbody tr')].filter(r=>r.hidden).length,0);
 const {document}=parseHTML(tabela(50));T.aplicar(document.querySelector('main'),document);
 const visiveis=()=>[...document.querySelectorAll('tbody tr')].filter(r=>!r.hidden).map(r=>r.firstElementChild.textContent);
 assert.equal(visiveis().length,20);assert.deepEqual(visiveis().slice(0,3),['1','2','3']);
 const btn=document.querySelector('.tab-mais');assert.match(btn.textContent,/Mostrar mais 20 · faltam 30/);
 btn.onclick();assert.equal(visiveis().length,40);btn.onclick();assert.equal(visiveis().length,50);
 assert.equal(document.querySelector('.tab-mais'),null,'sem linhas escondidas, o botão some');
});

test('reaplicar não duplica botão nem troca rótulo já definido',()=>{
 const {document}=parseHTML(tabela(30));const m=document.querySelector('main');T.aplicar(m,document);T.aplicar(m,document);
 assert.equal(document.querySelectorAll('.tab-mais').length,1);
 document.querySelector('td').setAttribute('data-label','Manual');T.aplicar(m,document);assert.equal(document.querySelector('td').getAttribute('data-label'),'Manual');
});
