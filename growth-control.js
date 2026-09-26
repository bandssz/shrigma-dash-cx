/* Operação atual: somente leitura. Não converte configuração ou coleta em prova de entrega. */
'use strict';
const GC={
  activeTab:'history',search:'',
  /* Filtros vivem aqui, não no DOM: a reconsulta a cada 60 s redesenha o painel inteiro
     e o que a pessoa escolheu tem que sobreviver ao redesenho. */
  filters:{wf:{q:'',estado:'todas',modo:'todos'},tpl:{status:'todos',categoria:'todas',uso:'todos',sort:'piece',dir:'asc'}},
  ESTADOS_WF:[['todas','Todas'],['ativas','Ativas'],['inativas','Inativas'],['conferir','A conferir']],
  MODOS_WF:[['todos','Qualquer modo'],['real','Envio real'],['sombra','Simulação'],['interno','Teste interno'],['segue-origem','Sem modo próprio'],['nao-confirmado','Modo não confirmado']],
  STATUS_TPL:[['todos','Qualquer status'],['APPROVED','Aprovado'],['outros','Não aprovado']],
  CATEGORIAS_TPL:[['todas','Qualquer categoria'],['UTILITY','Utilidade'],['MARKETING','Marketing'],['AUTHENTICATION','Autenticação'],['divergente','Categoria divergente']],
  USOS_TPL:[['todos','Qualquer uso'],['current','Mapeado no fluxo'],['native_pending','Integração pendente'],['optional','Opcional'],['retired','Retirado'],['available','Disponível'],['configured_paused','Etapa pausada']],
  usoLabel:usage=>({current:'Mapeado no fluxo · envio depende da ativação',native_pending:'Integração pendente · ainda fora do envio',optional:'Opcional · sem necessidade operacional',retired:'Retirado · sem integração a fazer',available:'Disponível · não selecionado',configured_paused:'Selecionado · etapa ou jornada pausada'}[usage]||'Uso não confirmado'),
  workflowMatches(row,f){
    if(f.estado==='ativas'&&!(row.collection.current&&row.active===true))return false;
    if(f.estado==='inativas'&&!(row.collection.current&&row.active===false))return false;
    if(f.estado==='conferir'&&!row.attention)return false;
    const values=row.modes.map(m=>m.value);
    if(['real','sombra','interno'].includes(f.modo)&&!values.includes(f.modo))return false;
    if(f.modo==='segue-origem'&&!(row.modes.length===0&&['upstream','per_request','none'].includes(row.mode_source)))return false;
    if(f.modo==='nao-confirmado'&&!(values.includes('unknown')||(row.modes.length===0&&!['upstream','per_request','none'].includes(row.mode_source))))return false;
    if(f.q&&typeof GT!=='undefined'&&!GT.busca([row],f.q,['label','key',r=>GC.brand(r.brand),r=>GC.channel(r.channel)]).length)return false;
    return true;
  },
  templateMatches(row,f){
    if(f.status==='APPROVED'&&row.status!=='APPROVED')return false;
    if(f.status==='outros'&&row.status==='APPROVED')return false;
    if(['UTILITY','MARKETING','AUTHENTICATION'].includes(f.categoria)&&row.category!==f.categoria)return false;
    if(f.categoria==='divergente'&&!row.mismatch)return false;
    if(GC.USOS_TPL.some(([key])=>key===f.uso&&key!=='todos')&&row.usage!==f.uso)return false;
    return true;
  },
  select(id,options,value,label){return `<label class="gt-filtro">${GC.esc(label)}<select id="${id}" data-gt-filter="${id}">${options.map(([v,t])=>`<option value="${GC.esc(v)}"${v===value?' selected':''}>${GC.esc(t)}</option>`).join('')}</select></label>`;},
  describe(parts){const p=parts.filter(Boolean);return p.length?' '+p.join(' '):'';},
  workflowColumns:[
    {chave:'label',rotulo:'Automação'},{chave:'key',rotulo:'Chave'},{chave:'brand',rotulo:'Marca',pega:r=>GC.brand(r.brand)},{chave:'channel',rotulo:'Canal',pega:r=>GC.channel(r.channel)},
    {chave:'active',rotulo:'Ativa'},{chave:'published',rotulo:'Publicada'},{chave:'has_unpublished_changes',rotulo:'Alterações não publicadas'},
    {chave:'mode_source',rotulo:'Origem do modo'},{chave:'modes',rotulo:'Modos',pega:r=>r.modes.map(m=>`${GC.modeLabel(m)}=${m.value==='unknown'?'não confirmado':m.value}`).join(' | ')||null},
    {chave:'retention_success',rotulo:'Retenção sucesso',pega:r=>r.retention.success},{chave:'retention_error',rotulo:'Retenção erro',pega:r=>r.retention.error},
    {chave:'collection_status',rotulo:'Consulta'},{chave:'collection_label',rotulo:'Situação da consulta',pega:r=>r.collection.label},{chave:'collection_error_code',rotulo:'Erro da consulta'},
    {chave:'checked_at',rotulo:'Consultado em'},{chave:'last_good_at',rotulo:'Última consulta válida'},
    {chave:'exec_status',rotulo:'Última execução retida',pega:r=>GC.object(r.last_retained_execution)?r.last_retained_execution.status:null},
    {chave:'exec_started',rotulo:'Início da execução',pega:r=>GC.object(r.last_retained_execution)?r.last_retained_execution.started_at:null},
    {chave:'exec_stopped',rotulo:'Término da execução',pega:r=>GC.object(r.last_retained_execution)?r.last_retained_execution.stopped_at:null},
  ],
  templateColumns:[
    {chave:'piece',rotulo:'Peça'},{chave:'name',rotulo:'Template'},{chave:'brand',rotulo:'Marca',pega:r=>GC.brand(r.brand)},{chave:'language',rotulo:'Idioma'},
    {chave:'status',rotulo:'Status'},{chave:'category',rotulo:'Categoria'},{chave:'expected_category',rotulo:'Categoria esperada'},{chave:'mismatch',rotulo:'Categoria divergente'},
    {chave:'usage',rotulo:'Uso',pega:r=>r.usage==='native_pending'?'integração pendente':r.usage==='current'?'mapeado no fluxo':GC.usoLabel(r.usage)},
    {chave:'mapped_in',rotulo:'Vinculado a',pega:r=>GC.linkTexto(r)},
    {chave:'aceitos_periodo',rotulo:'Aceitos no período',pega:r=>{const m=GC.templateMetrics(r);return m?(m.vazio?(m.coberto?0:null):m.aceitos):null;}},
    {chave:'entregues_periodo',rotulo:'Entregues no período',pega:r=>{const m=GC.templateMetrics(r);return m?(m.vazio?(m.coberto?0:null):m.entregues):null;}},
    {chave:'cobertura_metricas',rotulo:'Cobertura das métricas',pega:r=>{const m=GC.templateMetrics(r);return m?(m.coberto?`declarada ${m.cobertura.inicio} a ${m.cobertura.fim}`:'não declarada'):null;}},
    {chave:'collection_status',rotulo:'Consulta'},{chave:'collection_label',rotulo:'Situação da consulta',pega:r=>r.collection.label},{chave:'collection_error_code',rotulo:'Erro da consulta'},
    {chave:'checked_at',rotulo:'Consultado em'},{chave:'last_good_at',rotulo:'Última consulta válida'},
    {chave:'publicacao',rotulo:'Publicado / ativo',pega:r=>{const p=GC.publicacao(r);return p?p.rotulo:null;}},
  ],
  esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));},
  object(value){return !!value && typeof value==='object' && !Array.isArray(value);},
  text(value,fallback='Não informado'){return typeof value==='string' && value.trim()?value:fallback;},
  time(value){return typeof value==='string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value)?Date.parse(value):NaN;},
  stamp(value){const time=GC.time(value);return Number.isFinite(time)?new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(time)):'Não disponível';},
  fresh(value,now){const time=GC.time(value);return Number.isFinite(time) && time<=now+60000 && now-time<900000;},
  brand(key){return {fish:'Fishermans',aristo:'O Aristocrata',olivas:'Olivas do Campo',shared:'Compartilhado'}[key] || 'Marca não informada';},
  statusLabel(value){return {APPROVED:'Aprovado',PENDING:'Em análise',REJECTED:'Reprovado',PAUSED:'Pausado',DISABLED:'Desativado',DELETED:'Excluído'}[value]||GC.text(value,'Não informado');},
  categoryLabel(value){return {UTILITY:'Utilidade',MARKETING:'Marketing',AUTHENTICATION:'Autenticação'}[value]||GC.text(value,'Não informada');},
  modeValue(value){return {real:'envio real',sombra:'simulação',interno:'teste interno',unknown:'não confirmado'}[value]||value;},
  publicationLabel(pub,row){return pub.situacao==='ativo'?'Publicado · envio ativo':pub.situacao==='nao_ativo'?(row.mapped_in?.length?'Publicado · envio não ativo':'Publicado · sem automação vinculada'):'Publicado · ativação não confirmada';},
  channel(key){return {whatsapp:'WhatsApp',email:'E-mail',shared:'Todos os canais'}[key] || 'Canal não informado';},
  badge(label,tone='neutral',detail=''){return `<span class="control-badge control-${tone}"${detail?` tabindex="0" title="${GC.esc(detail)}" aria-label="${GC.esc(label+': '+detail)}"`:''}>${GC.esc(label)}</span>`;},
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
      const fieldsValid=typeof row.key==='string' && !!row.key.trim() && ['fish','aristo','olivas','shared'].includes(row.brand)
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
      const fieldsValid=expectedKnown && categoryKnown && GC.USOS_TPL.some(([key])=>key===row.usage&&key!=='todos')
        && typeof row.key==='string' && !!row.key.trim() && typeof row.id==='string' && /^\d+$/.test(row.id)
        && ['fish','aristo'].includes(row.brand) && row.channel==='whatsapp' && typeof row.piece==='string' && !!row.piece.trim()
        && typeof row.category_matches_expected==='boolean' && row.category_matches_expected===(category===row.expected_category)
        && typeof row.name==='string' && row.name.trim().length>0 && typeof row.language==='string' && row.language.trim().length>0;
      const eligible=collection.current && fieldsValid && status==='APPROVED' && !mismatch;
      return {...row,status,category,collection,fieldsValid,mismatch,eligible,attention:!collection.current||!fieldsValid||(row.usage==='current'&&!eligible)};
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
    return `<div class="control-context"><div><strong>Estado atual · independente do período acima</strong>${meta.current?'':`<p class="control-warning">${GC.esc(state)} Atualize o painel para conferir.</p>`}<div class="control-explainer">${GC.badge(meta.current?'Consulta atual':'Consulta a conferir',meta.current?'neutral':'warning',state)}${GC.badge(meta.collectionMode==='automatic'?'Atualização a cada 5 min':schedule,'neutral',schedule+' Dados com 15 minutos ou mais são sinalizados.')}</div></div>
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
    const modes=row.modes.map(mode=>`${GC.modeLabel(mode)}: ${GC.modeValue(mode.value)}`).join(' · ');
    const execution=GC.object(row.last_retained_execution)?row.last_retained_execution:null;
    const status=execution?({success:'Concluída',error:'Erro registrado',running:'Em execução',waiting:'Aguardando',canceled:'Cancelada',crashed:'Interrompida',new:'Nova',unknown:'Não confirmado'}[execution.status] || 'Não confirmado'):null;
    const retention=kind=>({all:'Salvas',none:'Não salvas',unknown:'Não confirmado'}[row.retention[kind]] || 'Não confirmado');
    return `<article class="control-workflow" data-control-workflow="${e(row.key)}"><div class="control-workflow-head"><div><span class="control-overline">${e(GC.brand(row.brand))} · ${e(GC.channel(row.channel))}</span><h3>${e(GC.text(row.label,'Automação sem nome'))}</h3></div>${GC.badge(row.collection.label,row.collection.tone)}</div>
      <div class="control-config">${GC.badge(active,current&&row.fieldsValid&&row.active===true?'info':'neutral')}${GC.badge(published)}${row.has_unpublished_changes===true?GC.badge('Alterações ainda não publicadas','warning'):''}</div>
      <p class="control-mode">${e(modes || (row.mode_source==='upstream'?'Segue o modo da automação de origem':row.mode_source==='per_request'?'Modo definido a cada solicitação de envio':row.mode_source==='none'?'Este serviço não define um modo de envio':'Modo de envio não informado'))}</p>
      ${!current?'<p class="control-warning">Os valores disponíveis são da última coleta; o estado atual não está confirmado.</p>':''}
      ${!row.fieldsValid?'<p class="control-warning">Há campos de configuração não confirmados.</p>':''}
      ${GC.collectionDetails(row)}
      <details class="control-detail"><summary>Registros técnicos disponíveis</summary><p>${execution?`${e(status)} · início ${e(GC.stamp(execution.started_at))}${execution.stopped_at?` · término ${e(GC.stamp(execution.stopped_at))}`:''}`:'Nenhuma execução retida foi informada pela fonte.'}</p>
      <p>Execuções concluídas: ${e(retention('success'))}. Execuções com erro: ${e(retention('error'))}.</p>
      <p>${row.retention.success==='none'?'Este fluxo não salva execuções concluídas; uma execução antiga com erro pode continuar sendo a última retida.':'A última execução retida pode não representar a última atividade do fluxo.'} Esse registro não comprova entrega ao cliente.</p></details></article>`;
  },
  /* R3 (10/09/2026): vínculo template→workflow vem do manifesto (mapped_in), nunca do nome; métricas por template vêm
     de crm_wa_template no período selecionado. Sem os dois na resposta, a coluna fica como antes. */
  templateCtx:{workflows:[],metrics:null,ini:'',fim:''},
  /* Fase A (11/09/2026): conteúdo publicado (R5.2) só quando `capabilities.templates.read_content` for true e a pessoa
     pedir. `conteudo` = null → nunca carregado; {} → carregado sem itens. Prévia vem de `components` da API, nunca do nome. */
  conteudo:null,conteudoEm:null,conteudoErro:null,historicos:{},carregando:null,
  previewContext:null,
  previewButton(ref,api){
    if(!['fish','aristo'].includes(ref.brand)||!['email','whatsapp'].includes(ref.channel)||!/^\d+$/.test(String(ref.id||'')))return '<span class="mini">Prévia indisponível: template não identificado.</span>';
    const caps=typeof GTA!=='undefined'?GTA.caps(api||GC.previewContext?.api||{}):null;
    if(!caps?.pode?.read_content||typeof GMP==='undefined')return '<span class="mini">Prévia indisponível nesta consulta. Atualize o acesso.</span>';
    return `<button type="button" class="refresh-btn" data-template-preview data-preview-brand="${GC.esc(ref.brand)}" data-preview-channel="${ref.channel}" data-preview-id="${GC.esc(ref.id)}" data-preview-selection="${ref.selection==='draft'?'draft':'published'}"${ref.key?` data-preview-key="${GC.esc(ref.key)}"`:''}>Ver prévia</button>`;
  },
  async previewTemplate(ref,ctx=GC.previewContext||{}){
    if(typeof GTA==='undefined'||typeof GMP==='undefined'||!['fish','aristo'].includes(ref?.brand)||!['email','whatsapp'].includes(ref?.channel)||!/^\d+$/.test(String(ref.id||'')))return;
    const caps=GTA.caps(ctx.api||{}),key=GTA.chaveLeitura(),scope=GC.previewContext?.marca,dialog=GMP.openPublished({brand:ref.brand,channel:ref.channel,selection:ref.selection});
    const current=()=>dialog.current()&&key===GTA.chaveLeitura()&&(!GC.previewContext||scope===GC.previewContext.marca)&&GTA.caps(GC.previewContext?.api||ctx.api||{}).endpoint===caps.endpoint;
    const check=()=>{if(!current())throw Error('A marca ou o acesso mudou. Feche e abra a prévia novamente.');};
    try{
      if(!caps.pode.read_content||!key)throw Error('Prévia indisponível neste acesso. Atualize o painel.');
      const client=GTA.cliente({endpoint:caps.endpoint,chaveLeitura:key}),res=await client.listar(ref.brand,ref.channel);check();
      if(!res.ok||!Array.isArray(res.body?.templates)||res.body.templates.length>250)throw Error('Não foi possível consultar o conteúdo publicado. Feche e tente novamente.');
      const matches=res.body.templates.filter(t=>t&&t.brand===ref.brand&&t.channel===ref.channel&&String(t.id)===String(ref.id)&&(!ref.key||t.key===ref.key));
      if(matches.length!==1)throw Error('O conteúdo deste template não foi confirmado. Atualize a lista antes de abrir a prévia.');
      const t=matches[0];if(JSON.stringify(t.components||null).length>400000)throw Error('O conteúdo ultrapassa o limite de visualização.');
      const checkedAt=GC.stamp(Number.isFinite(GC.time(res.body.consultado_em))?res.body.consultado_em:new Date().toISOString());
      if(ref.channel==='whatsapp'){dialog.whatsapp(t,checkedAt);return;}
      const c=t.components;if(!GC.object(c)||typeof c.body_html!=='string'||!c.body_html.trim()||typeof c.subject!=='string')throw Error('Conteúdo de e-mail indisponível nesta consulta.');
      let source=c.body_html,subject=c.subject;
      if(source.includes('{{')||subject.includes('{{')){
        const capability=await client.emailCapacidades();check();const p=capability.body;
        if(!capability.ok||p?.contract!=='crm_email_native_preview_v1'||p.policy_version!==1||p.native_email_preview!==true||!Array.isArray(p.brands)||!p.brands.includes(ref.brand))throw Error('A prévia com variáveis não está disponível neste acesso. Nenhum conteúdo foi inventado.');
        const domain={fish:'fishermans.com.br',aristo:'oaristocrata.com'}[ref.brand];
        // The renderer requires an envelope. These values are synthetic inputs
        // only: never present them as the sender/preheader used by the workflow.
        const r={canal:'email',marca:ref.brand,idioma:'pt_BR',categoria:'UTILITY',nome:'Prévia de conteúdo publicado',peca:'',cabecalho:'',corpo:/<html(?:\s|>)/i.test(source)?source:'<!doctype html><html><body>'+source+'</body></html>',rodape:'',assunto:subject,exemplos:{},botoes:[],from_email:'Prévia <contato@'+domain+'>',reply_to:'contato@'+domain,preheader:'Prévia com dados fictícios'};
        const rendered=await client.emailPrevia(r);check();const body=rendered.body;
        if(!rendered.ok||body?.contract!=='crm_email_native_preview_v1'||body.eligible!==true||body.brand!==ref.brand||!['synthetic','external'].includes(body.subscriber_context)||!/^[a-f0-9]{64}$/.test(body.source_hash||'')||typeof body.body_html!=='string'||!body.body_html.trim()||body.body_html.length>600000||body.body_html.includes('{{')||typeof body.subject!=='string'||body.subject.length>1000)throw Error('Não foi possível renderizar as variáveis deste template. Nenhum e-mail foi enviado.');
        source=body.body_html;subject=body.subject;
      }
      check();dialog.email({source,subject,checkedAt});
    }catch(error){if(dialog.current())dialog.status(error.message||'Prévia não confirmada. Feche e tente novamente.');}
  },
  bindPreviews(root,ctx){root?.querySelectorAll('[data-template-preview]').forEach(b=>b.onclick=()=>GC.previewTemplate({brand:b.dataset.previewBrand,channel:b.dataset.previewChannel,id:b.dataset.previewId,key:b.dataset.previewKey,selection:b.dataset.previewSelection},ctx));},
  publicacao(row){
    if(typeof GTA==='undefined'||row.status!=='APPROVED'||!Array.isArray(row.mapped_in))return null;
    return GTA.publicadoAtivo(row,GC.templateCtx.workflows);
  },
  previaPublicada(row){
    if(!GC.conteudo||typeof GTA==='undefined')return '';
    const t=GC.conteudo[row.key]||Object.values(GC.conteudo).find(x=>x&&x.name===row.name&&x.brand===row.brand);
    if(!t)return '<span class="control-template-meta">Conteúdo publicado indisponível nesta consulta. Recarregue o conteúdo para conferir.</span>';
    const e=GC.esc,hist=GC.historicos[row.key],version=/^[1-9]\d*$/.test(String(t.version??''))?' · v'+e(t.version):'',collected=!t.published_at&&Number.isFinite(GC.time(GC.conteudoEm))?' · consultada em '+e(GC.stamp(GC.conteudoEm)):'';
    return `<details class="control-detail control-template-preview" data-gt-key="prev-${e(row.key)}"><summary>Prévia publicada${version}${collected}${t.published_at?` · ${e(GC.stamp(t.published_at))}`:''}</summary>
      <div class="control-template-preview-body">${GTA.previaComponents(t.components)}</div>${t.components?.body_html?`<button type="button" class="refresh-btn" data-tpl-preview-email="${e(t.key||row.key)}">Abrir prévia do HTML</button>`:''}
      ${t.quality_score?`<p>Qualidade (Meta): ${e(typeof t.quality_score==='object'?JSON.stringify(t.quality_score):t.quality_score)}</p>`:''}${t.rejected_reason?`<p class="control-warning">Motivo de rejeição: ${e(t.rejected_reason)}</p>`:''}
      ${GC.caps?.pode?.list_history?(hist?`<ul class="control-template-hist">${hist.length?hist.map(x=>`<li>${e(GC.stamp(x.at))} · ${e(x.who||'?')} · ${e(x.action)}${x.from_version!=null||x.to_version!=null?` v${e(x.from_version??'—')}→v${e(x.to_version??'—')}`:''} · ${e(x.result||'')}</li>`).join(''):'<li>Nenhum evento devolvido pela API.</li>'}</ul>`:`<button type="button" class="refresh-btn" data-tpl-historico="${e(row.key)}"${GC.carregando?' disabled':''}>Carregar histórico</button>`):''}</details>`;
  },
  readTicket:null,
  startRead(ctx,action){
    const ticket={brand:ctx.marca,endpoint:GC.caps.endpoint,key:GTA.chaveLeitura()};
    GC.readTicket=ticket;GC.carregando=action;GC.render(ctx);return ticket;
  },
  currentRead(ticket){
    return GC.readTicket===ticket&&GC.previewContext?.marca===ticket.brand&&GTA.caps(GC.previewContext?.api||{},{TEMPLATE_API_URL:typeof TEMPLATE_API_URL!=='undefined'?TEMPLATE_API_URL:undefined}).endpoint===ticket.endpoint&&GTA.chaveLeitura()===ticket.key;
  },
  finishRead(ticket){
    if(GC.readTicket!==ticket)return null;
    const current=GC.currentRead(ticket),ctx=GC.previewContext;
    GC.readTicket=null;GC.carregando=null;
    if(!current){GC.render(ctx);return null;}return ctx;
  },
  async carregarConteudo(ctx){
    if(GC.carregando||typeof GTA==='undefined'||!GC.caps?.pode?.read_content)return;
    GC.conteudoErro=null;const ticket=GC.startRead(ctx,'listar');
    const c=GTA.cliente({endpoint:ticket.endpoint,fetch:typeof fetch==='function'?fetch:null,chaveLeitura:ticket.key});
    let res;try{res=await c.listar(ctx.marca);}catch(_){res={ok:false,status:0,body:null,rede:true};}
    ctx=GC.finishRead(ticket);if(!ctx)return;
    if(!res.ok){GC.conteudoErro=GTA.erro(res,'listar').texto;GC.render(ctx);return;}
    const lista=Array.isArray(res.body?.templates)?res.body.templates.filter(t=>t&&typeof t==='object'&&typeof t.key==='string'):[];
    GC.conteudo=Object.fromEntries(lista.map(t=>[t.key,t]));GC.conteudoEm=new Date().toISOString();GC.render(ctx);
  },
  async carregarHistorico(ctx,key){
    if(GC.carregando||typeof GTA==='undefined'||!GC.caps?.pode?.list_history)return;
    const ticket=GC.startRead(ctx,'historico');
    const c=GTA.cliente({endpoint:ticket.endpoint,fetch:typeof fetch==='function'?fetch:null,chaveLeitura:ticket.key});
    let res;try{res=await c.historico({key});}catch(_){res={ok:false,status:0,body:null,rede:true};}
    ctx=GC.finishRead(ticket);if(!ctx)return;
    GC.historicos[key]=res.ok&&Array.isArray(res.body?.events)?res.body.events.filter(x=>x&&typeof x==='object'):[];
    if(!res.ok)GC.conteudoErro=GTA.erro(res,'historico').texto;
    GC.render(ctx);
  },
  templateLink(row){
    const links=Array.isArray(row.mapped_in)?row.mapped_in:null;
    if(links===null)return null;
    const validos=links.filter(l=>GC.object(l)&&typeof l.workflow_key==='string'&&l.workflow_key.trim()),invalidos=links.length-validos.length;
    if(!validos.length)return row.usage==='native_pending'&&!invalidos?null:[{text:invalidos?`${invalidos} vínculo(s) em formato inválido`:'Sem automação vinculada',tone:invalidos?'warning':'neutral'}];
    const out=validos.map(l=>{
      const wf=GC.templateCtx.workflows.find(w=>w.key===l.workflow_key);
      const mode=wf?(wf.modes||[]).find(m=>m.key===l.mode_key):null;
      const piece=typeof l.piece==='string'&&l.piece.trim()?l.piece:'peça não informada';
      // F03: modo só é "configurado" se a consulta do workflow é atual e os campos são válidos; senão é o último modo observado.
      const atual=!!wf&&wf.collection?.current&&wf.fieldsValid;
      let modeTxt='',tone='neutral';
      if(mode){
        const val=mode.value==='unknown'?'não confirmado':mode.value;
        if(atual){modeTxt=`modo configurado: ${val}`;tone=mode.value==='real'?'verified':'neutral';}
        else{modeTxt=`último modo observado: ${val} · consulta ${wf.collection?.key==='error'?'com falha':'desatualizada'} (${GC.stamp(wf.last_good_at)})`;tone='warning';}
      }else if(wf)modeTxt='modo não informado';
      return {text:`${wf?wf.label||l.workflow_key:l.workflow_key} · ${piece}${modeTxt?` · ${modeTxt}`:''}`,displayText:`${wf?.label||'Automação vinculada'} · ${piece}${modeTxt?` · ${modeTxt.replace(/\breal\b/g,'envio real').replace(/\bsombra\b/g,'simulação').replace(/\binterno\b/g,'teste interno')}`:''}`,tone};
    });
    if(invalidos)out.push({text:`${invalidos} vínculo(s) em formato inválido ignorado(s)`,tone:'warning'});
    return out;
  },
  linkTexto(row){const l=GC.templateLink(row);return l?l.map(x=>x.text).join(' | '):null;},
  /* F01/F04/F06 (revisão de 11/09): contagem desconhecida (null, ausente, texto, negativo) nunca vira zero — a soma do campo
     fica null se qualquer linha for desconhecida (mesma regra de GD.sumKnown em Envios). Fluxo `teste-motor` sai, como em
     Envios. Linhas inválidas são contadas e não somadas. Array vazio só é "zero" com cobertura declarada
     (`crm_wa_template_cobertura`, pedido R5.9-e); sem ela, é "sem linha · cobertura não declarada". */
  METRICAS_TPL:['registros','aceitos','entregues','falhas'],
  templateMetrics(row){
    const m=GC.templateCtx.metrics;if(!Array.isArray(m))return null;
    const {ini,fim,cobertura}=GC.templateCtx;
    const count=v=>typeof GD!=='undefined'?GD.count(v):(Number.isSafeInteger(+v)&&+v>=0&&v!==null&&v!==''&&typeof v!=='boolean'?+v:null);
    const invalidas=m.filter(r=>!GC.object(r)).length;
    const doTemplate=m.filter(GC.object).filter(r=>String(r.template_ref)===String(row.id)&&r.marca===row.brand&&typeof r.dia==='string'&&(!ini||r.dia>=ini)&&(!fim||r.dia<=fim));
    const testes=doTemplate.filter(r=>r.flow==='teste-motor'),rows=doTemplate.filter(r=>r.flow!=='teste-motor');
    const coberto=!!cobertura&&(!ini||ini>=cobertura.inicio)&&(!fim||fim<=cobertura.fim);
    const out={linhas:rows.length,testes:testes.length,invalidas,coberto,cobertura:cobertura||null,vazio:!rows.length};
    GC.METRICAS_TPL.forEach(k=>{const vals=rows.map(r=>count(r[k]));out[k]=rows.length&&vals.every(v=>v!==null)?vals.reduce((a,b)=>a+b,0):null;});
    return out;
  },
  metricaTexto(met){
    if(!met)return null;
    const nf=v=>v===null?'—':new Intl.NumberFormat('pt-BR').format(v);
    if(met.vazio)return met.coberto?'Sem registro no período (0)':'Sem linha no período · cobertura não declarada';
    return `${nf(met.registros)} registros · ${nf(met.aceitos)} aceitos · ${nf(met.entregues)} entregues${met.falhas!==null&&met.falhas>0?` · ${nf(met.falhas)} falhas`:met.falhas===null?' · falhas —':''}`;
  },
  template(row){
    const e=GC.esc,current=row.collection.current;
    const links=GC.templateLink(row),met=GC.templateMetrics(row);
    const nf=v=>new Intl.NumberFormat('pt-BR').format(v);
    const linkHtml=links?(Array.isArray(links)?links:[links]).map(l=>`<span class="control-template-link" data-tone="${l.tone}" title="${e(l.text)}">${e(l.displayText||l.text)}</span>`).join(''):'';
    const metHtml=met?`<details class="control-template-metrics" data-gt-key="met-${e(row.key)}"><summary>${e(GC.metricaTexto(met))}${met.coberto?'':met.vazio?'':' · cobertura não declarada'}${met.linhas&&[met.registros,met.aceitos,met.entregues,met.falhas].some(v=>v===null)?' · parte não medida':''}</summary>
      <p>Linhas do motor para este template, na marca e no período selecionado, sem o fluxo de teste (mesma população de Envios). Registros incluem sombra; aceitos = wamid da Meta; entregues = delivered/read. "—" é contagem não informada em pelo menos uma linha, não zero.${met.testes?` ${met.testes} linha(s) de teste fora da soma.`:''}${met.invalidas?` ${met.invalidas} linha(s) da coleção em formato inválido, ignorada(s).`:''} ${met.coberto?`Cobertura declarada pela API: ${e(met.cobertura.inicio)} a ${e(met.cobertura.fim)}.`:'A API não declarou a cobertura desta coleção; ausência de linha não prova zero.'}</p></details>`:'';
    const note=GC.usoLabel(row.usage);
    const alerts=[];
    if(row.mismatch)alerts.push(`Categoria recebida: ${GC.categoryLabel(row.category)}; esperada: ${GC.categoryLabel(row.expected_category)}.`);
    if(row.status!=='APPROVED')alerts.push(`Status recebido: ${GC.statusLabel(row.status)}; aprovação não confirmada.`);
    if(!row.fieldsValid)alerts.push('Há campos do template não confirmados.');
    const statusTone=current && row.fieldsValid && row.status!=='APPROVED'?'warning':row.eligible && row.usage==='current'?'verified':'neutral';
    const categoryTone=current && row.mismatch?'warning':row.eligible && row.usage==='current'?'verified':'neutral';
    const pub=GC.publicacao(row);
    return `<tr data-control-template="${e(row.key)}"><td><strong class="control-template-piece">${e(GC.text(row.piece,'Peça não informada'))}</strong><code>${e(GC.text(row.name,'Nome não informado'))}</code><span class="control-template-meta">${e(GC.brand(row.brand))} · ${e(GC.text(row.language,'Idioma não informado'))}</span>${GC.caps?.pode?.read_content?GC.previewButton(row):''}${GC.previaPublicada(row)}</td>
      <td>${GC.badge(GC.statusLabel(row.status),statusTone,"Status recebido da Meta: "+row.status)}${GC.badge(GC.categoryLabel(row.category),categoryTone,"Categoria recebida da Meta: "+row.category)}<span class="control-template-meta">Categoria esperada: ${e(GC.categoryLabel(row.expected_category))}</span>${pub?`<span class="control-template-pub" data-situacao="${e(pub.situacao)}" title="${e(pub.rotulo)}. Publicado significa aprovado pela Meta. Envio ativo indica automação vinculada ligada e configurada para envio; não comprova disparo ou entrega.">${GC.badge(GC.publicationLabel(pub,row),pub.tone)}</span>`:''}</td>
      <td><span class="control-usage${row.usage==='native_pending'?' control-planned':''}">${e(note)}</span>${row.usage_reason?`<p class="control-template-meta">${e(row.usage_reason)}</p>`:''}${linkHtml}${metHtml}${alerts.map(alert=>`<p class="control-warning">${e(alert)}</p>`).join('')}</td>
      <td>${GC.badge(row.collection.label,row.collection.tone)}${GC.collectionDetails(row)}</td></tr>`;
  },
  emailFlowLabel(value,fallback='Jornada não identificada'){
    const key=String(value||'').split(':').pop();
    return ({carrinho:'Carrinho','nps-d0':'Pesquisa de satisfação','pedido-recebido':'Acompanhamento do pedido',popup:'Boas-vindas'})[key]||fallback;
  },
  emailStepLabel(value,fallback='Etapa não identificada'){
    return ({'carrinho-30min':'Após 30 minutos','carrinho-1h':'Após 1 hora','carrinho-2h':'Após 2 horas','carrinho-24h':'Após 24 horas','carrinho-48h':'Após 48 horas','nps-d0':'Primeiro convite','nps-d3':'Lembrete após 3 dias','cupom-boas-vindas':'Cupom de boas-vindas','pedido-recebido':'Pedido recebido','pedido-confirmado':'Pagamento confirmado','pedido-preparando':'Pedido em preparação','pedido-em_rota':'Pedido a caminho','pedido-entregue':'Pedido entregue','pedido-cancelado':'Pedido cancelado'})[value]||fallback;
  },
  managerOperation(model){
    const rows=model.workflows,notes=[];
    const add=(text,affected=[])=>{
      const stamps=[...new Set(affected.map(r=>GC.stamp(r.last_good_at)))];
      notes.push(`<p class="control-warning">${GC.esc(text)}${stamps.length?` <span class="mini">Última consulta válida: ${GC.esc(stamps.join(' · '))} · Brasília.</span>`:''}</p>`);
    };
    if(!model.meta.valid||!rows.length)add('Estado das automações indisponível. Atualize o painel; ausência de dados não confirma ausência de automações.');
    else{
      const failed=rows.filter(r=>r.collection.key==='error'),stale=rows.filter(r=>r.collection.key==='stale'),unknown=rows.filter(r=>['unknown','invalid'].includes(r.collection.key));
      if(failed.length)add('Não foi possível atualizar parte das automações. Atualize o painel; se persistir, peça conferência ao responsável.',failed);
      if(stale.length)add('Parte das automações tem informações desatualizadas. Atualize o painel antes de avaliar a operação.',stale);
      if(unknown.length)add('Estado de parte das automações não confirmado. Atualize o painel; não presuma que os envios estejam ativos.',unknown);
      if(rows.some(r=>!r.fieldsValid))add('Parte da configuração não foi confirmada. Peça conferência ao responsável antes de alterar envios.');
      if(rows.some(r=>r.has_unpublished_changes===true))add('Há alterações ainda não publicadas. Confirme com o responsável qual versão está em operação.');
    }
    return `<section class="control-manager-operation" data-crm-manager-only role="status"><strong>Acompanhamento da operação</strong>${notes.join('')}<p class="mini">Confira etapas, pausas e versões em Jornadas. Configuração habilitada não comprova envio ou entrega.</p></section>`;
  },
  emailInventory(api,marca,canal,now=Date.now()) {
    if(canal==='whatsapp'||!['fish','aristo','todas','todos'].includes(marca))return '';
    const raw=api?.crm_operacao?.email_steps,e=GC.esc;
    const heading='<h3>Etapas de e-mail configuradas</h3>';
    if(!Array.isArray(raw))return heading+'<p class="nota">A lista de etapas de e-mail ainda não veio nesta consulta. Atualize o painel para conferir as etapas.</p>';
    const chosen=raw.filter(r=>r&&(['todas','todos'].includes(marca)||r.brand===marca));
    const valid=chosen.every(r=>['fish','aristo'].includes(r.brand)&&typeof r.key==='string'&&typeof r.piece==='string'&&typeof r.flow_key==='string'&&typeof r.enabled==='boolean'&&typeof r.runtime_ready==='boolean'&&Number.isFinite(Date.parse(r.checked_at)))&&new Set(chosen.map(r=>r.key)).size===chosen.length;
    if(!valid)return heading+'<p class="nota">Não foi possível conferir as etapas de e-mail. Atualize o painel.</p>';
    const status=r=>{const age=now-Date.parse(r.checked_at);return !Number.isFinite(age)||age < -60000||age>900000?'Configuração na consulta anterior':!r.enabled?'Pausada':!r.runtime_ready?'Integração pendente':'Habilitada na configuração';};
    return '<section class="control-email-inventory">'+heading+`<div class="control-explainer">${GC.badge(chosen.length+(chosen.length===1?' etapa':' etapas'))}${GC.badge('Versão publicada','neutral','Configuração das jornadas, independente do período selecionado. Habilitada não confirma envio ou entrega; consulte os resultados medidos no histórico.')}</div><div class="rolagem"><table class="comparativo"><thead><tr><th>Marca / jornada</th><th>Etapa</th><th>Configuração</th><th>Consultado em · Brasília</th></tr></thead><tbody>${chosen.map(r=>`<tr data-email-step="${e(r.key)}"><td>${e(GC.brand(r.brand))}<br><span class="mini">${e(GC.emailFlowLabel(r.flow_key))}</span></td><td>${e(GC.emailStepLabel(r.piece))}<div class="control-preview-action">${GC.previewButton({brand:r.brand,channel:'email',id:r.template_id},api)}</div><span class="mini" data-crm-owner-only> · ${e(r.piece)}</span></td><td>${e(status(r))}</td><td>${e(GC.stamp(r.checked_at))}</td></tr>`).join('')||'<tr><td colspan="4">Nenhuma etapa de e-mail publicada para esta marca. Confira a configuração das jornadas.</td></tr>'}</tbody></table></div></section>`;
  },
  emailCatalog(ctx){
    if(ctx.canal==='whatsapp'||!['fish','aristo','todas','todos'].includes(ctx.marca))return '';
    const raw=ctx.api?.crm_operacao?.email_steps,e=GC.esc;
    if(!Array.isArray(raw))return '<section class="control-email-catalog"><h3>E-mails das jornadas</h3><p class="nota">Conteúdo não identificado nesta consulta. Atualize o painel.</p></section>';
    const rows=raw.filter(r=>r&&['fish','aristo'].includes(r.brand)&&(['todas','todos'].includes(ctx.marca)||r.brand===ctx.marca));
    return `<section class="control-email-catalog"><h3>E-mails das jornadas</h3><span class="control-badge" title="Conteúdo do template selecionado na configuração publicada. A prévia não altera a jornada.">Configuração publicada ⓘ</span><div class="rolagem"><table class="comparativo"><thead><tr><th>Marca / jornada</th><th>Etapa</th><th>Conteúdo</th></tr></thead><tbody>${rows.map(r=>`<tr data-email-template="${e(r.brand+':'+r.key)}"><td>${e(GC.brand(r.brand))} · ${e(GC.emailFlowLabel(r.flow_key))}</td><td>${e(GC.emailStepLabel(r.piece))}</td><td>${GC.previewButton({brand:r.brand,channel:'email',id:r.template_id},ctx.api)}</td></tr>`).join('')||'<tr><td colspan="3">Nenhum e-mail de jornada informado para esta marca.</td></tr>'}</tbody></table></div></section>`;
  },
  render(ctx={}){
    GC.previewContext=ctx;
    const model=GC.model(ctx.api?.crm_operacao,ctx);
    const cob=ctx.api?.crm_wa_template_cobertura;
    GC.templateCtx={workflows:model.workflows||[],metrics:Array.isArray(ctx.api?.crm_wa_template)?ctx.api.crm_wa_template:null,ini:ctx.ini||'',fim:ctx.fim||'',
      cobertura:GC.object(cob)&&/^\d{4}-\d{2}-\d{2}$/.test(cob.inicio||'')&&/^\d{4}-\d{2}-\d{2}$/.test(cob.fim||'')?{inicio:cob.inicio,fim:cob.fim}:null};
    GC.caps=typeof GTA!=='undefined'?GTA.caps(ctx.api,{TEMPLATE_API_URL:typeof TEMPLATE_API_URL!=='undefined'?TEMPLATE_API_URL:undefined}):null;
    if(GC.readTicket&&!GC.currentRead(GC.readTicket)){GC.readTicket=null;GC.carregando=null;}
    if(typeof document==='undefined')return model;
    const workflowRoot=document.querySelector('#control-workflows'),templateRoot=document.querySelector('#control-templates');
    if(!workflowRoot||!templateRoot)return model;
    const hasGT=typeof GT!=='undefined';
    const keptWf=hasGT?GT.captura(workflowRoot):null,keptTpl=hasGT?GT.captura(templateRoot):null;
    const ownerDetailsOpen=workflowRoot.querySelector('[data-crm-owner-diagnostics]')?.open===true;
    const openDetails=[...workflowRoot.querySelectorAll('[data-control-workflow]')].filter(card=>card.querySelector('details')?.open).map(card=>card.dataset.controlWorkflow);
    const oldInput=templateRoot.querySelector('#control-template-search'),restoreInput=oldInput&&document.activeElement===oldInput;
    const selection=restoreInput?[oldInput.selectionStart,oldInput.selectionEnd]:null;
    const e=GC.esc,fw=GC.filters.wf,ft=GC.filters.tpl;
    const brandSpecific=model.marca!=='todas' && !model.workflows.some(row=>row.brand===model.marca);
    const workflows=model.workflows.filter(row=>GC.workflowMatches(row,fw));
    const wfFiltered=fw.q||fw.estado!=='todas'||fw.modo!=='todos';
    const wfEmpty=!model.meta.valid?'Operação atual indisponível nesta consulta.'
      :!model.workflows.length?'Nenhuma automação disponível para estes filtros. Ausência de dados não confirma ausência de automações.'
      :`Nenhuma automação${GC.describe([fw.estado==='ativas'?'ativa':fw.estado==='inativas'?'inativa':fw.estado==='conferir'?'a conferir':'',
          fw.modo==='real'?'com envio real':fw.modo==='sombra'?'em simulação':fw.modo==='interno'?'em teste interno':fw.modo==='segue-origem'?'sem modo próprio':fw.modo==='nao-confirmado'?'com modo não confirmado':'',
          fw.q?`contendo "${e(fw.q)}"`:''])}${model.marca!=='todas'?` para ${e(GC.brand(model.marca))}`:''}${model.canal!=='todos'?` no canal ${e(GC.channel(model.canal))}`:''}. Simulação ou configuração inativa não significa que a operação parou de existir: confira os filtros.`;
    workflowRoot.innerHTML=GC.metadata(model)+GC.managerOperation(model)+GC.emailInventory(ctx.api,model.marca,model.canal,ctx.now??Date.now())+`<details class="control-owner-diagnostics" data-crm-owner-only data-crm-owner-diagnostics data-gt-key="control-owner-diagnostics"${ownerDetailsOpen?' open':''}><summary>Detalhes técnicos da operação</summary><div class="control-summary"><div><strong>${model.meta.valid?model.workflows.length:'—'}</strong><span>Serviços acompanhados</span></div><div><strong>${model.meta.valid?model.workflows.filter(row=>row.collection.current&&row.active===true).length:'—'}</strong><span>Serviços ativos na coleta</span></div><div><strong>${model.meta.valid?model.workflows.filter(row=>row.attention).length:'—'}</strong><span>Consultas ou campos a conferir</span></div></div>
      <div class="control-explainer">${GC.badge('Configuração dos serviços','neutral','Ativo indica configuração ligada; não confirma funcionamento ou entrega. As quantidades de serviços não representam o número de etapas de e-mail.')}${GC.badge('Simulação: sem disparos','neutral','A simulação não faz disparos reais.')}${GC.badge('Inclui serviços compartilhados','neutral','Serviços compartilhados aparecem também no filtro de cada marca.')}</div>
      ${brandSpecific?`<p class="control-scope">Nenhum serviço específico de ${e(GC.brand(model.marca))} foi informado neste canal.${model.shared?' Abaixo estão os serviços compartilhados.':''}</p>`:''}
      ${model.meta.valid?`<div class="gt-toolbar control-toolbar"><label class="gt-busca">Buscar automação<input type="search" id="control-workflow-search" placeholder="Nome ou chave" value="${e(fw.q)}" autocomplete="off"></label>
        ${GC.select('control-wf-estado',GC.ESTADOS_WF,fw.estado,'Estado')}${GC.select('control-wf-modo',GC.MODOS_WF,fw.modo,'Modo')}
        <span class="gt-contagem">${workflows.length} de ${model.workflows.length} automações</span>
        ${wfFiltered?'<button type="button" class="refresh-btn gt-limpar" data-clear="wf">Limpar filtros</button>':''}
        <button type="button" class="refresh-btn gt-export" id="control-wf-export"${workflows.length?'':' disabled'}>Exportar CSV</button></div>`:''}
      <div class="control-workflows">${workflows.length?workflows.map(GC.workflow).join(''):`<div class="vazio">${wfEmpty}${wfFiltered?' <button type="button" class="refresh-btn gt-limpar" data-clear="wf">Limpar filtros</button>':''}</div>`}</div></details>`;
    const search=GC.search.toLocaleLowerCase('pt-BR');
    const searched=model.templates.filter(row=>[row.name,row.piece,GC.brand(row.brand)].some(value=>String(value||'').toLocaleLowerCase('pt-BR').includes(search))).filter(row=>GC.templateMatches(row,ft));
    const templates=hasGT?GT.ordena(searched,ft.sort,ft.dir,r=>ft.sort==='collection'?r.checked_at:r[ft.sort]):searched;
    const tplFiltered=!!GC.search||ft.status!=='todos'||ft.categoria!=='todas'||ft.uso!=='todos';
    const tplEmpty=!model.templates.length?'Nenhum template disponível. Confira a marca e o canal ou prepare uma mensagem em Criar templates.'
      :`Nenhum template${GC.describe([ft.status==='APPROVED'?'aprovado':ft.status==='outros'?'não aprovado':'',
          ['UTILITY','MARKETING','AUTHENTICATION'].includes(ft.categoria)?GC.categoryLabel(ft.categoria):ft.categoria==='divergente'?'com categoria divergente':'',
          ft.uso==='current'?'mapeado em fluxo':ft.uso==='native_pending'?'com integração pendente':ft.uso!=='todos'?GC.usoLabel(ft.uso):'',GC.search?`contendo "${e(GC.search)}"`:''])}${model.marca!=='todas'?` de ${e(GC.brand(model.marca))}`:''} neste recorte.`;
    const th=(key,label,cls='')=>`<th data-sort="${key}"${cls?` class="${cls}"`:''}><button type="button" class="gt-th">${e(label)}</button></th>`;
    templateRoot.innerHTML=GC.metadata(model)+GC.emailCatalog(ctx)+`<div class="control-explainer">${GC.badge('Templates WhatsApp','neutral','Status e categoria da última consulta. Use Carregar conteúdo publicado para conferir a mensagem.')}${GC.badge('Aprovação não comprova envio','neutral','Um template mapeado pode pertencer a uma jornada em simulação.')}${GC.badge('Uso indicado por template','neutral','Opcionais e retirados têm sua justificativa e não são tarefas de integração obrigatórias.')}</div>
      ${model.canal==='email'?(['fish','aristo','todas','todos'].includes(model.marca)?'<p class="mini">Para consultar também as mensagens de WhatsApp, selecione Todos os canais.</p>':'<div class="vazio">Este catálogo acompanha templates de WhatsApp. Selecione WhatsApp ou Todos os canais no filtro acima.</div>'):`<div class="gt-toolbar control-toolbar control-template-toolbar"><label class="gt-busca" for="control-template-search">Buscar template<input type="search" id="control-template-search" placeholder="Nome ou peça" value="${e(GC.search)}" autocomplete="off"></label>
        ${GC.select('control-tpl-status',GC.STATUS_TPL,ft.status,'Status')}${GC.select('control-tpl-categoria',GC.CATEGORIAS_TPL,ft.categoria,'Categoria')}${GC.select('control-tpl-uso',GC.USOS_TPL,ft.uso,'Uso')}
        <span class="gt-contagem">${templates.length} de ${model.templates.length} templates neste recorte</span>
        ${tplFiltered?'<button type="button" class="refresh-btn gt-limpar" data-clear="tpl">Limpar filtros</button>':''}
        ${GC.caps?.pode?.read_content?`<button type="button" class="refresh-btn" id="control-tpl-conteudo"${GC.carregando?' disabled':''} title="Carrega a mensagem publicada para conferir a prévia. Esta consulta não altera o template.">${GC.carregando==='listar'?'Carregando…':GC.conteudo?`Recarregar conteúdo publicado (${GC.stamp(GC.conteudoEm)})`:'Carregar conteúdo publicado'}</button>`:''}
        <button type="button" class="refresh-btn gt-export" id="control-tpl-export"${templates.length?'':' disabled'}>Exportar CSV</button></div>${GC.conteudoErro?`<p class="control-warning">${e(GC.conteudoErro)}</p>`:''}
        <div class="rolagem"><table class="comparativo control-template-table" id="control-template-table"><thead><tr>${th('piece','Template / marca')}${th('status','Status e categoria')}${th('usage','Uso')}${th('collection','Consulta')}</tr></thead><tbody>${templates.length?templates.map(GC.template).join(''):`<tr><td colspan="4"><div class="vazio">${tplEmpty}${tplFiltered?' <button type="button" class="refresh-btn gt-limpar" data-clear="tpl">Limpar filtros</button>':''}</div></td></tr>`}</tbody></table></div>`}
      <span class="control-badge" title="Use Criar templates para preparar e publicar mensagens. Para editar etapas, pausar ou reativar uma jornada, abra Jornadas.">Edição em Criar templates e Jornadas</span>`;
    if(hasGT)GT.marcaCabecalhos(templateRoot.querySelector('#control-template-table'),ft);
    workflowRoot.querySelectorAll('[data-control-workflow]').forEach(card=>{if(openDetails.includes(card.dataset.controlWorkflow))card.querySelector('details').open=true;});
    const rerender=()=>GC.render(ctx);
    const input=templateRoot.querySelector('#control-template-search');
    if(restoreInput&&input){input.focus();input.setSelectionRange?.(...selection);}
    if(input)input.oninput=()=>{const position=input.selectionStart;GC.search=input.value;GC.render(ctx);const next=templateRoot.querySelector('#control-template-search');next?.focus();next?.setSelectionRange?.(position,position);};
    const wfInput=workflowRoot.querySelector('#control-workflow-search');
    if(wfInput)wfInput.oninput=()=>{const position=wfInput.selectionStart;GC.filters.wf.q=wfInput.value;GC.render(ctx);const next=workflowRoot.querySelector('#control-workflow-search');next?.focus();next?.setSelectionRange?.(position,position);};
    const bind=(id,apply)=>{const el=document.getElementById(id);if(el)el.onchange=()=>{apply(el.value);rerender();};};
    bind('control-wf-estado',v=>GC.filters.wf.estado=v);bind('control-wf-modo',v=>GC.filters.wf.modo=v);
    bind('control-tpl-status',v=>GC.filters.tpl.status=v);bind('control-tpl-categoria',v=>GC.filters.tpl.categoria=v);bind('control-tpl-uso',v=>GC.filters.tpl.uso=v);
    document.querySelectorAll('#control-workflows [data-clear="wf"]').forEach(b=>b.onclick=()=>{GC.filters.wf={q:'',estado:'todas',modo:'todos'};rerender();});
    document.querySelectorAll('#control-templates [data-clear="tpl"]').forEach(b=>b.onclick=()=>{GC.search='';GC.filters.tpl={...GC.filters.tpl,status:'todos',categoria:'todas',uso:'todos'};rerender();});
    templateRoot.querySelectorAll('th[data-sort]').forEach(th=>th.onclick=()=>{if(!hasGT)return;GC.filters.tpl={...GC.filters.tpl,...GT.proximaOrdem(GC.filters.tpl,th.dataset.sort,false)};rerender();});
    const meta=()=>typeof ctx.exportMeta==='function'?ctx.exportMeta({}):{};
    const wfExport=document.getElementById('control-wf-export');
    if(wfExport)wfExport.onclick=()=>{if(!hasGT)return;const m={...meta(),coleta_inventario:GC.stamp(model.meta.generated_at)};delete m.periodo_inicio;delete m.periodo_fim;GT.baixar(GT.nomeArquivo('automacoes-operacao',m),GT.csv(GC.workflowColumns,workflows,m));};
    const tplExport=document.getElementById('control-tpl-export');
    document.querySelectorAll('[data-tpl-preview-email]').forEach(b=>b.onclick=()=>{const t=GC.conteudo?.[b.dataset.tplPreviewEmail];if(t?.components?.body_html)GMP.openEmail({source:t.components.body_html,subject:t.components.subject,label:'Prévia do template publicado'});});
    GC.bindPreviews(workflowRoot,ctx);GC.bindPreviews(templateRoot,ctx);
    const tplConteudo=document.getElementById('control-tpl-conteudo');if(tplConteudo)tplConteudo.onclick=()=>GC.carregarConteudo(ctx);
    templateRoot.querySelectorAll('[data-tpl-historico]').forEach(b=>b.onclick=()=>GC.carregarHistorico(ctx,b.dataset.tplHistorico));
    if(tplExport)tplExport.onclick=()=>{if(!hasGT)return;const m={...meta(),coleta_inventario:GC.stamp(model.meta.generated_at)};delete m.periodo_inicio;delete m.periodo_fim;GT.baixar(GT.nomeArquivo('templates',m),GT.csv(GC.templateColumns,templates,m));};
    if(hasGT){if(keptWf&&!restoreInput)GT.restaura(workflowRoot,keptWf);if(keptTpl&&!restoreInput)GT.restaura(templateRoot,keptTpl);}
    GC.setTab(GC.activeTab);
    return model;
  },
  setTab(tab){
    if(!['history','workflows','templates','fluxos','drafts'].includes(tab))return;
    GC.activeTab=tab;
    if(typeof document==='undefined')return;
    document.querySelectorAll('[data-control-tab]').forEach(button=>{const selected=button.dataset.controlTab===tab;button.classList.toggle('ativo',selected);button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
    document.querySelectorAll('[data-control-panel]').forEach(panel=>{panel.hidden=panel.dataset.controlPanel!==tab;});
    if(tab==='fluxos'&&typeof GB!=='undefined'&&GB.state.loaded){
      const f=GB.state.flows.find(x=>x.key===GB.state.selected);
      if(f)for(const channel of new Set(f.available_steps.map(s=>s.channel)))GB.loadTemplates(f.brand,channel);
    }
  },
  init(){
    if(typeof document==='undefined')return;
    const allButtons=[...document.querySelectorAll('[data-control-tab]')];
    allButtons.forEach(button=>{const buttons=allButtons.filter(b=>b.closest('[role=tablist]')===button.closest('[role=tablist]')),index=buttons.indexOf(button);button.onclick=()=>GC.setTab(button.dataset.controlTab);button.onkeydown=event=>{let next;if(event.key==='ArrowRight')next=(index+1)%buttons.length;else if(event.key==='ArrowLeft')next=(index+buttons.length-1)%buttons.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=buttons.length-1;else return;event.preventDefault();buttons[next].click();buttons[next].focus();};});
    GC.setTab(GC.activeTab);
  },
};
if(typeof module!=='undefined'&&module.exports)module.exports=GC;
