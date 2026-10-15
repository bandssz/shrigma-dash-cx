'use strict';
// Product parity with growth.html. Reuse the original calculation contracts;
// the authenticated workspace owns fetching, scope, periods and Tabler markup.
const G=require('../../../../growth-data.js');
const GA=require('../../../../growth-attribution.js');
const GT=require('../../../../growth-table.js');
const GD=require('../../../../growth-delivery.js');
const Home=require('./home.js');
const Analytics=(()=>{
 const names={fish:'Fishermans',aristo:'O Aristocrata',olivas:'Olivas do Campo'},channels={email:'E-mail',whatsapp:'WhatsApp',todos:'E-mail e WhatsApp'};
 const numeric=v=>v!==null&&v!==undefined&&v!==''&&typeof v!=='boolean'&&Number.isFinite(Number(v))?Number(v):null;
 const count=v=>{const n=numeric(v);return Number.isSafeInteger(n)&&n>=0?n:null;};
 const knownSum=(rows,key)=>rows.length&&rows.every(r=>numeric(r[key])!==null)?rows.reduce((n,r)=>n+numeric(r[key]),0):null;
 const date=v=>String(v||'').slice(0,10),within=(r,a,z)=>date(r.dia)>=a&&date(r.dia)<=z;
 const num=v=>numeric(v)===null?'Indisponível':Number(v).toLocaleString('pt-BR',{maximumFractionDigits:1});
 const money=v=>numeric(v)===null?'Indisponível':Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
 const pct=v=>numeric(v)===null?'Indisponível':Number(v).toLocaleString('pt-BR',{maximumFractionDigits:1})+'%';
 const esc=GT.esc;
 function validate(api,brand){
  if(!api||api.brand!==brand||JSON.stringify(api.brands)!==JSON.stringify([brand]))throw Error('ANALYTICS_SCOPE');
  for(const [key,rows]of Object.entries(api)){if(!Array.isArray(rows)||!key.startsWith('crm_'))continue;for(const row of rows)if(row&&typeof row==='object'&&('marca'in row||'brand'in row)&&((row.marca||row.brand)!==brand||row.marca&&row.brand&&row.marca!==row.brand))throw Error('ANALYTICS_SCOPE');}
  for(const key of ['daily','hourly','coverage','quality','campaigns'])for(const row of api.crm_attribution?.[key]||[])if((row.marca||row.brand)!==brand)throw Error('ANALYTICS_SCOPE');
  return api;
 }
 function coverage(api,brand,a,z){
  const valid=GA.valid(api)&&Array.isArray(api.crm_attribution.daily)&&api.crm_attribution.daily.every(Home.validAttributionRow)&&(GA.model(api)===(api.crm_attribution.default_model||GA.DEFAULT_MODEL)||api.crm_attribution.daily.some(r=>r.model===GA.model(api)));
  const raw=Array.isArray(api?.crm_attribution?.coverage)?api.crm_attribution.coverage:[],counts=new Map();
  for(const r of raw)if((r.brand||r.marca)===brand)counts.set(date(r.day),(counts.get(date(r.day))||0)+1);
  const coverageRows=raw.filter(r=>(r.brand||r.marca)===brand&&counts.get(date(r.day))===1&&Number.isFinite(Date.parse(r.checked_at))&&Home.dates(date(r.day),date(r.day)).length===1);
  const c=valid?GA.coverage({...api,crm_attribution:{...api.crm_attribution,coverage:coverageRows,quality:Array.isArray(api.crm_attribution.quality)?api.crm_attribution.quality:[]}},brand,a,z):{covered:0,expected:Home.dates(a,z).length,complete:false};
  return {...c,valid,coveredDays:new Set((valid?coverageRows:[]).map(r=>date(r.day)))};
 }
 function channelMetric(api,brand,a,z,channel,key){
  const cov=coverage(api,brand,a,z),days=Home.dates(a,z),rows=cov.valid?GA.rows(api,brand,a,z,'channel',channel):[];
  const byDay=new Map(days.map(d=>[d,rows.filter(r=>date(r.dia)===d)]));
  const knownDays=days.filter(d=>cov.coveredDays.has(d)&&byDay.get(d).every(r=>numeric(r[key])!==null)&&new Set(byDay.get(d).map(r=>JSON.stringify(r.dimension))).size===byDay.get(d).length);
  const known=knownDays.length?knownDays.reduce((n,d)=>n+byDay.get(d).reduce((s,r)=>s+numeric(r[key]),0),0):null;
  return {known,total:cov.complete&&knownDays.length===days.length?known:null,knownDays:knownDays.length,expected:days.length,partial:known!==null&&(!cov.complete||knownDays.length!==days.length)};
 }
 function conversion(api,brand,a,z,grain='peca',channel='todos'){
  const cov=coverage(api,brand,a,z);if(!cov.valid||!cov.covered)return[];
  const g=grain==='peca'?'piece':grain==='familia'?(channel==='todos'?'family':'family_channel'):(channel==='todos'?'campaign':'campaign_channel');
  const raw=GA.rows(api,brand,a,z,g,channel).filter(r=>cov.coveredDays.has(date(r.dia)));
  const duplicate=new Set(),seen=new Set();for(const r of raw){const k=JSON.stringify([date(r.dia),r.dimension]);if(seen.has(k))duplicate.add(k);seen.add(k);}
  const groups=new Map();for(const r of raw){const key=JSON.stringify(r.dimension);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
  // GA sums the proper deduplicated grain. Never let its legacy numeric helper
  // convert an explicit NULL measure into a measured zero.
  const fields={pedidos:'pedidos',receita:'receita',assist:'assistidos',receita_assist:'receita_assistida',novos:'novos',recorr:'recorrentes'};
  const output=[];for(const group of groups.values()){
   const safe=group.filter(r=>!duplicate.has(JSON.stringify([date(r.dia),r.dimension]))),copy={...api,crm_attribution:{...api.crm_attribution,daily:safe.length?safe:[group[0]]}},r=GA.conversion(copy,brand,a,z,grain,channel)[0];
   if(!r)continue;const value={...r,partial:!cov.complete||safe.length!==group.length};for(const [key,source]of Object.entries(fields))if(!safe.length||safe.some(r=>numeric(r[source])===null)){value[key]=null;value.partial=true;}
   value.novos_pct=value.novos!==null&&value.recorr!==null&&value.novos+value.recorr>0?100*value.novos/(value.novos+value.recorr):null;output.push(value);
  }
  return GT.ordena(output,'receita','desc');
 }
 function pieces(api,brand,a,z,channel='todos'){
  const cov=coverage(api,brand,a,z);if(!GA.valid(api)||!Array.isArray(api.crm_attribution.campaigns))return[];
  return GA.campaigns(api,brand,a,z,channel).flatMap(group=>group.members.filter(m=>m.in_period).map(m=>{
   const e=GA.engagement(m),bound=cov.valid&&cov.covered>0&&Number.isFinite(Date.parse(m.enviado_em))&&cov.coveredDays.has(G.diaBR(m.enviado_em))&&m.result!==null&&m.evidence_verified&&m.evidence_receipt_valid&&m.tracking_state==='exclusive';
   const raw=bound?(api.crm_attribution.dispatch_evidence?.daily||[]).filter(r=>r.marca===brand&&r.model===GA.model(api)&&String(r.campanha_id)===String(m.campanha_id)&&within(r,a,z)&&cov.coveredDays.has(date(r.dia))):[],duplicate=new Set(raw.map(r=>date(r.dia))).size!==raw.length;
   const measure=key=>!bound||duplicate?null:raw.length?knownSum(raw,key):0;
   return {marca:brand,campanha_id:m.campanha_id,nome:m.nome,canal:m.canal||'email',familia:group.nome,enviados:count(m.enviados),entregues:e.delivered,abertura:e.opening,ctr:e.ctr,ctor:e.ctor,receita:measure('receita'),pedidos:measure('pedidos'),tracking:m.tracking_state,partial:!cov.complete||duplicate||bound&&raw.some(r=>numeric(r.receita)===null||count(r.pedidos)===null),submittedAt:m.enviado_em};
  }));
 }
 function series(api,brand,a,z,metric,channel='todos'){
  const days=Home.dates(a,z);if(!days.length)return[];
  if(metric==='receita'){
   const cov=coverage(api,brand,a,z),rows=cov.valid?GA.rows(api,brand,a,z,'channel',channel):[],byDay=new Map();
   for(const r of rows){const d=date(r.dia);if(!byDay.has(d))byDay.set(d,[]);byDay.get(d).push(r);}
   return days.map(d=>{const values=byDay.get(d)||[],known=cov.valid&&cov.coveredDays.has(d)&&values.every(r=>numeric(r.receita)!==null)&&new Set(values.map(r=>JSON.stringify(r.dimension))).size===values.length;return {d,v:known?values.reduce((n,r)=>n+numeric(r.receita),0):null};});
  }
  if(metric==='wa_entregues'||metric==='wa_falhas')return days.map(d=>({d,v:channel==='email'?null:GD.whatsapp(api,brand,d,d)[metric==='wa_entregues'?'entregues':'falhas']}));
  if(metric==='inscritos')return days.map(d=>({d,v:null}));
  const column={cliques:'cliques',enviados:'enviados',complaints:'complaints'}[metric];if(!column)return days.map(d=>({d,v:null}));
  const original=G.serie(api,brand,a,z,column,'email');
  return days.map(d=>{const rows=(api.crm_diario||[]).filter(r=>r.marca===brand&&date(r.dia)===d&&r.janela==='1d'),emailRows=rows.filter(r=>(r.canal||'email')==='email'),email=emailRows.length===1&&numeric(emailRows[0][column])!==null?original.find(r=>r.d===d)?.v??null:null,wa=metric==='enviados'?GD.whatsapp(api,brand,d,d).aceitos:null;return {d,v:metric!=='enviados'?(channel==='whatsapp'?null:email):channel==='email'?email:channel==='whatsapp'?wa:email!==null&&wa!==null?email+wa:null};});
 }
 function flowRows(api,brand,a,z,channel='todos'){
  const safeG={...G,regua:(...args)=>G.regua(...args).map(r=>({...r,pedidos:null,receita:null,assist:null,receita_assist:null,porMil:null,atribuicao_sem_vinculo:true}))};
  return GD.flows(safeG,api,brand,a,z,channel).map(r=>{const raw=(api.crm_fluxo||[]).filter(x=>x.marca===brand&&(x.canal||'email')===r.canal&&x.flow===r.flow&&x.piece===r.piece&&within(x,a,z));return {...r,enviados:r.canal==='email'?knownSum(raw,'enviados'):r.enviados,pedidos:null,receita:null};});
 }
 function cart(api,brand,a,z){
  const rows=(api.crm_carrinho||[]).filter(r=>r.marca===brand&&within(r,a,z)),v=G.carrinho(api,brand,a,z);if(!v)return null;
  const measured=rows.filter(r=>r.recuperados!==null&&r.recuperados!==undefined);
  return {...v,carrinhos:knownSum(rows,'carrinhos'),valor:knownSum(rows,'valor_em_jogo'),consent:knownSum(rows,'com_consent'),voltaram:knownSum(rows,'voltaram_72h'),recuperados:knownSum(measured,'recuperados'),receita:knownSum(measured,'receita_recuperada'),receitaVoltaram:knownSum(rows,'receita_voltaram'),marca:brand};
 }
 function build(sources,brands,a,z,channel='email',model='last_click'){
  const result={brands:[...brands],ini:a,fim:z,channel,model,sources:[],unavailable:[],conversion:[],pieces:[],flows:[],carts:[],coverage:[],revenue:[],orders:[],assisted:[]};
  for(const brand of brands){const d=sources[brand];if(!d){result.unavailable.push(brand);continue;}validate(d,brand);const api={...d,_attribution_model:Object.hasOwn(GA.models,model)?model:'last_click'};const c=coverage(api,brand,a,z);result.coverage.push({brand,covered:c.covered,expected:c.expected,complete:c.complete,valid:c.valid});result.sources.push({brand,cache:d._cache_gerado_em||d.gerado_em,attribution:d.crm_attribution?.generated_at});
   result.revenue.push(channelMetric(api,brand,a,z,channel,'receita'));result.orders.push(channelMetric(api,brand,a,z,channel,'pedidos'));result.assisted.push(channelMetric(api,brand,a,z,channel,'receita_assistida'));result.conversion.push(...conversion(api,brand,a,z,'peca',channel));result.pieces.push(...pieces(api,brand,a,z,channel));result.flows.push(...flowRows(api,brand,a,z,channel));const v=cart(api,brand,a,z);if(v)result.carts.push(v);
  }
  const aggregate=rows=>({known:rows.length&&rows.every(r=>r.known!==null)?rows.reduce((n,r)=>n+r.known,0):null,total:!result.unavailable.length&&rows.length===brands.length&&rows.every(r=>r.total!==null)?rows.reduce((n,r)=>n+r.total,0):null});
  result.revenueTotal=aggregate(result.revenue);result.ordersTotal=aggregate(result.orders);result.assistedTotal=aggregate(result.assisted);result.partial=result.unavailable.length>0||result.coverage.some(c=>!c.complete)||[...result.revenue,...result.orders,...result.assisted,...result.conversion,...result.pieces].some(r=>r.partial);
  return result;
 }
 const table=(headers,rows,empty='Sem dados confirmados neste recorte.')=>'<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr>'+headers.map(x=>'<th>'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>'+(rows.length?'':'<div class="card-body text-secondary">'+esc(empty)+'</div>');
 const cells=values=>'<tr>'+values.map(x=>'<td class="text-break">'+esc(x)+'</td>').join('')+'</tr>';
 const metric=(label,value,note)=>'<div class="col-12 col-sm-6 col-lg-3"><div class="card h-100"><div class="card-body"><div class="subheader mb-2">'+esc(label)+'</div><div class="metric-value">'+esc(value)+'</div><div class="source-line mt-2">'+esc(note)+'</div></div></div></div>';
 function summaryMarkup(data){const partial=m=>m.total===null&&m.known!==null;return metric(partial(data.revenueTotal)?'Receita conhecida · parcial':'Receita atribuída',money(data.revenueTotal.total??data.revenueTotal.known),channels[data.channel]+' · '+GA.models[data.model])+metric(partial(data.ordersTotal)?'Pedidos conhecidos · parcial':'Pedidos atribuídos',num(data.ordersTotal.total??data.ordersTotal.known),'Grão por canal, sem somar campanhas ou peças')+metric(partial(data.assistedTotal)?'Receita assistida conhecida · parcial':'Receita assistida conhecida',money(data.assistedTotal.total??data.assistedTotal.known),'Assistências se sobrepõem; não somar à receita atribuída')+metric('Marcas consultadas',data.sources.length+' / '+data.brands.length,'Somente as marcas permitidas neste acesso');}
 function coverageMarkup(data){const coverage=data.coverage.map(c=>names[c.brand]+': '+c.covered+'/'+c.expected+' dias').join(' · '),missing=data.unavailable.length?' · Fonte indisponível: '+data.unavailable.map(b=>names[b]).join(', '):'';return '<div class="alert alert-'+(data.partial?'warning':'info')+'">'+esc(coverage+missing)+'. '+(data.partial?'Valores conhecidos são parciais; lacunas permanecem indisponíveis.':'Período de atribuição conferido.')+'</div>';}
 function resultMarkup(data){
  return coverageMarkup(data)+'<div class="row g-3 mb-3">'+summaryMarkup(data)+'</div><div class="card mb-3"><div class="card-header flex-wrap gap-2"><h2 class="card-title">Evolução</h2><select id="results-metric" class="form-select w-auto ms-auto" aria-label="Métrica de evolução"><option value="receita">Receita atribuída</option><option value="cliques">Cliques de e-mail</option><option value="enviados">Envios registrados</option><option value="wa_entregues">Entregues · WhatsApp</option><option value="wa_falhas">Falhas · WhatsApp</option><option value="complaints">Reclamações de e-mail</option><option value="inscritos">Inscritos · fonte pendente</option></select></div><div class="card-body"><div style="height:280px;position:relative"><canvas id="results-chart" aria-label="Evolução no período" role="img"></canvas></div><div id="results-chart-note" class="source-line mt-2"></div></div></div><div class="card mb-3"><div class="card-header"><h2 class="card-title">Onde a venda fecha</h2></div><div id="results-closes"></div></div><div class="card mb-3"><div class="card-header flex-wrap gap-2"><h2 class="card-title">Desempenho por peça</h2><input id="results-piece-search" type="search" class="form-control w-auto ms-auto" placeholder="Buscar peça ou campanha" aria-label="Buscar peça"><select id="results-piece-sort" class="form-select w-auto" aria-label="Ordenar peças"><option value="receita">Maior receita</option><option value="enviados">Mais envios</option><option value="ctr">Maior CTR</option><option value="ctor">Maior CTOR</option><option value="nome">Nome</option></select><button id="results-piece-export" class="btn btn-outline-primary btn-sm">Exportar CSV</button></div><div id="results-pieces"></div><div class="card-footer source-line">Engajamento acumulado por disparo; compras no período e modelo selecionados. CTR = pessoas que clicaram ÷ entregues; CTOR = pessoas que clicaram ÷ pessoas que abriram. Aberturas podem incluir carregamentos automáticos. Receita compartilhada não é dividida artificialmente.</div></div><div class="card"><div class="card-header flex-wrap gap-2"><h2 class="card-title">Atribuição</h2><select id="results-grain" class="form-select w-auto ms-auto" aria-label="Agrupamento da atribuição"><option value="peca">Por peça</option><option value="campanha">Por campanha</option><option value="familia">Por família</option></select><input id="results-conversion-search" type="search" class="form-control w-auto" placeholder="Buscar atribuição" aria-label="Buscar atribuição"><button id="results-conversion-export" class="btn btn-outline-primary btn-sm">Exportar CSV</button></div><div id="results-conversion"></div><div class="card-footer source-line">Cada agrupamento usa seu próprio grão deduplicado. Assistências podem se sobrepor. % novos = novos ÷ (novos + recorrentes). Atribuição não mede efeito incremental nem prova que o comprador recebeu a mensagem.</div></div>';
 }
 function automationMarkup(data){
  const rows=data.flows.map(r=>cells([names[r.marca],channels[r.canal]||r.canal,r.flow,r.piece,num(r.enviados),num(r.entregues),num(r.falhas),num(r.pedidos),money(r.receita)]));
  const emailCampaigns=data.pieces.filter(r=>r.canal==='email'),emailFlows=data.flows.filter(r=>r.canal==='email');
  const compare=[cells(['Campanhas · e-mail',num(knownSum(emailCampaigns,'enviados')),'Acumulado dos disparos iniciados no período']),cells(['Automações · e-mail',num(knownSum(emailFlows,'enviados')),'Registros das etapas no período; base temporal diferente'])];
  const cards=data.carts.map(c=>'<div class="card mb-3"><div class="card-header"><h3 class="card-title">'+esc(names[c.marca])+' · carrinho · todos os canais</h3></div><div class="card-body"><div class="row g-3">'+metric('Carrinhos registrados',num(c.carrinhos),'Observados em '+c.dias+' dias')+metric('Valor em jogo',money(c.valor),'Não equivale a receita perdida')+metric('Voltaram em 72h',num(c.voltaram),'Retorno observado; não mede efeito incremental')+metric('Receita de quem voltou',money(c.receitaVoltaram),'Ausência permanece indisponível')+'</div><p class="source-line mt-3">Recuperações com cobertura: '+num(c.recuperados)+' · receita conhecida '+money(c.receita)+' · '+c.diasMedidos+'/'+c.dias+' dias medidos. A janela de 72h precisa maturar; o filtro de canal não divide os carrinhos da loja.</p></div></div>').join('');
  return coverageMarkup(data)+'<div class="card mb-3"><div class="card-header"><h2 class="card-title">Desempenho das automações por canal</h2></div>'+table(['Marca','Canal','Fluxo','Etapa','Disparos registrados','Entregues','Falhas','Pedidos','Receita'],rows)+'<div class="card-footer source-line">WhatsApp exige cobertura confirmada. Pedidos e receita por automação aguardam vínculo revisado de fluxo com UTM; não são zero. As sete jornadas existentes continuam preservadas.</div></div><div class="card mb-3"><div class="card-header"><h2 class="card-title">Campanhas × automações</h2></div>'+table(['Origem','Envios conhecidos','Como ler'],compare)+'<div class="card-footer source-line">Não comparar conversão por envio entre bases temporais diferentes nem atribuir receita ao fluxo sem vínculo confirmado.</div></div>'+cards;
 }
 function exportCsv(kind,rows,data){
  const columns=kind==='pieces'?[['nome','Peça'],['marca','Marca'],['canal','Canal'],['enviados','Enviados acumulados'],['entregues','Entregues acumulados'],['abertura','Abertura %'],['ctr','CTR %'],['ctor','CTOR %'],['receita','Receita BRL no periodo'],['tracking','Vinculo UTM']]:[['marca','Marca'],['canal','Canal'],['campanha','Campanha'],['peca','Peça'],['familia','Familia'],['pedidos','Pedidos conhecidos'],['receita','Receita conhecida BRL'],['assist','Pedidos assistidos'],['receita_assist','Receita assistida BRL'],['novos_pct','Novos %']];
  columns.push(['partial','Linha parcial']);
  const meta={recorte_marca:data.brands.join('+'),recorte_canal:data.channel,periodo_inicio:data.ini,periodo_fim:data.fim,modelo:data.model,cobertura:data.partial?'parcial':'completa',consulta_em:data.sources.map(r=>r.brand+':'+r.attribution).join(' | ')};
  return {name:GT.nomeArquivo(kind,meta),csv:GT.csv(columns.map(([chave,rotulo])=>({chave,rotulo})),rows,meta)};
 }
 return Object.freeze({names,channels,validate,coverage,channelMetric,conversion,pieces,series,flowRows,cart,build,table,cells,metric,summaryMarkup,coverageMarkup,resultMarkup,automationMarkup,exportCsv,numeric,count,knownSum,num,money,pct,esc,search:GT.busca,sort:GT.ordena,download:GT.baixar,models:GA.models});
})();
if(typeof module==='object'&&module.exports)module.exports=Analytics;
if(typeof window==='object')window.ShrigmaCrmAnalytics=Analytics;
