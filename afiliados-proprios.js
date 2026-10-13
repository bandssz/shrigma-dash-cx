/* Existing store partner programme; one separately admitted review action. */
(function(root){'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const number=v=>v===null||v===undefined?'—':Number(v).toLocaleString('pt-BR');
 const money=v=>v===null||v===undefined?'Indisponível':Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
 const states={novo:'Novo',em_analise:'Em análise',aprovado_piloto:'Aprovado',pausado:'Pausado',recusado:'Recusado',ativo:'Ativo',revogado:'Revogado'};
 function render(host,data){
  if(!host)return;
  if(data?.schema!=='shrigma-own-affiliates-read-v1'||!['fish','aristo'].includes(data.brand)||!['programs','candidates','links'].every(k=>Array.isArray(data[k]))){host.innerHTML='<section class="painel"><h2>Afiliados próprios</h2><p role="status">Consulta indisponível. Não foi possível confirmar o cadastro dos parceiros.</p></section>';return;}
  const p=data.programs[0],links=new Map(),orders=Array.isArray(data.partner_orders)?new Map(data.partner_orders.map(o=>[o.ref,o])):null;
  const pending=Array.isArray(data.pendingEdits)?data.pendingEdits:[],pendingIds=new Set(pending.map(e=>e.candidate_id)),editable=data.editAvailable===true;
  for(const link of data.links){const prior=links.get(link.candidate_id);if(!prior||prior.state==='revogado'&&(link.state!=='revogado'||Date.parse(link.updated_at)>Date.parse(prior.updated_at)))links.set(link.candidate_id,link);}
  const name=data.brand==='fish'?'Fishermans':'O Aristocrata';
  const rate=p?.rate==null?'Indisponível':(Number(p.rate)*100).toLocaleString('pt-BR',{maximumFractionDigits:2})+'%';
  const date=data.gerado_em?new Date(data.gerado_em).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'horário não informado';
  const rows=data.candidates.map(c=>{
   const link=links.get(c.id),order=link&&orders?.get(link.ref);
   const address=link?.state==='ativo'&&link.url?`<a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">Abrir link</a>`:link?esc(states[link.state]||link.state):'Sem link nesta consulta';
   const edit=editable&&c.state==='novo'&&!pendingIds.has(c.id)&&Number.isSafeInteger(Number(c.version))&&Number(c.version)>0?`<button class="btn sec" type="button" data-own-affiliate-review="${esc(c.id)}" data-version="${esc(c.version)}">Colocar em análise</button>`:pendingIds.has(c.id)?'Tentativa a conferir':'—';
   return `<tr><td><strong>${esc(c.name)}</strong><span class="mini">${esc(c.handle)}</span></td><td>${esc(states[c.state]||c.state)}</td><td>${address}${link?`<span class="mini">${esc(link.ref)}</span>`:''}</td><td class="num">${order?number(order.pedidos):'—'}</td><td class="num">${order?money(order.base_elegivel):'Indisponível'}</td><td class="num">${order?money(order.comissao):'Indisponível'}</td>${editable||pending.length?`<td>${edit}</td>`:''}</tr>`;
  }).join('');
  host.innerHTML=`<section class="painel"><div class="painel-cab"><div><h2>Afiliados próprios · ${name}</h2><p>Parceiros cadastrados no programa da loja.</p></div><button class="btn sec" type="button" data-own-affiliates-refresh>Atualizar</button></div>
   <div class="cp-metrics"><span><strong>${number(data.candidates.length)}</strong> cadastros</span><span><strong>${number(data.candidates.filter(c=>['novo','em_analise'].includes(c.state)).length)}</strong> para analisar</span><span><strong>${number(data.candidates.filter(c=>c.state==='aprovado_piloto').length)}</strong> aprovados</span><span><strong>${number(data.links.filter(l=>l.state==='ativo').length)}</strong> links ativos</span><span>Taxa do programa <strong>${rate}</strong></span></div>
   <p class="mini">Fonte: programa original de parceiros. Consulta em ${esc(date)}. Vendas de ${esc(data.janela.ini)} a ${esc(data.janela.fim)}. Comissão calculada não confirma pagamento.</p>
   ${orders?'':'<p role="status">Vendas e comissões indisponíveis nesta consulta. O cadastro permanece disponível.</p>'}
   <p data-own-affiliate-message role="status"></p>
   ${pending.length?`<section><h3>Tentativas a conferir</h3><p>Consulte a tentativa existente antes de fazer outra alteração.</p>${pending.map(e=>`<button class="btn sec" type="button" data-own-affiliate-operation="${esc(e.request_id)}" data-candidate="${esc(e.candidate_id)}">Conferir tentativa</button>`).join('')}</section>`:''}
   <div class="cp-table"><table><thead><tr><th>Parceiro</th><th>Estado</th><th>Link</th><th>Pedidos atribuídos</th><th>Base elegível</th><th>Comissão calculada</th>${editable||pending.length?'<th>Ação</th>':''}</tr></thead><tbody>${rows||`<tr><td colspan="${editable||pending.length?7:6}">Nenhum cadastro retornado pelo programa desta marca.</td></tr>`}</tbody></table></div>
   <p class="mini">Cupom individual e cadastro de pagamento ainda não são fornecidos por esta leitura.${editable?'':' Alterações não estão liberadas.'}</p></section>`;
 }
 root.ShrigmaOwnAffiliates={render};
 if(typeof module==='object'&&module.exports)module.exports=root.ShrigmaOwnAffiliates;
})(typeof window!=='undefined'?window:globalThis);
