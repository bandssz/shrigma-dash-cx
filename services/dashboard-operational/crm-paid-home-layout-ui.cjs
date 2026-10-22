'use strict';
// Como foi o e-mail neste período e o que está programado? inicio-layout6.spec.md.
function html(){
 let value=require('./crm-paid-comparison-ui.cjs').html('home');
 const brand=value.match(/<select id="brand"[\s\S]*?<\/select>/)[0];
 value=value.replace(/<header class="mb-3">[\s\S]*?<\/header>/,`<header class="mb-3"><div class="me-auto"><span class="badge bg-yellow-lt">Restrito</span><h1 class="page-title mt-2">Início</h1><div id="period" class="text-secondary mt-1"></div><div class="mt-2"><span id="quality" class="badge bg-yellow-lt">Conferindo</span> <span id="comparison-status" class="badge bg-secondary-lt"></span> <span id="revenue-updated" class="badge bg-secondary-lt"></span></div></div><div class="layout-actions">${brand}<select id="preset" class="form-select" form="filters" aria-label="Período"></select><button type="button" id="open-schedule" class="btn btn-primary">Ver programação</button></div></header>`);
 value=value.replace('<label class="form-label">Período<select id="preset" class="form-select"></select></label>','');
 value=value.replace('<form id="filters" class="filters mb-4">','<details class="card mb-3 layout-filters"><summary class="card-header">Filtros</summary><form id="filters" class="filters p-3">').replace('<button class="btn btn-primary" id="apply">Aplicar</button></form>','<button class="btn btn-outline-primary" id="apply">Aplicar</button></form></details>');
 value=value.replace('</style>',`.layout-actions .btn-primary{background:var(--tblr-primary);border-color:var(--tblr-primary)}.layout-filters .btn-outline-primary{--tblr-btn-variant:var(--tblr-primary);--tblr-btn-color:var(--tblr-primary);--tblr-btn-border-color:var(--tblr-primary);--tblr-btn-hover-color:#fff;--tblr-btn-hover-bg:var(--tblr-primary);--tblr-btn-hover-border-color:var(--tblr-primary)}.layout-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.layout-actions .form-select{width:auto;max-width:220px}.filters{grid-template-columns:1fr 1fr 1.3fr .7fr auto}.layout-filters summary{cursor:pointer;min-height:auto}.layout-filters summary::marker{color:var(--tblr-primary)}#freshness{display:none}#schedule{margin:0 0 0 auto;width:min(540px,100%);max-width:100%;height:100%;max-height:100%;padding:0;border:0;border-left:1px solid #dce2e6;background:var(--tblr-body-bg,#fff)}#schedule::backdrop{background:#172b3a55}#schedule .card{min-height:100%;border:0;border-radius:0}#schedule .card-header{display:flex;align-items:center;gap:12px}#schedule .campaign-name{max-width:280px;white-space:normal}#schedule tbody td{vertical-align:top}@media(max-width:600px){header{align-items:flex-start}.layout-actions{width:100%}.layout-actions .form-select{width:100%!important;max-width:none}.layout-actions .btn{width:100%}.filters{grid-template-columns:1fr}#schedule .campaign-name{max-width:200px}}</style>`);
 value=value.replace('</main>',`</main><dialog id="schedule" aria-labelledby="schedule-title"><section class="card"><header class="card-header"><div class="me-auto"><h2 class="card-title" id="schedule-title">Programação</h2><div class="text-secondary small">Agendadas · Todas as datas</div></div><button type="button" id="close-schedule" class="btn btn-outline-secondary">Fechar</button></header><div class="card-body"><span id="schedule-status" role="status" class="text-secondary">Consultando…</span></div><div class="table-responsive"><table class="table card-table"><thead><tr><th>Campanha</th><th>Horário Brasília</th></tr></thead><tbody id="schedule-rows"></tbody></table></div></section></dialog>`);
 return value.replace('</body>','<script src="/app/crm/restrito/inicio-layout.js"></script></body>');
}
function mount(){
 const $=id=>document.getElementById(id),dialog=$('schedule');let sequence=0,loading=false;
 const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const reset=()=>{sequence++;loading=false;$('schedule-rows').replaceChildren();$('schedule-status').textContent='Consultando…';if(dialog.open)dialog.close();};
 const signature=s=>JSON.stringify({id:s.user.id,role:s.user.role,permissions:s.user.permissions,brands:s.user.viewBrands||s.user.brands,fronts:s.user.productWriteFronts});
 async function session(){const r=await fetch('/auth/session',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('ACCESS_CHANGED');const s=await r.json();if(!s.authenticated||typeof s.user?.id!=='string')throw Error('ACCESS_CHANGED');return signature(s);}
 async function open(){
  if(loading)return;const current=++sequence,brand=$('brand').value;loading=true;$('schedule-rows').replaceChildren();$('schedule-status').textContent='Consultando…';dialog.showModal();
  try{
   const actor=await session(),campaigns=new Map();let more=true;
   for(let page=1;more;page++){
    if(page>100)throw Error('INCOMPLETE');
    const r=await fetch('/api/campaigns?'+new URLSearchParams({acao:'campanha_listar',brand,page}),{credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json','X-Shrigma-View-Brand':brand},signal:AbortSignal.timeout(45000)});
    if([401,403].includes(r.status))throw Error('ACCESS_CHANGED');if(!r.ok)throw Error('UNAVAILABLE');
    const v=await r.json();if(!Array.isArray(v.campaigns)||v.page!==page||typeof v.has_more!=='boolean'||v.has_more&&v.campaigns.length===0||v.campaigns.some(c=>c.definition?.brand!==brand))throw Error('INCOMPLETE');
    for(const c of v.campaigns)campaigns.set(c.id,c);more=v.has_more;
    if(current!==sequence||$('brand').value!==brand)return;
   }
   if(actor!==await session())throw Error('ACCESS_CHANGED');if(current!==sequence||$('brand').value!==brand)return;
   const scheduled=[...campaigns.values()].filter(c=>c.status==='scheduled');if(scheduled.some(c=>!Number.isFinite(Date.parse(c.send_at))))throw Error('INCOMPLETE');scheduled.sort((a,b)=>Date.parse(a.send_at)-Date.parse(b.send_at));
   for(const c of scheduled){const tr=node('tr'),name=node('td');name.append(node('strong','#'+c.id),node('div',c.definition.name,'campaign-name text-secondary small'));tr.append(name,node('td',new Date(c.send_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'})));$('schedule-rows').append(tr);}
   $('schedule-status').textContent=scheduled.length?scheduled.length+(scheduled.length===1?' campanha agendada':' campanhas agendadas'):'Nenhuma campanha agendada.';
  }catch(e){if(current!==sequence)return;$('schedule-rows').replaceChildren();if(e.message==='ACCESS_CHANGED'){reset();return;}$('schedule-status').textContent='Programação indisponível. Tente novamente.';}
  finally{if(current===sequence)loading=false;}
 }
 $('open-schedule').addEventListener('click',open);$('close-schedule').addEventListener('click',reset);dialog.addEventListener('cancel',reset);$('brand').addEventListener('change',reset);
 // Frescor fica no cabeçalho; o horário completo permanece acessível no title.
 const compact=()=>{const p=$('period'),text=p.textContent.replace(/^(?:Fishermans|O Aristocrata) · /,'');if(p.textContent!==text)p.textContent=text;const n=$('revenue-updated');if(n.textContent.startsWith('Receita atualizada ')){const time=n.textContent.match(/\d{2}:\d{2}/)?.[0];n.title=n.textContent+' · '+n.title;n.textContent=time?'Atualizada '+time:'Atualizada';}const chart=window.Chart?.getChart?.($('curve')),unit='Receita ('+$('currency').value+')';if(chart&&chart.options.scales.y.title?.text!==unit){chart.options.scales.y.title={display:true,text:unit};chart.update('none');}const back=document.querySelector('a[href^="/app/crm/"]');if(back)back.href='/app/crm/?brand='+encodeURIComponent($('brand').value);};
 const observer=new MutationObserver(compact);observer.observe($('period'),{childList:true});observer.observe($('revenue-updated'),{childList:true});compact();
}
module.exports={HTML:html(),JS:"'use strict';("+mount.toString()+")();"};
