/* Unmounted, local-only candidate. No API, storage, transport or activation. */
(function(root,factory){'use strict';if(typeof module==='object'&&module.exports)module.exports=factory(require('./n8n/growth/journey-graph-contract.js'));else root.JourneyGraphEditor=factory(root.JourneyGraphContract);})(typeof globalThis!=='undefined'?globalThis:this,function(G){
 'use strict';
 const VERSION='journey_graph_editor_v1',ENABLED=false;
 const clone=x=>JSON.parse(JSON.stringify(x)),esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const names={trigger:'Entrada',wait:'Espera',condition:'Condição',message:'E-mail',exit:'Saída'};
 const terms={'cart.abandoned':'Carrinho abandonado','purchase.confirmed':'Compra confirmada',first_name:'Nome','order.total':'Valor do pedido',tags:'Marcadores','last.purchase':'Última compra','cart.email':'Mensagem de carrinho',finished:'Concluído',purchased:'Compra realizada',not_eligible:'Não elegível',opted_out:'Descadastro'};
 const operators={eq:'é igual a',ne:'é diferente de',gt:'é maior que',gte:'é maior ou igual a',lt:'é menor que',lte:'é menor ou igual a',before:'é anterior a',after:'é posterior a',contains:'contém',not_contains:'não contém'};
 let serial=0;
 function mount(options={}){
  if(!G||!options.root?.ownerDocument)throw Error('GRAPH_EDITOR_DEPENDENCY');
  const root=options.root,prefix='jge-'+(++serial)+'-',brand=options.brand,readOnly=options.readOnly===true;
  if(!['fish','aristo'].includes(brand))throw Error('GRAPH_EDITOR_BRAND');
  const labels=options.labels||{},label=k=>Object.hasOwn(labels,k)&&typeof labels[k]==='string'?labels[k]:Object.hasOwn(terms,k)?terms[k]:String(k).replace(/[_.:-]+/g,' ');
  // The host supplies the server catalog; no operator control can change it.
  let catalog=null,catalogOK=false;
  try{const supplied=options.catalog,probe={version:G.VERSION,brand,name:'Conferência',nodes:[{id:'entry',type:'trigger',event:supplied?.triggers?.find(t=>t.available)?.key||''},{id:'end',type:'exit',reason:'finished'}],edges:[{from:'entry',to:'end',port:'next'}]};catalogOK=G.validateGraph(probe,{catalog:supplied}).ok;if(catalogOK)catalog=clone(supplied);}catch(_){}
  const fresh={version:G.VERSION,brand,name:'Nova jornada',nodes:[{id:'entry',type:'trigger',event:catalog?.triggers.find(t=>t.available)?.key||''},{id:'end',type:'exit',reason:'finished'}],edges:[{from:'entry',to:'end',port:'next'}]};
  let graph=fresh;
  if(options.definition){const checked=G.validateGraph(options.definition,{catalog});if(['GRAPH_JSON','GRAPH_SIZE'].includes(checked.errors[0]?.code)||catalogOK&&['GRAPH_SHAPE','GRAPH_CONDITION'].includes(checked.errors[0]?.code))throw Error('GRAPH_EDITOR_DOCUMENT');graph=clone(options.definition);if(graph.brand!==brand||!Array.isArray(graph.nodes)||!Array.isArray(graph.edges)||graph.nodes.some(n=>!names[n.type]))throw Error('GRAPH_EDITOR_DOCUMENT');}
  let server=null;
  if(options.server){const s=options.server,keys=['journey_id','brand','version','revision','published_revision','paused'];if(Object.keys(s).length!==keys.length||keys.some(k=>!Object.hasOwn(s,k))||s.brand!==brand||! /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s.journey_id)||!Number.isSafeInteger(s.version)||s.version<1||!Number.isSafeInteger(s.revision)||s.revision<1||s.published_revision!==null&&(!Number.isSafeInteger(s.published_revision)||s.published_revision<1)||typeof s.paused!=='boolean')throw Error('GRAPH_EDITOR_SERVER');server=clone(s);}
  const baseline=JSON.stringify(graph),units=Object.create(null),scenario=Object.create(null);let pending=null,review=null,simulation=null,notice='',destroyed=false;
  let simulationNow=options.simulationNow||new Date().toISOString();
  function trigger(){return graph.nodes.find(n=>n.type==='trigger');}
  function fields(){const allowed=catalog?.triggers.find(t=>t.key===trigger()?.event)?.fields||[];return (catalog?.fields||[]).filter(f=>f.available&&allowed.includes(f.key));}
  function emailBindings(){const allowed=new Set(fields().map(f=>f.key));return (catalog?.messages||[]).filter(m=>m.available&&m.channel==='email'&&m.required_fields.every(k=>allowed.has(k)));}
  function defaultValue(type){return type==='boolean'?false:type==='number'?0:type==='timestamp'?'':type==='string_set'?'': 'Valor';}
  function leaf(){const f=fields()[0];return {field:f?.key||'',op:G.CATALOG.operators[f?.type||'string'][0],value:defaultValue(f?.type)};}
  function graphCheck(){if(!catalogOK)return {ok:false,errors:[{message:'Catálogo indisponível. Carregue as opções desta marca antes de editar ou conferir a publicação.'}]};const r=G.validateGraph(graph,{catalog});if(r.ok&&graph.nodes.some(n=>n.type==='message'&&!emailBindings().some(m=>m.key===n.binding)))return {ok:false,errors:[{message:'Escolha um modelo de e-mail disponível nesta marca.'}]};return r;}
  function title(n){return (graph.nodes.indexOf(n)+1)+'. '+names[n.type];}
  const option=(value,text,selected)=>'<option value="'+esc(value)+'"'+(selected?' selected':'')+'>'+esc(text)+'</option>';
  const disabled=()=>readOnly||!catalogOK||pending!==null;
  function select(attrs,items,value,empty){return '<select '+attrs+'>'+ (empty?option('',empty,!value):'')+items.map(([v,t])=>option(v,t,v===value)).join('')+'</select>';}
  function control(text,body){return '<label class="jge-field"><span>'+esc(text)+'</span>'+body+'</label>';}
  function expressionAt(n,path){let e=n.expression;for(const i of path?path.split('.').map(Number):[]){const key=e.all?'all':'any';e=e[key]?.[i];if(!e)throw Error('GRAPH_EDITOR_EXPRESSION');}return e;}
  function expressionParent(n,path){const p=path.split('.'),index=Number(p.pop());return {parent:expressionAt(n,p.join('.')),index};}
  function expressionBound(e,depth=0){if(depth>4)return 100;const children=e.all||e.any;return children?children.reduce((sum,x)=>sum+expressionBound(x,depth+1),0):1;}
  function conditionHTML(n,e,path='',depth=0){
   const attrs='data-node="'+esc(n.id)+'" data-path="'+esc(path)+'"',off=disabled()?' disabled':'',rootExpr=path==='';
   let html='<div class="jge-expression" data-expression="'+esc(path)+'">';
   if(e.all||e.any){const key=e.all?'all':'any';html+=control('Combinar condições',select('data-expr="group" '+attrs+off,[['all','Todas as condições (E)'],['any','Qualquer condição (OU)']],key));
    html+=e[key].map((x,i)=>conditionHTML(n,x,path?path+'.'+i:String(i),depth+1)).join('');
    html+='<div class="jge-inline"><button type="button" data-action="expr-add" '+attrs+off+'>Adicionar condição</button><button type="button" data-action="expr-group" '+attrs+off+(depth>=3?' disabled':'')+'>Adicionar grupo</button></div>';
   }else{
    const f=fields().find(x=>x.key===e.field),ops=G.CATALOG.operators[f?.type||'string'];
    html+=control('Dado',select('data-expr="field" '+attrs+off,fields().map(x=>[x.key,label(x.key)]),e.field,'Escolha o dado'));
    html+=control('Comparação',select('data-expr="op" '+attrs+off,ops.map(x=>[x,operators[x]]),e.op));
    const type=f?.type==='number'?'number':f?.type==='timestamp'?'datetime-local':'text';
    html+=control(f?.type==='timestamp'?'Valor (data e hora UTC)':'Valor',f?.type==='boolean'?select('data-expr="value" '+attrs+off,[['true','Sim'],['false','Não']],String(e.value)):'<input data-expr="value" '+attrs+' type="'+type+'" step="any" maxlength="1024" value="'+esc(f?.type==='timestamp'?String(e.value).slice(0,19):e.value)+'"'+off+'>');
    if(rootExpr)html+='<button type="button" data-action="expr-wrap" '+attrs+off+'>Adicionar outra condição</button>';
   }
   if(!rootExpr)html+='<button type="button" class="jge-remove" data-action="expr-remove" '+attrs+off+'>Remover condição ou grupo</button>';
   return html+'</div>';
  }
  function nodeHTML(n){
   const off=disabled()?' disabled':'',data='data-node="'+esc(n.id)+'"';
   if(!catalogOK)return '<article class="jge-node"><h3>'+esc(title(n))+'</h3><p>Opções desta etapa indisponíveis até carregar o catálogo da marca.</p></article>';
   let html='<article class="jge-node" data-node-id="'+esc(n.id)+'"><header><h3>'+esc(title(n))+'</h3>'+(n.type!=='trigger'?'<button type="button" data-action="remove" '+data+off+' aria-label="Remover '+esc(title(n))+'">Remover</button>':'')+'</header>';
   if(n.type==='trigger')html+=control('Quando começa',select('data-field="event" '+data+off,(catalog?.triggers||[]).filter(t=>t.available).map(t=>[t.key,label(t.key)]),n.event,'Escolha a entrada'));
   if(n.type==='wait'){const unit=units[n.id]||(n.seconds%86400===0?86400:n.seconds%3600===0?3600:n.seconds%60===0?60:1);units[n.id]=unit;html+='<div class="jge-inline">'+control('Aguardar','<input type="number" min="1" step="any" data-field="wait-amount" '+data+' value="'+esc(n.seconds/unit)+'"'+off+'>')+control('Unidade',select('data-field="wait-unit" '+data+off,[[1,'Segundos'],[60,'Minutos'],[3600,'Horas'],[86400,'Dias']],unit))+'</div>';}
   if(n.type==='condition')html+=conditionHTML(n,n.expression)+'<details><summary>Se o dado ainda não chegou</summary><p>Aguardar informação; nunca assumir “Não”. Ao vencer o prazo, bloquear esta entrada.</p><div class="jge-inline">'+control('Prazo máximo (segundos)','<input type="number" min="1" max="86400" data-field="max_wait_seconds" '+data+' value="'+esc(n.on_unknown.max_wait_seconds)+'"'+off+'>')+control('Conferir novamente em (segundos)','<input type="number" min="1" data-field="retry_seconds" '+data+' value="'+esc(n.on_unknown.retry_seconds)+'"'+off+'>')+'</div></details>';
   if(n.type==='message')html+=control('Modelo de e-mail',select('data-field="binding" '+data+off,emailBindings().map(m=>[m.key,label(m.key)]),n.binding,'Escolha um modelo'))+'<p class="jge-note">Descadastro, consentimento e bloqueios devem ser conferidos antes do envio. Esta etapa só simula uma intenção.</p>';
   if(n.type==='exit')html+=control('Motivo do encerramento',select('data-field="reason" '+data+off,[...new Set(['finished','purchased','not_eligible','opted_out',n.reason])].map(k=>[k,label(k)]),n.reason));
   if(n.type!=='exit')for(const port of n.type==='condition'?['yes','no']:['next']){
    const target=graph.edges.find(e=>e.from===n.id&&e.port===port)?.to||'',destinations=graph.nodes.filter(x=>x.id!==n.id&&x.type!=='trigger').map(x=>[x.id,title(x)]);
    if(target&&!destinations.some(x=>x[0]===target))destinations.push([target,'Etapa indisponível']);
    html+=control(port==='yes'?'Se Sim, seguir para':port==='no'?'Se Não, seguir para':'Depois, seguir para',select('data-connection="'+port+'" '+data+off,destinations,target,'Escolha a próxima etapa'));
   }
   return html+'</article>';
  }
  function scenarioHTML(){return '<details class="jge-scenario"><summary>Dados fictícios para simular</summary><p>São observados no início. Uma espera longa pode tornar o dado antigo; a simulação mostrará essa falta de informação.</p>'+control('Início (data e hora UTC)','<input type="datetime-local" step="1" data-scenario-start value="'+esc(simulationNow.slice(0,19))+'">')+fields().map(f=>{
   const s=scenario[f.key]||(scenario[f.key]={known:false,value:defaultValue(f.type)}),attrs='data-scenario-value="'+esc(f.key)+'"';
   const value=f.type==='boolean'?select(attrs,[['false','Não'],['true','Sim']],String(s.value)):'<input '+attrs+' type="'+(f.type==='number'?'number':f.type==='timestamp'?'datetime-local':'text')+'" maxlength="1024" step="any" value="'+esc(f.type==='timestamp'?String(s.value).slice(0,19):s.value)+'">';
   return '<div class="jge-scenario-field"><label><input type="checkbox" data-scenario-known="'+esc(f.key)+'"'+(s.known?' checked':'')+'> Informar '+esc(label(f.key))+'</label>'+control(f.type==='timestamp'?'Valor (UTC)':f.type==='string_set'?'Valores separados por vírgula':'Valor fictício',value)+'</div>';
  }).join('')+'</details>';}
  function resultHTML(){if(!simulation)return '';const steps=simulation.trace.map(t=>{
   const from=graph.nodes.find(n=>n.id===(t.from||t.state.node_id)),base=from?title(from):'Etapa';let text=base;
   if(t.kind==='advance')text+=' → '+(t.decision?'Resultado: '+(t.decision.value?'Sim':'Não')+' · ':'')+title(graph.nodes.find(n=>n.id===t.to));
   else if(t.kind==='wait')text+=' · aguardar até '+t.due_at.replace('T',' ').replace('.000Z',' UTC');
   else if(t.kind==='wait_data')text+=' · informação ausente ou antiga; caminho Não não escolhido';
   else if(t.kind==='message_intent')text+=' · intenção de e-mail; aceite apenas hipotético';
   else if(t.kind==='blocked')text+=' · bloqueada: dados indisponíveis ou prazo encerrado';
   else if(t.kind==='exit')text+=' · encerrada';
   else text+=' · '+({unknown:'resultado hipotético desconhecido',failed:'falha hipotética',terminal:'finalizada'}[t.kind]||'limite da simulação');
   return '<li>'+esc(text)+'</li>';
  });return '<section class="jge-result" aria-label="Resultado da simulação"><h3>Simulação · nenhum envio realizado</h3><p>'+esc(simulation.reason==='wait_data'?'Aguardando informação. Não avançou para o caminho Não.':simulation.reason==='step_limit'?'Simulação incompleta: limite de etapas alcançado.':'Resultado fictício; não confirma execução nem entrega.')+'</p><ol>'+steps.join('')+'</ol></section>';}
  function render(){
   if(destroyed)return;const valid=graphCheck(),off=disabled()?' disabled':'',atLimit=graph.nodes.length>=G.MAX_NODES;
   root.classList.add('jge-editor');
   root.innerHTML='<div class="jge-content"'+(pending?' inert aria-hidden="true"':'')+'><header class="jge-heading"><div><h2>Construir jornada</h2><p>'+esc(brand==='fish'?'Fishermans':'O Aristocrata')+' · '+esc(server?'Revisão '+server.revision+' · '+(server.paused?'Pausada':'Estado informado pelo servidor'):'Nova jornada · ainda sem versão do servidor')+'</p></div><span>Preparação local</span></header>'+
    '<p class="jge-safety">Nenhuma mensagem será enviada. Descadastro e bloqueios não podem ser desativados.</p>'+
    (!catalogOK?'<p role="alert" class="jge-alert">Catálogo indisponível. Carregue as opções desta marca para continuar; publicação bloqueada.</p>':'')+
    (readOnly?'<p class="jge-note">Somente leitura. Você pode conferir o fluxo e simular dados fictícios.</p>':'')+
    control('Nome da jornada','<input data-name maxlength="120" value="'+esc(graph.name)+'"'+off+'>')+
    '<div class="jge-add" aria-label="Adicionar etapa">'+['wait','condition','message','exit'].map(type=>'<button type="button" data-action="add" data-type="'+type+'"'+off+(atLimit||type==='message'&&!emailBindings().length||type==='condition'&&!fields().length?' disabled':'')+'>Adicionar '+names[type].toLowerCase()+'</button>').join('')+'<span>'+graph.nodes.length+' de '+G.MAX_NODES+' etapas</span></div>'+
    '<div class="jge-nodes">'+graph.nodes.map(nodeHTML).join('')+'</div>'+
    '<section class="jge-validation" aria-live="polite" data-validation>'+validationHTML(valid)+'</section>'+scenarioHTML()+
    '<div class="jge-actions"><button type="button" data-action="simulate"'+(!valid.ok||pending?' disabled':'')+'>Simular caminho</button><button type="button" data-action="review"'+(!valid.ok||pending?' disabled':'')+'>Conferir revisão</button><button type="button" disabled title="A conexão de publicação ainda não está disponível.">Publicar indisponível</button></div>'+
    '<p class="jge-note" data-dirty>'+(JSON.stringify(graph)!==baseline?'Alterações apenas nesta tela.':'Sem alterações locais.')+'</p>'+
    '<div role="status" data-notice>'+esc(notice)+'</div>'+
    (review?'<section class="jge-review"><h3>Revisão conferida</h3><p>Conexões e opções válidas para '+esc(brand==='fish'?'Fishermans':'O Aristocrata')+'. '+(server?'Versão esperada: '+server.version+'. ':'')+'Nada publicado. A integração do servidor deverá conferir permissões, catálogo e versão novamente.</p></section>':'')+resultHTML()+'</div>'+
    (pending?'<div class="jge-confirm" role="alertdialog" aria-modal="true" aria-labelledby="'+prefix+'remove-title"><h3 id="'+prefix+'remove-title">Remover '+esc(title(graph.nodes.find(n=>n.id===pending)))+'?</h3><p>As conexões desta etapa serão removidas. Confira os caminhos antes de continuar.</p><button type="button" data-action="cancel-remove">Manter etapa</button><button type="button" data-action="confirm-remove">Remover etapa</button></div>':'');
  }
  function validationHTML(valid){return valid.ok?'<strong>Fluxo válido para simular</strong>':'<strong>Há ajustes no fluxo</strong><ul>'+valid.errors.map(e=>'<li>'+esc(e.message)+'</li>').join('')+'</ul>';}
  function changed(full=true){review=null;simulation=null;notice='';if(full)render();else{const valid=graphCheck();root.querySelector('[data-validation]').innerHTML=validationHTML(valid);root.querySelector('[data-dirty]').textContent=JSON.stringify(graph)!==baseline?'Alterações apenas nesta tela.':'Sem alterações locais.';root.querySelector('.jge-review')?.remove();root.querySelector('.jge-result')?.remove();root.querySelector('[data-notice]').textContent='';for(const b of root.querySelectorAll('[data-action="review"],[data-action="simulate"]'))b.disabled=!valid.ok;}}
  function parseValue(raw,type){if(type==='boolean')return raw==='true'?true:raw==='false'?false:null;if(type==='number')return raw.trim()===''?null:Number(raw);if(type==='timestamp'){const normalized=raw.length===16?raw+':00.000Z':raw.length===19?raw+'.000Z':raw+'Z',d=new Date(normalized);return Number.isFinite(d.getTime())&&d.toISOString()===normalized?normalized:raw;}return raw;}
  function valueChange(event){
   const el=event.target;if(destroyed||pending||!root.contains(el))return;
   if(el.hasAttribute('data-scenario-start')){simulationNow=parseValue(el.value,'timestamp');simulation=null;root.querySelector('.jge-result')?.remove();return;}
   if(el.hasAttribute('data-scenario-known')||el.hasAttribute('data-scenario-value')){const key=el.getAttribute('data-scenario-known')||el.getAttribute('data-scenario-value'),f=fields().find(x=>x.key===key);if(!f)return;const s=scenario[key]||(scenario[key]={known:false,value:defaultValue(f.type)});if(el.hasAttribute('data-scenario-known'))s.known=el.checked;else s.value=parseValue(el.value,f.type);simulation=null;root.querySelector('.jge-result')?.remove();return;}
   if(disabled())return;
   if(el.hasAttribute('data-name')){graph.name=el.value;changed(false);return;}
   const n=graph.nodes.find(x=>x.id===el.dataset.node);if(!n)return;
   if(el.dataset.connection){graph.edges=graph.edges.filter(e=>!(e.from===n.id&&e.port===el.dataset.connection));if(el.value)graph.edges.push({from:n.id,to:el.value,port:el.dataset.connection});changed(false);return;}
   if(el.dataset.expr){const e=expressionAt(n,el.dataset.path||''),kind=el.dataset.expr;if(kind==='group'){const children=e.all||e.any;delete e.all;delete e.any;e[el.value]=children;changed();return;}if(kind==='field'){const f=fields().find(x=>x.key===el.value);e.field=el.value;e.op=G.CATALOG.operators[f?.type||'string'][0];e.value=defaultValue(f?.type);changed();return;}if(kind==='op')e.op=el.value;else e.value=parseValue(el.value,fields().find(f=>f.key===e.field)?.type);changed(false);return;}
   const key=el.dataset.field;if(!key)return;
   if(key==='wait-unit'){const amount=Number(el.closest('[data-node-id]').querySelector('[data-field="wait-amount"]').value);units[n.id]=Number(el.value);n.seconds=amount*units[n.id];changed(false);}
   else if(key==='wait-amount'){n.seconds=Number(el.value)*(units[n.id]||1);changed(false);}
   else if(['max_wait_seconds','retry_seconds'].includes(key)){n.on_unknown[key]=Number(el.value);changed(false);}
   else if(['event','binding','reason'].includes(key)){n[key]=el.value;changed(key==='event');}
  }
  function proposal(){const validation=graphCheck();if(!validation.ok)return {ok:false,errors:clone(validation.errors)};return {ok:true,contract:VERSION,definition:clone(graph),server:clone(server),authorizes_publish:false,authorizes_send:false};}
  function click(event){const b=event.target.closest?.('[data-action]');if(!b||!root.contains(b)||b.disabled||destroyed)return;const action=b.dataset.action;
   if(pending){if(action==='cancel-remove'){pending=null;render();}else if(action==='confirm-remove'){const id=pending;graph.nodes=graph.nodes.filter(n=>n.id!==id);graph.edges=graph.edges.filter(e=>e.from!==id&&e.to!==id);pending=null;changed();}return;}
   if(action==='review'){const p=proposal();if(p.ok){review=p;notice='Revisão conferida. Publicação continua indisponível.';}render();return;}
   if(action==='simulate'){if(!graphCheck().ok)return;const facts={};for(const f of fields()){const s=scenario[f.key];if(s?.known)facts[f.key]={value:f.type==='string_set'?String(s.value).split(',').map(v=>v.trim()).filter(Boolean):s.value,observed_at:simulationNow,complete:true};}try{simulation=G.simulate(graph,{catalog,now:simulationNow,facts});notice='';}catch(_){simulation=null;notice='Confira os valores e a data dos dados fictícios.';}render();return;}
   if(disabled())return;
   if(action==='add'){if(graph.nodes.length>=G.MAX_NODES)return;let i=1;while(graph.nodes.some(n=>n.id==='step'+i))i++;const type=b.dataset.type,n={id:'step'+i,type};if(type==='wait')n.seconds=60;else if(type==='condition')Object.assign(n,{expression:{all:[leaf()]},on_unknown:{max_wait_seconds:120,retry_seconds:30}});else if(type==='message')n.binding=emailBindings()[0]?.key||'';else if(type==='exit')n.reason='finished';else return;graph.nodes.push(n);changed();return;}
   const n=graph.nodes.find(x=>x.id===b.dataset.node);if(!n)return;
   if(action==='remove'){if(n.type!=='trigger'){pending=n.id;render();root.querySelector('[data-action="cancel-remove"]')?.focus();}return;}
   if(action.startsWith('expr-')){const path=b.dataset.path||'',e=expressionAt(n,path),before=clone(n.expression);if(action==='expr-wrap')n.expression={all:[e,leaf()]};else if(action==='expr-add'||action==='expr-group')(e.all||e.any).push(action==='expr-add'?leaf():{any:[leaf()]});else if(action==='expr-remove'&&path){const {parent,index}=expressionParent(n,path),children=parent.all||parent.any;if(children.length===1){notice='Mantenha ao menos uma condição no grupo.';render();return;}children.splice(index,1);}if(expressionBound(n.expression)>16){n.expression=before;notice='Limite: até 16 condições e quatro níveis de grupos.';render();return;}changed();}
  }
  root.addEventListener('click',click);root.addEventListener('change',valueChange);
  // Text inputs update without rebuilding the form, preserving focus and selection.
  function input(event){if(event.target.matches('input:not([type="checkbox"])'))valueChange(event);}
  function keydown(event){if(!pending)return;if(event.key==='Escape'){event.preventDefault();pending=null;render();return;}if(event.key==='Tab'){const buttons=[...root.querySelectorAll('.jge-confirm button')],index=buttons.indexOf(event.target);event.preventDefault();buttons[(index+(event.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus();}}
  root.addEventListener('input',input);root.addEventListener('keydown',keydown);render();
  return Object.freeze({VERSION,enabled:false,getDefinition:()=>clone(graph),getServerIdentity:()=>clone(server),validate:()=>clone(graphCheck()),prepareReview:proposal,getSimulation:()=>simulation?clone(simulation):null,contextStatus:()=>({brand,dirty:JSON.stringify(graph)!==baseline,pendingConfirmation:pending!==null,readOnly,publicationAvailable:false}),destroy(){destroyed=true;root.removeEventListener('click',click);root.removeEventListener('change',valueChange);root.removeEventListener('input',input);root.removeEventListener('keydown',keydown);root.innerHTML='';root.classList.remove('jge-editor');}});
 }
 return Object.freeze({VERSION,ENABLED,mount});
});
