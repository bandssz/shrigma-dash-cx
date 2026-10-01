/* Read-only campaign activity, reusing the report snapshot and refresh lifecycle. */
const GCM=(()=>{
 'use strict';
 const brands={fish:'Fishermans',aristo:'O Aristocrata',olivas:'Olivas'},states={running:'Em envio',scheduled:'Agendada',finished:'Envio concluído',paused:'Pausada',cancelled:'Cancelada',draft:'Rascunho'};
 const filters={all:'Todas',running:'Em envio',scheduled:'Agendadas',finished:'Enviadas',other:'Outras situações'};
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const count=v=>(typeof v==='number'||typeof v==='string'&&/^\d+$/.test(v))&&Number.isSafeInteger(Number(v))&&Number(v)>=0?Number(v):null;
 const fmt=n=>n===null?'Não informado':n.toLocaleString('pt-BR');
 const stamp=v=>typeof v==='string'&&v.trim()&&Number.isFinite(Date.parse(v))?Date.parse(v):null;
 const time=v=>stamp(v)===null?'Horário não informado':new Date(v).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
 const day=v=>stamp(v)===null?'':new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(v));
 const norm=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 function model({api,marca,ini,fim,canal='todos',search='',filter='all'}){
  const available=api?.crm_attribution?.schema_version===2&&Array.isArray(api.crm_attribution.campaigns),counts={all:0,running:0,scheduled:0,finished:0,other:0},summary={running:0,scheduled:0,finished:0,paused:0};
  const source=available?api.crm_attribution.campaigns:[];
  const scoped=source.filter(m=>m&&Object.hasOwn(brands,m.marca)&&(marca==='todas'||m.marca===marca)&&m.canal==='email'&&canal!=='whatsapp').map(m=>{
   const sent=count(m.enviados),total=count(m.publico),category=['running','scheduled','finished'].includes(m.status)?m.status:'other';
   const date=day(m.enviado_em),historic=['finished','cancelled'].includes(m.status);
   return {...m,sent,total,category,date,historic,snapshotAt:api.crm_attribution.generated_at,progress:m.status==='running'&&sent!==null&&total!==null&&total>0&&sent<=total?100*sent/total:null};
  }).filter(m=>!m.historic||!m.date||m.date>=ini&&m.date<=fim);
  for(const m of scoped)if(Object.hasOwn(summary,m.status))summary[m.status]++;
  const rows=scoped.filter(m=>norm([m.nome,m.campanha_id,...Array.isArray(m.segmentos)?m.segmentos:[]].join(' ')).includes(norm(search)));
  for(const m of rows){counts.all++;counts[m.category]++;}
  const order={running:0,paused:1,scheduled:2,draft:3,finished:4,cancelled:5};
  rows.sort((a,b)=>(order[a.status]??6)-(order[b.status]??6)||(a.status==='scheduled'?(stamp(a.agendado_em)??Infinity)-(stamp(b.agendado_em)??Infinity):(stamp(b.enviado_em)??0)-(stamp(a.enviado_em)??0))||String(a.campanha_id).localeCompare(String(b.campanha_id)));
  return {available,counts,summary,rows:rows.filter(m=>filter==='all'||m.category===filter)};
 }
 let ctx=null,scope='',search='',filter='all',limit=30,busy=false;
 function row(m){
  const label=Object.hasOwn(states,m.status)?states[m.status]:'Situação não informada';
  const progress=m.progress===null?'':`<progress max="100" value="${m.progress}" aria-label="Progresso de ${esc(m.nome)}"></progress><span>${m.progress.toLocaleString('pt-BR',{maximumFractionDigits:1})}% do público contabilizado</span>`;
  return `<article class="gcm-row" data-status="${esc(m.status)}"><div class="gcm-identity"><span class="mini">${brands[m.marca]} · E-mail</span><h3>${esc(m.nome||'Campanha sem nome')}</h3><span class="ga-state is-${m.status==='running'?'running':m.status==='scheduled'?'scheduled':m.status==='finished'?'sent':'unknown'}">${label}</span><p class="mini">${m.status==='scheduled'?'Agendada para '+time(m.agendado_em):'Início do envio: '+time(m.enviado_em)}</p>${m.historic&&!m.date?'<p class="mini">Sem data de envio; não foi possível aplicar o período.</p>':''}</div><div class="gcm-numbers"><strong>${fmt(m.sent)} <small>enviados</small></strong>${progress}<span class="mini">Público contabilizado: ${fmt(m.total)}</span>${m.status==='running'&&m.progress===null?'<span class="mini">Progresso indisponível nesta leitura.</span>':''}${m.status==='finished'?'<span class="mini">Envio encerrado. Não significa entrega a todo o público.</span>':''}<span class="mini">Situação e envios: ${time(m.snapshotAt)}</span></div><details class="gcm-detail"><summary>Ver público e identificação</summary><p>${esc(Array.isArray(m.segmentos)&&m.segmentos.length?m.segmentos.join(' · '):'Público não informado')}</p><p>Código da campanha: ${esc(m.campanha_id??'não informado')}</p></details></article>`;
 }
 function draw(){
  const root=document.getElementById('campaign-monitor');if(!root||!ctx)return;
  const result=model({...ctx,search,filter}),list=root.querySelector('#gcm-list');
  const applicable=result.available&&ctx.canal!=='whatsapp';
  const summaries=[['running','Em envio','Campanhas em andamento'],['scheduled','Agendadas','Próximos envios preparados'],['finished','Finalizadas','Concluídas no período'],['paused','Pausadas','Envios interrompidos temporariamente']];
  root.querySelector('#gcm-summary').innerHTML=summaries.map(([key,label,help])=>`<article class="gcm-summary-card" data-summary-status="${key}"><span>${label}</span><strong>${applicable?result.summary[key].toLocaleString('pt-BR'):'—'}</strong><small>${applicable?help:result.available?'Somente para campanhas de e-mail':'Fonte indisponível nesta consulta'}</small></article>`).join('');
  list.innerHTML=!result.available?'<p class="nota">O histórico de campanhas não está disponível nesta consulta. Atualize os dados para tentar novamente.</p>':ctx.canal==='whatsapp'?'<p class="nota">Este acompanhamento reúne campanhas de e-mail. Selecione E-mail ou Todos os canais.</p>':result.rows.length?result.rows.slice(0,limit).map(row).join(''):'<p class="nota">Nenhuma campanha nesta situação e busca. Confira os filtros ou amplie o período para consultar envios antigos.</p>';
  for(const button of root.querySelectorAll('[data-gcm-filter]')){const key=button.dataset.gcmFilter;button.setAttribute('aria-pressed',String(key===filter));button.textContent=filters[key]+' ('+result.counts[key]+')';}
  root.querySelector('#gcm-count').textContent=`${Math.min(result.rows.length,limit)} de ${result.rows.length} campanhas`;
  root.querySelector('#gcm-more').hidden=result.rows.length<=limit;
 }
 function render(input){
  ctx=input;const root=document.getElementById('campaign-monitor');if(!root)return;
  const nextScope=input.marca+'|'+input.canal;
  if(scope!==nextScope){scope=nextScope;search='';filter='all';limit=30;}
  if(!root.querySelector('#gcm-list')){
   root.innerHTML=`<div class="painel-cab"><h2>Acompanhar e-mails</h2><button type="button" class="btn sec" id="gcm-refresh">Atualizar dados</button></div><p class="mini">Em envio, agendadas e pausadas aparecem independentemente do período. O histórico de envios concluídos e cancelados segue o período selecionado. A fonte reúne os últimos 120 dias. Rascunhos ficam em Preparar campanha.</p><p class="mini" id="gcm-freshness" role="status"></p><section class="gcm-summary" id="gcm-summary" aria-label="Resumo das campanhas neste recorte"></section><div class="gcm-filters" role="group" aria-label="Situação da campanha">${Object.entries(filters).map(([k,v])=>`<button type="button" data-gcm-filter="${k}" aria-pressed="${k==='all'}">${v}</button>`).join('')}</div><label class="gcm-search" for="gcm-search">Buscar campanha, público ou código<input id="gcm-search" type="search" placeholder="Nome da campanha ou público"></label><p class="mini" id="gcm-count" role="status"></p><div id="gcm-list"></div><button type="button" class="btn sec" id="gcm-more" hidden>Mostrar mais</button><details class="gcm-method"><summary>Como o progresso é atualizado</summary><p>Os números mudam quando chega uma nova coleta. A página consulta os dados a cada minuto enquanto está visível; a coleta pode ser anterior. Não é um contador em tempo real. O progresso divide enviados pelo público contabilizado. Esse público pode mudar quando o envio é retomado, e bloqueios ou descadastros podem reduzir o total enviado. Enviado não significa entregue.</p><p>Todos os horários são de Brasília. Campanhas sem data também podem aparecer fora do período.</p></details>`;
   root.querySelector('#gcm-search').addEventListener('input',e=>{search=e.target.value;limit=30;draw();});
   for(const button of root.querySelectorAll('[data-gcm-filter]'))button.addEventListener('click',()=>{filter=button.dataset.gcmFilter;limit=30;draw();});
   root.querySelector('#gcm-more').addEventListener('click',()=>{limit+=30;draw();});
   root.querySelector('#gcm-refresh').addEventListener('click',async()=>{if(busy||typeof ctx.onRefresh!=='function')return;busy=true;render(ctx);try{await ctx.onRefresh();}finally{busy=false;render(ctx);}});
  }
  const inputEl=root.querySelector('#gcm-search');if(inputEl.value!==search)inputEl.value=search;
  const refresh=root.querySelector('#gcm-refresh');refresh.disabled=busy||typeof ctx.onRefresh!=='function';refresh.textContent=busy?'Atualizando…':'Atualizar dados';
  root.querySelector('#gcm-freshness').textContent=(input.consulta?.falhou?'A última atualização falhou. Exibindo a consulta anterior. ':'')+'Dados preparados em '+time(input.api?.crm_attribution?.generated_at)+'. Os números correspondem a essa consulta, que pode vir do cache.';
  // Keep search/filter controls and focus stable across the existing periodic refresh.
  const opened=new Set([...root.querySelectorAll('.gcm-detail')].filter(d=>d.open||d.hasAttribute('open')).map(d=>d.parentElement.querySelector('.gcm-detail p:last-child')?.textContent+'|'+d.parentElement.querySelector('.mini')?.textContent));
  draw();for(const d of root.querySelectorAll('.gcm-detail'))if(opened.has(d.querySelector('p:last-child')?.textContent+'|'+d.parentElement.querySelector('.mini')?.textContent))d.open=true;
 }
 return {model,render};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GCM;
