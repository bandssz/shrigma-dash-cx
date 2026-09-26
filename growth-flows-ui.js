/* Fluxos — tela (Fase C · leitura). Regras em growth-flows.js. Sem edição: publicar/ativar/mudar etapa dependem da API de
   fluxos (Fase B, contrato R6). Tudo que aparece aqui vem da API; o que ela não declara é dito como "não declarado". */
'use strict';
const GFU={
  state:{q:'',origem:'todas'},
  ctx:{},
  e:s=>GF.obj(s)?'':String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  marca(k){return {fish:'Fishermans',aristo:'O Aristocrata',olivas:'Olivas do Campo'}[k]||k;},
  stamp(v){return typeof GC!=='undefined'?GC.stamp(v):v;},
  badge(t,tone='neutral'){return `<span class="control-badge control-${GFU.e(tone)}">${GFU.e(t)}</span>`;},
  owner(html){return `<details class="control-detail" data-crm-owner-only><summary>Detalhes técnicos</summary>${html}</details>`;},
  modoGerencia(f){
    const ws=f.etapas.flatMap(e=>e.workflows),partial=f.etapas.some(e=>!e.workflows.length);
    const text={nao_declarado:'Configuração indisponível',nao_confirmado:'Configuração não confirmada',misto:'Configuração varia entre mensagens',real:'Envio real configurado',sombra:'Simulação configurada',interno:'Envio interno configurado'}[f.modo.valor]||'Configuração não confirmada';
    return text+(ws.length&&partial?' · parte das mensagens':'')+(ws.some(w=>w.ativo===false)?' · automação inativa':'');
  },
  render(ctx){
    if(ctx)GFU.ctx=ctx;
    if(typeof GB!=='undefined'&&GFU.ctx.api?.capabilities?.workflows?.editor===true){GB.render(GFU.ctx);return;}
    const root=typeof document!=='undefined'?document.querySelector('#control-fluxos'):null;if(!root)return;
    const kept=typeof GT!=='undefined'?GT.captura(root):null;
    const lista=GF.lista(GFU.ctx.api,GFU.ctx);
    const busca=f=>!GFU.state.q||typeof GT==='undefined'||GT.busca([f],GFU.state.q,['nome','flow','key',x=>GFU.marca(x.marca),x=>x.etapas.map(e=>e.peca||e.template_nome||'').join(' ')]).length>0;
    const defs=GFU.state.origem==='observados'?[]:lista.definidos.filter(busca),obs=GFU.state.origem==='definidos'?[]:lista.observados.filter(busca);
    const total=lista.definidos.length+lista.observados.length,mostrados=defs.length+obs.length;
    const contexto=`<div class="control-context"><div><strong>Fluxos · leitura</strong><span class="control-badge" title="A edição de fluxos não está disponível nesta consulta. Nenhuma configuração é alterada aqui.">Somente leitura</span><p>${lista.presenteDef?`Configuração consultada em ${GFU.e(lista.gerado_em?GFU.stamp(lista.gerado_em):'horário não informado')}.${lista.observados.length?' Mensagens sem configuração informada aparecem no histórico.':''}`:'<strong>Histórico de mensagens.</strong> Sequência e esperas ainda não disponíveis; consulte Operação atual.'}</p>
      <details class="control-detail" data-gt-key="fluxos-como-ler"><summary>Como ler estes fluxos</summary><p>${lista.presenteDef?'Gatilho, etapas, esperas e condições seguem a configuração recebida.':'A consulta informa mensagens, canais, modelos e configuração conhecida. O nome de uma mensagem não revela o gatilho nem a ordem de execução.'} Modo é a configuração de envio; "real" não confirma entrega. Volumes usam o período selecionado: WhatsApp aceitos e entregues; e-mail aceito pelo provedor.</p></details></div>
      <div class="control-updated">Neste recorte<br><strong>${total} fluxo${total===1?'':'s'}</strong><span>${lista.definidos.length} com configuração · ${lista.observados.length} no histórico</span></div></div>
      ${lista.invalidosDef?`<p class="control-warning" data-crm-manager-only>${lista.invalidosDef} fluxo${lista.invalidosDef===1?' não pôde ser carregado':'s não puderam ser carregados'}. Consulte Operação atual.</p>${GFU.owner(`<p class="control-warning">${lista.invalidosDef} definição(ões) de fluxo em formato inválido ignorada(s): ${GFU.e(lista.errosDef.map(x=>`${x.key||'#'+(x.indice+1)} (${x.erros[0]})`).join('; '))}.</p>`)}`:''}
      ${lista.invalidasObs?`<p class="control-warning">${lista.invalidasObs} linha(s) de envio em formato inválido ignorada(s) no histórico.</p>`:''}`;
    const toolbar=total?`<div class="gt-toolbar control-toolbar"><label class="gt-busca" for="fluxos-busca">Buscar fluxo<input type="search" id="fluxos-busca" placeholder="Nome, peça ou marca" value="${GFU.e(GFU.state.q)}" autocomplete="off"></label>
      <label class="gt-filtro">Origem<select id="fluxos-origem" data-gt-filter="fluxos-origem"><option value="todas"${GFU.state.origem==='todas'?' selected':''}>Todas</option><option value="definidos"${GFU.state.origem==='definidos'?' selected':''}>Configuração disponível</option><option value="observados"${GFU.state.origem==='observados'?' selected':''}>Histórico de mensagens</option></select></label>
      <span class="gt-contagem">${mostrados} de ${total} fluxos</span>
      <button type="button" class="refresh-btn gt-export" id="fluxos-export"${mostrados?'':' disabled'}>Exportar CSV (por etapa)</button></div>`:'';
    const vazio=!total?`<div class="vazio">Nenhum fluxo neste recorte. Ausência de linha não prova ausência de automação: confira a marca selecionada e a aba Operação atual.</div>`
      :!mostrados?`<div class="vazio">Nenhum fluxo com esses filtros. <button type="button" class="refresh-btn gt-limpar" id="fluxos-limpar">Limpar filtros</button></div>`:'';
    root.innerHTML=contexto+toolbar+`<div class="flows-grid">${defs.map(GFU.definido).join('')}${obs.map(GFU.observado).join('')}</div>`+vazio;
    GFU.bind(root,{defs,obs,lista});
    if(kept&&typeof GT!=='undefined')GT.restaura(root,kept);
  },
  templateInfo(nome,ref){
    const tpls=GFU.ctx.api?.crm_operacao?.templates;const t=Array.isArray(tpls)?tpls.find(x=>GF.obj(x)&&((nome&&x.name===nome)||(ref&&String(x.id)===String(ref)))):null;
    const conteudo=typeof GC!=='undefined'&&GC.conteudo?Object.values(GC.conteudo).find(x=>x&&((nome&&x.name===nome)||(ref&&String(x.id)===String(ref)))):null;
    return {catalogo:t||null,conteudo:conteudo||null};
  },
  definido(f){
    const g=f.gatilho,v=f.versao,e=GFU.e;
    const etapas=f.etapas.map(et=>{
      const ti=et.tipo==='mensagem'?GFU.templateInfo(et.template_nome,et.template_ref):null;
      const titulo=et.tipo==='mensagem'?`${GF.CANAIS[et.canal]} · ${e(et.peca||et.template_nome||et.template_ref)}`:et.tipo==='espera'?`Espera ${GF.espera(et.espera_seg)}`:et.tipo==='condicao'?'Condição':'Fim';
      const sub=et.tipo==='mensagem'?`${e(et.template_nome||et.template_ref)}${ti.catalogo?` · ${e(ti.catalogo.status||'?')}${ti.catalogo.category?` · ${e(ti.catalogo.category)}`:''}`:et.canal==='whatsapp'?' · não encontrado no catálogo da Meta desta coleta':''}${et.modo&&et.modo!==f.modo?` · modo ${e(et.modo)} (difere do fluxo)`:''}`
        :et.tipo==='condicao'?et.condicoes.map(c=>`se ${e(c.se)}${c.entao?` → ${e(c.entao)}`:''}`).join(' · '):'';
      const detalhe=et.tipo==='mensagem'?(ti.conteudo?`<div class="flow-preview">${GTA.previaComponents(ti.conteudo.components)}</div>`:`<p class="mini">${ti.catalogo?'O catálogo traz metadados, não o corpo. Abra o conteúdo publicado na aba Templates para conferir a prévia, quando disponível.':'Sem prévia: template fora do catálogo desta coleta.'}</p>`):'';
      return `<li class="flow-step" data-tipo="${e(et.tipo)}" data-canal="${e(et.canal||'')}"><span class="flow-step-n">${e(et.ordem)}</span><div class="flow-step-body"><strong>${titulo}</strong>${sub?`<span class="flow-step-sub">${sub}</span>`:''}${detalhe?`<details class="control-detail" data-gt-key="flow-${e(f.marca)}-${e(f.key)}-${e(et.key)}"><summary>Prévia</summary>${detalhe}</details>`:''}</div></li>`;}).join('');
    return `<article class="control-workflow flow-card" data-flow="${e(f.marca)}|${e(f.key)}" data-origem="definido"><div class="control-workflow-head"><div><span class="control-overline">${e(GFU.marca(f.marca))} · configuração disponível${f.motor?`<span data-crm-owner-only> · motor ${e(f.motor)}</span>`:''}</span><h3>${e(f.nome)}</h3></div>
      <div class="flow-badges">${GFU.badge(`Modo ${f.modo}`,f.modo==='real'?'verified':'neutral')}${v?GFU.badge(`v${v.numero??'?'} · ${v.ativa?'ativa':'não ativa'}`,v.ativa?'info':'neutral'):''}${v?.rascunho_pendente?GFU.badge('Rascunho pendente','warning'):''}</div></div>
      <p class="flow-trigger"><span data-crm-owner-only><strong>Gatilho:</strong> ${e(g.evento)}${g.descricao?` — ${e(g.descricao)}`:''}<br><span class="mini">chave do evento <code>${e(g.chave_evento)}</code> · reentrada: ${e({nunca:'nunca',apos_fim:'só depois de terminar',sempre:'sempre'}[g.reentrada])}${g.saida.length?` · sai ao ocorrer: ${e(g.saida.join(', '))}`:' · sem condição de saída declarada'}</span></span><span data-crm-manager-only><strong>Quando começa:</strong> ${e(g.descricao||'Descrição não disponível nesta consulta.')}<br><span class="mini">Regras de retorno e encerramento: consulte Operação atual.</span></span></p>
      <ol class="flow-steps">${etapas}</ol>
      ${f.etapas_invalidas?`<p class="control-warning">${f.etapas_invalidas} etapa(s) em formato inválido não exibida(s).</p>`:''}
      <div class="control-collected">${v?.publicada_em?`Versão publicada em ${e(GFU.stamp(v.publicada_em))}`:'Sem versão publicada'} · definição lida ${e(GFU.stamp(GF.definidos(GFU.ctx.api).gerado_em))}</div></article>`;
  },
  observado(f){
    const e=GFU.e;
    const etapas=f.etapas.map((et,i)=>`<li class="flow-step" data-tipo="mensagem" data-canal="${e(et.canal||'')}"><span class="flow-step-n">·</span><div class="flow-step-body"><strong>${e(et.canal?GF.CANAIS[et.canal]:`canal "${et.canal_bruto}"`)} · ${e(et.peca)}</strong>
      <span class="flow-step-sub">${et.templates.length?et.templates.map(t=>`${e(t.name)} · ${e(t.status)}`).join(' | '):'Modelo da mensagem não informado'}</span>
      ${GFU.owner(`<span class="flow-step-sub">${et.workflows.length?et.workflows.map(w=>`<span class="control-template-link" data-tone="${w.atual===true&&w.modo==='real'?'verified':w.atual===false?'warning':'neutral'}">${e(w.label)} · ${e(GF.modoTexto(w))}${w.ativo===false?' · inativo':''}</span>`).join(''):'<span class="control-template-link" data-tone="neutral">workflow não declarado no manifesto</span>'}</span>`)}
      <span class="flow-step-sub flow-volume">${e(GF.volumeTexto(et))}</span></div></li>`).join('');
    const saude=f.saude.map(s=>`<span class="fluxo-chip" data-estado="${e(['ok','alerta'].includes(s.estado)?s.estado:'desconhecido')}" title="${e((s.motivo||'Sem ocorrência na última verificação')+' · verificado '+GFU.stamp(s.verificado_em))}">${e(s.nome||s.chave)}${s.estado==='alerta'?' · alerta':''}</span>`).join('');
    const health=f.saude.map(s=>`<span class="fluxo-chip" data-estado="${e(['ok','alerta'].includes(s.estado)?s.estado:'desconhecido')}" title="${e('Verificado em '+(s.verificado_em?GFU.stamp(s.verificado_em):'horário não informado'))}">${e(s.estado==='ok'?'Sem ocorrência na verificação':s.estado==='alerta'?'Atenção nesta automação · consulte Operação atual':'Verificação indisponível · consulte Operação atual')}</span>`).join('');
    return `<article class="control-workflow flow-card" data-flow="${e(f.marca)}|${e(f.flow)}" data-origem="observado"><div class="control-workflow-head"><div><span class="control-overline">${e(GFU.marca(f.marca))} · histórico de mensagens</span><h3>${e(f.flow)}</h3></div>
      <div class="flow-badges"><span data-crm-manager-only>${GFU.badge(GFU.modoGerencia(f),f.modo.tone)}</span><span data-crm-owner-only>${GFU.badge(f.modo.rotulo,f.modo.tone)}</span></div></div>
      <p class="flow-trigger"><strong>Configuração indisponível.</strong> Sequência, esperas e condições de saída ainda não disponíveis; consulte Operação atual.<br><span class="mini">As mensagens abaixo estão em ordem alfabética, não na sequência de envio.</span></p>
      <ol class="flow-steps flow-steps-obs">${etapas}</ol>
      ${saude?`<div class="fluxo-saude-lista flow-saude"><span data-crm-manager-only>${health}</span>${GFU.owner(saude)}</div>`:''}</article>`;
  },
  bind(root,{defs,obs}){
    const q=root.querySelector('#fluxos-busca');if(q)q.oninput=()=>{const pos=q.selectionStart;GFU.state.q=q.value;GFU.render();const n=root.querySelector('#fluxos-busca');n?.focus();n?.setSelectionRange?.(pos,pos);};
    const o=root.querySelector('#fluxos-origem');if(o)o.onchange=()=>{GFU.state.origem=o.value;GFU.render();};
    root.querySelector('#fluxos-limpar')?.addEventListener('click',()=>{GFU.state={q:'',origem:'todas'};GFU.render();});
    const ex=root.querySelector('#fluxos-export');if(ex)ex.onclick=()=>{if(typeof GT==='undefined')return;const m={...(GFU.ctx.exportMeta?GFU.ctx.exportMeta():{})};GT.baixar(GT.nomeArquivo('fluxos',m),GT.csv(GF.colunas,GF.linhasCsv({definidos:defs,observados:obs}),m));};
  },
};
if(typeof module!=='undefined'&&module.exports)module.exports=GFU;
