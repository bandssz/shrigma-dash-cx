/* Stories: a leitura financeira usa o mesmo pedido/modelo de Venda.
   A combinação UTM identifica a superfície, não uma publicação ou URL única. */
const OS=(()=>{
 'use strict';
 const attribution=()=>typeof OA!=='undefined'?OA:require('./organico-attribution.js');
 const BRANDS={aristo:'Aristocrata',fish:'Fishermans',olivas:'Olivas'};
 const brand=v=>({aristocrata:'aristo',fishermans:'fish'}[v]||v);
 const esc=v=>String(v??'').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
 const number=v=>(typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v))?Number(v):null;
 const count=v=>{const n=number(v);return n!==null&&Number.isSafeInteger(n)&&n>=0?n:null;};
 const nf=n=>n===null?'indisponível':n.toLocaleString('pt-BR');
 const money=n=>n===null?'indisponível':n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
 const sum=(rows,key,parser=number,empty=null)=>rows.length?rows.every(r=>parser(r[key])!==null)?rows.reduce((n,r)=>n+parser(r[key]),0):null:empty;
 const value=v=>typeof v==='string'&&v.trim()!==''?v:null;
 const fields=['utm_source','utm_medium','utm_campaign','utm_content','utm_term'];
 const day=v=>String(v||'').slice(0,10);
 const dateBR=v=>{const t=new Date(v);return Number.isFinite(t.getTime())?t.toLocaleDateString('sv-SE',{timeZone:'America/Sao_Paulo'}):null;};
 const stamp=v=>Number.isFinite(Date.parse(v||''))?new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}).format(new Date(v)):'sem confirmação';
 function select(api,marca,ini,fim,model){
  const view=attribution().select(api,marca,ini,fim,model);
  if(!view.available)return view;
  const editorial=view.rows.filter(r=>r.classification==='editorial');
  // The server owns classification. Neither campaign text nor publication date classifies a sale.
  const rows=editorial.filter(r=>r.superficie==='story');
  const unknownSurface=editorial.some(r=>!value(r.superficie));
  const empty=view.complete&&!view.malformed&&!unknownSurface?0:null;
  const grupos=new Map();
  for(const r of rows){
   const parts=[brand(r.marca),...fields.map(k=>value(r[k]))],key=JSON.stringify(parts);
   if(!grupos.has(key))grupos.set(key,{marca:parts[0],utm:Object.fromEntries(fields.map((k,i)=>[k,parts[i+1]])),rows:[]});
   grupos.get(key).rows.push(r);
  }
  const groups=[...grupos.values()].map(g=>({...g,pedidos:sum(g.rows,'pedidos',count),receita:sum(g.rows,'receita_liquida'),
   first:g.rows.map(r=>day(r.dia)).sort()[0],last:g.rows.map(r=>day(r.dia)).sort().at(-1),
   pieceUnavailable:g.rows.every(r=>r.piece_status==='nao_identificada')}));
  const rawStories=Array.isArray(api.cx_story)?api.cx_story:null;
  const selectedStories=rawStories?.filter(r=>view.brands.includes(brand(r.marca))&&dateBR(r.publicado_em)>=ini&&dateBR(r.publicado_em)<=fim);
  const pieceUnavailable=api.organico_attribution.piece_identity_available===false;
  return {...view,storyRows:rows,storyGroups:groups,unknownSurface,pieceUnavailable,
   storyOrders:sum(rows,'pedidos',count,empty),storyRevenue:sum(rows,'receita_liquida',number,empty),
   combosWithCampaign:groups.filter(g=>g.utm.utm_campaign!==null).length,
   storiesCollected:selectedStories?.length??null,
   storiesWithClicks:selectedStories?.filter(r=>count(r.link_clicks)!==null).length??null};
 }
 function markup(v){
  const title='<div class="painel-cab"><h2>Conversões de Stories · Shopify</h2><span class="mini">Pedidos e receita líquida atribuídos à superfície</span></div>';
  if(!v.available)return title+'<div class="nota" role="status">Conversões de Stories indisponíveis nesta consulta. Métricas do Instagram e receita histórica não substituem esta leitura.</div>';
  const model=attribution().MODELS[v.model];
  return title+`<div class="seg-mini org-story-models" role="group" aria-label="Modelo de conversões de Stories"><button type="button" data-story-model="last_click" class="${v.model==='last_click'?'ativo':''}" aria-pressed="${v.model==='last_click'}">Último clique · 30 dias</button><button type="button" data-story-model="last_non_direct" class="${v.model==='last_non_direct'?'ativo':''}" aria-pressed="${v.model==='last_non_direct'}">Não direto · comparação</button></div>
   <div class="nota"><strong>${esc(model)} · 30 dias.</strong> Mesmo modelo e filtros de marca/período de Venda. O período financeiro é a data da compra em Brasília. Receita líquida de reembolsos, em reais, de pedidos pagos elegíveis; sem testes/cancelamentos. Os modelos são alternativas e não se somam.</div>
   ${!v.complete?'<div class="nota" role="status"><strong>Cobertura parcial.</strong> Valores presentes são parciais; ausência de linha não significa zero.</div>':''}
   ${v.malformed||v.unknownSurface?'<div class="nota" role="status">Há valores inválidos ou superfície editorial não identificada. Não trate a ausência como zero.</div>':''}
   <div class="org-story-summary"><div><span>Pedidos por Stories</span><strong data-story-total="orders">${nf(v.storyOrders)}</strong></div><div><span>Receita líquida por Stories</span><strong data-story-total="revenue">${money(v.storyRevenue)}</strong></div><div><span>Identificação de publicação</span><strong>Não comprovada</strong><span>Os valores são de Stories como superfície, sem distribuição por story.</span></div></div>
   <div class="nota">O padrão vigente reconhecido usa <code>utm_source=instagram_social</code> e <code>utm_medium=story</code>. A campanha mantém o valor do link, com ou sem data no nome. As categorias de automação DM, Bio/Linktree e mídia paga, as receitas por cupom e as vendas nativas do TikTok Shop ficam fora destes totais. Stories segue a classificação da UTM; esse rótulo não comprova o local real de publicação. Uma compra atribuída não prova efeito causal do conteúdo.</div>
   <div class="rolagem" tabindex="0" role="region" aria-label="Conversões de Stories por combinação UTM; use as setas para rolar"><table class="comparativo"><thead><tr><th>Marca / campanha UTM</th><th>Combinação registrada</th><th>Compras no recorte</th><th class="num">Pedidos</th><th class="num">Receita líquida</th><th>Story / link exato</th></tr></thead><tbody>${v.storyGroups.length?v.storyGroups.slice().sort((a,b)=>a.marca.localeCompare(b.marca)||String(a.utm.utm_campaign).localeCompare(String(b.utm.utm_campaign))).map(g=>`<tr data-story-brand="${esc(g.marca)}"><td><strong>${esc(BRANDS[g.marca]||g.marca)}</strong><div class="org-utm-values">${esc(g.utm.utm_campaign||'Campanha não informada')}</div></td><td class="mini org-utm-values">source: ${esc(g.utm.utm_source||'não informado')}<br>medium: ${esc(g.utm.utm_medium||'não informado')}<br>content: ${esc(g.utm.utm_content||'não informado')}<br>term: ${esc(g.utm.utm_term||'não informado')}</td><td class="mini">${esc(g.first)}${g.first!==g.last?' a '+esc(g.last):''}<br>Data da compra</td><td class="num tabn">${nf(g.pedidos)}</td><td class="num tabn">${money(g.receita)}</td><td class="mini">${g.pieceUnavailable?'Peça não identificada na fonte':'Vínculo de peça não comprovado'}<br>UTM não comprova URL única ou publicação.${g.utm.utm_medium==='story'&&g.utm.utm_content==='link_in_bio'?'<br><strong>Sinal conflitante:</strong> medium=story e content=link_in_bio. A regra vigente usa source/medium; o local real de publicação continua não comprovado.':''}</td></tr>`).join(''):`<tr><td colspan="6">${v.storyOrders===0?'Nenhum pedido conhecido atribuído a Stories neste período e modelo.':'Sem conversões de Stories disponíveis; cobertura ou classificação insuficiente.'}</td></tr>`}</tbody></table></div>
   <div class="nota"><strong>Cobertura de link e peça:</strong> ${nf(v.storyGroups.length)} combinações UTM observadas; ${nf(v.combosWithCampaign)} com campanha informada. ${v.pieceUnavailable?'Esta fonte não fornece vínculo verificável com story_id.':'O vínculo entre UTM e publicação ainda precisa ser comprovado.'} Não deduzimos o story pela data da campanha, produto, alcance ou clique. Os valores UTM já foram normalizados pelo coletor; não são o texto completo do link.</div>
   <div class="rolagem" tabindex="0" role="region" aria-label="Cobertura financeira de Stories por marca"><table class="comparativo"><thead><tr><th>Marca</th><th>Dias de compra cobertos</th><th class="num">Origem desconhecida no modelo</th><th>Coleta dos dias cobertos</th></tr></thead><tbody>${v.coverage.map(c=>`<tr><td>${esc(BRANDS[c.marca])}</td><td>${nf(c.covered)} de ${nf(c.expected)}</td><td class="num tabn">${nf(c.unknown)}</td><td class="mini">Mais antiga: ${esc(stamp(c.oldest))}<br>Mais recente: ${esc(stamp(c.latest))}</td></tr>`).join('')}</tbody></table></div>
   <div class="nota">Origem desconhecida não recebe crédito de Stories. As métricas do Instagram abaixo usam <strong>data da publicação</strong>: ${nf(v.storiesCollected)} stories coletados no recorte, ${nf(v.storiesWithClicks)} com métrica de toques no link disponível. São outra população e outra janela; não calculamos taxa de compra dividindo estes pedidos por esses toques.</div>`;
 }
 function render(el,api,marca,ini,fim,onModelChange){
  if(!el)return;const A=attribution();el.innerHTML=markup(select(api,marca,ini,fim,A.getModel()));
  el.querySelectorAll('[data-story-model]').forEach(button=>{button.onclick=()=>{
   if(!A.MODELS[button.dataset.storyModel])return;
   A.setModel(button.dataset.storyModel);render(el,api,marca,ini,fim,onModelChange);if(onModelChange)onModelChange(A.getModel());
   el.querySelector(`[data-story-model="${A.getModel()}"]`)?.focus();
  };});
 }
 return {select,markup,render};
})();
if(typeof module!=='undefined')module.exports=OS;
