/* Escopo dos creators (27/09/2026, começa em outubro): combinado × feito no mês, por creator.
   Reels e posts entram sozinhos (o creator marcou a conta da marca no Instagram); story a Marcela marca à mão.
   Lê e grava em crm_influ_escopo_painel_v1 com a chave do painel de Influs. */
(function(root){'use strict';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const BRANDS={aristo:'O Aristocrata',fish:'Fishermans'};
 const TIPOS=[['story','Stories'],['reels','Reels'],['feed','Posts'],['tiktok','TikTok']];
 const MESES=['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
 const mesTxt=m=>{const [a,b]=String(m).split('-');return `${MESES[+b-1]||b}/${a}`;};
 const hojeSP=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
 const somaMes=(m,n)=>{const [a,b]=m.split('-').map(Number),d=new Date(Date.UTC(a,b-1+n,1));return d.toISOString().slice(0,7);};
 const dt=v=>{const d=new Date(v);return isNaN(d)?'—':d.toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});};
 const dia=v=>{const d=new Date(v);return isNaN(d)?'':d.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit'});};
 const igOk=h=>/^[a-z0-9._]{1,30}$/.test(String(h||''));
 function create({document,endpoint,key,getMarca,fetchImpl,uuid}){
  let dados=null,erro='',busy=false,host=null,mes=hojeSP().slice(0,7),aberto=null,aviso='';
  const REDE=()=>root.PainelRede||{ler:fn=>fn(),mensagem:e=>e.message,transitorio:()=>false,marca:e=>e};
  const f=()=>fetchImpl||root.fetch.bind(root),novoId=()=>(uuid||(()=>root.crypto.randomUUID()))();
  async function call(acao,data){
   const k=key();if(!k)throw Error('Entre com a chave do painel.');
   const r=await f()(endpoint(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acao,mes,data,k}),credentials:'omit',redirect:'error',cache:'no-store'});
   let j;try{j=await r.json();}catch(_){throw REDE().marca(Error('Resposta não confirmada. Recarregue antes de repetir.'),r.status);}
   if(!r.ok||!j||j.erro)throw REDE().marca(Error(j?.erro||'Não foi possível concluir.'),r.ok?0:r.status);return j;
  }
  async function carregar(){busy=true;erro='';paint();try{dados=await REDE().ler(()=>call('ler'));}catch(e){erro=REDE().mensagem(e);}finally{busy=false;paint();}}
  async function escreve(acao,data){busy=true;aviso='Gravando…';paint();try{const j=await call(acao,data);aviso=j.mensagem||'Feito.';aberto=null;dados=await call('ler');}catch(e){aviso=REDE().transitorio(e)?'Resposta não confirmada. Recarregue a lista antes de repetir.':e.message;}finally{busy=false;paint();}}
  // Ritmo do mês corrente: esperado até hoje = combinado × dias passados ÷ dias do mês.
  function ritmo(c){
   const e=c.escopo;if(!e)return null;const tot=TIPOS.reduce((t,[k])=>t+(+e[k==='story'?'stories':k]||0),0);if(!tot)return null;
   const feitos=TIPOS.reduce((t,[k])=>t+Math.min(+c.feito[k]||0,+e[k==='story'?'stories':k]||0),0);
   const h=hojeSP();if(mes<h.slice(0,7))return feitos>=tot?['cumpriu','bom']:['não cumpriu','ruim'];
   if(mes>h.slice(0,7))return ['mês futuro','nulo'];
   const [a,b,d]=h.split('-').map(Number),dias=new Date(Date.UTC(a,b,0)).getUTCDate(),esperado=tot*d/dias;
   return feitos>=tot?['cumprido','bom']:feitos+0.001>=Math.floor(esperado)?['no ritmo','neutro']:['atrasado','alerta'];
  }
  function cartao(c,todas,pode){
   const e=c.escopo,k=`${c.marca}|${c.influ}`,[rt,rc]=ritmo(c)||['sem escopo','nulo'];
   const linhas=TIPOS.map(([t,rot])=>{const alvo=e?+e[t==='story'?'stories':t]||0:0,feito=+c.feito[t]||0;if(!alvo&&!feito)return '';
    const pct=alvo?Math.min(100,Math.round(feito/alvo*100)):100;
    return `<div class="es-linha"><span class="es-rot">${rot}</span><span class="es-barra" role="img" aria-label="${feito} de ${alvo||'—'}"><span style="width:${pct}%"></span></span><strong class="tabn">${feito}${alvo?` / ${alvo}`:''}</strong></div>`;}).join('');
   const conts=c.conteudos.filter(x=>!x.ignorado).map(x=>`<a class="es-cont" href="${x.permalink&&/^https:\/\/(www\.)?instagram\.com\//.test(x.permalink)?esc(x.permalink):'#'}" target="_blank" rel="noopener noreferrer" title="${esc(x.tipo)} · ${esc(dia(x.publicado_em))}${x.fonte==='manual'?' · marcado à mão':''}">
     ${x.miniatura&&/^https:\/\//.test(x.miniatura)?`<img src="${esc(x.miniatura)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`:''}<span class="es-cont-tipo">${esc(x.tipo)}</span><span class="es-cont-dia">${esc(dia(x.publicado_em))}</span></a>`).join('');
   const ig=igOk(c.instagram)?`<a href="https://instagram.com/${esc(c.instagram)}" target="_blank" rel="noopener noreferrer">@${esc(c.instagram)}</a>`:'<span class="tag alerta" title="sem o @ do Instagram as marcações não casam">sem @</span>';
   const form=aberto===k+'|escopo'?`<form class="es-form" data-es-form="escopo"><div class="es-grid">
      <label>Vale a partir de<input type="month" name="desde" value="${esc(e?.vigente_desde?.slice(0,7)&&e.vigente_desde.slice(0,7)>mes?e.vigente_desde.slice(0,7):mes)}" required></label>
      <label>Instagram<input name="instagram" value="${esc(c.instagram||'')}" placeholder="@perfil" autocapitalize="none"></label>
      ${TIPOS.map(([t,rot])=>`<label>${rot} / mês<input name="${t==='story'?'stories':t}" type="number" min="0" max="200" step="1" value="${esc(e?.[t==='story'?'stories':t]??0)}"></label>`).join('')}
      <label class="es-largo">Observação<input name="obs" maxlength="300" value="${esc(e?.obs||'')}"></label></div>
      <div class="es-acoes"><button class="btn" type="submit">Salvar escopo</button><button class="btn sec" type="button" data-es="fechar">Cancelar</button></div></form>`
    :aberto===k+'|story'?`<form class="es-form" data-es-form="story"><div class="es-grid"><label>Tipo<select name="tipo">${TIPOS.map(([t,r])=>`<option value="${t}" ${t==='story'?'selected':''}>${r}</option>`).join('')}</select></label>
      <label>Dia<input type="date" name="dia" value="${esc(hojeSP())}" max="${esc(hojeSP())}" required></label><label class="es-largo">Link (opcional)<input name="link" type="url" placeholder="https://"></label></div>
      <div class="es-acoes"><button class="btn" type="submit">Marcar</button><button class="btn sec" type="button" data-es="fechar">Cancelar</button></div></form>`:'';
   return `<article class="es-card" data-k="${esc(k)}" data-marca="${esc(c.marca)}" data-influ="${esc(c.influ)}">
    <header><div><strong>${esc(c.nome)}</strong> <span class="mini">${ig}${todas?' · '+esc(BRANDS[c.marca]||c.marca):''}${c.modelo?' · '+esc(c.modelo):''}</span></div><span class="tag ${rc}">${esc(rt)}</span></header>
    ${linhas||'<p class="mini">Nada combinado nem entregue neste mês.</p>'}
    ${conts?`<div class="es-conts">${conts}</div>`:''}
    ${pode&&!form?`<div class="es-acoes"><button class="btn sec" type="button" data-es="story">Marcar story</button><button class="btn sec" type="button" data-es="escopo">${e?'Editar escopo':'Definir escopo'}</button></div>`:''}${form}</article>`;
  }
  // Sem escopo e sem entrega: uma linha só (nome, @, definir). Abre o cartão inteiro quando alguém clica.
  const compacto=c=>!TIPOS.some(([t])=>+c.feito[t]>0)&&!(aberto||'').startsWith(`${c.marca}|${c.influ}|`);
  function linha(c,todas,pode){
   const ig=igOk(c.instagram)?`@${esc(c.instagram)}`:'<span class="tag alerta">sem @</span>';
   return `<div class="es-card es-linha-c" data-k="${esc(c.marca+'|'+c.influ)}" data-marca="${esc(c.marca)}" data-influ="${esc(c.influ)}"><div><strong>${esc(c.nome)}</strong> <span class="mini">${ig}${todas?' · '+esc(BRANDS[c.marca]||c.marca):''}</span></div>${pode?'<button class="btn sec" type="button" data-es="escopo">Definir escopo</button>':''}</div>`;
  }
  function paint(){
   if(!host)return;
   if(!dados){host.innerHTML=erro?`<div class="vazio">${esc(erro)} <button class="btn sec" data-es="recarregar">Tentar de novo</button></div>`:'<div class="vazio">Carregando escopo…</div>';ligar();return;}
   const m=getMarca(),todas=m==='todas',pode=dados.pode_escrever===true;
   const lista=(dados.creators||[]).filter(c=>todas||c.marca===m);
   const com=lista.filter(c=>c.escopo&&TIPOS.some(([t])=>+c.escopo[t==='story'?'stories':t]>0));
   const sem=lista.filter(c=>!com.includes(c)),entregaram=sem.filter(c=>TIPOS.some(([t])=>+c.feito[t]>0));
   const orf=(dados.sem_cadastro||[]).filter(s=>todas||s.marca===m);
   const atrasados=com.filter(c=>{const r=ritmo(c);return r&&['atrasado','não cumpriu'].includes(r[0]);}).length;
   const opts=b=>lista.filter(c=>c.marca===b).map(c=>`<option value="${esc(c.influ)}">${esc(c.nome)}</option>`).join('');
   host.innerHTML=`<section class="painel es"><div class="painel-cab"><h2>Escopo dos creators</h2>
     <span class="mini" title="Reels e posts entram sozinhos quando o creator marca a conta da marca. Story é marcado à mão.">marcações lidas ${dados.coleta?.ultima?'em '+esc(dt(dados.coleta.ultima)):'—'}</span></div>
    <div class="es-topo"><div class="es-mes" role="group" aria-label="Mês"><button class="btn sec" data-es="mes" data-n="-1" aria-label="Mês anterior">‹</button><strong>${esc(mesTxt(dados.mes||mes))}</strong><button class="btn sec" data-es="mes" data-n="1" aria-label="Próximo mês">›</button></div>
     <span class="tag ${atrasados?'alerta':'bom'}">${com.length} com escopo · ${atrasados} atrasado(s)</span>${pode?'':'<span class="mini">chave só de leitura</span>'}</div>
    ${aviso?`<div class="nota" role="status">${esc(aviso)}</div>`:''}
    <div class="es-lista">${com.map(c=>cartao(c,todas,pode)).join('')||'<div class="vazio">Nenhum creator com escopo definido neste mês. Defina abaixo.</div>'}</div>
    ${orf.length?`<details class="es-det" open><summary>Marcaram a marca e não têm @ ligado a um creator <span class="tag alerta">${orf.length}</span></summary>
      <div class="es-orfaos">${orf.map(s=>`<div class="es-orfao" data-marca="${esc(s.marca)}" data-ig="${esc(s.username)}"><a href="https://instagram.com/${esc(s.username)}" target="_blank" rel="noopener noreferrer">@${esc(s.username)}</a><span class="mini">${esc(s.n)} marcação(ões)${todas?' · '+esc(BRANDS[s.marca]):''}</span>
       ${pode?`<select aria-label="Creator de @${esc(s.username)}"><option value="">ligar a…</option>${opts(s.marca)}</select><button class="btn sec" type="button" data-es="vincular">Ligar</button>`:''}</div>`).join('')}</div></details>`:''}
    <details class="es-det"${com.length?'':' open'}><summary>Sem escopo definido <span class="tag nulo">${sem.length}</span>${entregaram.length?` <span class="mini">${entregaram.length} já entregaram algo</span>`:''}</summary>
     <div class="es-lista">${sem.map(c=>compacto(c)?linha(c,todas,pode):cartao(c,todas,pode)).join('')}</div></details>
    <details class="ressalvas"><summary>Como conta</summary><ul><li>Reels e posts contam quando o creator marca @ da marca na publicação (a conta principal ou a reserva). A leitura é diária, às 06:10.</li>
     <li>Stories e TikTok, por enquanto, a Marcela marca à mão em "Marcar story".</li><li>O ritmo compara o que saiu com o combinado proporcional aos dias já passados do mês.</li><li>Marcação feita por quem não tem @ ligado aparece na lista para ligar a um creator; ao ligar, as marcações antigas passam a contar.</li></ul></details></section>`;
   ligar();
  }
  function ligar(){
   host.querySelectorAll('[data-es]').forEach(b=>b.onclick=()=>{const a=b.dataset.es,card=b.closest('.es-card');
    if(a==='recarregar')return carregar();
    if(a==='mes'){mes=somaMes(mes,Number(b.dataset.n));aviso='';return carregar();}
    if(a==='fechar'){aberto=null;return paint();}
    if(a==='story'||a==='escopo'){aberto=card.dataset.k+'|'+a;aviso='';return paint();}
    if(a==='vincular'){const o=b.closest('.es-orfao'),sel=o.querySelector('select');if(!sel.value){aviso='Escolha o creator.';return paint();}
     return escreve('vincular',{marca:o.dataset.marca,influ:sel.value,instagram:o.dataset.ig});}
   });
   host.querySelectorAll('[data-es-form]').forEach(fm=>fm.onsubmit=ev=>{ev.preventDefault();const card=fm.closest('.es-card'),v=n=>String(fm.querySelector(`[name="${n}"]`)?.value||'').trim();
    const base={marca:card.dataset.marca,influ:card.dataset.influ};
    if(fm.dataset.esForm==='escopo')return escreve('escopo_salvar',{...base,desde:v('desde'),instagram:v('instagram'),stories:v('stories')||'0',reels:v('reels')||'0',feed:v('feed')||'0',tiktok:v('tiktok')||'0',obs:v('obs')});
    return escreve('conteudo_marcar',{...base,tipo:v('tipo'),dia:v('dia'),link:v('link'),id:novoId()});
   });
  }
  return {mount(el){host=el;if(!busy)carregar();else paint();},carregar,paint,dados:()=>dados};
 }
 root.InfluEscopo={create};
})(typeof window!=='undefined'?window:globalThis);
if(typeof module!=='undefined'&&module.exports)module.exports=globalThis.InfluEscopo;
