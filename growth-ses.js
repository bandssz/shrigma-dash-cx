/* SES: unique accepted dispatches, grouped by send day within measured intervals. */
'use strict';
const GSES = {
  fields:['aceitos','enviados_ses','entregues','hard','soft','recusados_ses','falhas','reclamacoes','atrasos','sem_confirmacao_final'],
  count(v) { return typeof v==='number' && Number.isSafeInteger(v) && v>=0 ? v : null; },
  health(api,marca,now=Date.now()) {
    const h=api?.crm_email_ses?.health,alerts=[];
    const snapshot=Date.parse(h?.checked_at),snapshotAge=now-snapshot;
    if(h?.schema_version!==1||!Array.isArray(h.brands)||!Number.isFinite(snapshot)||snapshotAge < -60000)return {alerts:[{level:'warning',text:'Saúde da coleta sem consulta válida. Atualize o painel.'}]};
    // Heartbeats and queue size belong to this snapshot. Cache age is a separate signal.
    const age=t=>{const n=Date.parse(t);return Number.isFinite(n)&&n<=snapshot+60000?Math.max(0,snapshot-n):null;};
    const stale=snapshotAge>15*60000;
    if(stale)alerts.push({level:'warning',text:'Consulta de saúde com mais de 15 minutos. Atualize o painel; os avisos abaixo descrevem a última consulta.'});
    const pollAge=age(h.collector?.last_poll_ok_at),errorAge=age(h.collector?.last_error_at);
    if(pollAge===null)alerts.push({level:'warning',text:'Ainda sem confirmação de funcionamento do coletor.'});
    else if(pollAge>5*60000)alerts.push({level:'danger',text:'Na consulta, o coletor estava sem confirmação há mais de cinco minutos. As entregas podem estar desatualizadas.'});
    else alerts.push({level:stale?'info':'ok',text:'Consulta à fila confirmada nos cinco minutos anteriores à consulta de saúde.'});
    const q=h.queue,queueAge=age(q?.checked_at),queueError=age(q?.error_at);
    if(queueAge===null||queueAge>5*60000||['visible','inflight','delayed'].some(k=>GSES.count(q?.[k])===null)||queueError!==null&&Date.parse(q.error_at)>Date.parse(q.checked_at))alerts.push({level:'warning',text:'Tamanho da fila sem medição atual confirmada.'});
    else alerts.push({level:q.visible>=100?'warning':'info',text:'Fila SES: aproximadamente '+q.visible+' eventos aguardando, '+q.inflight+' em processamento e '+q.delayed+' com espera programada.'});
    if(errorAge!==null&&errorAge<15*60000)alerts.push({level:'danger',text:'Houve falha no processamento da coleta nos 15 minutos anteriores à consulta de saúde.'});
    for(const [key,label] of [['pending_ingest_15min','eventos aguardam conciliação há mais de 15 minutos'],['conflicts','eventos apresentam conflito de conciliação']]) {
      const n=GSES.count(h[key]);if(n===null)alerts.push({level:'warning',text:'Contagem de '+label+' indisponível.'});else if(n)alerts.push({level:'danger',text:n+' '+label+'.'});
    }
    for(const brand of ['fish','aristo'].filter(b=>['todas','todos'].includes(marca)||b===marca)) {
      const rows=h.brands.filter(r=>r?.marca===brand),r=rows[0],label=brand==='fish'?'Fishermans':'Aristocrata';
      const fields=['finalizacao_pendente','entregue_sem_gravacao','resultado_incerto','sem_confirmacao_15min','falhas_24h','reclamacoes_24h'];
      if(rows.length!==1||fields.some(k=>GSES.count(r?.[k])===null)){alerts.push({level:'warning',text:label+': diagnóstico de envios indisponível.'});continue;}
      if(r.finalizacao_pendente||r.entregue_sem_gravacao)alerts.push({level:'danger',text:label+': '+r.finalizacao_pendente+' envios com gravação pendente há mais de 15 minutos.'+(r.entregue_sem_gravacao?' '+r.entregue_sem_gravacao+' com entrega confirmada pelo SES e registro incompleto.':'')});
      if(r.resultado_incerto)alerts.push({level:'danger',text:label+': '+r.resultado_incerto+' envios com resultado incerto. Exigem conciliação antes de qualquer nova tentativa.'});
      if(r.sem_confirmacao_15min)alerts.push({level:'warning',text:label+': '+r.sem_confirmacao_15min+' envios aceitos nas últimas 24h aguardam confirmação final há mais de 15 minutos.'});
      if(r.falhas_24h)alerts.push({level:'warning',text:label+': '+r.falhas_24h+' falhas em envios iniciados nas últimas 24h.'});
      if(r.reclamacoes_24h)alerts.push({level:'danger',text:label+': '+r.reclamacoes_24h+(r.reclamacoes_24h===1?' reclamação':' reclamações')+' em envios iniciados nas últimas 24h.'});
    }
    return {alerts,checked_at:h.checked_at,stale};
  },
  healthHtml(api,marca,ui) {
    const h=GSES.health(api,marca);
    return `<div class="ses-health" role="status"><strong>Saúde da operação na última consulta</strong><p class="mini">${h.checked_at?`Consulta: ${ui.esc(ui.timestamp(h.checked_at))} · horário de Brasília · `:''}Atualizada junto aos dados do painel, a cada dez minutos · independe do período selecionado · cobertura parcial</p>${h.alerts.map(a=>`<p class="ses-health-${a.level}">${ui.esc(a.text)}</p>`).join('')}</div>`;
  },
  day(v) {
    const d=new Date(v || '');
    return Number.isFinite(d.valueOf()) ? new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(d) : null;
  },
  model(api,marca,ini,fim,now=Date.now()) {
    const p=api?.crm_email_ses;
    if(p?.schema_version!==1 || !Array.isArray(p.rows) || !Array.isArray(p.coverage) || !Number.isFinite(Date.parse(p.generated_at)))return null;
    const brand=r=>r && r.is_test!==true && (['todas','todos'].includes(marca) || r.marca===marca);
    const coverage=p.coverage.filter(c=>brand(c) && GSES.day(c.starts_at) && GSES.day(c.starts_at)<=fim && (!c.ends_at || GSES.day(c.ends_at)>=ini));
    const map=new Map();
    for(const r of p.rows) {
      if(!brand(r) || typeof r.dia!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.dia) || r.dia<ini || r.dia>fim)continue;
      // A row without a matching declared measurement interval is not a measured zero.
      const intervals=coverage.filter(c=>c.marca===r.marca && c.flow===r.flow && c.piece===r.piece && GSES.day(c.starts_at)<=r.dia && (!c.ends_at || GSES.day(c.ends_at)>=r.dia));
      if(!intervals.length)continue;
      const key=JSON.stringify([r.marca,r.flow,r.piece]);
      if(!map.has(key))map.set(key,{marca:r.marca,flow:r.flow,piece:r.piece,...Object.fromEntries(GSES.fields.map(k=>[k,0]))});
      const item=map.get(key);
      for(const k of GSES.fields) {const n=GSES.count(r[k]);item[k]=item[k]===null || n===null ? null : GSES.count(item[k]+n);}
    }
    const rows=[...map.values()];
    const totals=Object.fromEntries(GSES.fields.map(k=>[k,rows.length ? rows.reduce((n,r)=>n===null || r[k]===null ? null : GSES.count(n+r[k]),0) : null]));
    return {rows,totals,coverage,generated_at:p.generated_at,stale:now-Date.parse(p.generated_at)>15*60*1000};
  },
  render(api,marca,ini,fim,canal,ui) {
    const el=ui.el('#ses-delivery');if(!el)return;
    el.hidden=canal==='whatsapp';if(el.hidden)return;
    const m=GSES.model(api,marca,ini,fim);
    const heading='<div class="painel-cab"><h2>E-mail · entregas confirmadas</h2><span class="chip d-neutro">Cobertura parcial</span></div>';
    if(!m){el.innerHTML=heading+'<div class="nota">Métricas de entrega indisponíveis nesta consulta. Atualize o painel; se persistir, confira a coleta de e-mail.</div>';return;}
    const esc=ui.esc,labels={fish:'Fishermans',aristo:'Aristocrata'};
    const name=r=>esc(labels[r.marca] || r.marca);
    const states={partial:'Parcial',instrumented:'Instrumentado',interrupted:'Interrompido'};
    const metric=(label,key,note)=>`<div class="ses-metric"><span>${label}</span><strong>${ui.nf(m.totals[key])}</strong><small>${note}</small></div>`;
    el.innerHTML=heading+GSES.healthHtml(api,marca,ui)+`
      <p class="ses-summary">Automações com medição · agrupadas pelo dia do envio · ${esc(ui.period(ini,fim))}</p>
      ${m.stale?'<div class="nota" role="status">Esta consulta tem mais de 15 minutos. Atualize o painel para buscar novos eventos.</div>':''}
      <div class="ses-metrics">${metric('Aceitos pelo emissor','aceitos','Ainda não confirma entrega')}${metric('Entregues','entregues','Servidor do destinatário confirmou')}${metric('Falhas observadas','falhas','Devolução ou recusa do SES')}${metric('Sem confirmação final','sem_confirmacao_final','Aguardando entrega ou falha')}</div>
      <div class="rolagem"><table class="comparativo"><thead><tr><th>Marca / fluxo</th><th>Etapa</th><th class="num">Aceitos</th><th class="num">Envio SES</th><th class="num">Entregues</th><th class="num">Falhas</th><th class="num">Sem confirmação</th></tr></thead><tbody>${m.rows.length?m.rows.map(r=>`<tr><td>${name(r)}<br><span class="mini">${esc(r.flow)}</span></td><td>${esc(r.piece)}</td>${['aceitos','enviados_ses','entregues','falhas','sem_confirmacao_final'].map(k=>`<td class="num">${ui.nf(r[k])}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="7">${m.coverage.length?'Nenhum envio medido neste recorte. Experimente ampliar o período; a cobertura é parcial.':'Período sem cobertura de medição para a marca selecionada. Amplie o período ou confira a marca selecionada.'}</td></tr>`}</tbody></table></div>
      <div class="nota">Na base medida: ${ui.nf(m.totals.hard)} devoluções permanentes, ${ui.nf(m.totals.soft)} temporárias, ${ui.nf(m.totals.recusados_ses)} recusas do SES, ${ui.nf(m.totals.reclamacoes)} reclamações e ${ui.nf(m.totals.atrasos)} atrasos. Atraso não é falha definitiva. Um envio pode ter mais de um resultado ao longo do tempo; estas contagens não se somam.</div>
      <details class="ses-coverage"><summary>Cobertura por fluxo · ${m.coverage.length} intervalos neste recorte</summary><div class="rolagem"><table class="comparativo"><thead><tr><th>Marca / fluxo</th><th>Etapa</th><th>Início da medição</th><th>Fim</th><th>Estado</th></tr></thead><tbody>${m.coverage.map(c=>`<tr><td>${name(c)}<br><span class="mini">${esc(c.flow)}</span></td><td>${esc(c.piece)}</td><td>${esc(ui.timestamp(c.starts_at))}</td><td>${c.ends_at?esc(ui.timestamp(c.ends_at)):'Em andamento'}</td><td>${esc(states[c.state] || 'Não informado')}</td></tr>`).join('') || '<tr><td colspan="5">Sem intervalo de medição neste período.</td></tr>'}</tbody></table></div></details>
      <div class="nota">Entrega confirma o recebimento pelo servidor, não a abertura. Cada envio conta uma vez em cada resultado. Eventos posteriores atualizam o dia original do envio. Testes, eventos sem conciliação e envios fora dos intervalos medidos ficam fora. O período anterior à ativação não tem histórico de entrega nesta leitura.</div>
      <p class="mini ses-updated">Consulta: ${esc(ui.timestamp(m.generated_at))} · horários de Brasília</p>`;
  },
};
if(typeof module!=='undefined')module.exports=GSES;
