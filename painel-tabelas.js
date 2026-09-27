/* Tabelas do painel (27/09/2026).
   1. Cada célula ganha data-label com o título da coluna: no celular a linha vira cartão (CSS em organico-mobile.css).
   2. Lista longa mostra 20 linhas e um botão "Mostrar mais"; a ordem e os filtros continuam sendo da tabela.
   3. Trocar de aba no celular centraliza a aba e volta ao topo do conteúdo.
   Nada aqui muda número: só apresentação. Re-render da tabela é refeito sozinho pelo observador. */
(function(root){
 'use strict';
 const LIMITE=20,FOLGA=5;
 const txt=el=>String(el.textContent||'').replace(/\s+/g,' ').trim();
 function rotular(t){
  const ths=[...t.querySelectorAll(':scope>thead>tr:last-child>th')].map(txt);
  if(!ths.length)return;
  t.classList.add('tab-cartao');
  for(const tr of t.querySelectorAll(':scope>tbody>tr')){
   let c=0;for(const td of tr.children){if(!td.hasAttribute('data-label'))td.setAttribute('data-label',ths[c]||'');c+=Number(td.colSpan)||1;}
  }
 }
 function limitar(t,doc){
  const body=t.querySelector(':scope>tbody');if(!body)return;
  const rows=[...body.children].filter(r=>r.tagName==='TR'&&!r.querySelector('td[colspan]'));
  const alvo=t.closest('.rolagem')||t;let btn=alvo.nextElementSibling&&alvo.nextElementSibling.classList.contains('tab-mais')?alvo.nextElementSibling:null;
  if(rows.length<=LIMITE+FOLGA){rows.forEach(r=>{if(r.hidden)r.hidden=false;});if(btn)btn.remove();return;}
  const n=Math.min(rows.length,Number(t.dataset.visiveis)||LIMITE);
  rows.forEach((r,i)=>{const h=i>=n;if(r.hidden!==h)r.hidden=h;});
  const resta=rows.length-n;
  if(!resta){if(btn)btn.remove();return;}
  if(!btn){btn=doc.createElement('button');btn.type='button';btn.className='btn sec tab-mais';alvo.parentNode.insertBefore(btn,alvo.nextSibling);}
  const rot=`Mostrar mais ${Math.min(LIMITE,resta)} · faltam ${resta.toLocaleString('pt-BR')}`;
  if(btn.textContent!==rot)btn.textContent=rot;
  btn.onclick=()=>{t.dataset.visiveis=String(n+LIMITE);limitar(t,doc);};
 }
 function aplicar(scope,doc){
  for(const t of scope.querySelectorAll('table.comparativo')){rotular(t);limitar(t,doc);}
 }
 function bind({document:doc,root:scope,tabs}){
  const alvo=scope||doc.querySelector('main');if(!alvo)return null;
  let fila=0;
  const rodar=()=>{fila=0;aplicar(alvo,doc);};
  aplicar(alvo,doc);
  const obs=new (doc.defaultView||root).MutationObserver(ms=>{
   if(ms.every(m=>[...m.addedNodes].every(n=>n.nodeType!==1||n.classList?.contains('tab-mais'))))return;
   if(!fila)fila=(doc.defaultView||root).requestAnimationFrame(rodar);
  });
  obs.observe(alvo,{childList:true,subtree:true});
  if(tabs)for(const b of doc.querySelectorAll(tabs))b.addEventListener('click',()=>{
   const w=doc.defaultView||root;if(!w.matchMedia||!w.matchMedia('(max-width:720px)').matches)return;
   if(b.scrollIntoView)b.scrollIntoView({block:'nearest',inline:'center'});
   const m=doc.querySelector('main');if(m&&w.scrollY>m.offsetTop)w.scrollTo({top:Math.max(0,m.offsetTop-60)});
  });
  return {aplicar:()=>aplicar(alvo,doc),parar:()=>obs.disconnect()};
 }
 root.PainelTabelas={bind,aplicar,rotular,limitar,LIMITE};
})(typeof window!=='undefined'?window:globalThis);
if(typeof module!=='undefined'&&module.exports)module.exports=globalThis.PainelTabelas;
