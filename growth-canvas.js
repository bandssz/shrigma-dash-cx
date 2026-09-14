/* Unbounded viewport over the published journey model. Positions are draft metadata;
   edges are derived from executable triggers, timing and routing, never decorative steps. */
'use strict';
const GBC={
 views:{},selected:null,flowKey:null,hand:false,expanded:false,drag:null,palette:false,
 W:240,H:112,
 e:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 clamp:(v,min,max)=>Math.min(max,Math.max(min,v)),
 graph(f,d){
  const nodes=[],edges=[],add=(id,type,title,subtitle,x,y,extra={})=>{const p=d.layout?.nodes?.[id];nodes.push({id,type,title,subtitle,x:Number.isFinite(p?.x)?p.x:x,y:Number.isFinite(p?.y)?p.y:y,...extra});return id;};
  add('trigger','trigger',f.trigger,'Entrada na jornada',0,80);
  const groups=new Map();d.steps.forEach((s,index)=>{const w=Number(s.wait_min)||0;if(!groups.has(w))groups.set(w,[]);groups.get(w).push({s,index,slot:f.available_steps.find(t=>t.key===s.key)||s});});
  let y=0;
  for(const [wait,items] of [...groups.entries()].sort((a,b)=>a[0]-b[0])){
   // Stable stage-based identity keeps the wait node position when its duration changes.
   const anchor=items.map(i=>i.s.key).sort()[0],wid='wait:'+anchor;
   let parent='trigger';
   if(wait>0){parent=add(wid,'wait',GBC.duration(wait),'Desde o gatilho',330,y,{stepIndex:items[0].index});edges.push({from:'trigger',to:parent});}
   const alternatives=items.filter(i=>i.slot.variant||i.slot.source_template_id),parallel=items.filter(i=>!alternatives.includes(i));
   let row=y;
   if(alternatives.length){
    const carrier=alternatives.some(i=>i.slot.source_template_id),bid='branch:'+alternatives.map(i=>i.s.key).sort()[0];
    add(bid,'branch',carrier?'Qual transportadora?':'Distribuir variante A/B',carrier?'Uma rota por pedido':'Uma variante por carrinho',wait?650:330,row,{members:alternatives.map(i=>'step:'+i.s.key)});edges.push({from:parent,to:bid});
    for(const i of alternatives){const id=add('step:'+i.s.key,i.s.channel,i.slot.name,i.s.template_name||'Mensagem de atendimento',wait?980:650,row,{stepIndex:i.index,enabled:i.s.enabled});edges.push({from:bid,to:id,label:i.slot.variant?'Variante '+i.slot.variant.toUpperCase():i.slot.name});row+=170;}
   }
   for(const i of parallel){const id=add('step:'+i.s.key,i.s.channel,i.slot.name,i.s.template_name||'Mensagem de atendimento',wait?650:330,row,{stepIndex:i.index,enabled:i.s.enabled});edges.push({from:parent,to:id});row+=170;}
   y=Math.max(row,y+170)+80;
  }
  return {nodes,edges};
 },
 duration(m){return m>=60&&m%60===0?(m/60)+' h':m+' min';},
 bounds(nodes){return {x:Math.min(...nodes.map(n=>n.x),0),y:Math.min(...nodes.map(n=>n.y),0),right:Math.max(...nodes.map(n=>n.x+GBC.W),GBC.W),bottom:Math.max(...nodes.map(n=>n.y+GBC.H),GBC.H)};},
 worldPoint(view,x,y){return {x:(x-view.x)/view.z,y:(y-view.y)/view.z};},
 zoomAt(view,z,x,y){const p=GBC.worldPoint(view,x,y);z=GBC.clamp(z,.15,2);return {x:x-p.x*z,y:y-p.y*z,z};},
 edgePath(a,b){const x=a.x+GBC.W,y=a.y+GBC.H/2,ex=b.x,ey=b.y+GBC.H/2,dx=Math.max(70,Math.abs(ex-x)*.5);return `M ${x} ${y} C ${x+dx} ${y}, ${ex-dx} ${ey}, ${ex} ${ey}`;},
 edgesHtml(graph){return graph.edges.map((edge,i)=>{const a=graph.nodes.find(n=>n.id===edge.from),b=graph.nodes.find(n=>n.id===edge.to);return `<g><path class="flow-edge" d="${GBC.edgePath(a,b)}" marker-end="url(#flow-arrow)"></path>${edge.label?`<text class="flow-edge-label" x="${a.x+GBC.W+18}" y="${b.y+GBC.H/2-12}">${GBC.e(edge.label)}</text>`:''}</g>`;}).join('');},
 nodeHtml(n){const icon={trigger:'↯',wait:'◷',branch:'◇',whatsapp:'◉',email:'✉'}[n.type];return `<button type="button" class="flow-node flow-node-${n.type} ${n.enabled===false?'is-off':''} ${GBC.selected===n.id?'selected':''}" style="left:${n.x}px;top:${n.y}px" data-flow-node="${GBC.e(n.id)}" aria-label="${GBC.e(n.title)}. Arraste para mover" title="Clique para configurar" tabindex="0"><i class="flow-port input"></i><span class="flow-node-icon">${icon}</span><span class="flow-node-copy"><small>${{trigger:'GATILHO',wait:'ESPERA',branch:'CONDIÇÃO',whatsapp:'WHATSAPP',email:'E-MAIL'}[n.type]}</small><strong>${GBC.e(n.title)}</strong><span>${GBC.e(n.subtitle)}</span></span>${n.enabled===false?'<b class="flow-off">Pausada</b>':''}<i class="flow-port output"></i></button>`;},
 html(f,d){
  if(GBC.flowKey!==f.key){GBC.selected=null;GBC.palette=false;GBC.flowKey=f.key;}
  const g=GBC.graph(f,d),v=GBC.views[f.key]||{x:60,y:100,z:.8};GBC.views[f.key]=v;GBC.model=g;
  return `<div class="flow-workspace ${GBC.expanded?'is-expanded':''}" id="flow-workspace"><div class="flow-viewport ${GBC.hand?'hand-mode':''}" id="flow-viewport" tabindex="0" aria-label="Canvas do fluxo. Espaço e arrastar para navegar. Mais e menos para zoom, F para enquadrar."><div class="flow-world" id="flow-world"><svg class="flow-wires" width="1" height="1" aria-hidden="true"><defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a4afc0"></path></marker></defs><g id="flow-edges">${GBC.edgesHtml(g)}</g></svg>${g.nodes.map(GBC.nodeHtml).join('')}</div></div>
   <div class="flow-tools"><button type="button" id="flow-select" class="${!GBC.hand?'active':''}" title="Selecionar e mover blocos (V)" aria-label="Selecionar e mover blocos">↖</button><button type="button" id="flow-hand" class="${GBC.hand?'active':''}" title="Mover canvas (H ou espaço)" aria-label="Mover canvas">✥</button><span></span><button type="button" id="flow-add" class="flow-add-button">+ Adicionar bloco</button><button type="button" id="flow-arrange" title="Organizar automaticamente">Organizar</button></div>
   <button class="flow-expand" type="button" id="flow-expand" aria-label="${GBC.expanded?'Sair da tela cheia':'Tela cheia'}">${GBC.expanded?'↙ Sair da tela cheia':'↗ Tela cheia'}</button>
   <div class="flow-zoom"><button type="button" id="flow-zoom-out" aria-label="Diminuir zoom">−</button><button type="button" id="flow-reset" title="Zoom de 100%">100%</button><button type="button" id="flow-zoom-in" aria-label="Aumentar zoom">+</button><span></span><button type="button" id="flow-fit" title="Enquadrar fluxo (F)">Enquadrar</button></div>
   <div class="flow-navigation-hint">Arraste o fundo para navegar · scroll para mover · Ctrl/⌘ + scroll para zoom</div>
   <svg class="flow-minimap" id="flow-minimap" viewBox="0 0 200 130" aria-label="Minimapa. Clique para navegar." role="img"></svg>
   ${GBC.inspector(f,d,g)}${GBC.palette?GBC.paletteHtml(f,d):''}</div>`;
 },
 inspector(f,d,g){
  const n=g.nodes.find(n=>n.id===GBC.selected);if(!n)return '';
  let inner='';
  if(n.stepIndex!==undefined)inner=`<ul class="flow-inspector-fields">${GB.stepHtml(d.steps[n.stepIndex],n.stepIndex,f)}</ul><p class="flow-inspector-note">As esperas são contadas desde o gatilho. Compra, descadastro e validade são conferidos antes do envio.</p>`;
  else if(n.type==='trigger')inner=`<div class="flow-inspector-content"><h3>${GBC.e(f.trigger)}</h3><p>Este evento inicia a jornada. Cada ramo segue seu tempo e suas condições.</p><p>Arraste os blocos para organizar o desenho. Salvar rascunho conserva a posição deles.</p></div>`;
  else inner=`<div class="flow-inspector-content"><p>${n.subtitle==='Uma variante por carrinho'?'Cada carrinho segue a variante A ou B definida pela distribuição atual.':'O pedido segue uma das rotas abaixo conforme os dados de rastreio.'}</p>${(n.members||[]).map(id=>`<button type="button" data-flow-jump="${GBC.e(id)}">${GBC.e(g.nodes.find(x=>x.id===id)?.title)}</button>`).join('')}<p>As conexões representam as rotas executadas pela jornada.</p></div>`;
  return `<aside class="flow-inspector"><header><span>${n.type==='wait'?'Configurar espera':n.type==='branch'?'Rotas do fluxo':n.type==='trigger'?'Gatilho':'Configurar mensagem'}</span><button type="button" id="flow-close-inspector" aria-label="Fechar configurações">×</button></header>${inner}</aside>`;
 },
 paletteHtml(f,d){const available=f.available_steps.filter(x=>!d.steps.some(y=>y.key===x.key));return `<aside class="flow-palette"><header><strong>Adicionar à jornada</strong><button type="button" id="flow-close-palette" aria-label="Fechar blocos">×</button></header><p>Arraste um bloco para o canvas ou clique para adicionar.</p>${available.map(s=>`<button type="button" draggable="true" data-flow-add="${GBC.e(s.key)}"><span>${s.channel==='email'?'✉':'◉'}</span><div><strong>${GBC.e(s.name)}</strong><small>${s.channel==='email'?'E-mail':'WhatsApp'} · ${GBC.duration(s.wait_min)}</small></div><b>+</b></button>`).join('')||'<div class="flow-palette-empty">Todas as etapas conectadas a este gatilho já estão no canvas. Se remover uma, ela fica disponível aqui novamente.</div>'}</aside>`;},
 mount(root,f,d){
  const vp=root.querySelector('#flow-viewport');if(!vp)return;
  GBC.vp=vp;GBC.applyView();
  const on=(id,fn)=>root.querySelector('#'+id)?.addEventListener('click',fn);
  on('flow-select',()=>{GBC.hand=false;GB.render();});on('flow-hand',()=>{GBC.hand=true;GB.render();});
  on('flow-add',()=>{GBC.palette=!GBC.palette;GBC.selected=null;GB.render();});on('flow-close-palette',()=>{GBC.palette=false;GB.render();});
  on('flow-close-inspector',()=>{GBC.selected=null;GB.render();});
  on('flow-expand',()=>{GBC.expanded=!GBC.expanded;GB.render();});
  on('flow-zoom-in',()=>GBC.zoom(1.2));on('flow-zoom-out',()=>GBC.zoom(1/1.2));on('flow-reset',()=>GBC.zoom(1/GBC.views[f.key].z));on('flow-fit',()=>GBC.fit());
  on('flow-arrange',()=>{if(GB.state.busy)return;d.layout={version:1,nodes:{}};GB.change();GB.render();GBC.fit();});
  root.querySelectorAll('[data-flow-add]').forEach(b=>{b.onclick=()=>GBC.add(b.dataset.flowAdd);b.ondragstart=e=>e.dataTransfer.setData('application/x-growth-stage',b.dataset.flowAdd);});
  root.querySelectorAll('[data-flow-jump]').forEach(b=>b.onclick=()=>{GBC.selected=b.dataset.flowJump;GB.render();GBC.center(GBC.model.nodes.find(n=>n.id===GBC.selected));});
  vp.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('application/x-growth-stage'))e.preventDefault();});
  vp.addEventListener('drop',e=>{const key=e.dataTransfer.getData('application/x-growth-stage');if(!key)return;e.preventDefault();const r=vp.getBoundingClientRect();GBC.add(key,GBC.worldPoint(GBC.views[f.key],e.clientX-r.left,e.clientY-r.top));});
  vp.addEventListener('wheel',e=>{e.preventDefault();const v=GBC.views[f.key],r=vp.getBoundingClientRect();if(e.ctrlKey||e.metaKey)GBC.views[f.key]=GBC.zoomAt(v,v.z*Math.exp(-e.deltaY*.008),e.clientX-r.left,e.clientY-r.top);else{v.x-=e.shiftKey?e.deltaY:e.deltaX;v.y-=e.shiftKey?0:e.deltaY;}GBC.applyView();},{passive:false});
  vp.addEventListener('pointerdown',e=>{
   if(e.button!==0&&e.button!==1)return;const el=e.target.closest('[data-flow-node]'),n=el?GBC.model.nodes.find(n=>n.id===el.dataset.flowNode):null;
   if(GB.state.busy&&n)return;e.preventDefault();vp.focus({preventScroll:true});vp.setPointerCapture?.(e.pointerId);
   const pan=GBC.hand||GBC.space||e.button===1||!n;GBC.drag={pointer:e.pointerId,startX:e.clientX,startY:e.clientY,pan,node:pan?null:n,x:pan?GBC.views[f.key].x:n.x,y:pan?GBC.views[f.key].y:n.y,moved:false};vp.classList.add('dragging');
  });
  vp.addEventListener('pointermove',e=>{const drag=GBC.drag;if(!drag||drag.pointer!==e.pointerId)return;const dx=e.clientX-drag.startX,dy=e.clientY-drag.startY;if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;if(!drag.moved)return;
   if(drag.pan){GBC.views[f.key].x=drag.x+dx;GBC.views[f.key].y=drag.y+dy;GBC.applyView();}
   else{drag.node.x=GBC.clamp(Math.round((drag.x+dx/GBC.views[f.key].z)/10)*10,-1000000,1000000);drag.node.y=GBC.clamp(Math.round((drag.y+dy/GBC.views[f.key].z)/10)*10,-1000000,1000000);GBC.drawPositions();}
  });
  const end=e=>{const drag=GBC.drag;if(!drag||drag.pointer!==e.pointerId)return;GBC.drag=null;vp.classList.remove('dragging');
   if(drag.node&&drag.moved){GBC.storePosition(d,drag.node);GB.change();GB.refreshActions();}
   else if(drag.node){GBC.selected=drag.node.id;GBC.palette=false;GB.render();}
   else if(!drag.moved&&GBC.selected){GBC.selected=null;GB.render();}
   if(GBC.pendingRender){GBC.pendingRender=false;GB.render();}
  };vp.addEventListener('pointerup',end);vp.addEventListener('pointercancel',end);
  vp.addEventListener('keydown',e=>{if(e.target.matches('input,textarea,select'))return;if(e.code==='Space'){e.preventDefault();GBC.space=true;vp.classList.add('space-pan');}else if(e.key==='Escape'){GBC.selected=null;GBC.palette=false;GBC.expanded=false;GB.render();}else if(e.key.toLowerCase()==='f'){e.preventDefault();GBC.fit();}else if(['+','='].includes(e.key))GBC.zoom(1.2);else if(e.key==='-')GBC.zoom(1/1.2);else if(e.key.toLowerCase()==='h'){GBC.hand=true;GB.render();}else if(e.key.toLowerCase()==='v'){GBC.hand=false;GB.render();}else if(e.target.dataset.flowNode&&['Enter',' '].includes(e.key)){GBC.selected=e.target.dataset.flowNode;GB.render();}});
  vp.addEventListener('keyup',e=>{if(e.code==='Space'){GBC.space=false;vp.classList.remove('space-pan');}});vp.addEventListener('blur',()=>{GBC.space=false;vp.classList.remove('space-pan');});
  root.querySelectorAll('[data-flow-node]').forEach(el=>el.addEventListener('dblclick',()=>{GBC.selected=el.dataset.flowNode;GB.render();}));
  root.querySelector('#flow-minimap')?.addEventListener('pointerdown',e=>{e.preventDefault();const rect=e.currentTarget.getBoundingClientRect(),m=GBC.map;if(!m)return;const x=((e.clientX-rect.left)*200/rect.width-m.ox)/m.scale+m.b.x,y=((e.clientY-rect.top)*130/rect.height-m.oy)/m.scale+m.b.y;GBC.center({x:x-GBC.W/2,y:y-GBC.H/2});});
 },
 storePosition(d,n){if(!d.layout||d.layout.version!==1)d.layout={version:1,nodes:{}};d.layout.nodes=d.layout.nodes||{};d.layout.nodes[n.id]={x:n.x,y:n.y};},
 add(key,point){if(GB.state.busy)return;const f=GB.state.flows.find(x=>x.key===GB.state.selected),d=GB.state.draft,slot=f.available_steps.find(x=>x.key===key);if(!slot||d.steps.some(x=>x.key===key))return;const step=GB.clone(slot),sibling=slot.variant&&d.steps.find(s=>s.channel===slot.channel&&s.piece===slot.piece&&s.variant);if(sibling)step.wait_min=sibling.wait_min;d.steps.push(step);if(point)GBC.storePosition(d,{id:'step:'+key,x:Math.round(point.x/10)*10,y:Math.round(point.y/10)*10});GBC.selected='step:'+key;GBC.palette=false;GB.change();GB.render();if(!point)GBC.center(GBC.model.nodes.find(n=>n.id===GBC.selected));},
 drawPositions(){if(!GBC.vp)return;GBC.vp.querySelectorAll('[data-flow-node]').forEach(el=>{const n=GBC.model.nodes.find(n=>n.id===el.dataset.flowNode);if(n){el.style.left=n.x+'px';el.style.top=n.y+'px';}});const edges=GBC.vp.querySelector('#flow-edges');if(edges)edges.innerHTML=GBC.edgesHtml(GBC.model);GBC.minimap();},
 redraw(){const f=GB.state.flows.find(x=>x.key===GB.state.selected);if(!f||!GBC.vp)return;GBC.model=GBC.graph(f,GB.state.draft);const world=GBC.vp.querySelector('#flow-world'),svg=world?.querySelector('svg');if(!world||!svg)return;world.querySelectorAll('[data-flow-node]').forEach(n=>n.remove());world.insertAdjacentHTML('beforeend',GBC.model.nodes.map(GBC.nodeHtml).join(''));GBC.drawPositions();},
 applyView(){const v=GBC.views[GBC.flowKey],vp=GBC.vp;if(!vp||!v)return;const world=vp.querySelector('#flow-world');if(world)world.style.transform=`translate(${v.x}px,${v.y}px) scale(${v.z})`;vp.style.backgroundSize=`${24*v.z}px ${24*v.z}px`;vp.style.backgroundPosition=`${v.x}px ${v.y}px`;const label=document.querySelector('#flow-reset');if(label)label.textContent=Math.round(v.z*100)+'%';GBC.minimap();},
 zoom(factor){const r=GBC.vp.getBoundingClientRect(),v=GBC.views[GBC.flowKey];GBC.views[GBC.flowKey]=GBC.zoomAt(v,v.z*factor,r.width/2,r.height/2);GBC.applyView();},
 fit(){const r=GBC.vp.getBoundingClientRect(),b=GBC.bounds(GBC.model.nodes),width=Math.max(300,r.width-(GBC.selected?330:0)),z=GBC.clamp(Math.min((width-100)/(b.right-b.x),(r.height-150)/(b.bottom-b.y)),.15,1);GBC.views[GBC.flowKey]={x:(width-(b.right-b.x)*z)/2-b.x*z,y:(r.height-(b.bottom-b.y)*z)/2-b.y*z,z};GBC.applyView();},
 center(n){if(!n)return;const r=GBC.vp.getBoundingClientRect(),v=GBC.views[GBC.flowKey];v.x=(r.width-(GBC.selected?330:0))/2-(n.x+GBC.W/2)*v.z;v.y=r.height/2-(n.y+GBC.H/2)*v.z;GBC.applyView();},
 minimap(){const el=document.querySelector('#flow-minimap');if(!el||!GBC.model)return;const b=GBC.bounds(GBC.model.nodes),scale=Math.min(180/(b.right-b.x+100),110/(b.bottom-b.y+100)),ox=(200-(b.right-b.x)*scale)/2,oy=(130-(b.bottom-b.y)*scale)/2,v=GBC.views[GBC.flowKey],r=GBC.vp.getBoundingClientRect();GBC.map={b,scale,ox,oy};el.innerHTML=GBC.model.nodes.map(n=>`<rect x="${ox+(n.x-b.x)*scale}" y="${oy+(n.y-b.y)*scale}" width="${GBC.W*scale}" height="${GBC.H*scale}" rx="2" class="map-node ${n.type}"/>`).join('')+`<rect x="${ox+(-v.x/v.z-b.x)*scale}" y="${oy+(-v.y/v.z-b.y)*scale}" width="${r.width/v.z*scale}" height="${r.height/v.z*scale}" class="map-window"/>`;},
};
if(typeof module!=='undefined'&&module.exports)module.exports=GBC;
