/* Growth attribution contract v2: order-deduplicated aggregates, explicit models. */
const GA=(()=>{
 const DEFAULT_MODEL='last_click';
 const models={last_click:'Último clique',last_non_direct:'Último clique não direto'},brands=['aristo','fish','olivas'];
 const names={'semana-do-cliente-2026':'Semana do Cliente · 2026','desodorante-frescor':'Lançamento Desodorante Frescor','sabonete-alma-da-roca':'Lançamento Alma da Roça','fish-carta-fundador':'Carta do fundador','fish-dia-do-cliente':'Dia do Cliente · 2026','fish-copo':'Campanha do Copo','fish-kit-x1':'Kit X1','fish-4x-8x':'Guia 4X ou 8X','aristo-9do9':'Especial 9.9','workflow-175919-semana-do-pescador-02':'Semana do Pescador · WhatsApp (histórico)'};
 const norm=v=>String(v??'').trim().toLowerCase(),num=v=>Number(v)||0,date=v=>String(v||'').slice(0,10);
 const inPeriod=(d,a,b)=>date(d)>=a&&date(d)<=b;
 const day=v=>v?new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(v)):'';
 const valid=api=>api?.crm_attribution?.schema_version===2;
 const model=api=>models[api?._attribution_model]?api._attribution_model:DEFAULT_MODEL;
 const supported=b=>b==='todas'||brands.includes(b);
 const selected=(r,b,a,z)=> (b==='todas'||r.marca===b)&&inPeriod(r.dia,a,z);
 function rows(api,b,a,z,grain,channel='todos'){
  return (api?.crm_attribution?.daily||[]).filter(r=>r.model===model(api)&&r.grain===grain&&selected(r,b,a,z))
   .filter(r=>channel==='todos'||(grain==='piece'||grain==='flow_piece'||grain==='channel'?r.dimension[0]:r.dimension[1])===channel);
 }
 function sum(rr){return rr.reduce((s,r)=>({pedidos:s.pedidos+num(r.pedidos),receita:s.receita+num(r.receita),assist:s.assist+num(r.assistidos),receita_assist:s.receita_assist+num(r.receita_assistida),novos:s.novos+num(r.novos),recorr:s.recorr+num(r.recorrentes)}),{pedidos:0,receita:0,assist:0,receita_assist:0,novos:0,recorr:0});}
 function coverage(api,b,a,z){
  const bs=b==='todas'?brands:brands.includes(b)?[b]:[],have=new Map((api?.crm_attribution?.coverage||[]).map(r=>[r.brand+'|'+date(r.day),r.checked_at]));
  let expected=0,covered=0,oldest='',latest='';
  for(let d=a;d<=z;d=new Date(Date.parse(d+'T12:00:00Z')+864e5).toISOString().slice(0,10))for(const brand of bs){expected++;const t=have.get(brand+'|'+d);if(t){covered++;if(!oldest||t<oldest)oldest=t;if(t>latest)latest=t;}}
  const q=(api?.crm_attribution?.quality||[]).filter(r=>selected(r,b,a,z));
  const qualitySum=k=>q.length&&q.every(r=>Number.isFinite(r[k])&&r[k]>=0)?q.reduce((s,r)=>s+r[k],0):null;
  return {lastVisitKnown:qualitySum('pagos_com_ultima_sessao'),lastVisitMissing:qualitySum('pagos_sem_ultima_sessao'),nonDirectMissing:qualitySum('pagos_sem_origem_nao_direta'),expected,covered,complete:expected>0&&covered===expected,oldest,latest,read:q.reduce((s,r)=>s+num(r.pedidos_lidos),0),paid:q.reduce((s,r)=>s+num(r.pagos_elegiveis),0),pending:q.reduce((s,r)=>s+num(r.jornada_pendente),0),partial:q.reduce((s,r)=>s+num(r.jornada_parcial),0)};
 }
 function project(api,m=DEFAULT_MODEL){
  if(!valid(api))return api;
  if(!api._attribution_legacy)api._attribution_legacy={conv:api.crm_conversao||[],hourly:api.crm_intradia||[]};
  api._attribution_model=models[m]?m:DEFAULT_MODEL;
  // Unreconciled CRM aggregates are excluded for the reconciled brands, including
  // dates outside coverage. Organic and other brands retain their existing source.
  api.crm_conversao=api._attribution_legacy.conv.filter(r=>!brands.includes(r.marca)||!['email','whatsapp'].includes(r.canal)||r.utm_medium==='organico').concat(
   (api.crm_attribution.daily||[]).filter(r=>r.model===model(api)&&r.grain==='piece').map(r=>({marca:r.marca,dia:r.dia,canal:r.dimension[0],utm_medium:r.dimension[1],utm_campaign:r.dimension[2],utm_content:r.dimension[3],utm_term:r.dimension[4],utm_source:r.dimension[5],pedidos_ultimo:num(r.pedidos),receita_ultimo:num(r.receita),pedidos_assistido:num(r.assistidos),receita_assistida:num(r.receita_assistida),clientes_novos:num(r.novos),clientes_recorrentes:num(r.recorrentes),coletado_em:(api.crm_attribution.coverage||[]).find(c=>c.brand===r.marca&&date(c.day)===date(r.dia))?.checked_at||null})));
  api.crm_intradia=api._attribution_legacy.hourly.filter(r=>!brands.includes(r.marca)).concat((api.crm_attribution.hourly||[]).filter(r=>r.model===model(api)).map(r=>({...r,coletado_em:(api.crm_attribution.coverage||[]).find(c=>c.brand===r.marca&&date(c.day)===date(r.dia))?.checked_at||null})));
  return api;
 }
 function conversion(api,b,a,z,grain='peca',channel='todos'){
  const g=grain==='peca'?'piece':grain==='familia'?(channel==='todos'?'family':'family_channel'):(channel==='todos'?'campaign':'campaign_channel');
  const map=new Map();for(const r of rows(api,b,a,z,g,channel)){
   const d=r.dimension,k=JSON.stringify([r.marca,d]);let v=map.get(k);
   if(!v){v={marca:r.marca,canal:grain==='peca'?d[0]:'',campanha:grain==='peca'?d[2]:grain==='campanha'?d[0]:'',peca:grain==='peca'?[d[3],d[4]].filter(Boolean).join(' · '):'',familia:grain==='familia'?d[0]:'',canais:new Set(),pecas:new Set(),campanhas:new Set(),...sum([])};map.set(k,v);}
   const s=sum([r]);Object.keys(s).forEach(k=>v[k]+=s[k]);
   if(grain==='peca'){v.canais.add(d[0]);v.pecas.add(d.slice(2).join('|'));v.campanhas.add(d[2]);}
   else {
    // Metadata only; attribution totals always come from the deduplicated grain.
    for(const p of rows(api,r.marca,a,z,'piece',channel))if((grain==='campanha'?p.dimension[2]:family(api,r.marca,p.dimension[2]))===d[0]){v.canais.add(p.dimension[0]);v.pecas.add(p.dimension.slice(2).join('|'));v.campanhas.add(p.dimension[2]);}
   }
  }
  return [...map.values()].sort((a,b)=>b.receita-a.receita||b.receita_assist-a.receita_assist);
 }
 function family(api,brand,c){return (api.crm_familia_campanha||[]).find(r=>r.marca===brand&&norm(r.utm_campaign)===norm(c))?.familia||({'aristo-semana-cliente':'semana-do-cliente-2026','aristo-desodorante':'desodorante-frescor','desodorante-lancamento':'desodorante-frescor'}[norm(c)])||c||'(sem campanha)';}
 // Unique recipients per dispatch; missing tracking is not a measured zero.
 function engagement(m){
  const count=v=>(typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v))&&Number(v)>=0?Number(v):null;
  const delivered=count(m.entregues),opened=count(m.abriram),clicked=count(m.clicaram);
  const rate=(n,d)=>n!==null&&d!==null&&d>0?100*n/d:null;
  return {delivered,opened,clicked,opening:rate(opened,delivered),ctr:rate(clicked,delivered),ctor:rate(clicked,opened)};
 }
 const tuple=(brand,u)=>JSON.stringify([brand,norm(u.source),norm(u.medium),norm(u.campaign),norm(u.content),norm(u.term)]);
 function campaigns(api,b,a,z,channel='todos',search=''){
  const members=(api?.crm_attribution?.campaigns||[]).filter(r=>brands.includes(r.marca));
  const plannedClaimants=new Map();for(const m of members.filter(m=>num(m.enviados)>0||['scheduled','running'].includes(m.status)))for(const u of m.utms||[]){const k=tuple(m.marca,u);if(!plannedClaimants.has(k))plannedClaimants.set(k,new Set());plannedClaimants.get(k).add(m.campanha_id);}
  const claimants=new Map();for(const m of members.filter(m=>num(m.enviados)>0))for(const u of m.utms||[]){const k=tuple(m.marca,u);if(!claimants.has(k))claimants.set(k,new Set());claimants.get(k).add(m.campanha_id);}
  const map=new Map(),get=(brand,f)=>{const k=brand+'|'+f;if(!map.has(k))map.set(k,{marca:brand,familia:f,nome:names[f]||String(f).replace(/[-_]/g,' '),members:[],channels:[],...sum([])});return map.get(k);};
  for(const m of members)if((b==='todas'||m.marca===b)&&(channel==='todos'||m.canal===channel))get(m.marca,m.familia).members.push(m);
  for(const r of rows(api,b,a,z,channel==='todos'?'family':'family_channel',channel)){const v=get(r.marca,r.dimension[0]),s=sum([r]);Object.keys(s).forEach(k=>v[k]+=s[k]);}
  for(const r of rows(api,b,a,z,'family_channel',channel)){
   const v=get(r.marca,r.dimension[0]);let c=v.channels.find(c=>c.canal===r.dimension[1]);if(!c){c={canal:r.dimension[1],...sum([])};v.channels.push(c);}const s=sum([r]);Object.keys(s).forEach(k=>c[k]+=s[k]);
  }
  const pieces=rows(api,b,a,z,'piece',channel);
  const commercial=new Set(members.map(m=>m.marca+'|'+m.familia));for(const r of pieces)if(r.dimension[1]==='campanha')commercial.add(r.marca+'|'+family(api,r.marca,r.dimension[2]));
  for(const v of map.values()){
   const evidence=api.crm_attribution.dispatch_evidence,hasEvidence=evidence!==undefined,verified=evidence?.schema_version===1&&Array.isArray(evidence.daily);
   v.members=v.members.map(m=>{
    const tuples=new Set((m.utms||[]).map(u=>tuple(m.marca,u)));
    const matches=pieces.filter(r=>tuples.has(tuple(r.marca,{source:r.dimension[5],medium:r.dimension[1],campaign:r.dimension[2],content:r.dimension[3],term:r.dimension[4]})));
    const shared=[...tuples].some(k=>(claimants.get(k)?.size||0)>1),tracked=tuples.size>0,sent=num(m.enviados)>0;
    const exclusive=[...tuples].filter(k=>(claimants.get(k)?.size||0)===1);const uniqueMatches=matches.filter(r=>exclusive.includes(tuple(r.marca,{source:r.dimension[5],medium:r.dimension[1],campaign:r.dimension[2],content:r.dimension[3],term:r.dimension[4]})));
    const verifiedRows=verified?(evidence.daily||[]).filter(r=>r.model===model(api)&&r.marca===m.marca&&String(r.campanha_id)===String(m.campanha_id)&&inPeriod(r.dia,a,z)):[];
    const verifiedResult=verified&&sent&&tracked&&Number.isFinite(Date.parse(m.enviado_em))&&(!shared||verifiedRows.length)?sum(verifiedRows):null;
    return {...m,tracking_state:!tracked?'missing':[...tuples].some(k=>(plannedClaimants.get(k)?.size||0)>1)?'shared':'exclusive',in_period:sent&&inPeriod(day(m.enviado_em),a,z),future:!sent,shared,tracked,evidence_verified:verified,result:hasEvidence?(verified?verifiedResult:null):sent&&tracked&&exclusive.length?sum(uniqueMatches):null};
   }).sort((x,y)=>Number(x.future)-Number(y.future)||String(y.enviado_em||y.agendado_em).localeCompare(String(x.enviado_em||x.agendado_em)));
   v.sent=v.members.filter(m=>m.in_period).reduce((s,m)=>s+num(m.enviados),0);
   v.scheduled=v.members.filter(m=>m.future&&['scheduled','running'].includes(m.status)).length;
   v.pieces=v.members.filter(m=>m.in_period).length;
   v.untracked=v.members.filter(m=>!m.future&&!m.tracked).length;
   v.shared=v.members.filter(m=>!m.future&&m.shared).length;
  }
  return [...map.values()].filter(v=>commercial.has(v.marca+'|'+v.familia)||names[v.familia]).filter(v=>v.pedidos||v.assist||v.members.some(m=>m.in_period||m.future&&inPeriod(day(m.agendado_em),a,z))).filter(v=>norm([v.nome,v.familia,...v.members.flatMap(m=>[m.nome,...m.segmentos||[]])].join(' ')).includes(norm(search)))
   .sort((a,b)=>(b.familia==='semana-do-cliente-2026')-(a.familia==='semana-do-cliente-2026')||b.receita-a.receita||b.sent-a.sent);
 }
 function install(G){const oldFlows=G.regua;G.regua=function(api,b,a,z,c='todos'){const list=oldFlows.call(G,api,b,a,z,c);if(!valid(api))return list;return list.map(r=>{if(!brands.includes(r.marca))return r;const covered=coverage(api,r.marca,a,z).complete;const v=sum(rows(api,r.marca,a,z,'flow_piece',r.canal).filter(x=>x.dimension[1]===r.marca+'-'+r.flow&&x.dimension[2]===r.piece));return {...r,pedidos:covered?v.pedidos:null,receita:covered?v.receita:null,assist:covered?v.assist:null,receita_assist:covered?v.receita_assist:null,porMil:covered&&r.enviados?1000*v.pedidos/r.enviados:null};});};const old=G.conversao;G.conversao=function(api,b,a,z,g,c){if(valid(api)&&supported(b))return conversion(api,b,a,z,g,c);return old.call(G,api,b,a,z,g,c);};}
 let search='',opened=new Set();
 function render(ctx){
  const {api,marca:b,ini:a,fim:z,canal:channel='todos',GUI:U,onModel}=ctx;
  const root=document.querySelector('#attribution-campaigns'),bar=document.querySelector('#attribution-status');if(!root||!bar)return;
  const previousState=GT.captura(root),previousStatus=GT.captura(bar);const e=U.esc,n=U.nf,money=v=>v===null||v===undefined?'—':Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}),ok=valid(api)&&supported(b);
  if(!ok){bar.innerHTML='<p>Atribuição por pedido ainda não disponível para este recorte. Valores da fonte anterior não foram reconciliados.</p>';root.innerHTML='';return;}
  const reconciliation=(api.crm_attribution.reconciliation||[]).filter(r=>r.model===model(api)&&selected(r,b,a,z));
  const reconciled=k=>reconciliation.reduce((s,r)=>s+num(r[k]),0);
  const cov=coverage(api,b,a,z);api._attribution_missing=!cov.covered;const label=models[model(api)],rr=rows(api,b,a,z,channel==='todos'?'total':'channel',channel),total=sum(rr);
  bar.innerHTML=`<div class="ga-model"><label>Modelo de atribuição<select id="attribution-model"><option value="last_click" ${model(api)==='last_click'?'selected':''}>Último clique · padrão · 30 dias</option><option value="last_non_direct" ${model(api)==='last_non_direct'?'selected':''}>Último clique não direto · comparação</option></select></label><div><strong class="ga-coverage ${cov.complete?'is-complete':'is-partial'}">${cov.complete?'Período conciliado':'Cobertura parcial'}</strong><span>${n(cov.covered)} de ${n(cov.expected)} dias × marca · ${n(cov.read)} pedidos lidos · ${n(cov.paid)} pagos elegíveis</span></div></div>
   <div class="ga-status-labels"><span title="Receita líquida recebida, descontados reembolsos; data da compra em Brasília.">Receita líquida · compra em Brasília</span><span title="Periodicidade prevista para o cálculo; confira abaixo os horários disponíveis nesta consulta.">Atualização prevista: 5 min</span>${b==='todas'?'<span>Aristocrata · Fishermans · Olivas do Campo</span>':''}</div>
   ${cov.pending||cov.partial||!cov.complete?`<p class="ga-status-warning">${!cov.complete?'Total parcial: dias sem conciliação ficam fora dos resultados. ':''}${cov.pending?`${n(cov.pending)} pedido(s) com jornada pendente. `:''}${cov.partial?`${n(cov.partial)} jornada(s) parcial(is); assistências podem estar incompletas.`:''}</p>`:''}
   <div class="ga-freshness"><span><b>Leitura mais recente:</b> ${e(U.timestamp(cov.latest))}</span><span><b>Atribuição calculada:</b> ${e(U.timestamp(api.crm_attribution.generated_at))}</span>${api.crm_attribution.dispatch_evidence?`<span><b>Vínculos por disparo:</b> ${e(U.timestamp(api.crm_attribution.dispatch_evidence.checked_at))}</span>`:''}<span>Horários de Brasília</span></div>
   <details class="ga-method ga-tracking-quality" data-gt-key="attribution-tracking"><summary>${cov.lastVisitMissing===null?'Rastreamento · última sessão não informada':`Rastreamento · ${n(cov.lastVisitMissing)} pedido(s) sem última sessão`}</summary><p>${cov.lastVisitMissing===null?'Qualidade da última sessão: não informada nesta consulta.':`${n(cov.lastVisitKnown)} de ${n(cov.paid)} pedidos pagos têm última sessão registrada. ${n(cov.lastVisitMissing)} sem essa sessão ficam fora do crédito de último clique.`} ${reconciliation.length?`${n(reconciled('credito_crm'))} pagos com crédito CRM · ${n(reconciled('direto_outros'))} diretos/outros canais · ${n(reconciled('origem_desconhecida'))} sem origem definida. `:''}Cobertura de leitura não garante rastreamento completo.</p><p>PIX copiado no WhatsApp é medido separadamente como pagamento posterior; não comprova clique nem venda adicional causada pela mensagem.</p></details>`;
  bar.querySelector('select').onchange=ev=>onModel(ev.target.value);GT.restaura(bar,previousStatus);
  root.innerHTML=`<div class="painel-cab"><div><span class="ga-eyebrow">PERFORMANCE DE CRM</span><h2>Campanhas, de ponta a ponta</h2><p class="ga-subtitle">Cada iniciativa reúne seus canais, disparos e segmentos.</p></div><button type="button" class="refresh-btn" id="attribution-export">Exportar CSV <span aria-hidden="true">↗</span></button></div><div class="ga-summary">${U.stat('Receita atribuída ao CRM',money(cov.covered?total.receita:null),'ga-primary')}${U.stat('Pedidos com crédito final',n(cov.covered?total.pedidos:null))}${U.stat('Pedidos assistidos¹',n(cov.covered?total.assist:null))}</div><div class="ga-context"><span>${e(U.period(a,z))} <span aria-hidden="true">/</span> ${e(label)}</span><details class="ga-method"><summary>Como ler os números</summary><p>Último clique considera a última sessão registrada pela Shopify antes do pedido. Se essa sessão for direta ou de outro canal, o e-mail não recebe crédito final. Uma abertura ou clique sem pedido pago não gera receita. Totais de CRM incluem campanhas e automações, inclusive cliques históricos da Reportana. Receita pela data da compra; envios pela data do disparo. Uma compra recebe um crédito final. ¹ Assistidos são pedidos sem crédito final no recorte selecionado. Assistências entre campanhas podem se sobrepor e não devem ser somadas à receita atribuída.</p></details></div><div class="gt-toolbar"><label class="gt-busca"><span>Buscar campanha ou segmento</span><input id="attribution-search" type="search" placeholder="Buscar campanha ou segmento…" value="${e(search)}"></label><span class="mini" id="attribution-count" aria-live="polite"></span></div><div id="attribution-list"></div>`;
  const brandName=v=>v==='aristo'?'O Aristocrata':v==='fish'?'Fishermans':v==='olivas'?'Olivas do Campo':v;
  const shortName=v=>String(v||'').replace(/\s*\[CLAUDE\]\s*/gi,'').replace(/^(?:ARISTO(?:CRATA)?(?: SEMANA)?|FISH(?:ERMANS)?)\s*[—–]\s*/i,'').replace(/\s*\((?:seg|ter|qua|qui|sex|sáb|sab|dom)\b[^)]*\)/gi,'').trim();
  function memberRow(m){
   const metrics=engagement(m);
   const percent=(value,numerator,denominator)=>m.future?'—':value===null?`<span class="mini">${numerator===null||denominator===null?'Não medido':'Sem base'}</span>`:value.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})+'%';
   const detail=(value,label)=>m.future?'':`<div class="mini ga-metric-detail">${value===null?'Não medido':n(value)+' '+label}</div>`;
   const state=m.future?(m.status==='running'?'Preparando envio':m.status==='scheduled'?'Agendado':'Sem envio'):m.status==='running'?'Em envio':'Enviado';
   const value=m.future?'—':!cov.covered?'Sem cobertura':!m.tracked?'Sem UTM':m.shared&&!m.result?'Compartilhada':money(m.result?.receita);
   return `<tr><td data-label="Disparo / segmento"><strong class="ga-send-name">${e(shortName(m.nome))}</strong><div class="ga-segments">${(m.segmentos||[]).map(v=>`<span>${e(shortName(v))}</span>`).join('')||'<span>Segmento não informado</span>'}</div>${m.emissor!==m.marca?`<span class="ga-cross">Base ${e(brandName(m.emissor))} → ${e(brandName(m.marca))}</span>`:''}<details class="ga-origin"><summary>Ver identificação · #${n(m.campanha_id)}</summary><p>${e(m.nome)}</p>${m.emissor!==m.marca?`<p>Base ${e(brandName(m.emissor))} → venda ${e(brandName(m.marca))}</p>`:''}</details>${!['fish','aristo'].includes(m.marca)?'':typeof GUT==='undefined'?'<span class="mini">UTMs registradas indisponíveis nesta consulta.</span>':GUT.render({rows:m.utms,label:'UTMs registradas',mode:'registered',evidence:'Links e histórico de cliques · consulta '+U.timestamp(api.crm_attribution.generated_at),empty:'UTMs não disponíveis nesta consulta.'})}<span class="ga-tracking ${e(m.tracking_state)}">${m.tracking_state==='missing'?'Sem rastreamento por disparo':m.tracking_state==='shared'?'Há links reutilizados entre disparos':'Links identificados exclusivos deste disparo'}</span></td><td data-label="Situação"><span class="ga-state ${m.future?'is-scheduled':m.status==='running'?'is-running':'is-sent'}">${state}</span><div class="mini ga-time">${e(U.timestamp(m.enviado_em||m.agendado_em))}${!m.in_period&&!m.future?'<br>Fora do período':''}</div></td><td class="num" data-label="Enviados">${m.future?'—':n(m.enviados)}${detail(metrics.delivered,'entregues')}</td><td class="num ga-engagement" data-label="Abertura" title="Pessoas que abriram ÷ e-mails entregues"><strong>${percent(metrics.opening,metrics.opened,metrics.delivered)}</strong>${detail(metrics.opened,'abriram')}</td><td class="num ga-engagement" data-label="CTR · cliques" title="Pessoas que clicaram ÷ e-mails entregues"><strong>${percent(metrics.ctr,metrics.clicked,metrics.delivered)}</strong>${detail(metrics.clicked,'clicaram')}</td><td class="num ga-engagement" data-label="CTOR" title="Pessoas que clicaram ÷ pessoas que abriram"><strong>${percent(metrics.ctor,metrics.clicked,metrics.opened)}</strong></td><td class="num ga-send-revenue" data-label="Receita atribuída"><strong>${value}</strong>${m.result?`<div class="mini">${n(m.result.pedidos)} pedidos identificados${m.evidence_verified?'<br>Visita posterior ao início do disparo':''}${m.shared?'<br>+ vínculos não exclusivos ficam na iniciativa':''}</div>`:''}</td></tr>`;
  }

  function draw(){
   const list=campaigns(api,b,a,z,channel,search);root.querySelector('#attribution-list').innerHTML=list.length?list.map(v=>{
    const key=v.marca+'|'+v.familia;
    return `<details class="ga-campaign" data-key="${e(key)}" ${opened.has(key)?'open':''}><summary><span class="ga-chevron" aria-hidden="true"></span><div class="ga-identity"><span class="ga-brand">${e(brandName(v.marca))}</span><strong>${e(v.nome)}</strong><span class="ga-campaign-meta">${n(v.pieces)} disparo${v.pieces===1?'':'s'} <span aria-hidden="true">·</span> ${n(v.sent)} e-mails enviados${v.scheduled?` <span class="ga-state is-scheduled">${n(v.scheduled)} agendado${v.scheduled===1?'':'s'}</span>`:''}</span></div><div class="ga-amount"><span>Receita atribuída</span><strong>${money(cov.covered?v.receita:null)}</strong><span>${n(cov.covered?v.pedidos:null)} pedidos com crédito final</span></div></summary><div class="ga-details"><div class="ga-breakdown"><div class="ga-channels">${v.channels.map(c=>`<div class="ga-channel ${e(c.canal)}"><span class="ga-channel-name">${c.canal==='email'?'E-mail':'WhatsApp'}</span><strong>${money(c.receita)}</strong><span>${n(c.pedidos)} pedidos <span aria-hidden="true">·</span> ${n(c.assist)} assistências</span></div>`).join('')||(cov.covered?'<p>Nenhuma compra atribuída aos canais no período conciliado.</p>':'<p>Aguardando conciliação dos pedidos deste período.</p>')}</div><div class="ga-assists"><strong>${n(cov.covered?v.assist:null)}</strong><span>pedidos assistidos<br> sem crédito final nesta iniciativa</span></div></div><div class="ga-table-heading"><h3>Disparos e segmentos</h3><span class="mini">E-mail · compras no período selecionado</span></div><div class="rolagem"><table class="comparativo"><thead><tr><th scope="col">Disparo / segmento</th><th scope="col">Situação</th><th scope="col" class="num">Enviados</th><th scope="col" class="num">Abertura</th><th scope="col" class="num">CTR · cliques</th><th scope="col" class="num">CTOR</th><th scope="col" class="num">Receita atribuída</th></tr></thead><tbody>${v.members.map(memberRow).join('')||'<tr><td colspan="7">Conversão identificada na jornada. Disparo comercial ainda sem vínculo cadastrado.</td></tr>'}</tbody></table></div><div class="ga-mapping-note">${v.untracked?`<span>${n(v.untracked)} disparo(s) sem UTM: receita por disparo não identificável.</span>`:''}${v.shared?`<span>${n(v.shared)} disparo(s) com links compartilhados. Essa parcela da receita fica na iniciativa.</span>`:''}<span>${n(Math.max(0,v.pedidos-v.members.reduce((s,m)=>s+(m.result?.pedidos||0),0)))} pedido(s) sem vínculo exclusivo com os disparos acima.</span></div><details class="ga-method ga-campaign-method"><summary>Rastreamento e regras de leitura</summary><p>WhatsApp aparece na abertura por canal. Envios e engajamento são acumulados por disparo. Abertura = pessoas que abriram ÷ entregues; CTR = pessoas que clicaram ÷ entregues; CTOR = pessoas que clicaram ÷ pessoas que abriram. Contagens de abertura e clique são únicas dentro de cada disparo, não entre disparos. Aberturas registradas podem incluir carregamentos automáticos do provedor de e-mail. “Não medido” indica dado ausente; “Sem base”, denominador zero. Receita e pedidos respeitam o período e o modelo selecionados. Agendados ficam fora das métricas. O crédito por disparo exige correspondência das cinco UTMs e visita posterior ao início do envio. Se mais de um disparo anterior usar o mesmo link, a receita permanece sem divisão por segmento. Isso comprova o vínculo temporal do link, não que a pessoa recebeu aquele disparo nem o efeito incremental da mensagem. Referência: ${e(v.familia)}.</p></details></div></details>`;
   }).join(''):`<div class="vazio">${search.trim()?`Nenhuma campanha ou segmento contém “${e(search.trim())}”. <button type="button" class="refresh-btn gt-limpar" id="attribution-clear">Limpar busca</button>`:'Nenhuma campanha com envio ou atribuição neste recorte. Confira a marca, o canal e o período selecionados.'}</div>`;
   root.querySelector('#attribution-count').textContent=`${n(list.length)} iniciativa${list.length===1?'':'s'}${list.length?' · abra para explorar':''}`;
   root.querySelector('#attribution-clear')?.addEventListener('click',()=>{search='';const input=root.querySelector('#attribution-search');input.value='';draw();input.focus();});
   root.querySelectorAll('details[data-key]').forEach(el=>el.addEventListener('toggle',()=>{if(el.open)opened.add(el.dataset.key);else opened.delete(el.dataset.key);}));
   root.querySelector('#attribution-export').onclick=()=>{
    const records=list.map(v=>[v.nome,v.marca,a,z,label,cov.complete?'completa':'parcial',cov.covered?v.pedidos:null,cov.covered?v.receita:null,cov.covered?v.assist:null,cov.covered?v.receita_assist:null,v.sent,v.pieces]);
    const labels=['Campanha','Marca','Inicio compras','Fim compras','Modelo','Cobertura','Pedidos','Receita BRL','Assistidos','Receita assistida BRL','Emails enviados no periodo','Disparos no periodo'];
    const csv=GT.csv(labels.map((rotulo,chave)=>({chave,rotulo})),records,{recorte_canal:channel,consulta_em:api.crm_attribution.generated_at});
    GT.baixar(GT.nomeArquivo('campanhas',{recorte_marca:b==='todas'?'Todas as marcas':brandName(b),recorte_canal:channel==='email'?'E-mail':channel==='whatsapp'?'WhatsApp':'Todos os canais',periodo_inicio:a,periodo_fim:z}),csv);
   };
  }
  root.querySelector('#attribution-search').oninput=ev=>{search=ev.target.value;draw();};draw();GT.restaura(root,previousState);
 }
 return {DEFAULT_MODEL,models,valid,model,project,rows,sum,coverage,conversion,campaigns,engagement,install,render};
})();
if(typeof module!=='undefined')module.exports=GA;
