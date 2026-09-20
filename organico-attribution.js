/* Receita Shopify por pedido/modelo. Apenas leitura; nenhuma chamada de coleta ou envio. */
const OA=(()=>{
 'use strict';
 const DEFAULT_MODEL='last_click',MODELS={last_click:'Último clique estrito',last_non_direct:'Último clique não direto'};
 const BRANDS={aristo:'Aristocrata',fish:'Fishermans',olivas:'Olivas'};
 const GROUPS={
  editorial:{name:'Editorial orgânico',note:'Combinação de UTM reconhecida pela regra vigente.'},
  bio:{name:'Bio / Linktree',note:'Superfície compartilhada; pode haver mídia paga antes da visita.'},
  automacao_dm:{name:'Automação DM',note:'Link recebido por automação de mensagem direta.'},
  legado_ambiguo:{name:'Social legado ambíguo',note:'A UTM disponível não separa orgânico de mídia paga.'},
  midia_paga:{name:'Mídia paga',note:'Contexto de conciliação; fora da receita orgânica.'},
  crm:{name:'CRM',note:'Contexto de conciliação; o mesmo crédito pode aparecer no Growth.'},
  nao_classificado:{name:'Sem classificação de canal',note:'O pedido conhecido não tem combinação reconhecida pela regra.'},
 };
 const REASONS={controle_utm_instagram_story:'Padrão de story do controle de links',controle_utm_instagram_linktree:'Padrão de bio do controle de links',
  controle_utm_ou_alias_dm_documentado:'Automação DM documentada',social_legado_sem_distincao_paid:'Padrão social antigo, sem distinção de mídia paga',
  medium_ou_source_paid_explicito:'UTM declara mídia paga',canal_crm_do_ledger:'Canal CRM registrado na jornada',modelo_conhecido_sem_toque:'Modelo conhecido sem toque não direto',
  toque_sem_utm_de_canal:'Visita sem UTM de canal',combinacao_sem_regra_comprovada:'Combinação sem regra comprovada'};
 const keys=Object.keys(GROUPS),date=v=>String(v||'').slice(0,10);
 const brand=v=>({aristocrata:'aristo',fishermans:'fish'}[v]||v);
 const esc=v=>String(v??'').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
 const number=v=>(typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v))?Number(v):null;
 const count=v=>{const n=number(v);return n!==null&&Number.isInteger(n)&&n>=0?n:null;};
 const nf=n=>n===null?'indisponível':n.toLocaleString('pt-BR');
 const money=n=>n===null?'indisponível':n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
 const stamp=v=>Number.isFinite(Date.parse(v||''))?new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}).format(new Date(v)):'sem confirmação';
 const validDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'')&&Number.isFinite(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;
 const sum=(rows,field,parse=number)=>rows.length&&rows.every(r=>parse(r[field])!==null)?rows.reduce((s,r)=>s+parse(r[field]),0):null;
 function valid(api){const p=api?.organico_attribution;return p?.schema_version===1&&p.window_days===30&&p.source_system==='shopify'&&p.currency==='BRL'&&Array.isArray(p.daily)&&Array.isArray(p.quality)&&Array.isArray(p.coverage);}
 function select(api,marca,ini,fim,model=DEFAULT_MODEL){
  const b=brand(marca),bs=['todas','todos'].includes(b)?Object.keys(BRANDS):BRANDS[b]?[b]:[];
  if(!valid(api))return {available:false,reason:'payload'};
  if(!bs.length||!validDate(ini)||!validDate(fim)||ini>fim)return {available:false,reason:'filter'};
  const m=MODELS[model]?model:DEFAULT_MODEL,p=api.organico_attribution;
  const accepts=r=>bs.includes(brand(r.marca))&&date(r.dia)>=ini&&date(r.dia)<=fim;
  const rows=p.daily.filter(r=>r.model===m&&accepts(r)),quality=p.quality.filter(accepts);
  const days=Math.round((Date.parse(fim+'T12:00:00Z')-Date.parse(ini+'T12:00:00Z'))/864e5)+1;
  const coverage=bs.map(b=>{
   const byDay=new Map();
   for(const c of p.coverage.filter(r=>brand(r.marca)===b&&date(r.dia)>=ini&&date(r.dia)<=fim)){
    if(!Number.isFinite(Date.parse(c.checked_at||'')))continue;
    const d=date(c.dia),old=byDay.get(d);
    if(!old||Date.parse(c.checked_at)>Date.parse(old))byDay.set(d,c.checked_at);
   }
   const times=[...byDay.values()].sort((a,z)=>Date.parse(a)-Date.parse(z)),q=quality.filter(r=>brand(r.marca)===b);
   return {marca:b,covered:byDay.size,expected:days,complete:byDay.size===days,
    oldest:times[0]||null,latest:times.at(-1)||null,read:sum(q,'pedidos_lidos',count),paid:sum(q,'pagos_elegiveis',count),
    known:sum(q,'ultima_sessao_conhecida',count),unknown:sum(q,m==='last_click'?'ultima_sessao_desconhecida':'origem_nao_direta_desconhecida',count),
    pending:sum(q,'jornada_pendente',count),partial:sum(q,'jornada_parcial',count)};
  });
  const complete=coverage.every(r=>r.complete);
  const malformed=rows.some(r=>!GROUPS[r.classification]||count(r.pedidos)===null||number(r.receita_liquida)===null);
  const groups=keys.map(k=>{const rr=rows.filter(r=>r.classification===k);
   return {key:k,...GROUPS[k],rows:rr,pedidos:rr.length?sum(rr,'pedidos',count):complete&&!malformed?0:null,
    receita:rr.length?sum(rr,'receita_liquida'):complete&&!malformed?0:null};});
  return {available:true,model:m,ini,fim,brands:bs,rows,detailRows:rows.filter(r=>r.detail_level==='utm'),quality,coverage,complete,malformed,groups,
   rule:p.rule_version||null,assistanceAvailable:p.assistance_available===true,rawAvailable:p.utm_raw_available===true};
 }
 function tableGroups(v,kk){
  return `<div class="rolagem" tabindex="0" role="region" aria-label="Tabela de atribuição; use as setas para rolar"><table class="comparativo"><thead><tr><th>Origem classificada</th><th class="num">Pedidos</th><th class="num">Receita líquida</th><th>Como ler</th></tr></thead><tbody>${v.groups.filter(g=>kk.includes(g.key)).map(g=>`<tr data-org-group="${g.key}"><td><strong>${esc(g.name)}</strong></td><td class="num tabn">${nf(g.pedidos)}</td><td class="num tabn">${money(g.receita)}</td><td class="mini">${esc(g.note)}</td></tr>`).join('')}</tbody></table></div>`;
 }
 function markup(v){
  const title='<div class="painel-cab"><h2>Conversões por UTM · Shopify</h2><span class="mini">Receita líquida · por pedido</span></div>';
  if(!v.available)return title+`<div class="nota" role="status">${v.reason==='filter'?'Marca ou período inválido para esta leitura.':'A atribuição por pedido está indisponível nesta consulta. Os dados históricos abaixo usam outra projeção e não substituem esta leitura.'}</div>`;
  return title+`<div class="seg-mini" role="group" aria-label="Modelo de atribuição"><button type="button" data-org-model="last_click" class="${v.model==='last_click'?'ativo':''}" aria-pressed="${v.model==='last_click'}">Último clique · 30 dias</button><button type="button" data-org-model="last_non_direct" class="${v.model==='last_non_direct'?'ativo':''}" aria-pressed="${v.model==='last_non_direct'}">Não direto · comparação</button></div>
   <div class="nota"><strong>${esc(MODELS[v.model])} · janela de 30 dias.</strong> Compra pela data de Brasília. Pedidos pagos elegíveis em reais, sem testes/cancelamentos, com valor líquido de reembolsos. O crédito é exclusivo por pedido e modelo; os dois modelos não se somam. Atribuição não comprova venda causada pelo conteúdo.</div>
   ${!v.complete?'<div class="nota" role="status"><strong>Cobertura parcial no período.</strong> Os valores existentes são parciais; grupos sem dados ficam indisponíveis. Confira os dias cobertos por marca.</div>':''}
   ${v.malformed?'<div class="nota" role="status"><strong>Há linhas com valor ou classificação inválida.</strong> A conciliação está incompleta nesta leitura.</div>':''}
   ${tableGroups(v,['editorial','bio','automacao_dm','legado_ambiguo'])}
   <div class="nota">“Zero” significa nenhum vencedor nessa categoria entre os pedidos conhecidos e dias cobertos. Pedidos com origem desconhecida continuam separados abaixo. Bio não identifica um post; campanha ou data no link não comprova qual peça levou à compra.</div>
   <details><summary>Outros canais para conciliação</summary>${tableGroups(v,['midia_paga','crm','nao_classificado'])}<div class="nota">Estes canais são resumos por dia, marca e modelo; suas UTMs individuais não são carregadas neste painel. CRM pode aparecer também no Growth. Cupom de influenciador e assistência são perspectivas distintas. Venda nativa do TikTok Shop vem de outra fonte. Não somar novamente essas receitas entre abas.</div></details>
   <div class="rolagem" tabindex="0" role="region" aria-label="Tabela de atribuição; use as setas para rolar"><table class="comparativo"><thead><tr><th>Marca</th><th>Dias cobertos</th><th class="num">Pedidos elegíveis</th><th class="num">Origem desconhecida¹</th><th class="num">Jornada pendente / parcial</th><th>Coleta dos dias cobertos</th></tr></thead><tbody>${v.coverage.map(c=>`<tr><td>${esc(BRANDS[c.marca])}</td><td>${nf(c.covered)} de ${nf(c.expected)}</td><td class="num tabn">${nf(c.paid)}</td><td class="num tabn">${nf(c.unknown)}</td><td class="num tabn">${nf(c.pending)} / ${nf(c.partial)}</td><td class="mini">Mais antiga: ${esc(stamp(c.oldest))}<br>Mais recente: ${esc(stamp(c.latest))}</td></tr>`).join('')}</tbody></table></div>
   <div class="nota">¹ ${v.model==='last_click'?'Última sessão não confirmada':'Última origem não direta não confirmada'}: esses pedidos não recebem crédito neste modelo. Horário da coleta não é horário da compra ou da abertura desta página. ${!v.assistanceAvailable?'Assistências de Orgânico ainda não estão disponíveis nesta fonte.':''}</div>
   <details><summary>Conferir UTMs e regra de classificação</summary><div class="nota">Regra: ${esc(v.rule||'versão não informada')}. ${v.rawAvailable?'Valores fornecidos pela fonte.':'UTMs registradas no ledger, já normalizadas pelo coletor; não são uma cópia do texto original do link.'} Sem vínculo comprovado com post/story, a peça permanece desconhecida.</div>
    <div class="rolagem" tabindex="0" role="region" aria-label="Tabela de atribuição; use as setas para rolar"><table class="comparativo"><thead><tr><th>Marca / compra</th><th>Classificação</th><th>Rede / superfície</th><th>UTMs registradas</th><th class="num">Pedidos</th><th class="num">Receita líquida</th></tr></thead><tbody>${v.detailRows.length?v.detailRows.slice().sort((a,b)=>date(b.dia).localeCompare(date(a.dia))||brand(a.marca).localeCompare(brand(b.marca))).map(r=>`<tr><td>${esc(BRANDS[brand(r.marca)]||r.marca)}<div class="mini">${esc(date(r.dia))}</div></td><td>${esc(GROUPS[r.classification]?.name||'Classificação inválida')}<div class="mini">${esc(REASONS[r.rule_reason]||'Motivo não informado')}</div></td><td>${esc(r.rede||'não identificada')}<div class="mini">${esc(r.superficie||'superfície desconhecida')}</div></td><td class="mini org-utm-values">source: ${esc(r.utm_source||'não informado')}<br>medium: ${esc(r.utm_medium||'não informado')}<br>campaign: ${esc(r.utm_campaign||'não informada')}<br>content: ${esc(r.utm_content||'não informado')}<br>term: ${esc(r.utm_term||'não informado')}</td><td class="num tabn">${nf(count(r.pedidos))}</td><td class="num tabn">${money(number(r.receita_liquida))}</td></tr>`).join(''):`<tr><td colspan="6">${v.complete?'Nenhuma combinação UTM detalhada neste período e modelo. Confira os outros canais na conciliação.':'Sem linhas detalhadas disponíveis no recorte; cobertura incompleta.'}</td></tr>`}</tbody></table></div></details>`;
 }
 let activeModel=DEFAULT_MODEL;
 function render(el,api,marca,ini,fim,onModelChange){
  if(!el)return;
  el.innerHTML=markup(select(api,marca,ini,fim,activeModel));
  el.querySelectorAll('[data-org-model]').forEach(button=>{button.onclick=()=>{
   if(!MODELS[button.dataset.orgModel])return;
   activeModel=button.dataset.orgModel;render(el,api,marca,ini,fim,onModelChange);
   if(onModelChange)onModelChange(activeModel);
   el.querySelector(`[data-org-model="${activeModel}"]`)?.focus();
  };});
 }
 return {DEFAULT_MODEL,MODELS,GROUPS,valid,select,markup,render,getModel:()=>activeModel,setModel:model=>{if(MODELS[model])activeModel=model;}};
})();
if(typeof module!=='undefined')module.exports=OA;
