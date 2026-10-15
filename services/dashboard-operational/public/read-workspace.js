(function (root) {
  'use strict';
  const number = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const brl = value => number(value) === null ? '—' : number(value).toLocaleString('pt-BR', {style:'currency',currency:'BRL'});
  const integer = value => number(value) === null ? '—' : number(value).toLocaleString('pt-BR', {maximumFractionDigits:0});
  const percent = value => number(value) === null ? '—' : number(value).toLocaleString('pt-BR', {maximumFractionDigits:2}) + '%';
  const canonical = value => ({fishermans:'fish',aristocrata:'aristo'}[value] || value);
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('sv-SE', {timeZone:'America/Sao_Paulo'}).format(new Date(value)) : '';
  const when = value => /^\d{4}-\d{2}-\d{2}$/.test(value||'') ? new Date(value+'T12:00:00Z').toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'}) : value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('pt-BR', {timeZone:'America/Sao_Paulo'}) : 'Não informado';
  const sum = (rows, key) => !Array.isArray(rows) || rows.some(r => number(r[key]) === null) ? null : rows.reduce((n,r) => n + number(r[key]), 0);
  const chip = (text, detail='', style='secondary') => '<span class="badge bg-'+style+'-lt"'+(detail?' title="'+esc(detail)+'" tabindex="0"':'')+'>'+esc(text)+'</span>';
  const table = (headers, rows, empty='Nenhum registro retornado neste período.') => rows === null ? '<div class="card-body text-secondary">Fonte indisponível nesta consulta.</div>' : !rows.length ? '<div class="card-body text-secondary">'+esc(empty)+'</div>' : '<div class="table-responsive" tabindex="0" role="region" aria-label="Tabela de resultados"><table class="table table-vcenter card-table"><thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';
  const card = (title, body, aside='') => '<div class="card h-100"><div class="card-header"><h2 class="card-title">'+esc(title)+'</h2>'+aside+'</div>'+body+'</div>';
  const cards = values => '<div class="row row-cards mb-4">'+values.map(([label,value,format,detail])=>'<div class="col-12 col-sm-6 col-lg-3"><div class="card"><div class="card-body"><div class="subheader mb-2">'+esc(label)+(detail?' '+chip('ⓘ',detail):'')+'</div><div class="h1 mb-0 metric-value">'+format(value)+'</div></div></div></div>').join('')+'</div>';
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && date(value+'T12:00:00Z') === value;
  const addDays = (value, days) => new Date(Date.parse(value+'T12:00:00Z') + days*86400000).toISOString().slice(0,10);
  function availablePostWindow(rows,brand,ini,fim){
    if(!validDate(ini)||!validDate(fim)||ini>fim)return null;
    const days=(rows||[]).filter(r=>canonical(r.marca)===brand&&!r.impulsionado).map(r=>date(r.publicado_em)).filter(validDate);
    if(!days.length||days.some(d=>d>=ini&&d<=fim))return null;
    const end=days.sort().at(-1),span=Math.round((Date.parse(fim)-Date.parse(ini))/86400000);
    return {ini:addDays(end,-span),fim:end};
  }
  function availableOrganicWindow(data,brand,ini,fim,view='overview'){
    const rows=view==='posts'?data.cx_post||[]:view==='stories'?data.cx_story||[]:view==='sales'?data.cx_organico_receita||[]:[...(data.cx_post||[]),...(data.cx_story||[]),...(data.cx_organico_receita||[])];
    return availablePostWindow(rows.map(r=>({...r,publicado_em:r.publicado_em||r.dia})),brand,ini,fim);
  }
  function mount(config) {
    const el = id => document.getElementById(id), q = new URLSearchParams(location.search);
    const state = {brand:q.get('brand') || 'fish', view:Object.hasOwn(config.views,q.get('view'))?q.get('view'):'overview', data:null, ticket:0, charts:[], ini:'', fim:''};
    const scope = session => session?.authenticated === true && typeof session.user?.id === 'string' && session.user.permissions?.[config.area]?.read === true && (!session.user.productFronts || session.user.productFronts.includes(config.front));
    const brands = session => (session.user.viewBrands || session.user.brands || []).filter(b=>['fish','aristo'].includes(b));
    async function session() { const s=await root.ShrigmaReadSession(); if(!scope(s)) throw Object.assign(Error(),{code:'ACCESS_DENIED'}); return s; }
    function persist() { history.replaceState(null,'',location.pathname+'?'+new URLSearchParams({brand:state.brand,view:state.view,ini:state.ini,fim:state.fim})); }
    function chooseBrand() {
      state.brand=el('brand').value; document.documentElement.dataset.brand=state.brand;
      el('brand-logo').src='vendor/wm-'+(state.brand==='fish'?'fishermans':'aristocrata')+'.png';el('brand-logo').alt=state.brand==='fish'?'Fishermans':'O Aristocrata';
      for(const b of document.querySelectorAll('#seg-marca button')) b.classList.toggle('ativo',b.dataset.marca===state.brand);
    }
    function clear() { for(const chart of state.charts)chart.destroy();state.charts=[];for(const key of Object.keys(config.views))el(key+'-content').replaceChildren();el('detail').classList.add('d-none'); }
    function view(key) {
      if(!Object.hasOwn(config.views,key))return;state.view=key;
      for(const name of Object.keys(config.views))el(name).classList.toggle('d-none',name!==key);
      for(const button of document.querySelectorAll('[data-view]')){button.classList.toggle('active',button.dataset.view===key);button.setAttribute('aria-selected',String(button.dataset.view===key));}
      el('workspace-title').textContent=el('page-title').textContent=config.views[key];persist();if(state.data)render();
    }
    function render() { clear();config.render({state,el,api:W,detail,chart}); }
    function detail(title,body) { el('detail-title').textContent=title;el('detail-body').innerHTML=body;el('detail').classList.remove('d-none'); }
    function chart(id, labels, values, label, format=integer) {
      const canvas=el(id);if(!canvas||!values.some(v=>number(v)!==null))return;
      const color=getComputedStyle(document.documentElement).getPropertyValue('--brand-color').trim();
      state.charts.push(new Chart(canvas,{type:'line',data:{labels,datasets:[{label,data:values,borderColor:color,backgroundColor:color+'14',fill:true,pointRadius:0,borderWidth:2,tension:.2,spanGaps:false}]},options:{responsive:true,maintainAspectRatio:false,animation:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>format(c.raw)}}},scales:{x:{ticks:{maxTicksLimit:8,maxRotation:0},grid:{display:false}},y:{beginAtZero:true,ticks:{callback:v=>format(v)},grid:{color:'#e9edf2'}}}}}));
    }
    async function load() {
      const ticket=++state.ticket;state.controller?.abort();state.controller=new AbortController();state.data=null;clear();el('error').classList.add('d-none');el('loading').classList.remove('d-none');
      state.ini=el('d-ini').value;state.fim=el('d-fim').value;const brand=state.brand,ini=state.ini,fim=state.fim,controller=state.controller;
      try {
        if(!validDate(state.ini)||!validDate(state.fim)||state.ini>state.fim||Date.parse(state.fim)-Date.parse(state.ini)>369*86400000)throw Object.assign(Error(),{code:'DATE_RANGE_INVALID'});
        const before=await session();if(ticket!==state.ticket||controller.signal.aborted)return;if(!brands(before).includes(brand))throw Object.assign(Error(),{code:'ACCESS_DENIED'});
        const opts=config.front==='influs'?{method:'POST',body:JSON.stringify({acao:'listar',marca:brand,ini,fim,pilot:false}),headers:{'Content-Type':'application/json'}}:{method:'GET',headers:{'X-Shrigma-View-Brand':brand}};
        const response=await fetch(config.front==='influs'?'/api/influ':'/api/cache?painel=organico',{...opts,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
        const data=await response.json();if(!response.ok)throw Object.assign(Error(),{status:response.status,code:/^[A-Z_0-9]{1,80}$/.test(data.error||'')?data.error:'SOURCE_REFUSED'});
        if(ticket!==state.ticket||controller.signal.aborted)return;
        const after=await session();if(ticket!==state.ticket||brand!==state.brand||ini!==state.ini||fim!==state.fim||before.user.id!==after.user.id||!brands(after).includes(brand))return;
        if(data.brand&&canonical(data.brand)!==brand||config.required.some(key=>!Array.isArray(data[key])))throw Object.assign(Error(),{code:'SOURCE_CONTRACT_INVALID'});
        state.data=data;let lastWindow=null;
        if(config.front==='organico')lastWindow=availableOrganicWindow(data,brand,ini,fim,state.view);
        if(lastWindow){state.ini=lastWindow.ini;state.fim=lastWindow.fim;el('d-ini').value=state.ini;el('d-fim').value=state.fim;}
        el('source-time').textContent='Preparado '+when(data.gerado_em||data._cache_gerado_em);
        const latest=rows=>{const dates=(rows||[]).flatMap(r=>[r.ultima_coleta,r.coletado_em]).filter(v=>v&&Number.isFinite(Date.parse(v)));return dates.length?dates.sort((a,b)=>Date.parse(b)-Date.parse(a))[0]:null;};
        const lastPost=(data.cx_post||[]).filter(r=>canonical(r.marca)===brand&&r.publicado_em).map(r=>r.publicado_em).sort((a,b)=>Date.parse(b)-Date.parse(a))[0];
        el('freshness-note').textContent=config.front==='influs'?'Coleta dos pedidos '+when(data.coleta?.[brand]):'Última publicação '+when(lastPost)+' · Coleta dos posts '+when(latest(data.cx_post))+' · Stories até '+when(latest(data.cx_story));
        el('window').textContent=new Date(state.ini+'T12:00:00Z').toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'})+' — '+new Date(state.fim+'T12:00:00Z').toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});
        const labels={roi:'Resultados',custos:'Custos',termos:'Termos',saude:'Saúde das fontes',clientes:'Clientes agregados',conciliacao:'Conciliação',cx_post:'Posts',cx_story:'Stories',cx_post_midia:'Prévias',coleta:'Frescor'};
        const issues=[...new Set((data.read_issues||[]).map(r=>labels[r.section]||'Atribuição e cobertura'))];el('fallback').textContent=(lastWindow?'Sem registros no período solicitado para esta visão. Exibindo a última janela disponível: '+state.ini+' a '+state.fim+'. ':'')+(issues.length?'Leitura parcial. Dados indisponíveis: '+issues.join(', ')+'.':'');el('fallback').classList.toggle('d-none',!issues.length&&!lastWindow);
        el('read-at').textContent='Consulta '+when(new Date().toISOString());persist();render();
      } catch(error) {
        if(ticket!==state.ticket)return;state.data=null;clear();el('source-time').textContent='Dados indisponíveis';el('freshness-note').textContent='';
        el('error').textContent=error.code==='DATE_RANGE_INVALID'?'Selecione um período válido, de até 370 dias.':'Não foi possível consultar esta marca.'+(error.status?' HTTP '+error.status+'.':'')+(error.code?' Código: '+error.code+'.':'');el('error').classList.remove('d-none');
      } finally { if(ticket===state.ticket)el('loading').classList.add('d-none'); }
    }
    for(const button of document.querySelectorAll('[data-view]'))button.addEventListener('click',()=>view(button.dataset.view));
    el('detail-close').addEventListener('click',()=>el('detail').classList.add('d-none'));document.addEventListener('keydown',e=>{if(e.key==='Escape')el('detail').classList.add('d-none');});
    el('reload').addEventListener('click',load);el('brand').addEventListener('change',()=>{chooseBrand();load();});
    el('days').addEventListener('change',()=>{const last=date(new Date());el('d-fim').value=last;el('d-ini').value=addDays(last,1-Number(el('days').value));load();});
    for(const id of ['d-ini','d-fim'])el(id).addEventListener('change',load);
    for(const id of config.filters || [])el(id)?.addEventListener('input',()=>state.data&&render());
    (async()=>{try{const s=await session(),allowed=brands(s);if(!allowed.length)throw Object.assign(Error(),{code:'BRAND_DATA_UNAVAILABLE'});for(const option of [...el('brand').options])if(!allowed.includes(option.value))option.remove();el('brand').disabled=allowed.length===1;el('brand').value=allowed.includes(state.brand)?state.brand:allowed[0];chooseBrand();const last=date(new Date());el('d-fim').value=validDate(q.get('fim'))?q.get('fim'):last;el('d-ini').value=validDate(q.get('ini'))?q.get('ini'):addDays(last,-29);state.ini=el('d-ini').value;state.fim=el('d-fim').value;view(state.view);await load();}catch(error){el('error').textContent='Esta frente não está disponível para o seu acesso.';el('error').classList.remove('d-none');}})();
    return {state,load,render,view};
  }
  const W={number,esc,brl,integer,percent,canonical,date,when,sum,chip,table,card,cards,validDate,addDays,availablePostWindow,availableOrganicWindow,mount};
  if(typeof module!=='undefined')module.exports=W;else root.ShrigmaReadWorkspace=W;
})(typeof window!=='undefined'?window:globalThis);
