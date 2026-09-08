/* Operação atual: somente leitura. Não converte configuração ou coleta em prova de entrega. */
'use strict';
const GC={
  activeTab:'history',search:'',
  esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));},
  object(value){return !!value && typeof value==='object' && !Array.isArray(value);},
  text(value,fallback='Não informado'){return typeof value==='string' && value.trim()?value:fallback;},
  time(value){return typeof value==='string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value)?Date.parse(value):NaN;},
  stamp(value){const time=GC.time(value);return Number.isFinite(time)?new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(time)):'Não disponível';},
  fresh(value,now){const time=GC.time(value);return Number.isFinite(time) && time<=now+60000 && now-time<900000;},
  brand(key){return {fish:'Fishermans',aristo:'O Aristocrata',olivas:'Olivas do Campo',shared:'Compartilhado'}[key] || 'Marca não informada';},
  channel(key){return {whatsapp:'WhatsApp',email:'E-mail',shared:'Todos os canais'}[key] || 'Canal não informado';},
  badge(label,tone='neutral'){return `<span class="control-badge control-${tone}">${GC.esc(label)}</span>`;},
  collection(row,meta,now){
    if(row.collection_status==='error')return {key:'error',tone:'warning',label:'Falha na consulta',current:false};
    if(row.collection_status!=='ok')return {key:'unknown',tone:'neutral',label:'Consulta não confirmada',current:false};
    if(!Number.isFinite(GC.time(row.checked_at)) || !Number.isFinite(GC.time(row.last_good_at)))return {key:'invalid',tone:'warning',label:'Data de coleta inválida',current:false};
    if(!meta.current || !GC.fresh(row.checked_at,now) || !GC.fresh(row.last_good_at,now))return {key:'stale',tone:'warning',label:'Dados desatualizados',current:false};
    return {key:'ok',tone:'info',label:'Consulta atual',current:true};
  },
  model(raw,ctx={}){
    const now=Number.isFinite(ctx.now)?ctx.now:Date.now(),marca=ctx.marca || 'todas',canal=ctx.canal || 'todos';
    const valid=GC.object(raw) && raw.schema_version===1 && Array.isArray(raw.workflows) && Array.isArray(raw.templates);
    const collectionMode=valid&&['manual','automatic'].includes(raw.collection_mode)?raw.collection_mode:'unknown';
    const metadataValid=valid && raw.stale_after_seconds===900 && (collectionMode==='manual'?raw.refresh_interval_seconds===0:collectionMode==='automatic'?raw.refresh_interval_seconds===300:raw.collection_mode===undefined && [0,300].includes(raw.refresh_interval_seconds));
    const meta={valid,metadataValid,collectionMode,current:!!metadataValid && GC.fresh(raw.generated_at,now),generated_at:valid?raw.generated_at:null};
    const scoped=row=>(marca==='todas'||row.brand===marca||row.brand==='shared') && (canal==='todos'||row.channel===canal||row.channel==='shared');
    const workflows=(valid?raw.workflows:[]).filter(GC.object).filter(scoped).map(row=>{
      const collection=GC.collection(row,meta,now);
      const modes=Array.isArray(row.modes)?row.modes.filter(GC.object).map(mode=>({key:GC.text(mode.key,'Modo'),value:['real','sombra','interno'].includes(mode.value)?mode.value:'unknown'})):[];
      const retention=GC.object(row.retention)?row.retention:{};
      const fieldsValid=typeof row.key==='string' && !!row.key.trim() && ['fish','aristo','shared'].includes(row.brand)
        && ['whatsapp','email','shared'].includes(row.channel) && typeof row.label==='string' && !!row.label.trim()
        && typeof row.active==='boolean' && typeof row.published==='boolean' && Array.isArray(row.modes)
        && (row.modes.length===modes.length) && modes.every(mode=>mode.value!=='unknown')
        && (['all','none','unknown'].includes(retention.success)) && (['all','none','unknown'].includes(retention.error));
      return {...row,modes,retention,collection,fieldsValid,attention:!collection.current||!fieldsValid||row.has_unpublished_changes===true};
    });
    const templates=(valid && canal!=='email'?raw.templates:[]).filter(GC.object).filter(row=>marca==='todas'||row.brand===marca).map(row=>{
      const collection=GC.collection(row,meta,now),status=GC.text(row.status,'Desconhecido'),category=GC.text(row.category,'Desconhecida');
      const expectedKnown=['UTILITY','MARKETING','AUTHENTICATION'].includes(row.expected_category);
      const categoryKnown=['UTILITY','MARKETING','AUTHENTICATION'].includes(category);
      const mismatch=expectedKnown && categoryKnown && category!==row.expected_category;
      const fieldsValid=expectedKnown && categoryKnown && ['current','native_pending'].includes(row.usage)
        && typeof row.key==='string' && !!row.key.trim() && typeof row.id==='string' && /^\d+$/.test(row.id)
        && ['fish','aristo'].includes(row.brand) && row.channel==='whatsapp' && typeof row.piece==='string' && !!row.piece.trim()
        && typeof row.category_matches_expected==='boolean' && row.category_matches_expected===(category===row.expected_category)
        && typeof row.name==='string' && row.name.trim().length>0 && typeof row.language==='string' && row.language.trim().length>0;
      const eligible=collection.current && fieldsValid && status==='APPROVED' && !mismatch;
      return {...row,status,category,collection,fieldsValid,mismatch,eligible,attention:!eligible};
    });
    const invalidRows=valid?(raw.workflows.filter(row=>!GC.object(row)).length+raw.templates.filter(row=>!GC.object(row)).length):0;
    return {meta,marca,canal,workflows,templates,invalidRows,
      issues:workflows.filter(row=>row.attention).length+templates.filter(row=>row.attention).length,
      shared:workflows.filter(row=>row.brand==='shared').length};
  },
  metadata(model){
    const {meta}=model;
    let state=!meta.valid?'Operação atual indisponível nesta consulta.'
      :!meta.metadataValid?'A coleta retornou informações de atualização incompletas.'
      :!meta.current?'A coleta está desatualizada ou tem uma data inválida.'
      :'Estado consultado nas fontes de automação e templates.';
    const schedule=meta.collectionMode==='automatic'?'Coleta automática a cada 5 minutos.':meta.collectionMode==='manual'?'Conferência pontual · atualização automática pendente.':'Periodicidade de coleta não confirmada.';
    return `<div class="control-context"><div><strong>Estado atual · independente do período acima</strong><p>${GC.esc(state)}</p><p>${GC.esc(schedule)} Dados com 15 minutos ou mais são sinalizados.</p></div>
      <div class="control-updated">Coleta de referência<br><strong>${GC.esc(GC.stamp(meta.generated_at))}</strong><span>Horário de Brasília</span></div></div>
      ${model.invalidRows?'<p class="control-warning">Parte dos registros veio em formato inválido e não pôde ser apresentada.</p>':''}`;
  },
  collectionDetails(row){
    return `<div class="control-collected">Consulta: ${GC.esc(GC.stamp(row.checked_at))}${!row.collection.current?`<br>Última consulta válida: ${GC.esc(GC.stamp(row.last_good_at))}`:''}</div>`;
  },
  modeLabel(mode){return {modo:'Envio',modo_pedido_pago:'Pedido pago',modo_rastreio:'Rastreio',fish:'Fishermans',aristo:'O Aristocrata'}[mode.key] || mode.key;},
  workflow(row){
    const e=GC.esc,current=row.collection.current;
    const active=typeof row.active==='boolean'?(row.active?'Ativo':'Inativo'):'Ativação desconhecida';
    const published=typeof row.published==='boolean'?(row.published?'Versão publicada':'Sem versão publicada'):'Publicação não confirmada';
    const modes=row.modes.map(mode=>`${GC.modeLabel(mode)}: ${{real:'real',sombra:'sombra',interno:'interno',unknown:'não confirmado'}[mode.value]}`).join(' · ');
    const execution=GC.object(row.last_retained_execution)?row.last_retained_execution:null;
    const status=execution?({success:'Concluída',error:'Erro registrado',running:'Em execução',waiting:'Aguardando',canceled:'Cancelada',crashed:'Interrompida',new:'Nova',unknown:'Não confirmado'}[execution.status] || 'Não confirmado'):null;
    const retention=kind=>({all:'Salvas',none:'Não salvas',unknown:'Não confirmado'}[row.retention[kind]] || 'Não confirmado');
    return `<article class="control-workflow" data-control-workflow="${e(row.key)}"><div class="control-workflow-head"><div><span class="control-overline">${e(GC.brand(row.brand))} · ${e(GC.channel(row.channel))}</span><h3>${e(GC.text(row.label,'Automação sem nome'))}</h3></div>${GC.badge(row.collection.label,row.collection.tone)}</div>
      <div class="control-config">${GC.badge(active,current&&row.fieldsValid&&row.active===true?'info':'neutral')}${GC.badge(published)}${row.has_unpublished_changes===true?GC.badge('Alterações ainda não publicadas','warning'):''}</div>
      <p class="control-mode">${e(modes || (row.mode_source==='upstream'?'Segue o modo da automação de origem':row.mode_source==='per_request'?'Modo definido a cada solicitação de envio':row.mode_source==='none'?'Este serviço não define um modo de envio':'Modo de envio não informado'))}</p>
      ${!current?'<p class="control-warning">Os valores disponíveis são da última coleta; o estado atual não está confirmado.</p>':''}
      ${!row.fieldsValid?'<p class="control-warning">Há campos de configuração não confirmados.</p>':''}
      ${GC.collectionDetails(row)}
      <details class="control-detail"><summary>Última execução retida e registros</summary><p>${execution?`${e(status)} · início ${e(GC.stamp(execution.started_at))}${execution.stopped_at?` · término ${e(GC.stamp(execution.stopped_at))}`:''}`:'Nenhuma execução retida foi informada pela fonte.'}</p>
      <p>Execuções concluídas: ${e(retention('success'))}. Execuções com erro: ${e(retention('error'))}.</p>
      <p>${row.retention.success==='none'?'Este fluxo não salva execuções concluídas; uma execução antiga com erro pode continuar sendo a última retida.':'A última execução retida pode não representar a última atividade do fluxo.'} Esse registro não comprova entrega ao cliente.</p></details></article>`;
  },
  template(row){
    const e=GC.esc,current=row.collection.current;
    let note=row.usage==='native_pending'?'Integração pendente · ainda fora do envio':'Mapeado no fluxo · envio depende da ativação';
    if(!['current','native_pending'].includes(row.usage))note='Uso não confirmado';
    const alerts=[];
    if(row.mismatch)alerts.push(`Categoria recebida: ${row.category}; esperada: ${row.expected_category}.`);
    if(row.status!=='APPROVED')alerts.push(`Status recebido: ${row.status}; aprovação não confirmada.`);
    if(!row.fieldsValid)alerts.push('Há campos do template não confirmados.');
    const statusTone=current && row.fieldsValid && row.status!=='APPROVED'?'warning':row.eligible && row.usage==='current'?'verified':'neutral';
    const categoryTone=current && row.mismatch?'warning':row.eligible && row.usage==='current'?'verified':'neutral';
    return `<tr data-control-template="${e(row.key)}"><td><strong class="control-template-piece">${e(GC.text(row.piece,'Peça não informada'))}</strong><code>${e(GC.text(row.name,'Nome não informado'))}</code><span class="control-template-meta">${e(GC.brand(row.brand))} · ${e(GC.text(row.language,'Idioma não informado'))}</span></td>
      <td>${GC.badge(row.status,statusTone)}${GC.badge(row.category,categoryTone)}<span class="control-template-meta">Esperada: ${e(GC.text(row.expected_category,'Não informada'))}</span></td>
      <td><span class="control-usage${row.usage==='native_pending'?' control-planned':''}">${e(note)}</span>${alerts.map(alert=>`<p class="control-warning">${e(alert)}</p>`).join('')}</td>
      <td>${GC.badge(row.collection.label,row.collection.tone)}${GC.collectionDetails(row)}</td></tr>`;
  },
  render(ctx={}){
    const model=GC.model(ctx.api?.crm_operacao,ctx);
    if(typeof document==='undefined')return model;
    const workflowRoot=document.querySelector('#control-workflows'),templateRoot=document.querySelector('#control-templates');
    if(!workflowRoot||!templateRoot)return model;
    const openDetails=[...workflowRoot.querySelectorAll('[data-control-workflow]')].filter(card=>card.querySelector('details')?.open).map(card=>card.dataset.controlWorkflow);
    const oldInput=templateRoot.querySelector('#control-template-search'),restoreInput=oldInput&&document.activeElement===oldInput;
    const selection=restoreInput?[oldInput.selectionStart,oldInput.selectionEnd]:null;
    const e=GC.esc;
    const brandSpecific=model.marca!=='todas' && !model.workflows.some(row=>row.brand===model.marca);
    workflowRoot.innerHTML=GC.metadata(model)+`<div class="control-summary"><div><strong>${model.meta.valid?model.workflows.length:'—'}</strong><span>Automações acompanhadas</span></div><div><strong>${model.meta.valid?model.workflows.filter(row=>row.collection.current&&row.active===true).length:'—'}</strong><span>Ativas na coleta atual</span></div><div><strong>${model.meta.valid?model.workflows.filter(row=>row.attention).length:'—'}</strong><span>Consultas ou campos a conferir</span></div></div>
      <p class="control-explainer">Ativo indica configuração ligada; não confirma funcionamento ou entrega. O modo sombra não faz disparos reais. Serviços compartilhados aparecem também no filtro de cada marca.</p>
      ${brandSpecific?`<p class="control-scope">Nenhuma automação específica de ${e(GC.brand(model.marca))} foi informada neste canal.${model.shared?' Abaixo estão os serviços compartilhados.':''}</p>`:''}
      <div class="control-workflows">${model.workflows.length?model.workflows.map(GC.workflow).join(''):'<div class="vazio">Nenhuma automação disponível para estes filtros. Ausência de dados não confirma ausência de automações.</div>'}</div>`;
    const search=GC.search.toLocaleLowerCase('pt-BR'),templates=model.templates.filter(row=>[row.name,row.piece,GC.brand(row.brand)].some(value=>String(value||'').toLocaleLowerCase('pt-BR').includes(search)));
    templateRoot.innerHTML=GC.metadata(model)+`<p class="control-explainer">Status e categoria consultados na Meta. Um template mapeado pode pertencer a um fluxo em sombra; aprovação não comprova envio. Cartões de pedido com integração pendente continuam fora do envio.</p>
      ${model.canal==='email'?'<div class="vazio">Este catálogo acompanha templates de WhatsApp. Selecione WhatsApp ou Todos os canais no filtro acima.</div>':`<div class="control-template-toolbar"><label for="control-template-search">Buscar template<input type="search" id="control-template-search" placeholder="Nome ou peça" value="${e(GC.search)}"></label><span>${templates.length} de ${model.templates.length} templates neste recorte</span></div><div class="rolagem"><table class="comparativo control-template-table"><thead><tr><th>Template / marca</th><th>Status e categoria</th><th>Uso</th><th>Consulta</th></tr></thead><tbody>${templates.length?templates.map(GC.template).join(''):'<tr><td colspan="4"><div class="vazio">Nenhum template disponível para estes filtros.</div></td></tr>'}</tbody></table></div>`}
      <p class="control-future">Próxima etapa: criar e versionar templates, acompanhar submissões e gerenciar workflows de WhatsApp, Listmonk e SES pelo painel.</p>`;
    workflowRoot.querySelectorAll('[data-control-workflow]').forEach(card=>{if(openDetails.includes(card.dataset.controlWorkflow))card.querySelector('details').open=true;});
    const input=templateRoot.querySelector('#control-template-search');
    if(restoreInput&&input){input.focus();input.setSelectionRange?.(...selection);}
    if(input)input.oninput=()=>{const position=input.selectionStart;GC.search=input.value;GC.render(ctx);const next=templateRoot.querySelector('#control-template-search');next?.focus();next?.setSelectionRange?.(position,position);};
    GC.setTab(GC.activeTab);
    return model;
  },
  setTab(tab){
    if(!['history','workflows','templates'].includes(tab))return;
    GC.activeTab=tab;
    if(typeof document==='undefined')return;
    document.querySelectorAll('[data-control-tab]').forEach(button=>{const selected=button.dataset.controlTab===tab;button.classList.toggle('ativo',selected);button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
    document.querySelectorAll('[data-control-panel]').forEach(panel=>{panel.hidden=panel.dataset.controlPanel!==tab;});
  },
  init(){
    if(typeof document==='undefined')return;
    const buttons=[...document.querySelectorAll('[data-control-tab]')];
    buttons.forEach((button,index)=>{button.onclick=()=>GC.setTab(button.dataset.controlTab);button.onkeydown=event=>{let next;if(event.key==='ArrowRight')next=(index+1)%buttons.length;else if(event.key==='ArrowLeft')next=(index+buttons.length-1)%buttons.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=buttons.length-1;else return;event.preventDefault();GC.setTab(buttons[next].dataset.controlTab);buttons[next].focus();};});
    GC.setTab(GC.activeTab);
  },
};
if(typeof module!=='undefined'&&module.exports)module.exports=GC;
