/* PIX: same-order payments observed after an accepted recovery message. */
'use strict';
const GPIX = {
  rows(api, marca, ini, fim) {
    if (!Array.isArray(api?.crm_pix_conversao)) return null;
    const fields=['pedidos_avisados','pedidos_somente_internos','pedidos_entregues','pedidos_consultados','sem_leitura_pagamento','pagos_apos_aviso','valor_pago_brl','janela_aberta','cancelados_estornados','pedidos_janela_encerrada','pedidos_encerrados_consultados','pedidos_encerrados_reconsultados','pagos_janela_encerrada'];
    const map=new Map();
    for(const r of api.crm_pix_conversao) {
      if(!['todas','todos'].includes(marca)&&r.marca!==marca)continue;
      if(r.dia<ini||r.dia>fim)continue;
      if(!map.has(r.marca))map.set(r.marca,{marca:r.marca,...Object.fromEntries(fields.map(k=>[k,0])),leitura_mais_antiga:null,janela_dias:r.janela_dias});
      const s=map.get(r.marca);
      for(const k of fields) s[k]=s[k]===null||r[k]===null||r[k]===undefined||!Number.isFinite(+r[k])?null:s[k]+(+r[k]);
      if(r.leitura_mais_antiga&&(!s.leitura_mais_antiga||r.leitura_mais_antiga<s.leitura_mais_antiga))s.leitura_mais_antiga=r.leitura_mais_antiga;
    }
    return [...map.values()].map(r=>({...r,taxa:r.pedidos_avisados>0&&r.sem_leitura_pagamento===0&&r.pedidos_consultados===r.pedidos_avisados&&r.pagos_apos_aviso!==null?100*r.pagos_apos_aviso/r.pedidos_avisados:null,taxa_encerrada:r.pedidos_janela_encerrada>0&&r.pedidos_encerrados_reconsultados===r.pedidos_janela_encerrada&&r.pagos_janela_encerrada!==null?100*r.pagos_janela_encerrada/r.pedidos_janela_encerrada:null}));
  },
  render(api,marca,ini,fim,canal,ui) {
    const el=ui.el('#pix-conversion');if(!el)return;
    el.hidden=canal==='email';if(el.hidden)return;
    const rows=GPIX.rows(api,marca,ini,fim);
    if(rows===null){el.innerHTML='<div class="painel-cab"><h2>PIX · pagamento após o aviso</h2></div><div class="nota">Leitura de pagamentos indisponível nesta consulta.</div>';return;}
    const labels={fish:'Fishermans',aristo:'Aristocrata'};
    el.innerHTML=`<div class="painel-cab"><h2>PIX · pagamento após o aviso</h2><span class="mini">WhatsApp · mesmo pedido · até 7 dias</span></div>
      <div class="rolagem"><table class="comparativo"><thead><tr><th>Marca</th><th class="num">Pedidos avisados</th><th class="num">Entregues</th><th class="num">Pagos após aviso</th><th class="num">Taxa observada¹</th><th class="num">Valor pago</th><th>Leitura</th></tr></thead><tbody>${rows.length?rows.map(r=>`<tr><td>${ui.esc(labels[r.marca]||r.marca)}</td><td class="num">${ui.nf(r.pedidos_avisados)}</td><td class="num">${ui.nf(r.pedidos_entregues)}</td><td class="num">${r.pedidos_avisados?ui.nf(r.pagos_apos_aviso):'—'}</td><td class="num">${ui.pf(r.taxa)}${r.janela_aberta?'<div class="mini">Janela ainda aberta</div>':''}</td><td class="num">${r.pedidos_avisados?(r.valor_pago_brl===null?'—':r.valor_pago_brl.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})):'—'}</td><td>${r.pedidos_avisados?`${ui.nf(r.pedidos_consultados)} de ${ui.nf(r.pedidos_avisados)} com registro<br><span class="mini">${ui.esc(ui.timestamp(r.leitura_mais_antiga))} · leitura mais antiga</span>`:`Sem envio confirmado · ${ui.nf(r.pedidos_somente_internos)} pedidos sem aceite`}</td></tr>`).join(''):'<tr><td colspan="7">Sem avisos de PIX neste período.</td></tr>'}</tbody></table></div>
      <div class="nota">Pedidos agrupados pela data do primeiro aviso aceito pela Meta. A confirmação de pagamento precisa ocorrer depois desse aviso e em até sete dias. Cada pedido conta uma vez; pagamentos anteriores, testes identificados, registros internos e pedidos cancelados ficam fora das conversões. Fishermans usa o valor líquido de transações e estornos; Aristocrata exclui pedidos com evento de estorno ou contestação.</div>
      <div class="nota">¹ Associação temporal ao mesmo pedido. Não confirma o pagamento da cobrança PIX originalmente enviada, não comprova clique no botão Copiar código Pix nem que a mensagem causou a compra. Não se soma à receita atribuída por clique. Appmax é o provedor das duas marcas. Aristocrata usa eventos recebidos da Appmax; ausência de evento de pagamento não comprova inadimplência. Fishermans usa o registro financeiro da Shopify. Taxas com janela aberta são provisórias e não devem decidir vencedores A/B. ${rows.map(r=>`${ui.esc(labels[r.marca]||r.marca)}: ${ui.nf(r.janela_aberta)} pedidos ainda na janela de sete dias; ${ui.nf(r.sem_leitura_pagamento)} sem leitura completa; ${ui.nf(r.pedidos_janela_encerrada)} com janela encerrada, ${ui.nf(r.pedidos_encerrados_reconsultados)} reconsultados após o encerramento. Taxa da janela encerrada: ${ui.pf(r.taxa_encerrada)}.`).join(' ')}</div>`;
  },
};
if(typeof module!=='undefined')module.exports=GPIX;
