/* Growth attribution contract v2: order-deduplicated aggregates, explicit models. */
const GA=(()=>{
 const models={last_non_direct:'Último clique não direto',last_click:'Último clique'},brands=['aristo','fish'];
 const names={'semana-do-cliente-2026':'Semana do Cliente · 2026','desodorante-frescor':'Lançamento Desodorante Frescor','sabonete-alma-da-roca':'Lançamento Alma da Roça','fish-carta-fundador':'Carta do fundador'};
 const norm=v=>String(v??'').trim().toLowerCase(),num=v=>Number(v)||0,date=v=>String(v||'').slice(0,10);
 const inPeriod=(d,a,b)=>date(d)>=a&&date(d)<=b;
 const day=v=>v?new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(v)):'';
 const valid=api=>api?.crm_attribution?.schema_version===2;
 const model=api=>models[api?._attribution_model]?api._attribution_model:'last_non_direct';
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
  return {expected,covered,complete:expected>0&&covered===expected,oldest,latest,read:q.reduce((s,r)=>s+num(r.pedidos_lidos),0),paid:q.reduce((s,r)=>s+num(r.pagos_elegiveis),0),pending:q.reduce((s,r)=>s+num(r.jornada_pendente),0),partial:q.reduce((s,r)=>s+num(r.jornada_parcial),0)};
 }
 function project(api,m='last_non_direct'){
  if(!valid(api))return api;
  if(!api._attribution_legacy)api._attribution_legacy={conv:api.crm_conversao||[],hourly:api.crm_intradia||[]};
  api._attribution_model=models[m]?m:'last_non_direct';
  // Unreconciled CRM aggregates are excluded for the two audited brands, including
  // dates outside coverage. Organic and other brands retain their existing source.
  api.crm_conversao=api._attribution_legacy.conv.filter(r=>!brands.includes(r.marca)||!['email','whatsapp'].includes(r.canal)||r.utm_medium==='organico').concat(
   (api.crm_attribution.daily||[]).filter(r=>r.model===model(api)&&r.grain==='piece').map(r=>({marca:r.marca,dia:r.dia,canal:r.dimension[0],utm_medium:r.dimension[1],utm_campaign:r.dimension[2],utm_content:r.dimension[3],utm_term:r.dimension[4],utm_source:r.dimension[5],pedidos_ultimo:num(r.pedidos),receita_ultimo:num(r.receita),pedidos_assistido:num(r.assistidos),receita_assistida:num(r.receita_assistida),clientes_novos:num(r.novos),clientes_recorrentes:num(r.recorrentes),coletado_em:(api.crm_attribution.coverage||[]).find(c=>c.brand===r.marca&&date(c.day)===date(r.dia))?.checked_at||null})));
  api.crm_intradia=api._attribution_legacy.hourly.filter(r=>!brands.includes(r.marca)).concat((api.crm_attribution.hourly||[]).filter(r=>r.model===model(api)));
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
 const tuple=(brand,u)=>JSON.stringify([brand,norm(u.source),norm(u.medium),norm(u.campaign),norm(u.content),norm(u.term)]);
 function campaigns(api,b,a,z,channel='todos',search=''){
  const members=(api?.crm_attribution?.campaigns||[]).filter(r=>brands.includes(r.marca));
  const claimants=new Map();for(const m of members.filter(m=>num(m.enviados)>0))for(const u of m.utms||[]){const k=tuple(m.marca,u);if(!claimants.has(k))claimants.set(k,new Set());claimants.get(k).add(m.campanha_id);}
  const map=new Map(),get=(brand,f)=>{const k=brand+'|'+f;if(!map.has(k))map.set(k,{marca:brand,familia:f,nome:names[f]||String(f).replace(/[-_]/g,' '),members:[],channels:[],...sum([])});return map.get(k);};
  for(const m of members)if((b==='todas'||m.marca===b)&&(channel==='todos'||m.canal===channel))get(m.marca,m.familia).members.push(m);
  for(const r of rows(api,b,a,z,channel==='todos'?'family':'family_channel',channel)){const v=get(r.marca,r.dimension[0]),s=sum([r]);Object.keys(s).forEach(k=>v[k]+=s[k]);}
  for(const r of rows(api,b,a,z,'family_channel',channel)){
   const v=get(r.marca,r.dimension[0]);let c=v.channels.find(c=>c.canal===r.dimension[1]);if(!c){c={canal:r.dimension[1],...sum([])};v.channels.push(c);}const s=sum([r]);Object.keys(s).forEach(k=>c[k]+=s[k]);
  }
  const pieces=rows(api,b,a,z,'piece',channel);
  for(const v of map.values()){
   v.members=v.members.map(m=>{
    const tuples=new Set((m.utms||[]).map(u=>tuple(m.marca,u)));
    const matches=pieces.filter(r=>tuples.has(tuple(r.marca,{source:r.dimension[5],medium:r.dimension[1],campaign:r.dimension[2],content:r.dimension[3],term:r.dimension[4]})));
    const shared=[...tuples].some(k=>(claimants.get(k)?.size||0)>1),tracked=tuples.size>0,sent=num(m.enviados)>0;
    return {...m,in_period:sent&&inPeriod(day(m.enviado_em),a,z),future:!sent,shared,tracked,result:sent&&tracked&&!shared?sum(matches):null};
   }).sort((x,y)=>String(y.enviado_em||y.agendado_em).localeCompare(String(x.enviado_em||x.agendado_em)));
   v.sent=v.members.filter(m=>m.in_period).reduce((s,m)=>s+num(m.enviados),0);
   v.scheduled=v.members.filter(m=>m.future&&['scheduled','running'].includes(m.status)).length;
   v.pieces=v.members.filter(m=>m.in_period).length;
   v.untracked=v.members.filter(m=>!m.future&&!m.tracked).length;
   v.shared=v.members.filter(m=>!m.future&&m.shared).length;
  }
  return [...map.values()].filter(v=>v.pedidos||v.assist||v.members.some(m=>m.in_period||m.future&&inPeriod(day(m.agendado_em),a,z))).filter(v=>norm([v.nome,v.familia,...v.members.flatMap(m=>[m.nome,...m.segmentos||[]])].join(' ')).includes(norm(search)))
   .sort((a,b)=>(b.familia==='semana-do-cliente-2026')-(a.familia==='semana-do-cliente-2026')||b.receita-a.receita||b.sent-a.sent);
 }
 function install(G){const oldFlows=G.regua;G.regua=function(api,b,a,z,c='todos'){const list=oldFlows.call(G,api,b,a,z,c);if(!valid(api))return list;return list.map(r=>{if(!brands.includes(r.marca))return r;const covered=coverage(api,r.marca,a,z).complete;const v=sum(rows(api,r.marca,a,z,'flow_piece',r.canal).filter(x=>x.dimension[1]===r.marca+'-'+r.flow&&x.dimension[2]===r.piece));return {...r,pedidos:covered?v.pedidos:null,receita:covered?v.receita:null,assist:covered?v.assist:null,receita_assist:covered?v.receita_assist:null,porMil:covered&&r.enviados?1000*v.pedidos/r.enviados:null};});};const old=G.conversao;G.conversao=function(api,b,a,z,g,c){if(valid(api)&&supported(b))return conversion(api,b,a,z,g,c);return old.call(G,api,b,a,z,g,c);};}
 let search='',opened=new Set();
 function render(ctx){
  const {api,marca:b,ini:a,fim:z,canal:channel='todos',GUI:U,onModel}=ctx;
  const root=document.querySelector('#attribution-campaigns'),bar=document.querySelector('#attribution-status');if(!root||!bar)return;
  const e=U.esc,n=U.nf,money=U.rf,ok=valid(api)&&supported(b);
  if(!ok){bar.innerHTML='<p>Atribuição por pedido ainda não disponível para este recorte. Valores da fonte anterior não foram reconciliados.</p>';root.innerHTML='';return;}
  const cov=coverage(api,b,a,z);api._attribution_missing=!cov.covered;const label=models[model(api)],rr=rows(api,b,a,z,channel==='todos'?'total':'channel',channel),total=sum(rr);
  bar.innerHTML=`<div class="ga-model"><label>Modelo de atribuição<select id="attribution-model"><option value="last_non_direct" ${model(api)==='last_non_direct'?'selected':''}>Último clique não direto · 30 dias</option><option value="last_click" ${model(api)==='last_click'?'selected':''}>Último clique · 30 dias</option></select></label><div><strong>${cov.complete?'Período conciliado':'Cobertura parcial'}</strong><span>${n(cov.covered)} de ${n(cov.expected)} dias × marca · ${n(cov.read)} pedidos lidos · ${n(cov.paid)} pagos elegíveis</span></div></div><p>${e(label)} · receita líquida recebida, descontados reembolsos · data da compra em Brasília.${b==='todas'?' Atribuição conciliada: Aristocrata e Fishermans.':''} ${cov.pending?`${n(cov.pending)} pedido(s) com jornada pendente. `:''}${cov.partial?`${n(cov.partial)} jornada(s) parcial(is); assistências podem estar incompletas. `:''}${!cov.complete?'Dias sem conciliação ficam fora dos resultados; o total está parcial. ':''}Leitura mais recente: ${e(U.timestamp(cov.latest))}.</p>`;
  bar.querySelector('select').onchange=ev=>onModel(ev.target.value);
  root.innerHTML=`<div class="painel-cab"><div><span class="mini">CAMPANHAS COMERCIAIS</span><h2>Uma campanha, todos os contatos</h2></div><button type="button" class="refresh-btn" id="attribution-export">Exportar CSV</button></div><div class="ga-summary">${U.stat('Receita CRM no período',money(cov.covered?total.receita:null))}${U.stat('Pedidos com crédito final',n(cov.covered?total.pedidos:null))}${U.stat('Pedidos assistidos · sem crédito final neste recorte',n(cov.covered?total.assist:null))}</div><p class="nota">${e(U.period(a,z))} · ${e(label)}. Receita pela data da compra; envios pela data do disparo. Total CRM inclui campanhas e automações. Uma compra recebe um crédito final. Assistências entre campanhas podem se sobrepor e não devem ser somadas à receita atribuída.</p><div class="gt-toolbar"><label class="gt-busca">Buscar campanha ou segmento<input id="attribution-search" type="search" placeholder="Semana do Cliente, desodorante, mornos…" value="${e(search)}"></label><span class="mini">Agrupado por iniciativa · abrir para ver canais e bases</span></div><div id="attribution-list"></div>`;
  function draw(){
   const list=campaigns(api,b,a,z,channel,search);root.querySelector('#attribution-list').innerHTML=list.length?list.map(v=>{
    const key=v.marca+'|'+v.familia;
    return `<details class="ga-campaign" data-key="${e(key)}" ${opened.has(key)?'open':''}><summary><div><strong>${e(v.nome)}</strong><span>${e(v.marca==='aristo'?'O Aristocrata':'Fishermans')} · ${n(v.pieces)} disparos no período${v.scheduled?` · ${n(v.scheduled)} agendado(s)`:''}</span></div><div class="ga-amount"><strong>${money(cov.covered?v.receita:null)}</strong><span>${n(cov.covered?v.pedidos:null)} pedidos · ${n(v.sent)} e-mails enviados</span></div></summary><div class="ga-details"><div class="ga-channels">${v.channels.map(c=>`<div><span class="tag ${e(c.canal)}">${c.canal==='email'?'E-mail':'WhatsApp'}</span><strong>${money(c.receita)}</strong><span>${n(c.pedidos)} pedidos · ${n(c.assist)} assistências</span></div>`).join('')||(cov.covered?'<p>Nenhuma compra atribuída aos canais no período conciliado.</p>':'<p>Aguardando conciliação dos pedidos deste período.</p>')}</div><p class="mini">${n(cov.covered?v.assist:null)} pedidos assistidos pela iniciativa, sem crédito final nela.${v.untracked?` ${n(v.untracked)} disparo(s) sem UTM: volume disponível, receita por disparo não identificável.`:''}${v.shared?` ${n(v.shared)} disparo(s) compartilham rastreamento: receita permanece no total da iniciativa.`:''}</p><div class="rolagem"><table class="comparativo"><thead><tr><th>Disparo / base</th><th>Situação</th><th class="num">Enviados</th><th class="num">Clicaram</th><th class="num">Receita no período</th></tr></thead><tbody>${v.members.map(m=>`<tr><td><strong>${e(m.nome)}</strong><div class="mini">#${n(m.campanha_id)} · ${e((m.segmentos||[]).join(' · ')||'Segmento não informado')}</div>${m.emissor!==m.marca?`<div class="mini">Base ${e(m.emissor)} → venda ${e(m.marca)}</div>`:''}</td><td><span class="mini">${m.future?'Agendado':m.status==='running'?'Em envio':'Enviado'}<br>${e(U.timestamp(m.enviado_em||m.agendado_em))}${!m.in_period&&!m.future?'<br>Envio fora do período':''}</span></td><td class="num">${m.future?'—':n(m.enviados)}</td><td class="num">${m.future?'—':n(m.clicaram)}</td><td class="num">${m.future?'—':!cov.covered?'Sem cobertura':!m.tracked?'Sem UTM':m.shared?'Compartilhada':money(m.result?.receita)}${m.result?`<div class="mini">${n(m.result.pedidos)} pedidos</div>`:''}</td></tr>`).join('')||'<tr><td colspan="5">Conversão identificada na jornada. Disparo comercial ainda sem vínculo cadastrado.</td></tr>'}</tbody></table></div><p class="mini">Envios e cliques são acumulados por disparo; não são pessoas únicas da iniciativa. Agendados ficam fora das métricas. Links reutilizados entre bases não permitem dividir a receita por segmento. Referência: ${e(v.familia)}.</p></div></details>`;
   }).join(''):'<div class="vazio">Nenhuma campanha com envio ou atribuição neste recorte.</div>';
   root.querySelectorAll('details[data-key]').forEach(el=>el.addEventListener('toggle',()=>{if(el.open)opened.add(el.dataset.key);else opened.delete(el.dataset.key);}));
   root.querySelector('#attribution-export').onclick=()=>{
    const records=list.map(v=>[v.nome,v.marca,a,z,label,cov.complete?'completa':'parcial',v.pedidos,v.receita,v.assist,v.receita_assist,v.sent,v.pieces]);
    const cell=x=>'"'+String(x??'').replace(/"/g,'""').replace(/^[=+@-]/,x=>"'"+x)+'"';
    const csv='\uFEFF'+[['Campanha','Marca','Inicio compras','Fim compras','Modelo','Cobertura','Pedidos','Receita BRL','Assistidos','Receita assistida BRL','Emails enviados no periodo','Disparos no periodo'],...records].map(r=>r.map(cell).join(';')).join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`campanhas-${a}-${z}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
   };
  }
  root.querySelector('#attribution-search').oninput=ev=>{search=ev.target.value;draw();};draw();
 }
 return {models,valid,model,project,rows,sum,coverage,conversion,campaigns,install,render};
})();
if(typeof module!=='undefined')module.exports=GA;
