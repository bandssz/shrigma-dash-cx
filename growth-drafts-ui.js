/* Editor de rascunhos — tela. Regras e armazenamento local em growth-drafts.js; regras da API em growth-templates-api.js.
   Sem `capabilities` na resposta do GET Growth, esta tela é a mesma da Entrega 2: rascunho salvo só neste dispositivo.
   Com capacidades, aparecem Salvar no servidor → Validar → Publicar template → acompanhar.
   Publicar cadastra o template; enviar um teste é uma ação separada com confirmação explícita. */
'use strict';
const GRU={
  state:{editando:null,rascunho:null,msg:'',msgTone:'ok',filtro:'todos',ocupado:null,confirmando:false,confirmTexto:''},
  acesso:{aberto:false,chave:null,ignorarLegada:false,retorno:'drafts-chave'},
  ctx:{},caps:null,contextBrand:null,contextSaved:null,contextError:'',emailTestSession:null,replicationSession:false,nativeEmailSession:false,
  e:s=>GR.esc(s),
  stamp(v){return GTA.stamp(v);},
  rotulo(lista,k){return (lista.find(([v])=>v===k)||[])[1]||k;},
  opts(lista,val){return lista.map(([v,t])=>`<option value="${GRU.e(v)}"${v===val?' selected':''}>${GRU.e(t)}</option>`).join('');},
  /* Catálogo: só associação por nome EXATO. Não inventa corpo, não diz que o rascunho é o template. */
  noCatalogo(nome,marca,canal){
    const tpls=GRU.ctx.api?.crm_operacao?.templates;
    return Array.isArray(tpls)?tpls.find(t=>t&&t.name===nome&&t.brand===marca&&t.channel===canal)||null:null;
  },
  workflows(){const w=GRU.ctx.api?.crm_operacao?.workflows;return Array.isArray(w)?w.filter(x=>x&&typeof x==='object'):[];},
  capacidades(){return GTA.caps(GRU.ctx.api,{TEMPLATE_API_URL:typeof TEMPLATE_API_URL!=='undefined'?TEMPLATE_API_URL:undefined});},
  /* ---------- chaves ---------- */
  store(){try{return typeof localStorage!=='undefined'?localStorage:null;}catch(_){return null;}},
  guardado(slot){try{return GRU.store()?.getItem(slot)||'';}catch(_){return '';}},
  chaveEscrita(){
    return GRU.acesso.chave||(!GRU.acesso.ignorarLegada?((typeof shrigmaChaveOperador==='function'?shrigmaChaveOperador('growth','draft'):'')||GRU.guardado(GTA.CHAVE_ESCRITA)):'')||null;
  },
  esqueceChave(){
    GRU.acesso.chave=null;GRU.acesso.ignorarLegada=true;
    try{GRU.store()?.removeItem(GTA.CHAVE_ESCRITA);}catch(_){}
  },
  abrirAcesso(){
    if(GRU.state.ocupado||GRU.emailTestSession||GRU.replicationSession||GRU.nativeEmailSession)return;
    GRU.acesso.retorno=typeof document!=='undefined'?document.activeElement?.id||'drafts-chave':'drafts-chave';
    GRU.acesso.aberto=true;GRU.render();
    document.getElementById('drafts-chave-escrita')?.focus();
  },
  fecharAcesso(){
    const campo=document.getElementById('drafts-chave-escrita');if(campo)campo.value='';
    GRU.acesso.aberto=false;GRU.render();
    (document.getElementById(GRU.acesso.retorno)||document.getElementById('drafts-chave'))?.focus();
  },
  formularioAcesso(){
    if(!GRU.acesso.aberto)return '';
    return `<form class="drafts-scope" id="drafts-acesso" aria-labelledby="drafts-acesso-titulo">
      <strong id="drafts-acesso-titulo">Acesso para editar templates</strong>
      <p id="drafts-acesso-ajuda">Informe a chave de escrita de templates. A nova chave fica disponível apenas enquanto esta página estiver aberta. Preparar o acesso não salva nem submete uma mensagem. Depois, escolha a ação desejada.</p>
      <label for="drafts-chave-escrita">Chave de escrita de templates</label>
      <div class="draft-confirm-row"><input type="password" id="drafts-chave-escrita" required autocomplete="off" spellcheck="false" aria-describedby="drafts-acesso-ajuda drafts-acesso-erro">
      <button type="submit" class="btn">Preparar acesso</button><button type="button" class="btn sec" id="drafts-acesso-cancelar">Cancelar</button></div>
      <p id="drafts-acesso-erro" role="alert"></p></form>`;
  },
  prontaEscrita(r){
    if(GRU.state.ocupado||GRU.emailTestSession||GRU.replicationSession||GRU.nativeEmailSession)return false;
    if(GRU.contextError||GRU.ctx.marca&&r.marca!==GRU.ctx.marca){GRU.aviso(GRU.contextError||'Abra a marca deste template no cabeçalho antes de editar.','erro');GRU.render();return false;}
    const j=GRU.journal(),estado=j?.inspect();
    if(!j||estado.blocked||r?.servidor?.pendente){GRU.aviso(estado?.message||'A proteção de operações de templates está indisponível. Nenhuma operação foi enviada.','erro');GRU.render();return false;}
    if(GRU.chaveEscrita())return true;
    GRU.aviso('Sem chave de escrita: nada foi enviado.','erro');GRU.abrirAcesso();return false;
  },
  journal(){
    if(typeof GTJ==='undefined')return null;
    const endpoint=(GRU.caps||GRU.capacidades()).endpoint,storage=GRU.store();
    if(GRU._journal?.endpoint===endpoint&&GRU._journal.storage===storage)return GRU._journal.value;
    const legacyPending=()=>{
      const raw=storage?.getItem(GR.CHAVE),rows=raw===null||raw===undefined?[]:JSON.parse(raw);
      if(!Array.isArray(rows))throw Error('invalid local drafts');
      return !!GRU.state.rascunho?.servidor?.pendente||rows.some(r=>r?.servidor?.pendente);
    };
    const value=GTJ.create({endpoint,storage,locks:typeof navigator!=='undefined'?navigator.locks:null,crypto:typeof crypto!=='undefined'?crypto:null,legacyPending});
    GRU._journal={endpoint,storage,value};return value;
  },
  operacoes(){
    if(!GRU.caps?.endpoint)return '';
    const estado=GRU.journal()?.inspect();
    if(!estado)return '<div class="drafts-scope" role="status">Proteção de operações indisponível. A escrita no servidor está bloqueada.</div>';
    const linhas=[...estado.operations].reverse().slice(0,8);
    return `<div class="drafts-scope" aria-label="Registro de operações de templates">${estado.blocked?`<p role="status">${GRU.e(estado.message)}</p>`:''}${linhas.length?`<details${estado.operations.some(x=>['pending','unknown'].includes(x.phase))?' open':''}><summary>Operações registradas neste navegador (${estado.operations.length})</summary><ul>${linhas.map(op=>`<li>${GRU.e(op.request_payload.acao)} · ${GRU.e(op.id)} · ${GRU.e({pending:'aguardando confirmação',unknown:'resultado incerto',confirmed:'confirmada',rejected:'recusada com recibo'}[op.phase])} <button type="button" class="refresh-btn" data-template-operacao="${GRU.e(op.id)}"${GRU.state.ocupado?' disabled':''}>${['pending','unknown'].includes(op.phase)?'Conferir esta operação':'Abrir recibo'}</button></li>`).join('')}</ul><p>Conferir consulta somente esta tentativa. Não repete a operação. Ausência de recibo não libera um novo envio.</p></details>`:''}</div>`;
  },
  preservarLocal(r){
    if(!GR.guarda(r))return false;
    try{const rows=JSON.parse(GRU.store().getItem(GR.CHAVE)),saved=rows.find(x=>x.id===r.id);return !!saved&&GTJ.canonical(GR.conteudo(saved))===GTJ.canonical(GR.conteudo(r))&&GTJ.canonical(saved.servidor||null)===GTJ.canonical(r.servidor||null);}catch(_){return false;}
  },
  clienteSeguro(escrita,r){
    const client=GRU.cliente(escrita,typeof GENU!=='undefined'&&GENU.advanced(r)),journal=GRU.journal();
    const send=payload=>journal.run({local_id:r.id,request_payload:payload},{persistLocal:()=>GRU.preservarLocal(r),lookup:(id,acao)=>client.operacao(id,acao),transport:p=>p.acao==='rascunho'?client.rascunho(p.rascunho,{idempotency_key:p.idempotency_key,...(p.draft_id?{draft_id:p.draft_id,expected_version:p.expected_version}:{})}):p.acao==='validar'?client.validar(p.draft_id,p.idempotency_key,p.expected_version):client.submeter(p.draft_id,p.expected_version,p.confirm,p.idempotency_key)});
    return {...client,rascunho:(rascunho,extra)=>send({acao:'rascunho',rascunho,...extra}),validar:(draft_id,_idem,expected_version)=>send({acao:'validar',draft_id,expected_version}),submeter:(draft_id,expected_version,confirm)=>send({acao:'submeter',draft_id,expected_version,confirm})};
  },
  cliente(escrita,bearerWrite=false){
    const c=GRU.caps||GRU.capacidades();
    return GTA.cliente({endpoint:c.endpoint,fetch:typeof fetch==='function'?fetch:null,chaveLeitura:GTA.chaveLeitura(),chaveEscrita:escrita||'',bearerWrite});
  },
  /* ---------- render ---------- */
  render(ctx){
    if(ctx&&(GRU.emailTestSession||GRU.replicationSession||GRU.nativeEmailSession)&&ctx.marca!==undefined&&ctx.marca!==GRU.contextBrand)return false;
    if(ctx){GRU.ctx=ctx;if(ctx.marca!==undefined&&ctx.marca!==GRU.contextBrand)GRU.enterBrand(ctx.marca);}
    GRU.caps=GRU.capacidades();
    const root=typeof document!=='undefined'?document.querySelector('#control-drafts'):null;
    if(!root)return;
    const kept=typeof GT!=='undefined'?GT.captura(root):null;
    const caps=GRU.caps,todos=GR.lista().filter(d=>!GRU.ctx.marca||GRU.ctx.marca==='todas'||d.marca===GRU.ctx.marca),r=GRU.state.rascunho;
    const comServidor=caps.declaradas||todos.some(d=>GTA.situacao(d).estado!=='local');
    const lista=todos.filter(d=>GRU.state.filtro==='todos'||GTA.situacao(d).estado===GRU.state.filtro||(GRU.state.filtro==='sujo'&&GTA.situacao(d).sujo));
    const submetidos=todos.filter(d=>GTA.situacao(d).estado==='submetido');
    const ferramentas=`<div class="gt-toolbar drafts-toolbar"><button type="button" class="btn" id="drafts-novo"${GRU.ctx.marca==='todas'?' disabled':''}>Criar template WhatsApp</button><button type="button" class="btn sec" id="drafts-novo-email"${GRU.ctx.marca==='todas'?' disabled':''}>Criar template de e-mail</button>
      ${typeof GENU!=='undefined'?`<button type="button" class="btn sec" id="drafts-native-email"${GRU.ctx.marca==='todas'?' disabled':''}>Copiar e-mail publicado</button>`:''}<button type="button" class="refresh-btn drafts-importar" id="drafts-importar">Importar arquivo</button><input type="file" id="drafts-arquivo" accept="application/json,.json" aria-label="Arquivo de rascunho para importar" hidden>
      ${comServidor?`<label class="gt-filtro">Estado<select id="drafts-filtro" data-gt-filter="drafts-filtro"><option value="todos"${GRU.state.filtro==='todos'?' selected':''}>Todos</option>${GTA.ESTADOS.map(([v,t])=>`<option value="${v}"${GRU.state.filtro===v?' selected':''}>${GRU.e(t)}</option>`).join('')}<option value="rejeitado"${GRU.state.filtro==='rejeitado'?' selected':''}>Rejeitado</option><option value="sujo"${GRU.state.filtro==='sujo'?' selected':''}>Alterado após salvar no servidor</option></select></label>`:''}
      ${submetidos.length&&caps.endpoint?`<button type="button" class="refresh-btn" id="drafts-verificar"${GRU.state.ocupado?' disabled':''}>Verificar ${submetidos.length===1?'a submissão':`${submetidos.length} submissões`} agora</button>`:''}
      <span class="gt-contagem">${lista.length}${lista.length!==todos.length?` de ${todos.length}`:''} rascunho${todos.length===1?'':'s'} neste dispositivo</span>${GRU.state.msg?`<span class="drafts-msg" data-tone="${GRU.e(GRU.state.msgTone)}" role="status">${GRU.e(GRU.state.msg)}</span>`:''}</div>`;
    const listaHtml=lista.length?`<div class="draft-grid">${lista.map(d=>GRU.cartao(d,caps)).join('')}</div>`
      :`<div class="vazio">${todos.length?'Nenhum rascunho neste estado. <button type="button" class="refresh-btn gt-limpar" id="drafts-limpar">Ver todos</button>':'Nenhum rascunho neste dispositivo. Comece por "Criar template" ou importe um arquivo exportado em outro computador.'}</div>`;
    root.innerHTML=(GRU.ctx.marca==='todas'?'<p class="mini">Escolha uma marca no cabeçalho para criar um template. Abrir um rascunho leva à marca dele.</p>':'')+GRU.escopo(caps)+GRU.operacoes()+GRU.emailTestOperations()+ferramentas+(typeof GERU!=='undefined'?GERU.html():'')+(typeof GENU!=='undefined'?GENU.html():'')+(r?GRU.editor(r,caps):'')+listaHtml;
    GRU.bind(root,caps);
    GRU.bindEmailTest(root);
    if(typeof GERU!=='undefined')GERU.bind(root);
    if(typeof GENU!=='undefined')GENU.bind(root);
    if(GRU.nativeEmailSession)root.querySelectorAll('button,input,select,textarea').forEach(el=>{if(!el.closest('#email-native-import'))el.disabled=true;});
    if(GRU.replicationSession)root.querySelectorAll('button,input,select,textarea').forEach(el=>{if(!el.closest('#email-replication'))el.disabled=true;});
    if(GRU.emailTestSession)root.querySelectorAll('button,input,select,textarea').forEach(el=>{if(!el.closest('#d-email-test-confirm'))el.disabled=true;});
    GRU.agenda();
    if(kept&&typeof GT!=='undefined')GT.restaura(root,kept);
  },
  escopo(caps){
    if(!caps.declaradas)return `<div class="drafts-scope"><strong>Rascunhos neste dispositivo</strong><span class="control-badge" title="Salve antes de fechar. Exporte o arquivo para continuar em outro computador. A publicação não está disponível neste acesso.">Publicação indisponível</span></div>`;
    if(caps.semEndpoint)return `<div class="drafts-scope" role="status"><strong>Publicação indisponível</strong><span title="A conexão de templates não foi informada. Seus rascunhos permanecem neste dispositivo.">Atualize o painel para tentar novamente.</span></div>`;
    const chave=GRU.chaveEscrita();
    return `<div class="drafts-scope drafts-scope-api"><div><strong>Templates</strong><span class="control-badge" title="Salvar guarda uma versão para revisão. Publicar cadastra o template; enviar teste e ativar um fluxo são ações separadas, com confirmação.">Publicar não envia mensagens</span></div>
      <div class="drafts-key"><span class="mini">${chave?'Acesso de edição disponível':'Acesso de edição necessário'}</span><button type="button" class="refresh-btn" id="drafts-chave" aria-expanded="${GRU.acesso.aberto}"${GRU.state.ocupado?' disabled':''}>${chave?'Trocar acesso':'Informar chave'}</button></div></div>${GRU.formularioAcesso()}`;
  },
  passos(d){
    const {estado,sujo}=GTA.situacao(d),ord=GTA.ORDEM[estado]??0;
    return `<ol class="draft-steps" aria-label="Etapas do template">${GTA.ESTADOS.map(([k,t],i)=>{const st=estado==='rejeitado'&&k==='publicado'?'rejeitado':i<ord?'feito':i===ord?'atual':'';return `<li data-passo="${k}"${st?` data-st="${st}"`:''}>${GRU.e(estado==='rejeitado'&&k==='publicado'?'Rejeitado':t)}</li>`;}).join('')}</ol>${sujo?'<span class="mini draft-sujo">Alterações ainda não salvas no servidor</span>':''}`;
  },
  cartao(d,caps){
    const v=GR.valida(d),cat=GRU.noCatalogo(d.nome,d.marca,d.canal),sit=GTA.situacao(d),s=sit.servidor;
    const rot=GTA.rotuloEstado(d,{workflows:GRU.workflows(),mapped_in:s?.mapped_in});
    const acoes=GTA.acoes(caps,d);
    const eventos=[...(s?.historico||[]).map(x=>({...x,origem:'api'})),...(s?.eventos||[])].sort((a,b)=>String(b.at).localeCompare(String(a.at)));
    return `<article class="draft-card" data-draft="${GRU.e(d.id)}" data-estado="${GRU.e(sit.estado)}"><div class="draft-head"><div><span class="control-overline">${GRU.e(GRU.rotulo(GR.MARCAS,d.marca))} · ${GRU.e(GRU.rotulo(GR.CANAIS,d.canal))}${d.canal==='whatsapp'?` · ${GRU.e(d.categoria||'')}`:''}</span>
      <h3>${GRU.e(d.nome||'(sem nome)')}</h3>${d.peca?`<span class="flow-sub">peça: ${GRU.e(d.peca)}</span>`:''}</div>
      <span class="control-badge control-${GRU.e(rot.tone)}">${GRU.e(rot.texto)}</span></div>
      ${caps.declaradas||sit.estado!=='local'?GRU.passos(d):''}
      <p class="draft-excerpt">${GRU.e((d.canal==='email'?(d.assunto?d.assunto+' — ':''):'')+String(d.corpo||'').slice(0,140))}${String(d.corpo||'').length>140?'…':''}</p>
      ${cat?`<p class="control-warning">Existe um template com este nome no catálogo da Meta (status ${GRU.e(cat.status||'?')}, categoria ${GRU.e(cat.category||'?')}). O rascunho não é esse template e o catálogo não traz o corpo dele para comparar.</p>`:''}
      <div class="draft-meta">${v.erros.length?`<span class="control-badge control-warning">${v.erros.length} pendência${v.erros.length===1?'':'s'}</span>`:v.avisos.length?`<span class="control-badge">${v.avisos.length} aviso${v.avisos.length===1?'':'s'}</span>`:'<span class="control-badge control-info">Conteúdo conferido</span>'}<span>editado ${GRU.stamp(d.atualizado_em)}</span>${s?`<span title="Versão do rascunho no servidor e hora da última confirmação da API">servidor v${GRU.e(s.version)} · ${GRU.stamp(s.confirmado_em||s.salvo_em)}</span>`:''}${sit.estado==='submetido'?`<span title="Última consulta do painel ao estado da submissão">verificado ${GRU.stamp(s.checked_at)||'—'}</span>`:''}</div>
      ${s?`<details class="control-detail draft-historico" data-gt-key="hist-${GRU.e(d.id)}"><summary>Histórico (${eventos.length})</summary>${eventos.length?`<ul>${eventos.map(x=>`<li><time>${GRU.stamp(x.at)}</time> · ${GRU.e(x.who||'?')} · ${GRU.e(x.action)}${Number.isFinite(+x.from_version)||Number.isFinite(+x.to_version)?` v${GRU.e(x.from_version??'—')}→v${GRU.e(x.to_version??'—')}`:''} · ${GRU.e(x.result||'')}${x.detail?` · ${GRU.e(x.detail)}`:''}</li>`).join('')}</ul>`:'<p>Nenhuma alteração registrada. Salve no servidor para iniciar o histórico.</p>'}${acoes.historico?`<button type="button" class="refresh-btn" data-draft-historico="${GRU.e(d.id)}"${GRU.state.ocupado?' disabled':''}>Atualizar histórico</button>`:''}</details>`:''}
      <div class="draft-actions"><button type="button" class="refresh-btn" data-draft-edit="${GRU.e(d.id)}">Editar</button>${acoes.verificar?`<button type="button" class="refresh-btn" data-draft-verificar="${GRU.e(d.id)}"${GRU.state.ocupado?' disabled':''}>Verificar agora</button>`:''}<button type="button" class="refresh-btn" data-draft-export="${GRU.e(d.id)}">Exportar arquivo</button><button type="button" class="refresh-btn" data-draft-dup="${GRU.e(d.id)}">Duplicar nesta marca</button>${d.canal==='email'&&['fish','aristo'].includes(d.marca)?`<button type="button" class="refresh-btn" data-email-replicate="${GRU.e(d.id)}">Copiar para ${d.marca==='fish'?'O Aristocrata':'Fishermans'}</button>`:''}<button type="button" class="refresh-btn draft-delete" data-draft-delete="${GRU.e(d.id)}">Excluir</button></div></article>`;
  },
  editor(r,caps){
    const wa=r.canal==='whatsapp',vars=GR.variaveis(r.corpo),v=GR.valida(r),sit=GTA.situacao(r),s=sit.servidor,acoes=GTA.acoes(caps,r),oc=GRU.state.ocupado;
    const rot=GTA.rotuloEstado(r,{workflows:GRU.workflows(),mapped_in:s?.mapped_in});
    const botoes=(r.botoes||[]).map((b,i)=>`<div class="draft-botao" data-botao="${i}"><select data-botao-campo="tipo" aria-label="Tipo do botão ${i+1}">${GRU.opts(wa?GR.TIPOS_BOTAO:GR.TIPOS_BOTAO.filter(([k])=>k==='url'),b.tipo)}</select>
      <input type="text" data-botao-campo="texto" maxlength="${GR.LIMITES.botao}" placeholder="Texto do botão" value="${GRU.e(b.tipo==='order_details'?'Copiar código Pix':b.texto)}"${b.tipo==='order_details'?' readonly':''} aria-label="Texto do botão ${i+1}">
      ${['quick_reply','order_details'].includes(b.tipo)?'':`<input type="text" data-botao-campo="valor" placeholder="${b.tipo==='url'?'https://…':'+55…'}" value="${GRU.e(b.valor)}" aria-label="${b.tipo==='url'?'Link':'Telefone'} do botão ${i+1}">`}
      <button type="button" class="mais" data-botao-remover="${i}" title="Remover botão">–</button></div>`).join('');
    const provedor=wa?'Meta':'Listmonk';
    const dis=oc?' disabled':'';
    const servidorBar=caps.pode.draft?`<div class="draft-server-actions">
        <button type="button" class="btn sec" id="d-servidor"${dis}>${oc==='rascunho'?'Salvando…':s?`Salvar no servidor (v${GRU.e(s.version)}${sit.sujo?' → nova versão':''})`:'Salvar no servidor'}</button>
        ${acoes.validar?`<button type="button" class="btn sec" id="d-validar"${dis}>${oc==='validar'?'Validando…':'Conferir conteúdo'}</button>`:''}
        ${acoes.submeter?`<button type="button" class="btn" id="d-submeter"${dis||(GRU.state.confirmando?' disabled':'')}>${wa?'Enviar para aprovação…':'Publicar template…'}</button>`:''}
        ${acoes.verificar?`<button type="button" class="refresh-btn" id="d-verificar"${dis}>${oc==='submissao'?'Consultando…':'Verificar aprovação'}</button>`:''}
        <span class="mini">${s?`Servidor: v${GRU.e(s.version)} · ${GRU.e(rot.texto)}${sit.sujo?' · salve as alterações antes de continuar':''}`:'Salve no servidor para conferir e publicar.'}${caps.validate&&s&&!sit.sujo&&sit.estado==='rascunho'&&caps.pode.submit?' · confira o conteúdo antes de publicar':''}</span></div>
        ${s?.conflito?`<div class="draft-conflito control-warning"><strong>Alguém alterou este rascunho no servidor antes de você.</strong> ${GRU.e(`Por ${s.conflito.changed_by||'outra chave'} às ${GRU.stamp(s.conflito.changed_at)}; versão atual v${s.conflito.current_version??'?'}. Nada foi sobrescrito.`)} <button type="button" class="refresh-btn" id="d-refazer">Refazer sobre a v${GRU.e(s.conflito.current_version??'?')}</button> <span class="mini">Refazer só ajusta a versão esperada; o conteúdo continua o seu e nada é enviado até você salvar de novo.</span></div>`:''}
        ${GRU.state.confirmando&&acoes.submeter?GRU.confirmacao(r,provedor):''}`
      :caps.semEndpoint?'<p class="mini draft-server-off" role="status">Publicação indisponível. Atualize o painel para tentar novamente.</p>':'';
    return `<section class="painel draft-editor" id="draft-editor" aria-label="Editor de rascunho"><div class="painel-cab"><h2>${GRU.state.editando?'Editar rascunho':'Novo rascunho'}</h2><span class="control-badge control-${GRU.e(rot.tone)}">${GRU.e(rot.texto)}</span></div>
      <div class="draft-form"><div class="form">
        <div class="campo"><label for="d-nome">${'Nome do template'}</label><input type="text" id="d-nome" data-campo="nome" value="${GRU.e(r.nome)}" placeholder="${wa?'fishermans_rastreio_v3':'carta-do-fundador-02'}"><span class="ajuda">${wa?'Como ficará na Meta: minúsculas, números e _.':'Este nome aparecerá no catálogo de e-mail.'}</span></div>
        <div class="campo"><label for="d-marca">Marca</label><select id="d-marca" disabled>${GRU.opts(GR.MARCAS.filter(([k])=>k!=='olivas'||r.marca==='olivas'),r.marca)}</select></div>
        <div class="campo"><label for="d-canal">Canal</label><select id="d-canal" data-campo="canal">${GRU.opts(GR.CANAIS,r.canal)}</select></div>
        ${wa?`<div class="campo"><label for="d-idioma">Idioma</label><input type="text" id="d-idioma" data-campo="idioma" value="${GRU.e(r.idioma)}" placeholder="pt_BR"></div>
        <div class="campo"><label for="d-categoria">Categoria esperada</label><select id="d-categoria" data-campo="categoria">${GRU.opts(GR.CATEGORIAS,r.categoria)}</select><span class="ajuda">Utility deve tratar de uma solicitação ou transação específica, sem promoção. A Meta define a categoria final.</span></div>`
        :`<div class="campo"><label for="d-from-email">Remetente</label><input type="text" id="d-from-email" data-campo="from_email" maxlength="254" value="${GRU.e(r.from_email)}" placeholder="Nome &lt;contato@dominio.com&gt;"></div>
        <div class="campo"><label for="d-reply-to">Responder para</label><input type="email" id="d-reply-to" data-campo="reply_to" maxlength="254" value="${GRU.e(r.reply_to)}"></div>
        <div class="campo largo"><label for="d-assunto">Assunto</label><input type="text" id="d-assunto" data-campo="assunto" maxlength="150" value="${GRU.e(r.assunto)}"></div>
        <div class="campo largo"><label for="d-preheader">Pré-header</label><input type="text" id="d-preheader" data-campo="preheader" maxlength="200" value="${GRU.e(r.preheader)}" placeholder="Complemento do assunto na caixa de entrada"></div>`}
        <div class="campo"><label for="d-peca">Nome da etapa (opcional)</label><input type="text" id="d-peca" data-campo="peca" value="${GRU.e(r.peca)}" placeholder="rastreio-criado"><span class="ajuda">Mesmo nome da peça usado nas automações, para bater com o histórico.</span></div>
        ${wa?`<div class="campo largo"><label for="d-cabecalho">Cabeçalho (opcional)</label><input type="text" id="d-cabecalho" data-campo="cabecalho" maxlength="${GR.LIMITES.cabecalho}" value="${GRU.e(r.cabecalho)}"><span class="ajuda" id="d-cabecalho-conta">${String(r.cabecalho||'').length} de ${GR.LIMITES.cabecalho}</span></div>`:''}
        <div class="campo largo"><label for="d-corpo">Corpo</label><textarea id="d-corpo" data-campo="corpo" rows="7" placeholder="${wa?'Olá {{1}}, seu pedido {{2}} saiu para entrega…':'Texto do e-mail…'}">${GRU.e(r.corpo)}</textarea><span class="ajuda" id="d-corpo-conta">${GRU.contaCorpo(r)}</span></div>
        ${wa?`<div class="campo largo"><label for="d-rodape">Rodapé (opcional)</label><input type="text" id="d-rodape" data-campo="rodape" maxlength="${GR.LIMITES.rodape}" value="${GRU.e(r.rodape)}"><span class="ajuda" id="d-rodape-conta">${String(r.rodape||'').length} de ${GR.LIMITES.rodape}</span></div>`:''}
        ${wa&&vars.length?`<div class="campo largo"><label>Exemplos das variáveis</label><div class="draft-exemplos">${vars.map(n=>`<label>{{${n}}}<input type="text" data-exemplo="${n}" value="${GRU.e((r.exemplos||{})[n]||'')}" placeholder="exemplo real, sem dado de cliente"></label>`).join('')}</div><span class="ajuda">A Meta pede um exemplo por variável. Use valores fictícios.</span></div>`:''}
        <div class="campo largo"><label>Botões ${wa?`(até ${GR.LIMITES.botoes})`:'(links do e-mail)'}</label><div class="draft-botoes" id="d-botoes">${botoes||'<span class="ajuda">Use Adicionar botão para incluir um link.</span>'}</div>
          ${(r.botoes||[]).length<GR.LIMITES.botoes?'<button type="button" class="refresh-btn" id="d-botao-add">Adicionar botão</button>':''}</div>
      </div>
      <div class="draft-preview" aria-live="polite"><div class="draft-preview-head">Prévia<span class="control-badge" title="Mostra o conteúdo deste rascunho, que pode ser diferente da versão publicada.">Rascunho</span></div>${wa?'':typeof GENU!=='undefined'&&GENU.advanced(r)?'<button type="button" class="refresh-btn" id="d-native-preview">Conferir prévia nativa</button>':'<button type="button" class="refresh-btn mp-open" id="d-preview-open">Abrir prévia do HTML ↗</button>'}<div id="d-preview">${GRU.preview(r)}</div>
        <div id="d-checagens">${GRU.checagens(v,s)}</div></div></div>
      <div class="draft-editor-actions"><button type="button" class="btn" id="d-salvar"${dis}>Salvar neste dispositivo</button><button type="button" class="btn sec" id="d-cancelar">Fechar sem salvar</button><button type="button" class="refresh-btn" id="d-exportar">Exportar arquivo</button>${caps.pode.draft?'':'<span class="mini" title="Salvar neste dispositivo não publica o template nem envia mensagens.">Salvo só neste dispositivo</span>'}</div>
      ${servidorBar}${GRU.emailTestControls(r,caps)}</section>`;
  },
  contaCorpo(r){return `${String(r.corpo||'').length}${r.canal==='whatsapp'?` de ${GR.LIMITES.corpo}`:''} caracteres${r.canal==='whatsapp'?' · variáveis como {{1}}, {{2}}':' · Texto ou HTML. Variáveis como {{ .Tx.Data.first_name }}; use apenas os dados indicados na etapa do fluxo.'}`;},
  /* Confirmação textual (R5.4): resumo do que vai para o provedor + a palavra digitada. O botão só liga com a palavra certa. */
  confirmacao(r,provedor){
    const s=r.servidor||{},ok=GRU.state.confirmTexto.trim().toLowerCase()==='submeter',wa=r.canal==='whatsapp';
    return `<div class="draft-confirm" id="d-confirmar" role="dialog" aria-label="Confirmar submissão"><strong>${wa?'Submeter à Meta o rascunho':'Publicar template'} v${GRU.e(s.version)}</strong>
      <dl><dt>Nome</dt><dd>${GRU.e(r.nome)}</dd><dt>Marca · canal</dt><dd>${GRU.e(GRU.rotulo(GR.MARCAS,r.marca))} · ${GRU.e(GRU.rotulo(GR.CANAIS,r.canal))}</dd>${wa?`<dt>Categoria · idioma</dt><dd>${GRU.e(r.categoria)} · ${GRU.e(r.idioma)}</dd>`:`<dt>Assunto</dt><dd>${GRU.e(r.assunto)}</dd>`}<dt>Depois</dt><dd>${wa?'A Meta revisa; aprovado vira "publicado · não ativo". Nenhum workflow muda.':'Cadastra o template no Listmonk. Não envia nenhum e-mail.'}</dd></dl>
      ${s.avisos?.length?`<p class="draft-aviso">Avisos da validação: ${GRU.e(s.avisos.map(a=>a.mensagem||a.codigo).join(' · '))}</p>`:''}
      <label for="d-confirm-texto">Digite <code>submeter</code> para liberar o botão</label><div class="draft-confirm-row"><input type="text" id="d-confirm-texto" value="${GRU.e(GRU.state.confirmTexto)}" autocomplete="off" spellcheck="false"><button type="button" class="btn" id="d-confirm-ok"${ok&&!GRU.state.ocupado?'':' disabled'}>${GRU.state.ocupado==='submeter'?(wa?'Submetendo…':'Publicando…'):(wa?'Submeter agora':'Publicar template')}</button><button type="button" class="btn sec" id="d-confirm-cancel">Cancelar</button></div></div>`;
  },
  preview(r){return r.canal==='email'?(typeof GENU!=='undefined'&&GENU.advanced(r)?GENU.editorPreview(r):GMP.email(r)):GMP.whatsapp(r);},
  checagens(v,s){
    const api=s&&!GTA.situacao({servidor:s,...(GRU.state.rascunho||{})}).sujo?`${(s.erros||[]).map(x=>`<p class="control-warning draft-erro">${GRU.e(x.mensagem||x.codigo)}${x.campo?` (${GRU.e(x.campo)})`:''}</p>`).join('')}${(s.avisos||[]).map(x=>`<p class="draft-aviso">${GRU.e(x.mensagem||x.codigo)}</p>`).join('')}`:'';
    if(!v.erros.length&&!v.avisos.length)return `<span class="control-badge" title="A conferência local não confirma publicação nem entrega. ${GRU.state.rascunho?.canal==='email'?'Confira o conteúdo no servidor e use o envio de teste para revisar o e-mail.':'Confira a versão salva e a aprovação da Meta antes de usar o template.'}">Conteúdo conferido</span>${api}`;
    return `${v.erros.map(x=>`<p class="control-warning draft-erro">${GRU.e(x)}</p>`).join('')}${v.avisos.map(x=>`<p class="draft-aviso">${GRU.e(x)}</p>`).join('')}${api}`;
  },
  atualizaPreview(){
    const r=GRU.state.rascunho;if(!r)return;
    const p=document.getElementById('d-preview'),c=document.getElementById('d-checagens'),n=document.getElementById('d-corpo-conta');
    if(p)p.innerHTML=GRU.preview(r);if(c)c.innerHTML=GRU.checagens(GR.valida(r),r.servidor);
    if(n)n.textContent=GRU.contaCorpo(r);
    const h=document.getElementById('d-cabecalho-conta');if(h)h.textContent=`${String(r.cabecalho||'').length} de ${GR.LIMITES.cabecalho}`;
    const f=document.getElementById('d-rodape-conta');if(f)f.textContent=`${String(r.rodape||'').length} de ${GR.LIMITES.rodape}`;
  },
  /* Email test: preview is read-only; the captured client/version survives until
     confirmation finishes. The durable GETest journal owns transport identity. */
  emailTestKey(){return typeof shrigmaChaveOperador==='function'?shrigmaChaveOperador('growth','submit'):'';},
  emailTestClient(key=GRU.emailTestKey()){
    if(typeof GETest==='undefined'||!GRU.caps?.endpoint)return null;
    try{return GETest.create({endpoint:GRU.caps.endpoint,key,storage:GRU.store(),locks:typeof navigator!=='undefined'?navigator.locks:null,crypto:typeof crypto!=='undefined'?crypto:null,fetch:typeof fetch==='function'?fetch:null});}catch(_){return null;}
  },
  emailTestReason(code){return ({
    manager_required:'Entre com o acesso de gestor do CRM para conferir o teste.',
    draft_unavailable:'Abra um template de e-mail de Fishermans ou O Aristocrata.',
    version_conflict:'O template mudou no servidor. Reabra a versão atual e confira uma nova prévia.',
    published_validated_version_required:'Salve, valide e publique esta versão antes do teste.',
    published_identity_ambiguous:'A publicação precisa ser conferida pelo integrador antes do teste.',
    published_content_mismatch:'O conteúdo publicado mudou. Reabra e confira a publicação antes do teste.',
    email_envelope_required:'Complete remetente, resposta e pré-header; salve, valide e publique a nova versão.',
    recipient_unavailable:'O cadastro de Felipe precisa ser conferido antes do teste.',
    recipient_disabled:'O cadastro de Felipe está desabilitado ou bloqueado. Nenhum envio foi feito.',
    recipient_opted_out:'Felipe está descadastrado nesta marca. Nenhum envio foi feito.',
    version_already_attempted:'Esta versão já tem uma tentativa. Consulte o resultado existente.',
    unsupported_template_expression:'Este template usa uma expressão que o teste não consegue preencher. Revise as variáveis.',
    unsupported_test_variable:'Este template usa dados ainda não disponíveis no teste. Revise as variáveis.',
    unsupported_variable_context:'Há uma variável em link, atributo ou estilo. Revise antes de testar.',
  })[code]||'Não foi possível conferir este teste. Preserve a versão e consulte o integrador.';},
  emailTestSummary(op){
    const r=op.receipt||op.operation||{},s=r.ses||{};
    if(op.phase==='rejected')return GRU.emailTestReason(r.code);
    if(s.bounce||s.complaint||s.reject||s.rendering_failure)return 'O SES registrou uma falha ou reclamação. Não repita esta versão.';
    if(s.delivery)return 'Entrega confirmada pelo SES.';
    if(r.http_accepted)return 'Envio aceito; entrega ainda não confirmada.';
    if(s.send)return 'Envio registrado pelo SES; entrega ainda não confirmada.';
    return 'Resultado não confirmado. Consulte esta tentativa; não envie novamente.';
  },
  emailTestLabel(op){const d=GR.lista().find(r=>r.servidor?.draft_id===op.request_payload.draft_id);return [d?.nome||'Template de e-mail',d?.marca?GRU.rotulo(GR.MARCAS,d.marca):'',`v${op.request_payload.expected_version}`].filter(Boolean).join(' · ');},
  emailTestOperations(){
    const c=GRU.emailTestClient(),j=c?.inspect();if(!j)return '';
    if(j.blocked)return `<p class="drafts-scope" role="status">${GRU.e(j.message||'O registro de testes está indisponível. Nenhum envio de teste será feito.')}</p>`;
    if(!j.operations.length)return '';
    return `<details class="drafts-scope" aria-label="Testes de e-mail registrados"${j.operations.some(o=>['pending','unknown'].includes(o.phase))?' open':''}><summary>Testes de e-mail (${j.operations.length})</summary><ul>${[...j.operations].reverse().map(o=>`<li>${GRU.e(GRU.emailTestLabel(o))} · ${GRU.e(GRU.emailTestSummary(o))} <button type="button" class="refresh-btn" data-email-test-receipt="${GRU.e(o.id)}"${GRU.state.ocupado||GRU.emailTestSession?' disabled':''}>Consultar tentativa</button></li>`).join('')}</ul></details>`;
  },
  emailTestControls(r,caps){
    if(r.canal!=='email'||!caps.endpoint||!caps.submit_email||typeof GETest==='undefined')return '';
    const session=GRU.emailTestSession;
    if(session?.preview){const p=session.preview;
      return `<section class="draft-confirm" id="d-email-test-confirm" role="dialog" aria-labelledby="d-email-test-title" aria-describedby="d-email-test-help" tabindex="-1"><h3 id="d-email-test-title">Conferir teste · ${GRU.e(GRU.rotulo(GR.MARCAS,p.brand))} · v${GRU.e(p.version)}</h3><dl><dt>Para</dt><dd>${GRU.e(p.recipient)}</dd><dt>Assunto</dt><dd>${GRU.e(p.rendered_subject)}</dd><dt>Remetente</dt><dd>${GRU.e(p.from_email)}</dd><dt>Responder para</dt><dd>${GRU.e(p.reply_to)}</dd><dt>Dados fictícios</dt><dd>${Object.entries(p.data).map(([k,v])=>`${GRU.e(k)}: ${GRU.e(v&&typeof v==='object'?JSON.stringify(v):v)}`).join(' · ')||'Nenhuma variável'}</dd></dl><p id="d-email-test-help" class="mini">Uma tentativa desta versão. Assunto com prefixo ✅ FINAL — ; dados de exemplo. Links e imagens externas estão desativados na prévia.</p>${GMP.frame(p.body_html,false,'Prévia isolada do teste para Felipe')}<div class="draft-confirm-row"><button type="button" class="btn" id="d-email-test-send"${GRU.state.ocupado?' disabled':''}>${GRU.state.ocupado==='email_test_send'?'Conferindo resultado…':'Confirmar envio para Felipe'}</button><button type="button" class="btn sec" id="d-email-test-cancel"${GRU.state.ocupado?' disabled':''}>Cancelar</button></div></section>`;
    }
    const sit=GTA.situacao(r),j=GRU.emailTestClient()?.inspect(),previous=j?.operations.find(o=>o.request_payload.draft_id===r.servidor?.draft_id&&o.request_payload.expected_version===r.servidor?.version&&o.phase!=='rejected');
    const reason=previous?'Esta versão já tem uma tentativa. Consulte o resultado acima.':!GRU.emailTestKey()?'Entre com o acesso de gestor do CRM.':j?.blocked||!j?'O registro seguro de testes está indisponível.':sit.estado!=='publicado'||sit.sujo||!r.servidor?.hash?'Salve, valide e publique esta versão antes do teste.':GRU.contextError||r.servidor?.pendente?'Confira a operação de template pendente.':'';
    return `<div class="draft-server-actions"><button type="button" class="btn" id="d-email-test-preview" title="${GRU.e(reason||'Abre a prévia; nada é enviado antes de confirmar.')}"${reason||GRU.state.ocupado||GRU.state.confirmando||session?' disabled':''}>${GRU.state.ocupado==='email_test_preview'?'Conferindo prévia…':'Enviar teste para Felipe'}</button><span class="mini">${GRU.e(reason||'Somente felipebandeira@oaristocrata.com · uma tentativa por versão')}</span></div>`;
  },
  emailTestCurrent(s){
    const r=GRU.state.rascunho,latest=GR.lista().find(x=>x.id===s.local_id);
    return !!r&&GRU.emailTestSession===s&&r.id===s.local_id&&r.marca===s.brand&&GRU.ctx.marca===s.brand&&r.servidor?.draft_id===s.draft_id&&r.servidor?.version===s.version&&JSON.stringify(GR.conteudo(r))===s.content&&(!latest?.servidor||latest.servidor.draft_id===s.draft_id&&latest.servidor.version===s.version);
  },
  async emailTestPrepare(r){
    if(GRU.state.ocupado||GRU.state.confirmando||GRU.emailTestSession||GRU.replicationSession||GRU.nativeEmailSession)return;
    const sit=GTA.situacao(r),key=GRU.emailTestKey(),client=GRU.emailTestClient(key),j=client?.inspect();
    if(!key||!client||j.blocked||GRU.contextError||r.marca!==GRU.ctx.marca||sit.estado!=='publicado'||sit.sujo||!r.servidor?.hash||r.servidor?.pendente){GRU.aviso('Use o acesso de gestor e uma versão salva, validada e publicada para testar.','erro');GRU.render();return;}
    if(j.operations.some(o=>o.request_payload.draft_id===r.servidor.draft_id&&o.request_payload.expected_version===r.servidor.version&&o.phase!=='rejected')){GRU.aviso('Esta versão já tem uma tentativa. Consulte o resultado existente.','aviso');GRU.render();return;}
    const session={client,local_id:r.id,brand:r.marca,draft_id:r.servidor.draft_id,version:r.servidor.version,content:JSON.stringify(GR.conteudo(r)),from_email:r.from_email,reply_to:r.reply_to};
    GRU.emailTestSession=session;GRU.state.ocupado='email_test_preview';GRU.aviso('');GRU.render();
    try{
      if(typeof GENU!=='undefined'&&GENU.advanced(r))await GENU.requireCapability(r);
      const p=await client.preview({draft_id:session.draft_id,expected_version:session.version});
      if(!GRU.emailTestCurrent(session))throw Error('A preparação mudou. Reabra o template e confira a prévia novamente.');
      if(!p.eligible)throw Error(GRU.emailTestReason(p.code));
      if(p.recipient!=='felipebandeira@oaristocrata.com'||p.brand!==session.brand||p.draft_id!==session.draft_id||p.version!==session.version||p.from_email!==session.from_email||p.reply_to!==session.reply_to||typeof p.rendered_subject!=='string'||!p.rendered_subject.startsWith('✅ FINAL — ')||typeof p.body_html!=='string'||!p.data||typeof p.data!=='object'||Array.isArray(p.data))throw Error('A prévia não confirmou a versão e o destinatário. Nada foi enviado.');
      session.preview=JSON.parse(JSON.stringify(p));GRU.state.ocupado=null;GRU.render();document.getElementById('d-email-test-cancel')?.focus();
    }catch(e){GRU.emailTestSession=null;GRU.state.ocupado=null;GRU.aviso(e.message||'Não foi possível conferir a prévia. Nada foi enviado.','erro');GRU.render();}
  },
  emailTestCancel(){if(GRU.state.ocupado)return;GRU.emailTestSession=null;GRU.aviso('Teste cancelado. Nenhum e-mail enviado.');GRU.render();document.getElementById('d-email-test-preview')?.focus();},
  async emailTestSend(){
    const s=GRU.emailTestSession;if(!s?.preview||GRU.state.ocupado)return;
    if(!GRU.emailTestCurrent(s)){GRU.emailTestSession=null;GRU.aviso('A versão mudou. Reabra o template e confira uma nova prévia.','erro');GRU.render();return;}
    GRU.state.ocupado='email_test_send';GRU.render();
    try{const result=await s.client.run({draft_id:s.draft_id,expected_version:s.version,confirm:'enviar_teste',...(s.preview.render_policy?{render_policy:s.preview.render_policy,preview_token:s.preview.preview_token}:{})});GRU.aviso(GRU.emailTestSummary(result),result.phase==='confirmed'?'ok':'aviso');}
    catch(e){GRU.aviso(e.message||'Resultado não confirmado. Consulte a tentativa; não envie novamente.','erro');}
    finally{GRU.state.ocupado=null;GRU.emailTestSession=null;GRU.render();document.querySelector('[data-email-test-receipt]')?.focus();}
  },
  async emailTestReconcile(id){
    if(GRU.state.ocupado||GRU.emailTestSession||GRU.replicationSession||GRU.nativeEmailSession)return;
    const key=GRU.emailTestKey(),client=GRU.emailTestClient(key);if(!key||!client){GRU.aviso('Entre com o acesso de gestor do CRM para consultar esta tentativa.','erro');GRU.render();return;}
    GRU.state.ocupado='email_test_receipt';GRU.render();
    try{const result=await client.reconcile(id);GRU.aviso(GRU.emailTestSummary(result),result.phase==='confirmed'?'ok':'aviso');}
    catch(e){GRU.aviso(e.message||'Não foi possível confirmar esta tentativa. Não repita o envio.','erro');}
    finally{GRU.state.ocupado=null;GRU.render();}
  },
  bindEmailTest(root){
    root.querySelector('#d-email-test-preview')?.addEventListener('click',()=>GRU.emailTestPrepare(GRU.state.rascunho));
    root.querySelector('#d-email-test-send')?.addEventListener('click',()=>GRU.emailTestSend());
    root.querySelector('#d-email-test-cancel')?.addEventListener('click',()=>GRU.emailTestCancel());
    root.querySelectorAll('[data-email-test-receipt]').forEach(b=>b.onclick=()=>GRU.emailTestReconcile(b.dataset.emailTestReceipt));
    const confirmation=root.querySelector('#d-email-test-confirm');if(confirmation)confirmation.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();GRU.emailTestCancel();}if(e.key==='Tab'){const buttons=[...confirmation.querySelectorAll('button:not([disabled])')];if(!buttons.length)return;const first=buttons[0],last=buttons.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};
  },
  contextValue(){return {editando:GRU.state.editando,rascunho:GRU.state.rascunho};},
  contextStatus(){return {blocked:!!(GRU.state.ocupado||GRU.state.confirmando||GRU.emailTestSession||GRU.replicationSession||GRU.nativeEmailSession),dirty:!!GRU.state.rascunho&&JSON.stringify(GRU.contextValue())!==GRU.contextSaved};},
  preserve(){
    if(GRU.contextError)throw Error(GRU.contextError);
    if(!GBS.validBrand(GRU.contextBrand))return;
    const value=GRU.contextValue();GBS.save('template',GRU.contextBrand,value);GRU.contextSaved=JSON.stringify(value);
  },
  enterBrand(brand){
    if(GRU.state.ocupado||GRU.state.confirmando||GRU.emailTestSession||GRU.replicationSession||GRU.nativeEmailSession)return false;
    if(brand!==GRU.contextBrand)GRU.aviso('');
    let value=null;GRU.contextError='';
    try{value=GBS.read('template',brand);if(value?.rascunho?.marca&&value.rascunho.marca!==brand)throw Error('Preparação de template de outra marca. Os dados foram preservados.');}catch(e){value=null;GRU.contextError=e.message;}
    GRU.contextBrand=brand;GRU.fechar(false);
    if(value){
      GRU.state.editando=value.editando;GRU.state.rascunho=value.rascunho;
      const latest=GR.lista().find(d=>d.id===value.rascunho?.id),old=value.rascunho?.servidor;
      // A saved editor buffer cannot roll back a receipt reconciled while another brand was open.
      if(latest?.servidor&&old?.draft_id&&latest.servidor.draft_id!==old.draft_id)GRU.contextError='O vínculo deste template mudou em outra aba. Exporte sua preparação e reabra o rascunho para conferir.';
      else if(latest?.servidor&&Number(latest.servidor.version)>=Number(old?.version||0))GRU.state.rascunho.servidor=JSON.parse(JSON.stringify(latest.servidor));
    }
    GRU.contextSaved=JSON.stringify(GRU.contextValue());if(GRU.contextError)GRU.aviso(GRU.contextError,'erro');
    return true;
  },
  abrir(r,editando){
    if(typeof GEC!=='undefined')r=GEC.draft(r);
    if(GRU.state.ocupado||GRU.state.confirmando||GRU.emailTestSession||GRU.replicationSession||GRU.nativeEmailSession)return false;
    if(GRU.ctx.marca&&r.marca!==GRU.ctx.marca){
      if(typeof window.growthChangeBrand!=='function'||!window.growthChangeBrand(r.marca,()=>GRU.abrir(r,editando)))return false;
    }
    GRU.state={...GRU.state,editando,rascunho:{...GR.novo(),...r,exemplos:{...(r.exemplos||{})},botoes:(r.botoes||[]).map(b=>({...b})),servidor:r.servidor?JSON.parse(JSON.stringify(r.servidor)):undefined},msg:'',confirmando:false,confirmTexto:''};GRU.render();document.getElementById('d-nome')?.focus();},
  fechar(persist=true){if(GRU.emailTestSession||GRU.nativeEmailSession)return false;GRU.state={...GRU.state,editando:null,rascunho:null,confirmando:false,confirmTexto:''};if(persist&&typeof GBS!=='undefined'&&GBS.validBrand(GRU.contextBrand))try{GRU.preserve();}catch(e){GRU.aviso(e.message,'erro');}},
  aviso(msg,tone='ok'){GRU.state.msg=msg;GRU.state.msgTone=tone;},
  bind(root,caps){
    const $=s=>root.querySelector(s);
    $('#drafts-novo')?.addEventListener('click',()=>{if(GRU.ctx.marca==='todas')return;GRU.abrir(GR.novo({marca:GRU.ctx.marca||'fish'}),null);});
    $('#drafts-novo-email')?.addEventListener('click',()=>{if(GRU.ctx.marca==='todas')return;GRU.abrir(GR.novo({canal:'email',marca:GRU.ctx.marca||'fish'}),null);});
    $('#drafts-chave')?.addEventListener('click',()=>GRU.abrirAcesso());
    root.querySelectorAll('[data-template-operacao]').forEach(b=>b.onclick=()=>GRU.consultarOperacao(b.dataset.templateOperacao));
    const acesso=$('#drafts-acesso');
    if(acesso){
      acesso.onsubmit=event=>{
        event.preventDefault();
        if(!GRU.acesso.aberto||GRU.state.ocupado)return;
        const campo=$('#drafts-chave-escrita'),chave=campo.value.trim();
        if(!chave){campo.setAttribute('aria-invalid','true');$('#drafts-acesso-erro').textContent='Informe a chave de escrita de templates.';campo.focus();return;}
        // Authentication only: never replay an action or change a pending operation here.
        GRU.acesso.chave=chave;GRU.acesso.ignorarLegada=true;campo.value='';
        GRU.aviso('Acesso preparado para esta página aberta. Nenhuma operação foi enviada; escolha a ação desejada.');GRU.fecharAcesso();
      };
      acesso.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();GRU.fecharAcesso();}};
      $('#drafts-acesso-cancelar')?.addEventListener('click',()=>GRU.fecharAcesso());
    }
    const filtro=$('#drafts-filtro');if(filtro)filtro.onchange=()=>{GRU.state.filtro=filtro.value;GRU.render();};
    $('#drafts-limpar')?.addEventListener('click',()=>{GRU.state.filtro='todos';GRU.render();});
    $('#drafts-verificar')?.addEventListener('click',()=>GRU.verificarSubmissoes(false));
    const arquivo=$('#drafts-arquivo');
    $('#drafts-importar')?.addEventListener('click',()=>arquivo?.click());
    if(arquivo)arquivo.onchange=()=>{const f=arquivo.files&&arquivo.files[0];if(!f)return;const rd=new FileReader();rd.onload=()=>GRU.importaTexto(String(rd.result||''));rd.readAsText(f);};
    root.querySelectorAll('[data-draft-edit]').forEach(b=>b.onclick=()=>{const d=GR.lista().find(x=>x.id===b.dataset.draftEdit);if(d)GRU.abrir(d,d.id);});
    root.querySelectorAll('[data-draft-export]').forEach(b=>b.onclick=()=>{const d=GR.lista().find(x=>x.id===b.dataset.draftExport);if(d)GRU.exporta(d);});
    root.querySelectorAll('[data-draft-verificar]').forEach(b=>b.onclick=()=>{const d=GR.lista().find(x=>x.id===b.dataset.draftVerificar);if(d)GRU.verificarSubmissao(d);});
    root.querySelectorAll('[data-draft-historico]').forEach(b=>b.onclick=()=>{const d=GR.lista().find(x=>x.id===b.dataset.draftHistorico);if(d)GRU.carregarHistorico(d);});
    root.querySelectorAll('[data-draft-dup]').forEach(b=>b.onclick=()=>{const d=GR.lista().find(x=>x.id===b.dataset.draftDup);if(d){const copia={...d,id:GR.id(),nome:d.nome?d.nome+'_copia':'',criado_em:GR.agora()};delete copia.servidor;GR.guarda(GR.novo(copia));GRU.aviso('Rascunho duplicado (só o conteúdo; o estado no servidor não é copiado).');GRU.render();}});
    root.querySelectorAll('[data-draft-delete]').forEach(b=>b.onclick=()=>{const d=GR.lista().find(x=>x.id===b.dataset.draftDelete);if(!d)return;const s=GTA.situacao(d);if(typeof confirm==='function'&&!confirm(`Excluir o rascunho "${d.nome||'(sem nome)'}" deste dispositivo?${s.estado!=='local'?' O que já foi ao servidor continua lá; este painel só perde o vínculo.':' Só o rascunho local é removido.'}`))return;GR.remove(d.id);if(GRU.state.editando===d.id)GRU.fechar();GRU.aviso('Rascunho excluído deste dispositivo.');GRU.render();});
    const r=GRU.state.rascunho;if(!r)return;
    root.querySelectorAll('[data-campo]').forEach(el=>{
      const h=()=>{r[el.dataset.campo]=el.value;if(el.dataset.campo==='canal'&&typeof GEC!=='undefined')Object.assign(r,GEC.draft(r));const mudouEstrutura=el.dataset.campo==='canal'||(el.dataset.campo==='corpo'&&GR.variaveis(r.corpo).join()!==GRU._vars);const sujoAntes=GRU._sujo,sujoAgora=GTA.situacao(r).sujo;GRU._sujo=sujoAgora;if(mudouEstrutura||sujoAntes!==sujoAgora){GRU._vars=GR.variaveis(r.corpo).join();GRU.render();return;}GRU.atualizaPreview();};
      el.oninput=h;el.onchange=h;});
    GRU._vars=GR.variaveis(r.corpo).join();GRU._sujo=GTA.situacao(r).sujo;
    root.querySelectorAll('[data-exemplo]').forEach(el=>el.oninput=()=>{r.exemplos=r.exemplos||{};r.exemplos[el.dataset.exemplo]=el.value;GRU.mudou(r);});
    root.querySelectorAll('[data-botao-campo]').forEach(el=>{const i=+el.closest('[data-botao]').dataset.botao;const h=()=>{r.botoes[i][el.dataset.botaoCampo]=el.value;if(el.dataset.botaoCampo==='tipo'){r.botoes[i].valor='';if(el.value==='order_details')r.botoes[i].texto='Copiar código Pix';GRU.mudou(r);GRU.render();}else GRU.mudou(r);};el.oninput=h;el.onchange=h;});
    root.querySelectorAll('[data-botao-remover]').forEach(b=>b.onclick=()=>{r.botoes.splice(+b.dataset.botaoRemover,1);GRU.render();});
    $('#d-botao-add')?.addEventListener('click',()=>{r.botoes=r.botoes||[];r.botoes.push({tipo:'url',texto:'',valor:''});GRU.render();});
    $('#d-salvar')?.addEventListener('click',()=>{const v=GR.valida(r);if(v.erros.length){GRU.aviso('');GRU.atualizaPreview();document.getElementById('d-checagens')?.scrollIntoView?.({block:'nearest'});return;}
      const salvo=GR.guarda(r);if(salvo){GRU.fechar();GRU.aviso(`Rascunho "${salvo.nome}" salvo neste dispositivo às ${GRU.stamp(salvo.atualizado_em)}.`);}else GRU.aviso('Não foi possível gravar no navegador (armazenamento cheio ou bloqueado). Exporte o arquivo para não perder.','erro');GRU.render();});
    $('#d-cancelar')?.addEventListener('click',()=>{GRU.fechar();GRU.render();});
    $('#d-exportar')?.addEventListener('click',()=>GRU.exporta(r));
    $('#d-preview-open')?.addEventListener('click',()=>GMP.openEmail({source:GMP.emailHTML(r),subject:r.assunto}));
    $('#d-servidor')?.addEventListener('click',()=>GRU.salvarServidor(r));
    $('#d-validar')?.addEventListener('click',()=>GRU.validarServidor(r));
    $('#d-verificar')?.addEventListener('click',()=>GRU.verificarSubmissao(r));
    $('#d-refazer')?.addEventListener('click',()=>{if(!r.servidor?.conflito)return;r.servidor.version=r.servidor.conflito.current_version;GTA.evento(r.servidor,{at:GR.agora(),who:'este painel',action:'refazer',result:'ok',detail:`versão esperada ajustada para v${r.servidor.version}; nada enviado`});delete r.servidor.conflito;GR.guarda(r);GRU.aviso(`Versão esperada ajustada para v${r.servidor.version}. Revise o conteúdo e clique em Salvar no servidor.`);GRU.render();});
    $('#d-submeter')?.addEventListener('click',()=>{GRU.state.confirmando=true;GRU.state.confirmTexto='';GRU.render();document.getElementById('d-confirm-texto')?.focus();});
    const ct=$('#d-confirm-texto');if(ct)ct.oninput=()=>{GRU.state.confirmTexto=ct.value;const ok=ct.value.trim().toLowerCase()==='submeter';const btn=document.getElementById('d-confirm-ok');if(btn)btn.disabled=!ok||!!GRU.state.ocupado;};
    $('#d-confirm-cancel')?.addEventListener('click',()=>{GRU.state.confirmando=false;GRU.state.confirmTexto='';GRU.render();});
    $('#d-confirm-ok')?.addEventListener('click',()=>{if(GRU.state.confirmTexto.trim().toLowerCase()!=='submeter')return;GRU.submeter(r);});
  },
  mudou(r){const sujoAgora=GTA.situacao(r).sujo;if(sujoAgora!==GRU._sujo){GRU._sujo=sujoAgora;GRU.render();}else GRU.atualizaPreview();},
  exporta(d){if(typeof GT!=='undefined')GT.baixar(GR.nomeArquivo(d),GR.exporta(d),'application/json');},
  importaTexto(texto){const res=GR.importa(texto);if(res.erro){GRU.aviso(res.erro,'erro');GRU.render();return;}GRU.abrir(res.rascunho,null);GRU.aviso('Arquivo importado como novo rascunho. Revise e salve.');GRU.render();},

  /* Writes use a durable operation journal. A lost reply is read back by its
     exact operation ID; no POST is automatically retried and legacy pending
     identities are preserved for explicit reconciliation. */
  who(res){return typeof res.body?.who==='string'&&res.body.who.trim()?res.body.who:'chave de escrita deste navegador';},
  async chamada(acao,r,fn){
    if(GRU.state.ocupado||GRU.emailTestSession||GRU.replicationSession||GRU.nativeEmailSession)return;
    const advanced=typeof GENU!=='undefined'&&GENU.advanced(r);
    const escrita=['listar','historico','submissao'].includes(acao)?null:advanced?GRU.emailTestKey():GRU.chaveEscrita();
    if(escrita===null&&!['listar','historico','submissao'].includes(acao)){GRU.aviso('Sem chave de escrita: nada foi enviado.','erro');GRU.abrirAcesso();return;}
    GRU.state.ocupado=acao;GRU.aviso('');GRU.render();
    let res;try{if(advanced&&!['listar','historico','submissao'].includes(acao)){const content=GENU.content(r),brand=r.marca,endpoint=GRU.caps.endpoint;try{await GENU.requireCapability(r);if(GRU.ctx.marca!==brand||GENU.content(r)!==content||GRU.caps.endpoint!==endpoint||GRU.emailTestKey()!==escrita)throw Error('O rascunho mudou durante a conferência.');}catch(e){GRU.state.ocupado=null;GRU.aviso(e.message,'erro');GRU.render();return;}}res=await fn(escrita?GRU.clienteSeguro(escrita,r):GRU.cliente(escrita));}catch(e){res={ok:false,status:0,body:null,rede:true,journalError:advanced||String(e?.code||'').startsWith('TPL_')?e.message:null,journalCode:e?.code};}
    GRU.state.ocupado=null;
    if(!res.ok){const e=res.journalError?{texto:res.journalError,tipo:'incerto',chaveInvalida:res.journalCode==='TPL_AUTH'}:GTA.erro(res,acao);if(e.chaveInvalida)GRU.esqueceChave();return {res,erro:e};}
    return {res,erro:null};
  },
  async aplicarRecibo(r,res){
    const op=GRU.journal()?.inspect().operations.find(x=>x.id===res.operation_id);
    if(!op||!['confirmed','rejected'].includes(op.phase)||r.servidor?.pendente){GRU.aviso('O recibo precisa de conciliação antes de alterar este rascunho.','erro');GRU.render();return;}
    const p=op.request_payload,b=res.body,s=r.servidor||{},acao=p.acao;
    const confirmaLocal=async()=>{
      try{await GRU.journal().markApplied(op.id,()=>GRU.preservarLocal(r));return true;}
      catch(_){GRU.aviso('Recibo confirmado, mas a atualização local permanece pendente. Abra o mesmo recibo para recuperar; nenhuma operação será repetida.','aviso');return false;}
    };
    if(s.operacoes_aplicadas?.includes(op.id)){if(await confirmaLocal())GRU.aviso('Recibo já conferido; nenhuma operação foi repetida.');GRU.render();return;}
    if(s.draft_id&&(p.draft_id&&s.draft_id!==p.draft_id||acao==='rascunho'&&res.ok&&s.draft_id!==b.draft_id)||s.version&&(acao==='rascunho'&&res.ok?s.version>b.version:p.expected_version!==null&&s.version!==p.expected_version)){
      GRU.aviso('Recibo histórico conferido. A revisão atual deste rascunho foi preservada.','aviso');GRU.render();return;
    }
    if(!res.ok){
      const erro=GTA.erro(res,acao);
      r.servidor={...s,operacoes_aplicadas:[...(s.operacoes_aplicadas||[]),op.id]};
      if(acao==='validar'&&erro.tipo==='validacao'){r.servidor.estado='rascunho';r.servidor.erros=erro.erros;r.servidor.avisos=[];}
      GRU.falha(r,acao,res,erro);await confirmaLocal();GRU.render();return;
    }
    if(acao==='rascunho'){
      r.servidor={...s,draft_id:b.draft_id,version:b.version,estado:'rascunho',salvo_em:b.salvo_em||GR.agora(),confirmado_em:GR.agora(),hash:GTA.hash(p.rascunho),erros:[],avisos:[],eventos:s.eventos||[]};
      delete r.servidor.conflito;delete r.servidor.submission_id;
      GRU.aviso(`Rascunho salvo no servidor como v${b.version}. Não submetido.`);
    }else if(acao==='validar'){
      r.servidor={...s,estado:'validado',erros:[],avisos:Array.isArray(b.avisos)?b.avisos:[],validado_em:GR.agora(),confirmado_em:GR.agora()};
      GRU.aviso(`Conteúdo conferido${r.servidor.avisos.length?` com ${r.servidor.avisos.length} aviso(s)`:''}. Pronto para revisão antes da publicação.`);
    }else{
      r.servidor={...s,estado:b.estado,submission_id:b.submission_id,provider:b.provider,provider_id:b.provider_id||null,submitted_at:b.submitted_at||GR.agora(),provider_status:b.provider_status||null,checked_at:null,confirmado_em:GR.agora()};
      GRU.state.confirmando=false;GRU.state.confirmTexto='';
      GRU.aviso(b.estado==='publicado'?'Publicado pelo provedor (APPROVED). Publicado não é ativo: nenhum workflow mudou.':`Submetido à ${b.provider==='listmonk'?'Listmonk':'Meta'}. Aguardando; o painel consulta a cada 60 s.`);
    }
    r.servidor.operacoes_aplicadas=[...(s.operacoes_aplicadas||[]),op.id];
    GTA.evento(r.servidor,{at:GR.agora(),who:GRU.who(res),action:acao==='submeter'?'submit':acao,to_version:r.servidor.version,result:String(res.status),detail:`operação ${op.id}`});
    await confirmaLocal();
    GRU.render();
  },
  async consultarOperacao(id){
    if(GRU.state.ocupado||GRU.emailTestSession||GRU.replicationSession||GRU.nativeEmailSession)return;
    const escrita=GRU.chaveEscrita();
    if(!escrita){GRU.aviso('Informe a chave de escrita para consultar esta operação. Nenhuma operação será repetida.');GRU.abrirAcesso();return;}
    const journal=GRU.journal(),op=journal?.inspect().operations.find(x=>x.id===id);if(!op)return;
    GRU.state.ocupado='operacao';GRU.render();
    try{
      const client=GRU.cliente(escrita),res=await journal.reconcile(id,(key,acao)=>client.operacao(key,acao));
      let r=GRU.state.rascunho?.id===op.local_id?GRU.state.rascunho:GR.lista().find(x=>x.id===op.local_id);
      if(!r&&op.request_payload.rascunho)r=GR.novo({...op.request_payload.rascunho,id:op.local_id});
      GRU.state.ocupado=null;
      if(r){GRU.state.rascunho=r;GRU.state.editando=r.id;await GRU.aplicarRecibo(r,res);}
      else{GRU.aviso('Recibo conferido e preservado. O rascunho local não está disponível; consulte o integrador para recuperar o conteúdo.','aviso');GRU.render();}
    }catch(e){GRU.state.ocupado=null;GRU.aviso(String(e?.code||'').startsWith('TPL_')?e.message:'Não foi possível consultar o recibo. A operação permanece bloqueada.','erro');GRU.render();}
  },
  async salvarServidor(r){
    const v=GR.valida(r);if(v.erros.length){GRU.aviso('Corrija as pendências locais antes de salvar no servidor.','erro');GRU.render();return;}
    if(!GRU.prontaEscrita(r))return;
    const extra=r.servidor?.draft_id?{draft_id:r.servidor.draft_id,expected_version:r.servidor.version}:{};
    const out=await GRU.chamada('rascunho',r,c=>c.rascunho(GR.conteudo(r),extra));if(!out)return;
    if(out.res.operation_id)await GRU.aplicarRecibo(r,out.res);else if(out.erro)GRU.falha(r,'rascunho',out.res,out.erro);
  },
  async validarServidor(r){
    if(!GRU.prontaEscrita(r))return;
    const out=await GRU.chamada('validar',r,c=>c.validar(r.servidor.draft_id,undefined,r.servidor.version));if(!out)return;
    if(out.res.operation_id)await GRU.aplicarRecibo(r,out.res);else if(out.erro)GRU.falha(r,'validar',out.res,out.erro);
  },
  async submeter(r){
    if(!GRU.prontaEscrita(r))return;
    const out=await GRU.chamada('submeter',r,c=>c.submeter(r.servidor.draft_id,r.servidor.version,'submeter'));if(!out)return;
    if(out.res.operation_id)await GRU.aplicarRecibo(r,out.res);else if(out.erro)GRU.falha(r,'submeter',out.res,out.erro);
  },
  async verificarSubmissao(r,silencioso){
    const s=r.servidor;if(!s?.submission_id)return;
    const out=await GRU.chamada('submissao',r,c=>c.submissao(s.submission_id));if(!out)return;
    const {res,erro}=out;
    if(erro){if(!silencioso){GRU.aviso(`Não deu para consultar a submissão: ${erro.texto}`,'erro');GRU.render();}return;}
    const b=res.body||{};
    s.checked_at=b.checked_at||GR.agora();s.provider_status=b.provider_status||null;s.rejected_reason=b.rejected_reason||null;
    // "publicado" só com a palavra da API (estado publicado ou provider APPROVED). Nunca por otimismo do painel.
    const novo=b.estado==='publicado'||b.provider_status==='APPROVED'?'publicado':b.estado==='rejeitado'||b.provider_status==='REJECTED'?'rejeitado':'submetido';
    if(novo!==s.estado){s.estado=novo;s.confirmado_em=GR.agora();GTA.evento(s,{at:GR.agora(),who:'provedor via API',action:novo,result:b.provider_status||novo,detail:s.rejected_reason});}
    GR.guarda(r);
    // C03: provider_status é extensível (PAUSED, DISABLED, IN_APPEAL…). Só PENDING/IN_APPEAL é "aguardando"; o resto é dito pelo nome, sem virar aprovação.
    const aguardando=[undefined,null,'','PENDING','IN_APPEAL'].includes(b.provider_status);
    if(!silencioso)GRU.aviso(novo==='publicado'?`Publicado pelo provedor (${b.provider_status}). Publicado não é ativo: nenhum workflow mudou.`:novo==='rejeitado'?`Rejeitado${s.rejected_reason?`: ${s.rejected_reason}`:''}.`
      :aguardando?`Ainda aguardando (${b.provider_status||'sem status'}) · verificado ${GRU.stamp(s.checked_at)}.`:`Provedor devolveu "${b.provider_status}": não é aprovação nem rejeição; estado mantido como submetido. Confira no provedor.`,novo==='rejeitado'||!aguardando&&novo==='submetido'?'aviso':'ok');
    if(GRU.state.rascunho&&GRU.state.rascunho.id===r.id)GRU.state.rascunho.servidor=JSON.parse(JSON.stringify(s));
    GRU.render();
  },
  async verificarSubmissoes(auto){
    if(GRU.state.ocupado||GRU.emailTestSession||GRU.replicationSession||GRU.nativeEmailSession)return;
    const lista=GR.lista().filter(d=>GTA.situacao(d).estado==='submetido'&&d.servidor?.submission_id);
    for(const d of lista)await GRU.verificarSubmissao(d,auto);
    if(!auto&&!lista.length){GRU.aviso('Nenhuma submissão aguardando.');GRU.render();}
  },
  async carregarHistorico(r){
    const s=r.servidor;if(!s)return;
    const ref=s.template_key?{key:s.template_key}:{draft_id:s.draft_id};
    const out=await GRU.chamada('historico',r,c=>c.historico(ref));if(!out)return;
    const {res,erro}=out;
    if(erro){GRU.aviso(`Histórico indisponível: ${erro.texto}`,'erro');GRU.render();return;}
    s.historico=Array.isArray(res.body?.events)?res.body.events.filter(x=>x&&typeof x==='object'):[];
    GR.guarda(r);GRU.aviso(`Histórico atualizado: ${s.historico.length} evento(s).`);GRU.render();
  },
  falha(r,acao,res,erro){
    r.servidor=r.servidor||{};
    if(erro.conflito)r.servidor.conflito=erro.conflito;
    GTA.evento(r.servidor,{at:GR.agora(),who:GRU.who(res),action:acao,result:res.status?String(res.status):'rede',detail:erro.texto});
    if(r.servidor.draft_id)GR.guarda(r);
    GRU.aviso(erro.texto,erro.tipo==='indisponivel'?'aviso':'erro');GRU.render();
  },
  /* Acompanhamento automático (R5.4): a cada 60 s consulta as submissões pendentes. Só roda se houver alguma. */
  agenda(){
    if(GRU._timer||typeof setInterval!=='function')return;
    GRU._timer=setInterval(()=>{if(GRU.caps?.endpoint&&GR.lista().some(d=>GTA.situacao(d).estado==='submetido'))GRU.verificarSubmissoes(true);},GTA.POLL_MS)||true;
  },
};
if(typeof module!=='undefined'&&module.exports)module.exports=GRU;
