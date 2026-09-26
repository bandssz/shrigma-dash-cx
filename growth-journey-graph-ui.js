/* Capability-gated flow preparation. Existing live journeys retain their own editor. */
(function(root,factory){'use strict';if(typeof module==='object'&&module.exports)module.exports=factory();else root.GJG=factory().create({document:root.document,Editor:root.JourneyGraphEditor,API:root.GJGApi,state:GBS,key:()=>typeof shrigmaChaveOperador==='function'?shrigmaChaveOperador('growth','draft'):''});})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const CONTRACT='journey_graph_draft_api_v1',clone=x=>JSON.parse(JSON.stringify(x));
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const names={fish:'Fishermans',aristo:'O Aristocrata'};
 const enabled=api=>api?.capabilities?.journeys?.graph_drafts===CONTRACT&&typeof api.capabilities?.endpoints?.journey_graph==='string';
 function create({document,Editor,API,state,key,clientFactory}={}){
  let root,ctx={},editor=null,client=null,identity=null,ticket=0,brand=null,buffer=null,catalog=null,labels={},rows=[],cursor=null,busy=false,loaded=false,error='',notice='',confirm=null,pending=null,storageError='';
  const find=s=>root?.querySelector(s),dirty=()=>!!buffer&&!same(buffer.definition,buffer.base);
  function capture(){if(editor)buffer={...buffer,definition:editor.getDefinition(),server:editor.getServerIdentity()};return buffer;}
  function preserve(){capture();if(buffer&&brand)state.save('graph',brand,buffer);if(storageError)throw Error(storageError);return true;}
  const current=(n,b)=>n===ticket&&b===brand;
  function refreshPending(){const status=client?.inspect();pending=status?.pending||null;return status;}
  function tools(){
   const bar=find('[data-graph-toolbar]');if(!bar)return;const focusedDialogAction=confirm&&document.activeElement?.closest?.('[data-graph-confirm]')?document.activeElement.dataset.graph:null;const status=refreshPending(),blocked=busy||!!confirm||status?.blocked||!!storageError;
   bar.innerHTML='<button type="button" class="btn" data-graph="save"'+(blocked||!editor?.validate().ok?' disabled':'')+'>Salvar rascunho</button><button type="button" class="btn sec" data-graph="new"'+(busy||confirm||pending||storageError?' disabled':'')+'>Novo fluxo</button><button type="button" class="btn sec" data-graph="refresh"'+(busy||confirm?' disabled':'')+'>Atualizar opções</button><span class="mini">'+esc(busy?'Aguarde…':buffer?.server?'Versão '+buffer.server.version+(dirty()?' · alterações não salvas':' · salva no painel'):'Ainda não salvo')+'</span>';
   find('[data-graph-status]').textContent=storageError||error||notice||status?.error||'';
   const receipt=find('[data-graph-pending]');receipt.innerHTML=pending?'<span>Salvamento de '+esc(names[pending.payload.brand])+' aguardando conferência.</span> <button type="button" class="btn sec" data-graph="recover"'+(busy||confirm||pending.payload.brand!==brand?' disabled':'')+'>Consultar salvamento</button>':'';
   const alert=find('[data-graph-confirm]');alert.hidden=!confirm;alert.innerHTML=confirm?'<div role="alertdialog" aria-modal="true" aria-labelledby="graph-confirm-title"><strong id="graph-confirm-title">'+esc(confirm.text)+'</strong><div><button type="button" class="btn" data-graph="accept">'+esc(confirm.accept)+'</button><button type="button" class="btn sec" data-graph="cancel">Cancelar</button></div></div>':'';
   if(focusedDialogAction)find('[data-graph="'+focusedDialogAction+'"]')?.focus();
   const content=find('[data-graph-content]');if(confirm)content.setAttribute('inert','');else content.removeAttribute('inert');
   root.querySelectorAll('[data-graph="open"]').forEach(b=>b.disabled=busy||!!confirm||!!pending||!!storageError);
  }
  function mountEditor(){
   editor?.destroy();editor=null;const target=find('[data-graph-editor]');if(!target||!catalog)return;
   try{editor=Editor.mount({root:target,brand,catalog,labels,persistence:'server',definition:buffer?.definition,server:buffer?.server||null,readOnly:busy||!!pending||!!storageError,onChange:change=>{
    buffer={...buffer,definition:change.definition,server:change.server};try{state.save('graph',brand,buffer);storageError='';}catch(e){storageError=e.message;}
    tools();
   }});}catch(_){editor=null;storageError='Não foi possível abrir a preparação guardada. Ela foi preservada. Recarregue o painel para tentar novamente.';target.textContent='Preparação preservada · edição indisponível';return;}
   if(!buffer){buffer={definition:editor.getDefinition(),server:null,base:editor.getDefinition()};}
  }
  function list(){const area=find('[data-graph-list]');if(!area)return;area.innerHTML=rows.length?'<ul class="jgu-list">'+rows.map(r=>'<li><button type="button" class="btn sec" data-graph="open" data-id="'+esc(r.journey_id)+'">'+esc(r.name)+'</button><span class="mini">Versão '+esc(r.version)+'</span></li>').join('')+'</ul>':'<p class="mini">Nenhum rascunho salvo. Monte as etapas abaixo e clique em Salvar rascunho.</p>';if(cursor)area.innerHTML+='<button type="button" class="btn sec" data-graph="more">Ver mais fluxos</button>';}
  function shell(){
   editor?.destroy();editor=null;
   root.innerHTML='<div class="jgu-shell"><div data-graph-content><div class="painel-cab"><h2>Construir fluxo · '+esc(names[brand])+'</h2><span class="mini" title="Crie, salve, reabra e simule. A ativação dos novos fluxos ainda não está disponível; salvar não envia mensagens.">Rascunhos</span></div><div class="jgu-toolbar" data-graph-toolbar></div><div role="status" class="mini" data-graph-status></div><div class="jgu-toolbar" data-graph-pending></div><details><summary>Rascunhos salvos</summary><div data-graph-list></div></details><div data-graph-editor></div></div><div class="jgu-confirm" data-graph-confirm hidden></div></div>';
   list();mountEditor();tools();
   root.onclick=e=>{const b=e.target.closest('[data-graph]');if(!b||!root.contains(b)||b.disabled)return;void act(b.dataset.graph,b.dataset.id);};
   root.onkeydown=e=>{if(!confirm)return;if(e.key==='Escape'){e.preventDefault();closeConfirm(false);}if(e.key==='Tab'){const buttons=[...root.querySelectorAll('[data-graph-confirm] button')];e.preventDefault();buttons[document.activeElement===buttons[0]?1:0]?.focus();}};
  }
  function ask(text,accept,work){const caller=document.activeElement;confirm={text,accept,work,caller};tools();find('[data-graph="cancel"]')?.focus();}
  function closeConfirm(accepted){const c=confirm;if(!c)return;confirm=null;tools();const caller=c.caller?.isConnected?c.caller:[...root.querySelectorAll('[data-graph]')].find(b=>b.dataset.graph===c.caller?.dataset.graph&&b.dataset.id===c.caller?.dataset.id);caller?.focus();if(accepted)void c.work();}
  function replace(work){if(dirty())ask('Descartar as alterações ainda não salvas deste rascunho?','Descartar alterações',work);else void work();}
  async function guarded(work){if(busy)return;busy=true;error='';capture();refreshPending();mountEditor();tools();const n=ticket,b=brand;try{await work(n,b);}catch(e){if(current(n,b))error=e.message;}finally{if(current(n,b)){busy=false;refreshPending();mountEditor();tools();}}}
  function catalogFrom(r){if(r.catalog?.brand!==brand)throw Error('As opções recebidas não pertencem a esta marca.');catalog=r.catalog;labels=Object.assign({},r.labels?.triggers,r.labels?.fields,r.labels?.messages);}
  async function load(){return guarded(async(n,b)=>{
   const [c,l]=await Promise.all([client.get('catalog',b),client.get('list',b)]);if(!current(n,b))return;
   catalogFrom(c);if(!Array.isArray(l.journeys)||l.journeys.some(r=>r.brand!==b))throw Error('A lista recebida não pertence a esta marca.');rows=l.journeys;cursor=l.next_cursor;loaded=true;notice='';list();
  });}
  async function applyResult(r,operationClient=client,n=ticket,b=brand){
   if(r.state!=='succeeded'){notice='A gravação ainda não foi confirmada. Consulte a tentativa ou retome a mesma gravação.';return false;}
   const p=r.request_payload,v=r.receipt;if(p.brand!==brand)throw Error('Volte à marca da tentativa para recuperar o rascunho.');
   const server=Object.fromEntries(['journey_id','brand','version','revision','published_revision','paused'].map(k=>[k,v[k]]));
   const keepLocal=dirty()&&!same(buffer.definition,p.definition),sameJourney=buffer?.server?.journey_id===server.journey_id;
   const next=keepLocal?(sameJourney?{...clone(buffer),server,base:clone(p.definition)}:{...clone(buffer),last_recovered:{definition:clone(p.definition),server}}):{definition:clone(p.definition),server,base:clone(p.definition)};
   // Local identity must be durable before allowing another create after a reload.
   state.save('graph',b,next);buffer=next;await operationClient.acknowledge(v.operation_id);if(!current(n,b))return true;
   rows=[{...server,name:p.definition.name},...rows.filter(x=>x.journey_id!==v.journey_id)];list();notice=keepLocal?(sameJourney?'Gravação confirmada; alterações locais ainda não salvas.':'Gravação confirmada; edição atual mantida. Fluxo recuperado em Rascunhos salvos.'):'Rascunho salvo. Nenhuma mensagem enviada.';return true;
  }
  async function act(action,id){
   if(action==='cancel')return closeConfirm(false);if(action==='accept')return closeConfirm(true);if(busy||confirm)return;
   refreshPending();
   if(action==='save')return guarded(async(n,b)=>{if(pending||storageError||!editor?.validate().ok)throw Error('Confira as etapas e o salvamento pendente antes de continuar.');preserve();const operationClient=client,p={action:buffer.server?'save':'create',brand:b,definition:clone(buffer.definition),...(buffer.server?{journey_id:buffer.server.journey_id,expected_version:buffer.server.version}:{})};const r=await operationClient.run(p);if(current(n,b))await applyResult(r,operationClient,n,b);});
   if(action==='recover'&&pending?.payload.brand===brand)return guarded(async(n,b)=>{const operationClient=client,requestId=pending.payload.request_id,r=await operationClient.recover(requestId);if(!current(n,b)||await applyResult(r,operationClient,n,b))return;ask('Retomar a mesma gravação deste rascunho?','Retomar gravação',()=>guarded(async(nn,bb)=>{const resumed=await operationClient.recover(requestId,{resume:true});if(current(nn,bb))await applyResult(resumed,operationClient,nn,bb);}));});
   if(action==='refresh')return load();
   if(action==='new'&&!pending&&!storageError)return replace(async()=>{buffer=null;notice='';shell();preserve();});
   if(action==='open'&&!pending&&!storageError)return replace(()=>guarded(async(n,b)=>{const r=await client.get('get',b,{journey_id:id});if(!current(n,b))return;if(r.server?.brand!==b||r.definition?.brand!==b||r.server?.journey_id!==id)throw Error('O fluxo recebido não pertence a esta marca.');catalogFrom(r);buffer={definition:r.definition,server:r.server,base:clone(r.definition)};state.save('graph',b,buffer);notice='Rascunho aberto.';}));
   if(action==='more'&&cursor)return guarded(async(n,b)=>{const r=await client.get('list',b,{after:cursor});if(!current(n,b))return;if(!Array.isArray(r.journeys)||r.journeys.some(x=>x.brand!==b))throw Error('A lista recebida não pertence a esta marca.');rows=[...rows,...r.journeys.filter(x=>!rows.some(y=>y.journey_id===x.journey_id))];cursor=r.next_cursor;list();});
  }
  async function sync(next){
   ctx=next;root=document.querySelector('#control-graph');const tab=document.querySelector('#control-tab-graph');if(!root||!tab)return;
   const available=enabled(ctx.api),valid=Object.hasOwn(names,ctx.marca);tab.hidden=!available;tab.disabled=!valid;
   if(!available||!valid){capture();if(buffer&&brand)try{state.save('graph',brand,buffer);}catch(e){storageError=e.message;}ticket++;busy=false;loaded=false;identity=null;confirm=null;editor?.destroy();editor=null;root.innerHTML=available?'<p class="vazio">Escolha Fishermans ou O Aristocrata para construir um fluxo.</p>':'';return;}
   const endpoint=ctx.api.capabilities.endpoints.journey_graph,k=key();const changed=brand!==ctx.marca||identity?.endpoint!==endpoint||identity?.key!==k;
   if(changed){capture();if(buffer&&brand)try{state.save('graph',brand,buffer);}catch(e){storageError=e.message;return;}
    ticket++;busy=false;confirm=null;brand=ctx.marca;identity={endpoint,key:k};loaded=false;catalog=null;rows=[];cursor=null;buffer=null;error='';notice='';storageError='';
    try{client=clientFactory?clientFactory({endpoint,key}):API.create({endpoint,key});buffer=state.read('graph',brand);if(buffer?.definition?.brand&&buffer.definition.brand!==brand)throw Error('A preparação guardada pertence a outra marca.');refreshPending();}catch(e){storageError=e.message;client=null;}
    shell();
   }
   if(ctx.section==='regua'&&ctx.tab==='graph'&&!loaded&&!busy&&!storageError)return load();
  }
  function contextStatus(){refreshPending();return {brand,dirty:dirty(),blocked:busy||!!confirm||!!storageError||editor?.contextStatus().pendingConfirmation===true,pending:!!pending};}
  return {sync,preserve,contextStatus,available:enabled};
 }
 return {create,enabled};
});
