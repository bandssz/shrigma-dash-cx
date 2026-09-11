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
  timestamp(value) {
    const date=new Date(value || '');
    return Number.isFinite(date.valueOf()) ? new Intl.DateTimeFormat('pt-BR',{
      timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',
    }).format(date) : 'Não disponível';
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
    const compare=(current,before,invert=false) => {
      if(!cmp) return '<span class="mini">Comparação desativada</span>';
      if(!closed) return '<span class="mini">Período parcial · sem comparação</span>';
      const delta=G.delta(current,before,GUI.number(current) && GUI.number(before));
      if(delta === null) return `<span class="mini">Sem base comparável em ${GUI.esc(previousLabel)}</span>`;
      const good=invert ? delta <= 0 : delta >= 0;
      return `<span class="chip ${good ? 'd-bom' : 'd-ruim'}">${delta > 0 ? '+' : ''}${GUI.pf(delta)}</span><span class="mini">vs. ${GUI.esc(previousLabel)}</span>`;
    };
    const jump=(label,target)=>`<button type="button" class="kpi-jump" data-kpi-jump="${target}">${label}</button>`;
    const waDelivery={label:'Entrega WhatsApp',value:wa.entrega_pct,before:previous?.wa?.entrega_pct,format:GUI.pf,
      note:GUI.number(wa.entregues)?`${GUI.nf(wa.entregues)} entregues · ${GUI.nf(wa.falhas)} falhas · de ${GUI.nf(wa.aceitos)} aceitos`:'Entregues ÷ aceitos pela Meta',link:jump('Ver automações','flows:whatsapp')};
    const emailCtr={label:'CTR das campanhas de e-mail',value:email.ctr,before:previous?.email?.ctr,format:GUI.pf,
      note:GUI.number(email.medidasCliques)?`Clicaram ÷ entregues · ${GUI.nf(email.medidasCliques)} de ${GUI.nf(email.pecas)} peças medidas`:'Clicaram ÷ entregues · somente base medida',link:jump('Ver campanhas','camp')};
    const kpis=[
      {label:canal==='whatsapp'?'Aceitos pela Meta':'Disparos registrados',value:summary.enviados,before:previous?.enviados,format:GUI.nf,
        note:canal==='whatsapp' ? 'Aceite não é entrega · sem Reportana' : canal==='email' ? 'Campanhas Listmonk + automações SES' : 'WhatsApp próprio + e-mail',link:jump('Ver envios',`flows:${canal}`)},
      ...(canal==='whatsapp'?[
        {label:'Entregues',value:wa.entregues,before:previous?.wa?.entregues,format:GUI.nf,note:GUI.number(wa.entrega_pct)?`${GUI.pf(wa.entrega_pct)} dos aceitos · delivered ou read`:'delivered ou read · sem duplicar',link:jump('Ver automações','flows:whatsapp')},
        {label:'Falhas na entrega',value:wa.falhas,before:previous?.wa?.falhas,format:GUI.nf,invert:true,note:GUI.number(wa.pendentes_entrega)?`${GUI.nf(wa.pendentes_entrega)} aguardando confirmação`:'Aguardando confirmação: —',link:jump('Ver ocorrências','attention'),failure:GUI.number(wa.falhas)&&+wa.falhas>0},
      ]:[]),
      {label:'Receita atribuída',value:receipt,before:conversionKnown ? previous?.receita : null,format:GUI.rf,note:'Último clique · data da compra',link:jump('Ver conversão','conv')},
      {label:'Pedidos atribuídos',value:orders,before:conversionKnown ? previous?.pedidos : null,format:GUI.nf,note:'Último clique · data da compra',link:jump('Ver conversão','conv')},
      ...(canal==='todos'?[waDelivery,emailCtr]:canal==='email'?[emailCtr]:[]),
    ];
    GUI.html('#area-kpis',kpis.map(k=>`<div class="kpi${k.failure?' kpi-falha':''}"><div class="kpi-rot">${k.label}</div>
      <div class="kpi-val tabn${GUI.number(k.value)?'':' vazio-val'}">${k.format(k.value)}</div>
      <div class="kpi-rodape">${compare(k.value,k.before,k.invert)}</div><div class="kpi-sub">${k.note}${k.link?` · ${k.link}`:''}</div></div>`).join(''));
    GUI.el('#area-kpis')?.querySelectorAll('[data-kpi-jump]').forEach(button=>button.addEventListener('click',()=>{
      if(typeof ctx.onJump==='function')ctx.onJump(button.dataset.kpiJump);
    }));

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
        <details data-gt-key="wa-como-ler"><summary>Como ler estas métricas</summary>
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
      <ul class="measure-gaps" aria-label="O que está medido no e-mail">
        <li data-gap="${GUI.number(email.medidasCliques)&&email.medidasCliques===email.pecas?'ok':'parcial'}" title="Abertura, CTR e CTOR consideram apenas campanhas Listmonk com a medição correspondente. Peça sem medição fica fora da taxa, nunca entra como zero."><strong>Campanhas</strong> ${GUI.number(email.pecas)?`${GUI.nf(email.medidasCliques)} de ${GUI.nf(email.pecas)} peças com clique medido`:'sem peças no período'}</li>
        <li data-gap="lacuna" title="Automações registram o aceite da API Listmonk/SES. Entrega, abertura e clique por mensagem não são medidos neste contrato; a taxa fica como —, não como 0% ou 100%."><strong>Automações SES</strong> aceite da API · entrega individual não medida</li>
        <li data-gap="lacuna" title="Os percentuais de rejeição e reclamação das campanhas selecionadas não são a reputação oficial da conta SES; a AWS usa volume representativo próprio."><strong>Reputação SES</strong> não derivada destes agregados</li>
      </ul>
      <div class="channel-foot"><p>Envios de campanhas e automações separados. Abertura, CTR e CTOR usam apenas campanhas Listmonk com a respectiva medição.</p>
        <details data-gt-key="email-como-ler"><summary>Como ler estas métricas</summary><p>${attributionNote}</p>
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
    GUI.sources(ctx,summary);
    GUI.flowHealth(ctx);
    GUI.attention(ctx);
    return summary;
  },
  /* Faixa de fontes: cada origem tem seu próprio horário. Horário não é veredito de
     saúde, então a etiqueta só muda de cor quando há regra conhecida: inventário
     vence em 15 min (contrato), consulta à API falhou, ou fonte ausente. */
  sourceMax(rows,field){return (Array.isArray(rows)?rows:[]).reduce((max,row)=>{const v=String(row?.[field]||'');return v>max?v:max;},'')||null;},
  sourceTime(value){
    const date=new Date(value||'');
    if(!Number.isFinite(date.valueOf()))return null;
    const hoje=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
    const dia=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(date);
    const hora=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'}).format(date);
    return dia===hoje?hora:`${dia.slice(8,10)}/${dia.slice(5,7)} ${hora}`;
  },
  sources(ctx={},summary={}){
    const el=GUI.el('#fontes');if(!el)return null;
    const api=ctx.api||{},consulta=ctx.consulta||{};
    const now=Number.isFinite(ctx.now)?ctx.now:Date.now();
    const consultaItem={rot:'Consulta',hora:GUI.sourceTime(consulta.em),estado:consulta.falhou?'ruim':consulta.em?'ok':'falta',
      detalhe:consulta.falhou?'A última tentativa de atualizar falhou. Os números na tela são da consulta indicada.':'Hora em que a API respondeu por último. Cada fonte abaixo tem o próprio horário de coleta.',
      texto:consulta.falhou?'falhou · exibindo':'às'};
    let items;
    if(Array.isArray(api.crm_fontes)&&api.crm_fontes.length){
      // R2: a API declara hora, cadência e status de coleta por fonte. Coleta ≠ evento: 'evento' é o último
      // status recebido da Meta (push), que não prova coleta nem saúde — fica neutro.
      const ROT={shopify_conversao:'Venda',listmonk_snapshot:'E-mail',wa_status_meta:'WhatsApp',inventario_operacao:'Inventário',wa_saude:'Saúde canal',wa_fluxo_saude:'Saúde fluxos'};
      items=[consultaItem,...api.crm_fontes.map(f=>{
        const cad=Number.isFinite(+f.cadencia_seg)&&+f.cadencia_seg>0?+f.cadencia_seg:null;
        const cadTxt=cad?(cad>=86400?`${Math.round(cad/86400)} dia(s)`:cad>=3600?`${Math.round(cad/3600)} h`:`${Math.round(cad/60)} min`):null;
        return {rot:ROT[f.fonte]||f.rotulo||f.fonte,hora:GUI.sourceTime(f.coletado_em),
          estado:!f.coletado_em?'falta':f.status==='atrasado'?'velho':'ok',
          texto:f.tipo==='evento'?'último evento':'coletado',
          detalhe:f.tipo==='evento'?`${f.rotulo||f.fonte}: hora do último evento recebido (push). Não é coleta e não indica saúde.`
            :`${f.rotulo||f.fonte}: última coleta bem-sucedida${cadTxt?` · cadência ${cadTxt}; sinalizado a partir de 2× a cadência`:''}${f.status==='atrasado'?' · ATRASADA':''}.`};
      })];
    } else {
      const wa=summary.wa||{},cov=wa.coverage?.meta||{};
      const op=api.crm_operacao&&typeof api.crm_operacao==='object'?api.crm_operacao:null;
      const invAge=op?.generated_at?now-Date.parse(op.generated_at):NaN;
      items=[consultaItem,
        {rot:'WhatsApp',hora:GUI.sourceTime(cov.ultimo_status_em||wa.ultimo_status_em),estado:wa.coverage?.present?'ok':'falta',
          detalhe:'Última atualização de status (entregue, lido, falha) recebida da Meta no motor próprio. Não inclui Reportana.',texto:'status até'},
        {rot:'Venda',hora:GUI.sourceTime(GUI.sourceMax(api.crm_conversao,'coletado_em')),estado:Array.isArray(api.crm_conversao)?'ok':'falta',
          detalhe:'Última coleta de pedidos atribuídos na Shopify (último clique, data da compra). Vendas depois deste horário ainda não aparecem.',texto:'coletada até'},
        {rot:'E-mail',hora:GUI.sourceTime(GUI.sourceMax(api.crm_diario,'coletado_em')||GUI.sourceMax(api.crm_campanha,'coletado_em')),estado:Array.isArray(api.crm_campanha)?'ok':'falta',
          detalhe:'Última coleta de campanhas e métricas do Listmonk. Automações via SES registram aceite da API, sem entrega individual.',texto:'coletado até'},
        {rot:'Inventário',hora:GUI.sourceTime(op?.generated_at),estado:!op?'falta':Number.isFinite(invAge)&&invAge<900000&&invAge>-60000?'ok':'velho',
          detalhe:'Coleta do estado atual de workflows e templates (a cada 5 min; sinalizado a partir de 15 min). Independe do período selecionado.',texto:'coletado'},
      ];
    }
    el.innerHTML=items.map(i=>`<span class="fonte" data-estado="${i.hora?i.estado:'falta'}" title="${GUI.esc(i.detalhe)}"><b>${GUI.esc(i.rot)}</b> ${i.hora?`${GUI.esc(i.texto)} ${GUI.esc(i.hora)}`:'sem dado'}</span>`).join('');
    return items;
  },
  /* Saúde dos fluxos (shrigma_wa_fluxo_saude, horária): gatilho de e-mail sem linha WhatsApp, aceite sem status
     da Meta, falhas. Só exibe o que a API devolveu; sem a chave, nada aparece (ausência não é saúde). */
  flowHealth(ctx={}){
    const el=GUI.el('#fluxo-saude');if(!el)return [];
    const rows=Array.isArray(ctx.api?.wa_fluxo_saude)?ctx.api.wa_fluxo_saude:null;
    const marca=ctx.marca||'todas';
    const vis=(rows||[]).filter(r=>marca==='todas'||r.brand===marca);
    if(!rows){el.innerHTML='';return [];}
    const alertas=vis.filter(r=>r.estado==='alerta');
    const stamp=v=>GUI.sourceTime(v)||'—';
    el.innerHTML=vis.length?`<div class="fluxo-saude-lista">${vis.map(r=>`<span class="fluxo-chip" data-estado="${GUI.esc(r.estado)}" title="${GUI.esc((r.motivo||'Sem ocorrência na última verificação')+' · verificado '+stamp(r.verificado_em)+(r.alerta_desde?' · em alerta desde '+stamp(r.alerta_desde):''))}">${GUI.esc(r.nome)}${r.estado==='alerta'?' · alerta':''}</span>`).join('')}</div>`
      :`<span class="mini">Sem verificação de fluxo para este recorte.</span>`;
    return alertas;
  },
  attention(ctx={}) {
    const {G,GD,marca='todas',ini='',fim='',canal='todos'}=ctx;
    if(!G || !GD) return null;
    const model=GD.attention(G,ctx.api || {},marca,ini,fim,canal),{wa,rows}=model;
    const el=GUI.el('#automation-attention');
    if(!el) return model;
    const stats=[['falhas','Falhas na entrega'],['erros_sincronos','Erros antes do aceite'],['pendentes_entrega','Aguardando confirmação']];
    const brand=key=>G.MARCA?.[key] || key || 'Sem marca';
    const totals=stats.map(([key,label])=>`<div class="attention-stat${wa[key] > 0 ? key==='pendentes_entrega'?' attention-pending':' attention-occurrence':''}"><strong class="tabn">${GUI.nf(wa[key])}</strong><span>${label}</span></div>`).join('');
    const rowHtml=row=>`<li class="attention-row"><div class="attention-identity"><span class="attention-brand">${GUI.esc(brand(row.marca))} · WhatsApp</span>
      <strong>${GUI.esc(row.piece || 'Sem peça')}</strong><span class="flow-sub">${GUI.esc(row.flow || 'Sem fluxo')}</span>
      <span class="attention-time">Último registro da peça: ${GUI.esc(GUI.timestamp(row.ultimo_registro_em))}</span>
      ${row.dados_incompletos?'<span class="attention-incomplete">Contagem incompleta</span>':''}</div>
      <div class="attention-counts">${stats.map(([key,label])=>`<div><strong class="tabn${row[key] > 0 && key!=='pendentes_entrega'?' attention-count-failure':''}">${GUI.nf(row[key])}</strong><span>${label}</span></div>`).join('')}</div>
      <button type="button" class="refresh-btn attention-jump" data-attention-brand="${GUI.esc(row.marca)}" data-attention-flow="${GUI.esc(row.flow || 'Sem fluxo')}" aria-label="Ver automação ${GUI.esc(row.flow || 'Sem fluxo')} de ${GUI.esc(brand(row.marca))}">Ver automação →</button></li>`;
    const state=!wa.coverage.present?'Dados de WhatsApp indisponíveis nesta consulta; não é possível avaliar as ocorrências.'
      : !wa.coverage.complete?'O período selecionado não está totalmente coberto. Contagens incompletas aparecem como —.'
      : !model.campos_completos?'Algumas contagens não foram informadas pela fonte e aparecem como —.'
      : rows.length?'Peças com ocorrências registradas no período.'
      : 'Nenhuma falha de entrega, erro antes do aceite ou aceite aguardando confirmação registrado neste recorte. Isso não confirma que os fluxos estejam ligados.';
    const waHtml=canal==='email'?'':`<div class="attention-stats">${totals}</div><p class="attention-state">${state}</p>
      ${rows.length?`<ul class="attention-list">${rows.map(rowHtml).join('')}</ul>`:''}
      <details class="attention-details"><summary>O que este acompanhamento permite verificar</summary>
        <p>Falhas e erros pertencem às tentativas registradas neste período; não indicam, sozinhos, uma falha atual da automação. Aguardando confirmação significa que a Meta aceitou a mensagem, mas ainda não há entrega ou falha registrada.</p>
        <p>Registros sem aceite e sem erro, que podem incluir sombra, não entram nas falhas. O último registro é da peça inteira, não necessariamente da ocorrência. Este quadro não informa se o fluxo está ligado nem identifica a causa de cada erro.</p>
        <p>Último registro WhatsApp no recorte: ${GUI.esc(GUI.timestamp(wa.ultimo_registro_em))}. Última atualização de status disponível: ${GUI.esc(GUI.timestamp(wa.ultimo_status_em))}. Horários de Brasília. Não inclui Reportana.</p>
      </details>`;
    const emailHtml=canal==='whatsapp'?'':`<div class="attention-email"><div><strong>E-mail · cobertura do acompanhamento</strong>
      <p>Campanhas Listmonk têm métricas agregadas. Nas automações via SES, esta visão mostra os envios registrados; entrega e falhas individuais ainda não são medidas aqui.</p></div>
      <button type="button" class="refresh-btn" data-attention-email>Ver automações de e-mail →</button></div>`;
    el.innerHTML=`<div class="painel-cab"><h2 id="attention-title">Acompanhamento das automações</h2><span class="mini">Histórico do período</span></div>
      <p class="attention-intro">Envios de ${GUI.esc(GUI.period(ini,fim))} · status disponíveis na consulta. Use os filtros de marca, canal e período para conferir cada operação.</p>${waHtml}${emailHtml}`;
    el.querySelectorAll('[data-attention-flow]').forEach(button=>button.addEventListener('click',()=>{
      if(typeof ctx.onFlows==='function')ctx.onFlows('whatsapp',{marca:button.dataset.attentionBrand,flow:button.dataset.attentionFlow});
    }));
    el.querySelector('[data-attention-email]')?.addEventListener('click',()=>{
      if(typeof ctx.onFlows==='function')ctx.onFlows('email');
    });
    return model;
  },
  flowsState:{q:'',sort:'receita',dir:'desc'},
  flowsColumns:[
    {chave:'piece',rotulo:'Peça'},{chave:'flow',rotulo:'Fluxo'},{chave:'marca',rotulo:'Marca',pega:r=>r.marca},{chave:'canal',rotulo:'Canal'},
    {chave:'enviados',rotulo:'Disparos'},{chave:'entregues',rotulo:'Entregues'},{chave:'falhas',rotulo:'Falhas'},{chave:'lidos',rotulo:'Lidos'},
    {chave:'pendentes_entrega',rotulo:'Aguardando confirmação'},{chave:'sem_disparo_confirmado',rotulo:'Sem disparo confirmado'},{chave:'erros_sincronos',rotulo:'Erros antes do aceite'},
    {chave:'pedidos',rotulo:'Pedidos'},{chave:'receita',rotulo:'Receita'},{chave:'assist',rotulo:'Pedidos assistidos'},{chave:'receita_assist',rotulo:'Receita assistida'},
    {chave:'atribuicao_ambigua',rotulo:'Atribuição ambígua',pega:r=>!!r.atribuicao_ambigua},{chave:'ultimo_registro_em',rotulo:'Último registro'},{chave:'ultimo_status_em',rotulo:'Último status'},
  ],
  flows(ctx={}) {
    const {G,GD,marca='todas',ini='',fim='',canal='todos'}=ctx;
    const api=ctx.api || {};
    if(!G || !GD) return [];
    const rows=GD.flows(G,api,marca,ini,fim,canal);
    const selector=GUI.el('#sel-flow'),search=GUI.el('#regua-busca'),table=GUI.el('#tab-regua'),exportButton=GUI.el('#regua-export');
    const options=[...new Set(rows.map(row=>String(row.flow || 'Sem fluxo')))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
    if(selector) {
      const previous=selector.value;
      selector.innerHTML='<option value="">Todas as automações</option>'+options.map(flow=>`<option value="${GUI.esc(flow)}">${GUI.esc(flow)}</option>`).join('');
      selector.value=options.includes(previous)?previous:'';
    }
    if(search && search.value!==GUI.flowsState.q) search.value=GUI.flowsState.q;
    let lastVisible=[];
    const render=()=>{
      const chosen=selector?.value || '';
      const state=GUI.flowsState;
      const byFlow=chosen?rows.filter(row=>String(row.flow || 'Sem fluxo')===chosen):rows;
      const searched=typeof GT!=='undefined'?GT.busca(byFlow,state.q,['piece','flow',r=>G.MARCA?.[r.marca]||r.marca]):byFlow;
      const visible=typeof GT!=='undefined'?GT.ordena(searched,state.sort,state.dir):searched;
      lastVisible=visible;
      if(typeof GT!=='undefined')GT.marcaCabecalhos(table,state);
      const tbody=GUI.el('#tab-regua tbody');
      const kept=typeof GT!=='undefined'?GT.captura(tbody):null;
      GUI.text('#n-regua',rows.length || '');
      GUI.text('#regua-rot',`${visible.length} peça${visible.length===1?'':'s'}${visible.length!==rows.length?` de ${rows.length}`:''} · ${GUI.period(ini,fim)}`);
      if(exportButton)exportButton.disabled=!visible.length;
      const empty=!rows.length?'Nenhuma automação com registros neste recorte.'
        :chosen&&state.q?`Nenhuma peça de "${GUI.esc(chosen)}" contém "${GUI.esc(state.q)}".`
        :state.q?`Nenhuma peça contém "${GUI.esc(state.q)}" neste recorte.`
        :`Nenhuma peça registrada para "${GUI.esc(chosen)}" no período.`;
      const clear=rows.length&&(chosen||state.q)?' <button type="button" class="refresh-btn gt-limpar" data-flows-clear>Limpar busca e fluxo</button>':'';
      GUI.html('#tab-regua tbody',visible.length?visible.map(row=>{
        const channel=row.canal==='whatsapp'?'whatsapp':'email';
        const brandClass=['fish','aristo','olivas'].includes(row.marca)?row.marca:'nulo';
        const brand=G.MARCA?.[row.marca] || row.marca || 'Sem marca';
        const key=GUI.esc([row.marca,row.canal,row.flow,row.piece].join('|'));
        const details=channel==='whatsapp'
          ? `<details class="flow-extra" data-gt-key="${key}"><summary>Detalhes dos disparos</summary><div>Lidos: ${GUI.nf(row.lidos)} · Aguardando confirmação: ${GUI.nf(row.pendentes_entrega)}<br>
              Sem disparo confirmado: ${GUI.nf(row.sem_disparo_confirmado)} · Erros antes do aceite: ${GUI.nf(row.erros_sincronos)}</div></details>`
          : '<div class="flow-extra">Entrega e falhas individuais não medidas nesta visão.</div>';
        const ambiguous=row.atribuicao_ambigua?'<span class="tag nulo" title="Mais de um fluxo usa esta peça: pedidos e receita existem, mas não têm dono. Aparece em branco, não como zero.">indivisível</span>':'';
        return `<tr><td><div class="flow-name">${GUI.esc(row.piece || 'Sem peça')}</div><div class="flow-sub">${GUI.esc(row.flow || 'Sem fluxo')}</div>${details}</td>
          <td><span class="tag growth-table-tag ${brandClass}">${GUI.esc(brand)}</span><span class="tag ${channel}">${channel==='whatsapp'?'WhatsApp':'E-mail'}</span></td>
          <td class="num tabn">${GUI.nf(row.enviados)}</td><td class="num tabn">${GUI.nf(channel==='whatsapp'?row.entregues:null)}</td>
          <td class="num tabn${channel==='whatsapp'&&+row.falhas>0?' vm':''}">${GUI.nf(channel==='whatsapp'?row.falhas:null)}</td><td class="num tabn">${ambiguous||GUI.nf(row.pedidos)}</td>
          <td class="num tabn destaque">${ambiguous?'':GUI.rf(row.receita)}</td></tr>`;
      }).join(''):`<tr><td colspan="7"><div class="vazio">${empty}${clear}</div></td></tr>`);
      if(kept&&typeof GT!=='undefined')GT.restaura(GUI.el('#tab-regua tbody'),kept);
      GUI.el('#tab-regua [data-flows-clear]')?.addEventListener('click',()=>{GUI.flowsState.q='';if(search)search.value='';if(selector)selector.value='';render();});
      const anomalies=(G.REGUA_ANOMALIAS || []).filter(a=>canal!=='whatsapp' && a.dia>=ini && a.dia<=fim && (marca==='todas' || a.marca===marca));
      GUI.html('#nota-regua',`Disparos de WhatsApp são mensagens aceitas pela Meta; sombra e tentativas sem aceite ficam nos detalhes. Não inclui Reportana. Automações de e-mail são envios registrados via SES; entrega e falhas individuais aparecem como —.<br>
        Pedidos e receita seguem a data da compra e a atribuição por último clique à peça. Não são conversão dos envios deste período. Busca, fluxo e ordenação alteram somente esta tabela e a exportação.`+
        anomalies.map(a=>`<div class="metric-note"><strong>${GUI.date(a.dia)} · ${GUI.esc(G.MARCA?.[a.marca] || a.marca)} · ${GUI.esc(a.piece)}:</strong> ${GUI.esc(a.motivo)}.</div>`).join(''));
      return visible;
    };
    if(selector) selector.onchange=render;
    if(search) search.oninput=()=>{GUI.flowsState.q=search.value;render();};
    if(table) table.querySelectorAll('th[data-sort]').forEach(th=>{th.onclick=()=>{
      if(typeof GT==='undefined')return;
      GUI.flowsState={...GUI.flowsState,...GT.proximaOrdem(GUI.flowsState,th.dataset.sort,th.classList.contains('num'))};render();};});
    if(exportButton) exportButton.onclick=()=>{
      if(typeof GT==='undefined'||typeof ctx.exportMeta!=='function')return;
      const meta=ctx.exportMeta({fluxo:selector?.value||'todos',busca:GUI.flowsState.q||''});
      const csvRows=lastVisible.map(r=>({...r,marca:G.MARCA_CHEIA?.[r.marca]||G.MARCA?.[r.marca]||r.marca,
        pedidos:r.atribuicao_ambigua?null:r.pedidos,receita:r.atribuicao_ambigua?null:r.receita,assist:r.atribuicao_ambigua?null:r.assist,receita_assist:r.atribuicao_ambigua?null:r.receita_assist}));
      GT.baixar(GT.nomeArquivo('automacoes',meta),GT.csv(GUI.flowsColumns,csvRows,meta));
    };
    render();
    return rows;
  },
};
if(typeof module !== 'undefined' && module.exports) module.exports=GUI;
