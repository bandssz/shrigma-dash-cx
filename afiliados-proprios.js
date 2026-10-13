/* Existing store partner programme. Filters and details never authorize a write. */
(function(root){'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const number=v=>v===null||v===undefined?'—':Number(v).toLocaleString('pt-BR');
 const money=v=>v===null||v===undefined?'Indisponível':Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
 const stamp=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'Indisponível';
 const states={novo:'Novo',em_analise:'Em análise',aprovado_piloto:'Aprovado',pausado:'Pausado',recusado:'Recusado',ativo:'Ativo',revogado:'Revogado'};
 const normalize=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
 function currentLinks(data){
  const links=new Map();
  for(const link of data.links){const prior=links.get(link.candidate_id);if(!prior||prior.state==='revogado'&&(link.state!=='revogado'||Date.parse(link.updated_at)>Date.parse(prior.updated_at)))links.set(link.candidate_id,link);}
  return links;
 }
 function matches(candidate,link,{search='',state='',linkState=''}={}){
  return (!state||candidate.state===state)&&(!linkState||(linkState==='active'?link?.state==='ativo':link?.state!=='ativo'))&&
   (!normalize(search)||normalize([candidate.name,candidate.handle,link?.ref].join(' ')).includes(normalize(search).replace(/^@/,'')));
 }
 function detail(c,link,order,closings){
  const address=link?.state==='ativo'&&link.url?`<a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">Abrir link</a>`:'Sem link ativo';
  const fields=[['Estado',states[c.state]||c.state],['Criado em',stamp(c.created_at)],['Atualizado em',stamp(c.updated_at)],['Referência',link?.ref||'Indisponível'],['Pedidos atribuídos',order?number(order.pedidos):'Indisponível'],['Base elegível',order?money(order.base_elegivel):'Indisponível'],['Comissão calculada',order?money(order.comissao):'Indisponível'],['Primeira venda no período',order?.primeiro_dia||'Indisponível'],['Última venda no período',order?.ultimo_dia||'Indisponível']];
  return `<header><div><span class="own-affiliate-eyebrow">Ficha do parceiro</span><h3>${esc(c.name)}</h3><p class="mini">${esc(c.handle)}</p></div><button class="btn sec" type="button" data-own-detail-close>Fechar</button></header><dl>${fields.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}<div><dt>Link da loja</dt><dd>${address}</dd></div></dl>
   <p class="own-affiliate-note">Comissão calculada não confirma pagamento. O fechamento abaixo é o registro da fonte para esta referência.</p>
   ${closings===null?'<p>Fechamento indisponível nesta consulta.</p>':closings.length?`<div class="own-affiliate-table"><table><thead><tr><th>Competência</th><th>Pedidos</th><th>Base elegível</th><th>Comissão</th><th>Prazo</th></tr></thead><tbody>${closings.map(x=>`<tr><td>${esc(x.competencia)}</td><td>${number(x.pedidos)}</td><td>${money(x.base_elegivel)}</td><td>${money(x.comissao)}</td><td>${esc(x.prazo||'Indisponível')}</td></tr>`).join('')}</tbody></table></div>`:'<p>Nenhum fechamento retornado para este parceiro no período.</p>'}`;
 }
 function render(host,data){
  if(!host)return;
  if(data?.schema!=='shrigma-own-affiliates-read-v1'||!['fish','aristo'].includes(data.brand)||!['programs','candidates','links'].every(k=>Array.isArray(data[k]))){host.innerHTML='<section class="painel"><h2>Afiliados próprios</h2><p role="status">Consulta indisponível. Não foi possível confirmar o cadastro dos parceiros.</p></section>';return;}
  const p=data.programs[0],links=currentLinks(data),orders=Array.isArray(data.partner_orders)?new Map(data.partner_orders.map(o=>[o.ref,o])):null;
  const pending=Array.isArray(data.pendingEdits)?data.pendingEdits:[],pendingIds=new Set(pending.map(e=>e.candidate_id)),editable=data.editAvailable===true;
  const name=data.brand==='fish'?'Fishermans':'O Aristocrata';
  const rate=p?.rate==null?'Indisponível':(Number(p.rate)*100).toLocaleString('pt-BR',{maximumFractionDigits:2})+'%';
  const counts=[['novo','Novos',data.candidates.filter(c=>c.state==='novo').length],['em_analise','Em análise',data.candidates.filter(c=>c.state==='em_analise').length],['aprovado_piloto','Aprovados',data.candidates.filter(c=>c.state==='aprovado_piloto').length],['no_link','Sem link ativo',data.candidates.filter(c=>links.get(c.id)?.state!=='ativo').length]];
  const rows=data.candidates.map(c=>{
   const link=links.get(c.id),order=link&&orders?.get(link.ref);
   const address=link?.state==='ativo'&&link.url?`<a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">Abrir link</a>`:link?esc(states[link.state]||link.state):'Sem link nesta consulta';
   const edit=editable&&c.state==='novo'&&!pendingIds.has(c.id)&&Number.isSafeInteger(Number(c.version))&&Number(c.version)>0?`<button class="btn sec" type="button" data-own-affiliate-review="${esc(c.id)}" data-version="${esc(c.version)}">Colocar em análise</button>`:pendingIds.has(c.id)?'Tentativa a conferir':'—';
   return `<tr data-own-affiliate-row="${esc(c.id)}"><td><strong>${esc(c.name)}</strong><span class="mini">${esc(c.handle)}</span></td><td><span class="own-affiliate-state" data-state="${esc(c.state)}">${esc(states[c.state]||c.state)}</span></td><td>${address}${link?`<span class="mini">${esc(link.ref)}</span>`:''}</td><td class="num">${order?number(order.pedidos):'—'}</td><td class="num">${order?money(order.comissao):'Indisponível'}</td><td><button class="btn sec" type="button" data-own-affiliate-detail="${esc(c.id)}" aria-expanded="false">Ver ficha</button></td>${editable||pending.length?`<td>${edit}</td>`:''}</tr>`;
  }).join('');
  host.innerHTML=`<section class="painel own-affiliate-board"><div class="painel-cab"><div><span class="own-affiliate-eyebrow">Programa da loja · ${name}</span><h2>Afiliados próprios</h2><p>Da análise do cadastro à conferência das vendas.</p></div><button class="btn sec" type="button" data-own-affiliates-refresh>Atualizar</button></div>
   <div class="own-affiliate-pipeline" aria-label="Fila de cadastros">${counts.map(([key,label,count])=>`<button type="button" data-own-pipeline="${key}" aria-pressed="false"><strong>${number(count)}</strong><span>${label}</span></button>`).join('')}</div>
   <p class="own-affiliate-note">Taxa do programa <strong>${rate}</strong> · Fonte: programa original de parceiros. Consulta em ${esc(stamp(data.gerado_em))}. Vendas de ${esc(data.janela.ini)} a ${esc(data.janela.fim)}.</p>
   ${orders?'':'<p role="status">Vendas e comissões indisponíveis nesta consulta. O cadastro permanece disponível.</p>'}
   <p data-own-affiliate-message role="status"></p>
   ${pending.length?`<section class="own-affiliate-pending"><h3>Tentativas a conferir</h3><p>Consulte a tentativa existente antes de fazer outra alteração. Esta fila permanece visível com qualquer filtro.</p>${pending.map(e=>`<button class="btn sec" type="button" data-own-affiliate-operation="${esc(e.request_id)}" data-candidate="${esc(e.candidate_id)}">Conferir tentativa</button>`).join('')}</section>`:''}
   <div class="own-affiliate-toolbar"><label>Buscar parceiro<input type="search" data-own-search placeholder="Nome, @perfil ou referência" autocomplete="off"></label><label>Estado<select data-own-state><option value="">Todos os estados</option>${['novo','em_analise','aprovado_piloto','pausado','recusado'].map(s=>`<option value="${s}">${states[s]}</option>`).join('')}</select></label><label>Link<select data-own-link><option value="">Todos</option><option value="active">Com link ativo</option><option value="missing">Sem link ativo</option></select></label><button class="btn sec" type="button" data-own-clear>Limpar</button></div>
   <p class="own-affiliate-note" data-own-count role="status" aria-live="polite">${number(data.candidates.length)} de ${number(data.candidates.length)} cadastros</p>
   <div class="own-affiliate-table"><table><thead><tr><th>Parceiro</th><th>Estado</th><th>Link</th><th>Pedidos atribuídos</th><th>Comissão calculada</th><th>Detalhes</th>${editable||pending.length?'<th>Ação</th>':''}</tr></thead><tbody>${rows||`<tr><td colspan="${editable||pending.length?7:6}">Nenhum cadastro retornado pelo programa desta marca.</td></tr>`}</tbody></table></div>
   <p data-own-empty hidden>Nenhum parceiro corresponde aos filtros. Limpe os filtros para rever a fila.</p><section class="own-affiliate-detail" data-own-detail hidden aria-label="Ficha do parceiro"></section>
   <p class="own-affiliate-note">Comissão calculada não confirma pagamento. Cupom individual e cadastro de pagamento ainda não são fornecidos por esta leitura.${editable?'':' Alterações não estão liberadas.'}</p></section>`;
  if(typeof host.querySelector!=='function')return;
  const search=host.querySelector('[data-own-search]'),state=host.querySelector('[data-own-state]'),linkState=host.querySelector('[data-own-link]');
  const apply=()=>{
   const filters={search:search.value,state:state.value,linkState:linkState.value};let count=0;
   for(const row of host.querySelectorAll('[data-own-affiliate-row]')){const c=data.candidates.find(x=>x.id===row.dataset.ownAffiliateRow);row.hidden=!matches(c,links.get(c.id),filters);if(!row.hidden)count++;}
   host.querySelector('[data-own-count]').textContent=number(count)+' de '+number(data.candidates.length)+' cadastros';host.querySelector('[data-own-empty]').hidden=count!==0||data.candidates.length===0;
   for(const card of host.querySelectorAll('[data-own-pipeline]'))card.setAttribute('aria-pressed',String(card.dataset.ownPipeline==='no_link'?filters.linkState==='missing':card.dataset.ownPipeline===filters.state));
  };
  search.addEventListener('input',apply);state.addEventListener('change',apply);linkState.addEventListener('change',apply);
  host.querySelector('[data-own-clear]').addEventListener('click',()=>{search.value='';state.value='';linkState.value='';apply();search.focus();});
  for(const card of host.querySelectorAll('[data-own-pipeline]'))card.addEventListener('click',()=>{const key=card.dataset.ownPipeline;state.value=key==='no_link'?'':key;linkState.value=key==='no_link'?'missing':'';apply();});
  const detailHost=host.querySelector('[data-own-detail]');
  for(const button of host.querySelectorAll('[data-own-affiliate-detail]'))button.addEventListener('click',()=>{
   const c=data.candidates.find(x=>x.id===button.dataset.ownAffiliateDetail);if(!c)return;const link=links.get(c.id),order=link&&orders?.get(link.ref);
   const closings=Array.isArray(data.fechamento)?data.fechamento.filter(x=>link&&x.ref===link.ref):null;
   detailHost.innerHTML=detail(c,link,order,closings);detailHost.hidden=false;
   for(const other of host.querySelectorAll('[data-own-affiliate-detail]'))other.setAttribute('aria-expanded',String(other===button));
   detailHost.querySelector('[data-own-detail-close]').addEventListener('click',()=>{detailHost.hidden=true;button.setAttribute('aria-expanded','false');button.focus();});detailHost.scrollIntoView?.({block:'nearest',behavior:'auto'});
  });
 }
 root.ShrigmaOwnAffiliates={render,matches,currentLinks};
 if(typeof module==='object'&&module.exports)module.exports=root.ShrigmaOwnAffiliates;
})(typeof window!=='undefined'?window:globalThis);
