/* Growth: métricas operacionais por canal, com bases e datas explícitas. */
'use strict';
const GUI = {
  esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  },
  number(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(+value);
  },
  nf(value) { return GUI.number(value) ? (+value).toLocaleString('pt-BR', {maximumFractionDigits:0}) : '—'; },
  rf(value) { return GUI.number(value) ? (+value).toLocaleString('pt-BR', {style:'currency',currency:'BRL',maximumFractionDigits:0}) : '—'; },
  pf(value) { return GUI.number(value) ? (+value).toLocaleString('pt-BR', {maximumFractionDigits:2}) + '%' : '—'; },
  date(value) {
    const s = String(value || '').slice(0,10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('/') : '—';
  },
  el(selector) { return typeof document === 'undefined' ? null : document.querySelector(selector); },
  html(selector, value) { const el=GUI.el(selector); if(el) el.innerHTML=value; },
  text(selector, value) { const el=GUI.el(selector); if(el) el.textContent=value; },
  period(ini, fim) { return ini === fim ? GUI.date(ini) : `${GUI.date(ini)} a ${GUI.date(fim)}`; },
  sum(rows, field) { return rows.reduce((total, row) => total + (+row[field] || 0),0); },
  stat(label, value, className='') {
    return `<div${className ? ` class="${className}"` : ''}><strong>${value}</strong><span>${label}</span></div>`;
  },
  overview(ctx={}) {
    const {G,GD,marca='todas',ini='',fim='',canal='todos',cmp=false,hoje=''}=ctx;
    const api=ctx.api || {};
    if(!G || !GD) return null;
    const summary=GD.summary(G,api,marca,ini,fim,canal);
    const wa=summary.wa || {}, email=summary.email || {};
    const conversionKnown=Array.isArray(api.crm_conversao);
    const receipt=conversionKnown ? summary.receita : null;
    const orders=conversionKnown ? summary.pedidos : null;
    const closed=!!hoje && fim < hoje;
    const previousPeriod=G.anterior(ini,fim);
    const previous=cmp && closed ? GD.summary(G,api,marca,previousPeriod.ini,previousPeriod.fim,canal) : null;
    const previousLabel=GUI.period(previousPeriod.ini,previousPeriod.fim);
    const compare=(current,before) => {
      if(!cmp) return '<span class="mini">Comparação desativada</span>';
      if(!closed) return '<span class="mini">Período parcial · comparação indisponível</span>';
      const delta=G.delta(current,before,GUI.number(current) && GUI.number(before));
      if(delta === null) return `<span class="mini">Sem base comparável em ${GUI.esc(previousLabel)}</span>`;
      return `<span class="chip ${delta >= 0 ? 'd-bom' : 'd-ruim'}">${delta > 0 ? '+' : ''}${GUI.pf(delta)}</span><span class="mini">vs. ${GUI.esc(previousLabel)}</span>`;
    };
    const kpis=[
      {label:'Disparos registrados',value:summary.enviados,before:previous?.enviados,format:GUI.nf,
        note:canal==='whatsapp' ? 'Mensagens aceitas pela Meta' : canal==='email' ? 'Campanhas Listmonk + automações SES' : 'WhatsApp próprio + e-mail'},
      {label:'Receita atribuída',value:receipt,before:conversionKnown ? previous?.receita : null,format:GUI.rf,note:'Último clique · data da compra'},
      {label:'Pedidos atribuídos',value:orders,before:conversionKnown ? previous?.pedidos : null,format:GUI.nf,note:'Último clique · data da compra'},
      canal==='whatsapp'
        ? {label:'Taxa de entrega WhatsApp',value:wa.entrega_pct,before:previous?.wa?.entrega_pct,format:GUI.pf,note:'Entregues ÷ aceitos pela Meta'}
        : {label:'CTR das campanhas de e-mail',value:email.ctr,before:previous?.email?.ctr,format:GUI.pf,note:'Clicaram ÷ entregues · somente base medida'},
    ];
    GUI.html('#area-kpis',kpis.map(k=>`<div class="kpi"><div class="kpi-rot">${k.label}</div>
      <div class="kpi-val tabn${GUI.number(k.value)?'':' vazio-val'}">${k.format(k.value)}</div>
      <div class="kpi-rodape">${compare(k.value,k.before)}</div><div class="kpi-sub">${k.note}</div></div>`).join(''));

    const coverage=wa.coverage || {present:false,complete:false};
    const coverageEl=GUI.el('#wa-coverage');
    if(coverageEl) {
      coverageEl.hidden=canal==='email' || coverage.complete;
      coverageEl.textContent=!coverage.present
        ? 'Dados de disparos do WhatsApp indisponíveis nesta consulta. Os indicadores de e-mail continuam disponíveis.'
        : `Cobertura do WhatsApp: ${GUI.period(coverage.inicio,coverage.fim)}. O período selecionado não está totalmente coberto; os totais de envio aparecem como —.`;
    }
    const channelConv=channel => {
      const rows=(summary.conv || []).filter(r=>r.canal===channel);
      return {receita:conversionKnown ? GUI.sum(rows,'receita') : null,pedidos:conversionKnown ? GUI.sum(rows,'pedidos') : null};
    };
    const waConv=channelConv('whatsapp'),emailConv=channelConv('email');
    const period=GUI.esc(GUI.period(ini,fim));
    const channelButton=channel => `<button type="button" class="refresh-btn" data-select-channel="${channel}" aria-pressed="${canal===channel}">${canal===channel?'Ver todos os canais':'Ver só este canal'}</button>`;
    const attributionNote='Receita e pedidos seguem a data da compra e o último clique. Não representam a taxa de conversão dos envios deste período.';
    const waBar=[wa.entregues,wa.pendentes_entrega,wa.falhas].every(GUI.number) && +wa.aceitos > 0
      ? `<div class="delivery-bar" aria-hidden="true">${[['ok',wa.entregues],['pending',wa.pendentes_entrega],['failed',wa.falhas]].map(([cls,n])=>`<i class="${cls}" style="width:${Math.min(100,Math.max(0,100*n/wa.aceitos))}%"></i>`).join('')}</div>` : '';
    const waCard=`<article class="channel-card whatsapp" data-channel-card="whatsapp">
      <div class="channel-head"><h2>WhatsApp</h2>${channelButton('whatsapp')}</div>
      <div class="channel-main"><div><div class="big">${GUI.nf(wa.aceitos)}</div><span class="channel-label">aceitos pela Meta · ${period}</span></div>
        <div class="amount"><strong>${GUI.rf(waConv.receita)}</strong><span class="channel-label">receita atribuída</span></div></div>
      <div class="channel-stats">${GUI.stat('Entregues',GUI.nf(wa.entregues))}${GUI.stat('Lidos',GUI.nf(wa.lidos))}${GUI.stat('Falhas na entrega',GUI.nf(wa.falhas),'failure')}
        ${GUI.stat('Aguardando confirmação',GUI.nf(wa.pendentes_entrega))}${GUI.stat('Pedidos atribuídos',GUI.nf(waConv.pedidos))}${GUI.stat('Taxa de entrega',GUI.pf(wa.entrega_pct))}</div>
      ${waBar}<div class="channel-foot"><p>Envios próprios registrados no período; status atualizado até a consulta. Não inclui disparos da Reportana.</p>
        <details><summary>Como ler estas métricas</summary>
          <p>${attributionNote}</p>
          <p>Entregues incluem mensagens lidas. Leituras dependem da confirmação disponível no WhatsApp; ausência de leitura não significa ausência de interesse.</p>
          <p class="substats">Sem disparo confirmado: <strong>${GUI.nf(wa.sem_disparo_confirmado)}</strong> · Erros antes do aceite: <strong>${GUI.nf(wa.erros_sincronos)}</strong>.</p>
          <p>Sem disparo confirmado inclui sombra, reserva ou tentativa sem aceite da Meta. Esses registros não entram em disparos aceitos.</p>
          <p>Testes identificados: <strong>${GUI.nf(wa.testes_aceitos)}</strong>, fora dos totais operacionais. Testes internos sem modo identificável podem permanecer nos indicadores.</p>
          ${+wa.conflitos_status > 0 ? `<p>${GUI.nf(wa.conflitos_status)} registro(s) com confirmações divergentes; confira o acompanhamento antes de avaliar a taxa.</p>` : ''}
        </details></div><button type="button" class="channel-jump" data-open-flows="whatsapp">Ver automações →</button></article>`;
    const emailCard=`<article class="channel-card email" data-channel-card="email">
      <div class="channel-head"><h2>E-mail</h2>${channelButton('email')}</div>
      <div class="channel-main"><div><div class="big">${GUI.nf(email.enviados)}</div><span class="channel-label">disparos registrados · ${period}</span></div>
        <div class="amount"><strong>${GUI.rf(emailConv.receita)}</strong><span class="channel-label">receita atribuída</span></div></div>
      <div class="channel-stats">${GUI.stat('Campanhas Listmonk',GUI.nf(email.campanhas_enviados))}${GUI.stat('Automações SES',GUI.nf(email.automacoes_enviados))}${GUI.stat('Pedidos atribuídos',GUI.nf(emailConv.pedidos))}
        ${GUI.stat('CTR · campanhas',GUI.pf(email.ctr))}${GUI.stat('CTOR · campanhas',GUI.pf(email.ctor))}${GUI.stat('Abertura · campanhas',GUI.pf(email.abertura))}</div>
      <div class="channel-foot"><p>Envios de campanhas e automações separados. Abertura, CTR e CTOR usam apenas campanhas Listmonk com a respectiva medição.</p>
        <details><summary>Como ler estas métricas</summary><p>${attributionNote}</p>
          <p>CTR = pessoas que clicaram ÷ entregues; CTOR = pessoas que clicaram ÷ pessoas que abriram; abertura = pessoas que abriram ÷ entregues.</p>
          <p class="substats">Campanhas com cliques medidos: <strong>${GUI.nf(email.medidasCliques)}</strong> · Base entregue para CTR: <strong>${GUI.nf(email.baseCliques)}</strong>.<br>
            Campanhas com abertura medida: <strong>${GUI.nf(email.medidas)}</strong> · Base entregue para abertura: <strong>${GUI.nf(email.baseAbertura)}</strong>.<br>
            Campanhas com ambas as medições, usadas no CTOR: <strong>${GUI.nf(email.medidasConjuntas)}</strong>.</p>
          <p>Automações via SES não têm abertura, clique ou entrega individual confirmados nesta visão. Métrica ausente aparece como —.</p>
          <p>Abertura pode incluir ações automáticas de provedores. Use cliques e pedidos para complementar a análise.</p>
        </details></div><button type="button" class="channel-jump" data-open-flows="email">Ver automações →</button></article>`;
    const cards=GUI.el('#channel-cards');
    if(cards) {
      cards.classList.toggle('single',canal!=='todos');
      cards.innerHTML=canal==='whatsapp'?waCard:canal==='email'?emailCard:waCard+emailCard;
      cards.querySelectorAll('[data-select-channel]').forEach(button=>button.addEventListener('click',()=>{
        if(typeof ctx.onChannel==='function') ctx.onChannel(canal===button.dataset.selectChannel?'todos':button.dataset.selectChannel);
      }));
      cards.querySelectorAll('[data-open-flows]').forEach(button=>button.addEventListener('click',()=>{
        if(typeof ctx.onFlows==='function') ctx.onFlows(button.dataset.openFlows);
      }));
    }
    return summary;
  },
  flows(ctx={}) {
    const {G,GD,marca='todas',ini='',fim='',canal='todos'}=ctx;
    const api=ctx.api || {};
    if(!G || !GD) return [];
    const rows=GD.flows(G,api,marca,ini,fim,canal);
    const selector=GUI.el('#sel-flow');
    const options=[...new Set(rows.map(row=>String(row.flow || 'Sem fluxo')))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
    if(selector) {
      const previous=selector.value;
      selector.innerHTML='<option value="">Todas as automações</option>'+options.map(flow=>`<option value="${GUI.esc(flow)}">${GUI.esc(flow)}</option>`).join('');
      selector.value=options.includes(previous)?previous:'';
    }
    const render=()=>{
      const chosen=selector?.value || '';
      const visible=chosen?rows.filter(row=>String(row.flow || 'Sem fluxo')===chosen):rows;
      GUI.text('#n-regua',rows.length || '');
      GUI.text('#regua-rot',`${visible.length} peça${visible.length===1?'':'s'}${chosen?` de ${rows.length}`:''} · ${GUI.period(ini,fim)}`);
      GUI.html('#tab-regua tbody',visible.length?visible.map(row=>{
        const channel=row.canal==='whatsapp'?'whatsapp':'email';
        const brandClass=['fish','aristo','olivas'].includes(row.marca)?row.marca:'nulo';
        const brand=G.MARCA?.[row.marca] || row.marca || 'Sem marca';
        const details=channel==='whatsapp'
          ? `<details class="flow-extra"><summary>Detalhes dos disparos</summary><div>Lidos: ${GUI.nf(row.lidos)} · Aguardando confirmação: ${GUI.nf(row.pendentes_entrega)}<br>
              Sem disparo confirmado: ${GUI.nf(row.sem_disparo_confirmado)} · Erros antes do aceite: ${GUI.nf(row.erros_sincronos)}</div></details>`
          : '<div class="flow-extra">Entrega e falhas individuais não medidas nesta visão.</div>';
        return `<tr><td><div class="flow-name">${GUI.esc(row.piece || 'Sem peça')}</div><div class="flow-sub">${GUI.esc(row.flow || 'Sem fluxo')}</div>${details}</td>
          <td><span class="tag growth-table-tag ${brandClass}">${GUI.esc(brand)}</span><span class="tag ${channel}">${channel==='whatsapp'?'WhatsApp':'E-mail'}</span></td>
          <td class="num tabn">${GUI.nf(row.enviados)}</td><td class="num tabn">${GUI.nf(channel==='whatsapp'?row.entregues:null)}</td>
          <td class="num tabn">${GUI.nf(channel==='whatsapp'?row.falhas:null)}</td><td class="num tabn">${GUI.nf(row.pedidos)}</td>
          <td class="num tabn destaque">${GUI.rf(row.receita)}</td></tr>`;
      }).join(''):'<tr><td colspan="7"><div class="vazio">Nenhuma automação com registros neste recorte.</div></td></tr>');
      const anomalies=(G.REGUA_ANOMALIAS || []).filter(a=>canal!=='whatsapp' && a.dia>=ini && a.dia<=fim && (marca==='todas' || a.marca===marca));
      GUI.html('#nota-regua',`Disparos de WhatsApp são mensagens aceitas pela Meta; sombra e tentativas sem aceite ficam nos detalhes. Não inclui Reportana. Automações de e-mail são envios registrados via SES; entrega e falhas individuais aparecem como —.<br>
        Pedidos e receita seguem a data da compra e a atribuição por último clique à peça. Não são conversão dos envios deste período. O filtro de automação altera somente esta tabela.`+
        anomalies.map(a=>`<div class="metric-note"><strong>${GUI.date(a.dia)} · ${GUI.esc(G.MARCA?.[a.marca] || a.marca)} · ${GUI.esc(a.piece)}:</strong> ${GUI.esc(a.motivo)}.</div>`).join(''));
      return visible;
    };
    if(selector) selector.onchange=render;
    render();
    return rows;
  },
};
if(typeof module !== 'undefined' && module.exports) module.exports=GUI;
