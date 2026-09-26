/* Influs · Conferência com a Shopify e saúde das fontes.
   Mostra, lado a lado e sem somar: o relatório da Shopify (conta o pedido na criação, inclusive
   PIX/boleto que expirou), o que o painel conta (pedido pago, subtotal após desconto, sem frete —
   a base de comissão) e os pedidos não pagos que explicam a diferença. Ausência de fonte é
   "indisponível", nunca zero. */
(function(root){
'use strict';
const MARCA={aristo:'O Aristocrata',fish:'Fishermans',olivas:'Olivas do Campo'};
const ADMIN={aristo:'gwx20u-vw',fish:'c0kfm1-qt'};
const LANES=[
 {lane:'sync_cupom',nome:'Catálogo de cupons',quando:'diário 03:50'},
 {lane:'coleta_pedidos',nome:'Pedidos com cupom',quando:'diário 04:10'},
 {lane:'relatorio_shopify',nome:'Relatório Shopify',quando:'diário 04:35'}];
const LENTE=new Set(['influ','pendente',null,undefined,'desconhecido']);
const SITUACAO={
 igual:{rot:'Igual à Shopify',cls:'bom'},
 explicada_nao_pagos:{rot:'Diferença = não pagos',cls:'bom'},
 diferenca_de_valor:{rot:'Diferença a investigar',cls:'ruim'},
 ausente_no_painel:{rot:'Só na Shopify',cls:'ruim'},
 ausente_no_relatorio:{rot:'Só no painel',cls:'ruim'},
 fora_da_lente:{rot:'Fora da lente',cls:'nulo'},
 relatorio_parcial:{rot:'Relatório parcial',cls:'neutro'},
 relatorio_indisponivel:{rot:'Relatório indisponível',cls:'neutro'}};
const num=v=>v===null||v===undefined||v===''||!Number.isFinite(Number(v))?null:Number(v);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const brl=v=>v===null?'—':'R$ '+v.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const int=v=>v===null?'—':v.toLocaleString('pt-BR');
const quando=(iso,agora)=>{if(!iso)return '—';const d=new Date(iso);if(Number.isNaN(+d))return '—';
 const f=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(d);
 const h=(agora-d)/36e5;return h<1?f+' (há '+Math.max(1,Math.round(h*60))+' min)':h<48?f+' (há '+Math.round(h)+' h)':f;};

function disponivel(p){return Array.isArray(p?.conciliacao);}
function naLente(x){return LENTE.has(x.tipo);}
function linhas(p,marca,escopo){
 if(!disponivel(p))return null;
 return p.conciliacao.filter(x=>x&&(marca==='todas'||x.marca===marca)&&(escopo==='todos'||naLente(x)))
  .map(x=>({...x,relatorio_pedidos:num(x.relatorio_pedidos),relatorio_vendas_liquidas:num(x.relatorio_vendas_liquidas),
   pagos:num(x.pagos)??0,receita_paga:num(x.receita_paga)??0,nao_pagos:num(x.nao_pagos)??0,receita_nao_paga:num(x.receita_nao_paga)??0,diferenca:num(x.diferenca)}))
  .sort((a,b)=>(b.relatorio_vendas_liquidas??b.receita_paga)-(a.relatorio_vendas_liquidas??a.receita_paga)||String(a.codigo).localeCompare(String(b.codigo)));
}
// Totais por marca só da lente de creator. Relatório com cobertura incompleta não entra no total:
// o total da Shopify fica "indisponível" em vez de parecer menor.
function resumo(p,marca){
 const ls=linhas(p,marca,'lente');if(!ls)return null;
 const out={};
 for(const x of ls){const r=out[x.marca]||(out[x.marca]={marca:x.marca,cobertura:x.relatorio_cobertura,relPedidos:0,relLiquidas:0,pagos:0,receitaPaga:0,naoPagos:0,receitaNaoPaga:0,investigar:0,cupons:0});
  r.cupons++;r.pagos+=x.pagos;r.receitaPaga+=x.receita_paga;r.naoPagos+=x.nao_pagos;r.receitaNaoPaga+=x.receita_nao_paga;
  if(x.relatorio_cobertura!=='completa')r.cobertura=x.relatorio_cobertura;
  r.relPedidos+=x.relatorio_pedidos||0;r.relLiquidas+=x.relatorio_vendas_liquidas||0;
  if(['diferenca_de_valor','ausente_no_painel','ausente_no_relatorio'].includes(x.situacao))r.investigar++;}
 for(const r of Object.values(out)){if(r.cobertura!=='completa'){r.relPedidos=null;r.relLiquidas=null;}
  r.receitaPaga=Math.round(r.receitaPaga*100)/100;r.receitaNaoPaga=Math.round(r.receitaNaoPaga*100)/100;if(r.relLiquidas!==null)r.relLiquidas=Math.round(r.relLiquidas*100)/100;}
 return Object.values(out).sort((a,b)=>a.marca.localeCompare(b.marca));
}
// Saúde esperada: cada etapa × Aristocrata e Fishermans. Sem registro = desconhecido; sucesso com
// mais de 26 h = desatualizado; falha mostra desde quando não há sucesso.
function saude(p,agora=Date.now()){
 if(!Array.isArray(p?.saude))return null;
 const idx=new Map(p.saude.map(s=>[s.lane+'|'+s.marca,s]));
 return LANES.flatMap(l=>['aristo','fish'].map(m=>{const s=idx.get(l.lane+'|'+m);
  if(!s)return {...l,marca:m,estado:'sem_registro'};
  const ok=s.ok===true,ult=s.ultimo_ok_em||(ok?s.em:null),idade=ult?(agora-new Date(ult))/36e5:null;
  return {...l,marca:m,estado:!ok?'falha':idade!==null&&idade>26?'desatualizada':'ok',em:s.em,ultimo_ok_em:ult,detalhe:s.detalhe,itens:s.itens};}));
}
function csvCel(v){if(v===null||v===undefined)return '';const s=typeof v==='number'?String(v).replace('.',','):String(v);return /[;"\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
function csv(cab,rows){return '\ufeff'+[cab.map(c=>c[1]),...rows.map(r=>cab.map(([k])=>r[k]))].map(l=>l.map(csvCel).join(';')).join('\r\n');}
function csvCupons(ls,periodo){
 return csv([['marca','marca'],['codigo','cupom'],['tipo','tipo'],['influ','dono'],['relatorio_pedidos','shopify_pedidos'],['relatorio_vendas_liquidas','shopify_vendas_liquidas'],
  ['pagos','painel_pedidos_pagos'],['receita_paga','painel_receita_paga'],['nao_pagos','nao_pagos_pedidos'],['receita_nao_paga','nao_pagos_valor'],['status','nao_pagos_status'],
  ['diferenca','diferenca_sem_explicacao'],['situacao','situacao'],['relatorio_cobertura','cobertura_relatorio'],['relatorio_coletado_em','relatorio_coletado_em'],['painel_atualizado_em','painel_atualizado_em'],['ini','periodo_ini'],['fim','periodo_fim']],
  ls.map(x=>({...x,status:Object.entries(x.status_nao_pagos||{}).map(([k,v])=>k+' '+v).join(' '),ini:periodo.ini,fim:periodo.fim})));
}
function csvPedidos(rows){
 return csv([['marca','marca'],['order_id','pedido_id'],['admin','link_admin'],['dia','dia_brasilia'],['cupom_usado','cupom'],['todos_cupons','todos_cupons'],['tipo','tipo_cupom'],['influ','dono'],
  ['status_financeiro','status_shopify'],['pago_txt','conta_no_painel'],['receita_base','subtotal_apos_desconto'],['frete','frete'],['reembolsado','reembolsado'],['comissao','comissao_apurada'],['atualizado_em','coletado_em']],
  (rows||[]).map(r=>({...r,dia:String(r.dia||'').slice(0,10),pago_txt:r.pago?'sim':'não',admin:ADMIN[r.marca]?`https://admin.shopify.com/store/${ADMIN[r.marca]}/orders/${r.order_id}`:'',
   receita_base:num(r.receita_base),frete:num(r.frete),reembolsado:num(r.reembolsado),comissao:num(r.comissao)})));
}
function baixar(doc,nome,conteudo){
 const url=URL.createObjectURL(new Blob([conteudo],{type:'text/csv;charset=utf-8'}));
 const a=doc.createElement('a');a.href=url;a.download=nome;doc.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function coletaTexto(p,marca,agora=Date.now()){
 const c=p?.coleta;if(!c||typeof c!=='object')return null;
 const ms=(marca==='todas'?Object.keys(c):[marca]).filter(m=>c[m]&&m!=='olivas');if(!ms.length)return null;
 const mais_velho=ms.map(m=>c[m]).sort()[0];
 return 'última coleta de pedidos: '+quando(mais_velho,agora);
}

function render(doc,host,ctx){
 if(!host)return;
 const p=ctx.getData(),marca=ctx.getMarca(),per=ctx.getPeriod(),agora=Date.now();
 if(!p){host.innerHTML='<div class="vazio">Carregando a conferência…</div>';return;}
 const escopo=host.dataset.escopo||'lente';
 const ls=linhas(p,marca,escopo),rs=resumo(p,marca),sd=saude(p,agora);
 const hoje=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date(agora));
 const incluiHoje=per.fim>=hoje;
 const cab=`<div class="painel-cab"><h2>Conferência com a Shopify</h2><span class="mini">${esc(per.ini)} a ${esc(per.fim)} · dia de Brasília</span></div>`;
 const leitura=`<div class="conf-leitura"><div><strong>Shopify</strong><span>conta o pedido quando é criado, inclusive PIX e boleto que ainda não foram pagos ou expiraram. É o número do relatório “Vendas por código de desconto”.</span></div>
  <div><strong>Painel</strong><span>conta só pedido pago: subtotal após desconto, sem frete, já descontando estorno. É a base de receita, ROI e comissão.</span></div>
  <div><strong>Não pagos</strong><span>pedidos com cupom que a Shopify conta e o painel não. São eles que explicam a diferença.</span></div></div>`;
 const avisoHoje=incluiHoje?`<div class="alerta">O período inclui hoje. Pedidos são coletados uma vez por dia (04:10) e o relatório Shopify vai até ontem; o dia de hoje aparece como parcial, não como diferença.</div>`:'';
 let corpo;
 if(!ls){corpo='<div class="vazio"><strong>Conferência indisponível.</strong><br>A API ainda não entregou o relatório Shopify para este período. Os números do painel continuam válidos; a comparação é que não pode ser feita agora.</div>';}
 else{
  const res=(rs||[]).map(r=>`<div class="conf-marca" data-marca-conf="${esc(r.marca)}"><h3>${esc(MARCA[r.marca]||r.marca)}</h3>
    <dl><div><dt>Shopify</dt><dd>${r.relLiquidas===null?'<span class="mini">relatório '+(r.cobertura==='parcial'?'parcial':'indisponível')+'</span>':brl(r.relLiquidas)+'<small>'+int(r.relPedidos)+' pedidos</small>'}</dd></div>
    <div><dt>Painel (pagos)</dt><dd>${brl(r.receitaPaga)}<small>${int(r.pagos)} pedidos</small></dd></div>
    <div><dt>Não pagos</dt><dd>${brl(r.receitaNaoPaga)}<small>${int(r.naoPagos)} pedidos</small></dd></div></dl>
    <p class="mini">${r.investigar?`<span class="tag ruim">${r.investigar} cupom(ns) a investigar</span>`:(r.relLiquidas===null?'Sem conferência completa neste período.':'<span class="tag bom">Diferenças explicadas</span>')} · ${r.cupons} cupons de creator</p></div>`).join('')||'<div class="vazio">Nenhum cupom de creator com pedido neste período.</div>';
  const tabela=ls.length?`<div class="rolagem"><table class="comparativo conf-tabela"><thead><tr><th>Cupom</th><th>Dono</th>
    <th class="num">Shopify<br><span class="mini">pedidos · vendas líquidas</span></th><th class="num">Painel · pagos<br><span class="mini">pedidos · receita</span></th>
    <th class="num">Não pagos<br><span class="mini">pedidos · valor</span></th><th class="num">Sem explicação</th><th>Situação</th></tr></thead><tbody>
    ${ls.map(x=>{const s=SITUACAO[x.situacao]||{rot:x.situacao,cls:'nulo'};const st=Object.entries(x.status_nao_pagos||{}).map(([k,v])=>k.toLowerCase()+' '+v).join(', ');
     const dica=x.situacao==='diferenca_de_valor'?'A Shopify registra devolução e estorno no dia em que acontecem. Estorno feito fora do período muda o subtotal atual do pedido, mas não o relatório do período. Exporte os pedidos para conferir.':x.situacao==='fora_da_lente'?'Cupom classificado como '+(x.tipo||'')+': não entra em receita de creator.':x.situacao==='ausente_no_painel'?'A Shopify tem venda com este cupom e o painel não tem pedido. Confira a classificação e a coleta.':'';
     return `<tr><td><code>${esc(x.codigo)}</code> <span class="tag ${esc(x.marca)}">${esc((MARCA[x.marca]||x.marca).replace('O ',''))}</span>${x.tipo?'':' <span class="tag alerta">sem cadastro</span>'}</td>
      <td>${x.influ?esc(x.influ):x.tipo==='pendente'?'<span class="tag alerta">pendente</span>':'<span class="mini">—</span>'}</td>
      <td class="num tabn">${x.relatorio_pedidos===null?'—':int(x.relatorio_pedidos)+' · '+brl(x.relatorio_vendas_liquidas)}</td>
      <td class="num tabn">${int(x.pagos)} · ${brl(x.receita_paga)}</td>
      <td class="num tabn" title="${esc(st)}">${x.nao_pagos?int(x.nao_pagos)+' · '+brl(x.receita_nao_paga):'—'}</td>
      <td class="num tabn">${x.diferenca===null?'—':Math.abs(x.diferenca)<0.005?'<span class="conf-zero">R$ 0,00</span>':brl(x.diferenca)}</td>
      <td><span class="tag ${s.cls}"${dica?` title="${esc(dica)}"`:''}>${esc(s.rot)}</span></td></tr>`;}).join('')}</tbody></table></div>`:'<div class="vazio">Nada neste filtro.</div>';
  corpo=`<div class="conf-resumo">${res}</div>
   <div class="conf-barra"><label class="mini">Mostrar <select class="i-sel" id="conf-escopo"><option value="lente"${escopo==='lente'?' selected':''}>cupons de creator</option><option value="todos"${escopo==='todos'?' selected':''}>todos os cupons</option></select></label>
    <span class="conf-acoes"><button class="btn sec" id="conf-csv-cupons" type="button">Exportar cupons (CSV)</button><button class="btn sec" id="conf-csv-pedidos" type="button">Exportar pedidos (CSV)</button><span class="mini" id="conf-msg" role="status"></span></span></div>${tabela}`;
 }
 const saudeHtml=!sd?'<div class="vazio">Saúde das fontes indisponível nesta leitura.</div>':`<div class="rolagem"><table class="comparativo conf-saude"><thead><tr><th>Etapa</th><th>Loja</th><th>Estado</th><th>Último sucesso</th><th>Última tentativa</th><th>Detalhe</th></tr></thead><tbody>
  ${sd.filter(s=>marca==='todas'||s.marca===marca).map(s=>`<tr><td>${esc(s.nome)} <span class="mini">${esc(s.quando)}</span></td><td>${esc(MARCA[s.marca])}</td>
   <td>${s.estado==='ok'?'<span class="tag bom">ok</span>':s.estado==='falha'?'<span class="tag ruim">falhou</span>':s.estado==='desatualizada'?'<span class="tag alerta">sem sucesso há mais de 26 h</span>':'<span class="tag nulo">sem registro</span>'}</td>
   <td class="tabn">${quando(s.ultimo_ok_em,agora)}</td><td class="tabn">${quando(s.em,agora)}</td><td class="mini conf-det">${esc(s.detalhe||'')}</td></tr>`).join('')}</tbody></table></div>`;
 host.innerHTML=`<section class="painel">${cab}${leitura}${avisoHoje}${corpo}</section>
  <section class="painel"><div class="painel-cab"><h2>Saúde das fontes</h2><span class="mini">${esc(coletaTexto(p,marca,agora)||'horário da coleta indisponível')}</span></div>${saudeHtml}
  <details class="ressalvas"><summary>Como cada etapa é conferida</summary><ul>
   <li><strong>Catálogo de cupons</strong>: lê todos os descontos da Shopify. Cupom novo entra como pendente; tipo e dono cadastrados nunca são trocados pela coleta.</li>
   <li><strong>Pedidos com cupom</strong>: relê 45 dias. Guarda pago e não pago; só pago vira receita e comissão. Erro da Shopify marca falha em vez de zero.</li>
   <li><strong>Relatório Shopify</strong>: mesmo relatório do admin (ShopifyQL), por dia e cupom, até ontem. Serve para conferir, não soma com nada.</li>
   <li>Meta, TikTok e links de parceiros são outras fontes e outras populações: não entram nesta conferência.</li></ul></details></section>`;
 const sel=host.querySelector('#conf-escopo');if(sel)sel.onchange=()=>{host.dataset.escopo=sel.value;render(doc,host,ctx);};
 const b1=host.querySelector('#conf-csv-cupons');if(b1)b1.onclick=()=>baixar(doc,`conferencia-cupons-${marca}-${per.ini}-${per.fim}.csv`,csvCupons(linhas(p,marca,escopo),per));
 const b2=host.querySelector('#conf-csv-pedidos'),msg=host.querySelector('#conf-msg');
 if(b2)b2.onclick=async()=>{b2.disabled=true;msg.textContent='Lendo pedidos…';
  try{const rows=await ctx.fetchPedidos({...per,marca});
   if(!Array.isArray(rows))throw new Error('A API ainda não entrega os pedidos da conferência.');
   baixar(doc,`conferencia-pedidos-${marca}-${per.ini}-${per.fim}.csv`,csvPedidos(rows));msg.textContent=rows.length+' pedido(s) exportado(s).';}
  catch(e){msg.textContent=e.message||'Não foi possível exportar agora.';}
  finally{b2.disabled=false;}};
}
const api={MARCA,LANES,SITUACAO,linhas,resumo,saude,csvCupons,csvPedidos,coletaTexto,render};
if(typeof module==='object'&&module.exports)module.exports=api;else root.InflusConferencia=api;
})(typeof window!=='undefined'?window:globalThis);
