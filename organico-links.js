/* Registro de links UTM do Orgânico (26/09/2026). Gera o link no padrão da planilha da Júlia
   (utm_campaign = AAAAMMDD_campanha quando há data), grava no servidor e mostra o que cada link vendeu
   no período (último clique, mesma fonte da aba Venda). A montagem final é refeita no servidor. */
(function(root){'use strict';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const BRANDS={aristo:'O Aristocrata',fish:'Fishermans'},SITE={aristo:'https://oaristocrata.com/',fish:'https://fishermans.com.br/'};
 const SOURCES=['instagram_social','facebook_social','tiktok_social','youtube','whatsapp'];
 const MEDIUMS={story:'Story',linktree:'Bio / linktree',dm:'Direct (DM)',feed:'Feed',reels:'Reels',comunidade:'Comunidade',direct:'Direct',grupo:'Grupo'};
 const HOSTS={aristo:['oaristocrata.com','www.oaristocrata.com'],fish:['fishermans.com.br','www.fishermans.com.br']};
 const normBrand=m=>({aristocrata:'aristo',fishermans:'fish'})[m]||m;
 const money=n=>n==null?'—':Number(n).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
 function monta({destino,utm_source,utm_medium,campanha,dia}){
  const camp=dia?String(dia).replace(/-/g,'')+'_'+campanha:campanha;
  return {utm_campaign:camp,url:destino+(destino.includes('?')?'&':'?')+'utm_source='+utm_source+'&utm_medium='+utm_medium+'&utm_campaign='+camp};
 }
 function valida(d){
  let host='';try{const u=new URL(d.destino);if(u.protocol!=='https:')return 'Destino precisa começar com https://';host=u.host;}catch(_){return 'Destino precisa ser um endereço completo do site.';}
  if(!HOSTS[d.marca]?.includes(host))return `Destino precisa ser do site ${BRANDS[d.marca]||'da marca'}.`;
  if(/[?&]utm_/i.test(d.destino))return 'Tire as UTMs do destino; o painel monta.';
  if(!/^[A-Za-z0-9_-]{2,60}$/.test(d.campanha))return 'Campanha: 2 a 60 letras, números, _ ou -, sem espaço.';
  return '';
 }
 // Pedidos e receita do link no período: mesmo último clique da aba Venda, casando marca + utm.
 function vendas(api,link,ini,fim){
  const d=api?.organico_attribution?.daily;if(!Array.isArray(d))return null;
  const rows=d.filter(r=>r.model==='last_click'&&normBrand(r.marca)===link.marca&&r.utm_campaign===link.utm_campaign&&r.utm_medium===link.utm_medium&&r.utm_source===link.utm_source&&String(r.dia).slice(0,10)>=ini&&String(r.dia).slice(0,10)<=fim);
  return {pedidos:rows.reduce((t,r)=>t+(+r.pedidos||0),0),receita:rows.reduce((t,r)=>t+(+r.receita_liquida||0),0)};
 }
 function create({document,endpoint,key,getApi,getMarca,getPeriod,fetchImpl}){
  let links=null,erro='',msg='',busy=false,host=null;
  const REDE=()=>root.PainelRede||{ler:fn=>fn(),mensagem:e=>e.message,transitorio:()=>false,marca:e=>e};
  const q=s=>host?.querySelector(s);
  async function call(body){
   const k=key();if(!k)throw Error('Entre com a chave do painel para usar os links.');
   const r=await (fetchImpl||fetch)(endpoint(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,k}),credentials:'omit',redirect:'error',cache:'no-store'});
   let j;try{j=await r.json();}catch(_){throw REDE().marca(Error('Resposta não confirmada. Atualize a lista antes de tentar de novo.'),r.status);}
   if(!r.ok||!j||j.erro)throw REDE().marca(Error(j?.erro||'Não foi possível concluir.'),r.ok?0:r.status);return j;
  }
  async function carregar(){if(busy)return;busy=true;erro='';paint();try{links=(await REDE().ler(()=>call({acao:'listar'}))).links||[];}catch(e){erro=REDE().mensagem(e);}finally{busy=false;paint();}}
  function paint(){
   if(!host)return;const brand=getMarca(),per=getPeriod(),api=getApi(),hoje=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
   const lista=(links||[]).filter(l=>brand==='todas'||l.marca===brand),marcaForm=brand==='todas'?'aristo':brand;
   const linhas=lista.map(l=>{const v=vendas(api,l,per.ini,per.fim);let path='';try{const u=new URL(l.destino);path=u.pathname+(u.search||'');}catch(_){path=l.destino;}
    return `<tr><td class="tabn nowrap">${l.dia?esc(String(l.dia).slice(8,10)+'/'+String(l.dia).slice(5,7)):'<span class="mini">sem data</span>'}</td><td>${esc(BRANDS[l.marca]||l.marca)}</td><td>${esc(MEDIUMS[l.utm_medium]||l.utm_medium)}<span class="mini ol-sub">${esc(l.utm_source)}</span></td>
     <td><code>${esc(l.utm_campaign)}</code>${l.observacao?`<span class="mini ol-sub${/divergente/.test(l.observacao)?' ol-alerta':''}">${esc(l.observacao)}</span>`:''}</td><td class="ol-destino" title="${esc(l.destino)}">${esc(path)}</td>
     <td class="num tabn">${v?v.pedidos:'—'}</td><td class="num tabn">${v?money(v.receita):'—'}</td>
     <td class="nowrap"><span class="mini ol-quem">${esc(l.origem==='planilha'?'da planilha':l.criado_por)}</span><button type="button" class="btn sec ol-copiar" data-url="${esc(l.url)}">Copiar</button> <button type="button" class="btn sec ol-arquivar" data-id="${esc(l.id)}" title="Some da lista; o histórico fica no banco">Arquivar</button></td></tr>`;}).join('');
   host.innerHTML=`<div class="painel"><div class="painel-cab"><h2>Links UTM</h2><span class="mini">${links?`${lista.length} link(s) · pedidos e receita no período, último clique`:''}</span></div>
    <form id="ol-form" class="ol-form" novalidate autocomplete="off">
     <label>Marca<select name="marca">${Object.entries(BRANDS).map(([k,v])=>`<option value="${k}" ${k===marcaForm?'selected':''}>${v}</option>`).join('')}</select></label>
     <label>Data<input name="dia" type="date" value="${esc(hoje)}"></label>
     <label>Superfície<select name="utm_medium">${Object.entries(MEDIUMS).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label>
     <label class="ol-largo">Destino<input name="destino" type="url" placeholder="${esc(SITE[marcaForm])}products/…" value="${esc(SITE[marcaForm])}"></label>
     <label>Campanha<input name="campanha" placeholder="kit_duas_aguas" maxlength="60"></label>
     <label>Origem<select name="utm_source">${SOURCES.map(s=>`<option value="${s}">${s}</option>`).join('')}</select></label>
     <label>Observação<input name="observacao" maxlength="200" placeholder="opcional"></label>
     <div class="ol-previa ol-largo"><span class="mini">Link final</span><code id="ol-url">—</code></div>
     <div class="ol-largo"><button class="btn" type="submit" ${busy?'disabled':''}>Salvar e copiar</button> <span class="mini" id="ol-msg" role="status" aria-live="polite">${esc(msg)}</span></div>
    </form>
    ${erro?`<div class="vazio">${esc(erro)} <button type="button" class="btn sec" id="ol-recarregar">Tentar de novo</button></div>`:!links?'<div class="vazio">Carregando links…</div>'
     :`<div class="rolagem"><table class="comparativo ol-tabela"><thead><tr><th>Data</th><th>Marca</th><th>Superfície</th><th>Campanha</th><th>Destino</th><th class="num">Pedidos</th><th class="num">Receita</th><th></th></tr></thead><tbody>${linhas||'<tr><td colspan="8"><div class="vazio">Nenhum link registrado para esta marca.</div></td></tr>'}</tbody></table></div>`}
    <details class="ressalvas"><summary>Como o link é montado</summary><ul><li>Com data: <code>utm_campaign = AAAAMMDD_campanha</code>, igual à planilha. Sem data (link fixo, como o da bio): só a campanha.</li><li>Pedidos e receita vêm da atribuição por último clique (aba Venda) e casam marca, origem, superfície e campanha exatas.</li><li>Link com o mesmo endereço final não duplica: o painel devolve o que já existe.</li></ul></details></div>`;
   const f=q('#ol-form'),ler=()=>{const g=n=>String(f.querySelector(`[name="${n}"]`)?.value||'').trim();return {marca:g('marca'),destino:g('destino'),dia:g('dia'),utm_source:g('utm_source'),utm_medium:g('utm_medium'),campanha:g('campanha'),observacao:g('observacao')};};
   const previa=()=>{const d=ler(),e=valida(d);q('#ol-url').textContent=e?'—':monta(d).url;};
   f.oninput=previa;f.onchange=e=>{if(e.target.name==='marca'){const i=f.querySelector('[name=destino]');if(!i.value||Object.values(SITE).includes(i.value))i.value=SITE[e.target.value];}previa();};previa();
   f.onsubmit=async ev=>{ev.preventDefault();if(busy)return;const d=ler(),e=valida(d);if(e){msg=e;q('#ol-msg').textContent=e;return;}
    busy=true;msg='Salvando…';paint();
    try{const j=await call({acao:'salvar',data:{...d,id:(root.crypto?.randomUUID?.()||'')}});msg=j.repetido?'Esse link já existia; copiado.':'Salvo e copiado.';try{await navigator.clipboard.writeText(j.link.url);}catch(_){msg+=' (copie pelo botão da lista)';}
     links=(await call({acao:'listar'})).links||links;}catch(err){msg=REDE().transitorio(err)?'Resposta não confirmada. Atualize a lista antes de salvar de novo.':err.message;}finally{busy=false;paint();}};
   host.querySelectorAll('.ol-copiar').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.url);b.textContent='Copiado';}catch(_){b.textContent='Não copiou';}});
   host.querySelectorAll('.ol-arquivar').forEach(b=>b.onclick=async()=>{if(b.dataset.armado!=='1'){b.dataset.armado='1';b.textContent='Confirmar?';return;}b.disabled=true;
    try{await call({acao:'arquivar',data:{id:b.dataset.id}});links=links.filter(l=>l.id!==b.dataset.id);msg='Link arquivado.';}catch(err){msg=REDE().transitorio(err)?'Resposta não confirmada. Atualize a lista antes de repetir.':err.message;}paint();});
   q('#ol-recarregar')?.addEventListener('click',carregar);
  }
  return {mount(el){host=el;if(!links&&!busy)carregar();else paint();},paint,carregar,_links:()=>links};
 }
 root.OrganicoLinks={create,monta,valida,vendas};
})(typeof window!=='undefined'?window:globalThis);
if(typeof module!=='undefined'&&module.exports)module.exports=globalThis.OrganicoLinks;
