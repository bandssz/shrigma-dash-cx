/* Server-backed journey editor. Published settings and drafts remain distinct. */
'use strict';
const GB={
 state:{flows:[],selected:null,draft:null,dirty:false,busy:false,loaded:false,error:'',notice:'',templates:{},pending:null},ctx:{},
 e:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 clone:v=>JSON.parse(JSON.stringify(v)),
 brandLabel:brand=>({fish:'Fishermans',aristo:'O Aristocrata',olivas:'Olivas do Campo'}[brand]||'Marca não informada'),
 signature(components){
  const result=[];
  for(const c of components||[]){
   if(['BODY','HEADER'].includes(c.type)){
    const vars=[...new Set([...String(c.text||'').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(m=>m[1]))].sort();
    if(c.type==='HEADER'||vars.length)result.push({type:c.type,format:c.format||null,vars});
   }else if(c.type==='BUTTONS')result.push({type:'BUTTONS',buttons:(c.buttons||[]).map(b=>({type:b.type,url:b.url||null,phone:b.phone_number||null,reply:b.type==='QUICK_REPLY'?b.text:null}))});
  }return result;
 },
 same(a,b){const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;return JSON.stringify(stable(a))===JSON.stringify(stable(b));},
 compatible(template,slot){
  if(template.status!=='APPROVED')return false;
  if(slot.channel==='whatsapp'&&/^pix(?:-|_|$)/.test(slot.piece||'')&&!template.components?.some(c=>c.type==='BUTTONS'&&c.buttons?.some(b=>b.type==='ORDER_DETAILS')))return false;
  if(slot.channel==='whatsapp')return template.language==='pt_BR'&&(slot.category!=='UTILITY'||template.category==='UTILITY')&&GB.same(GB.signature(template.components),slot.signature);
  const content=String(template.components?.body_html||'')+String(template.components?.subject||'');
  const present=[...content.matchAll(/\.Tx\.Data\.([A-Za-z][A-Za-z0-9_]*)/g)].map(m=>m[1]);
  if(!(slot.required_variables||[]).every(v=>present.includes(v)))return false;
  if(String(template.id)===String(slot.template_id))return true;
  if(!template.draft_id)return false;
  const vars=[...(String(template.components?.body_html||'')+String(template.components?.subject||'')).matchAll(/\.Tx\.Data\.([A-Za-z][A-Za-z0-9_]*)/g)].map(m=>m[1]);
  return vars.every(v=>(slot.variables||[]).includes(v));
 },
 endpoint(){return GTA.caps(GB.ctx.api).endpoint;},
 async request(action,body={},write=false,keyOverride=null,endpointOverride=null){
  const endpoint=endpointOverride??GB.endpoint();if(!endpoint)return {ok:false,body:{erro:'endpoint_indisponivel'}};
  let k=keyOverride??(write?(typeof GRU!=='undefined'?GRU.chaveEscrita():''):GTA.chaveLeitura());
  if(write&&!k){k=typeof GRU!=='undefined'?GRU.chaveEscrita(true):null;if(!k)return {ok:false,body:{erro:'Informe a chave de edição para salvar.'}};}
  try{
   const r=await fetch(write?endpoint:endpoint+'?'+new URLSearchParams({acao:action,...body}),write?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({k,acao:action,...body}),redirect:'error',credentials:'omit',signal:typeof AbortSignal!=='undefined'&&AbortSignal.timeout?AbortSignal.timeout(20000):undefined}:{headers:{Authorization:'Bearer '+k},cache:'no-store',redirect:'error',credentials:'omit',signal:typeof AbortSignal!=='undefined'&&AbortSignal.timeout?AbortSignal.timeout(20000):undefined});
   return {ok:r.ok,status:r.status,body:await r.json()};
  }catch(_){return {ok:false,status:0,body:{erro:write?'Resultado não confirmado. Consulte a mesma tentativa antes de repetir.':'Não foi possível confirmar a leitura. Tente novamente.'}};}
 },
 journal(){
  if(typeof GFJ==='undefined')return null;
  const endpoint=GB.endpoint();if(GB._journal?.endpoint===endpoint)return GB._journal.value;
  let storage;try{storage=globalThis.localStorage;}catch(_){}
  const value=GFJ.create({storage,locks:globalThis.navigator?.locks,endpoint,uuid:()=>GTA.uuid()});GB._journal={endpoint,value};return value;
 },
 syncPending(){
  const journal=GB.journal();if(!journal||GB.state.pending?.signature)return null;
  const status=journal.inspect();GB.state.pending=status?.pending||(status?.uncertain?{unavailable:true}:null);return status;
 },
 hasPending(){return !!GB.syncPending()?.pending||!!GB.state.pending;},
 canLeave(){return !GB.state.busy&&!GB.state.dirty&&!GB.hasPending();},
 editingBlocked(){return GB.state.busy||GB.hasPending();},
 hasDifferentDraft(op){return GB.state.dirty&&(GB.state.selected!==op.request_payload.key||GB.state.baseVersion!==op.context.baseVersion||!GB.same(GB.state.draft,op.context.draft));},
 restorePending(){
  const op=GB.syncPending()?.pending;if(!op?.context)return false;
  if(GB.hasDifferentDraft(op))return true;
  GB.state.selected=op.request_payload.key;GB.state.baseVersion=op.context.baseVersion;GB.state.draft=GB.clone(op.context.draft);GB.state.dirty=op.context.dirty;return true;
 },
 async confirmation(action,f,payload){
  if(action==='fluxo_salvar')return true;
  if(typeof document==='undefined'||!document.body)return false;
  const verb=action==='fluxo_publicar'?'Publicar alterações':payload.enabled?'Retomar jornada':'Pausar jornada';
  const effect=action==='fluxo_publicar'?'A versão salva passará a orientar os próximos eventos desta jornada.':payload.enabled?'Os próximos eventos elegíveis poderão seguir a versão publicada.':'Os próximos envios desta jornada ficarão pausados. Mensagens já aceitas ou em trânsito não são recolhidas.';
  const opener=document.activeElement,dialog=document.createElement('dialog');dialog.className='builder-confirm';dialog.id='builder-confirm';dialog.setAttribute('aria-labelledby','builder-confirm-title');dialog.setAttribute('aria-describedby','builder-confirm-effect');
  dialog.innerHTML=`<h2 id="builder-confirm-title">${GB.e(verb)}</h2><dl><dt>Marca</dt><dd>${GB.e(GB.brandLabel(f.brand))}</dd><dt>Jornada</dt><dd>${GB.e(f.name)}</dd><dt>Versão</dt><dd>${GB.e(payload.expected_version)}</dd></dl><p id="builder-confirm-effect">${GB.e(effect)}</p><p class="mini">Compra, descadastro e as demais guardas continuam valendo.</p><div class="builder-confirm-actions"><button type="button" class="btn" data-flow-confirm>${GB.e(verb)}</button><button type="button" class="btn sec" data-flow-cancel>Cancelar</button></div>`;
  document.body.append(dialog);
  return new Promise(resolve=>{
   let settled=false;const done=accepted=>{if(settled)return;settled=true;dialog.remove();opener?.focus?.();resolve(accepted);};
   dialog.querySelector('[data-flow-confirm]').onclick=()=>done(true);dialog.querySelector('[data-flow-cancel]').onclick=()=>done(false);
   dialog.addEventListener('cancel',e=>{e.preventDefault();done(false);});dialog.addEventListener('close',()=>done(false));
   dialog.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();done(false);}if(e.key==='Tab'){const buttons=[...dialog.querySelectorAll('button')],first=buttons[0],last=buttons.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
   if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');dialog.querySelector('[data-flow-cancel]').focus();
  });
 },
 recovery(){
  const latest=[...(GB.journal()?.inspect().operations||[])].reverse().find(op=>op.request_payload.key===GB.state.selected);
  return !GB.state.pending&&latest?.phase==='rejected'&&latest.applied&&latest.context.dirty?latest:null;
 },
 recoverDraft(){
  if(GB.editingBlocked())return;const op=GB.recovery();if(!op)return;
  if(GB.hasDifferentDraft(op)&&!confirm('Há uma edição local diferente. Deseja substituí-la pela edição recusada que ficou guardada?'))return;
  GB.state.selected=op.request_payload.key;GB.state.draft=GB.clone(op.context.draft);GB.state.baseVersion=op.context.baseVersion;GB.state.dirty=true;GB.state.notice='Edição recusada recuperada, com a versão original. Nenhuma alteração foi enviada.';GB.render();
 },
 async applyOperation(result,journal=GB.journal()){
  return journal.apply(result.operation_id,async op=>{
   const r=op.receipt,preserve=GB.hasDifferentDraft(op);
   if(r.ok){const updated=r.body.flow;GB.state.flows=GB.state.flows.map(x=>x.key===updated.key&&x.version<=updated.version?updated:x);
    if(!preserve){GB.state.selected=op.request_payload.key;GB.state.baseVersion=updated.version;GB.state.draft=GB.clone(updated.draft);GB.state.dirty=false;}
    GB.state.error='';GB.state.notice=preserve?'Tentativa confirmada. Sua edição local foi preservada; confira a versão atual antes de salvar.':op.request_payload.acao==='fluxo_publicar'?'Versão publicada. Os próximos eventos usarão estas configurações.':op.request_payload.acao==='fluxo_estado'?(updated.enabled?'Jornada retomada.':'Jornada pausada.'):'Rascunho salvo no servidor.';
   }else{
    if(!preserve){GB.state.selected=op.request_payload.key;GB.state.baseVersion=op.context.baseVersion;GB.state.draft=GB.clone(op.context.draft);GB.state.dirty=op.context.dirty;}
    GB.state.notice=preserve?'Sua edição local foi preservada. A edição recusada continua guardada na jornada de origem.':'';GB.state.error=(r.body.messages||[]).join(' · ')||GTA.erro(r,op.request_payload.acao).texto||r.body.erro;
   }
   return true;
  });
 },
 async reconcile(){
  if(GB.state.busy)return;const op=GB.syncPending()?.pending;if(!op)return;
  const k=typeof GRU!=='undefined'?GRU.chaveEscrita(true):null;if(!k){GB.state.error='Informe o acesso de edição usado nesta tentativa.';GB.render();return;}
  const endpoint=GB.endpoint(),journal=GB.journal();GB.state.busy=true;GB.render();
  try{const result=await journal.reconcile(op.id,(id,action)=>GB.request('fluxo_operacao',{idempotency_key:id,operation_action:action},false,k,endpoint));await GB.applyOperation(result,journal);}
  catch(e){GB.state.error=e.message;}finally{GB.state.busy=false;GB.syncPending();GB.render();}
 },
 async load(){
  if(GB.state.busy)return;GB.state.busy=true;GB.render();
  const r=await GB.request('fluxos_listar');GB.state.busy=false;
  if(typeof GBC!=='undefined'&&GBC.drag){GBC.pendingRender=true;return;}
  if(!r.ok||!Array.isArray(r.body?.flows)){GB.state.error=r.body?.erro||'Não foi possível carregar as jornadas.';GB.state.loaded=true;GB.render();return;}
  GB.state.flows=r.body.flows;GB.state.loaded=true;GB.state.error='';GB.state.templates={};
  if(GB.restorePending()){GB.render();return;}
  if(!GB.state.dirty){const f=GB.visible().find(f=>f.key===GB.state.selected)||GB.visible()[0];if(f)GB.select(f.key,false);}
  else {const f=GB.state.flows.find(f=>f.key===GB.state.selected);if(f)for(const channel of new Set(f.available_steps.map(s=>s.channel)))GB.loadTemplates(f.brand,channel);}
  GB.render();
 },
 visible(){return GB.state.flows.filter(f=>!GB.ctx.marca||GB.ctx.marca==='todas'||f.brand===GB.ctx.marca);},
 select(key,confirmDirty=true){
  if(GB.state.busy||GB.hasPending()&&!GB.state.pending?.unavailable)return;
  if(confirmDirty&&GB.state.dirty&&!confirm('Há alterações não salvas. Deseja descartá-las?'))return;
  const f=GB.state.flows.find(f=>f.key===key);if(!f)return;
  GB.state.selected=key;GB.state.baseVersion=f.version;GB.state.draft=GB.clone(f.draft);GB.state.dirty=false;GB.state.notice='';GB.render();
  for(const channel of new Set(f.available_steps.map(s=>s.channel)))GB.loadTemplates(f.brand,channel);
 },
 async loadTemplates(brand,channel){
  const key=brand+':'+channel;if(GB.state.templates[key])return;
  GB.state.templates[key]=[];const r=await GB.request('listar',{marca:brand,canal:channel});
  if(r.ok)GB.state.templates[key]=(r.body.templates||[]).filter(t=>t.brand===brand&&t.channel===channel);
  else delete GB.state.templates[key];GB.render();
 },
 change(){GB.state.dirty=true;GB.state.notice='';},
 async mutate(action,extra={}){
  if(GB.editingBlocked())return;const f=GB.state.flows.find(f=>f.key===GB.state.selected);if(!f)return;
  if(action!=='fluxo_salvar'&&(GB.state.dirty||!f.runtime_ready))return;
  const payload={acao:action,key:f.key,expected_version:GB.state.baseVersion??f.version,...extra};
  const context={brand:f.brand,name:f.name,baseVersion:payload.expected_version,draft:GB.clone(GB.state.draft),dirty:GB.state.dirty},viewBrand=GB.ctx.marca,flowVersion=f.version;
  if(action==='fluxo_salvar')payload.definition=GB.clone(context.draft);
  if(action==='fluxo_publicar')payload.confirm='publicar';
  if(action==='fluxo_estado')payload.confirm=payload.enabled?'retomar':'pausar';
  const openerId=typeof document!=='undefined'?document.activeElement?.id:null;
  const endpoint=GB.endpoint(),journal=GB.journal();if(!journal){GB.state.error='A proteção de tentativas não está disponível. Nenhuma alteração foi enviada.';GB.render();return;}
  const k=typeof GRU!=='undefined'?GRU.chaveEscrita(true):null;if(!k){GB.state.error='Informe o acesso de edição antes de alterar a jornada.';GB.render();return;}
  GB.state.busy=true;GB.state.error='';GB.render();
  try{
   if(!await GB.confirmation(action,f,payload))return;
   const current=GB.state.flows.find(x=>x.key===payload.key);
   if(GB.state.selected!==payload.key||GB.ctx.marca!==viewBrand||GB.state.baseVersion!==context.baseVersion||GB.state.dirty!==context.dirty||!GB.same(GB.state.draft,context.draft)||current?.version!==flowVersion||current?.brand!==context.brand||GB.hasPending())throw Error('A jornada mudou durante a confirmação. Confira a versão atual antes de continuar. Nenhuma alteração foi enviada.');
   const result=await journal.run({request_payload:payload,context},{transport:p=>{const {acao,...body}=p;return GB.request(acao,body,true,k,endpoint);},lookup:(id,a)=>GB.request('fluxo_operacao',{idempotency_key:id,operation_action:a},false,k,endpoint)});
   await GB.applyOperation(result,journal);
  }catch(e){GB.state.error=e.message;}finally{GB.state.busy=false;GB.syncPending();GB.render();if(openerId)document.getElementById(openerId)?.focus();}
 },
 trackingHtml(step,f,open=false){
  if(typeof GUT==='undefined'||!['fish','aristo'].includes(f.brand))return '';
  const template=(GB.state.templates[f.brand+':'+step.channel]||[]).find(t=>t.brand===f.brand&&t.channel===step.channel&&String(t.id)===String(step.template_id));
  const content=GUT.templateContent(template),slot=f.available_steps.find(x=>x.key===step.key)||step;
  const key=f.key+':'+step.key+':'+(open?'inspector':'summary');
  const runtime=typeof GURT!=='undefined'?GURT.read(f,step):null;
  if(runtime){
   const label=open?'UTMs e origem':`${step.channel==='email'?'E-mail':'WhatsApp'} · ${slot.name||step.key}`,expanded=GB.utmViews?.has(key)?GB.utmViews.get(key):open;
   return `<details class="crm-utm" data-utm-key="${GB.e(key)}"${expanded?' open':''}><summary>${GB.e(label)}</summary>${GUT.render({rows:runtime.rows,label:runtime.label||'Parâmetros preenchidos pelo envio',mode:'content',evidence:runtime.evidence,empty:runtime.empty,sourceExpression:runtime.sourceExpression,open:true})}<span class="crm-utm-note" title="${GB.e(runtime.scope)}">Condições do link ⓘ</span>${GUT.render({rows:GUT.fromContent(content),dynamic:GUT.dynamicFields(content),label:'Links escritos no template',mode:'content',evidence:template?`Template selecionado: ${template.name}${GB.state.dirty?' · edição ainda não salva':''}`:'Conteúdo do template não disponível nesta consulta.',empty:template?'O template usa os endereços fornecidos pela etapa ou não declara UTMs próprias.':'Use Atualizar na jornada para consultar o template selecionado.'})}</details>`;
  }
  return GUT.render({label:open?'UTMs e origem':`${step.channel==='email'?'E-mail':'WhatsApp'} · ${slot.name||step.key}`,rows:GUT.fromContent(content),dynamic:GUT.dynamicFields(content),mode:'content',key,open:GB.utmViews?.has(key)?GB.utmViews.get(key):open,
   evidence:template?`Template selecionado: ${template.name}. ${GB.state.dirty?'Edição ainda não salva.':'Confira a versão publicada antes de alterar.'}`:'Conteúdo do template não disponível nesta consulta.',
   empty:template?'Este template não declara UTMs nos links. O envio pode preencher o endereço; confira a variável da etapa.':'Use Atualizar na jornada para consultar os templates e confira a etapa selecionada.'});
 },
 trackingSummary(f,d){
  if(typeof GUT==='undefined'||!['fish','aristo'].includes(f.brand))return '';
  return `<details class="crm-utm builder-utm" data-journey-utm data-utm-key="${GB.e(f.key)}"${GB.utmViews?.get(f.key)?' open':''}><summary>UTMs da automação · origem e variáveis</summary>${d.steps.map(s=>GB.trackingHtml(s,f)).join('')}</details>`;
 },
 previewHtml(step,f){
  if(typeof GC==='undefined'||typeof GC.previewButton!=='function')return '';
  const draft=GB.state.dirty||f.version!==f.published_version;
  return `<div class="control-preview-action">${GC.previewButton({brand:f.brand,channel:step.channel,id:step.template_id,selection:draft?'draft':'published'},GB.ctx.api)}<span class="control-badge" title="${draft?'A prévia usa o template selecionado neste rascunho; a jornada publicada permanece intacta.':'A prévia consulta o conteúdo do template selecionado nesta etapa.'}">${draft?'Seleção em rascunho':'Template da etapa'}</span></div>`;
 },
 stepHtml(step,index,f){
  const e=GB.e,slot=f.available_steps.find(x=>x.key===step.key)||step;
  const choices=(GB.state.templates[f.brand+':'+step.channel]||[]).filter(t=>GB.compatible(t,slot));
  const current=choices.some(t=>String(t.id)===String(step.template_id));
  const icon=step.channel==='email'?'✉':'◉';
  const wait=Number(slot.max_wait)>0?`<div class="builder-wait"><span>◷</span><label>Após <input type="number" min="${e(slot.min_wait)}" max="${e(slot.max_wait)}" step="0.5" data-step="${index}" data-field="wait_min" value="${e(step.wait_min)}" ${Number(slot.min_wait)===Number(slot.max_wait)?'readonly':''}> minutos ${e(slot.wait_label||'do gatilho')}</label></div>`:'';
  return `<li class="builder-stage ${step.enabled?'':'is-off'}" data-stage="${e(step.key)}">${wait}<div class="builder-message"><div class="builder-message-head"><span class="builder-channel ${e(step.channel)}">${icon}</span><div><small>${step.channel==='email'?'E-MAIL':'WHATSAPP'}</small><strong>${e(slot.name)}</strong></div><label class="builder-toggle"><input type="checkbox" data-step="${index}" data-field="enabled" ${step.enabled?'checked':''} aria-label="Ativar ${e(slot.name)}"><span>Ativa</span></label></div>
   ${slot.kind==='interactive'?`<label>Mensagem<textarea data-step="${index}" data-field="body" rows="4" maxlength="1024">${e(step.body)}</textarea></label>`:`<label>Template<select data-step="${index}" data-field="template_id">${current?'':`<option value="${e(step.template_id)}">${e(step.template_name||'Selecionar template')}</option>`}${choices.map(t=>`<option value="${e(t.id)}" ${String(t.id)===String(step.template_id)?'selected':''}>${e(t.name)}</option>`).join('')}</select></label><button class="builder-text-button" type="button" data-create-template="${e(step.channel)}">+ Criar template de ${step.channel==='email'?'e-mail':'WhatsApp'}</button>`}
   ${slot.kind==='interactive'?'':GB.previewHtml(step,f)}${slot.variables?.length?`<details class="builder-variables"><summary>Dados usados nesta mensagem</summary><dl>${slot.variables.map(v=>`<dt>${e(({first_name:'Primeiro nome',customer_name:'Nome do cliente',checkout_url:'Link do carrinho',order_url:'Link do pedido',order_number:'Número do pedido',tracking_url:'Link de rastreio',tracking_code:'Código de rastreio',coupon:'Cupom',coupon_code:'Código do cupom',nps_url:'Link da pesquisa',p:'Identificação do pedido na pesquisa',e:'Contato da pesquisa',s:'Validação do link da pesquisa'})[v]||'Dado da mensagem')}</dt><dd><code>${e(v)}</code></dd>`).join('')}</dl></details>`:''}${GB.trackingHtml(step,f,true)}
   <div class="builder-stage-actions"><button type="button" data-remove="${index}">Remover etapa</button></div></div></li>`;
 },
 journeySummary(f,d){
  const channels=[...new Set(d.steps.map(s=>s.channel))].map(c=>c==='email'?'E-mail':'WhatsApp').join(' + ');
  const note=f.journey_kind==='nps'?'Pesquisa e lembrete na mesma jornada · prazo desde o registro inicial · seleção às 19h de Brasília':f.journey_kind==='order'?'Cada evento inicia seu próprio ramo · os estados não precisam chegar em sequência':f.available_steps.some(s=>s.flow==='carrinho')?'Todos os toques desde o abandono · compra e elegibilidade conferidas antes de cada envio':'Etapas e canais reunidos pelo objetivo da jornada';
  return `<div class="builder-journey-summary"><span>${GB.e(channels)}</span><span>${d.steps.length} etapas</span><p>${GB.e(note)}</p></div>`;
 },
 stagesHtml(f,d){
  const groups=new Map();d.steps.forEach((step,index)=>{const key=Number(step.wait_min)||0;if(!groups.has(key))groups.set(key,[]);groups.get(key).push({step,index});});
  return [...groups.entries()].sort((a,b)=>a[0]-b[0]).map(([wait,items])=>`<section class="builder-moment"><h3>${wait?`Após ${GB.e(wait)} minutos`:'Ao receber o evento'}</h3><p>${items.some(x=>f.available_steps.find(s=>s.key===x.step.key)?.source_template_id)?'Uma mensagem, conforme a transportadora e os dados disponíveis.':items.some(x=>x.step.variant)?'WhatsApp escolhe a variante A ou B. E-mail segue sua própria etapa.':items.length>1?'Os canais são acionados no mesmo evento.':'A etapa é executada se suas condições continuarem válidas.'}</p><ul class="builder-stages ${items.length>1?'builder-parallel':''}">${items.map(({step,index})=>GB.stepHtml(step,index,f)).join('')}</ul></section>`).join('');
 },
 captureFocus(root){
  const input=document.activeElement;
  if(!root.contains(input)||!input.matches('input,textarea,select'))return null;
  return {flow:root.dataset.builderFlow,version:root.dataset.builderVersion,id:input.id,step:input.closest('[data-stage]')?.dataset.stage,field:input.dataset.field,
   value:input.value,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection};
 },
 restoreFocus(root,kept){
  if(!kept||kept.flow!==root.dataset.builderFlow||kept.version!==root.dataset.builderVersion)return;
  const input=kept.id?[...root.querySelectorAll('[id]')].find(el=>el.id===kept.id):[...root.querySelectorAll('[data-stage]')].find(el=>el.dataset.stage===kept.step)?.querySelector('[data-field="'+kept.field+'"]');
  if(!input||input.disabled)return;
  // Preserve the text still being typed (including a partial numeric value), not
  // the old view of another journey/revision. Input handlers own draft updates.
  if(input.type!=='checkbox')input.value=kept.value;
  input.focus({preventScroll:true});
  if(Number.isInteger(kept.start)&&typeof input.setSelectionRange==='function')try{input.setSelectionRange(kept.start,kept.end,kept.direction);}catch(_){}
 },
 render(ctx){
  if(typeof GBC!=='undefined'&&GBC.drag){if(ctx)GB.ctx=ctx;GBC.pendingRender=true;return;}
  if(ctx){const old=GB.ctx.marca;GB.ctx=ctx;if(old!==ctx.marca&&GB.state.loaded&&!GB.state.dirty&&!GB.hasPending()){const first=GB.visible()[0];if(first&&first.key!==GB.state.selected){GB.select(first.key,false);return;}}}const root=document.querySelector('#control-fluxos');if(!root)return;
  const keptFocus=GB.captureFocus(root);
  GB.utmViews??=new Map();root.querySelectorAll('[data-utm-key]').forEach(el=>GB.utmViews.set(el.dataset.utmKey,el.open));
  GB.syncPending();const s=GB.state,e=GB.e,visible=GB.visible();
  if(s.loaded&&!visible.length&&!s.busy&&!s.dirty&&!s.pending){s.selected=null;s.draft=null;s.baseVersion=null;}
  const f=visible.find(x=>x.key===s.selected),d=s.draft;
  if(!s.loaded&&!s.busy){GB.load();return;}
  const rail=`<aside class="builder-rail"><div class="builder-rail-title">Jornadas <span>${visible.length}</span></div>${visible.map(x=>`<button type="button" class="builder-flow ${x.key===s.selected?'selected':''}" data-flow-key="${e(x.key)}"><span class="builder-dot ${x.enabled?'on':''}"></span><span><strong>${e(x.name)}</strong><small>${e(GB.brandLabel(x.brand))} · ${x.draft.steps.length} etapas</small></span></button>`).join('')}${!visible.length?`<p>${s.busy?'Carregando jornadas…':s.error?'Lista de jornadas indisponível.':'Nenhuma jornada nesta marca.'}</p>`:''}<button type="button" class="builder-reload" id="builder-reload" ${s.busy?'disabled':''}>${s.busy?'Carregando…':s.error?'Tentar novamente':'↻ Atualizar'}</button></aside>`;
  const visual=typeof GBC!=='undefined'&&!!(f&&d);
  const available=f?f.available_steps.filter(x=>!d?.steps.some(y=>y.key===x.key)):[];
  const recovery=GB.recovery();
  const feedback=`${recovery?`<div class="builder-notice" role="status">Uma edição recusada desta jornada está guardada neste navegador.<button type="button" id="builder-recover-draft" ${s.busy?'disabled':''}>Recuperar edição recusada</button></div>`:''}${s.pending?`<div class="builder-alert" role="status">${e(s.pending.context?GB.brandLabel(s.pending.context.brand)+' · '+s.pending.context.name+': tentativa sem confirmação. Consulte antes de editar ou repetir.':'O registro da tentativa precisa ser conciliado. Preserve este navegador.')}<button type="button" id="builder-reconcile" ${s.busy||!s.pending.request_payload?'disabled':''}>Consultar tentativa</button></div>`:''}${s.error?`<div class="builder-alert" role="alert">${e(s.error)}</div>`:''}${s.notice?`<div class="builder-notice" role="status">${e(s.notice)}</div>`:''}`;
  const main=f&&d?`<main class="builder-main">${visual?feedback:''}<header class="builder-header"><div><label class="builder-flow-label">Jornada<select id="builder-flow-picker">${visible.map(x=>`<option value="${e(x.key)}" ${x.key===s.selected?'selected':''}>${e(GB.brandLabel(x.brand))} · ${e(x.name)}</option>`).join('')}</select></label><span class="builder-eyebrow">${e(GB.brandLabel(f.brand).toUpperCase())} / AUTOMAÇÃO</span><input class="builder-title" aria-label="Nome da jornada" id="builder-name" value="${e(d.name)}" maxlength="120"><div class="builder-status"><span class="builder-status-pill ${f.enabled?'live':''}">${!f.runtime_ready?'Em preparação':f.enabled?'Ativo':'Pausado'}</span><span>Publicada v${f.published_version}</span>${s.dirty||f.version!==f.published_version?'<span class="builder-draft-label">Alterações em rascunho</span>':''}</div></div><div class="builder-header-actions">${visual?`<button type="button" id="builder-reload" ${s.busy?'disabled':''}>↻ Atualizar</button>`:''}<button type="button" id="builder-toggle" ${s.busy||s.pending||s.dirty||!f.runtime_ready?'disabled':''}>${f.enabled?'Pausar':'Retomar'}</button><button type="button" id="builder-save" ${s.busy||s.pending||!s.dirty?'disabled':''}>Salvar rascunho</button><button type="button" class="builder-primary" id="builder-publish" ${s.busy||s.pending||s.dirty||!f.runtime_ready?'disabled':''}>Publicar alterações</button></div></header>
   ${GB.journeySummary(f,d)}${GB.trackingSummary(f,d)}${visual?GBC.html(f,d):`   <div class="builder-canvas"><div class="builder-trigger"><span class="builder-trigger-icon">↯</span><div><small>ENTRADA NA JORNADA</small><strong>${e(f.trigger)}</strong><p>${e(f.binding_description||'Cada evento mantém sua identidade para evitar envios repetidos.')}</p></div></div>
   ${GB.stagesHtml(f,d)}
   ${available.length?`<div class="builder-add"><select id="builder-add-slot" aria-label="Etapa para adicionar">${available.map(x=>`<option value="${e(x.key)}">${e(x.name)} · ${x.channel==='email'?'E-mail':'WhatsApp'}</option>`).join('')}</select><button type="button" id="builder-add">+ Adicionar etapa</button></div>`:''}
   <div class="builder-end">✓ Fim da jornada</div><div class="builder-exits"><strong>Saídas automáticas</strong><span>${e(f.exit_description||'Compra, cancelamento e descadastro são respeitados pelas guardas de cada jornada.')}</span></div>
   ${!f.runtime_ready?'<p class="builder-runtime-note">Você pode preparar e salvar esta jornada. A publicação será liberada quando a conexão com a operação estiver concluída.</p>':''}</div>`}</main>`:`<main class="builder-main builder-empty" role="status">${s.busy?'Carregando jornadas…':s.error?'Tente novamente para carregar as jornadas.':visible.length?'Selecione uma jornada para editar suas etapas.':'Nenhuma jornada disponível para a marca selecionada.'}</main>`;
  root.innerHTML=`${visual&&f&&d?'':feedback}<div class="builder-layout ${visual?'builder-visual':''}" aria-busy="${s.busy}">${visual?'':rail}${main}</div>`;root.dataset.builderFlow=f?.key||'';root.dataset.builderVersion=String(s.baseVersion??'');GB.bind(root);if(visual&&f&&d)GBC.mount(root,f,d);GB.restoreFocus(root,keptFocus);
 },
 bind(root){
  if(typeof GC!=='undefined'&&typeof GC.bindPreviews==='function')GC.bindPreviews(root,GB.ctx);
  if(GB.editingBlocked())root.querySelectorAll('[data-step],[data-remove],[data-create-template],#builder-name,#builder-add,#builder-add-slot').forEach(el=>el.disabled=true);
  if(GB.state.busy||GB.state.pending&&!GB.state.pending.unavailable)root.querySelectorAll('[data-flow-key],#builder-flow-picker').forEach(el=>el.disabled=true);
  root.querySelectorAll('[data-flow-key]').forEach(b=>b.onclick=()=>GB.select(b.dataset.flowKey));
  root.querySelector('#builder-flow-picker')?.addEventListener('change',ev=>{GB.select(ev.target.value);ev.target.value=GB.state.selected;});
  root.querySelector('#builder-reload')?.addEventListener('click',()=>GB.load());
  root.querySelector('#builder-reconcile')?.addEventListener('click',()=>GB.reconcile());
  root.querySelector('#builder-recover-draft')?.addEventListener('click',()=>GB.recoverDraft());
  if(!GB._storageListener&&globalThis.addEventListener){GB._storageListener=true;globalThis.addEventListener('storage',ev=>{if(typeof GFJ!=='undefined'&&ev.key===GFJ.SLOT){GB.syncPending();GB.render();}});}
  root.querySelector('#builder-name')?.addEventListener('input',ev=>{GB.state.draft.name=ev.target.value;GB.change();GB.refreshActions();});
  root.querySelectorAll('[data-step]').forEach(input=>{
   const storeInput=()=>{const step=GB.state.draft.steps[Number(input.dataset.step)],field=input.dataset.field;
    step[field]=field==='enabled'?input.checked:field==='wait_min'?Number(input.value):input.value;
    if(field==='wait_min'&&step.channel==='whatsapp'&&step.variant)GB.state.draft.steps.filter(s=>s.channel===step.channel&&s.piece===step.piece).forEach(s=>s.wait_min=step.wait_min);
    GB.change();GB.refreshActions();
   };
   if(['body','wait_min'].includes(input.dataset.field))input.addEventListener('input',storeInput);
   input.addEventListener('change',()=>{
   const step=GB.state.draft.steps[Number(input.dataset.step)],field=input.dataset.field;
   storeInput();
   if(field==='template_id'){
    const f=GB.state.flows.find(x=>x.key===GB.state.selected),t=(GB.state.templates[f.brand+':'+step.channel]||[]).find(x=>String(x.id)===String(input.value));
    if(t)step.template_name=t.name;
   }
   if(field==='enabled')input.closest('.builder-stage')?.classList.toggle('is-off',!step.enabled);
   if(field==='template_id'){GB.render();return;}
   if(typeof GBC!=='undefined')GBC.redraw();
   if(field==='wait_min'){
    root.querySelectorAll('[data-field="wait_min"]').forEach(el=>el.value=GB.state.draft.steps[Number(el.dataset.step)].wait_min);
    const title=input.closest('.builder-moment')?.querySelector('h3');if(title)title.textContent='Espera alterada · salve para reorganizar as etapas';
   }
   });
  });
  root.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{GB.state.draft.steps.splice(+b.dataset.remove,1);GB.change();GB.render();});
  root.querySelector('#builder-add')?.addEventListener('click',()=>{const f=GB.state.flows.find(x=>x.key===GB.state.selected),key=root.querySelector('#builder-add-slot').value,slot=f.available_steps.find(s=>s.key===key);GB.state.draft.steps.push(GB.clone(slot));GB.change();GB.render();});
  root.querySelector('#builder-save')?.addEventListener('click',()=>GB.mutate('fluxo_salvar'));
  root.querySelector('#builder-publish')?.addEventListener('click',()=>GB.mutate('fluxo_publicar'));
  root.querySelector('#builder-toggle')?.addEventListener('click',()=>{const f=GB.state.flows.find(x=>x.key===GB.state.selected);GB.mutate('fluxo_estado',{enabled:!f.enabled});});
  root.querySelectorAll('[data-create-template]').forEach(b=>b.onclick=()=>{
   const f=GB.state.flows.find(x=>x.key===GB.state.selected);document.querySelector('[data-control-tab="drafts"]')?.click();
   delete GB.state.templates[f.brand+':'+b.dataset.createTemplate];
   GRU.abrir(GR.novo({marca:f.brand,canal:b.dataset.createTemplate}),null);
  });
 },
 refreshActions(){const t=document.querySelector('#builder-toggle');if(t)t.disabled=true;const b=document.querySelector('#builder-save');if(b)b.disabled=GB.editingBlocked()||!GB.state.dirty;const p=document.querySelector('#builder-publish');if(p)p.disabled=true;},
};
if(typeof module!=='undefined'&&module.exports)module.exports=GB;
