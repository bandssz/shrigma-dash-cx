/* Editor de rascunhos locais — tela. Regras de negócio e armazenamento ficam em growth-drafts.js.
   Tudo aqui é rotulado como rascunho salvo neste dispositivo. Não existe publicar, submeter ou ativar. */
'use strict';
const GRU={
  state:{editando:null,rascunho:null,msg:''},
  ctx:{},
  e:s=>GR.esc(s),
  stamp(v){const t=Date.parse(v||'');return Number.isFinite(t)?new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(t)):'—';},
  rotulo(lista,k){return (lista.find(([v])=>v===k)||[])[1]||k;},
  opts(lista,val){return lista.map(([v,t])=>`<option value="${GRU.e(v)}"${v===val?' selected':''}>${GRU.e(t)}</option>`).join('');},
  /* Catálogo: só associação por nome EXATO. Não inventa corpo, não diz que o rascunho é o template. */
  noCatalogo(nome){
    const tpls=GRU.ctx.api?.crm_operacao?.templates;
    return Array.isArray(tpls)?tpls.find(t=>t&&t.name===nome)||null:null;
  },
  render(ctx){
    if(ctx)GRU.ctx=ctx;
    const root=typeof document!=='undefined'?document.querySelector('#control-drafts'):null;
    if(!root)return;
    const kept=typeof GT!=='undefined'?GT.captura(root):null;
    const lista=GR.lista(),r=GRU.state.rascunho;
    const aviso=`<div class="drafts-scope"><strong>Rascunhos salvos só neste dispositivo</strong><p>Escreva e revise mensagens de WhatsApp e e-mail. Elas ficam neste navegador e só serão salvas ao clicar em Salvar. Para levar a outro computador, exporte o arquivo. Publicação de templates e ativação de automações pelo painel ainda estão em desenvolvimento.</p></div>`;
    const ferramentas=`<div class="gt-toolbar drafts-toolbar"><button type="button" class="btn" id="drafts-novo">Novo rascunho</button>
      <label class="refresh-btn drafts-importar">Importar arquivo<input type="file" id="drafts-arquivo" accept="application/json,.json" hidden></label>
      <span class="gt-contagem">${lista.length} rascunho${lista.length===1?'':'s'} neste dispositivo</span>${GRU.state.msg?`<span class="drafts-msg" role="status">${GRU.e(GRU.state.msg)}</span>`:''}</div>`;
    const cartao=d=>{const v=GR.valida(d),cat=GRU.noCatalogo(d.nome);
      return `<article class="draft-card" data-draft="${GRU.e(d.id)}"><div class="draft-head"><div><span class="control-overline">${GRU.e(GRU.rotulo(GR.MARCAS,d.marca))} · ${GRU.e(GRU.rotulo(GR.CANAIS,d.canal))}${d.canal==='whatsapp'?` · ${GRU.e(d.categoria||'')}`:''}</span>
        <h3>${GRU.e(d.nome||'(sem nome)')}</h3>${d.peca?`<span class="flow-sub">peça: ${GRU.e(d.peca)}</span>`:''}</div>
        <span class="control-badge">Rascunho local</span></div>
        <p class="draft-excerpt">${GRU.e((d.canal==='email'?(d.assunto?d.assunto+' — ':''):'')+String(d.corpo||'').slice(0,140))}${String(d.corpo||'').length>140?'…':''}</p>
        ${cat?`<p class="control-warning">Existe um template com este nome no catálogo da Meta (status ${GRU.e(cat.status||'?')}, categoria ${GRU.e(cat.category||'?')}). O rascunho não é esse template e o catálogo não traz o corpo dele para comparar.</p>`:''}
        <div class="draft-meta">${v.erros.length?`<span class="control-badge control-warning">${v.erros.length} pendência${v.erros.length===1?'':'s'}</span>`:v.avisos.length?`<span class="control-badge">${v.avisos.length} aviso${v.avisos.length===1?'':'s'}</span>`:'<span class="control-badge control-info">Checagens locais ok</span>'}<span>editado ${GRU.stamp(d.atualizado_em)}</span></div>
        <div class="draft-actions"><button type="button" class="refresh-btn" data-draft-edit="${GRU.e(d.id)}">Editar</button><button type="button" class="refresh-btn" data-draft-export="${GRU.e(d.id)}">Exportar arquivo</button><button type="button" class="refresh-btn" data-draft-dup="${GRU.e(d.id)}">Duplicar</button><button type="button" class="refresh-btn draft-delete" data-draft-delete="${GRU.e(d.id)}">Excluir</button></div></article>`;};
    const listaHtml=lista.length?`<div class="draft-grid">${lista.map(cartao).join('')}</div>`:'<div class="vazio">Nenhum rascunho neste dispositivo. Comece por "Novo rascunho" ou importe um arquivo exportado em outro computador.</div>';
    root.innerHTML=aviso+ferramentas+(r?GRU.editor(r):'')+listaHtml;
    GRU.bind(root);
    if(kept&&typeof GT!=='undefined')GT.restaura(root,kept);
  },
  editor(r){
    const wa=r.canal==='whatsapp',vars=GR.variaveis(r.corpo),v=GR.valida(r);
    const botoes=(r.botoes||[]).map((b,i)=>`<div class="draft-botao" data-botao="${i}"><select data-botao-campo="tipo" aria-label="Tipo do botão ${i+1}">${GRU.opts(GR.TIPOS_BOTAO,b.tipo)}</select>
      <input type="text" data-botao-campo="texto" maxlength="${GR.LIMITES.botao}" placeholder="Texto do botão" value="${GRU.e(b.texto)}" aria-label="Texto do botão ${i+1}">
      ${b.tipo==='quick_reply'?'':`<input type="text" data-botao-campo="valor" placeholder="${b.tipo==='url'?'https://…':'+55…'}" value="${GRU.e(b.valor)}" aria-label="${b.tipo==='url'?'Link':'Telefone'} do botão ${i+1}">`}
      <button type="button" class="mais" data-botao-remover="${i}" title="Remover botão">–</button></div>`).join('');
    return `<section class="painel draft-editor" id="draft-editor" aria-label="Editor de rascunho"><div class="painel-cab"><h2>${GRU.state.editando?'Editar rascunho':'Novo rascunho'}</h2><span class="control-badge">Rascunho local</span></div>
      <div class="draft-form"><div class="form">
        <div class="campo"><label for="d-nome">${wa?'Nome do template':'Nome do rascunho'}</label><input type="text" id="d-nome" data-campo="nome" value="${GRU.e(r.nome)}" placeholder="${wa?'fishermans_rastreio_v3':'carta-do-fundador-02'}"><span class="ajuda">${wa?'Como ficará na Meta: minúsculas, números e _.':'Só para você achar depois.'}</span></div>
        <div class="campo"><label for="d-marca">Marca</label><select id="d-marca" data-campo="marca">${GRU.opts(GR.MARCAS,r.marca)}</select></div>
        <div class="campo"><label for="d-canal">Canal</label><select id="d-canal" data-campo="canal">${GRU.opts(GR.CANAIS,r.canal)}</select></div>
        ${wa?`<div class="campo"><label for="d-idioma">Idioma</label><input type="text" id="d-idioma" data-campo="idioma" value="${GRU.e(r.idioma)}" placeholder="pt_BR"></div>
        <div class="campo"><label for="d-categoria">Categoria esperada</label><select id="d-categoria" data-campo="categoria">${GRU.opts(GR.CATEGORIAS,r.categoria)}</select><span class="ajuda">Utility deve tratar de uma solicitação ou transação específica, sem promoção. A Meta define a categoria final.</span></div>`
        :`<div class="campo largo"><label for="d-assunto">Assunto</label><input type="text" id="d-assunto" data-campo="assunto" value="${GRU.e(r.assunto)}"></div>`}
        <div class="campo"><label for="d-peca">Peça (opcional)</label><input type="text" id="d-peca" data-campo="peca" value="${GRU.e(r.peca)}" placeholder="rastreio-criado"><span class="ajuda">Mesmo nome da peça usado nas automações, para bater com o histórico.</span></div>
        ${wa?`<div class="campo largo"><label for="d-cabecalho">Cabeçalho (opcional)</label><input type="text" id="d-cabecalho" data-campo="cabecalho" maxlength="${GR.LIMITES.cabecalho}" value="${GRU.e(r.cabecalho)}"></div>`:''}
        <div class="campo largo"><label for="d-corpo">Corpo</label><textarea id="d-corpo" data-campo="corpo" rows="7" placeholder="${wa?'Olá {{1}}, seu pedido {{2}} saiu para entrega…':'Texto do e-mail…'}">${GRU.e(r.corpo)}</textarea><span class="ajuda" id="d-corpo-conta">${String(r.corpo||'').length}${wa?` de ${GR.LIMITES.corpo}`:''} caracteres${wa?' · variáveis como {{1}}, {{2}}':''}</span></div>
        ${wa?`<div class="campo largo"><label for="d-rodape">Rodapé (opcional)</label><input type="text" id="d-rodape" data-campo="rodape" maxlength="${GR.LIMITES.rodape}" value="${GRU.e(r.rodape)}"></div>`:''}
        ${wa&&vars.length?`<div class="campo largo"><label>Exemplos das variáveis</label><div class="draft-exemplos">${vars.map(n=>`<label>{{${n}}}<input type="text" data-exemplo="${n}" value="${GRU.e((r.exemplos||{})[n]||'')}" placeholder="exemplo real, sem dado de cliente"></label>`).join('')}</div><span class="ajuda">A Meta pede um exemplo por variável. Use valores fictícios.</span></div>`:''}
        <div class="campo largo"><label>Botões ${wa?`(até ${GR.LIMITES.botoes})`:'(links do e-mail)'}</label><div class="draft-botoes" id="d-botoes">${botoes||'<span class="ajuda">Nenhum botão.</span>'}</div>
          ${(r.botoes||[]).length<GR.LIMITES.botoes?'<button type="button" class="refresh-btn" id="d-botao-add">Adicionar botão</button>':''}</div>
      </div>
      <div class="draft-preview" aria-live="polite"><div class="draft-preview-head">Prévia do que você digitou<span class="control-badge">não é o template publicado</span></div><div id="d-preview">${GRU.preview(r)}</div>
        <div id="d-checagens">${GRU.checagens(v)}</div></div></div>
      <div class="draft-editor-actions"><button type="button" class="btn" id="d-salvar">Salvar neste dispositivo</button><button type="button" class="btn sec" id="d-cancelar">Fechar sem salvar</button><button type="button" class="refresh-btn" id="d-exportar">Exportar arquivo</button><span class="mini">Salvar grava no navegador. Não cadastra, não submete e não ativa nada.</span></div></section>`;
  },
  preview(r){
    const ex=r.exemplos||{},corpo=GR.preenche(r.corpo,ex);
    if(r.canal==='email')return `<div class="draft-mail"><div class="draft-mail-assunto">${GRU.e(r.assunto||'(sem assunto)')}</div><div class="draft-mail-corpo">${GRU.e(corpo)||'<span class="mini">Corpo vazio.</span>'}</div>${(r.botoes||[]).filter(b=>b.texto).map(b=>`<span class="draft-mail-link">${GRU.e(b.texto)}</span>`).join('')}</div>`;
    return `<div class="draft-bubble">${r.cabecalho?`<div class="draft-bubble-head">${GRU.e(GR.preenche(r.cabecalho,ex))}</div>`:''}<div class="draft-bubble-body">${GRU.e(corpo)||'<span class="mini">Corpo vazio.</span>'}</div>${r.rodape?`<div class="draft-bubble-foot">${GRU.e(r.rodape)}</div>`:''}</div>
      ${(r.botoes||[]).filter(b=>b.texto).map(b=>`<div class="draft-bubble-btn">${b.tipo==='url'?'↗ ':b.tipo==='phone'?'☏ ':''}${GRU.e(b.texto)}</div>`).join('')}`;
  },
  checagens(v){
    if(!v.erros.length&&!v.avisos.length)return '<p class="draft-ok">Checagens locais ok. Essas checagens são parciais. No WhatsApp, a Meta define aprovação e categoria; no e-mail, ainda falta validar a integração de envio.</p>';
    return `${v.erros.map(x=>`<p class="control-warning draft-erro">${GRU.e(x)}</p>`).join('')}${v.avisos.map(x=>`<p class="draft-aviso">${GRU.e(x)}</p>`).join('')}`;
  },
  atualizaPreview(){
    const r=GRU.state.rascunho;if(!r)return;
    const p=document.getElementById('d-preview'),c=document.getElementById('d-checagens'),n=document.getElementById('d-corpo-conta');
    if(p)p.innerHTML=GRU.preview(r);if(c)c.innerHTML=GRU.checagens(GR.valida(r));
    if(n)n.textContent=`${String(r.corpo||'').length}${r.canal==='whatsapp'?` de ${GR.LIMITES.corpo}`:''} caracteres${r.canal==='whatsapp'?' · variáveis como {{1}}, {{2}}':''}`;
  },
  abrir(r,editando){GRU.state={editando,rascunho:{...GR.novo(),...r,exemplos:{...(r.exemplos||{})},botoes:(r.botoes||[]).map(b=>({...b}))},msg:''};GRU.render();document.getElementById('d-nome')?.focus();},
  bind(root){
    const $=s=>root.querySelector(s);
    $('#drafts-novo')?.addEventListener('click',()=>GRU.abrir(GR.novo(),null));
    const arquivo=$('#drafts-arquivo');
    if(arquivo)arquivo.onchange=()=>{const f=arquivo.files&&arquivo.files[0];if(!f)return;const rd=new FileReader();rd.onload=()=>GRU.importaTexto(String(rd.result||''));rd.readAsText(f);};
    root.querySelectorAll('[data-draft-edit]').forEach(b=>b.onclick=()=>{const d=GR.lista().find(x=>x.id===b.dataset.draftEdit);if(d)GRU.abrir(d,d.id);});
    root.querySelectorAll('[data-draft-export]').forEach(b=>b.onclick=()=>{const d=GR.lista().find(x=>x.id===b.dataset.draftExport);if(d)GRU.exporta(d);});
    root.querySelectorAll('[data-draft-dup]').forEach(b=>b.onclick=()=>{const d=GR.lista().find(x=>x.id===b.dataset.draftDup);if(d){GR.guarda(GR.novo({...d,id:GR.id(),nome:d.nome?d.nome+'_copia':'',criado_em:GR.agora()}));GRU.state.msg='Rascunho duplicado.';GRU.render();}});
    root.querySelectorAll('[data-draft-delete]').forEach(b=>b.onclick=()=>{const d=GR.lista().find(x=>x.id===b.dataset.draftDelete);if(!d)return;if(typeof confirm==='function'&&!confirm(`Excluir o rascunho "${d.nome||'(sem nome)'}" deste dispositivo? Só o rascunho local é removido.`))return;GR.remove(d.id);if(GRU.state.editando===d.id)GRU.state={editando:null,rascunho:null,msg:''};GRU.state.msg='Rascunho excluído deste dispositivo.';GRU.render();});
    const r=GRU.state.rascunho;if(!r)return;
    root.querySelectorAll('[data-campo]').forEach(el=>{
      const h=()=>{r[el.dataset.campo]=el.value;if(el.dataset.campo==='canal'||el.dataset.campo==='corpo'&&GR.variaveis(r.corpo).join()!==GRU._vars){GRU._vars=GR.variaveis(r.corpo).join();GRU.render();return;}GRU.atualizaPreview();};
      el.oninput=h;el.onchange=h;});
    GRU._vars=GR.variaveis(r.corpo).join();
    root.querySelectorAll('[data-exemplo]').forEach(el=>el.oninput=()=>{r.exemplos=r.exemplos||{};r.exemplos[el.dataset.exemplo]=el.value;GRU.atualizaPreview();});
    root.querySelectorAll('[data-botao-campo]').forEach(el=>{const i=+el.closest('[data-botao]').dataset.botao;const h=()=>{r.botoes[i][el.dataset.botaoCampo]=el.value;if(el.dataset.botaoCampo==='tipo'){r.botoes[i].valor='';GRU.render();}else GRU.atualizaPreview();};el.oninput=h;el.onchange=h;});
    root.querySelectorAll('[data-botao-remover]').forEach(b=>b.onclick=()=>{r.botoes.splice(+b.dataset.botaoRemover,1);GRU.render();});
    $('#d-botao-add')?.addEventListener('click',()=>{r.botoes=r.botoes||[];r.botoes.push({tipo:'quick_reply',texto:'',valor:''});GRU.render();});
    $('#d-salvar')?.addEventListener('click',()=>{const v=GR.valida(r);if(v.erros.length){GRU.state.msg='';GRU.atualizaPreview();document.getElementById('d-checagens')?.scrollIntoView?.({block:'nearest'});return;}
      const salvo=GR.guarda(r);GRU.state=salvo?{editando:null,rascunho:null,msg:`Rascunho "${salvo.nome}" salvo neste dispositivo às ${GRU.stamp(salvo.atualizado_em)}.`}:{...GRU.state,msg:'Não foi possível gravar no navegador (armazenamento cheio ou bloqueado). Exporte o arquivo para não perder.'};GRU.render();});
    $('#d-cancelar')?.addEventListener('click',()=>{GRU.state={editando:null,rascunho:null,msg:''};GRU.render();});
    $('#d-exportar')?.addEventListener('click',()=>GRU.exporta(r));
  },
  exporta(d){if(typeof GT!=='undefined')GT.baixar(GR.nomeArquivo(d),GR.exporta(d),'application/json');},
  importaTexto(texto){const res=GR.importa(texto);if(res.erro){GRU.state.msg=res.erro;GRU.render();return;}GRU.abrir(res.rascunho,null);GRU.state.msg='Arquivo importado como novo rascunho. Revise e salve.';GRU.render();},
};
if(typeof module!=='undefined'&&module.exports)module.exports=GRU;
