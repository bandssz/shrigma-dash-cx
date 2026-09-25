/* Unbounded viewport over the published journey model. Positions are draft metadata;
   edges are derived from executable triggers, timing and routing, never decorative steps. */
'use strict';
const GBC={
 views:{},selected:null,flowKey:null,hand:false,expanded:false,drag:null,palette:false,
 W:240,H:112,
 e:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 clamp:(v,min,max)=>Math.min(max,Math.max(min,v)),
 legacyGraph(f,d){
  const nodes=[],edges=[],add=(id,type,title,subtitle,x,y,extra={})=>{const p=d.layout?.nodes?.[id];nodes.push({id,type,title,subtitle,x:Number.isFinite(p?.x)?p.x:x,y:Number.isFinite(p?.y)?p.y:y,...extra});return id;};
  add('trigger','trigger',f.trigger,'Entrada na jornada',0,80);
  const groups=new Map();d.steps.forEach((s,index)=>{const w=Number(s.wait_min)||0;if(!groups.has(w))groups.set(w,[]);groups.get(w).push({s,index,slot:f.available_steps.find(t=>t.key===s.key)||s});});
  let y=0;
  for(const [wait,items] of [...groups.entries()].sort((a,b)=>a[0]-b[0])){
   // Stable stage-based identity keeps the wait node position when its duration changes.
   const anchor=items.map(i=>i.s.key).sort()[0],wid='wait:'+anchor;
   let parent='trigger';
   if(wait>0){parent=add(wid,'wait',GBC.duration(wait),items[0].slot.wait_caption||'Desde o gatilho',330,y,{stepIndex:items[0].index});edges.push({from:'trigger',to:parent});}
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
 graph(f,d){
  if(f.journey_kind==='nps')return GBC.npsGraph(f,d);
  if(f.journey_kind==='order'){
   const nodes=[],edges=[],groups=new Map();
   for(const step of d.steps){const slot=f.available_steps.find(s=>s.key===step.key)||step,key=slot.entry_key||step.key;if(!groups.has(key))groups.set(key,{label:slot.entry_label||slot.name,steps:[]});groups.get(key).steps.push(step);}
   let y=0;
   for(const [key,group] of groups){
    const graph=GBC.legacyGraph({...f,trigger:group.label},{steps:group.steps});
    const id='entry:'+key;
    for(const n of graph.nodes){if(n.id==='trigger'){n.id=id;n.subtitle='Evento independente';n.detail='Este evento inicia apenas este ramo. Não é necessário percorrer os outros estados do pedido.';}n.y+=y;const pos=d.layout?.nodes?.[n.id];if(pos){n.x=pos.x;n.y=pos.y;}nodes.push(n);}
    edges.push(...graph.edges.map(e=>({...e,from:e.from==='trigger'?id:e.from,to:e.to==='trigger'?id:e.to})));
    y+=Math.max(260,graph.nodes.length>2?420:260);
   }
   return {nodes,edges};
  }
  const graph=GBC.legacyGraph(f,d);
  if(f.available_steps.some(s=>s.flow==='carrinho')){
   // Each touch retains its absolute offset from abandonment. This gate represents
   // the existing runtime checks, shared by the channels at that moment.
   for(const wait of graph.nodes.filter(n=>n.type==='wait')){
    const outgoing=graph.edges.filter(e=>e.from===wait.id),id='eligible:'+wait.id;
    const gate={id,type:'branch',title:'Ainda sem compra?',subtitle:'Revalidar antes de cada envio',x:wait.x+330,y:wait.y,detail:'Cada canal confere novamente compra e elegibilidade antes de reservar o envio. Os prazos continuam contados desde o abandono. WhatsApp mantém sua variante A/B.'};
    const members=new Set(outgoing.map(e=>e.to));let more=true;while(more){more=false;for(const e of graph.edges)if(members.has(e.from)&&!members.has(e.to)){members.add(e.to);more=true;}}for(const n of graph.nodes)if(members.has(n.id))n.x+=330;
    const pos=d.layout?.nodes?.[id];if(pos){gate.x=pos.x;gate.y=pos.y;}graph.nodes.push(gate);
    for(const e of outgoing){e.from=id;e.label=e.label||'Elegível';}graph.edges.push({from:wait.id,to:id});
    const exit={id:'exit:'+wait.id,type:'end',title:'Encerrar este toque',subtitle:'Compra ou contato inelegível',x:gate.x,y:wait.y-145,detail:'Bloqueio na guarda do canal. Um envio já aceito pelo provedor não pode ser cancelado retroativamente.'};const ep=d.layout?.nodes?.[exit.id];if(ep){exit.x=ep.x;exit.y=ep.y;}graph.nodes.push(exit);graph.edges.push({from:id,to:exit.id,label:'Bloqueado'});
   }
  }
  for(const n of graph.nodes){const p=d.layout?.nodes?.[n.id];if(p){n.x=p.x;n.y=p.y;}}
  return graph;
 },
 npsGraph(f,d){
  const nodes=[],edges=[],add=(id,type,title,subtitle,x,y,extra={})=>{const p=d.layout?.nodes?.[id];nodes.push({id,type,title,subtitle,x:p?.x??x,y:p?.y??y,...extra});return id;},link=(from,to,label)=>edges.push({from,to,...(label?{label}:{})});
  const initial=d.steps.findIndex(s=>s.piece==='nps-d0'),reminder=d.steps.findIndex(s=>s.piece==='nps-d3');
  add('trigger','trigger','Pedido elegível','Entrada na pesquisa',0,80);
  if(initial>=0){const st=d.steps[initial];add('step:'+st.key,'email','Enviar pesquisa',st.template_name,330,80,{stepIndex:initial,enabled:st.enabled});link('trigger','step:'+st.key);}
  if(reminder>=0){
   const st=d.steps[reminder];
   add('prior','trigger','Pesquisas já registradas','Continuidade dos pedidos anteriores',0,370,{detail:'Pesquisas anteriores continuam elegíveis conforme registro, resposta e confirmação do envio. A unificação não reinicia contatos nem reenvia a pesquisa.'});
   add('confirmed','branch','Pesquisa confirmada?','Mesmo pedido, marca e contato',330,370,{detail:'Exige registro de aceite inicial e bloqueia estado incerto/rejeitado ou falha definitiva conhecida. Sem confirmação, não envia lembrete.'});link('prior','confirmed');if(initial>=0)link('step:'+d.steps[initial].key,'confirmed');
   add('unconfirmed','end','Aguardar conciliação','Sem lembrete automático',660,150,{detail:'A ausência de confirmação não libera um novo envio. Falhas e resultados incertos precisam ser conciliados.'});link('confirmed','unconfirmed','Não');
   const wid='wait:'+st.key;add(wid,'wait',GBC.duration(Number(st.wait_min)),'Desde o registro da pesquisa',660,370,{stepIndex:reminder});link('confirmed',wid,'Sim');
   add('answered','branch','Respondeu à pesquisa?','Conferir ao selecionar e reservar',990,370,{detail:'Resposta do mesmo pedido bloqueia o lembrete. Seleção diária às 19h de Brasília após completar o prazo. Uma resposta após o compromisso do envio não cancela retroativamente o transporte.'});link(wid,'answered');
   add('responded','end','Respondido','Encerrar lembrete',990,150);link('answered','responded','Sim');
   add('step:'+st.key,'email','Enviar um lembrete',st.template_name,990,620,{stepIndex:reminder,enabled:st.enabled});link('answered','step:'+st.key,'Não · elegível');
   add('done','end','Aguardar resposta','Sem outro reenvio automático',660,620);link('step:'+st.key,'done');
  }
  return {nodes,edges};
 },
 duration(m){return m>=1440&&m%1440===0?(m/1440)+(m===1440?' dia':' dias'):m>=60&&m%60===0?(m/60)+' h':m+' min';},
 bounds(nodes){return {x:Math.min(...nodes.map(n=>n.x),0),y:Math.min(...nodes.map(n=>n.y),0),right:Math.max(...nodes.map(n=>n.x+GBC.W),GBC.W),bottom:Math.max(...nodes.map(n=>n.y+GBC.H),GBC.H)};},
 worldPoint(view,x,y){return {x:(x-view.x)/view.z,y:(y-view.y)/view.z};},
 zoomAt(view,z,x,y){const p=GBC.worldPoint(view,x,y);z=GBC.clamp(z,.15,2);return {x:x-p.x*z,y:y-p.y*z,z};},
 ports(a,b){
  if(b.x>=a.x+GBC.W+30)return {x:a.x+GBC.W,y:a.y+GBC.H/2,ex:b.x,ey:b.y+GBC.H/2,axis:'x',direction:1};
  if(a.x>=b.x+GBC.W+30)return {x:a.x,y:a.y+GBC.H/2,ex:b.x+GBC.W,ey:b.y+GBC.H/2,axis:'x',direction:-1};
  const down=b.y>=a.y;return {x:a.x+GBC.W/2,y:a.y+(down?GBC.H:0),ex:b.x+GBC.W/2,ey:b.y+(down?0:GBC.H),axis:'y',direction:down?1:-1};
 },
 edgePath(a,b){const {x,y,ex,ey,axis,direction}=GBC.ports(a,b),delta=direction*Math.max(40,Math.abs(axis==='x'?ex-x:ey-y)*.5);return axis==='x'?`M ${x} ${y} C ${x+delta} ${y}, ${ex-delta} ${ey}, ${ex} ${ey}`:`M ${x} ${y} C ${x} ${y+delta}, ${ex} ${ey-delta}, ${ex} ${ey}`;},
 edgesHtml(graph){return graph.edges.map(edge=>{const a=graph.nodes.find(n=>n.id===edge.from),b=graph.nodes.find(n=>n.id===edge.to),p=GBC.ports(a,b);return `<g><path class="flow-edge" d="${GBC.edgePath(a,b)}" marker-end="url(#flow-arrow)"></path>${edge.label?`<text class="flow-edge-label" x="${(p.x+p.ex)/2+(p.axis==='y'?14:0)}" y="${(p.y+p.ey)/2-10}" text-anchor="${p.axis==='y'?'start':'middle'}">${GBC.e(edge.label)}</text>`:''}</g>`;}).join('');},
 nodeHtml(n){const icon={trigger:'↯',wait:'◷',branch:'◇',end:'✓',whatsapp:'◉',email:'✉'}[n.type];return `<button type="button" class="flow-node flow-node-${n.type} ${n.enabled===false?'is-off':''} ${GBC.selected===n.id?'selected':''}" style="left:${n.x}px;top:${n.y}px" data-flow-node="${GBC.e(n.id)}" aria-label="${GBC.e(n.title)}. Arraste para mover" title="Clique para configurar" tabindex="0"><i class="flow-port input"></i><span class="flow-node-icon">${icon}</span><span class="flow-node-copy"><small>${{trigger:'GATILHO',wait:'ESPERA',branch:'CONDIÇÃO',end:'SAÍDA',whatsapp:'WHATSAPP',email:'E-MAIL'}[n.type]}</small><strong>${GBC.e(n.title)}</strong><span>${GBC.e(n.subtitle)}</span></span>${n.enabled===false?'<b class="flow-off">Pausada</b>':''}<i class="flow-port output"></i></button>`;},
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
  const slot=n.stepIndex!==undefined?f.available_steps.find(s=>s.key===d.steps[n.stepIndex].key):null;
  if(n.stepIndex!==undefined)inner=`<ul class="flow-inspector-fields">${GB.stepHtml(d.steps[n.stepIndex],n.stepIndex,f)}</ul><p class="flow-inspector-note">${GBC.e(slot?.help_text||'As esperas são contadas desde o gatilho. Compra, descadastro e validade são conferidos antes do envio.')}</p>`;
  else if(n.detail)inner=`<div class="flow-inspector-content"><h3>${GBC.e(n.title)}</h3><p>${GBC.e(n.detail)}</p></div>`;
  else if(n.type==='end')inner=`<div class="flow-inspector-content"><h3>${GBC.e(n.title)}</h3><p>${GBC.e(n.subtitle)}</p></div>`;
  else if(n.type==='trigger')inner=`<div class="flow-inspector-content"><h3>${GBC.e(f.trigger)}</h3><p>${GBC.e(f.available_steps[0]?.help_text||'Este evento inicia a jornada. Cada ramo segue seu tempo e suas condições.')}</p><p>Arraste os blocos para organizar o desenho. Salvar rascunho conserva a posição deles.</p></div>`;
  else inner=`<div class="flow-inspector-content"><p>${n.subtitle==='Uma variante por carrinho'?'Cada carrinho segue a variante A ou B definida pela distribuição atual.':'O pedido segue uma das rotas abaixo conforme os dados de rastreio.'}</p>${(n.members||[]).map(id=>`<button type="button" data-flow-jump="${GBC.e(id)}">${GBC.e(g.nodes.find(x=>x.id===id)?.title)}</button>`).join('')}<p>As conexões representam as rotas executadas pela jornada.</p></div>`;
  return `<aside class="flow-inspector"><header><span>${n.type==='wait'?'Configurar espera':n.type==='branch'?'Condição da jornada':n.type==='trigger'?'Gatilho':n.type==='end'?'Saída da jornada':'Configurar mensagem'}</span><button type="button" id="flow-close-inspector" aria-label="Fechar configurações">×</button></header>${inner}</aside>`;
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
  on('flow-arrange',()=>{if(GB.editingBlocked())return;d.layout={version:1,nodes:{}};GB.change();GB.render();GBC.fit();});
  root.querySelectorAll('[data-flow-add]').forEach(b=>{b.onclick=()=>GBC.add(b.dataset.flowAdd);b.ondragstart=e=>e.dataTransfer.setData('application/x-growth-stage',b.dataset.flowAdd);});
  root.querySelectorAll('[data-flow-jump]').forEach(b=>b.onclick=()=>{GBC.selected=b.dataset.flowJump;GB.render();GBC.center(GBC.model.nodes.find(n=>n.id===GBC.selected));});
  vp.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('application/x-growth-stage'))e.preventDefault();});
  vp.addEventListener('drop',e=>{const key=e.dataTransfer.getData('application/x-growth-stage');if(!key)return;e.preventDefault();const r=vp.getBoundingClientRect();GBC.add(key,GBC.worldPoint(GBC.views[f.key],e.clientX-r.left,e.clientY-r.top));});
  vp.addEventListener('wheel',e=>{e.preventDefault();const v=GBC.views[f.key],r=vp.getBoundingClientRect();if(e.ctrlKey||e.metaKey)GBC.views[f.key]=GBC.zoomAt(v,v.z*Math.exp(-e.deltaY*.008),e.clientX-r.left,e.clientY-r.top);else{v.x-=e.shiftKey?e.deltaY:e.deltaX;v.y-=e.shiftKey?0:e.deltaY;}GBC.applyView();},{passive:false});
  vp.addEventListener('pointerdown',e=>{
   if(e.button!==0&&e.button!==1)return;const el=e.target.closest('[data-flow-node]'),n=el?GBC.model.nodes.find(n=>n.id===el.dataset.flowNode):null;
   if(GB.editingBlocked()&&n)return;e.preventDefault();vp.focus({preventScroll:true});vp.setPointerCapture?.(e.pointerId);
   const pan=GBC.hand||GBC.space||e.button===1||!n;GBC.drag={pointer:e.pointerId,startX:e.clientX,startY:e.clientY,pan,node:pan?null:n,x:pan?GBC.views[f.key].x:n.x,y:pan?GBC.views[f.key].y:n.y,moved:false};vp.classList.add('dragging');
  });
  vp.addEventListener('pointermove',e=>{const drag=GBC.drag;if(!drag||drag.pointer!==e.pointerId)return;const dx=e.clientX-drag.startX,dy=e.clientY-drag.startY;if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;if(!drag.moved)return;
   if(drag.pan){GBC.views[f.key].x=drag.x+dx;GBC.views[f.key].y=drag.y+dy;GBC.applyView();}
   else{drag.node.x=GBC.clamp(Math.round((drag.x+dx/GBC.views[f.key].z)/10)*10,-1000000,1000000);drag.node.y=GBC.clamp(Math.round((drag.y+dy/GBC.views[f.key].z)/10)*10,-1000000,1000000);GBC.drawPositions();}
  });
  const end=e=>{const drag=GBC.drag;if(!drag||drag.pointer!==e.pointerId)return;GBC.drag=null;vp.classList.remove('dragging');
   if(drag.node&&drag.moved&&!GB.editingBlocked()){GBC.storePosition(d,drag.node);GB.change();GB.refreshActions();}
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
 add(key,point){if(GB.editingBlocked())return;const f=GB.state.flows.find(x=>x.key===GB.state.selected),d=GB.state.draft,slot=f.available_steps.find(x=>x.key===key);if(!slot||d.steps.some(x=>x.key===key))return;const step=GB.clone(slot),sibling=slot.variant&&d.steps.find(s=>s.channel===slot.channel&&s.piece===slot.piece&&s.variant);if(sibling)step.wait_min=sibling.wait_min;d.steps.push(step);if(point)GBC.storePosition(d,{id:'step:'+key,x:Math.round(point.x/10)*10,y:Math.round(point.y/10)*10});GBC.selected='step:'+key;GBC.palette=false;GB.change();GB.render();if(!point)GBC.center(GBC.model.nodes.find(n=>n.id===GBC.selected));},
 drawPositions(){if(!GBC.vp)return;GBC.vp.querySelectorAll('[data-flow-node]').forEach(el=>{const n=GBC.model.nodes.find(n=>n.id===el.dataset.flowNode);if(n){el.style.left=n.x+'px';el.style.top=n.y+'px';}});const edges=GBC.vp.querySelector('#flow-edges');if(edges)edges.innerHTML=GBC.edgesHtml(GBC.model);GBC.minimap();},
 redraw(){const f=GB.state.flows.find(x=>x.key===GB.state.selected);if(!f||!GBC.vp)return;GBC.model=GBC.graph(f,GB.state.draft);const world=GBC.vp.querySelector('#flow-world'),svg=world?.querySelector('svg');if(!world||!svg)return;world.querySelectorAll('[data-flow-node]').forEach(n=>n.remove());world.insertAdjacentHTML('beforeend',GBC.model.nodes.map(GBC.nodeHtml).join(''));GBC.drawPositions();},
 applyView(){const v=GBC.views[GBC.flowKey],vp=GBC.vp;if(!vp||!v)return;const world=vp.querySelector('#flow-world');if(world)world.style.transform=`translate(${v.x}px,${v.y}px) scale(${v.z})`;vp.style.backgroundSize=`${24*v.z}px ${24*v.z}px`;vp.style.backgroundPosition=`${v.x}px ${v.y}px`;const label=document.querySelector('#flow-reset');if(label)label.textContent=Math.round(v.z*100)+'%';GBC.minimap();},
 zoom(factor){const r=GBC.vp.getBoundingClientRect(),v=GBC.views[GBC.flowKey];GBC.views[GBC.flowKey]=GBC.zoomAt(v,v.z*factor,r.width/2,r.height/2);GBC.applyView();},
 fit(){const r=GBC.vp.getBoundingClientRect(),b=GBC.bounds(GBC.model.nodes),width=Math.max(300,r.width-(GBC.selected?330:0)),height=Math.max(180,r.height-220),z=GBC.clamp(Math.min((width-100)/(b.right-b.x),height/(b.bottom-b.y)),.15,1);GBC.views[GBC.flowKey]={x:(width-(b.right-b.x)*z)/2-b.x*z,y:70+(height-(b.bottom-b.y)*z)/2-b.y*z,z};GBC.applyView();},
 center(n){if(!n)return;const r=GBC.vp.getBoundingClientRect(),v=GBC.views[GBC.flowKey];v.x=(r.width-(GBC.selected?330:0))/2-(n.x+GBC.W/2)*v.z;v.y=r.height/2-(n.y+GBC.H/2)*v.z;GBC.applyView();},
 minimap(){const el=document.querySelector('#flow-minimap');if(!el||!GBC.model)return;const b=GBC.bounds(GBC.model.nodes),scale=Math.min(180/(b.right-b.x+100),110/(b.bottom-b.y+100)),ox=(200-(b.right-b.x)*scale)/2,oy=(130-(b.bottom-b.y)*scale)/2,v=GBC.views[GBC.flowKey],r=GBC.vp.getBoundingClientRect();GBC.map={b,scale,ox,oy};el.innerHTML=GBC.model.nodes.map(n=>`<rect x="${ox+(n.x-b.x)*scale}" y="${oy+(n.y-b.y)*scale}" width="${GBC.W*scale}" height="${GBC.H*scale}" rx="2" class="map-node ${n.type}"/>`).join('')+`<rect x="${ox+(-v.x/v.z-b.x)*scale}" y="${oy+(-v.y/v.z-b.y)*scale}" width="${r.width/v.z*scale}" height="${r.height/v.z*scale}" class="map-window"/>`;},
};
if(typeof module!=='undefined'&&module.exports)module.exports=GBC;
