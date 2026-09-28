/* Candidaturas do site (27/09/2026): o que o candidato mandou pela LP "Seja um Parceiro", com números
   declarados, CPM estimado, prints e o aceite do termo. A análise e a decisão continuam no cadastro do
   candidato (aba Parceiros); aqui é só leitura. Prints carregam sob demanda e não ficam guardados no navegador. */
(function(root){'use strict';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const BRANDS={aristo:'O Aristocrata',fish:'Fishermans'};
 const ESTADO={novo:['nova','alerta'],em_analise:['em análise','neutro'],aprovado_piloto:['aprovada','bom'],pausado:['pausada','nulo'],recusado:['recusada','nulo']};
 const nf=n=>n==null?'—':Number(n).toLocaleString('pt-BR');
 const rf=n=>n==null?'—':Number(n).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
 const dt=v=>{const d=new Date(v);return isNaN(d)?'—':d.toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'});};
 const curto=v=>{const d=new Date(v);return isNaN(d)?'—':d.toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});};
 const handleOk=h=>/^[a-z0-9._]{1,30}$/.test(String(h||''));
 function create({document,endpoint,key,getMarca,fetchImpl}){
  let dados=null,erro='',busy=false,host=null,filtro='abertas';const imgs=new Map();
  const f=()=>fetchImpl||root.fetch.bind(root);
  async function call(corpo){
   const k=key();if(!k)throw Error('Entre com a chave do painel.');
   const r=await f()(endpoint(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...corpo,k}),credentials:'omit',redirect:'error',cache:'no-store'});
   let j;try{j=await r.json();}catch(_){throw Error('Resposta não confirmada.');}
   if(!r.ok||!j||j.erro)throw Error(j?.erro||'Não foi possível carregar.');return j;
  }
  async function carregar(){if(busy)return;busy=true;erro='';paint();try{dados=await call({acao:'ler'});}catch(e){erro=e.message;}finally{busy=false;paint();}}
  async function prints(app){
   for(const p of app.prints){if(imgs.has(p.id))continue;imgs.set(p.id,'carregando');paint();
    try{const j=await call({acao:'print',id:p.id});imgs.set(p.id,/^image\/(jpeg|png|webp)$/.test(j.mime)&&/^[A-Za-z0-9+/=]+$/.test(j.base64)?`data:${j.mime};base64,${j.base64}`:'erro');}catch(_){imgs.set(p.id,'erro');}
    paint();}
  }
  // Uma candidatura por linha: foto do print, quem é, números declarados, ações. Ressalvas ficam no title.
  function cartao(a,todas){
   const [rot,cls]=ESTADO[a.estado]||[a.estado||'—','nulo'];
   const ig=handleOk(a.instagram)?`<a href="https://instagram.com/${esc(a.instagram)}" target="_blank" rel="noopener noreferrer">@${esc(a.instagram)}</a>`:'';
   const tt=handleOk(a.tiktok)?`<a href="https://www.tiktok.com/@${esc(a.tiktok)}" target="_blank" rel="noopener noreferrer">TikTok @${esc(a.tiktok)}</a>`:'';
   const zap=/^\d{12,13}$/.test(a.whatsapp)?`<a class="btn sec pc-btn" href="https://wa.me/${esc(a.whatsapp)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>`:'';
   const TIT_CPM='CPM = preço declarado ÷ views declaradas × 1.000';
   const num=(rotulo,v,extra)=>`<div class="pc-num"><span>${rotulo}</span><strong class="tabn">${nf(v)}</strong>${extra||''}</div>`;
   const rc=n=>n==null?'—':Number(n).toLocaleString('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:Number(n)%1?2:0});
   const midia=(rotulo,v,preco,cpm)=>v?num(rotulo,v,preco!=null&&cpm!=null?`<em title="${TIT_CPM}. Cobra ${rf(preco)} por ${rotulo}.">CPM ${rf(cpm)}</em><small>cobra ${rc(preco)}</small>`:'<em class="pc-sem" title="Não informou preço, então não há CPM">sem preço</em>'):'';
   const p1=a.prints[0],s1=p1?imgs.get(p1.id):null,n=a.prints.length;
   const capa=!p1?'<span class="pc-foto pc-foto-vazia">sem print</span>'
    :`<button type="button" class="pc-foto${s1&&s1.startsWith('data:')?'':' pc-foto-vazia'}" data-pc="prints" title="Ver ${n>1?`os ${n} prints`:'o print'} das estatísticas">${s1&&s1.startsWith('data:')?`<img src="${s1}" alt="Print 1 de ${esc(a.nome)}">`:`<span${s1==='carregando'?' class="pc-carregando" aria-label="carregando"':''}>${s1==='carregando'?'':s1==='erro'?'não abriu':'ver print'}</span>`}${n>1?`<span class="pc-n">${n}</span>`:''}</button>`;
   const sub=[esc([a.cidade,a.uf].filter(Boolean).join('/')),esc(a.nicho||'')].filter(Boolean).map(x=>`<span>${x}</span>`).join('');
   return `<article class="pc-card" data-id="${esc(a.id)}">
    ${capa}
    <div class="pc-quem">
     <div class="pc-meta">${todas?`<span class="pc-marca">${esc(BRANDS[a.marca]||a.marca)}</span>`:''}<span class="tag ${cls}">${esc(rot)}</span><span class="tag bom" title="Aceitou o termo v${esc(a.termo_versao)} em ${dt(a.aceite_em)}">termo v${esc(a.termo_versao)}</span><span class="mini" title="Enviada em ${dt(a.criado_em)}">${curto(a.criado_em)}</span></div>
     <h3>${esc(a.nome)}</h3>
     <div class="pc-perfis">${[ig,tt].filter(Boolean).join('<i>·</i>')||'<span class="mini">sem perfil válido</span>'}</div>
     <div class="pc-sub mini">${sub}</div>
     ${a.mensagem?`<details class="pc-msg"><summary>“${esc(String(a.mensagem).slice(0,90))}${String(a.mensagem).length>90?'…':''}”</summary><p>${esc(a.mensagem)}</p></details>`:''}
    </div>
    <div class="pc-nums">${num('seguidores',a.seguidores)}${midia('story',a.views_stories,a.preco_story,a.cpm_story)}${midia('reels',a.views_reels,a.preco_reels,a.cpm_reels)}</div>
    <div class="pc-acoes">${zap}<a class="btn sec pc-btn" href="mailto:${esc(a.email)}">E-mail</a><button type="button" class="btn pc-btn" data-pc="abrir" data-cid="${esc(a.candidate_id)}">Analisar</button></div>
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
  // Capa: só o primeiro print das candidaturas em análise, até 12, uma de cada vez. Fica só na memória.
  async function capas(lista){const fila=lista.slice(0,12).filter(a=>a.prints[0]&&!imgs.has(a.prints[0].id));
   const um=async()=>{for(let a=fila.shift();a;a=fila.shift())await prints({...a,prints:[a.prints[0]]});};await Promise.all([um(),um(),um()]);}
  function paint(){
   if(!host)return;
   if(!dados){host.innerHTML=erro?`<div class="vazio">${esc(erro)} <button class="btn sec" data-pc="recarregar">Tentar de novo</button></div>`:'<div class="vazio">Carregando candidaturas…</div>';ligar();return;}
   const m=getMarca(),todas=m==='todas',todasApps=(dados.candidaturas||[]).filter(a=>todas||a.marca===m);
   const abertas=todasApps.filter(a=>['novo','em_analise'].includes(a.estado)),lista=filtro==='abertas'?abertas:todasApps;
   const termo=(dados.termos||[]).filter(t=>(todas||t.marca===m)&&t.publicado_em&&!t.retirado_em);
   const fechadas=(todas?['aristo','fish']:[m]).filter(b=>!termo.some(t=>t.marca===b));
   host.innerHTML=`<section class="painel pc"><div class="painel-cab"><h2>Candidaturas do site <span class="tag ${abertas.length?'alerta':'nulo'}">${abertas.length}</span></h2>
     ${fechadas.length?`<span class="tag alerta" title="Sem termo publicado o formulário da LP não aceita envio">formulário fechado em ${fechadas.map(b=>BRANDS[b]).join(' e ')}</span>`:`<span class="tag bom" title="${esc(termo.map(t=>`${BRANDS[t.marca]||t.marca}: termo v${t.versao}`).join(' · '))}">formulário aberto</span>`}</div>
    <div class="pc-filtro" role="group" aria-label="Quais candidaturas"><button type="button" data-pc="filtro" data-f="abertas" class="${filtro==='abertas'?'ativo':''}">Para analisar (${abertas.length})</button><button type="button" data-pc="filtro" data-f="todas" class="${filtro==='todas'?'ativo':''}">Todas (${todasApps.length})</button></div>
    <div class="pc-lista">${lista.map(a=>cartao(a,todas)).join('')||`<div class="vazio">${filtro==='abertas'?'Nenhuma candidatura esperando análise.':'Nenhuma candidatura recebida pelo site ainda.'}</div>`}</div></section>`;
   ligar();capas(lista.filter(a=>['novo','em_analise'].includes(a.estado)));
  }
  function ligar(){
   host.querySelectorAll('[data-pc]').forEach(b=>b.onclick=()=>{const a=b.dataset.pc;
    if(a==='recarregar')return carregar();
    if(a==='filtro'){filtro=b.dataset.f;return paint();}
    const app=(dados?.candidaturas||[]).find(x=>x.id===b.closest('.pc-card')?.dataset.id);
    if(a==='prints'&&app){visor(app);return prints(app).then(()=>{if(document.querySelector('.pc-visor'))visor(app);});}
    if(a==='abrir'){const alvo=document.querySelector(`[data-candidate-edit="${CSS.escape(b.dataset.cid)}"]`);if(alvo){alvo.click();alvo.closest('section')?.scrollIntoView({block:'start'});}}
   });
  }
  return {mount(el){host=el;if(!dados&&!busy)carregar();else paint();},carregar,paint,dados:()=>dados};
 }
 root.PartnerCandidaturas={create};
})(typeof window!=='undefined'?window:globalThis);
if(typeof module!=='undefined'&&module.exports)module.exports=globalThis.PartnerCandidaturas;
