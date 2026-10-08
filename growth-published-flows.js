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
  if(!['fish','aristo'].includes(brand)||!plain(body)||!dense(body.flows,200)||!stamp(body.checked_at)||!canvas||typeof canvas.graph!=='function')return unavailable('response_unavailable');
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
   flows.push({key:f.key,name:f.name,state:'published',version:f.published_version,enabled:f.enabled,runtimeReady:f.runtime_ready,graph});
  }
  return {state:'loaded',reason:null,flows,checkedAt:body.checked_at,write:false};
 }
 function html(model){
  if(model.state!=='loaded')return '<p class="jpr-unavailable">Fluxograma publicado indisponível nesta leitura. O histórico de mensagens não declara conexões, gatilhos nem esperas.</p>';
  if(!model.flows.length)return '<p class="jpr-unavailable">Nenhuma jornada publicada retornada para esta marca nesta consulta. Isso não comprova ausência de automações.</p>';
  return model.flows.map((f,index)=>{
   if(f.state!=='published')return '<article class="jpr-card"><h3>'+esc(f.name)+'</h3><p>Versão publicada indisponível. Nenhum rascunho foi usado como configuração publicada.</p></article>';
   const g=f.graph,left=Math.min(0,...g.nodes.map(n=>n.x))-30,top=Math.min(0,...g.nodes.map(n=>n.y))-30,right=Math.max(...g.nodes.map(n=>n.x+240))+30,bottom=Math.max(...g.nodes.map(n=>n.y+112))+30,marker='jpr-arrow-'+index;
   const paths=g.edges.map(e=>{const a=g.nodes.find(n=>n.id===e.from),b=g.nodes.find(n=>n.id===e.to),x=a.x+240,y=a.y+56,xx=b.x,yy=b.y+56,m=(x+xx)/2;return '<path d="M '+x+' '+y+' C '+m+' '+y+','+m+' '+yy+','+xx+' '+yy+'" marker-end="url(#'+marker+')" />'+(e.label?'<text x="'+m+'" y="'+((y+yy)/2-10)+'">'+esc(e.label)+'</text>':'');}).join('');
   const nodes=g.nodes.map(n=>'<g transform="translate('+n.x+' '+n.y+')"><rect width="240" height="112" rx="10"/><text x="12" y="22" class="jpr-node-type">'+esc({trigger:'Gatilho',wait:'Espera',branch:'Condição',end:'Saída',email:'E-mail',whatsapp:'WhatsApp'}[n.type])+'</text><text x="12" y="49">'+esc(n.title)+'</text><text x="12" y="75" class="jpr-node-sub">'+esc(n.subtitle)+'</text>'+(n.enabled===false?'<text x="12" y="99" class="jpr-node-sub">Etapa pausada</text>':'')+'<title>'+esc(n.title+'. '+(n.detail||n.subtitle||''))+'</title></g>').join('');
   return '<article class="jpr-card"><h3>'+esc(f.name)+'</h3><p>Versão publicada '+f.version+' · '+(f.enabled?'configuração habilitada':'configuração pausada')+' · '+(f.runtimeReady?'vínculo de execução declarado':'vínculo de execução não declarado')+'. Esta consulta não comprova entrega.</p><div class="jpr-scroll"><svg role="img" aria-label="Fluxograma publicado de '+esc(f.name)+'" width="'+(right-left)+'" height="'+(bottom-top)+'" viewBox="'+[left,top,right-left,bottom-top].join(' ')+'"><defs><marker id="'+marker+'" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs><g class="jpr-edges">'+paths+'</g><g class="jpr-nodes">'+nodes+'</g></svg></div></article>';
  }).join('');
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
  function invalidate(){sequence++;abort?.abort();abort=null;busy=false;model=unavailable();}
  function sync(next){
   const nextEndpoint=admission(next?.api,origin),changed=!ctx||ctx.api!==next?.api||ctx.marca!==next?.marca||endpoint!==nextEndpoint||active(ctx)!==active(next);
   if(changed)invalidate();ctx=next;endpoint=nextEndpoint;return {model,busy,available:active(ctx)&&!!endpoint};
  }
  async function refresh(){
   if(busy||!active(ctx)||!endpoint||typeof fetchImpl!=='function')return false;
   const ticket=++sequence,at={api:ctx.api,marca:ctx.marca},target=endpoint,controller=new AbortController();abort=controller;const signal=controller.signal;busy=true;model=unavailable();onChange();
   let expire;const deadline=new Promise((_,reject)=>{expire=()=>{controller.abort();reject(Error('read_unavailable'));};});const timeout=setTimeout(expire,20000);
   const requestUrl=target+'?acao=fluxos_listar&marca='+at.marca;
   try{
    const r=await Promise.race([fetchImpl(requestUrl,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal}),deadline]);
    if(!r.ok||r.url&&r.url!==requestUrl)throw Error('read_unavailable');
    const body=await Promise.race([readBody(r),deadline]);
    if(ticket!==sequence||ctx?.api!==at.api||ctx?.marca!==at.marca||!active(ctx)||admission(ctx.api,origin)!==target)return false;
    model=normalize(body,ctx.marca,canvas);return model.state==='loaded';
   }catch{if(ticket===sequence)model=unavailable('read_unavailable');return false;}
   finally{clearTimeout(timeout);if(ticket===sequence){busy=false;abort=null;onChange();}}
  }
  return Object.freeze({sync,refresh,state:()=>({model,busy,available:active(ctx)&&!!endpoint}),dispose(){invalidate();ctx=null;endpoint=null;}});
 }
 let browser=null;
 function sync(ctx){
  if(typeof window==='undefined'||typeof document==='undefined')return;
  if(!browser){if(typeof window.fetch!=='function'||typeof window.location?.origin!=='string'||!window.location.origin)return;browser=create({fetchImpl:window.fetch.bind(window),canvas:typeof GBC==='undefined'?null:GBC,origin:window.location.origin,onChange:()=>paint()});window.addEventListener('pagehide',()=>{browser.dispose();paint();});}
  browser.sync(ctx);paint();
 }
 function paint(){
  const root=document.getElementById('jpr-published');if(!root||!browser)return;const s=browser.state();
  root.innerHTML='<header><h2>Fluxograma publicado · somente leitura</h2><button type="button" class="refresh-btn" data-jpr-read'+(!s.available||s.busy?' disabled':'')+'>'+(s.busy?'Consultando…':'Consultar fluxogramas publicados')+'</button></header>'+(s.model.checkedAt?'<p>Consulta recebida em '+esc(s.model.checkedAt)+'.</p>':'')+html(s.model);
  root.querySelector('[data-jpr-read]')?.addEventListener('click',()=>browser.refresh());
 }
 function mount(ctx,root){sync({...ctx,section:'regua',tab:'fluxos'});if(!root||!browser)return;root.querySelector('#jpr-published')?.remove();const el=document.createElement('section');el.id='jpr-published';el.className='jpr-published';el.setAttribute('aria-label','Fluxogramas publicados');root.appendChild(el);paint();}
 function clear(){browser?.dispose();if(typeof document!=='undefined')paint();}
 return Object.freeze({VERSION,normalize,html,admission,create,sync,mount,clear});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GPR;
