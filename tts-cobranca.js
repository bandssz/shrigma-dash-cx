/* Aba Cobrança do TikTok (26/09/2026): modelos aprovados pela Marcela, o que o robô faria hoje, o que saiu
   e o que precisa de gente. Lê e grava em crm_tts_cobranca_painel_v1 com a chave do painel de Influs.
   Enviar para o criador continua sendo só do sender no servidor; esta tela nunca fala com a TikTok. */
(function(root){'use strict';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const MARCA={aristo:'O Aristocrata',fish:'Fishermans'};
 const ETAPA={vitrine_sem_video:'Pôs na vitrine, não gravou',amostra_sem_video:'Recebeu amostra, não postou'};
 const ESTADO={aceito:['enviada','bom'],bloqueado:['parou','neutro'],incerto:['sem confirmação','ruim'],em_transporte:['sem confirmação','ruim'],reservado:['na fila','nulo']};
 // O que cada motivo quer dizer para quem opera.
 const MOTIVO={
  im_resposta_criador:'respondeu no chat',im_nao_lidas:'tem mensagem sem ler',im_conversa_recente:'conversa em andamento (7 dias)',
  im_historico_incompleto:'não deu para ler a conversa inteira',im_historico_ausente:'conversa existe mas veio vazia',im_mensagem_desconhecida:'mensagem de formato desconhecido',
  im_identidade_divergente:'conversa aberta com outro usuário',im_identidade_incompleta:'TikTok não confirmou quem é',identidade_ambigua:'usuário ligado a duas contas',
  im_abertura_invalida:'TikTok não abriu a conversa',im_leitura_invalida:'TikTok não devolveu as mensagens',im_data_invalida:'mensagem sem data válida',
  preflight_resultado_incerto:'TikTok não respondeu ao abrir a conversa',transporte_resultado_incerto:'TikTok não respondeu ao envio',
  transporte_sem_aceite_confirmado:'TikTok não confirmou o envio',api_aceitou:'TikTok aceitou',confirmado_no_seller_center:'conferido no Seller Center',
  fonte_nao_elegivel:'já não deve conteúdo',fonte_alterada:'dado mudou durante o envio',modelo_alterado:'mensagem mudou durante o envio',modelo_nao_aprovado:'mensagem sem aprovação',
  supressao:'fora da régua',modo_nao_ativo:'cobrança desligada durante o envio',historico_legado_requer_conciliacao:'envio antigo a conferir'};
 const motivo=m=>MOTIVO[m]||String(m||'').replace(/_/g,' ');
 // {nome} e {produto} aparecem como marcadores, com o que viram na mensagem.
 const vars=t=>esc(t).replace(/\{nome\}/g,'<span class="cob-var" title="vira “, Fulano” quando o apelido parece nome de gente; senão some">nome</span>').replace(/\{produto\}/g,'<span class="cob-var" title="nome curto do produto">produto</span>');
 const dt=v=>{if(!v)return '—';const d=new Date(v);return isNaN(d)?'—':d.toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});};
 const msg=t=>{const s=String(t||''),p=s.split('\n')[0];if(!s)return '<span class="mini">—</span>';
  return s.length<=90&&!s.includes('\n')?esc(s):`<details class="tts-msg-det"><summary>${esc(p.slice(0,90))}…</summary><div>${esc(s)}</div></details>`;};
 function create({document,endpoint,key,getMarca,fetchImpl,onChange}){
  let dados=null,chave=null,erro='',aviso='',busy=false,host=null,editando=null;
  const f=()=>fetchImpl||root.fetch.bind(root);
  async function call(acao,data){
   const k=key();if(!k)throw Error('Entre com a chave do painel.');
   const url=endpoint();if(!url)throw Error('Serviço da cobrança não configurado.');
   const r=await f()(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao,data,k}),credentials:'omit',redirect:'error',cache:'no-store'});
   let j;try{j=await r.json();}catch(_){throw Error('Resposta não confirmada. Recarregue antes de repetir.');}
   if(!r.ok||!j||j.erro)throw Error(j?.erro||'Não foi possível concluir.');return j;
  }
  async function carregar(){
   if(busy)return;busy=true;erro='';paint();
   try{const k=key();dados=await call('ler');chave=k;}catch(e){erro=e.message;}
   finally{busy=false;paint();if(onChange)onChange();}
  }
  async function escreve(acao,data){
   busy=true;aviso='Gravando…';paint();
   try{const j=await call(acao,data);aviso=j.mensagem||'Feito.';editando=null;dados=await call('ler');}
   catch(e){aviso=e.message;}finally{busy=false;paint();if(onChange)onChange();}
  }
  const daMarca=xs=>{const m=getMarca();return (xs||[]).filter(x=>m==='todas'||x.marca===m);};
  const tagM=m=>`<span class="tag nulo">${esc(MARCA[m]||m)}</span>`;
  function paint(){
   if(!host)return;
   if(!dados){host.innerHTML=erro?`<div class="vazio">${esc(erro)} <button type="button" class="btn sec" data-cob="recarregar">Tentar de novo</button></div>`:'<div class="vazio">Carregando a cobrança…</div>';ligar();return;}
   const pode=dados.pode_escrever===true,todas=getMarca()==='todas';
   const regras=daMarca(dados.regras),modelos=daMarca(dados.modelos),envios=daMarca(dados.envios),sims=daMarca(dados.simulacoes),sup=daMarca(dados.supressoes);
   const pend=envios.filter(e=>e.humano&&!e.suprimido),saiu=envios.filter(e=>e.estado==='aceito'),tec=envios.filter(e=>!e.humano&&e.estado!=='aceito');
   const MODO={ativo:['envio ligado','bom'],dry_run:['simulação','neutro'],pausado:['pausada','nulo']};
   const estadoMarca=regras.map(g=>{const ap=dados.modelos.filter(m=>m.marca===g.marca&&m.ativo),ok=ap.filter(m=>m.aprovado).length,[rot,cls]=MODO[g.cobranca_modo]||[g.cobranca_modo,'nulo'];
    return `<div class="cob-marca"><div class="cob-marca-top">${tagM(g.marca)}<span class="tag ${cls}">${esc(rot)}</span>${g.parada?'<span class="tag ruim">parada: confira o envio sem confirmação</span>':''}</div>
     <div class="cob-marca-num"><strong class="tabn">${esc(g.hoje)}</strong> de ${esc(g.max_dia)} hoje · <strong class="tabn">${ok}</strong> de ${ap.length} mensagens aprovadas</div>
     ${g.cobranca_modo!=='ativo'&&g.pronta?'<div class="mini">Pronta para ligar na configuração abaixo.</div>':''}${!g.pronta?'<div class="mini">Para ligar, aprove ao menos uma mensagem desta marca.</div>':''}</div>`;}).join('');
   const botao=(rot,attrs,cls='sec')=>pode?`<button type="button" class="btn ${cls} cob-btn" ${attrs} ${busy?'disabled':''}>${rot}</button>`:'';
   const idE=e=>`data-marca="${esc(e.marca)}" data-etapa="${esc(e.etapa)}" data-username="${esc(e.username)}" data-tentativa="${esc(e.tentativa)}" data-estado="${esc(e.estado)}"`;
   const pendHtml=pend.length?`<div class="painel-cab cob-cab"><h3>Precisa de você <span class="tag alerta">${pend.length}</span></h3><span class="mini">o robô parou de propósito; a próxima palavra é sua</span></div>
    <div class="cob-lista">${pend.map(e=>{const enviado=e.transporte_em!=null;
     return `<div class="cob-item"><div class="cob-item-top">${todas?tagM(e.marca):''}<strong>@${esc(e.username)}</strong><span class="mini">${esc(ETAPA[e.etapa]||e.etapa)} · toque ${esc(e.tentativa)}</span></div>
      <div class="cob-item-motivo">${enviado?'Mensagem enviada sem confirmação da TikTok. Confira no chat do Seller Center se ela chegou.':esc(motivo(e.motivo))+'. Responda pelo chat do Seller Center; depois devolva à régua ou tire a pessoa dela.'}</div>
      <div class="cob-item-msg">${msg(e.texto)}</div>
      <div class="cob-acoes">${enviado?botao('Chegou',`data-cob="resolver" data-decisao="chegou" ${idE(e)}`,'')+botao('Não chegou',`data-cob="resolver" data-decisao="nao_chegou" ${idE(e)}`)
       :botao('Já respondi · devolver à régua',`data-cob="resolver" data-decisao="liberar" ${idE(e)}`,'')+botao('Tirar da régua',`data-cob="resolver" data-decisao="suprimir" ${idE(e)}`)}<span class="mini">${dt(e.concluido_em||e.transporte_em||e.reservado_em)}</span></div></div>`;}).join('')}</div>`:'';
   const porEtapa=Object.keys(ETAPA).map(et=>{const ms=modelos.filter(m=>m.etapa===et);if(!ms.length)return '';
    return `<div class="cob-etapa"><h4>${esc(ETAPA[et])}</h4>${ms.map(m=>{const k=`${m.marca}|${m.etapa}|${m.tentativa}`,ed=editando===k,attrs=`data-marca="${esc(m.marca)}" data-etapa="${esc(m.etapa)}" data-tentativa="${esc(m.tentativa)}" data-esperado="${esc(m.atualizado_em)}"`;
     return `<div class="cob-modelo${m.aprovado?' ok':''}"><div class="cob-modelo-top">${todas?tagM(m.marca):''}<strong>Toque ${esc(m.tentativa)}</strong>${m.aprovado?`<span class="tag bom">aprovada · ${esc(m.aprovado_por||'')} ${esc(dt(m.aprovado_em))}</span>`:'<span class="tag neutro">sem aprovação · não sai</span>'}${m.ativo?'':'<span class="tag nulo">desativada</span>'}</div>
      ${ed?`<textarea class="cob-texto" rows="5" maxlength="700" aria-label="Mensagem do toque ${esc(m.tentativa)}">${esc(m.texto)}</textarea><div class="mini">{nome} vira ", Fulano" quando o apelido parece nome de gente; {produto} é o nome curto do produto.</div>
       <div class="cob-acoes">${botao('Salvar e aprovar',`data-cob="salvar" ${attrs}`,'')}<button type="button" class="btn sec" data-cob="cancelar">Cancelar</button></div>`
      :`<div class="cob-modelo-txt">${vars(m.texto)}</div><div class="cob-acoes">${m.aprovado?botao('Retirar aprovação',`data-cob="revogar" ${attrs}`):botao('Aprovar este texto',`data-cob="aprovar" ${attrs}`,'')}${botao('Editar',`data-cob="editar" data-k="${esc(k)}"`)}</div>`}</div>`;}).join('')}</div>`;}).join('');
   const simHtml=sims.length?`<details class="cob-det"${pend.length?'':' open'}><summary>O que o robô faria na última simulação <span class="tag nulo">${sims.length}</span></summary>
    <div class="rolagem"><table class="comparativo tts-compacta"><thead><tr>${todas?'<th>Marca</th>':''}<th>Criador</th><th>Por quê</th><th class="num">Toque</th><th>Mensagem</th><th>Quando</th></tr></thead><tbody>
    ${sims.map(s=>`<tr>${todas?`<td>${tagM(s.marca)}</td>`:''}<td>@${esc(s.username)}</td><td class="mini">${esc(ETAPA[s.etapa]||s.etapa)}</td><td class="num tabn">${esc(s.tentativa)}</td><td class="msg">${msg(s.texto)}${s.aprovado?'':' <span class="tag neutro">sem aprovação</span>'}</td><td class="mini tabn">${dt(s.simulado_em)}</td></tr>`).join('')}</tbody></table></div></details>`:'';
   const linhaEnvio=e=>{const [rot,cls]=ESTADO[e.estado]||[e.estado,'nulo'];return `<tr>${todas?`<td>${tagM(e.marca)}</td>`:''}<td>@${esc(e.username)}</td><td class="mini">${esc(ETAPA[e.etapa]||e.etapa)}</td><td class="num tabn">${esc(e.tentativa)}</td><td><span class="tag ${cls}">${esc(rot)}</span> <span class="mini">${esc(motivo(e.motivo))}</span></td><td class="msg">${msg(e.texto)}</td><td class="mini tabn">${dt(e.concluido_em||e.reservado_em)}</td></tr>`;};
   const cabEnvio=`<thead><tr>${todas?'<th>Marca</th>':''}<th>Criador</th><th>Por quê</th><th class="num">Toque</th><th>Estado</th><th>Mensagem</th><th>Quando</th></tr></thead>`;
   const saiuHtml=`<details class="cob-det"${saiu.length&&!pend.length?' open':''}><summary>Enviadas nos últimos 45 dias <span class="tag nulo">${saiu.length}</span></summary>${saiu.length?`<div class="rolagem"><table class="comparativo tts-compacta">${cabEnvio}<tbody>${saiu.map(linhaEnvio).join('')}</tbody></table></div>`:'<p class="mini">Nenhuma mensagem enviada ainda.</p>'}</details>`;
   const tecHtml=tec.length?`<details class="cob-det"><summary>Paradas por motivo técnico <span class="tag nulo">${tec.length}</span></summary><p class="mini">Nada disso chegou a ser enviado. Voltam sozinhas para a fila (as de conversa em andamento, depois do intervalo da régua).</p><div class="rolagem"><table class="comparativo tts-compacta">${cabEnvio}<tbody>${tec.map(linhaEnvio).join('')}</tbody></table></div></details>`:'';
   const supHtml=sup.length?`<details class="cob-det"><summary>Fora da régua <span class="tag nulo">${sup.length}</span></summary><div class="cob-lista">${sup.map(s=>`<div class="cob-item"><div class="cob-item-top">${todas?tagM(s.marca):''}<strong>${s.username?'@'+esc(s.username):'criador'}</strong><span class="mini">${esc(s.motivo)} · ${dt(s.registrado_em)}</span></div><div class="cob-acoes">${botao('Devolver à régua',`data-cob="reativar" data-marca="${esc(s.marca)}" data-open="${esc(s.creator_open_id)}"`)}</div></div>`).join('')}</div></details>`:'';
   host.innerHTML=`<div class="cob-estado">${estadoMarca}</div>
    ${aviso?`<div class="nota" role="status" aria-live="polite">${esc(aviso)}</div>`:''}${pode?'':'<div class="nota">Esta chave só lê. Aprovar mensagens e resolver pendências pedem a chave de gestão de Influs.</div>'}
    ${pendHtml}
    <div class="painel-cab cob-cab"><h3>Mensagens da régua</h3><span class="mini">cada toque só sai com o texto aprovado; mudou o texto, precisa aprovar de novo</span></div>
    <div class="cob-modelos">${porEtapa||'<div class="vazio">Nenhuma mensagem cadastrada.</div>'}</div>
    ${simHtml}${saiuHtml}${tecHtml}${supHtml}
    <details class="ressalvas"><summary>Como o robô decide</summary><ul>
     <li>Roda em dias úteis às 13h20. Em simulação, só mostra o que faria; em envio ligado, manda até o teto do dia, uma pessoa por vez.</li>
     <li>Antes de cada mensagem, lê a conversa inteira no TikTok. Se o criador respondeu (em qualquer época), tem mensagem sem ler ou alguém falou nos últimos 7 dias, não manda e a pessoa aparece em "Precisa de você".</li>
     <li>Se a TikTok não confirmar um envio, a marca para até você conferir no Seller Center. Nada é reenviado sozinho.</li>
     <li>Uma etapa por pessoa, com o intervalo da régua entre toques; o toque seguinte só depois de o anterior ter saído.</li>
     <li>"Enviada" quer dizer que a TikTok aceitou a mensagem, não que o criador leu.</li></ul></details>`;
   ligar();
  }
  function ligar(){
   host.querySelectorAll('[data-cob]').forEach(b=>b.onclick=()=>{
    const a=b.dataset.cob,d=b.dataset;
    if(a==='recarregar')return carregar();
    if(a==='editar'){editando=d.k;aviso='';return paint();}
    if(a==='cancelar'){editando=null;return paint();}
    const arma=(rot,fn)=>{if(b.dataset.armado!=='1'){b.dataset.armado='1';b.dataset.rot=b.textContent;b.textContent=rot;setTimeout(()=>{if(b.isConnected&&b.dataset.armado==='1'){b.dataset.armado='';b.textContent=b.dataset.rot;}},6000);return;}b.dataset.armado='';fn();};
    const modelo={marca:d.marca,etapa:d.etapa,tentativa:Number(d.tentativa),esperado:d.esperado};
    if(a==='salvar'){const t=b.closest('.cob-modelo').querySelector('.cob-texto').value;return arma('Aprovar este texto?',()=>escreve('modelo_salvar',{...modelo,texto:t}));}
    if(a==='aprovar'){const m=dados.modelos.find(x=>x.marca===d.marca&&x.etapa===d.etapa&&String(x.tentativa)===d.tentativa);return arma('Aprovar?',()=>escreve('modelo_salvar',{...modelo,texto:m.texto}));}
    if(a==='revogar')return arma('Retirar?',()=>escreve('modelo_revogar',modelo));
    if(a==='resolver'){const rot={liberar:'Devolver?',suprimir:'Tirar da régua?',chegou:'Confirmar que chegou?',nao_chegou:'Confirmar que não chegou?'}[d.decisao];
     return arma(rot,()=>escreve('resolver',{marca:d.marca,etapa:d.etapa,username:d.username,tentativa:Number(d.tentativa),estado:d.estado,decisao:d.decisao}));}
    if(a==='reativar')return arma('Devolver?',()=>escreve('reativar',{marca:d.marca,creator_open_id:d.open}));
   });
  }
  return {
   mount(el){host=el;if((!dados||chave!==key())&&!busy)carregar();else paint();},
   carregar,paint,
   pronta:m=>!!dados?.regras?.find(g=>g.marca===m)?.pronta,
   dados:()=>dados,
  };
 }
 root.TTSCobranca={create,motivo};
})(typeof window!=='undefined'?window:globalThis);
if(typeof module!=='undefined'&&module.exports)module.exports=globalThis.TTSCobranca;
