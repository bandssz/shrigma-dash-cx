/* Published connected journeys, READ only. The source is fluxos_listar /
   shrigma_flow_public_row, not observed message counts or the new graph engine.
   Without the exact brand-scoped BFF capability, no GET is issued.
   GBC.graph is the existing pure projection; its editor/transport is never used. */
'use strict';
const GPR=(()=>{
 const VERSION='crm-published-journey-read-v1',MAX_BYTES=1024*1024;
 const own=(o,k)=>!!o&&Object.prototype.hasOwnProperty.call(o,k);
 const plain=o=>!!o&&typeof o==='object'&&Object.getPrototypeOf(o)===Object.prototype;
 const text=(s,n=500)=>typeof s==='string'&&s.length>0&&s.length<=n&&!/[\x00-\x1f\x7f]/.test(s);
 const dense=(a,n)=>Array.isArray(a)&&a.length<=n&&Array.from({length:a.length},(_,i)=>own(a,i)).every(Boolean);
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const stamp=s=>typeof s==='string'&&s.length<=64&&Number.isFinite(Date.parse(s));
 const unavailable=(reason='definitions_unavailable')=>({state:'unavailable',reason,flows:[],checkedAt:null,write:false});
 function normalize(body,brand,canvas){
  if(!['fish','aristo'].includes(brand)||!plain(body)||!dense(body.flows,200)||!stamp(body.checked_at)||!canvas||typeof canvas.graph!=='function'||typeof canvas.edgesHtml!=='function')return unavailable('response_unavailable');
  const flows=[],keys=new Set();
  for(const f of body.flows){
   if(!plain(f)||!['fish','aristo'].includes(f.brand)||!text(f.key,160)||!f.key.startsWith(f.brand+':')||keys.has(f.key)||!text(f.name)||!text(f.trigger)||!Number.isSafeInteger(f.version)||f.version<1||typeof f.enabled!=='boolean'||typeof f.runtime_ready!=='boolean'||!own(f,'published')||!own(f,'published_version')||!own(f,'journey_kind')||!dense(f.available_steps,64))return unavailable('response_unavailable');
   keys.add(f.key);
   if(f.brand!==brand)return unavailable('brand_mismatch'); // BFF response must be restricted to the requested brand.
   if(f.published===null&&f.published_version===null){flows.push({key:f.key,name:f.name,state:'unavailable',reason:'not_published'});continue;}
   if(!plain(f.published)||!Number.isSafeInteger(f.published_version)||f.published_version<1||f.published_version>f.version||!dense(f.published.steps,64)||!f.published.steps.length||![null,'order','nps'].includes(f.journey_kind))return unavailable('published_definition_unavailable');
   const slots=new Map();
   for(const s of f.available_steps){if(!plain(s)||!text(s.key,160)||slots.has(s.key)||!text(s.name)||!['email','whatsapp'].includes(s.channel))return unavailable('binding_unavailable');slots.set(s.key,s);}
   const seen=new Set();
   for(const s of f.published.steps){
    const slot=plain(s)?slots.get(s.key):null;
    if(!slot||seen.has(s.key)||slot.channel!==s.channel||typeof s.enabled!=='boolean'||typeof s.wait_min!=='number'||!Number.isFinite(s.wait_min)||s.wait_min<0||s.wait_min>525600||s.template_name!==undefined&&!text(s.template_name)||slot.variant!==undefined&&slot.variant!==''&&!['a','b'].includes(slot.variant)||f.journey_kind==='order'&&(!text(slot.entry_key,160)||!text(slot.entry_label)))return unavailable('binding_unavailable');
    if(f.journey_kind==='nps'&&!['nps-d0','nps-d3'].includes(s.piece))return unavailable('binding_unavailable');
    seen.add(s.key);
   }
   if(f.published.layout!==undefined){
    const layout=f.published.layout;
    if(!plain(layout)||!plain(layout.nodes)||Object.keys(layout.nodes).length>300)return unavailable('layout_unavailable');
    for(const p of Object.values(layout.nodes))if(!plain(p)||![p.x,p.y].every(n=>Number.isFinite(n)&&Math.abs(n)<=10000))return unavailable('layout_unavailable');
   }
   let graph;try{graph=canvas.graph(f,f.published);}catch{return unavailable('graph_unavailable');}
   if(!graph||!dense(graph.nodes,300)||!dense(graph.edges,600)||!graph.edges.length)return unavailable('graph_unavailable');
   const ids=new Set();for(const n of graph.nodes){if(!plain(n)||!text(n.id,320)||ids.has(n.id)||!text(n.title)||!['trigger','wait','branch','end','email','whatsapp'].includes(n.type)||![n.x,n.y].every(v=>Number.isFinite(v)&&Math.abs(v)<=100000))return unavailable('graph_unavailable');ids.add(n.id);}
   if(graph.edges.some(e=>!plain(e)||!ids.has(e.from)||!ids.has(e.to)))return unavailable('graph_unavailable');
   let edgeMarkup;try{edgeMarkup=canvas.edgesHtml(graph).replaceAll('url(#flow-arrow)','url(#jpr-flow-arrow)');}catch{return unavailable('graph_unavailable');}
   flows.push({key:f.key,name:f.name,state:'published',version:f.published_version,enabled:f.enabled,runtimeReady:f.runtime_ready,steps:f.published.steps.map(s=>({...s})),edgeMarkup,graph});
  }
  return {state:'loaded',reason:null,flows,checkedAt:body.checked_at,write:false};
 }
 function createView(canvas){
  let model=null,key=null,views=new Map();
  const flow=()=>model?.flows.find(f=>f.key===key),state=()=>views.get(key);
  return {sync(next){if(next!==model){model=next;views=new Map();key=next.flows.find(f=>f.state==='published')?.key||next.flows[0]?.key||null;}if(key&&!views.has(key))views.set(key,{x:60,y:100,z:.8,node:null,expanded:false,hand:false});return state();},flow,state,
   select(next){if(model?.flows.some(f=>f.key===next)){key=next;if(!views.has(key))views.set(key,{x:60,y:100,z:.8,node:null,expanded:false,hand:false});}},
   inspect(id){const v=state();if(v)v.node=flow()?.graph?.nodes.some(n=>n.id===id)?id:null;},
   pan(x,y){const v=state();if(v&&Number.isFinite(x)&&Number.isFinite(y)){v.x+=x;v.y+=y;}},
   zoom(z,x,y){const v=state();if(v&&[z,x,y].every(Number.isFinite))Object.assign(v,canvas.zoomAt(v,z,x,y));},
   fit(width,height){const v=state(),f=flow();if(!v||!f?.graph)return;const b=canvas.bounds(f.graph.nodes),w=Math.max(300,width-(v.node?330:0)),h=Math.max(180,height-220),z=canvas.clamp(Math.min((w-100)/(b.right-b.x),h/(b.bottom-b.y)),.15,1);Object.assign(v,{x:(w-(b.right-b.x)*z)/2-b.x*z,y:70+(h-(b.bottom-b.y)*z)/2-b.y*z,z});},
   map(width=800,height=620){const f=flow(),v=state();if(!f?.graph||!v)return null;const b=canvas.bounds(f.graph.nodes),scale=Math.min(180/(b.right-b.x+100),110/(b.bottom-b.y+100)),ox=(200-(b.right-b.x)*scale)/2,oy=(130-(b.bottom-b.y)*scale)/2;return {b,scale,ox,oy,html:f.graph.nodes.map(n=>'<rect x="'+(ox+(n.x-b.x)*scale)+'" y="'+(oy+(n.y-b.y)*scale)+'" width="'+(240*scale)+'" height="'+(112*scale)+'" rx="2" class="map-node '+n.type+'"/>').join('')+'<rect class="map-window" x="'+(ox+(-v.x/v.z-b.x)*scale)+'" y="'+(oy+(-v.y/v.z-b.y)*scale)+'" width="'+width/v.z*scale+'" height="'+height/v.z*scale+'"/>'};},
   mapTo(x,y,width,height){const m=this.map(width,height),v=state();if(m&&v)Object.assign(v,{x:width/2-((x-m.ox)/m.scale+m.b.x)*v.z,y:height/2-((y-m.oy)/m.scale+m.b.y)*v.z});}
  };
 }
 function nodeHtml(n,selected){return '<button type="button" class="flow-node flow-node-'+n.type+(n.enabled===false?' is-off':'')+(selected===n.id?' selected':'')+'" style="left:'+n.x+'px;top:'+n.y+'px" data-jpr-node="'+esc(n.id)+'" aria-pressed="'+(selected===n.id)+'" aria-label="'+esc(n.title)+'. Somente leitura. Abrir detalhes" title="Ver detalhes publicados"><i class="flow-port input"></i><span class="flow-node-icon">'+({trigger:'↯',wait:'◷',branch:'◇',end:'✓',whatsapp:'◉',email:'✉'}[n.type])+'</span><span class="flow-node-copy"><small>'+({trigger:'GATILHO',wait:'ESPERA',branch:'CONDIÇÃO',end:'SAÍDA',whatsapp:'WHATSAPP',email:'E-MAIL'}[n.type])+'</small><strong>'+esc(n.title)+'</strong><span>'+esc(n.subtitle)+'</span></span>'+(n.enabled===false?'<b class="flow-off">Pausada</b>':'')+'<i class="flow-port output"></i></button>';}
 function html(model,view){
  if(model.state!=='loaded')return '<p class="jpr-unavailable">Fluxograma publicado indisponível nesta leitura. O histórico de mensagens não declara conexões, gatilhos nem esperas.</p>';
  if(!model.flows.length)return '<p class="jpr-unavailable">Nenhuma jornada publicada retornada para esta marca nesta consulta. Isso não comprova ausência de automações.</p>';
  const f=view?.flow()||model.flows.find(f=>f.state==='published')||model.flows[0],v=view?.state()||{x:60,y:100,z:.8},g=f.graph;
  const picker='<label class="builder-flow-label">Jornada <select data-jpr-picker>'+model.flows.map(x=>'<option value="'+esc(x.key)+'"'+(x.key===f.key?' selected':'')+'>'+esc(x.name)+'</option>').join('')+'</select></label>';
  let body='<p>Versão publicada indisponível. Nenhum rascunho foi usado como configuração publicada.</p>';
  if(g){const n=g.nodes.find(n=>n.id===v.node),step=n?.stepIndex!==undefined?f.steps[n.stepIndex]:null;
   const inspector=n?'<aside class="flow-inspector"><header><span>Detalhes publicados</span><button type="button" data-jpr-action="close" aria-label="Fechar detalhes">×</button></header><div class="flow-inspector-content"><h3>'+esc(n.title)+'</h3><p>'+esc(n.detail||n.subtitle)+'</p>'+(step?'<dl><dt>Canal</dt><dd>'+esc(step.channel)+'</dd><dt>Espera desde o gatilho</dt><dd>'+esc(step.wait_min)+' min</dd><dt>Template publicado</dt><dd>'+esc(step.template_name||'Não informado')+'</dd><dt>Configuração</dt><dd>'+(step.enabled?'Habilitada':'Pausada')+'</dd></dl>':'')+'<p class="flow-inspector-note">Somente leitura. A publicação não comprova entrega.</p></div></aside>':'';
   const button=(action,label,title)=>'<button type="button" data-jpr-action="'+action+'" title="'+title+'" aria-label="'+title+'">'+label+'</button>';
   body='<div class="flow-workspace '+(v.expanded?'is-expanded':'')+'"><div class="flow-viewport '+(v.hand?'hand-mode':'')+'" data-jpr-viewport tabindex="0" aria-label="Mapa publicado. Arraste o fundo para navegar. F enquadra, mais e menos ampliam."><div class="flow-world" data-jpr-world style="transform:translate('+v.x+'px,'+v.y+'px) scale('+v.z+')"><svg class="flow-wires" width="1" height="1" aria-hidden="true"><defs><marker id="jpr-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a4afc0"/></marker></defs>'+f.edgeMarkup+'</svg>'+g.nodes.map(n=>nodeHtml(n,v.node)).join('')+'</div></div><div class="flow-tools">'+button('select','↖','Selecionar detalhes')+button('hand','✥','Navegar pelo mapa')+'</div>'+button('expand',v.expanded?'↙ Sair da tela cheia':'↗ Tela cheia',v.expanded?'Sair da tela cheia':'Tela cheia').replace('type="button"','type="button" class="flow-expand"')+'<div class="flow-zoom">'+button('out','−','Diminuir zoom')+button('reset',Math.round(v.z*100)+'%','Zoom 100%')+button('in','+','Aumentar zoom')+button('fit','Enquadrar','Enquadrar jornada')+'</div><div class="flow-navigation-hint">Arraste o fundo para navegar · Ctrl/Cmd + rolagem amplia</div><svg class="flow-minimap" data-jpr-minimap viewBox="0 0 200 130" role="button" tabindex="0" aria-label="Minimapa. Clique para navegar, Enter para enquadrar">'+(view?.map()?.html||'')+'</svg>'+inspector+'</div>';
  }
  return '<div class="builder-layout builder-visual"><main class="builder-main '+(v.expanded?'jpr-expanded':'')+'"><header class="builder-header"><div>'+picker+'<h3 class="builder-title">'+esc(f.name)+'</h3><div class="builder-status">'+(g?'Versão publicada '+f.version+' · '+(f.enabled?'configuração habilitada':'configuração pausada')+' · '+(f.runtimeReady?'vínculo de execução declarado':'vínculo de execução não declarado'):'Publicação indisponível')+'</div></div></header>'+body+'</main></div>';
 }
 function admission(api,origin){
  const w=api?.capabilities?.workflows,endpoint=api?.capabilities?.endpoints?.templates;
  if(!plain(w)||w.published_read_contract!==VERSION||w.published_read!==true||w.published_read_scope!=='master-brand-scoped'||typeof endpoint!=='string')return null;
  let u;try{u=new URL(endpoint,origin);}catch{return null;}
  return u.origin===origin&&u.pathname==='/api/templates'&&!u.search&&!u.hash&&!u.username&&!u.password&&u.href===origin+'/api/templates'?u.href:null;
 }
 async function readBody(response){
  const reader=response.body?.getReader();if(!reader)throw Error('read_unavailable');const parts=[];let size=0;
  try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw Error('read_unavailable');}parts.push(r.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }
 function create({fetchImpl,canvas,origin,onChange=()=>{}}){
  let ctx=null,sequence=0,abort=null,model=unavailable(),busy=false,endpoint=null;
  const active=c=>!!c&&c.section==='regua'&&c.tab==='fluxos'&&['fish','aristo'].includes(c.marca);
  // A visible button offers a CURRENT access check, never a permission claim.
  const consultable=()=>active(ctx);
  function invalidate(){sequence++;abort?.abort();abort=null;busy=false;model=unavailable();}
  function sync(next){
   const nextEndpoint=admission(next?.api,origin),changed=!ctx||ctx.api!==next?.api||ctx.marca!==next?.marca||endpoint!==nextEndpoint||active(ctx)!==active(next);
   if(changed)invalidate();ctx=next;endpoint=nextEndpoint;return {model,busy,available:consultable()};
  }
  async function refresh(){
   if(busy||!consultable()||typeof fetchImpl!=='function')return false;
   const ticket=++sequence,at={api:ctx.api,marca:ctx.marca},target=origin+'/api/templates',controller=new AbortController();abort=controller;const signal=controller.signal;busy=true;model=unavailable();onChange();
   let expire;const deadline=new Promise((_,reject)=>{expire=()=>{controller.abort();reject(Error('read_unavailable'));};});const timeout=setTimeout(expire,20000);
   const requestUrl=target+'?acao=fluxos_listar&marca='+at.marca;
   try{
    const capabilityUrl=target+'?acao=fluxos_capacidade&marca='+at.marca;
    const capabilityResponse=await Promise.race([fetchImpl(capabilityUrl,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal}),deadline]);
    if(!capabilityResponse.ok||capabilityResponse.url&&capabilityResponse.url!==capabilityUrl)throw Error('read_unavailable');
    const proof=await Promise.race([readBody(capabilityResponse),deadline]);
    if(!plain(proof)||Object.keys(proof).sort().join(',')!=='brand,contract,endpoint,read,readOnly,scope,write'||proof.contract!==VERSION||proof.brand!==at.marca||proof.read!==true||proof.endpoint!==target||proof.scope!=='master-brand-scoped'||proof.readOnly!==true||proof.write!==false)throw Error('read_unavailable');
    if(ticket!==sequence||ctx?.api!==at.api||ctx?.marca!==at.marca||!active(ctx))return false;
    const r=await Promise.race([fetchImpl(requestUrl,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal}),deadline]);
    if(!r.ok||r.url&&r.url!==requestUrl)throw Error('read_unavailable');
    const body=await Promise.race([readBody(r),deadline]);
    if(ticket!==sequence||ctx?.api!==at.api||ctx?.marca!==at.marca||!active(ctx))return false;
    model=normalize(body,ctx.marca,canvas);return model.state==='loaded';
   }catch{if(ticket===sequence)model=unavailable('read_unavailable');return false;}
   finally{clearTimeout(timeout);if(ticket===sequence){busy=false;abort=null;onChange();}}
  }
  return Object.freeze({sync,refresh,state:()=>({model,busy,available:consultable()}),dispose(){invalidate();ctx=null;endpoint=null;}});
 }
 let browser=null,view=null;
 function sync(ctx){
  if(typeof window==='undefined'||typeof document==='undefined')return;
  if(!browser){if(typeof window.fetch!=='function'||typeof window.location?.origin!=='string'||!window.location.origin)return;browser=create({fetchImpl:window.fetch.bind(window),canvas:typeof GBC==='undefined'?null:GBC,origin:window.location.origin,onChange:()=>paint()});window.addEventListener('pagehide',()=>{browser.dispose();paint();});}
  browser.sync(ctx);if(!view&&typeof GBC!=='undefined')view=createView(GBC);paint();
 }
 function paint(){
  const root=document.getElementById('jpr-published');if(!root||!browser)return;const s=browser.state();view?.sync(s.model);
  root.innerHTML='<header><h2>Fluxograma publicado · somente leitura</h2><button type="button" class="refresh-btn" data-jpr-read'+(!s.available||s.busy?' disabled':'')+'>'+(s.busy?'Consultando…':s.available&&s.model.state!=='loaded'?'Verificar acesso e consultar fluxogramas publicados':'Consultar fluxogramas publicados')+'</button></header>'+(s.model.checkedAt?'<p>Consulta recebida em '+esc(s.model.checkedAt)+'.</p>':'')+html(s.model,view);
  bind(root);
  root.querySelector('[data-jpr-read]')?.addEventListener('click',()=>browser.refresh());
 }
 function bind(root){
  const vp=root.querySelector('[data-jpr-viewport]');
  root.querySelector('[data-jpr-picker]')?.addEventListener('change',e=>{view.select(e.target.value);paint();});
  for(const el of root.querySelectorAll?.('[data-jpr-node]')||[])el.addEventListener('click',()=>{view.inspect(el.dataset.jprNode);paint();});
  if(!vp||!view)return;
  const size=()=>vp.getBoundingClientRect(),apply=()=>{const v=view.state(),world=root.querySelector('[data-jpr-world]'),map=root.querySelector('[data-jpr-minimap]'),r=size();if(world)world.style.transform='translate('+v.x+'px,'+v.y+'px) scale('+v.z+')';if(map)map.innerHTML=view.map(r.width,r.height)?.html||'';const reset=root.querySelector('[data-jpr-action="reset"]');if(reset)reset.textContent=Math.round(v.z*100)+'%';};
  const action=a=>{const v=view.state(),r=size();if(a==='fit')view.fit(r.width,r.height);else if(a==='close')view.inspect(null);else if(a==='expand')v.expanded=!v.expanded;else if(a==='hand'||a==='select')v.hand=a==='hand';else view.zoom(a==='reset'?1:v.z*(a==='in'?1.2:1/1.2),r.width/2,r.height/2);paint();};
  for(const el of root.querySelectorAll?.('[data-jpr-action]')||[])el.addEventListener('click',()=>action(el.dataset.jprAction));
  let drag=null,space=false;
  vp.addEventListener('pointerdown',e=>{if(e.button!==0&&e.button!==1||e.target.closest?.('[data-jpr-node]')&&!view.state().hand&&!space&&e.button!==1)return;e.preventDefault();drag={id:e.pointerId,x:e.clientX,y:e.clientY};vp.setPointerCapture?.(e.pointerId);});
  vp.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;view.pan(e.clientX-drag.x,e.clientY-drag.y);drag.x=e.clientX;drag.y=e.clientY;apply();});
  for(const name of ['pointerup','pointercancel','lostpointercapture'])vp.addEventListener(name,()=>{drag=null;});
  vp.addEventListener('wheel',e=>{e.preventDefault();const r=size(),v=view.state();if(e.ctrlKey||e.metaKey)view.zoom(v.z*Math.exp(-e.deltaY*.008),e.clientX-r.left,e.clientY-r.top);else view.pan(-(e.shiftKey?e.deltaY:e.deltaX),e.shiftKey?0:-e.deltaY);apply();},{passive:false});
  vp.addEventListener('keydown',e=>{if(e.target!==vp)return;const k=e.key.toLowerCase();if(k===' '){space=true;e.preventDefault();}else if(['f','+','=','-','escape','h','v'].includes(k)){e.preventDefault();if(k==='escape'){view.inspect(null);view.state().expanded=false;paint();}else action(({f:'fit','+':'in','=':'in','-':'out',h:'hand',v:'select'})[k]);}});
  vp.addEventListener('keyup',e=>{if(e.key===' ')space=false;});vp.addEventListener('blur',()=>{space=false;drag=null;});
  const map=root.querySelector('[data-jpr-minimap]');map?.addEventListener('click',e=>{const m=map.getBoundingClientRect(),r=size();view.mapTo((e.clientX-m.left)*200/m.width,(e.clientY-m.top)*130/m.height,r.width,r.height);apply();});map?.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();action('fit');}});apply();
 }
 function mount(ctx,root){sync({...ctx,section:'regua',tab:'fluxos'});if(!root||!browser)return;root.querySelector('#jpr-published')?.remove();const el=document.createElement('section');el.id='jpr-published';el.className='jpr-published';el.setAttribute('aria-label','Fluxogramas publicados');root.appendChild(el);paint();}
 function clear(){browser?.dispose();if(typeof document!=='undefined')paint();}
 return Object.freeze({VERSION,normalize,html,createView,nodeHtml,admission,create,sync,mount,clear});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GPR;
