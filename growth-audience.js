/* Public audience snapshots. Read-only: no membership changes or sending eligibility claims. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GAudience=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const BRANDS={fish:'Fishermans',aristo:'O Aristocrata',olivas:'Olivas do Campo'},TZ='America/Sao_Paulo';
 const GROUPS={profile:'Perfil',rfm:'Relacionamento',interest:'Próxima compra sugerida',journey:'Jornadas',list:'Listas de envio'};
 const PROFILE={total:'Todos os contatos',ativos:'Contatos ativos',compradores:'Clientes que já compraram',recompradores:'Clientes que compraram novamente',engajados_90d:'Engajados nos últimos 90 dias',novos_dia:'Novos contatos no dia',blocklisted:'Bloqueados',descadastrados:'Descadastrados'};
 const RFM={campeao:'Campeões',leal:'Clientes leais',um_x:'Compraram uma vez',um_x_lapsando:'Compra única · em risco de inatividade',dormant:'Inativos',needs_attention:'Precisam de atenção',ex_campeao_at_risk:'Ex-campeões em risco'};
 const INTEREST={'(sem)':'Sem sugestão de próxima compra',X4:'Linha X4',X8:'Linha X8',S50:'Linha S50',X16:'Linha X16',oceanica:'Linha Oceânica',amazonica:'Linha Amazônica'};
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const list=v=>Array.isArray(v)?v:[],text=v=>typeof v==='string'?v.trim():'';
 const brand=v=>Object.hasOwn(BRANDS,v)?v:null;
 const count=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:typeof v==='string'&&/^\d+$/.test(v)&&Number.isSafeInteger(Number(v))?Number(v):null;
 const identity=(b,id)=>JSON.stringify([b,id]);
 function date(value,dayMode=true){
  if(typeof value!=='string')return null;
  const m=/^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.000)?Z)?$/.exec(value);
  if(m&&(dayMode||value.length===10)){const ms=Date.parse(m[1]+'T12:00:00Z');if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==m[1])return null;return {value:m[1],ms,day:true};}
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return null;
  const ms=Date.parse(value);return Number.isFinite(ms)?{value,ms,day:false}:null;
 }
 const record=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
 function baseRows(api,chosen){
  const latestByBrand=new Map(),out=[];
  const fingerprint=r=>JSON.stringify([Object.keys(PROFILE).map(k=>count(r[k])),...['rfm','next_best'].map(g=>Object.entries(record(record(r.segmentos)[g])).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,count(v)]))]);
  for(const r of list(api.crm_base)){const b=brand(r?.marca);if(!b||chosen!=='todas'&&b!==chosen)continue;const at=date(r.coletado_em,false)||date(r.dia),old=latestByBrand.get(b);
   if(!old||(at?.ms??-Infinity)>(old.at?.ms??-Infinity))latestByBrand.set(b,{r,at,conflict:false});
   else if((at?.ms??-Infinity)===(old.at?.ms??-Infinity)&&fingerprint(r)!==fingerprint(old.r))old.conflict=true;
  }
  for(const [b,{r,at,conflict}] of latestByBrand){const segments=record(r.segmentos),common={brand:b,kind:'segment',available:null,source:'crm_base',measuredAt:at?.value||null,dateOnly:at?.day??true};
   const add=(group,id,name,value)=>out.push({...common,key:group+':'+identity(b,id),id,group,name,count:at&&!conflict?count(value):null,reason:conflict?'conflicting_snapshot':!at?'missing_snapshot':count(value)===null?'missing_count':null});
   for(const [id,name] of Object.entries(PROFILE))add('profile',id,name,r[id]);
   for(const [id,value] of Object.entries(record(segments.rfm)))add('rfm',id,Object.hasOwn(RFM,id)?RFM[id]:id.replace(/_/g,' '),value);
   for(const [id,value] of Object.entries(record(segments.next_best)))add('interest',id,Object.hasOwn(INTEREST,id)?INTEREST[id]:id.replace(/_/g,' '),value);
  }
  return out;
 }
 function latest(rows){
  let best=null,conflict=false;
  for(const r of rows){const at=date(r.dia);if(!at)continue;const n=count(r.pessoas);
   if(!best||at.ms>best.at.ms){best={at,count:n};conflict=false;}
   else if(at.ms===best.at.ms&&n!==best.count)conflict=true;
  }
  return best?{count:conflict?null:best.count,measuredAt:best.at.value,dateOnly:best.at.day,reason:conflict?'conflicting_snapshot':best.count===null?'missing_count':null}:{count:null,measuredAt:null,dateOnly:true,reason:'missing_snapshot'};
 }
 function rows(api={}, {brand:chosen='todas',catalogs=[]}={}){
  const result=baseRows(api,chosen),snapshots=new Map(),rules=new Map();
  for(const s of list(api.crm_galho)){const b=brand(s?.marca),id=text(s?.galho);if(!b||!id)continue;const k=identity(b,id);if(!snapshots.has(k))snapshots.set(k,[]);snapshots.get(k).push(s);}
  for(const r of list(api.crm_regra_galho)){const b=brand(r?.marca),id=text(r?.galho);if(!b||!id||chosen!=='todas'&&b!==chosen)continue;const k=identity(b,id);if(!rules.has(k))rules.set(k,{r,b,id});}
  for(const [k,{r,b,id}] of rules)result.push({key:'segment:'+k,id,brand:b,name:text(r.rotulo)||id,kind:'segment',group:'journey',available:null,source:'crm_galho',...latest(snapshots.get(k)||[])});
  // Existing campaign catalog proves identity/availability, not list size.
  const lists=new Map();for(const c of list(catalogs)){if(!brand(c?.brand)||c.current!==true||chosen!=='todas'&&c.brand!==chosen)continue;for(const l of list(c.lists)){
   if(l?.brand!==c.brand||!Number.isSafeInteger(l.id)||l.id<=0||typeof l.available!=='boolean')continue;
   const k=identity(c.brand,l.id);if(!lists.has(k))lists.set(k,{key:'list:'+k,id:l.id,brand:c.brand,name:text(l.name)||'Lista '+l.id,kind:'list',group:'list',available:l.available,source:'campaign_catalog',count:null,measuredAt:null,dateOnly:false,reason:'catalog_without_count'});
  }}result.push(...lists.values());return result;
 }
 const normalized=v=>String(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt-BR');
 function sortRows(input,{sort='size_desc',search='',kind='all',group='all'}={}){
  const needle=normalized(search.trim()),selected=list(input).filter(r=>(kind==='all'||r.kind===kind)&&(group==='all'||r.group===group)&&(!needle||normalized(r.name+' '+(BRANDS[r.brand]||'')+' '+(GROUPS[r.group]||'')).includes(needle)));
  return selected.slice().sort((a,b)=>{
   if(a.count===null&&b.count!==null)return 1;if(a.count!==null&&b.count===null)return -1;
   if(sort!=='name'&&a.count!==null&&b.count!==null&&a.count!==b.count)return sort==='size_asc'?a.count-b.count:b.count-a.count;
   return a.name.localeCompare(b.name,'pt-BR',{sensitivity:'base',numeric:true})||a.brand.localeCompare(b.brand)||a.key.localeCompare(b.key);
  });
 }
 function freshness(row,now=Date.now()){
  const at=date(row.measuredAt,row.dateOnly!==false);if(!at)return {label:'Contagem não informada',age:'Sem data de contagem',stale:false};
  const day=at.day?at.value:new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at.ms));
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const days=Math.floor((Date.parse(today+'T12:00:00Z')-Date.parse(day+'T12:00:00Z'))/86400000);
  const label=at.day?'Contagem de '+day.slice(8,10)+'/'+day.slice(5,7)+'/'+day.slice(0,4):'Contagem em '+new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,dateStyle:'short',timeStyle:'short'}).format(new Date(at.ms))+' BRT';
  const minutes=Math.floor((now-at.ms)/60000);
  return {label,age:days<0||!at.day&&minutes<0?'Data futura: conferir a atualização':at.day?(days===0?'Hoje':days===1?'Há 1 dia':'Há '+days+' dias'):minutes===0?'Há menos de 1 minuto':minutes<60?'Há '+minutes+' min':minutes<2880?'Há '+Math.floor(minutes/60)+' h':'Há '+Math.floor(minutes/1440)+' dias',stale:at.day?days>1||days<0:minutes>26*60||minutes<0};
 }
 let serial=0;
 function mount({element,onRefresh}={}){
  if(!element?.ownerDocument)throw Error('Audience container required');
  const id='growth-audience-'+(++serial),state={api:{},brand:'todas',catalogs:[],now:Date.now(),sort:'size_desc',search:'',kind:'all',group:'all',groupNotice:''};
  element.classList.add('growth-audience');element.innerHTML=`<div class="ga-toolbar"><label for="${id}-search">Buscar público<input id="${id}-search" data-ga-search type="search" placeholder="Nome do público"></label><label for="${id}-sort">Ordenar por<select id="${id}-sort" data-ga-sort><option value="size_desc">Maior público</option><option value="size_asc">Menor público</option><option value="name">Nome A–Z</option></select></label><label for="${id}-group">Grupo<select id="${id}-group" data-ga-group><option value="all">Todos os grupos</option></select></label>${typeof onRefresh==='function'?'<button type="button" class="refresh-btn" data-ga-refresh>Atualizar</button>':''}</div><p class="ga-audience-summary" data-ga-summary role="status" aria-live="polite"></p><span class="ga-note crm-help" tabindex="0" title="Cada grupo mostra pessoas contadas na sua própria data. Uma pessoa pode estar em mais de um público; os tamanhos não são somados. Esses grupos não são listas prontas para envio: opt-out e quantidade elegível são conferidos na campanha.">Contagem de pessoas · disponibilidade para envio conferida na campanha ⓘ</span><div data-ga-result></div>`;
  const q=s=>element.querySelector(s);
  function paint(){const all=rows(state.api,{brand:state.brand,catalogs:state.catalogs}),groups=Object.keys(GROUPS).filter(g=>all.some(r=>r.group===g));
   if(state.group!=='all'&&!groups.includes(state.group)){state.groupNotice='O grupo '+(GROUPS[state.group]||'selecionado')+' não está disponível neste recorte. Exibindo todos os grupos.';state.group='all';}
   const select=q('[data-ga-group]'),signature=groups.join('|');
   if(select.dataset.groups!==signature){select.dataset.groups=signature;select.innerHTML=['all',...groups].map(g=>`<option value="${g}"${state.group===g?' selected':''}>${g==='all'?'Todos os grupos':GROUPS[g]}</option>`).join('');}
   const visible=sortRows(all,state),unknown=visible.filter(r=>r.count===null).length;
   q('[data-ga-summary]').textContent=visible.length+' de '+all.length+' públicos'+(unknown?' · '+unknown+' sem contagem':'')+(state.groupNotice?' · '+state.groupNotice:'');
   q('[data-ga-result]').innerHTML=visible.length?`<div class="ga-table-wrap"><table class="ga-table"><thead><tr><th scope="col">Público</th><th scope="col">Grupo</th><th scope="col" class="ga-count">Pessoas</th><th scope="col">Contagem</th></tr></thead><tbody>${visible.map(r=>{const f=freshness(r,state.now);return `<tr data-ga-row="${esc(r.key)}"><th scope="row"><strong>${esc(r.name)}</strong><span class="ga-brand">${esc(BRANDS[r.brand])}${r.available===false?' · Indisponível para novas campanhas':''}</span></th><td>${esc(GROUPS[r.group])}</td><td class="ga-count">${r.count===null?'<span title="Não há uma contagem confirmada para este público.">Sem contagem</span>':r.count.toLocaleString('pt-BR')}</td><td><span>${esc(f.label)}</span><small class="${f.stale?'ga-stale':''}">${esc(f.age)}</small>${r.reason==='conflicting_snapshot'?'<small class="ga-stale">Contagens divergentes na mesma data</small>':''}</td></tr>`;}).join('')}</tbody></table></div>`:`<div class="ga-empty">${all.length?'Nenhum público corresponde à busca. Altere o nome ou o filtro para ver os demais.':'Nenhum público disponível nesta marca. Atualize os dados para consultar as listas e os segmentos.'}</div>`;
   return {total:all.length,visible:visible.length,unknown};
  }
  q('[data-ga-search]').oninput=e=>{state.search=e.target.value;paint();};q('[data-ga-sort]').onchange=e=>{state.sort=e.target.value;paint();};q('[data-ga-group]').onchange=e=>{state.group=e.target.value;state.groupNotice='';paint();};if(q('[data-ga-refresh]'))q('[data-ga-refresh]').onclick=()=>onRefresh();
  return {update({api={},brand:chosen='todas',catalogs=[],now=Date.now()}={}){if(state.brand!==chosen)state.groupNotice='';state.api=api;state.brand=chosen;state.catalogs=catalogs;state.now=now;return paint();},destroy(){for(const s of ['[data-ga-search]','[data-ga-sort]','[data-ga-group]','[data-ga-refresh]']){const n=q(s);if(n){n.oninput=null;n.onchange=null;n.onclick=null;}}}};
 }
 return Object.freeze({rows,sortRows,freshness,mount});
});
