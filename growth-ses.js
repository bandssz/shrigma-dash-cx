/* SES: unique accepted dispatches, grouped by send day within measured intervals. */
'use strict';
const GSES = {
  fields:['aceitos','enviados_ses','entregues','hard','soft','recusados_ses','falhas','reclamacoes','atrasos','sem_confirmacao_final'],
  count(v) { return typeof v==='number' && Number.isSafeInteger(v) && v>=0 ? v : null; },
  day(v) {
    const d=new Date(v || '');
    return Number.isFinite(d.valueOf()) ? new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(d) : null;
  },
  model(api,marca,ini,fim,now=Date.now()) {
    const p=api?.crm_email_ses;
    if(p?.schema_version!==1 || !Array.isArray(p.rows) || !Array.isArray(p.coverage) || !Number.isFinite(Date.parse(p.generated_at)))return null;
    const brand=r=>r && (['todas','todos'].includes(marca) || r.marca===marca);
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
    if(!m){el.innerHTML=heading+'<div class="nota">Métricas de entrega indisponíveis nesta consulta.</div>';return;}
    const esc=ui.esc,labels={fish:'Fishermans',aristo:'Aristocrata'};
    const name=r=>esc(labels[r.marca] || r.marca);
    const states={partial:'Parcial',instrumented:'Instrumentado',interrupted:'Interrompido'};
    const metric=(label,key,note)=>`<div class="ses-metric"><span>${label}</span><strong>${ui.nf(m.totals[key])}</strong><small>${note}</small></div>`;
    el.innerHTML=heading+`
      <p class="ses-summary">Automações com medição · agrupadas pelo dia do envio · ${esc(ui.period(ini,fim))}</p>
      ${m.stale?'<div class="nota" role="status">Esta consulta tem mais de 15 minutos. Atualize o painel para buscar novos eventos.</div>':''}
      <div class="ses-metrics">${metric('Aceitos pelo emissor','aceitos','Ainda não confirma entrega')}${metric('Entregues','entregues','Servidor do destinatário confirmou')}${metric('Falhas observadas','falhas','Devolução ou recusa do SES')}${metric('Sem confirmação final','sem_confirmacao_final','Aguardando entrega ou falha')}</div>
      <div class="rolagem"><table class="comparativo"><thead><tr><th>Marca / fluxo</th><th>Etapa</th><th class="num">Aceitos</th><th class="num">Envio SES</th><th class="num">Entregues</th><th class="num">Falhas</th><th class="num">Sem confirmação</th></tr></thead><tbody>${m.rows.length?m.rows.map(r=>`<tr><td>${name(r)}<br><span class="mini">${esc(r.flow)}</span></td><td>${esc(r.piece)}</td>${['aceitos','enviados_ses','entregues','falhas','sem_confirmacao_final'].map(k=>`<td class="num">${ui.nf(r[k])}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="7">${m.coverage.length?'Nenhum envio medido neste recorte. A cobertura é parcial.':'Período sem cobertura de medição para a marca selecionada.'}</td></tr>`}</tbody></table></div>
      <div class="nota">Na base medida: ${ui.nf(m.totals.hard)} devoluções permanentes, ${ui.nf(m.totals.soft)} temporárias, ${ui.nf(m.totals.recusados_ses)} recusas do SES, ${ui.nf(m.totals.reclamacoes)} reclamações e ${ui.nf(m.totals.atrasos)} atrasos. Atraso não é falha definitiva. Um envio pode ter mais de um resultado ao longo do tempo; estas contagens não se somam.</div>
      <details class="ses-coverage"><summary>Cobertura por fluxo · ${m.coverage.length} intervalos neste recorte</summary><div class="rolagem"><table class="comparativo"><thead><tr><th>Marca / fluxo</th><th>Etapa</th><th>Início da medição</th><th>Fim</th><th>Estado</th></tr></thead><tbody>${m.coverage.map(c=>`<tr><td>${name(c)}<br><span class="mini">${esc(c.flow)}</span></td><td>${esc(c.piece)}</td><td>${esc(ui.timestamp(c.starts_at))}</td><td>${c.ends_at?esc(ui.timestamp(c.ends_at)):'Em andamento'}</td><td>${esc(states[c.state] || 'Não informado')}</td></tr>`).join('') || '<tr><td colspan="5">Sem intervalo de medição neste período.</td></tr>'}</tbody></table></div></details>
      <div class="nota">Entrega confirma o recebimento pelo servidor, não a abertura. Cada envio conta uma vez em cada resultado. Eventos posteriores atualizam o dia original do envio. Testes, eventos sem conciliação e envios fora dos intervalos medidos ficam fora. O período anterior à ativação não tem histórico de entrega nesta leitura.</div>
      <p class="mini ses-updated">Consulta: ${esc(ui.timestamp(m.generated_at))} · horários de Brasília</p>`;
  },
};
if(typeof module!=='undefined')module.exports=GSES;
