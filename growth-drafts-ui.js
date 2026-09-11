/* Editor de rascunhos — tela. Regras e armazenamento local em growth-drafts.js; regras da API em growth-templates-api.js.
   Sem `capabilities` na resposta do GET Growth, esta tela é a mesma da Entrega 2: rascunho salvo só neste dispositivo.
   Com capacidades (R5.1), aparecem — e só então — Salvar no servidor → Validar → Submeter → acompanhar → publicado ≠ ativo.
   Nunca há botão de publicar/ativar aqui: publicar é a Meta/Listmonk quem faz; ativar é o workflow (R5.5, fora desta fase). */
'use strict';
const GRU={
  state:{editando:null,rascunho:null,msg:'',msgTone:'ok',filtro:'todos',ocupado:null,confirmando:false,confirmTexto:''},
  ctx:{},caps:null,
  e:s=>GR.esc(s),
  stamp(v){return GTA.stamp(v);},
  rotulo(lista,k){return (lista.find(([v])=>v===k)||[])[1]||k;},
  opts(lista,val){return lista.map(([v,t])=>`<option value="${GRU.e(v)}"${v===val?' selected':''}>${GRU.e(t)}</option>`).join('');},
  /* Catálogo: só associação por nome EXATO. Não inventa corpo, não diz que o rascunho é o template. */
  noCatalogo(nome){
    const tpls=GRU.ctx.api?.crm_operacao?.templates;
    return Array.isArray(tpls)?tpls.find(t=>t&&t.name===nome)||null:null;
  },
  workflows(){const w=GRU.ctx.api?.crm_operacao?.workflows;return Array.isArray(w)?w.filter(x=>x&&typeof x==='object'):[];},
  capacidades(){return GTA.caps(GRU.ctx.api,{TEMPLATE_API_URL:typeof TEMPLATE_API_URL!=='undefined'?TEMPLATE_API_URL:undefined});},
  /* ---------- chaves ---------- */
  store(){return typeof localStorage!=='undefined'?localStorage:null;},
  chaveEscrita(pedir){
    const st=GRU.store();let k=st?.getItem(GTA.CHAVE_ESCRITA)||'';
    if(!k&&pedir&&typeof prompt==='function'){k=prompt('Chave de ESCRITA de templates (não é a chave de leitura do painel):')||'';if(k&&st)st.setItem(GTA.CHAVE_ESCRITA,k);}
    return k||null;
  },
  esqueceChave(){GRU.store()?.removeItem(GTA.CHAVE_ESCRITA);},
  cliente(escrita){
    const c=GRU.caps||GRU.capacidades();
    return GTA.cliente({endpoint:c.endpoint,fetch:typeof fetch==='function'?fetch:null,chaveLeitura:GRU.store()?.getItem(GTA.CHAVE_LEITURA)||'',chaveEscrita:escrita||''});
  },
  /* ---------- render ---------- */
  render(ctx){
    if(ctx)GRU.ctx=ctx;
    GRU.caps=GRU.capacidades();
    const root=typeof document!=='undefined'?document.querySelector('#control-drafts'):null;
    if(!root)return;
    const kept=typeof GT!=='undefined'?GT.captura(root):null;
    const caps=GRU.caps,todos=GR.lista(),r=GRU.state.rascunho;
    const comServidor=caps.declaradas||todos.some(d=>GTA.situacao(d).estado!=='local');
    const lista=todos.filter(d=>GRU.state.filtro==='todos'||GTA.situacao(d).estado===GRU.state.filtro||(GRU.state.filtro==='sujo'&&GTA.situacao(d).sujo));
    const submetidos=todos.filter(d=>GTA.situacao(d).estado==='submetido');
    const ferramentas=`<div class="gt-toolbar drafts-toolbar"><button type="button" class="btn" id="drafts-novo">Novo rascunho</button>
      <label class="refresh-btn drafts-importar">Importar arquivo<input type="file" id="drafts-arquivo" accept="application/json,.json" hidden></label>
      ${comServidor?`<label class="gt-filtro">Estado<select id="drafts-filtro" data-gt-filter="drafts-filtro"><option value="todos"${GRU.state.filtro==='todos'?' selected':''}>Todos</option>${GTA.ESTADOS.map(([v,t])=>`<option value="${v}"${GRU.state.filtro===v?' selected':''}>${GRU.e(t)}</option>`).join('')}<option value="rejeitado"${GRU.state.filtro==='rejeitado'?' selected':''}>Rejeitado</option><option value="sujo"${GRU.state.filtro==='sujo'?' selected':''}>Alterado após salvar no servidor</option></select></label>`:''}
      ${submetidos.length&&caps.endpoint?`<button type="button" class="refresh-btn" id="drafts-verificar"${GRU.state.ocupado?' disabled':''}>Verificar ${submetidos.length===1?'a submissão':`${submetidos.length} submissões`} agora</button>`:''}
      <span class="gt-contagem">${lista.length}${lista.length!==todos.length?` de ${todos.length}`:''} rascunho${todos.length===1?'':'s'} neste dispositivo</span>${GRU.state.msg?`<span class="drafts-msg" data-tone="${GRU.e(GRU.state.msgTone)}" role="status">${GRU.e(GRU.state.msg)}</span>`:''}</div>`;
    const listaHtml=lista.length?`<div class="draft-grid">${lista.map(d=>GRU.cartao(d,caps)).join('')}</div>`
      :`<div class="vazio">${todos.length?'Nenhum rascunho neste estado. <button type="button" class="refresh-btn gt-limpar" id="drafts-limpar">Ver todos</button>':'Nenhum rascunho neste dispositivo. Comece por "Novo rascunho" ou importe um arquivo exportado em outro computador.'}</div>`;
    root.innerHTML=GRU.escopo(caps)+ferramentas+(r?GRU.editor(r,caps):'')+listaHtml;
    GRU.bind(root,caps);
    GRU.agenda();
    if(kept&&typeof GT!=='undefined')GT.restaura(root,kept);
  },
  escopo(caps){
    if(!caps.declaradas)return `<div class="drafts-scope"><strong>Rascunhos salvos só neste dispositivo</strong><p>Escreva e revise mensagens de WhatsApp e e-mail. Elas ficam neste navegador e só serão salvas ao clicar em Salvar. Para levar a outro computador, exporte o arquivo. Publicação de templates e ativação de automações pelo painel ainda estão em desenvolvimento.</p></div>`;
    if(caps.semEndpoint)return `<div class="drafts-scope"><strong>Rascunhos salvos só neste dispositivo</strong><p>A API declarou capacidades de templates, mas não informou o endereço da API de templates (<code>capabilities.endpoints.templates</code>). Sem o endereço, nenhum botão de servidor aparece — um botão que não sabe para onde chamar é um botão que não funciona.</p></div>`;
    const cap=(k,t)=>`<span class="control-badge${caps.pode[k]?' control-verified':''}" title="${caps.pode[k]?'Disponível nesta API':'A API não declarou esta capacidade; o botão não aparece'}">${t}${caps.pode[k]?'':' · indisponível'}</span>`;
    const chave=GRU.chaveEscrita(false);
    return `<div class="drafts-scope drafts-scope-api"><div><strong>Rascunhos neste dispositivo, com envio ao servidor</strong><p>O que esta API permite hoje: ${cap('draft','Salvar no servidor')} ${cap('validate','Validar')} ${cap('submit','Submeter')} ${cap('list_history','Histórico')} ${cap('read_content','Conteúdo publicado')}. Publicado é o que a Meta/Listmonk aprovou; ativo é o workflow em modo real — a tela nunca junta os dois.</p></div>
      <div class="drafts-key"><span class="mini">Chave de escrita: ${chave?'informada neste navegador':'ainda não informada'}</span><button type="button" class="refresh-btn" id="drafts-chave">${chave?'Trocar chave':'Informar chave'}</button></div></div>`;
  },
  passos(d){
    const {estado,sujo}=GTA.situacao(d),ord=GTA.ORDEM[estado]??0;
    return `<ol class="draft-steps" aria-label="Etapas do template">${GTA.ESTADOS.map(([k,t],i)=>{const st=estado==='rejeitado'&&k==='publicado'?'rejeitado':i<ord?'feito':i===ord?'atual':'';return `<li data-passo="${k}"${st?` data-st="${st}"`:''}>${GRU.e(estado==='rejeitado'&&k==='publicado'?'Rejeitado':t)}</li>`;}).join('')}</ol>${sujo?'<span class="mini draft-sujo">conteúdo local difere do servidor</span>':''}`;
  },
  cartao(d,caps){
    const v=GR.valida(d),cat=GRU.noCatalogo(d.nome),sit=GTA.situacao(d),s=sit.servidor;
    const rot=GTA.rotuloEstado(d,{workflows:GRU.workflows(),mapped_in:s?.mapped_in});
    const acoes=GTA.acoes(caps,d);
    const eventos=[...(s?.historico||[]).map(x=>({...x,origem:'api'})),...(s?.eventos||[])].sort((a,b)=>String(b.at).localeCompare(String(a.at)));
    return `<article class="draft-card" data-draft="${GRU.e(d.id)}" data-estado="${GRU.e(sit.estado)}"><div class="draft-head"><div><span class="control-overline">${GRU.e(GRU.rotulo(GR.MARCAS,d.marca))} · ${GRU.e(GRU.rotulo(GR.CANAIS,d.canal))}${d.canal==='whatsapp'?` · ${GRU.e(d.categoria||'')}`:''}</span>
      <h3>${GRU.e(d.nome||'(sem nome)')}</h3>${d.peca?`<span class="flow-sub">peça: ${GRU.e(d.peca)}</span>`:''}</div>
      <span class="control-badge control-${GRU.e(rot.tone)}">${GRU.e(rot.texto)}</span></div>
      ${caps.declaradas||sit.estado!=='local'?GRU.passos(d):''}
      <p class="draft-excerpt">${GRU.e((d.canal==='email'?(d.assunto?d.assunto+' — ':''):'')+String(d.corpo||'').slice(0,140))}${String(d.corpo||'').length>140?'…':''}</p>
      ${cat?`<p class="control-warning">Existe um template com este nome no catálogo da Meta (status ${GRU.e(cat.status||'?')}, categoria ${GRU.e(cat.category||'?')}). O rascunho não é esse template e o catálogo não traz o corpo dele para comparar.</p>`:''}
      <div class="draft-meta">${v.erros.length?`<span class="control-badge control-warning">${v.erros.length} pendência${v.erros.length===1?'':'s'}</span>`:v.avisos.length?`<span class="control-badge">${v.avisos.length} aviso${v.avisos.length===1?'':'s'}</span>`:'<span class="control-badge control-info">Checagens locais ok</span>'}<span>editado ${GRU.stamp(d.atualizado_em)}</span>${s?`<span title="Versão do rascunho no servidor e hora da última confirmação da API">servidor v${GRU.e(s.version)} · ${GRU.stamp(s.confirmado_em||s.salvo_em)}</span>`:''}${sit.estado==='submetido'?`<span title="Última consulta do painel ao estado da submissão">verificado ${GRU.stamp(s.checked_at)||'—'}</span>`:''}</div>
      ${s?`<details class="control-detail draft-historico" data-gt-key="hist-${GRU.e(d.id)}"><summary>Histórico (${eventos.length})</summary>${eventos.length?`<ul>${eventos.map(x=>`<li><time>${GRU.stamp(x.at)}</time> · ${GRU.e(x.who||'?')} · ${GRU.e(x.action)}${Number.isFinite(+x.from_version)||Number.isFinite(+x.to_version)?` v${GRU.e(x.from_version??'—')}→v${GRU.e(x.to_version??'—')}`:''} · ${GRU.e(x.result||'')}${x.detail?` · ${GRU.e(x.detail)}`:''}${x.origem==='api'?' <span class="mini">(API)</span>':''}</li>`).join('')}</ul>`:'<p>Nenhum evento registrado.</p>'}${acoes.historico?`<button type="button" class="refresh-btn" data-draft-historico="${GRU.e(d.id)}"${GRU.state.ocupado?' disabled':''}>Carregar histórico da API</button>`:''}</details>`:''}
      <div class="draft-actions"><button type="button" class="refresh-btn" data-draft-edit="${GRU.e(d.id)}">Editar</button>${acoes.verificar?`<button type="button" class="refresh-btn" data-draft-verificar="${GRU.e(d.id)}"${GRU.state.ocupado?' disabled':''}>Verificar agora</button>`:''}<button type="button" class="refresh-btn" data-draft-export="${GRU.e(d.id)}">Exportar arquivo</button><button type="button" class="refresh-btn" data-draft-dup="${GRU.e(d.id)}">Duplicar</button><button type="button" class="refresh-btn draft-delete" data-draft-delete="${GRU.e(d.id)}">Excluir</button></div></article>`;
  },
  editor(r,caps){
    const wa=r.canal==='whatsapp',vars=GR.variaveis(r.corpo),v=GR.valida(r),sit=GTA.situacao(r),s=sit.servidor,acoes=GTA.acoes(caps,r),oc=GRU.state.ocupado;
    const rot=GTA.rotuloEstado(r,{workflows:GRU.workflows(),mapped_in:s?.mapped_in});
    const botoes=(r.botoes||[]).map((b,i)=>`<div class="draft-botao" data-botao="${i}"><select data-botao-campo="tipo" aria-label="Tipo do botão ${i+1}">${GRU.opts(GR.TIPOS_BOTAO,b.tipo)}</select>
      <input type="text" data-botao-campo="texto" maxlength="${GR.LIMITES.botao}" placeholder="Texto do botão" value="${GRU.e(b.texto)}" aria-label="Texto do botão ${i+1}">
      ${b.tipo==='quick_reply'?'':`<input type="text" data-botao-campo="valor" placeholder="${b.tipo==='url'?'https://…':'+55…'}" value="${GRU.e(b.valor)}" aria-label="${b.tipo==='url'?'Link':'Telefone'} do botão ${i+1}">`}
      <button type="button" class="mais" data-botao-remover="${i}" title="Remover botão">–</button></div>`).join('');
    const provedor=wa?'Meta':'Listmonk';
    const dis=oc?' disabled':'';
    const servidorBar=caps.pode.draft?`<div class="draft-server-actions">
        <button type="button" class="btn sec" id="d-servidor"${dis}>${oc==='rascunho'?'Salvando…':s?`Salvar no servidor (v${GRU.e(s.version)}${sit.sujo?' → nova versão':''})`:'Salvar no servidor'}</button>
        ${acoes.validar?`<button type="button" class="btn sec" id="d-validar"${dis}>${oc==='validar'?'Validando…':'Validar na API'}</button>`:''}
        ${acoes.submeter?`<button type="button" class="btn" id="d-submeter"${dis||(GRU.state.confirmando?' disabled':'')}>Submeter à ${provedor}…</button>`:''}
        ${acoes.verificar?`<button type="button" class="refresh-btn" id="d-verificar"${dis}>${oc==='submissao'?'Consultando…':'Verificar submissão'}</button>`:''}
        <span class="mini">${s?`Servidor: v${GRU.e(s.version)} · ${GRU.e(rot.texto)}${sit.sujo?' · salve de novo antes de validar ou submeter':''}`:'Ainda não foi ao servidor. Salvar no servidor não submete nem ativa nada.'}${caps.validate&&s&&!sit.sujo&&sit.estado==='rascunho'&&caps.pode.submit?' · submeter exige validar primeiro':''}</span></div>
        ${s?.conflito?`<div class="draft-conflito control-warning"><strong>Alguém alterou este rascunho no servidor antes de você.</strong> ${GRU.e(`Por ${s.conflito.changed_by||'outra chave'} às ${GRU.stamp(s.conflito.changed_at)}; versão atual v${s.conflito.current_version??'?'}. Nada foi sobrescrito.`)} <button type="button" class="refresh-btn" id="d-refazer">Refazer sobre a v${GRU.e(s.conflito.current_version??'?')}</button> <span class="mini">Refazer só ajusta a versão esperada; o conteúdo continua o seu e nada é enviado até você salvar de novo.</span></div>`:''}
        ${GRU.state.confirmando&&acoes.submeter?GRU.confirmacao(r,provedor):''}`
      :caps.semEndpoint?'<p class="mini draft-server-off">Capacidades declaradas sem endereço da API: envio ao servidor indisponível nesta consulta.</p>':'';
    return `<section class="painel draft-editor" id="draft-editor" aria-label="Editor de rascunho"><div class="painel-cab"><h2>${GRU.state.editando?'Editar rascunho':'Novo rascunho'}</h2><span class="control-badge control-${GRU.e(rot.tone)}">${GRU.e(rot.texto)}</span></div>
      <div class="draft-form"><div class="form">
        <div class="campo"><label for="d-nome">${wa?'Nome do template':'Nome do rascunho'}</label><input type="text" id="d-nome" data-campo="nome" value="${GRU.e(r.nome)}" placeholder="${wa?'fishermans_rastreio_v3':'carta-do-fundador-02'}"><span class="ajuda">${wa?'Como ficará na Meta: minúsculas, números e _.':'Só para você achar depois.'}</span></div>
        <div class="campo"><label for="d-marca">Marca</label><select id="d-marca" data-campo="marca">${GRU.opts(GR.MARCAS,r.marca)}</select></div>
        <div class="campo"><label for="d-canal">Canal</label><select id="d-canal" data-campo="canal">${GRU.opts(GR.CANAIS,r.canal)}</select></div>
        ${wa?`<div class="campo"><label for="d-idioma">Idioma</label><input type="text" id="d-idioma" data-campo="idioma" value="${GRU.e(r.idioma)}" placeholder="pt_BR"></div>
        <div class="campo"><label for="d-categoria">Categoria esperada</label><select id="d-categoria" data-campo="categoria">${GRU.opts(GR.CATEGORIAS,r.categoria)}</select><span class="ajuda">Utility deve tratar de uma solicitação ou transação específica, sem promoção. A Meta define a categoria final.</span></div>`
        :`<div class="campo largo"><label for="d-assunto">Assunto</label><input type="text" id="d-assunto" data-campo="assunto" value="${GRU.e(r.assunto)}"></div>`}
        <div class="campo"><label for="d-peca">Peça (opcional)</label><input type="text" id="d-peca" data-campo="peca" value="${GRU.e(r.peca)}" placeholder="rastreio-criado"><span class="ajuda">Mesmo nome da peça usado nas automações, para bater com o histórico.</span></div>
        ${wa?`<div class="campo largo"><label for="d-cabecalho">Cabeçalho (opcional)</label><input type="text" id="d-cabecalho" data-campo="cabecalho" maxlength="${GR.LIMITES.cabecalho}" value="${GRU.e(r.cabecalho)}"><span class="ajuda" id="d-cabecalho-conta">${String(r.cabecalho||'').length} de ${GR.LIMITES.cabecalho}</span></div>`:''}
        <div class="campo largo"><label for="d-corpo">Corpo</label><textarea id="d-corpo" data-campo="corpo" rows="7" placeholder="${wa?'Olá {{1}}, seu pedido {{2}} saiu para entrega…':'Texto do e-mail…'}">${GRU.e(r.corpo)}</textarea><span class="ajuda" id="d-corpo-conta">${GRU.contaCorpo(r)}</span></div>
        ${wa?`<div class="campo largo"><label for="d-rodape">Rodapé (opcional)</label><input type="text" id="d-rodape" data-campo="rodape" maxlength="${GR.LIMITES.rodape}" value="${GRU.e(r.rodape)}"><span class="ajuda" id="d-rodape-conta">${String(r.rodape||'').length} de ${GR.LIMITES.rodape}</span></div>`:''}
        ${wa&&vars.length?`<div class="campo largo"><label>Exemplos das variáveis</label><div class="draft-exemplos">${vars.map(n=>`<label>{{${n}}}<input type="text" data-exemplo="${n}" value="${GRU.e((r.exemplos||{})[n]||'')}" placeholder="exemplo real, sem dado de cliente"></label>`).join('')}</div><span class="ajuda">A Meta pede um exemplo por variável. Use valores fictícios.</span></div>`:''}
        <div class="campo largo"><label>Botões ${wa?`(até ${GR.LIMITES.botoes})`:'(links do e-mail)'}</label><div class="draft-botoes" id="d-botoes">${botoes||'<span class="ajuda">Nenhum botão.</span>'}</div>
          ${(r.botoes||[]).length<GR.LIMITES.botoes?'<button type="button" class="refresh-btn" id="d-botao-add">Adicionar botão</button>':''}</div>
      </div>
      <div class="draft-preview" aria-live="polite"><div class="draft-preview-head">Prévia do que você digitou<span class="control-badge">não é o template publicado</span></div><div id="d-preview">${GRU.preview(r)}</div>
        <div id="d-checagens">${GRU.checagens(v,s)}</div></div></div>
      <div class="draft-editor-actions"><button type="button" class="btn" id="d-salvar"${dis}>Salvar neste dispositivo</button><button type="button" class="btn sec" id="d-cancelar">Fechar sem salvar</button><button type="button" class="refresh-btn" id="d-exportar">Exportar arquivo</button>${caps.pode.draft?'':'<span class="mini">Salvar grava no navegador. Não cadastra, não submete e não ativa nada.</span>'}</div>
      ${servidorBar}</section>`;
  },
  contaCorpo(r){return `${String(r.corpo||'').length}${r.canal==='whatsapp'?` de ${GR.LIMITES.corpo}`:''} caracteres${r.canal==='whatsapp'?' · variáveis como {{1}}, {{2}}':''}`;},
  /* Confirmação textual (R5.4): resumo do que vai para o provedor + a palavra digitada. O botão só liga com a palavra certa. */
  confirmacao(r,provedor){
    const s=r.servidor||{},ok=GRU.state.confirmTexto.trim().toLowerCase()==='submeter',wa=r.canal==='whatsapp';
    return `<div class="draft-confirm" id="d-confirmar" role="dialog" aria-label="Confirmar submissão"><strong>Submeter à ${GRU.e(provedor)} o rascunho v${GRU.e(s.version)}</strong>
      <dl><dt>Nome</dt><dd>${GRU.e(r.nome)}</dd><dt>Marca · canal</dt><dd>${GRU.e(GRU.rotulo(GR.MARCAS,r.marca))} · ${GRU.e(GRU.rotulo(GR.CANAIS,r.canal))}</dd>${wa?`<dt>Categoria · idioma</dt><dd>${GRU.e(r.categoria)} · ${GRU.e(r.idioma)}</dd>`:`<dt>Assunto</dt><dd>${GRU.e(r.assunto)}</dd>`}<dt>Depois</dt><dd>${wa?'A Meta revisa; aprovado vira "publicado · não ativo". Nenhum workflow muda.':'Vai ao Listmonk como definição de template (o recurso exato — template transacional, não campanha — segue o contrato final, B01 da revisão). Nada é agendado nem disparado.'}</dd></dl>
      ${s.avisos?.length?`<p class="draft-aviso">Avisos da validação: ${GRU.e(s.avisos.map(a=>a.mensagem||a.codigo).join(' · '))}</p>`:''}
      <label for="d-confirm-texto">Digite <code>submeter</code> para liberar o botão</label><div class="draft-confirm-row"><input type="text" id="d-confirm-texto" value="${GRU.e(GRU.state.confirmTexto)}" autocomplete="off" spellcheck="false"><button type="button" class="btn" id="d-confirm-ok"${ok&&!GRU.state.ocupado?'':' disabled'}>${GRU.state.ocupado==='submeter'?'Submetendo…':'Submeter agora'}</button><button type="button" class="btn sec" id="d-confirm-cancel">Cancelar</button></div></div>`;
  },
  preview(r){
    const ex=r.exemplos||{},corpo=GR.preenche(r.corpo,ex);
    if(r.canal==='email')return `<div class="draft-mail"><div class="draft-mail-assunto">${GRU.e(r.assunto||'(sem assunto)')}</div><div class="draft-mail-corpo">${GRU.e(corpo)||'<span class="mini">Corpo vazio.</span>'}</div>${(r.botoes||[]).filter(b=>b.texto).map(b=>`<span class="draft-mail-link">${GRU.e(b.texto)}</span>`).join('')}</div>`;
    return `<div class="draft-bubble">${r.cabecalho?`<div class="draft-bubble-head">${GRU.e(GR.preenche(r.cabecalho,ex))}</div>`:''}<div class="draft-bubble-body">${GRU.e(corpo)||'<span class="mini">Corpo vazio.</span>'}</div>${r.rodape?`<div class="draft-bubble-foot">${GRU.e(r.rodape)}</div>`:''}</div>
      ${(r.botoes||[]).filter(b=>b.texto).map(b=>`<div class="draft-bubble-btn">${b.tipo==='url'?'↗ ':b.tipo==='phone'?'☏ ':''}${GRU.e(b.texto)}</div>`).join('')}`;
  },
  checagens(v,s){
    const api=s&&!GTA.situacao({servidor:s,...(GRU.state.rascunho||{})}).sujo?`${(s.erros||[]).map(x=>`<p class="control-warning draft-erro">API: ${GRU.e(x.mensagem||x.codigo)}${x.campo?` (${GRU.e(x.campo)})`:''}</p>`).join('')}${(s.avisos||[]).map(x=>`<p class="draft-aviso">API: ${GRU.e(x.mensagem||x.codigo)}</p>`).join('')}`:'';
    if(!v.erros.length&&!v.avisos.length)return `<p class="draft-ok">Checagens locais ok. Essas checagens são parciais. No WhatsApp, a Meta define aprovação e categoria; no e-mail, ainda falta validar a integração de envio.</p>${api}`;
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
  abrir(r,editando){GRU.state={...GRU.state,editando,rascunho:{...GR.novo(),...r,exemplos:{...(r.exemplos||{})},botoes:(r.botoes||[]).map(b=>({...b})),servidor:r.servidor?JSON.parse(JSON.stringify(r.servidor)):undefined},msg:'',confirmando:false,confirmTexto:''};GRU.render();document.getElementById('d-nome')?.focus();},
  fechar(){GRU.state={...GRU.state,editando:null,rascunho:null,confirmando:false,confirmTexto:''};},
  aviso(msg,tone='ok'){GRU.state.msg=msg;GRU.state.msgTone=tone;},
  bind(root,caps){
    const $=s=>root.querySelector(s);
    $('#drafts-novo')?.addEventListener('click',()=>GRU.abrir(GR.novo(),null));
    $('#drafts-chave')?.addEventListener('click',()=>{GRU.esqueceChave();if(GRU.chaveEscrita(true))GRU.aviso('Chave de escrita guardada neste navegador. Ela não é mostrada em lugar nenhum.');GRU.render();});
    const filtro=$('#drafts-filtro');if(filtro)filtro.onchange=()=>{GRU.state.filtro=filtro.value;GRU.render();};
    $('#drafts-limpar')?.addEventListener('click',()=>{GRU.state.filtro='todos';GRU.render();});
    $('#drafts-verificar')?.addEventListener('click',()=>GRU.verificarSubmissoes(false));
    const arquivo=$('#drafts-arquivo');
    if(arquivo)arquivo.onchange=()=>{const f=arquivo.files&&arquivo.files[0];if(!f)return;const rd=new FileReader();rd.onload=()=>GRU.importaTexto(String(rd.result||''));rd.readAsText(f);};
    root.querySelectorAll('[data-draft-edit]').forEach(b=>b.onclick=()=>{const d=GR.lista().find(x=>x.id===b.dataset.draftEdit);if(d)GRU.abrir(d,d.id);});
    root.querySelectorAll('[data-draft-export]').forEach(b=>b.onclick=()=>{const d=GR.lista().find(x=>x.id===b.dataset.draftExport);if(d)GRU.exporta(d);});
    root.querySelectorAll('[data-draft-verificar]').forEach(b=>b.onclick=()=>{const d=GR.lista().find(x=>x.id===b.dataset.draftVerificar);if(d)GRU.verificarSubmissao(d);});
    root.querySelectorAll('[data-draft-historico]').forEach(b=>b.onclick=()=>{const d=GR.lista().find(x=>x.id===b.dataset.draftHistorico);if(d)GRU.carregarHistorico(d);});
    root.querySelectorAll('[data-draft-dup]').forEach(b=>b.onclick=()=>{const d=GR.lista().find(x=>x.id===b.dataset.draftDup);if(d){const copia={...d,id:GR.id(),nome:d.nome?d.nome+'_copia':'',criado_em:GR.agora()};delete copia.servidor;GR.guarda(GR.novo(copia));GRU.aviso('Rascunho duplicado (só o conteúdo; o estado no servidor não é copiado).');GRU.render();}});
    root.querySelectorAll('[data-draft-delete]').forEach(b=>b.onclick=()=>{const d=GR.lista().find(x=>x.id===b.dataset.draftDelete);if(!d)return;const s=GTA.situacao(d);if(typeof confirm==='function'&&!confirm(`Excluir o rascunho "${d.nome||'(sem nome)'}" deste dispositivo?${s.estado!=='local'?' O que já foi ao servidor continua lá; este painel só perde o vínculo.':' Só o rascunho local é removido.'}`))return;GR.remove(d.id);if(GRU.state.editando===d.id)GRU.fechar();GRU.aviso('Rascunho excluído deste dispositivo.');GRU.render();});
    const r=GRU.state.rascunho;if(!r)return;
    root.querySelectorAll('[data-campo]').forEach(el=>{
      const h=()=>{r[el.dataset.campo]=el.value;const mudouEstrutura=el.dataset.campo==='canal'||(el.dataset.campo==='corpo'&&GR.variaveis(r.corpo).join()!==GRU._vars);const sujoAntes=GRU._sujo,sujoAgora=GTA.situacao(r).sujo;GRU._sujo=sujoAgora;if(mudouEstrutura||sujoAntes!==sujoAgora){GRU._vars=GR.variaveis(r.corpo).join();GRU.render();return;}GRU.atualizaPreview();};
      el.oninput=h;el.onchange=h;});
    GRU._vars=GR.variaveis(r.corpo).join();GRU._sujo=GTA.situacao(r).sujo;
    root.querySelectorAll('[data-exemplo]').forEach(el=>el.oninput=()=>{r.exemplos=r.exemplos||{};r.exemplos[el.dataset.exemplo]=el.value;GRU.mudou(r);});
    root.querySelectorAll('[data-botao-campo]').forEach(el=>{const i=+el.closest('[data-botao]').dataset.botao;const h=()=>{r.botoes[i][el.dataset.botaoCampo]=el.value;if(el.dataset.botaoCampo==='tipo'){r.botoes[i].valor='';GRU.render();}else GRU.mudou(r);};el.oninput=h;el.onchange=h;});
    root.querySelectorAll('[data-botao-remover]').forEach(b=>b.onclick=()=>{r.botoes.splice(+b.dataset.botaoRemover,1);GRU.render();});
    $('#d-botao-add')?.addEventListener('click',()=>{r.botoes=r.botoes||[];r.botoes.push({tipo:'quick_reply',texto:'',valor:''});GRU.render();});
    $('#d-salvar')?.addEventListener('click',()=>{const v=GR.valida(r);if(v.erros.length){GRU.aviso('');GRU.atualizaPreview();document.getElementById('d-checagens')?.scrollIntoView?.({block:'nearest'});return;}
      const salvo=GR.guarda(r);if(salvo){GRU.fechar();GRU.aviso(`Rascunho "${salvo.nome}" salvo neste dispositivo às ${GRU.stamp(salvo.atualizado_em)}.`);}else GRU.aviso('Não foi possível gravar no navegador (armazenamento cheio ou bloqueado). Exporte o arquivo para não perder.','erro');GRU.render();});
    $('#d-cancelar')?.addEventListener('click',()=>{GRU.fechar();GRU.render();});
    $('#d-exportar')?.addEventListener('click',()=>GRU.exporta(r));
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

  /* ---------- chamadas ao servidor ----------
     Padrão único: chave de idempotência por tentativa (reaproveitada se a anterior ficou incerta), resposta traduzida
     por GTA.erro, estado só muda com resposta da API, e tudo que a API confirmou é gravado no rascunho local. */
  idem(r,acao){r.servidor=r.servidor||{};const p=r.servidor.pendente;if(p&&p.acao===acao&&p.idempotency_key)return p.idempotency_key;const k=GTA.uuid();r.servidor.pendente={acao,idempotency_key:k};return k;},
  concluiu(r,res){if(res.rede||res.status>=500||res.status===0)return;if(r.servidor)delete r.servidor.pendente;},
  who(res){return typeof res.body?.who==='string'&&res.body.who.trim()?res.body.who:'chave de escrita deste navegador';},
  async chamada(acao,r,fn){
    if(GRU.state.ocupado)return;
    const escrita=['listar','historico','submissao'].includes(acao)?null:GRU.chaveEscrita(true);
    if(escrita===null&&!['listar','historico','submissao'].includes(acao)){GRU.aviso('Sem chave de escrita: nada foi enviado.','erro');GRU.render();return;}
    GRU.state.ocupado=acao;GRU.aviso('');GRU.render();
    let res;try{res=await fn(GRU.cliente(escrita));}catch(_){res={ok:false,status:0,body:null,rede:true};}
    GRU.state.ocupado=null;
    if(!res.ok){const e=GTA.erro(res,acao);if(e.chaveInvalida)GRU.esqueceChave();return {res,erro:e};}
    return {res,erro:null};
  },
  async salvarServidor(r){
    const v=GR.valida(r);if(v.erros.length){GRU.aviso('Corrija as pendências locais antes de salvar no servidor.','erro');GRU.render();return;}
    const conteudo=GR.conteudo(r),idem=GRU.idem(r,'rascunho');
    const extra={idempotency_key:idem,...(r.servidor?.draft_id?{draft_id:r.servidor.draft_id,expected_version:r.servidor.version}:{})};
    const out=await GRU.chamada('rascunho',r,c=>c.rascunho(conteudo,extra));if(!out)return;
    const {res,erro}=out;GRU.concluiu(r,res);
    if(erro){GRU.falha(r,'rascunho',res,erro);return;}
    const b=res.body||{};
    const s=r.servidor||{};
    r.servidor={...s,draft_id:String(b.draft_id||s.draft_id||''),version:Number.isFinite(+b.version)?+b.version:(s.version||1),estado:'rascunho',salvo_em:b.salvo_em||GR.agora(),confirmado_em:GR.agora(),hash:GTA.hash(conteudo),erros:[],avisos:[],eventos:s.eventos||[]};
    delete r.servidor.conflito;delete r.servidor.submission_id;
    GTA.evento(r.servidor,{at:GR.agora(),who:GRU.who(res),action:'rascunho',to_version:r.servidor.version,result:'ok'});
    GR.guarda(r);GRU.aviso(`Rascunho salvo no servidor como v${r.servidor.version} (${GRU.stamp(r.servidor.salvo_em)}). Não submetido.`);GRU.render();
  },
  async validarServidor(r){
    const idem=GRU.idem(r,'validar');
    const out=await GRU.chamada('validar',r,c=>c.validar(r.servidor.draft_id,idem));if(!out)return;
    const {res,erro}=out;GRU.concluiu(r,res);
    if(erro&&erro.tipo==='validacao'){r.servidor.estado='rascunho';r.servidor.erros=erro.erros;r.servidor.avisos=[];GTA.evento(r.servidor,{at:GR.agora(),who:GRU.who(res),action:'validar',result:'422',detail:`${erro.erros.length} erro(s)`});GR.guarda(r);GRU.aviso(`A API recusou: ${erro.texto}`,'erro');GRU.render();return;}
    if(erro){GRU.falha(r,'validar',res,erro);return;}
    const b=res.body||{};
    r.servidor.estado='validado';r.servidor.erros=[];r.servidor.avisos=Array.isArray(b.avisos)?b.avisos:[];r.servidor.validado_em=GR.agora();r.servidor.confirmado_em=GR.agora();
    GTA.evento(r.servidor,{at:GR.agora(),who:GRU.who(res),action:'validar',result:'ok',detail:r.servidor.avisos.length?`${r.servidor.avisos.length} aviso(s)`:null});
    GR.guarda(r);GRU.aviso(`Validado pela API${r.servidor.avisos.length?` com ${r.servidor.avisos.length} aviso(s)`:''}. Ainda não submetido.`);GRU.render();
  },
  async submeter(r){
    const idem=GRU.idem(r,'submeter');
    const out=await GRU.chamada('submeter',r,c=>c.submeter(r.servidor.draft_id,r.servidor.version,'submeter',idem));if(!out)return;
    const {res,erro}=out;GRU.concluiu(r,res);
    if(erro){GRU.falha(r,'submeter',res,erro);return;}
    const b=res.body||{};
    r.servidor.estado='submetido';r.servidor.submission_id=String(b.submission_id||'');r.servidor.provider=b.provider||(r.canal==='whatsapp'?'meta':'listmonk');r.servidor.provider_id=b.provider_id||null;r.servidor.submitted_at=b.submitted_at||GR.agora();r.servidor.provider_status=null;r.servidor.checked_at=null;r.servidor.confirmado_em=GR.agora();
    GTA.evento(r.servidor,{at:GR.agora(),who:GRU.who(res),action:'submit',from_version:r.servidor.version,to_version:r.servidor.version,result:'202',detail:`submission ${r.servidor.submission_id}`});
    GRU.state.confirmando=false;GRU.state.confirmTexto='';
    GR.guarda(r);GRU.aviso(`Submetido à ${r.servidor.provider==='listmonk'?'Listmonk':'Meta'} às ${GRU.stamp(r.servidor.submitted_at)}. Aguardando; o painel consulta a cada 60 s.`);GRU.render();
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
    if(GRU.state.ocupado)return;
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
    GR.guarda(r);GRU.aviso(`Histórico da API carregado: ${s.historico.length} evento(s).`);GRU.render();
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
