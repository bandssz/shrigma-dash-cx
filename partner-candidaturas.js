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
  function cartao(a,todas){
   const [rot,cls]=ESTADO[a.estado]||[a.estado||'—','nulo'];
   const ig=handleOk(a.instagram)?`<a href="https://instagram.com/${esc(a.instagram)}" target="_blank" rel="noopener noreferrer">@${esc(a.instagram)}</a>`:'';
   const tt=handleOk(a.tiktok)?`<a href="https://www.tiktok.com/@${esc(a.tiktok)}" target="_blank" rel="noopener noreferrer">TikTok @${esc(a.tiktok)}</a>`:'';
   const zap=/^\d{12,13}$/.test(a.whatsapp)?`<a href="https://wa.me/${esc(a.whatsapp)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>`:'';
   const cpm=(v,p,c)=>v?`<div class="pc-num"><span class="mini">${p}</span><strong class="tabn">${nf(v)}</strong><span class="mini">views${c!=null?` · CPM ${rf(c)}`:''}</span></div>`:'';
   const fotos=a.prints.map(p=>{const s=imgs.get(p.id);return s&&s.startsWith('data:')?`<a class="pc-foto" href="${s}" target="_blank" rel="noopener"><img src="${s}" alt="Print ${p.ordem} de ${esc(a.nome)}" loading="lazy"></a>`
     :`<span class="pc-foto pc-foto-vazia">${s==='carregando'?'carregando…':s==='erro'?'não abriu':'print '+p.ordem}</span>`;}).join('');
   return `<article class="pc-card" data-id="${esc(a.id)}">
    <div class="pc-top">${todas?`<span class="tag nulo">${esc(BRANDS[a.marca]||a.marca)}</span>`:''}<span class="tag ${cls}">${esc(rot)}</span><span class="mini">${dt(a.criado_em)}</span></div>
    <h3>${esc(a.nome)}</h3><div class="pc-perfis">${[ig,tt].filter(Boolean).join(' · ')||'<span class="mini">sem perfil válido</span>'}</div>
    <div class="pc-nums"><div class="pc-num"><span class="mini">seguidores</span><strong class="tabn">${nf(a.seguidores)}</strong><span class="mini">${esc(a.nicho||'')}</span></div>
     ${cpm(a.views_stories,'story',a.cpm_story)}${cpm(a.views_reels,'reels',a.cpm_reels)}</div>
    ${a.preco_story!=null||a.preco_reels!=null?`<p class="mini">Cobra ${[a.preco_story!=null?rf(a.preco_story)+' por story':'',a.preco_reels!=null?rf(a.preco_reels)+' por reels':''].filter(Boolean).join(' e ')}. CPM = preço ÷ views × 1.000, pelos números que ele declarou.</p>`:'<p class="mini">Não informou preço: sem CPM.</p>'}
    <div class="pc-fotos">${fotos}${a.prints.some(p=>!imgs.has(p.id))?`<button type="button" class="btn sec" data-pc="prints">Ver prints (${a.prints.length})</button>`:''}</div>
    ${a.mensagem?`<details class="pc-msg"><summary>Mensagem</summary><p>${esc(a.mensagem)}</p></details>`:''}
    <div class="pc-rodape"><span class="mini">${esc([a.cidade,a.uf].filter(Boolean).join(' / '))}</span><span class="mini">aceitou o termo v${esc(a.termo_versao)} em ${dt(a.aceite_em)}</span>
     <span class="pc-acoes">${zap}<a href="mailto:${esc(a.email)}">E-mail</a><button type="button" class="btn" data-pc="abrir" data-cid="${esc(a.candidate_id)}">Analisar no cadastro</button></span></div>
   </article>`;
  }
  function paint(){
   if(!host)return;
   if(!dados){host.innerHTML=erro?`<div class="vazio">${esc(erro)} <button class="btn sec" data-pc="recarregar">Tentar de novo</button></div>`:'<div class="vazio">Carregando candidaturas…</div>';ligar();return;}
   const m=getMarca(),todas=m==='todas',todasApps=(dados.candidaturas||[]).filter(a=>todas||a.marca===m);
   const abertas=todasApps.filter(a=>['novo','em_analise'].includes(a.estado)),lista=filtro==='abertas'?abertas:todasApps;
   const termo=(dados.termos||[]).filter(t=>(todas||t.marca===m)&&t.publicado_em&&!t.retirado_em);
   const fechadas=(todas?['aristo','fish']:[m]).filter(b=>!termo.some(t=>t.marca===b));
   host.innerHTML=`<section class="painel pc"><div class="painel-cab"><h2>Candidaturas do site <span class="tag ${abertas.length?'alerta':'nulo'}">${abertas.length}</span></h2>
     <span class="mini">${fechadas.length?`formulário fechado em ${fechadas.map(b=>BRANDS[b]).join(' e ')}: falta publicar o termo`:'formulário aberto'}</span></div>
    <div class="pc-filtro" role="group" aria-label="Quais candidaturas"><button type="button" data-pc="filtro" data-f="abertas" class="${filtro==='abertas'?'ativo':''}">Para analisar (${abertas.length})</button><button type="button" data-pc="filtro" data-f="todas" class="${filtro==='todas'?'ativo':''}">Todas (${todasApps.length})</button></div>
    <div class="pc-lista">${lista.map(a=>cartao(a,todas)).join('')||`<div class="vazio">${filtro==='abertas'?'Nenhuma candidatura esperando análise.':'Nenhuma candidatura recebida pelo site ainda.'}</div>`}</div></section>`;
   ligar();
  }
  function ligar(){
   host.querySelectorAll('[data-pc]').forEach(b=>b.onclick=()=>{const a=b.dataset.pc;
    if(a==='recarregar')return carregar();
    if(a==='filtro'){filtro=b.dataset.f;return paint();}
    const app=(dados?.candidaturas||[]).find(x=>x.id===b.closest('.pc-card')?.dataset.id);
    if(a==='prints'&&app)return prints(app);
    if(a==='abrir'){const alvo=document.querySelector(`[data-candidate-edit="${CSS.escape(b.dataset.cid)}"]`);if(alvo){alvo.click();alvo.closest('section')?.scrollIntoView({block:'start'});}}
   });
  }
  return {mount(el){host=el;if(!dados&&!busy)carregar();else paint();},carregar,paint,dados:()=>dados};
 }
 root.PartnerCandidaturas={create};
})(typeof window!=='undefined'?window:globalThis);
if(typeof module!=='undefined'&&module.exports)module.exports=globalThis.PartnerCandidaturas;
