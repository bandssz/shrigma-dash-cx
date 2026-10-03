(function(root,factory){'use strict';if(typeof module==='object'&&module.exports)module.exports=factory(require('./growth-campaign-audience-client.js'),require('./growth-segment-client.js'),require('./growth-campaign-regular-client.js'));else root.GCAudienceUI=factory(root.GCAC,root.GSC,root.GCRC);})(typeof globalThis==='undefined'?this:globalThis,function(Binding,Segments,Regular){
 'use strict';
 const clone=x=>JSON.parse(JSON.stringify(x)),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const brandName=b=>b==='fish'?'Fishermans':'O Aristocrata';
 // Agendamento sempre em Brasília, como no editor; nunca no fuso do navegador.
 const brasilia=v=>new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}).format(new Date(v))+' · Brasília';
 const brasiliaClock=v=>new Date(v).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo'})+' (Brasília)';
 const operatorName={eq:'igual a',gt:'maior que',gte:'maior ou igual a',lt:'menor que',lte:'menor ou igual a',before:'antes de',on_or_before:'até',after:'depois de',on_or_after:'a partir de',purchased:'comprou',not_purchased:'não comprou nos pedidos identificados',is:'é',is_not:'não é',within_last_days:'nos últimos dias',not_within_last_days:'sem registro nos últimos dias'};
 const messages={
  REGULAR_ADMISSION_EMPTY:'Nenhuma pessoa está elegível neste público. Confira as condições e o consentimento.',
  REGULAR_ADMISSION_SOURCE_UNAVAILABLE:'A fonte deste público não está disponível agora; a quantidade está desconhecida (não é zero). Nada foi agendado. Confira novamente mais tarde.',
  REGULAR_ADMISSION_CHANGED:'O conteúdo, público ou serviço de envio mudou. Confira novamente antes de agendar.',
  REGULAR_ADMISSION_EXPIRED:'A conferência venceu. Confira conteúdo e público novamente.',
  REGULAR_ADMISSION_SCHEDULE_TOO_SOON:'Salve a campanha com pelo menos 15 minutos de antecedência.',
  REGULAR_ADMISSION_ATTACHMENTS_UNAVAILABLE:'O envio por público salvo ainda não aceita anexos. Remova o anexo e salve novamente.',
  REGULAR_ADMISSION_RENDER_UNAVAILABLE:'O template usa uma função ainda não disponível para público salvo. Revise o template antes de agendar.',
  REGULAR_ADMISSION_UNCONFIRMED:'O agendamento ainda não foi confirmado. Consulte a mesma tentativa antes de continuar.',
  REGULAR_ADMISSION_UNAVAILABLE:'O serviço de agendamento deste público ainda não está disponível.',
  REGULAR_ADMISSION_ACCESS_CHANGED:'O acesso mudou. Restaure o acesso original para consultar a tentativa.',
  REGULAR_ADMISSION_HEADERS_UNAVAILABLE:'A configuração de envio desta campanha precisa de revisão. Salve a campanha novamente pelo editor e confira.',
  REGULAR_ADMISSION_SENDER_UNAVAILABLE:'O remetente ainda não foi liberado para esta marca. Confira a configuração antes de agendar.',
  SEGMENT_BINDING_BASE_REQUIRED:'Selecione apenas a lista base indicada abaixo e salve a campanha antes de conferir este público.',
  SEGMENT_BINDING_VERSION_CONFLICT:'A campanha ou o público mudou. Reabra a campanha e confira novamente.',
  SEGMENT_BINDING_AUDIENCE_CHANGED:'O público mudou ou foi arquivado. Atualize a lista e confira a versão atual.',
  SEGMENT_BINDING_CHANGED:'A conferência mudou. Reabra a campanha e confira novamente.',
  SEGMENT_BINDING_RELEASE_BLOCKED:'Esta campanha tem preparação ou operação em andamento. Conclua ou cancele essa etapa antes de voltar às listas.',
  SEGMENT_BINDING_RELEASE_CHANGED:'A campanha ou o vínculo mudou. Reabra a campanha antes de voltar às listas.',
  SEGMENT_AUDIENCE_LIST_UNAVAILABLE:'Os públicos salvos não puderam ser listados. O vínculo atual foi conferido e ainda pode ser removido.',
  SEGMENT_BINDING_UNCONFIRMED:'O resultado ainda não foi confirmado. Consulte a mesma tentativa antes de continuar.',
  SEGMENT_BINDING_OPERATION_PENDING:'Há uma tentativa sem confirmação. Consulte a mesma tentativa.',
  SEGMENT_BINDING_ACCESS_CHANGED:'O acesso mudou. Restaure o acesso da tentativa original para consultar.',
  SEGMENT_UNAUTHORIZED:'O acesso não foi confirmado. Confira sua sessão do CRM.',
  SEGMENT_ACCESS_DENIED:'Seu acesso não permite esta ação.',
  UI_CAMPAIGN_CHANGED:'A campanha mudou. Reabra a versão salva antes de continuar.',
  UI_INSPECTION_EXPIRED:'A conferência venceu. Confira o público novamente.',
  UI_CONFIRMATION_UNAVAILABLE:'Este navegador não conseguiu abrir a confirmação. Nenhum vínculo foi solicitado.',
  UI_CONTEXT_CHANGED:'A campanha, o público ou o acesso mudou durante a conferência. Confira novamente.'
 };
 const fail=code=>{throw Object.assign(Error(code),{code});};
 function create({element,key,storage=localStorage,fetch:fetcher=fetch,locks=globalThis.navigator?.locks,identity,id,now=()=>Date.now(),onChange=()=>{},onBound=async()=>{},getCampaignContext=()=>null,Client=Binding,SegmentClient=Segments}={}){
  if(!element||typeof key!=='function'||!Client||!SegmentClient)throw Error('CAMPAIGN_AUDIENCE_UI_CONFIG');
  let ctx=null,client=null,regular=null,segments=null,rows=[],catalog=null,offset=0,more=false,selected='',inspection=null,readConfirmed=false,busy=false,busyRead=false,confirmation=null,error='',notice='',baseList=null,fatal=false,reviewTimer=null,destroyed=false;
  const q=s=>element.querySelector(s),pending=()=>!!client?.pending()||!!regular?.pending(),selectedRow=()=>rows.find(r=>r.id===selected&&!r.archived&&r.semantic_context?.current===true);
  const available=x=>!!x&&!!x.token&&['fish','aristo'].includes(x.brand)&&Client.caps(x.api).read&&Client.caps(x.api).brands.includes(x.brand)&&SegmentClient.caps(x.api).read&&SegmentClient.caps(x.api).contract_version==='crm-audience-v2'&&SegmentClient.caps(x.api).brands.includes(x.brand);
  const eligible=()=>available(ctx)&&ctx.campaign?.id&&ctx.campaign.status==='draft'&&ctx.campaign.sent===0&&ctx.campaign.started_at===null;
  const locked=()=>busy||!!confirmation||pending()||fatal||!!ctx?.blocked;
  const state=()=>client?.snapshot()||{};
  function history(){const id=ctx?.campaign?.id||ctx?.localCampaignId;if(!id||!['fish','aristo'].includes(ctx.brand))return false;try{return !!storage.getItem(Client.SLOT+ctx.brand+':'+id)||!!(Regular&&storage.getItem(Regular.SLOT+ctx.brand+':'+id));}catch{return true;}}
  // A local record is not authority to resume: when access disappears, freeze
  // the context until its original authenticated client can reconcile it.
  const unresolvedHistory=()=>history()&&(!available(ctx)||!ctx?.campaign);
  const canValidate=()=>eligible()&&ctx.clean&&!locked()&&readConfirmed&&!!state().binding?.campaign_current&&state().binding?.semantic_context?.current===true&&Client.caps(ctx.api).validate===true;
  const canSchedule=()=>{const r=regular?.snapshot().review;return !!(regular&&canValidate()&&regular.capabilities().schedule&&r&&r.campaign_version===ctx.campaign.version&&r.binding_hash===state().binding?.binding_hash&&Date.parse(r.expires_at)>now());};
  const status=()=>({canSchedule:canSchedule(),canValidate:!!canValidate(),active:available(ctx),blocked:busy||!!confirmation||fatal||unresolvedHistory(),activeOperation:busy||!!confirmation,reading:busy&&busyRead&&!confirmation,confirming:!!confirmation,pending:pending(),bound:!!state().binding,readConfirmed,readError:!!error,recoveryRequired:fatal||unresolvedHistory(),legacyBlocked:!!ctx?.campaign&&(!!state().binding||pending()||((available(ctx)||history())&&(!readConfirmed||busy||!!confirmation||fatal)))});
  function audienceSummary(row){
   const contract=SegmentClient.contractFor(ctx.api),rule=row.definition.rule,value=(r,f)=>{if(f.type==='product')return catalog?.products.find(x=>x.id===r.value)?.name||'produto indisponível';if(f.type==='origin')return catalog?.origins.find(x=>x.key===r.value)?.name||'origem indisponível';if(f.type==='money')return `${r.value} ${row.semantic_context?.currency||catalog?.currency||''}`.trim();return r.value;};
   const walk=r=>{if(r.op==='confirmed')return walk(r.rule)+' · somente cadastros com dados confirmados';if(r.op==='in_list')return `lista ${catalog?.lists.find(x=>x.id===r.list_id)?.name||'indisponível'}`;if(r.op==='condition'){const f=contract.FIELDS[r.field];return `${f.label}: ${operatorName[r.operator]} ${value(r,f)}`;}return `(${r.rules.map(walk).join(r.op==='and'?' E ':' OU ')})`;};
   return walk(rule);
  }
  function audienceFreshness(row){
   const contract=SegmentClient.contractFor(ctx.api),usesShopify=rule=>rule.op==='confirmed'?usesShopify(rule.rule):rule.op==='condition'?contract.FIELDS[rule.field]?.source==='shopify':(rule.rules||[]).some(usesShopify),updated=`Atualizado no painel em ${new Date(row.updated_at).toLocaleString('pt-BR')}.`;
   if(!usesShopify(row.definition.rule))return updated+' Este público não usa condição Shopify.';
   const s=catalog?.shopify_snapshot;if(!s?.current)return updated+' A atualização Shopify não está confirmada; revise o público antes de usar.';
   return `${updated} Dados Shopify coletados até ${new Date(s.observed_at).toLocaleString('pt-BR')}, válidos até ${new Date(s.expires_at).toLocaleString('pt-BR')}. A sincronização é noturna.`;
  }
  function render(){
   if(destroyed)return;
   if(reviewTimer!==null){clearTimeout(reviewTimer);reviewTimer=null;}
   element.hidden=!available(ctx)&&!history()&&!state().binding;if(element.hidden)return;
   if(!available(ctx)||unresolvedHistory()){if(!confirmation)element.innerHTML='<h4>Público salvo</h4><p role="status">A consulta deste vínculo está indisponível. O registro foi preservado; confira o vínculo com o acesso original antes de agendar.</p>';return;}
   // Keep the dialog node intact until its own lifecycle finishes.
   if(confirmation)return;
   if(!ctx.campaign){element.innerHTML='<h4>Público salvo</h4><p>Salve a campanha para escolher um público reutilizável.</p>';return;}
   const row=selectedRow(),s=state(),bound=s.binding,can=eligible()&&ctx.clean&&!locked(),inspected=!!inspection&&row?.id===inspection.intent?.audience_id&&row.version===inspection.intent?.audience_revision;
   const description=bound?`Público vinculado · versão ${bound.audience_revision}. ${bound.campaign_current===false?'A campanha mudou após o vínculo. Confira e vincule a versão atual.':(regular?.capabilities().prepare?'Confira o conteúdo e o público antes de agendar.':'O disparo deste público ainda aguarda liberação.')}`:readConfirmed?'Esta campanha ainda usa as listas selecionadas.':'Carregue os públicos para conferir o vínculo atual desta campanha.';
   // Capacidade ausente (somente leitura) explica o botão desabilitado em vez de deixá-lo mudo.
   const access=Client.caps(ctx.api),accessNote=!access.inspect?'Seu acesso a públicos salvos é de leitura: consultar o vínculo está disponível; conferir e usar outro público não estão liberados.':!access.bind?'Seu acesso a públicos salvos é de leitura: conferir está disponível; usar outro público nesta campanha não está liberado.':'';
   const ready=regular?.snapshot().review,regularValid=ready&&ctx.clean&&ready.campaign_version===ctx.campaign.version&&Date.parse(ready.expires_at)>now();
   const checked=s.validation,valid=checked&&ctx.token===key()&&ctx.clean&&checked.binding.campaign_version===ctx.campaign.version&&Date.parse(checked.expires_at)>now();
   if(regularValid)reviewTimer=setTimeout(()=>{reviewTimer=null;changed();},Math.max(1,Date.parse(ready.expires_at)-now()+1));
   if(valid&&!regularValid)reviewTimer=setTimeout(()=>{reviewTimer=null;changed();},Math.max(1,Date.parse(checked.expires_at)-now()+1));
   reviewTimer?.unref?.();
   const reviewText=valid?(checked.content.ok?'Conteúdo conferido. ':'Revise o conteúdo e salve novamente. ')+(checked.audience.source_confirmed?`${checked.audience.eligible_count} pessoas elegíveis no público escolhido, com consentimento conferido neste momento.`:'A fonte deste público não está disponível; a quantidade permanece desconhecida.')+' A conferência não reserva destinatários nem libera envio.':checked?'A conferência venceu ou a campanha mudou. Confira conteúdo e público novamente.':'';
   element.innerHTML=`<h4>Público salvo</h4><p>${esc(description)}</p><p class="ce-audience-warning">${regular?.capabilities().prepare?'A quantidade é conferida novamente ao confirmar. Descadastros continuam sendo respeitados até o envio.':'A escolha pode ser preparada aqui. O envio por público salvo ainda não está disponível.'}</p>
    <div class="ce-actions"><button type="button" class="ce-secondary" data-ca="load" ${locked()?'disabled':''}>Carregar públicos salvos</button><button type="button" class="ce-secondary" data-ca="consult" ${!pending()||busy||!!ctx.blocked?'disabled':''} ${pending()?'':'hidden'}>Consultar tentativa</button></div>
    ${rows.length?`<label>Escolha o público de ${brandName(ctx.brand)}<select data-ca-select ${!can?'disabled':''}><option value="">Selecione um público</option>${rows.filter(r=>!r.archived).map(r=>`<option value="${esc(r.id)}" ${r.id===selected?'selected':''} ${r.semantic_context?.current!==true?'disabled':''}>${esc(r.name)} · versão ${r.version}${r.semantic_context?.current!==true?' · precisa de revisão':''}</option>`).join('')}</select></label>`:readConfirmed?'<p>Nenhum público disponível nesta página. Crie e salve um público na seção Público.</p>':''}
    ${row?`<div data-ca-audience-details><p data-ca-audience-summary><strong>Regras salvas:</strong> ${esc(audienceSummary(row))}</p><p data-ca-audience-freshness>${esc(audienceFreshness(row))}</p><p data-ca-audience-count-guidance>Para conferir a quantidade atual, abra Público, reabra esta versão e use Contar público.</p></div>`:''}
    ${offset||more?`<div class="ce-actions"><button type="button" class="ce-secondary" data-ca="previous" ${locked()||offset===0?'disabled':''}>Anteriores</button><button type="button" class="ce-secondary" data-ca="next" ${locked()||!more?'disabled':''}>Próximos</button></div>`:''}
    ${!ctx.clean?'<p>Salve as alterações da campanha antes de conferir ou vincular um público.</p>':''}
    ${baseList?`<p data-ca-base>Lista base necessária: <strong>${esc(baseList.name)}</strong>. Selecione somente essa lista no catálogo da campanha e salve.</p>`:''}
    ${inspection?`<p data-ca-inspection>Conferido: <strong>${esc(inspection.audience_name)}</strong>, versão ${inspection.intent.audience_revision}. Esta conferência confirma a configuração; não informa quantidade de destinatários nem libera o envio.</p>`:''}
    <div class="ce-actions"><button type="button" class="ce-secondary" data-ca="inspect" ${!can||!row||!Client.caps(ctx.api).inspect?'disabled':''}${!access.inspect?' aria-describedby="ca-access-note"':''}>Conferir público escolhido</button><button type="button" class="ce-primary" data-ca="bind" ${!can||!inspected||!client?.canWrite()?'disabled':''}${accessNote?' aria-describedby="ca-access-note"':''}>Usar este público</button>${bound?`<button type="button" class="ce-secondary" data-ca="release" ${!can||!client?.canRelease()?'disabled':''}>Voltar a listas existentes</button>`:''}</div>${accessNote?`<p class="ce-audience-warning" id="ca-access-note" data-ca-access>${esc(accessNote)}</p>`:''}
    ${ready?`<p data-ca-regular-review>${regularValid?esc(ready.eligible_count+' pessoas elegíveis. Agendamento preparado para '+brasilia(ready.send_at)+'. Confirme antes de '+brasiliaClock(ready.expires_at)+'.'):'A conferência venceu ou a campanha mudou. Confira conteúdo e público novamente.'}</p>`:''}
    ${reviewText?`<p data-ca-validation role="status">${esc(reviewText)}</p>`:''}
    <p data-ca-status role="status" aria-live="polite" data-error="${!!error}">${esc(error||notice||(busy?'Conferindo…':''))}</p>
    <dialog class="ce-confirm" data-ca-dialog aria-labelledby="ca-confirm-title"><h4 id="ca-confirm-title">Confirmar público</h4><p data-ca-confirm-text></p><div class="ce-actions"><button type="button" class="ce-secondary" data-ca-no autofocus>Voltar</button><button type="button" class="ce-primary" data-ca-yes>Confirmar público</button></div></dialog>`;
  }
  function changed(){if(destroyed)return;render();onChange();}
  // O render recria os botões: devolve o foco ao botão equivalente a quem abriu a confirmação.
  function refocus(caller){const same=caller?.dataset?.ca?q('[data-ca="'+caller.dataset.ca+'"]'):null;(caller?.isConnected&&!caller.disabled?caller:same&&!same.disabled?same:q('[data-ca="load"]'))?.focus();}
  const identityContext=()=>({brand:ctx?.brand,campaign:ctx?.campaign?.id,version:ctx?.campaign?.version,token:key(),bindingEndpoint:Client.caps(ctx?.api).endpoint,segmentsEndpoint:SegmentClient.caps(ctx?.api).endpoint,caps:JSON.stringify(ctx?.api),clean:ctx?.clean,blocked:ctx?.blocked,campaignContext:getCampaignContext()});
  function current(before){return same(before,identityContext())&&ctx?.token===key();}
  function syncedVersion(){if(state().campaign_version!==ctx.campaign.version)fail('UI_CAMPAIGN_CHANGED');}
  async function guarded(work,{read=false}={}){if(busy||confirmation)return;busy=true;busyRead=read;error='';notice='';baseList=null;changed();try{await work();}catch(e){error=messages[e?.code]||'Não foi possível confirmar esta ação. Preserve a tentativa e confira o estado atual.';if(e?.code==='SEGMENT_BINDING_BASE_REQUIRED'&&e.baseList)baseList=clone(e.baseList);}finally{busy=false;busyRead=false;changed();}}
  async function load(page=0){if(pending()||fatal)return;await guarded(async()=>{
   if(!eligible())fail('UI_CAMPAIGN_CHANGED');const before=identityContext();inspection=null;readConfirmed=false;
   await client.read(ctx.campaign.id);if(!current(before))fail('UI_CONTEXT_CHANGED');syncedVersion();
   readConfirmed=true;rows=[];catalog=null;offset=0;more=false;selected='';
   let listed;try{listed=await segments.list({offset:page,limit:50});}catch{fail('SEGMENT_AUDIENCE_LIST_UNAVAILABLE');}if(!current(before))fail('UI_CONTEXT_CHANGED');
   rows=listed.segments;catalog=listed.catalog;offset=page;more=rows.length===50;selected='';readConfirmed=true;
  },{read:true});}
  // Reopening a saved campaign first checks its current binding with a GET.
  // A null binding permits the existing list-based validation path; a binding
  // keeps that path blocked until the saved-audience flow is reconciled.
  async function confirmBindingRead(){
   if(!eligible()||!ctx.clean||locked())return false;
   await guarded(async()=>{
    const before=identityContext();inspection=null;readConfirmed=false;
    await client.read(ctx.campaign.id);if(!current(before))fail('UI_CONTEXT_CHANGED');syncedVersion();
    readConfirmed=true;notice=state().binding?'Vínculo do público salvo confirmado. Confira o conteúdo e a liberação antes de agendar.':'Nenhum público salvo vinculado a esta campanha. Confira o conteúdo e as listas antes de agendar.';
   },{read:true});
   return readConfirmed;
  }
  async function inspect(){if(!eligible()||!ctx.clean||locked()||!Client.caps(ctx.api).inspect)return;const row=selectedRow();if(!row)return;await guarded(async()=>{
   const before=identityContext();inspection=null;await client.inspect(ctx.campaign.id,{id:row.id,version:row.version});if(!current(before)||selected!==row.id)fail('UI_CONTEXT_CHANGED');
   const fresh=state().inspection;
   if(fresh?.intent?.expected_campaign_version!==ctx.campaign.version||fresh.intent.audience_id!==row.id||fresh.intent.audience_revision!==row.version)fail('UI_CAMPAIGN_CHANGED');
   inspection=clone(fresh);notice='Confira a campanha e o público antes de confirmar o vínculo.';
  });}
  async function confirmBinding(){
   if(!eligible()||!ctx.clean||locked()||!inspection||!selectedRow()||!client.canWrite())return;
   const caller=element.ownerDocument.activeElement,before=identityContext(),review=clone(inspection),row=selectedRow(),dialog=q('[data-ca-dialog]');
   if(typeof dialog?.showModal!=='function'||typeof dialog?.close!=='function'){error=messages.UI_CONFIRMATION_UNAVAILABLE;changed();return;}
   if(Date.parse(review.expires_at)<=now()){inspection=null;error=messages.UI_INSPECTION_EXPIRED;changed();return;}
   let accepted=false;error='';
   try{
    const request=JSON.stringify(review);confirmation={};onChange();
    accepted=await new Promise(resolve=>{
     let finished=false;const done=value=>{if(finished)return;finished=true;dialog.oncancel=null;dialog.onclose=null;q('[data-ca-yes]').onclick=null;q('[data-ca-no]').onclick=null;try{dialog.close();}catch{dialog.removeAttribute('open');}resolve(value);};
     q('[data-ca-confirm-text]').textContent=`Usar “${row.name}”, versão ${row.version}, na campanha “${ctx.campaign.definition.name}” de ${brandName(ctx.brand)}? A campanha permanecerá em rascunho, com envio indisponível para este público.`;
     q('[data-ca-yes]').onclick=()=>done(true);q('[data-ca-no]').onclick=()=>done(false);dialog.oncancel=e=>{e.preventDefault();done(false);};dialog.onclose=()=>done(false);confirmation.finish=done;
     try{dialog.showModal();q('[data-ca-no]').focus();}catch{done(false);error=messages.UI_CONFIRMATION_UNAVAILABLE;}
    });
    if(accepted&&(!current(before)||ctx.token!==key()||JSON.stringify(inspection)!==request||selected!==row.id||!ctx.clean))fail('UI_CONTEXT_CHANGED');
    if(accepted&&Date.parse(review.expires_at)<=now())fail('UI_INSPECTION_EXPIRED');
   }catch(e){accepted=false;error=messages[e?.code]||messages.UI_CONTEXT_CHANGED;}
   finally{confirmation=null;changed();}
   if(accepted)await guarded(async()=>{await client.bind(review.intent);inspection=null;readConfirmed=true;notice='Público vinculado. Atualizando a versão salva da campanha…';await onBound(ctx.campaign.id);notice='Público vinculado. O disparo ainda aguarda liberação.';});
   refocus(caller);
  }
  async function confirmRelease(){
   if(!eligible()||!ctx.clean||locked()||!state().binding||!client.canRelease())return;
   const caller=element.ownerDocument.activeElement,before=identityContext(),bound=clone(state().binding),dialog=q('[data-ca-dialog]');
   if(typeof dialog?.showModal!=='function'||typeof dialog?.close!=='function'){error=messages.UI_CONFIRMATION_UNAVAILABLE;changed();return;}
   let accepted=false;error='';confirmation={};onChange();
   try{
    accepted=await new Promise(resolve=>{
     let finished=false;const done=value=>{if(finished)return;finished=true;dialog.oncancel=null;dialog.onclose=null;q('[data-ca-yes]').onclick=null;q('[data-ca-no]').onclick=null;try{dialog.close();}catch{dialog.removeAttribute('open');}resolve(value);};
     q('#ca-confirm-title').textContent='Voltar a listas existentes';q('[data-ca-yes]').textContent='Voltar às listas';
     q('[data-ca-confirm-text]').textContent=`Remover o uso do público salvo nesta campanha de ${brandName(ctx.brand)}? A campanha continuará em rascunho e voltará a usar somente as listas escolhidas. O histórico do vínculo será preservado.`;
     q('[data-ca-yes]').onclick=()=>done(true);q('[data-ca-no]').onclick=()=>done(false);dialog.oncancel=e=>{e.preventDefault();done(false);};dialog.onclose=()=>done(false);confirmation.finish=done;
     try{dialog.showModal();q('[data-ca-no]').focus();}catch{done(false);error=messages.UI_CONFIRMATION_UNAVAILABLE;}
    });
    if(accepted&&(!current(before)||!ctx.clean||state().binding?.binding_hash!==bound.binding_hash||state().binding?.binding_version!==bound.binding_version))fail('UI_CONTEXT_CHANGED');
   }catch(e){accepted=false;error=messages[e?.code]||messages.UI_CONTEXT_CHANGED;}finally{confirmation=null;changed();}
   if(accepted)await guarded(async()=>{await client.release();inspection=null;readConfirmed=true;await onBound(ctx.campaign.id);notice='Vínculo removido. A campanha voltou a usar as listas existentes.';});
   refocus(caller);
  }
  async function validate(){if(!canValidate())return;await guarded(async()=>{
   const before=identityContext();if(regular?.capabilities().prepare)await regular.prepare(state().binding);else await client.validate();if(!current(before))fail('UI_CONTEXT_CHANGED');
   notice=regular?.snapshot().review?'Conteúdo e público conferidos. Revise a data e confirme o agendamento.':'Conteúdo e público conferidos. O envio continua indisponível.';
  });}
  async function schedule(){
   if(!canSchedule())return;
   const before=identityContext(),review=regular.snapshot().review,dialog=q('[data-ca-dialog]'),caller=element.ownerDocument.activeElement;
   if(typeof dialog?.showModal!=='function'||typeof dialog?.close!=='function'){error=messages.UI_CONFIRMATION_UNAVAILABLE;changed();return;}
   let accepted=false;error='';confirmation={};onChange();
   try{
    accepted=await new Promise(resolve=>{
     let done=false;const finish=value=>{if(done)return;done=true;dialog.oncancel=null;dialog.onclose=null;q('[data-ca-yes]').onclick=null;q('[data-ca-no]').onclick=null;try{dialog.close();}catch{dialog.removeAttribute('open');}resolve(value);};
     q('#ca-confirm-title').textContent='Confirmar agendamento';q('[data-ca-yes]').textContent='Agendar campanha';
     q('[data-ca-confirm-text]').textContent=`Agendar “${ctx.campaign.definition.name}” de ${brandName(ctx.brand)} para ${brasilia(review.send_at)}? ${review.eligible_count} pessoas estão elegíveis no público escolhido. O total pode mudar até o envio; descadastros serão respeitados.`;
     q('[data-ca-yes]').onclick=()=>finish(true);q('[data-ca-no]').onclick=()=>finish(false);dialog.oncancel=e=>{e.preventDefault();finish(false);};dialog.onclose=()=>finish(false);confirmation.finish=finish;
     try{dialog.showModal();q('[data-ca-no]').focus();}catch{finish(false);error=messages.UI_CONFIRMATION_UNAVAILABLE;}
    });
    if(accepted&&(!current(before)||!ctx.clean||regular.snapshot().review?.review_id!==review.review_id))fail('UI_CONTEXT_CHANGED');
    if(accepted&&Date.parse(review.expires_at)<=now())fail('UI_INSPECTION_EXPIRED');
   }catch(e){accepted=false;error=messages[e?.code]||messages.UI_CONTEXT_CHANGED;}finally{confirmation=null;changed();}
   if(accepted)await guarded(async()=>{await regular.schedule(review.review_id);await onBound(ctx.campaign.id);await regular.reconcile();notice='Campanha agendada com o público escolhido.';});
   refocus(caller);
  }
  async function consult(){if(!pending()||busy||confirmation||ctx?.blocked)return;await guarded(async()=>{
   if(regular?.pending()){await regular.consult();const op=regular.snapshot().operation;if(op.phase==='confirmed'){await onBound(ctx.campaign.id);await regular.reconcile();notice='Agendamento confirmado pela tentativa original.';}else notice=messages[op.receipt.body.error]||'Agendamento recusado. Confira novamente antes de uma nova tentativa.';return;}
   await client.consult();if(pending())fail('SEGMENT_BINDING_UNCONFIRMED');inspection=null;readConfirmed=true;
   if(state().binding){await onBound(ctx.campaign.id);notice='Vínculo confirmado pela tentativa original. O disparo ainda aguarda liberação.';}else notice='Tentativa conferida. Atualize os públicos antes de uma nova escolha.';
  });}
  function sync(next){
   if(destroyed)return false;
   const minimal={capabilities:{campaign_audience:next.api?.capabilities?.campaign_audience,segments:next.api?.capabilities?.segments,endpoints:{campaign_audience:next.api?.capabilities?.endpoints?.campaign_audience,segments:next.api?.capabilities?.endpoints?.segments}}};
   const target={...next,api:clone(minimal),token:key()},sameId=ctx&&ctx.brand===target.brand&&ctx.campaign?.id===target.campaign?.id;
   if(!sameId&&(busy||confirmation||pending()))return false;
   const sameAccess=sameId&&ctx.token===target.token&&Client.caps(ctx.api).endpoint===Client.caps(target.api).endpoint&&SegmentClient.caps(ctx.api).endpoint===SegmentClient.caps(target.api).endpoint;
   if(!sameAccess){
    if((busy||confirmation||pending())&&ctx){ctx={...ctx,api:target.api,token:target.token};client?.update(target.api);regular?.update(target.api);inspection=null;readConfirmed=false;error=messages.UI_CONTEXT_CHANGED;render();return false;}
    client=null;regular=null;segments=null;rows=[];catalog=null;offset=0;more=false;selected='';inspection=null;readConfirmed=false;error='';notice='';baseList=null;fatal=false;ctx=target;
    if(available(ctx)&&ctx.campaign?.id){try{client=Client.create({api:ctx.api,brand:ctx.brand,campaignId:ctx.campaign.id,key,storage,fetch:fetcher,locks,identity,id});if(Regular)regular=Regular.create({api:ctx.api,brand:ctx.brand,campaignId:ctx.campaign.id,key,storage,fetch:fetcher,locks,identity:identity||Client.fingerprint,id});segments=SegmentClient.create({api:ctx.api,brand:ctx.brand,key,storage,fetch:fetcher,locks,identity});}catch{fatal=true;error='O registro desta preparação não foi confirmado. Preserve os dados deste navegador e restaure o acesso original.';}}
   }else{
    if(ctx.campaign?.version!==target.campaign?.version||!same(ctx.api,target.api)){inspection=null;readConfirmed=false;catalog=null;regular?.invalidate();}
    if(!target.clean)regular?.invalidate();
    ctx=target;client?.update(target.api);regular?.update(target.api);segments?.update(target.api);
   }
   render();return !fatal;
  }
  function onClick(e){if(destroyed)return;const b=e.target.closest('[data-ca]');if(!b||b.disabled||!element.contains(b))return;const action=b.dataset.ca;
   if(action==='load')void load();if(action==='previous')void load(Math.max(0,offset-50));if(action==='next')void load(offset+50);if(action==='inspect')void inspect();if(action==='bind')void confirmBinding();if(action==='release')void confirmRelease();if(action==='consult')void consult();
  }
  function onSelectionChange(e){if(destroyed||!e.target.matches('[data-ca-select]')||locked())return;selected=e.target.value;inspection=null;baseList=null;error='';notice='';changed();}
  element.addEventListener('click',onClick);element.addEventListener('change',onSelectionChange);
  function destroy(){
   if(destroyed)return;
   destroyed=true;confirmation?.finish?.(false);if(reviewTimer!==null){clearTimeout(reviewTimer);reviewTimer=null;}
   element.removeEventListener('click',onClick);element.removeEventListener('change',onSelectionChange);
  }
  return {sync,validate,schedule,confirmBindingRead,contextStatus:status,destroy};
 }
 return {create};
});
