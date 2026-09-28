/* Candidaturas do site (27–28/09/2026): o que o candidato mandou pela LP "Seja um Parceiro" e a decisão.
   - Para analisar: Aprovar (cria cupom na Shopify + link de parceiro + cadastro em Influs, num clique) ou Recusar.
   - Aprovados: cupom, link e envio do produto (pendente → enviado com rastreio).
   A regra mora no servidor (partner-aprovacao.sql + workflow). Prints carregam sob demanda e ficam só na memória. */
(function(root){'use strict';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const BRANDS={aristo:'O Aristocrata',fish:'Fishermans'};
 const ESTADO={novo:['nova','alerta'],em_analise:['em análise','neutro'],aprovado_piloto:['aprovada','bom'],pausado:['pausada','nulo'],recusado:['recusada','nulo']};
 const ABERTA=['novo','em_analise'];
 const nf=n=>n==null?'—':Number(n).toLocaleString('pt-BR');
 const rf=n=>n==null?'—':Number(n).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
 const pc=n=>n==null?'—':(Math.round(Number(n)*1000)/10).toLocaleString('pt-BR')+'%';
 const dt=v=>{const d=new Date(v);return isNaN(d)?'—':d.toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'});};
 const curto=v=>{const d=new Date(v);return isNaN(d)?'—':d.toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});};
 const handleOk=h=>/^[a-z0-9._]{1,30}$/.test(String(h||''));
 // Mesma regra do servidor (crm_partner_codigo_sugerido_v1): só letras e números, maiúsculo, até 20.
 const sugerido=ig=>String(ig||'').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^A-Za-z0-9]/g,'').toUpperCase().slice(0,20);
 const uuid=()=>root.crypto&&root.crypto.randomUUID?root.crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g,()=>Math.floor(Math.random()*16).toString(16));
 function create({document,endpoint,key,getMarca,fetchImpl,aprovacaoEndpoint,chaveEscrita,piloto}){
  let dados=null,apr=null,erro='',busy=false,host=null,filtro='abertas',aberto=null,aviso=null;const imgs=new Map(),pedidos=new Map(),salvando=new Set();
  const f=()=>fetchImpl||root.fetch.bind(root);
  const pil=()=>(piloto&&piloto())||{};
  async function post(url,corpo,k){
   if(!k)throw Error('Entre com a chave do painel.');
   const r=await f()(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...corpo,k}),credentials:'omit',redirect:'error',cache:'no-store'});
   let j;try{j=await r.json();}catch(_){throw Error('Resposta não confirmada.');}
   if(!r.ok||!j||j.erro){const e=Error(j?.erro||'Não foi possível carregar.');e.campo=j?.campo;throw e;}return j;
  }
  const call=corpo=>post(endpoint(),corpo,key());
  const callApr=(corpo,escrita)=>post(aprovacaoEndpoint(),corpo,escrita?(chaveEscrita||key)():key());
  async function carregar(){if(busy)return;busy=true;erro='';paint();
   try{const [c,a]=await Promise.all([call({acao:'ler'}),aprovacaoEndpoint?callApr({acao:'ler'}).catch(()=>null):null]);dados=c;apr=a;}catch(e){erro=e.message;}finally{busy=false;paint();}}
  async function prints(app){
   for(const p of app.prints){if(imgs.has(p.id))continue;imgs.set(p.id,'carregando');paint();
    try{const j=await call({acao:'print',id:p.id});imgs.set(p.id,/^image\/(jpeg|png|webp)$/.test(j.mime)&&/^[A-Za-z0-9+/=]+$/.test(j.base64)?`data:${j.mime};base64,${j.base64}`:'erro');}catch(_){imgs.set(p.id,'erro');}
    paint();}
  }
  // Estado mais novo que existir: o do cadastro do piloto (atualiza na hora depois de salvar) vence o da última leitura.
  const cadastro=id=>(pil().candidates||[]).find(c=>c.id===id);
  const estadoDe=a=>cadastro(a.candidate_id)?.state||a.estado;
  const parceiroDe=a=>(apr?.parceiros||[]).find(p=>p.candidate_id===a.candidate_id);
  const descontoDe=m=>apr?.descontos?.[m];

  function capa(a){
   const p1=a.prints[0],s1=p1?imgs.get(p1.id):null,n=a.prints.length;
   if(!p1)return '<span class="pc-foto pc-foto-vazia">sem print</span>';
   return `<button type="button" class="pc-foto${s1&&s1.startsWith('data:')?'':' pc-foto-vazia'}" data-pc="prints" title="Ver ${n>1?`os ${n} prints`:'o print'} das estatísticas">${s1&&s1.startsWith('data:')?`<img src="${s1}" alt="Print 1 de ${esc(a.nome)}">`:`<span${s1==='carregando'?' class="pc-carregando" aria-label="carregando"':''}>${s1==='carregando'?'':s1==='erro'?'não abriu':'ver print'}</span>`}${n>1?`<span class="pc-n">${n}</span>`:''}</button>`;
  }
  function numeros(a){
   const TIT_CPM='CPM = preço declarado ÷ views declaradas × 1.000';
   const num=(rotulo,v,extra)=>`<div class="pc-num"><span>${rotulo}</span><strong class="tabn">${nf(v)}</strong>${extra||''}</div>`;
   const rc=n=>n==null?'—':Number(n).toLocaleString('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:Number(n)%1?2:0});
   const midia=(rotulo,v,preco,cpm)=>v?num(rotulo,v,preco!=null&&cpm!=null?`<em title="${TIT_CPM}. Cobra ${rf(preco)} por ${rotulo}.">CPM ${rf(cpm)}</em><small>cobra ${rc(preco)}</small>`:'<em class="pc-sem" title="Não informou preço, então não há CPM">sem preço</em>'):'';
   return `<div class="pc-nums">${num('seguidores',a.seguidores)}${midia('story',a.views_stories,a.preco_story,a.cpm_story)}${midia('reels',a.views_reels,a.preco_reels,a.cpm_reels)}</div>`;
  }
  // Parceiro aprovado: cupom, link e envio no lugar dos números.
  function funcionando(p){
   const envio=p.encerrado_em?`<span class="tag nulo" title="Encerrada por ${esc(p.encerrado_por||'—')} em ${dt(p.encerrado_em)}. Link desligado e comissão zerada; o cupom segue ativo e as vendas continuam em Influs.">parceria encerrada ${curto(p.encerrado_em).split(',')[0]}</span>`
    :p.envio_estado==='enviado'
    ?`<span class="tag bom" title="Enviado em ${dt(p.envio_em)}${p.envio_rastreio?' · rastreio '+esc(p.envio_rastreio):''}">produto enviado${p.envio_rastreio?' · '+esc(p.envio_rastreio):''}</span>`
    :'<span class="tag alerta">envio pendente</span>';
   return `<div class="pc-ok">
    <div class="pc-ok-item"><span>cupom</span><button type="button" class="pc-copia" data-pc="copiar" data-v="${esc(p.cupom)}" title="Copiar cupom">${esc(p.cupom)}</button><small>${pc(p.desconto)} para quem compra</small></div>
    <div class="pc-ok-item pc-ok-link"><span>link</span><button type="button" class="pc-copia" data-pc="copiar" data-v="${esc(p.url||'')}" title="${esc(p.url||'link indisponível')}">${esc(p.ref)}</button><small>${p.link_estado==='ativo'?'ativo':p.link_estado==='revogado'?'desligado':esc(p.link_estado||'—')}</small></div>
    <div class="pc-ok-item"><span>${p.encerrado_em?'parceria':'envio'}</span>${envio}</div></div>`;
  }
  function acoes(a,est,p){
   const zap=/^\d{12,13}$/.test(a.whatsapp)?`<a class="btn sec pc-btn" href="https://wa.me/${esc(a.whatsapp)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>`:'';
   const mail=`<a class="btn sec pc-btn" href="mailto:${esc(a.email)}">E-mail</a>`;
   if(p){
    const msg=encodeURIComponent(`Oi, ${String(a.nome||'').split(' ')[0]}! Sua parceria com ${BRANDS[a.marca]||''} foi aprovada.\n\nSeu cupom: ${p.cupom} (${pc(p.desconto)} de desconto para quem compra)\nSeu link: ${p.url||''}\n\nCada venda com o cupom ou pelo link rende 5% para você, pago todo dia 5 via Pix.`);
    const zapMsg=/^\d{12,13}$/.test(a.whatsapp)?`<a class="btn sec pc-btn" href="https://wa.me/${esc(a.whatsapp)}?text=${msg}" target="_blank" rel="noopener noreferrer" title="Abre o WhatsApp com a mensagem pronta; você confere e envia">Mandar cupom e link</a>`:'';
    if(p.encerrado_em)return `<div class="pc-acoes">${zap}${mail}</div>`;
    return `<div class="pc-acoes">${zapMsg}${p.envio_estado==='enviado'?'<button type="button" class="btn sec pc-btn" data-pc="envio-desfaz">Envio pendente</button>':'<button type="button" class="btn pc-btn" data-pc="envio">Marcar enviado</button>'}<button type="button" class="btn sec pc-btn pc-recusa" data-pc="encerrar" title="Desliga o link e zera a comissão a partir de hoje. O cupom segue ativo.">Encerrar</button></div>`;
   }
   if(!ABERTA.includes(est))return `<div class="pc-acoes">${zap}${mail}</div>`;
   return `<div class="pc-acoes">${zap}${mail}<button type="button" class="btn sec pc-btn pc-recusa" data-pc="recusar">Recusar</button><button type="button" class="btn pc-btn" data-pc="aprovar">Aprovar</button></div>`;
  }
  // Painel que abre embaixo da linha: aprovação, recusa ou envio.
  function gaveta(a,p){
   if(!aberto||aberto.id!==a.id)return '';
   const ocupado=salvando.has(a.id),msg=aviso&&aviso.id===a.id?`<p class="pc-aviso ${aviso.ok?'bom':'ruim'}" role="status">${esc(aviso.texto)}</p>`:'';
   if(aberto.modo==='aprovar'){
    const d=descontoDe(a.marca),cod=aberto.codigo??sugerido(a.instagram||a.tiktok||a.nome);
    return `<div class="pc-gaveta" data-gaveta="aprovar">
     <label class="pc-campo">Cupom do parceiro<input name="codigo" value="${esc(cod)}" maxlength="30" autocomplete="off" spellcheck="false" autocapitalize="characters" ${aviso&&aviso.id===a.id&&aviso.campo==='codigo'?'aria-invalid="true"':''}></label>
     <ul class="pc-resumo"><li><strong>${d!=null?pc(d):'—'}</strong> de desconto para quem compra, todos os produtos</li><li><strong>5%</strong> de comissão por venda com o cupom ou pelo link</li><li>Cria o cupom na Shopify ${esc(BRANDS[a.marca]||'')}, o link de parceiro e o cadastro em Influs</li></ul>
     ${msg}<div class="pc-gaveta-acoes"><button type="button" class="btn sec pc-btn" data-pc="fechar">Cancelar</button><button type="button" class="btn pc-btn" data-pc="confirma-aprovar" ${ocupado?'disabled':''}>${ocupado?'Criando cupom e link…':'Aprovar e criar cupom'}</button></div></div>`;
   }
   if(aberto.modo==='recusar')return `<div class="pc-gaveta" data-gaveta="recusar"><p>Recusar a candidatura de <strong>${esc(a.nome)}</strong>? Ela sai de "Para analisar" e fica em "Todas".</p>${msg}
     <div class="pc-gaveta-acoes"><button type="button" class="btn sec pc-btn" data-pc="fechar">Cancelar</button><button type="button" class="btn pc-btn pc-perigo" data-pc="confirma-recusar" ${ocupado?'disabled':''}>${ocupado?'Recusando…':'Recusar candidatura'}</button></div></div>`;
   if(aberto.modo==='encerrar')return `<div class="pc-gaveta" data-gaveta="encerrar"><p>Encerrar a parceria com <strong>${esc(a.nome)}</strong>? O link para de contar e a comissão fica zerada a partir de hoje. O cupom <strong>${esc(p?.cupom||'')}</strong> continua ativo e as vendas seguem aparecendo em Influs.</p>${msg}
     <div class="pc-gaveta-acoes"><button type="button" class="btn sec pc-btn" data-pc="fechar">Cancelar</button><button type="button" class="btn pc-btn pc-perigo" data-pc="confirma-encerrar" ${ocupado?'disabled':''}>${ocupado?'Encerrando…':'Encerrar parceria'}</button></div></div>`;
   if(aberto.modo==='envio')return `<div class="pc-gaveta" data-gaveta="envio"><label class="pc-campo">Código de rastreio (opcional)<input name="rastreio" maxlength="80" autocomplete="off" spellcheck="false" value="${esc(p?.envio_rastreio||'')}"></label>${msg}
     <div class="pc-gaveta-acoes"><button type="button" class="btn sec pc-btn" data-pc="fechar">Cancelar</button><button type="button" class="btn pc-btn" data-pc="confirma-envio" ${ocupado?'disabled':''}>${ocupado?'Salvando…':'Marcar produto enviado'}</button></div></div>`;
   return msg?`<div class="pc-gaveta">${msg}</div>`:'';
  }
  // Uma candidatura por linha: foto do print, quem é, números (ou cupom/link/envio), ações. Ressalvas ficam no title.
  function cartao(a,todas){
   const est=estadoDe(a),p=parceiroDe(a),[rot,cls]=ESTADO[est]||[est||'—','nulo'];
   const ig=handleOk(a.instagram)?`<a href="https://instagram.com/${esc(a.instagram)}" target="_blank" rel="noopener noreferrer">@${esc(a.instagram)}</a>`:'';
   const tt=handleOk(a.tiktok)?`<a href="https://www.tiktok.com/@${esc(a.tiktok)}" target="_blank" rel="noopener noreferrer">TikTok @${esc(a.tiktok)}</a>`:'';
   const sub=[esc([a.cidade,a.uf].filter(Boolean).join('/')),esc(a.nicho||'')].filter(Boolean).map(x=>`<span>${x}</span>`).join('');
   return `<article class="pc-card${p?' pc-aprovado':''}${aberto&&aberto.id===a.id?' pc-aberto':''}" data-id="${esc(a.id)}">
    ${capa(a)}
    <div class="pc-quem">
     <div class="pc-meta">${todas?`<span class="pc-marca">${esc(BRANDS[a.marca]||a.marca)}</span>`:''}<span class="tag ${cls}">${esc(rot)}</span><span class="tag bom" title="Aceitou o termo v${esc(a.termo_versao)} em ${dt(a.aceite_em)}">termo v${esc(a.termo_versao)}</span><span class="mini" title="Enviada em ${dt(a.criado_em)}">${curto(a.criado_em)}</span></div>
     <h3>${esc(a.nome)}</h3>
     <div class="pc-perfis">${[ig,tt].filter(Boolean).join('<i>·</i>')||'<span class="mini">sem perfil válido</span>'}</div>
     <div class="pc-sub mini">${sub}</div>
     ${a.mensagem?`<details class="pc-msg"><summary>“${esc(String(a.mensagem).slice(0,90))}${String(a.mensagem).length>90?'…':''}”</summary><p>${esc(a.mensagem)}</p></details>`:''}
    </div>
    ${p?funcionando(p):numeros(a)}
    ${acoes(a,est,p)}
    ${gaveta(a,p)}
   </article>`;
  }
  // Visualizador dos prints (data: não abre em aba nova no Chrome, por isso fica na própria página).
  function visor(app){
   const d=document.createElement('div');d.className='pc-visor';d.setAttribute('role','dialog');d.setAttribute('aria-label',`Prints de ${app.nome}`);
   const fotos=app.prints.map(p=>{const s=imgs.get(p.id);return s&&s.startsWith('data:')?`<img src="${s}" alt="Print ${p.ordem} de ${esc(app.nome)}">`:`<span class="pc-foto-vazia">${s==='erro'?'não abriu':'carregando…'}</span>`;}).join('');
   d.innerHTML=`<div class="pc-visor-caixa"><div class="pc-visor-cab"><strong>${esc(app.nome)}</strong><button type="button" class="btn sec" data-fechar>Fechar</button></div><div class="pc-visor-fotos">${fotos}</div></div>`;
   const fechar=()=>{d.remove();document.removeEventListener('keydown',esc_);};const esc_=e=>{if(e.key==='Escape')fechar();};
   d.addEventListener('click',e=>{if(e.target===d||e.target.closest('[data-fechar]'))fechar();});document.addEventListener('keydown',esc_);
   document.querySelector('.pc-visor')?.remove();(document.body||document.documentElement).appendChild(d);d.querySelector('[data-fechar]').focus?.();
  }
  // Capa: só o primeiro print das candidaturas em análise, até 12, três por vez. Fica só na memória.
  async function capas(lista){const fila=lista.slice(0,12).filter(a=>a.prints[0]&&!imgs.has(a.prints[0].id));
   const um=async()=>{for(let a=fila.shift();a;a=fila.shift())await prints({...a,prints:[a.prints[0]]});};await Promise.all([um(),um(),um()]);}
  function paint(){
   if(!host)return;
   if(!dados){host.innerHTML=erro?`<div class="vazio">${esc(erro)} <button class="btn sec" data-pc="recarregar">Tentar de novo</button></div>`:'<div class="vazio">Carregando candidaturas…</div>';ligar();return;}
   const m=getMarca(),todas=m==='todas',todasApps=(dados.candidaturas||[]).filter(a=>todas||a.marca===m);
   const abertas=todasApps.filter(a=>ABERTA.includes(estadoDe(a))&&!parceiroDe(a)),aprovados=todasApps.filter(a=>parceiroDe(a)&&!parceiroDe(a).encerrado_em);
   const pendentes=aprovados.filter(a=>parceiroDe(a).envio_estado!=='enviado').length;
   const lista=filtro==='abertas'?abertas:filtro==='aprovados'?aprovados:todasApps;
   const termo=(dados.termos||[]).filter(t=>(todas||t.marca===m)&&t.publicado_em&&!t.retirado_em);
   const fechadas=(todas?['aristo','fish']:[m]).filter(b=>!termo.some(t=>t.marca===b));
   const aba=(id,rot,n,extra)=>`<button type="button" data-pc="filtro" data-f="${id}" class="${filtro===id?'ativo':''}" aria-pressed="${filtro===id}">${rot} <span class="pc-cont">${n}</span>${extra||''}</button>`;
   const vazio={abertas:'Nenhuma candidatura esperando análise.',aprovados:'Nenhum parceiro aprovado pelo painel ainda.',todas:'Nenhuma candidatura recebida pelo site ainda.'}[filtro];
   host.innerHTML=`<section class="painel pc"><div class="painel-cab"><h2>Candidaturas do site</h2>
     ${fechadas.length?`<span class="tag alerta" title="Sem termo publicado o formulário da LP não aceita envio">formulário fechado em ${fechadas.map(b=>BRANDS[b]).join(' e ')}</span>`:`<span class="tag bom" title="${esc(termo.map(t=>`${BRANDS[t.marca]||t.marca}: termo v${t.versao}`).join(' · '))}">formulário aberto</span>`}</div>
    <div class="pc-filtro" role="group" aria-label="Quais candidaturas">${aba('abertas','Para analisar',abertas.length)}${aba('aprovados','Aprovados',aprovados.length,pendentes?`<span class="pc-ponto" title="${pendentes} com envio pendente">${pendentes} envio</span>`:'')}${aba('todas','Todas',todasApps.length)}</div>
    ${apr===null&&aprovacaoEndpoint?'<p class="mini pc-nota">Cupom, link e envio dos aprovados não carregaram agora. <button type="button" class="pc-link" data-pc="recarregar">Tentar de novo</button></p>':''}
    <div class="pc-lista">${lista.map(a=>cartao(a,todas)).join('')||`<div class="vazio">${vazio}</div>`}</div></section>`;
   ligar();capas(lista.filter(a=>ABERTA.includes(estadoDe(a))));
   const inp=aberto&&host.querySelector(`.pc-card[data-id="${CSS.escape(aberto.id)}"] .pc-gaveta input`);if(inp&&aberto.foco){inp.focus();aberto.foco=false;}
  }
  const texto=(id,t,ok,campo)=>{aviso={id,texto:t,ok,campo};};
  async function aprovar(a){
   const inp=host.querySelector(`.pc-card[data-id="${CSS.escape(a.id)}"] input[name=codigo]`);const cod=sugerido(inp?.value||'');aberto.codigo=cod;
   if(cod.length<3){texto(a.id,'Cupom: pelo menos 3 letras ou números.',false,'codigo');return paint();}
   // Mesmo pedido enquanto o código não muda: repetir depois de erro não cria dois cupons.
   let pd=pedidos.get(a.id);if(!pd||pd.codigo!==cod){pd={id:uuid(),codigo:cod};pedidos.set(a.id,pd);}
   salvando.add(a.id);aviso=null;paint();
   try{const r=await callApr({acao:'aprovar',request_id:pd.id,data:{candidate_id:a.candidate_id,codigo:cod}},true);
    pedidos.delete(a.id);aberto=null;texto(a.id,r.mensagem||'Parceiro aprovado.',true);filtro='aprovados';
    await carregar();if(piloto&&pil().reload)pil().reload();
   }catch(e){texto(a.id,e.message,false,e.campo);}
   finally{salvando.delete(a.id);paint();}
  }
  async function recusar(a){
   const c=cadastro(a.candidate_id),P=pil();
   if(!c||!P.save){texto(a.id,'Cadastro do candidato ainda não carregou. Atualize a página e tente de novo.',false);return paint();}
   salvando.add(a.id);aviso=null;paint();
   try{await P.save('candidato',{id:c.id,marca:c.marca,name:c.name,handle:c.handle||'',source:c.source,source_reference:c.source_reference||'',state:'recusado',note:c.note||''},c.version);}catch(_){}
   salvando.delete(a.id);
   if(estadoDe(a)==='recusado'){aberto=null;texto(a.id,'Candidatura recusada.',true);await carregar();}
   else{const st=document.querySelector('[data-pilot-status]')?.textContent?.trim();texto(a.id,st&&!/^Salvando/.test(st)?st:'Não foi possível recusar agora. Confira a chave de gestão e tente de novo.',false);paint();}
  }
  async function envio(a,estado){
   const inp=host.querySelector(`.pc-card[data-id="${CSS.escape(a.id)}"] input[name=rastreio]`);
   salvando.add(a.id);aviso=null;paint();
   try{await callApr({acao:'envio',data:{candidate_id:a.candidate_id,estado,rastreio:estado==='enviado'?(inp?.value||'').trim():''}},true);aberto=null;await carregar();}
   catch(e){texto(a.id,e.message,false);}finally{salvando.delete(a.id);paint();}
  }
  async function encerrar(a){
   salvando.add(a.id);aviso=null;paint();
   try{const r=await callApr({acao:'encerrar',data:{candidate_id:a.candidate_id}},true);aberto=null;texto(a.id,r.mensagem||'Parceria encerrada.',true);await carregar();if(piloto&&pil().reload)pil().reload();}
   catch(e){texto(a.id,e.message,false);}finally{salvando.delete(a.id);paint();}
  }
  function ligar(){
   host.querySelectorAll('[data-pc]').forEach(b=>b.onclick=()=>{const acao=b.dataset.pc;
    if(acao==='recarregar')return carregar();
    if(acao==='filtro'){filtro=b.dataset.f;aberto=null;aviso=null;return paint();}
    if(acao==='copiar'){const v=b.dataset.v;if(v&&root.navigator?.clipboard)root.navigator.clipboard.writeText(v).then(()=>{b.classList.add('copiado');setTimeout(()=>b.classList.remove('copiado'),1200);},()=>{});return;}
    const app=(dados?.candidaturas||[]).find(x=>x.id===b.closest('.pc-card')?.dataset.id);if(!app)return;
    if(acao==='prints'){visor(app);return prints(app).then(()=>{if(document.querySelector('.pc-visor'))visor(app);});}
    if(acao==='aprovar'||acao==='recusar'||acao==='envio'||acao==='encerrar'){aberto={id:app.id,modo:acao,foco:acao==='aprovar'||acao==='envio'};aviso=null;return paint();}
    if(acao==='fechar'){aberto=null;aviso=null;return paint();}
    if(acao==='confirma-aprovar')return aprovar(app);
    if(acao==='confirma-recusar')return recusar(app);
    if(acao==='confirma-envio')return envio(app,'enviado');
    if(acao==='confirma-encerrar')return encerrar(app);
    if(acao==='envio-desfaz')return envio(app,'pendente');
   });
   host.querySelectorAll('.pc-gaveta input').forEach(i=>i.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();i.closest('.pc-gaveta').querySelector('[data-pc^=confirma]')?.click();}if(e.key==='Escape'){aberto=null;aviso=null;paint();}});
  }
  // Remontar: o estado vem do cadastro do piloto na hora. Se o piloto recarregou (lista nova), relê as candidaturas também.
  let ultimos=null;
  return {mount(el){host=el;const cs=pil().candidates||null,mudou=!!(cs&&ultimos&&cs!==ultimos);ultimos=cs||ultimos;
    if(!dados&&!busy)carregar();else{paint();if(mudou&&!busy)carregar();}},carregar,paint,dados:()=>dados,sugerido};
 }
 root.PartnerCandidaturas={create,sugerido};
})(typeof window!=='undefined'?window:globalThis);
if(typeof module!=='undefined'&&module.exports)module.exports=globalThis.PartnerCandidaturas;
