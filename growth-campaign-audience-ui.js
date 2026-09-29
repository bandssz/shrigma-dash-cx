(function(root,factory){'use strict';if(typeof module==='object'&&module.exports)module.exports=factory(require('./growth-campaign-audience-client.js'),require('./growth-segment-client.js'));else root.GCAudienceUI=factory(root.GCAC,root.GSC);})(typeof globalThis==='undefined'?this:globalThis,function(Binding,Segments){
 'use strict';
 const clone=x=>JSON.parse(JSON.stringify(x)),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const brandName=b=>b==='fish'?'Fishermans':'O Aristocrata';
 const messages={
  SEGMENT_BINDING_BASE_REQUIRED:'Selecione apenas a lista base indicada abaixo e salve a campanha antes de conferir este público.',
  SEGMENT_BINDING_VERSION_CONFLICT:'A campanha ou o público mudou. Reabra a campanha e confira novamente.',
  SEGMENT_BINDING_AUDIENCE_CHANGED:'O público mudou ou foi arquivado. Atualize a lista e confira a versão atual.',
  SEGMENT_BINDING_CHANGED:'A conferência mudou. Reabra a campanha e confira novamente.',
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
  let ctx=null,client=null,segments=null,rows=[],offset=0,more=false,selected='',inspection=null,readConfirmed=false,busy=false,confirmation=null,error='',notice='',baseList=null,fatal=false,reviewTimer=null;
  const q=s=>element.querySelector(s),pending=()=>!!client?.pending(),selectedRow=()=>rows.find(r=>r.id===selected&&!r.archived&&r.semantic_context?.current===true);
  const available=x=>!!x&&!!x.token&&['fish','aristo'].includes(x.brand)&&Client.caps(x.api).read&&Client.caps(x.api).brands.includes(x.brand)&&SegmentClient.caps(x.api).read&&SegmentClient.caps(x.api).contract_version==='crm-audience-v2'&&SegmentClient.caps(x.api).brands.includes(x.brand);
  const eligible=()=>available(ctx)&&ctx.campaign?.id&&ctx.campaign.status==='draft'&&ctx.campaign.sent===0&&ctx.campaign.started_at===null;
  const locked=()=>busy||!!confirmation||pending()||fatal||!!ctx?.blocked;
  const state=()=>client?.snapshot()||{};
  function history(){const id=ctx?.campaign?.id||ctx?.localCampaignId;if(!id||!['fish','aristo'].includes(ctx.brand))return false;try{return !!storage.getItem(Client.SLOT+ctx.brand+':'+id);}catch{return true;}}
  // A local record is not authority to resume: when access disappears, freeze
  // the context until its original authenticated client can reconcile it.
  const unresolvedHistory=()=>history()&&(!available(ctx)||!ctx?.campaign);
  const canValidate=()=>eligible()&&ctx.clean&&!locked()&&readConfirmed&&!!state().binding?.campaign_current&&state().binding?.semantic_context?.current===true&&Client.caps(ctx.api).validate===true;
  const status=()=>({canValidate:!!canValidate(),active:available(ctx),blocked:busy||!!confirmation||fatal||unresolvedHistory(),pending:pending(),bound:!!state().binding,readConfirmed,legacyBlocked:!!ctx?.campaign&&(!!state().binding||pending()||((available(ctx)||history())&&(!readConfirmed||busy||!!confirmation||fatal)))});
  function render(){
   if(reviewTimer!==null){clearTimeout(reviewTimer);reviewTimer=null;}
   element.hidden=!available(ctx)&&!history()&&!state().binding;if(element.hidden)return;
   if(!available(ctx)||unresolvedHistory()){if(!confirmation)element.innerHTML='<h4>Público salvo</h4><p role="status">A consulta deste vínculo está indisponível. O registro foi preservado; confira o vínculo com o acesso original antes de agendar.</p>';return;}
   // Keep the dialog node intact until its own lifecycle finishes.
   if(confirmation)return;
   if(!ctx.campaign){element.innerHTML='<h4>Público salvo</h4><p>Salve a campanha para escolher um público reutilizável.</p>';return;}
   const row=selectedRow(),s=state(),bound=s.binding,can=eligible()&&ctx.clean&&!locked(),inspected=!!inspection&&row?.id===inspection.intent?.audience_id&&row.version===inspection.intent?.audience_revision;
   const description=bound?`Público vinculado · versão ${bound.audience_revision}. ${bound.campaign_current===false?'A campanha mudou após o vínculo. Confira e vincule a versão atual.':'O disparo deste público ainda aguarda liberação.'}`:readConfirmed?'Esta campanha ainda usa as listas selecionadas.':'Carregue os públicos para conferir o vínculo atual desta campanha.';
   const checked=s.validation,valid=checked&&ctx.token===key()&&ctx.clean&&checked.binding.campaign_version===ctx.campaign.version&&Date.parse(checked.expires_at)>now();
   if(valid)reviewTimer=setTimeout(()=>{reviewTimer=null;changed();},Math.max(1,Date.parse(checked.expires_at)-now()+1));
   const reviewText=valid?(checked.content.ok?'Conteúdo conferido. ':'Revise o conteúdo e salve novamente. ')+(checked.audience.source_confirmed?`${checked.audience.eligible_count} pessoas elegíveis no público escolhido, com consentimento conferido neste momento.`:'A fonte deste público não está disponível; a quantidade permanece desconhecida.')+' A conferência não reserva destinatários nem libera envio.':checked?'A conferência venceu ou a campanha mudou. Confira conteúdo e público novamente.':'';
   element.innerHTML=`<h4>Público salvo</h4><p>${esc(description)}</p><p class="ce-audience-warning">A escolha pode ser preparada aqui. O envio por público salvo ainda não está disponível.</p>
    <div class="ce-actions"><button type="button" class="ce-secondary" data-ca="load" ${locked()?'disabled':''}>Carregar públicos salvos</button><button type="button" class="ce-secondary" data-ca="consult" ${!pending()||busy||!!ctx.blocked?'disabled':''} ${pending()?'':'hidden'}>Consultar tentativa</button></div>
    ${rows.length?`<label>Escolha o público de ${brandName(ctx.brand)}<select data-ca-select ${!can?'disabled':''}><option value="">Selecione um público</option>${rows.filter(r=>!r.archived).map(r=>`<option value="${esc(r.id)}" ${r.id===selected?'selected':''} ${r.semantic_context?.current!==true?'disabled':''}>${esc(r.name)} · versão ${r.version}${r.semantic_context?.current!==true?' · precisa de revisão':''}</option>`).join('')}</select></label>`:readConfirmed?'<p>Nenhum público disponível nesta página. Crie e salve um público na seção Público.</p>':''}
    ${offset||more?`<div class="ce-actions"><button type="button" class="ce-secondary" data-ca="previous" ${locked()||offset===0?'disabled':''}>Anteriores</button><button type="button" class="ce-secondary" data-ca="next" ${locked()||!more?'disabled':''}>Próximos</button></div>`:''}
    ${!ctx.clean?'<p>Salve as alterações da campanha antes de conferir ou vincular um público.</p>':''}
    ${baseList?`<p data-ca-base>Lista base necessária: <strong>${esc(baseList.name)}</strong>. Selecione somente essa lista no catálogo da campanha e salve.</p>`:''}
    ${inspection?`<p data-ca-inspection>Conferido: <strong>${esc(inspection.audience_name)}</strong>, versão ${inspection.intent.audience_revision}. Esta conferência confirma a configuração; não informa quantidade de destinatários nem libera o envio.</p>`:''}
    <div class="ce-actions"><button type="button" class="ce-secondary" data-ca="inspect" ${!can||!row||!Client.caps(ctx.api).inspect?'disabled':''}>Conferir público escolhido</button><button type="button" class="ce-primary" data-ca="bind" ${!can||!inspected||!client?.canWrite()?'disabled':''}>Usar este público</button></div>
    ${reviewText?`<p data-ca-validation role="status">${esc(reviewText)}</p>`:''}
    <p data-ca-status role="status" aria-live="polite" data-error="${!!error}">${esc(error||notice||(busy?'Conferindo…':''))}</p>
    <dialog class="ce-confirm" data-ca-dialog aria-labelledby="ca-confirm-title"><h4 id="ca-confirm-title">Confirmar público</h4><p data-ca-confirm-text></p><div class="ce-actions"><button type="button" class="ce-secondary" data-ca-no autofocus>Voltar</button><button type="button" class="ce-primary" data-ca-yes>Confirmar público</button></div></dialog>`;
  }
  function changed(){render();onChange();}
  const identityContext=()=>({brand:ctx?.brand,campaign:ctx?.campaign?.id,version:ctx?.campaign?.version,token:key(),bindingEndpoint:Client.caps(ctx?.api).endpoint,segmentsEndpoint:SegmentClient.caps(ctx?.api).endpoint,caps:JSON.stringify(ctx?.api),clean:ctx?.clean,blocked:ctx?.blocked,campaignContext:getCampaignContext()});
  function current(before){return same(before,identityContext())&&ctx?.token===key();}
  function syncedVersion(){if(state().campaign_version!==ctx.campaign.version)fail('UI_CAMPAIGN_CHANGED');}
  async function guarded(work){if(busy||confirmation)return;busy=true;error='';notice='';baseList=null;changed();try{await work();}catch(e){error=messages[e?.code]||'Não foi possível confirmar esta ação. Preserve a tentativa e confira o estado atual.';if(e?.code==='SEGMENT_BINDING_BASE_REQUIRED'&&e.baseList)baseList=clone(e.baseList);}finally{busy=false;changed();}}
  async function load(page=0){if(pending()||fatal)return;await guarded(async()=>{
   if(!eligible())fail('UI_CAMPAIGN_CHANGED');const before=identityContext();inspection=null;readConfirmed=false;
   const listed=await segments.list({offset:page,limit:50});if(!current(before))fail('UI_CONTEXT_CHANGED');
   await client.read(ctx.campaign.id);if(!current(before))fail('UI_CONTEXT_CHANGED');syncedVersion();
   rows=listed.segments;offset=page;more=rows.length===50;selected='';readConfirmed=true;
  });}
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
   (caller?.isConnected&&!caller.disabled?caller:q('[data-ca="load"]'))?.focus();
  }
  async function validate(){if(!canValidate())return;await guarded(async()=>{
   const before=identityContext();await client.validate();if(!current(before))fail('UI_CONTEXT_CHANGED');
   notice='Conteúdo e público conferidos. O envio continua indisponível.';
  });}
  async function consult(){if(!pending()||busy||confirmation||ctx?.blocked)return;await guarded(async()=>{
   await client.consult();if(pending())fail('SEGMENT_BINDING_UNCONFIRMED');inspection=null;readConfirmed=true;
   if(state().binding){await onBound(ctx.campaign.id);notice='Vínculo confirmado pela tentativa original. O disparo ainda aguarda liberação.';}else notice='Tentativa conferida. Atualize os públicos antes de uma nova escolha.';
  });}
  function sync(next){
   const minimal={capabilities:{campaign_audience:next.api?.capabilities?.campaign_audience,segments:next.api?.capabilities?.segments,endpoints:{campaign_audience:next.api?.capabilities?.endpoints?.campaign_audience,segments:next.api?.capabilities?.endpoints?.segments}}};
   const target={...next,api:clone(minimal),token:key()},sameId=ctx&&ctx.brand===target.brand&&ctx.campaign?.id===target.campaign?.id;
   if(!sameId&&(busy||confirmation||pending()))return false;
   const sameAccess=sameId&&ctx.token===target.token&&Client.caps(ctx.api).endpoint===Client.caps(target.api).endpoint&&SegmentClient.caps(ctx.api).endpoint===SegmentClient.caps(target.api).endpoint;
   if(!sameAccess){
    if((busy||confirmation||pending())&&ctx){ctx={...ctx,api:target.api,token:target.token};client?.update(target.api);inspection=null;readConfirmed=false;error=messages.UI_CONTEXT_CHANGED;render();return false;}
    client=null;segments=null;rows=[];offset=0;more=false;selected='';inspection=null;readConfirmed=false;error='';notice='';baseList=null;fatal=false;ctx=target;
    if(available(ctx)&&ctx.campaign?.id){try{client=Client.create({api:ctx.api,brand:ctx.brand,campaignId:ctx.campaign.id,key,storage,fetch:fetcher,locks,identity,id});segments=SegmentClient.create({api:ctx.api,brand:ctx.brand,key,storage,fetch:fetcher,locks,identity});}catch{fatal=true;error='O registro desta preparação não foi confirmado. Preserve os dados deste navegador e restaure o acesso original.';}}
   }else{
    if(ctx.campaign?.version!==target.campaign?.version||!same(ctx.api,target.api)){inspection=null;readConfirmed=false;}
    ctx=target;client?.update(target.api);segments?.update(target.api);
   }
   render();return !fatal;
  }
  element.addEventListener('click',e=>{const b=e.target.closest('[data-ca]');if(!b||b.disabled||!element.contains(b))return;const action=b.dataset.ca;
   if(action==='load')void load();if(action==='previous')void load(Math.max(0,offset-50));if(action==='next')void load(offset+50);if(action==='inspect')void inspect();if(action==='bind')void confirmBinding();if(action==='consult')void consult();
  });
  element.addEventListener('change',e=>{if(!e.target.matches('[data-ca-select]')||locked())return;selected=e.target.value;inspection=null;baseList=null;error='';notice='';changed();});
  return {sync,validate,contextStatus:status};
 }
 return {create};
});
