(function (root) {
  'use strict';
  const number = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const brl = value => number(value) === null ? '—' : number(value).toLocaleString('pt-BR', {style:'currency',currency:'BRL'});
  const integer = value => number(value) === null ? '—' : number(value).toLocaleString('pt-BR', {maximumFractionDigits:0});
  const percent = value => number(value) === null ? '—' : number(value).toLocaleString('pt-BR', {maximumFractionDigits:2}) + '%';
  const canonical = value => ({fishermans:'fish',aristocrata:'aristo'}[value] || value);
  const brasiliaDate = new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'});
  const date = value => typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value?value:'':value&&Number.isFinite(Date.parse(value))?brasiliaDate.format(new Date(value)):'';
  const when = value => /^\d{4}-\d{2}-\d{2}$/.test(value||'') ? new Date(value+'T12:00:00Z').toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'}) : value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('pt-BR', {timeZone:'America/Sao_Paulo'}) : 'Não informado';
  const sum = (rows, key) => !Array.isArray(rows) || rows.some(r => number(r[key]) === null) ? null : rows.reduce((n,r) => n + number(r[key]), 0);
  const chip = (text, detail='', style='secondary') => '<span class="badge bg-'+style+'-lt"'+(detail?' title="'+esc(detail)+'" tabindex="0"':'')+'>'+esc(text)+'</span>';
  const table = (headers, rows, empty='Nenhum registro retornado neste período.') => rows === null ? '<div class="card-body text-secondary">Fonte indisponível nesta consulta.</div>' : !rows.length ? '<div class="card-body text-secondary">'+esc(empty)+'</div>' : '<div class="table-responsive" tabindex="0" role="region" aria-label="Tabela de resultados"><table class="table table-vcenter card-table"><thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';
  const card = (title, body, aside='') => '<div class="card h-100"><div class="card-header"><h2 class="card-title">'+esc(title)+'</h2>'+aside+'</div>'+body+'</div>';
  const cards = values => '<div class="row row-cards mb-4">'+values.map(([label,value,format,detail,comparison])=>'<div class="col-12 col-sm-6 col-lg-3"><div class="card"><div class="card-body"><div class="subheader mb-2">'+esc(label)+(detail?' '+chip('ⓘ',detail):'')+'</div><div class="h1 mb-0 metric-value">'+format(value)+'</div>'+(comparison?Period.comparison(Object.hasOwn(comparison,'current')?comparison.current:value,comparison.previous,comparison):'')+'</div></div></div>').join('')+'</div>';
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && date(value+'T12:00:00Z') === value;
  const addDays = (value, days) => new Date(Date.parse(value+'T12:00:00Z') + days*86400000).toISOString().slice(0,10);
  const Period=(()=>{
    const COOKIE='shrigma_period_v1',MAX_DAYS=366,DAY=86400000;
    const presets=Object.freeze([['today','Hoje'],['yesterday','Ontem'],['last7','Últimos 7 dias'],['last30','Últimos 30 dias'],['week','Esta semana'],['lastWeek','Semana passada'],['month','Este mês'],['lastMonth','Mês passado'],['custom','Personalizado']].map(Object.freeze));
    const valid=v=>validDate(v)&&v>='2000-01-01'&&v<='2100-12-31';
    const days=(ini,fim)=>valid(ini)&&valid(fim)&&ini<=fim?Math.round((Date.parse(fim+'T12:00:00Z')-Date.parse(ini+'T12:00:00Z'))/DAY)+1:0;
    const validRange=p=>!!p&&days(p.ini,p.fim)>0&&days(p.ini,p.fim)<=MAX_DAYS;
    const today=now=>date(new Date(now===undefined?Date.now():now).toISOString());
    const civil=(y,m,d)=>new Date(Date.UTC(y,m,d,12)).toISOString().slice(0,10);
    function previous(p){
      if(!validRange(p))throw Error('PERIOD_INVALID');
      let ini,fim;const [y,m,d]=p.fim.split('-').map(Number);
      if(p.preset==='month'){
        ini=civil(y,m-2,1);fim=civil(y,m-2,Math.min(d,new Date(Date.UTC(y,m-1,0)).getUTCDate()));
      }else if(p.preset==='lastMonth'){
        ini=civil(y,m-2,1);fim=civil(y,m-1,0);
      }else if(p.preset==='week'){
        ini=addDays(p.ini,-7);fim=addDays(p.fim,-7);
      }else{fim=addDays(p.ini,-1);ini=addDays(p.ini,-days(p.ini,p.fim));}
      return Object.freeze({ini,fim,days:days(ini,fim),clamped:days(ini,fim)!==days(p.ini,p.fim)});
    }
    function resolve(preset='last30',now,custom){
      if(!presets.some(([key])=>key===preset))throw Error('PERIOD_PRESET_INVALID');
      const end=today(now),[y,m]=end.split('-').map(Number),monday=addDays(end,-((new Date(end+'T12:00:00Z').getUTCDay()+6)%7));let ini,fim=end;
      if(preset==='custom'){ini=custom?.ini;fim=custom?.fim;}
      else if(preset==='today')ini=end;
      else if(preset==='yesterday')ini=fim=addDays(end,-1);
      else if(preset==='last7'||preset==='last30')ini=addDays(end,preset==='last7'?-6:-29);
      else if(preset==='week')ini=monday;
      else if(preset==='lastWeek'){ini=addDays(monday,-7);fim=addDays(monday,-1);}
      else if(preset==='month')ini=civil(y,m-1,1);
      else if(preset==='lastMonth'){ini=civil(y,m-2,1);fim=civil(y,m-1,0);}
      const p={preset,ini,fim};if(!validRange(p))throw Error('PERIOD_INVALID');return Object.freeze({...p,days:days(ini,fim),previous:previous(p)});
    }
    function parse(raw,now){
      if(typeof raw!=='string'||raw.length>512)return null;
      try{const x=JSON.parse(decodeURIComponent(raw));if(!x||Object.keys(x).sort().join(',')!=='fim,ini,preset,v'||x.v!==1||!validRange(x))return null;return resolve(x.preset,now,x);}catch{return null;}
    }
    function readCookie(cookie,now){
      if(typeof cookie!=='string'||cookie.length>16384)return null;const values=cookie.split(';').map(v=>v.trim()).filter(v=>v.startsWith(COOKIE+'='));return values.length===1?parse(values[0].slice(COOKIE.length+1),now):null;
    }
    function initial({search='',cookie='',now,defaultPreset='last30'}={}){
      const q=new URLSearchParams(search),preset=q.get('preset');
      if(preset&&preset!=='custom'&&presets.some(([key])=>key===preset))return resolve(preset,now);
      if(q.has('ini')&&q.has('fim')&&validRange({ini:q.get('ini'),fim:q.get('fim')}))return resolve('custom',now,{ini:q.get('ini'),fim:q.get('fim')});
      if(q.has('days')&&[7,30,90].includes(Number(q.get('days')))){const n=Number(q.get('days'));return n===7||n===30?resolve('last'+n,now):resolve('custom',now,{ini:addDays(today(now),1-n),fim:today(now)});}
      return readCookie(cookie,now)||resolve(defaultPreset,now);
    }
    function save(document,location,p){
      // This is a public date preference, never a brand, grant or auth token.
      if(!document||location?.protocol!=='https:'||!['crm.shrigma.com.br','influs.shrigma.com.br','organico.shrigma.com.br','gestao.shrigma.com.br','gerencial.shrigma.com.br'].includes(location.hostname)||!validRange(p))return false;
      const value=encodeURIComponent(JSON.stringify({v:1,preset:p.preset,ini:p.ini,fim:p.fim}));
      if(!parse(value))return false;try{document.cookie=COOKIE+'='+value+'; Path=/; Domain=shrigma.com.br; Max-Age=31536000; Secure; SameSite=Lax';return true;}catch{return false;}
    }
    const label=p=>p.ini.split('-').reverse().join('/')+' a '+p.fim.split('-').reverse().join('/');
    function change(current,prior,{ready=true,rate=false}={}){
      const a=number(current),b=number(prior);if(!ready)return {available:false,text:'Comparando…',percent:null};
      if(a===null||b===null)return {available:false,text:'Comparação indisponível',percent:null};
      const difference=a-b,arrow=difference>0?'↑':difference<0?'↓':'→',percent=b===0?null:100*difference/Math.abs(b),fmt=v=>Math.abs(v).toLocaleString('pt-BR',{maximumFractionDigits:1});
      const text=rate?arrow+' '+fmt(difference*100)+' p.p.'+(percent===null?' · anterior zero':' ('+fmt(percent)+'%)'):percent===null?arrow+' Anterior zero · sem base percentual':arrow+' '+fmt(percent)+'%';
      return {available:true,text,percent,difference,arrow};
    }
    function comparison(current,prior,options={}){const c=change(current,prior,options);return '<div class="source-line mt-2" data-period-comparison'+(options.period?' title="'+esc('Anterior: '+label(options.period)+(options.period.clamped?' · mês com duração diferente':''))+'"':'')+'>'+esc(c.text)+'</div>';}
    function bind({document,location,select,start,end,apply,note,onChange,now=Date.now,defaultPreset='last30'}={}){
      if(!select||!start||!end)return null;let selected=initial({search:location?.search||'',cookie:document?.cookie||'',now:now(),defaultPreset});
      function paint(){select.replaceChildren();for(const [key,name]of presets){const option=document.createElement('option');option.value=key;option.textContent=name;select.append(option);}select.value=selected.preset;start.value=selected.ini;end.value=selected.fim;start.min=end.min='2000-01-01';start.max=end.max='2100-12-31';if(note)note.textContent='Anterior: '+label(selected.previous)+(selected.previous.clamped?' · mês com duração diferente':'')+' · Brasília · semana de segunda a domingo';}
      function commit(p){selected=p;paint();save(document,location,selected);onChange?.(selected);}
      select.addEventListener('change',()=>{if(select.value==='custom'){start.focus?.();return;}commit(resolve(select.value,now()));});
      for(const field of [start,end])field.addEventListener('input',()=>{select.value='custom';field.setCustomValidity?.('');});
      const submit=event=>{event?.preventDefault();try{const p=resolve(select.value,now(),{ini:start.value,fim:end.value});start.setCustomValidity?.('');end.setCustomValidity?.('');commit(p);}catch{end.setCustomValidity?.('Escolha um período válido de até '+MAX_DAYS+' dias.');end.reportValidity?.();if(note)note.textContent='Período inválido: use datas válidas, em ordem, e até '+MAX_DAYS+' dias.';}};
      if(apply)apply.addEventListener(apply.tagName==='FORM'?'submit':'click',submit);
      paint();save(document,location,selected);
      function current(){const p=resolve(selected.preset,now(),selected);if(p.ini!==selected.ini||p.fim!==selected.fim){selected=p;paint();save(document,location,selected);}return selected;}
      return Object.freeze({get:({refresh=false}={})=>refresh?current():selected,sync(){const p=readCookie(document?.cookie||'',now());if(p){selected=p;paint();}return current();},apply:submit});
    }
    return Object.freeze({COOKIE,MAX_DAYS,presets,days,validRange,today,previous,resolve,parse,readCookie,initial,save,label,change,comparison,bind});
  })();
  function availablePostWindow(rows,brand,ini,fim){
    if(!validDate(ini)||!validDate(fim)||ini>fim)return null;
    const days=(rows||[]).filter(r=>canonical(r.marca)===brand&&!r.impulsionado).map(r=>date(r.publicado_em)).filter(validDate);
    if(!days.length||days.some(d=>d>=ini&&d<=fim))return null;
    const end=days.sort().at(-1),span=Math.round((Date.parse(fim)-Date.parse(ini))/86400000);
    return {ini:addDays(end,-span),fim:end};
  }
  function availableOrganicWindow(data,brand,ini,fim,view='overview'){
    const revenue=data.organico_attribution?.schema_version===1?data.organico_attribution.daily||[]:[];
    const rows=view==='posts'?data.cx_post||[]:view==='stories'?data.cx_story||[]:view==='sales'?revenue:[...(data.cx_post||[]),...(data.cx_story||[]),...revenue];
    return availablePostWindow(rows.map(r=>({...r,publicado_em:r.publicado_em||r.dia})),brand,ini,fim);
  }
  function mount(config) {
    const el=id=>document.getElementById(id),q=new URLSearchParams(location.search);
    const state={brand:q.get('brand')||'fish',view:Object.hasOwn(config.views,q.get('view'))?q.get('view'):'overview',data:null,previousData:null,comparisonStatus:'pending',ticket:0,charts:[],ini:'',fim:'',selectedPeriod:null,previousPeriod:null};
    const cache=new Map();
    const scope=session=>session?.authenticated===true&&typeof session.user?.id==='string'&&session.user.permissions?.[config.area]?.read===true&&(!session.user.productFronts||session.user.productFronts.includes(config.front));
    const brands=session=>(session.user.viewBrands||session.user.brands||[]).filter(b=>['fish','aristo'].includes(b));
    async function session(){let s;try{s=await root.ShrigmaReadSession();}catch{throw Object.assign(Error(),{code:'SESSION_UNCONFIRMED',status:401});}if(!scope(s))throw Object.assign(Error(),{code:'ACCESS_DENIED',status:403});return s;}
    const accessFailure=error=>[401,403].includes(error?.status)||['ACCESS_CHANGED','ACCESS_DENIED','SESSION_UNCONFIRMED'].includes(error?.code);
    function invalidate(){state.ticket++;state.controller?.abort();state.data=null;state.previousData=null;cache.clear();clear();el('source-time').textContent='Dados indisponíveis';el('freshness-note').textContent='';el('window').textContent='';el('fallback').classList.add('d-none');el('loading').classList.add('d-none');el('error').textContent='Seu acesso mudou ou a sessão terminou. Entre novamente no painel.';el('error').classList.remove('d-none');}
    let period;
    function persist(){const p=period?.get()||state.selectedPeriod;history.replaceState(null,'',location.pathname+'?'+new URLSearchParams({brand:state.brand,view:state.view,...(p?{ini:p.ini,fim:p.fim,preset:p.preset}:{})}));}
    function chooseBrand(){
      state.brand=el('brand').value;document.documentElement.dataset.brand=state.brand;
      el('brand-logo').src='vendor/wm-'+(state.brand==='fish'?'fishermans':'aristocrata')+'.png';el('brand-logo').alt=state.brand==='fish'?'Fishermans':'O Aristocrata';
      for(const b of document.querySelectorAll('#seg-marca button'))b.classList.toggle('ativo',b.dataset.marca===state.brand);
    }
    function clear(){for(const chart of state.charts)chart.destroy();state.charts=[];for(const key of Object.keys(config.views))el(key+'-content').replaceChildren();el('detail').classList.add('d-none');}
    function view(key){
      if(!Object.hasOwn(config.views,key))return;state.view=key;
      for(const name of Object.keys(config.views))el(name).classList.toggle('d-none',name!==key);
      for(const b of document.querySelectorAll('[data-view]')){b.classList.toggle('active',b.dataset.view===key);b.setAttribute('aria-selected',String(b.dataset.view===key));}
      el('workspace-title').textContent=el('page-title').textContent=config.views[key];persist();if(state.data){effectivePeriod();sourceNotes();render();}
    }
    function render(){clear();config.render({state,el,api:W,detail,chart});}
    function detail(title,body){el('detail-title').textContent=title;el('detail-body').innerHTML=body;el('detail').classList.remove('d-none');}
    function chart(id,labels,values,label,format=integer){
      const canvas=el(id);if(!canvas||!values.some(v=>number(v)!==null))return;
      const color=getComputedStyle(document.documentElement).getPropertyValue('--brand-color').trim();
      state.charts.push(new Chart(canvas,{type:'line',data:{labels,datasets:[{label,data:values,borderColor:color,backgroundColor:color+'14',fill:true,pointRadius:values.filter(v=>number(v)!==null).length===1?3:0,borderWidth:2,tension:.2,spanGaps:false}]},options:{responsive:true,maintainAspectRatio:false,animation:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>format(c.raw)}}},scales:{x:{ticks:{maxTicksLimit:8,maxRotation:0},grid:{display:false}},y:{beginAtZero:true,ticks:{callback:v=>format(v)},grid:{color:'#e9edf2'}}}}}));
    }
    function effectivePeriod(){
      const p=state.selectedPeriod;state.ini=p.ini;state.fim=p.fim;
      state.fallback=config.front==='organico'?availableOrganicWindow(state.data,state.brand,p.ini,p.fim,state.view):null;
      if(state.fallback){state.ini=state.fallback.ini;state.fim=state.fallback.fim;}
      state.previousPeriod=state.fallback?Period.previous({preset:'custom',ini:state.ini,fim:state.fim}):p.previous;
    }
    function sourceNotes(){
      const data=state.data,latest=rows=>{const d=(rows||[]).flatMap(r=>[r.ultima_coleta,r.coletado_em]).filter(v=>v&&Number.isFinite(Date.parse(v)));return d.length?d.sort((a,b)=>Date.parse(b)-Date.parse(a))[0]:null;};
      const lastPost=(data.cx_post||[]).filter(r=>canonical(r.marca)===state.brand&&r.publicado_em).map(r=>r.publicado_em).sort((a,b)=>Date.parse(b)-Date.parse(a))[0];
      el('source-time').textContent='Preparado '+when(data.gerado_em||data._cache_gerado_em);
      el('freshness-note').textContent=config.front==='influs'?'Coleta dos pedidos '+when(data.coleta?.[state.brand]):'Última publicação '+when(lastPost)+' · Coleta dos posts '+when(latest(data.cx_post))+' · Stories até '+when(latest(data.cx_story));
      el('window').textContent=Period.label({ini:state.ini,fim:state.fim});
      const names={roi:'Resultados',custos:'Custos',termos:'Termos',saude:'Saúde das fontes',clientes:'Clientes agregados',conciliacao:'Conciliação',cx_post:'Posts',cx_story:'Stories',cx_post_midia:'Prévias',coleta:'Frescor'},issues=[...new Set((data.read_issues||[]).map(r=>names[r.section]||'Atribuição e cobertura'))];
      el('fallback').textContent=(state.fallback?'Sem registros no período escolhido para esta visão. Exibindo a última janela disponível: '+state.ini+' a '+state.fim+'. Sua seleção foi preservada. ':'')+(issues.length?'Leitura parcial. Dados indisponíveis: '+issues.join(', ')+'.':'');
      el('fallback').classList.toggle('d-none',!state.fallback&&!issues.length);el('read-at').textContent='Consulta '+when(new Date().toISOString());
    }
    async function fetchData(range,{brand,before,ticket,controller}){
      const key=config.front+':'+before.user.id+':'+brand+':'+(config.front==='organico'?'cache':range.ini+':'+range.fim),cached=cache.get(key);
      async function confirm(){const after=await session();if(ticket!==state.ticket||controller.signal.aborted||state.brand!==brand||before.user.id!==after.user.id||!brands(after).includes(brand))throw Object.assign(Error(),{code:'ACCESS_CHANGED'});}
      if(cached&&Date.now()-cached.at<60000){await confirm();return cached.data;}
      const opts=config.front==='influs'?{method:'POST',body:JSON.stringify({acao:'listar',marca:brand,ini:range.ini,fim:range.fim,pilot:false}),headers:{'Content-Type':'application/json'}}:{method:'GET',headers:{'X-Shrigma-View-Brand':brand}};
      const r=await fetch(config.front==='influs'?'/api/influ':'/api/cache?painel=organico',{...opts,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal}),data=await r.json();
      if(!r.ok)throw Object.assign(Error(),{status:r.status,code:/^[A-Z_0-9]{1,80}$/.test(data.error||'')?data.error:'SOURCE_REFUSED'});
      await confirm();
      if(data.brand&&canonical(data.brand)!==brand||config.required.some(key=>!Array.isArray(data[key])))throw Object.assign(Error(),{code:'SOURCE_CONTRACT_INVALID'});
      if(cache.size>=8)cache.delete(cache.keys().next().value);cache.set(key,{at:Date.now(),data});return data;
    }
    async function compare(range,context){
      try{const prior=await fetchData(range.previous,context);if(context.ticket!==state.ticket||context.controller.signal.aborted)return;state.previousData=prior;state.comparisonStatus='ready';}
      catch(error){if(context.ticket!==state.ticket)return;if(accessFailure(error)){invalidate();return;}state.previousData=null;state.comparisonStatus='unavailable';}
      if(state.data)render();
    }
    async function load({refresh=false}={}){
      const ticket=++state.ticket;state.controller?.abort();const controller=state.controller=new AbortController();state.data=null;state.previousData=null;state.comparisonStatus='pending';clear();el('error').classList.add('d-none');el('loading').classList.remove('d-none');
      const range=state.selectedPeriod=period.get({refresh:true}),brand=state.brand;if(refresh)cache.clear();persist();
      try{
        const before=await session();if(ticket!==state.ticket)return;if(!brands(before).includes(brand))throw Object.assign(Error(),{code:'ACCESS_DENIED'});
        const context={brand,before,ticket,controller},data=await fetchData(range,context);if(ticket!==state.ticket||controller.signal.aborted)return;
        state.data=data;state.comparisonStatus=config.front==='organico'?'ready':'pending';effectivePeriod();sourceNotes();render();
        // Previous-period reads never delay the first useful numbers.
        if(config.front==='influs')void compare(range,context);
      }catch(error){if(ticket!==state.ticket)return;if(accessFailure(error)){invalidate();return;}state.data=null;clear();el('source-time').textContent='Dados indisponíveis';el('freshness-note').textContent='';el('error').textContent=error.code==='PERIOD_INVALID'?'Selecione um período válido, de até 366 dias.':'Não foi possível consultar esta marca.'+(error.status?' HTTP '+error.status+'.':'')+(error.code?' Código: '+error.code+'.':'');el('error').classList.remove('d-none');}
      finally{if(ticket===state.ticket)el('loading').classList.add('d-none');}
    }
    period=Period.bind({document,location,select:el('days'),start:el('d-ini'),end:el('d-fim'),apply:el('period-apply'),note:el('period-note'),onChange:()=>load()});
    for(const b of document.querySelectorAll('[data-view]'))b.addEventListener('click',()=>view(b.dataset.view));
    el('detail-close').addEventListener('click',()=>el('detail').classList.add('d-none'));document.addEventListener('keydown',e=>{if(e.key==='Escape')el('detail').classList.add('d-none');});
    el('reload').addEventListener('click',()=>load({refresh:true}));el('brand').addEventListener('change',()=>{chooseBrand();period.sync();load();});
    for(const id of config.filters||[])el(id)?.addEventListener('input',()=>state.data&&render());
    (async()=>{try{const s=await session(),allowed=brands(s);if(!allowed.length)throw Error('BRAND_DATA_UNAVAILABLE');for(const o of [...el('brand').options])if(!allowed.includes(o.value))o.remove();el('brand').disabled=allowed.length===1;el('brand').value=allowed.includes(state.brand)?state.brand:allowed[0];chooseBrand();state.selectedPeriod=period.get();state.ini=state.selectedPeriod.ini;state.fim=state.selectedPeriod.fim;view(state.view);await load();}catch{el('error').textContent='Esta frente não está disponível para o seu acesso.';el('error').classList.remove('d-none');}})();
    return {state,load,render,view,period};
  }

  const W={number,esc,brl,integer,percent,canonical,date,when,sum,chip,table,card,cards,validDate,addDays,Period,availablePostWindow,availableOrganicWindow,mount};
  if(typeof module!=='undefined')module.exports=W;else{root.ShrigmaReadWorkspace=W;root.ShrigmaPeriod=Period;}
})(typeof window!=='undefined'?window:globalThis);
