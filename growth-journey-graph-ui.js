/* Capability-gated flow preparation. Existing live journeys retain their own editor. */
(function(root,factory){'use strict';if(typeof module==='object'&&module.exports)module.exports=factory();else root.GJG=factory().create({document:root.document,Editor:root.JourneyGraphEditor,API:root.GJGApi,state:GBS,key:()=>typeof shrigmaChaveOperador==='function'?shrigmaChaveOperador('growth','draft'):''});})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const CONTRACT='journey_graph_draft_api_v1',clone=x=>JSON.parse(JSON.stringify(x));
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const LIFECYCLE='journey_graph_lifecycle_panel_v1';
 const lifecycleEndpoint=api=>{try{const u=new URL(api?.capabilities?.endpoints?.journey_graph_lifecycle);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash?u.href:null;}catch{return null;}};
 const lifecycleEnabled=(api,b)=>{const c=api?.capabilities?.journeys?.graph_lifecycle;return c?.contract===LIFECYCLE&&c.prepare===true&&c.publish_paused===true&&c.activate===false&&Array.isArray(c.brands)&&c.brands.includes(b)&&!!lifecycleEndpoint(api);};
 const names={fish:'Fishermans',aristo:'O Aristocrata'};
 const enabled=api=>api?.capabilities?.journeys?.graph_drafts===CONTRACT&&typeof api.capabilities?.endpoints?.journey_graph==='string';
 function create({document,Editor,API,state,key,clientFactory}={}){
  let root,ctx={},editor=null,client=null,identity=null,ticket=0,brand=null,buffer=null,catalog=null,labels={},rows=[],cursor=null,busy=false,loaded=false,error='',notice='',confirm=null,pending=null,storageError='',review=null;
  const published=()=>buffer?.server?.published_revision!==null&&buffer?.server?.published_revision!==undefined;
  const find=s=>root?.querySelector(s),dirty=()=>!!buffer&&!same(buffer.definition,buffer.base);
  function capture(){if(editor)buffer={...buffer,definition:editor.getDefinition(),server:editor.getServerIdentity()};return buffer;}
  function preserve(){capture();if(buffer&&brand)state.save('graph',brand,buffer);if(storageError)throw Error(storageError);return true;}
  const current=(n,b)=>n===ticket&&b===brand;
  function refreshPending(){const status=client?.inspect();pending=status?.pending||null;return status;}
  function tools(){
   const bar=find('[data-graph-toolbar]');if(!bar)return;const focusedDialogAction=confirm&&document.activeElement?.closest?.('[data-graph-confirm]')?document.activeElement.dataset.graph:null;const status=refreshPending(),blocked=busy||!!confirm||status?.blocked||!!storageError;
   bar.innerHTML='<button type="button" class="btn" data-graph="save"'+(blocked||published()||!editor?.validate().ok?' disabled':'')+'>Salvar rascunho</button><button type="button" class="btn sec" data-graph="new"'+(busy||confirm||pending||storageError?' disabled':'')+'>Novo fluxo</button><button type="button" class="btn sec" data-graph="refresh"'+(busy||confirm?' disabled':'')+'>Atualizar opções</button><span class="mini">'+esc(busy?'Aguarde…':buffer?.server?'Versão '+buffer.server.version+(dirty()?' · alterações não salvas':' · salva no painel'):'Ainda não salvo')+'</span>';
   const lifecycle=find('[data-graph-lifecycle]'),ready=lifecycleEnabled(ctx.api,brand),prepared=buffer?.lifecycle_prepared,usable=prepared&&prepared.journey_id===buffer?.server?.journey_id&&prepared.base_version===buffer.server.version&&prepared.base_revision===buffer.server.revision&&!dirty();
   if(lifecycle){lifecycle.hidden=!ready&&!published();lifecycle.innerHTML=published()?'<p>Revisão '+esc(buffer.server.published_revision)+' publicada e pausada. A ativação ainda está indisponível.</p>'+(buffer.local_edit?'<p>Sua edição local foi preservada separadamente.</p><button type="button" class="btn sec" data-graph="restore-local"'+(blocked?' disabled':'')+'>Continuar edição preservada em novo fluxo</button>':''):ready?'<p class="mini">Confira a revisão salva, prepare a mensagem e publique pausada. Nenhuma dessas etapas envia mensagens.</p><button type="button" class="btn sec" data-graph="review"'+(blocked||!buffer?.server||dirty()?' disabled':'')+'>Conferir publicação</button> '+(review?.state==='reviewed'?'<button type="button" class="btn sec" data-graph="prepare"'+(blocked||dirty()?' disabled':'')+'>Preparar mensagem</button> ':'')+(usable?'<button type="button" class="btn" data-graph="publish"'+(blocked?' disabled':'')+'>Publicar pausado</button>':'')+(review?.state==='blocked'?'<ul>'+review.review.blockers.map(x=>'<li>'+esc(x.message)+'</li>').join('')+'</ul>':''):'';}
   find('[data-graph-status]').textContent=storageError||error||notice||status?.error||'';
   const receipt=find('[data-graph-pending]');receipt.innerHTML=pending?'<span>Operação de '+esc(names[pending.payload.brand])+' aguardando conferência.</span> <button type="button" class="btn sec" data-graph="recover"'+(busy||confirm||pending.payload.brand!==brand?' disabled':'')+'>Consultar operação</button>':'';
   const alert=find('[data-graph-confirm]');alert.hidden=!confirm;alert.innerHTML=confirm?'<div role="alertdialog" aria-modal="true" aria-labelledby="graph-confirm-title"><strong id="graph-confirm-title">'+esc(confirm.text)+'</strong><div><button type="button" class="btn" data-graph="accept">'+esc(confirm.accept)+'</button><button type="button" class="btn sec" data-graph="cancel">Cancelar</button></div></div>':'';
   if(focusedDialogAction)find('[data-graph="'+focusedDialogAction+'"]')?.focus();
   const content=find('[data-graph-content]');if(confirm)content.setAttribute('inert','');else content.removeAttribute('inert');
   root.querySelectorAll('[data-graph="open"]').forEach(b=>b.disabled=busy||!!confirm||!!pending||!!storageError);
  }
  function mountEditor(){
   editor?.destroy();editor=null;const target=find('[data-graph-editor]');if(!target||!catalog)return;
   try{editor=Editor.mount({root:target,brand,catalog,labels,persistence:'server',definition:buffer?.definition,server:buffer?.server||null,readOnly:busy||!!pending||!!storageError||published(),onChange:change=>{
    review=null;buffer={...buffer,definition:change.definition,server:change.server};try{state.save('graph',brand,buffer);storageError='';}catch(e){storageError=e.message;}
    tools();
   }});}catch(_){editor=null;storageError='Não foi possível abrir a preparação guardada. Ela foi preservada. Recarregue o painel para tentar novamente.';target.textContent='Preparação preservada · edição indisponível';return;}
   if(!buffer){buffer={definition:editor.getDefinition(),server:null,base:editor.getDefinition()};}
  }
  function list(){const area=find('[data-graph-list]');if(!area)return;area.innerHTML=rows.length?'<ul class="jgu-list">'+rows.map(r=>'<li><button type="button" class="btn sec" data-graph="open" data-id="'+esc(r.journey_id)+'">'+esc(r.name)+'</button><span class="mini">Versão '+esc(r.version)+'</span></li>').join('')+'</ul>':'<p class="mini">Nenhum rascunho salvo. Monte as etapas abaixo e clique em Salvar rascunho.</p>';if(cursor)area.innerHTML+='<button type="button" class="btn sec" data-graph="more">Ver mais fluxos</button>';}
  function shell(){
   editor?.destroy();editor=null;
   root.innerHTML='<div class="jgu-shell"><div data-graph-content><div class="painel-cab"><h2>Construir fluxo · '+esc(names[brand])+'</h2><span class="mini" title="Crie, salve, reabra e simule. A ativação dos novos fluxos ainda não está disponível; salvar não envia mensagens.">Rascunhos</span></div><div class="jgu-toolbar" data-graph-toolbar></div><div role="status" class="mini" data-graph-status></div><div class="jgu-toolbar" data-graph-pending></div><details><summary>Rascunhos salvos</summary><div data-graph-list></div></details><div data-graph-lifecycle></div><div data-graph-editor></div></div><div class="jgu-confirm" data-graph-confirm hidden></div></div>';
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
   catalogFrom(c);if(published()&&buffer.publication_catalog)catalog=clone(buffer.publication_catalog);if(!Array.isArray(l.journeys)||l.journeys.some(r=>r.brand!==b))throw Error('A lista recebida não pertence a esta marca.');rows=l.journeys;cursor=l.next_cursor;loaded=true;notice='';list();
  });}
  async function applyResult(r,operationClient=client,n=ticket,b=brand){
   if(r.state!=='succeeded'){notice='A gravação ainda não foi confirmada. Consulte a tentativa ou retome a mesma gravação.';return false;}
   const p=r.request_payload,v=r.receipt;if(['prepare','publish'].includes(p.action))return applyLifecycleResult(r,operationClient,n,b);if(p.brand!==brand)throw Error('Volte à marca da tentativa para recuperar o rascunho.');
   const server=Object.fromEntries(['journey_id','brand','version','revision','published_revision','paused'].map(k=>[k,v[k]]));
   const keepLocal=dirty()&&!same(buffer.definition,p.definition),sameJourney=buffer?.server?.journey_id===server.journey_id;
   const next=keepLocal?(sameJourney?{...clone(buffer),server,base:clone(p.definition)}:{...clone(buffer),last_recovered:{definition:clone(p.definition),server}}):{definition:clone(p.definition),server,base:clone(p.definition)};
   // Local identity must be durable before allowing another create after a reload.
   state.save('graph',b,next);buffer=next;await operationClient.acknowledge(v.operation_id);if(!current(n,b))return true;
   rows=[{...server,name:p.definition.name},...rows.filter(x=>x.journey_id!==v.journey_id)];list();notice=keepLocal?(sameJourney?'Gravação confirmada; alterações locais ainda não salvas.':'Gravação confirmada; edição atual mantida. Fluxo recuperado em Rascunhos salvos.'):'Rascunho salvo. Nenhuma mensagem enviada.';return true;
  }
  async function applyLifecycleResult(r,operationClient,n,b){
   const p=r.request_payload,v=r.receipt;if(p.brand!==b)throw Error('Volte à marca desta operação para recuperar a publicação.');
   const stored=clone(buffer),sameJourney=stored?.server?.journey_id===p.journey_id;
   if(p.action==='prepare'){
    if(sameJourney&&!dirty()&&stored.server.version===p.expected_version)buffer={...stored,lifecycle_prepared:clone(v)};
    else buffer={...stored,last_lifecycle_receipt:clone(v)};
   }else{
    const currentStatus=await operationClient.readLifecycle('status',b,{journey_id:p.journey_id});if(!current(n,b))return false;
    if(currentStatus.state!=='published_paused'||currentStatus.receipt?.publication_hash!==v.publication_hash||currentStatus.server.version!==v.version)throw Error('A publicação foi registrada; consulte novamente para confirmar a versão exibida.');
    const next={definition:currentStatus.definition,server:currentStatus.server,base:clone(currentStatus.definition),lifecycle_publication:clone(v),publication_catalog:clone(currentStatus.catalog)};
    if(sameJourney){buffer=dirty()?{...next,local_edit:stored}:next;catalog=currentStatus.catalog;}
    else buffer={...stored,last_lifecycle_publication:next};
    rows=[{...currentStatus.server,name:currentStatus.definition.name},...rows.filter(x=>x.journey_id!==p.journey_id)];list();
   }
   state.save('graph',b,buffer);await operationClient.acknowledge(v.request_id);if(!current(n,b))return true;
   review=null;notice=p.action==='prepare'?'Mensagem preparada. Confira e confirme Publicar pausado.':'Publicação confirmada e pausada. Nenhuma mensagem enviada.';return true;
  }
  async function act(action,id){
   if(action==='cancel')return closeConfirm(false);if(action==='accept')return closeConfirm(true);if(busy||confirm)return;
   refreshPending();
   if(action==='save')return guarded(async(n,b)=>{if(pending||storageError||published()||!editor?.validate().ok)throw Error('Confira as etapas e o salvamento pendente antes de continuar.');preserve();const operationClient=client,p={action:buffer.server?'save':'create',brand:b,definition:clone(buffer.definition),...(buffer.server?{journey_id:buffer.server.journey_id,expected_version:buffer.server.version}:{})};const r=await operationClient.run(p);if(current(n,b))await applyResult(r,operationClient,n,b);});
   if(action==='recover'&&pending?.payload.brand===brand)return guarded(async(n,b)=>{const operationClient=client,requestId=pending.payload.request_id,isLifecycle=['prepare','publish'].includes(pending.payload.action),r=await operationClient.recover(requestId);if(!current(n,b)||await applyResult(r,operationClient,n,b))return;if(isLifecycle){notice='A operação continua sem confirmação. Consulte a mesma tentativa; uma nova publicação permanece bloqueada.';return;}ask('Retomar a mesma gravação deste rascunho?','Retomar gravação',()=>guarded(async(nn,bb)=>{const resumed=await operationClient.recover(requestId,{resume:true});if(current(nn,bb))await applyResult(resumed,operationClient,nn,bb);}));});
   if(action==='restore-local'&&published()&&buffer.local_edit&&!pending&&!storageError)return ask('Continuar a edição preservada como um novo fluxo?','Continuar edição',()=>guarded(async(n,b)=>{const saved=clone(buffer.local_edit),fresh=await client.get('catalog',b);if(!current(n,b))return;catalogFrom(fresh);buffer={definition:saved.definition,server:null,base:clone(saved.base),last_lifecycle_publication:{server:clone(buffer.server),receipt:clone(buffer.lifecycle_publication)}};state.save('graph',b,buffer);review=null;notice='Edição local recuperada como novo fluxo, ainda não salvo.';}));
   if(['review','prepare','publish'].includes(action)){
    if(!lifecycleEnabled(ctx.api,brand)||pending||storageError||published()||dirty()||!buffer?.server)return;
    const server=clone(buffer.server);
    const recheck=()=>{capture();if(!lifecycleEnabled(ctx.api,brand)||pending||storageError||published()||dirty()||!same(buffer?.server,server))throw Error('A edição ou a disponibilidade mudou. Preserve o rascunho e confira novamente.');preserve();};
    if(action==='review')return guarded(async(n,b)=>{const r=await client.readLifecycle('review',b,{journey_id:server.journey_id,expected_version:server.version});if(current(n,b)){review=r;notice=r.state==='reviewed'?'Revisão conferida. Prepare a mensagem em até 30 segundos.':'A revisão precisa dos ajustes indicados.';}});
    if(action==='prepare'){
     if(review?.state!=='reviewed'||Date.now()>=Date.parse(review.review.expires_at)){review=null;error='A conferência expirou. Confira a publicação novamente.';tools();return;}
     const reviewHash=review.review.review_hash;
     return ask('Preparar a mensagem desta revisão salva?','Preparar mensagem',()=>guarded(async(n,b)=>{recheck();if(review?.review?.review_hash!==reviewHash||Date.now()>=Date.parse(review.review.expires_at))throw Error('A conferência expirou. Confira novamente.');const operationClient=client,r=await operationClient.run({action:'prepare',brand:b,journey_id:server.journey_id,expected_version:server.version,review_hash:reviewHash,confirm:'preparar'});if(current(n,b))await applyResult(r,operationClient,n,b);}));
    }
    const prepared=buffer.lifecycle_prepared;if(!prepared||prepared.journey_id!==server.journey_id||prepared.base_version!==server.version||prepared.base_revision!==server.revision)return;
    return ask('Publicar esta revisão pausada? A ativação continuará indisponível.','Publicar pausado',()=>guarded(async(n,b)=>{recheck();if(!same(buffer.lifecycle_prepared,prepared))throw Error('A preparação mudou. Confira novamente.');const operationClient=client,r=await operationClient.run({action:'publish',brand:b,journey_id:server.journey_id,expected_version:server.version,prepared_revision:prepared.base_revision+1,prepared_hash:prepared.prepared_hash,confirm:'publicar'});if(current(n,b))await applyResult(r,operationClient,n,b);}));
   }
   if(action==='refresh'){review=null;return load();}
   if(action==='new'&&!pending&&!storageError)return replace(()=>guarded(async(n,b)=>{const fresh=await client.get('catalog',b);if(!current(n,b))return;catalogFrom(fresh);buffer=null;review=null;notice='';shell();preserve();}));
   if(action==='open'&&!pending&&!storageError)return replace(()=>guarded(async(n,b)=>{const listed=rows.find(x=>x.journey_id===id);let r=listed?.published_revision?await client.readLifecycle('status',b,{journey_id:id}):await client.get('get',b,{journey_id:id});if(!current(n,b))return;if(r.server?.published_revision&&r.state!=='published_paused'){r=await client.readLifecycle('status',b,{journey_id:id});if(!current(n,b))return;}if(r.server?.brand!==b||r.definition?.brand!==b||r.server?.journey_id!==id)throw Error('O fluxo recebido não pertence a esta marca.');catalogFrom(r);review=null;buffer={definition:r.definition,server:r.server,base:clone(r.definition),...(r.server.published_revision?{publication_catalog:clone(r.catalog),lifecycle_publication:clone(r.receipt)}:{})};state.save('graph',b,buffer);notice=r.server.published_revision?'Publicação pausada aberta para consulta.':'Rascunho aberto.';}));
   if(action==='more'&&cursor)return guarded(async(n,b)=>{const r=await client.get('list',b,{after:cursor});if(!current(n,b))return;if(!Array.isArray(r.journeys)||r.journeys.some(x=>x.brand!==b))throw Error('A lista recebida não pertence a esta marca.');rows=[...rows,...r.journeys.filter(x=>!rows.some(y=>y.journey_id===x.journey_id))];cursor=r.next_cursor;list();});
  }
  async function sync(next){
   ctx=next;root=document.querySelector('#control-graph');const tab=document.querySelector('#control-tab-graph');if(!root||!tab)return;
   const available=enabled(ctx.api),valid=Object.hasOwn(names,ctx.marca);tab.hidden=!available;tab.disabled=!valid;
   if(!available||!valid){capture();if(buffer&&brand)try{state.save('graph',brand,buffer);}catch(e){storageError=e.message;}ticket++;busy=false;loaded=false;identity=null;confirm=null;editor?.destroy();editor=null;root.innerHTML=available?'<p class="vazio">Escolha Fishermans ou O Aristocrata para construir um fluxo.</p>':'';return;}
   const endpoint=ctx.api.capabilities.endpoints.journey_graph,operational=lifecycleEndpoint(ctx.api),k=key();const changed=identity?.operational!==operational||brand!==ctx.marca||identity?.endpoint!==endpoint||identity?.key!==k;
   if(changed){capture();if(buffer&&brand)try{state.save('graph',brand,buffer);}catch(e){storageError=e.message;return;}
    ticket++;busy=false;confirm=null;brand=ctx.marca;identity={endpoint,operational,key:k};review=null;loaded=false;catalog=null;rows=[];cursor=null;buffer=null;error='';notice='';storageError='';
    try{client=clientFactory?clientFactory({endpoint,lifecycleEndpoint:operational,key}):API.create({endpoint,lifecycleEndpoint:operational,key});buffer=state.read('graph',brand);if(buffer?.definition?.brand&&buffer.definition.brand!==brand)throw Error('A preparação guardada pertence a outra marca.');refreshPending();}catch(e){storageError=e.message;client=null;}
    shell();
   }
   if(ctx.section==='regua'&&ctx.tab==='graph'&&!loaded&&!busy&&!storageError)return load();
  }
  function contextStatus(){refreshPending();return {brand,dirty:dirty(),blocked:busy||!!confirm||!!storageError||editor?.contextStatus().pendingConfirmation===true,pending:!!pending};}
  return {sync,preserve,contextStatus,available:enabled};
 }
 return {create,enabled};
});
