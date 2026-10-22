'use strict';
// Como os resultados de e-mail mudaram contra o período anterior? comparacao-periodos.spec.md.
function html(kind){
 const home=kind==='home',base=require(home?'./crm-paid-home-ui.cjs':'./crm-paid-results-ui.cjs').HTML;
 return base.replace('<body>','<body data-view="'+(home?'home':'results')+'">')
  .replace('1fr 1fr 1.3fr .7fr auto','1.1fr 1fr 1fr 1.1fr .7fr auto')
  .replace('<label class="form-label">De','<label class="form-label">Período<select id="preset" class="form-select"></select></label><label class="form-label">De')
  .replace('<span id="quality"','<span id="comparison-status" class="badge bg-secondary-lt"></span> <span id="quality"')
  .replace('<div id="notice"','<div id="previous-period" class="text-secondary small mb-3"></div><div id="notice"')
  .replace(/<script src="\/app\/crm\/restrito\/(?:inicio|resultados)\.js"><\/script>/,'<script src="/app/crm/workspace.js"></script><script src="/app/crm/restrito/comparacao.js"></script>');
}
function mount(){
 const $=id=>document.getElementById(id),Period=window.ShrigmaPeriod,home=document.body.dataset.view==='home',params=new URLSearchParams(location.search);
 let busy=false,chart=null,viewer=null,displayedBrand=null,controller;
 const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const number=v=>v===null||v===undefined?'—':new Intl.NumberFormat('pt-BR').format(v),day=v=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(v));
 const money=(v,currency)=>{if(v===null||v===undefined)return '—';const n=BigInt(v),symbol=new Intl.NumberFormat('pt-BR',{style:'currency',currency}).formatToParts(0).find(x=>x.type==='currency').value;return symbol+' '+(n/100n).toLocaleString('pt-BR')+','+(n%100n).toString().padStart(2,'0');};
 const pct=v=>v===null||v===undefined?'—':new Intl.NumberFormat('pt-BR',{maximumFractionDigits:2}).format(v/100)+'%';
 function clear(){if(chart){chart.destroy();chart=null;}$('metrics').replaceChildren();$('campaign-rows').replaceChildren();$('period').textContent='';$('freshness').textContent='';$('comparison-status').textContent='';$('previous-period').textContent='';if($('revenue-updated'))$('revenue-updated').textContent='';$('curve').hidden=true;$('curve-empty').hidden=false;$('curve-empty').textContent='Entre novamente no CRM.';displayedBrand=null;throw Error('O acesso mudou. Entre novamente no CRM.');}
 async function session(){const r=await fetch('/auth/session',{credentials:'same-origin',cache:'no-store'});if(!r.ok)return clear();const s=await r.json();if(!s.authenticated||typeof s.user?.id!=='string')return clear();const key=JSON.stringify({id:s.user.id,role:s.user.role,permissions:s.user.permissions,brands:s.user.viewBrands||s.user.brands,fronts:s.user.productWriteFronts});if(viewer!==null&&viewer!==key)return clear();viewer=key;return s;}
 function render(v){
  const previous=v.comparison,p=controller.get();displayedBrand=v.brand;document.body.dataset.brand=v.brand;$('brand').value=v.brand;
  $('period').textContent=(v.brand==='fish'?'Fishermans':'O Aristocrata')+' · '+Period.label(v.calendar)+(v.period.fallback?' · Dados da última janela disponível':'');
  $('from').value=v.calendar.ini;$('until').value=v.calendar.fim;if(v.period.fallback)$('preset').value='custom';
  $('previous-period').textContent='Anterior: '+Period.label(previous.calendar);$('previous-period').title=previous.calendar.clamped?'Comparação com mês de duração diferente.':'Mesma moeda e identificação das campanhas nos dois períodos.';
  $('quality').textContent=v.partial?'Parcial':v.available?'Confirmado':'Sem dados';$('quality').title='Fatos pagos conhecidos. Último clique não direto em até 30 dias. Cobertura integral '+(v.coverage.windowConfirmed?'confirmada.':'não confirmada; valores conhecidos são subtotais.');
  $('comparison-status').textContent=!previous.available?'Comparação indisponível':previous.partial?'Comparação parcial':'Comparação';$('comparison-status').title=previous.reason||'Período anterior: '+Period.label(previous.calendar)+(previous.partial?' · comparação de subtotais conhecidos.':'');
  $('currency').replaceChildren();for(const currency of [...new Set([...v.currencies,v.currency])])$('currency').append(node('option',currency));$('currency').value=v.currency;
  const sent=x=>x?.sent??x?.knownSent??null,entries=home?[
   ['Enviados',sent(v.mail),sent(previous.mail),number,false],['Pessoas alcançadas',null,null,number,false],['Pedidos',v.totals.orders,previous.totals.orders,number,false],['Receita atribuída',v.totals.revenueCents,previous.totals.revenueCents,x=>money(x,v.currency),false]
  ]:[['Receita atribuída',v.totals.revenueCents,previous.totals.revenueCents,x=>money(x,v.currency),false],['Pedidos',v.totals.orders,previous.totals.orders,number,false],['Primeiras compras',v.totals.firstPurchases,previous.totals.firstPurchases,number,false],['% da receita da loja',v.totals.storeShareBasisPoints,previous.totals.storeShareBasisPoints,pct,true]];
  const comparable=entries.some(([,current,prior])=>current!==null&&current!==undefined&&prior!==null&&prior!==undefined);$('comparison-status').textContent=!comparable?'Comparação indisponível':previous.partial?'Comparação parcial':'Comparação';$('comparison-status').title=comparable?'Período anterior: '+Period.label(previous.calendar)+(previous.partial?' · comparação de subtotais conhecidos.':''):previous.reason||'Um dos períodos não tem valores confirmados para comparação.';
  $('metrics').replaceChildren();for(const [label,value,prior,format,rate]of entries){const cell=node('div',undefined,'metric'),change=Period.change(rate&&value!==null?value/10000:value,rate&&prior!==null?prior/10000:prior,{rate}),delta=node('div',change.text,'text-secondary small mt-2');delta.dataset.comparison='true';delta.title='Anterior: '+format(prior)+' · '+Period.label(previous.calendar);cell.append(node('div',label,'text-secondary'),node('div',format(value),'h1 mb-0'),delta);if(label==='Enviados')cell.title='Total de envios da marca, inclusive ao filtrar campanhas; mesma leitura diária nos dois períodos.';if(label==='Pessoas alcançadas')cell.title='Pessoas únicas com entrega confirmada não disponíveis.';$('metrics').append(cell);}
  const observed=v.revenueObservedAt||v.contributingObservedAt;$('freshness').textContent=observed?new Date(observed).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'Leitura parcial';if($('revenue-updated')){$('revenue-updated').textContent=observed?'Receita atualizada '+new Date(observed).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'Receita sem data confirmada';$('revenue-updated').title='Observação persistida de pedidos que contribuem receita.';}
  $('campaign-rows').replaceChildren();for(const row of v.campaigns){const tr=node('tr'),label=node('td'),family=node('div',row.families.join(' · ')||'—','text-secondary small family');family.title=row.families.join('\n');label.append(node('strong','E-mail #'+row.campaignId),family);tr.append(label,node('td',money(row.revenueCents,v.currency)),node('td',number(row.orders)),node('td',number(row.firstPurchases)),node('td',pct(row.storeShareBasisPoints)));$('campaign-rows').append(tr);}if(!v.campaigns.length){const tr=node('tr'),cell=node('td','Nenhuma campanha identificada nesta janela.');cell.colSpan=5;tr.append(cell);$('campaign-rows').append(tr);}
  if(chart){chart.destroy();chart=null;}const has=v.series.some(x=>x.revenueCents!==null)||previous.series.some(x=>x.revenueCents!==null);$('curve').hidden=!has;$('curve-empty').hidden=has;$('curve-empty').textContent='Sem receita identificada nestas janelas.';
  if(has&&typeof Chart!=='function'){$('curve').hidden=true;$('curve-empty').hidden=false;$('curve-empty').textContent='Gráfico indisponível.';}
  if(has&&typeof Chart==='function'){
   const length=Math.max(v.series.length,previous.series.length),points=rows=>Array.from({length},(_,i)=>rows[i]?.revenueCents==null?null:Number(rows[i].revenueCents)/100);
   chart=new Chart($('curve'),{
    type:'line',
    data:{labels:Array.from({length},(_,i)=>v.series[i]?.day.split('-').reverse().join('/')||String(i+1)),datasets:[
     {label:'Atual',data:points(v.series),borderColor:v.brand==='aristo'?'#174f3f':'#285788',pointRadius:2,spanGaps:false},
     {label:'Anterior',data:points(previous.series),borderColor:'#8a97a3',borderDash:[5,4],pointRadius:2,spanGaps:false}
    ]},
    options:{responsive:true,maintainAspectRatio:false,animation:false,
     plugins:{legend:{display:true},tooltip:{callbacks:{label:c=>{const row=(c.datasetIndex?previous.series:v.series)[c.dataIndex];return row?row.day.split('-').reverse().join('/')+' · '+money(row.revenueCents,v.currency):'—';}}}},
     scales:{y:{beginAtZero:true,ticks:{callback:x=>new Intl.NumberFormat('pt-BR',{notation:'compact'}).format(x)}}}
    }
   });
  }
  const saved=new URLSearchParams({brand:v.brand,preset:p.preset,ini:p.ini,fim:p.fim,currency:v.currency});if($('campaigns').value.trim())saved.set('campaigns',$('campaigns').value.trim());history.replaceState(null,'',location.pathname+'?'+saved);
 }
 async function load(){await session();const period=controller.get(),query=new URLSearchParams({action:home?'compare-home':'compare-results',brand:$('brand').value,preset:period.preset,ini:period.ini,fim:period.fim,currency:$('currency').value,campaigns:$('campaigns').value.trim()}),r=await fetch('/api/crm-restricted/compras?'+query,{credentials:'same-origin',cache:'no-store'});if([401,403].includes(r.status))return clear();const value=await r.json();if(!r.ok||value.error)throw Error('Consulta indisponível. Os dados anteriores foram preservados.');
  if(home){try{const r=await fetch('/api/crm-read?action=cache_growth&painel=growth',{credentials:'same-origin',cache:'no-store',headers:{'X-Shrigma-View-Brand':value.brand,'X-Shrigma-Crm-View':'home'}});if([401,403].includes(r.status))return clear();if(!r.ok)throw Error('MAIL_UNAVAILABLE');const payload=await r.json(),data={crm_diario:payload.crm_diario,crm_fontes:payload.crm_fontes};for(const target of [value,value.comparison])target.mail=window.ShrigmaCrmHome.summarize(data,value.brand,day(target.period.from),day(Date.parse(target.period.until)-1));}catch(e){if(e.message==='O acesso mudou. Entre novamente no CRM.')throw e;value.mail=null;value.comparison.mail=null;}}
  if(home){value.partial=value.partial||!value.mail||value.mail.volumePartial;value.comparison.partial=value.comparison.partial||value.partial||!value.comparison.mail||value.comparison.mail.volumePartial;}
  await session();render(value);
 }
 async function work(){if(busy)return;busy=true;for(const e of $('filters').elements)e.disabled=true;$('brand').disabled=true;try{$('notice').hidden=true;await load();}catch(e){if(displayedBrand)$('brand').value=displayedBrand;$('notice').textContent=e.message||'Consulta indisponível.';$('notice').hidden=false;$('quality').textContent='Indisponível';}finally{busy=false;for(const e of $('filters').elements)e.disabled=false;$('brand').disabled=false;}}
 $('brand').value=params.get('brand')==='fish'?'fish':'aristo';$('campaigns').value=params.get('campaigns')||'';const initialCurrency=params.get('currency')||'BRL';if(/^[A-Z]{3}$/.test(initialCurrency)&&initialCurrency!=='BRL')$('currency').append(node('option',initialCurrency));$('currency').value=initialCurrency;$('curve').hidden=true;$('curve-empty').hidden=false;$('curve-empty').textContent='Conferindo dados…';
 controller=Period.bind({document,location,select:$('preset'),start:$('from'),end:$('until'),apply:$('filters'),onChange:()=>work()});$('brand').addEventListener('change',()=>work());
 return work();
}
module.exports={html,JS:"'use strict';("+mount.toString()+")();"};
