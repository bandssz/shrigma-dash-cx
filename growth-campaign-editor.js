/* Campaign editor. Server actions require explicitly announced capabilities. */
'use strict';
const GCE=(()=>{
 let contextBrand=null,contextEpoch=0,localError='',localCampaign=undefined,checkCampaign=false;
 const fields=['brand','initiative_name','initiative_key','utm_campaign','name','subject','from_email','reply_to','list_ids','template_id','send_at','tags','html','text'];
 let root=null,dirty=false,api=null,remote=null,remoteCaps=null,remoteBusy=false,remoteBrand=null,remoteCampaigns=[],hiddenCampaigns=[];
 let sessionWrite='',legacyWrite=true,accessImporting=false,accessEpoch=0,accessFileError=false,accessCaller=null;
 let confirmation=null,deferredAccess='',audienceTimer=null,remoteRead=false,dialogOpen=false;
 let confirmedCatalog=null,onCatalog=null,audienceView=null,queuedSavedAudience=null;
 const audienceState=()=>audienceView?.contextStatus()||{};
 const audienceFrozen=()=>!!(audienceState().blocked||audienceState().pending);
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const blank=brand=>({brand:['fish','aristo','olivas'].includes(brand)?brand:'fish',initiative_name:'',initiative_key:'',utm_campaign:'',name:'',subject:'',from_email:'',reply_to:'',list_ids:'',template_id:'',send_at:'',tags:'',html:'',text:''});
 const split=v=>String(v||'').split(',').map(v=>v.trim()).filter(Boolean);
 // Deslocamento real de America/Sao_Paulo para a data/hora digitada (Intl, sem
 // dependências). Hoje é -03:00; se a regra de horário de verão voltar, o fuso
 // do navegador acompanha a base de fusos em vez de um valor fixo.
 const zoneParts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
 const zoneOffset=ms=>{const p=Object.fromEntries(zoneParts.formatToParts(new Date(ms)).map(x=>[x.type,x.value]));return Math.round((Date.UTC(+p.year,p.month-1,+p.day,+p.hour%24,+p.minute,+p.second)-Math.floor(ms/1000)*1000)/60000);};
 function brasiliaOffset(local){
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(String(local));if(!m)return '-03:00';
  const wall=Date.UTC(+m[1],m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0));let off=zoneOffset(wall);const second=zoneOffset(wall-off*60000);if(second!==off)off=second;
  const a=Math.abs(off);return (off<0?'-':'+')+String(Math.floor(a/60)).padStart(2,'0')+':'+String(a%60).padStart(2,'0');
 }
 const definition=v=>CampaignContract.normalize({schema_version:CampaignContract.VERSION,brand:v.brand,channel:'email',initiative:{key:v.initiative_key,name:v.initiative_name},utm_campaign:v.utm_campaign,name:v.name,subject:v.subject,from_email:v.from_email,reply_to:v.reply_to,list_ids:split(v.list_ids).map(Number),template_id:Number(v.template_id),html:v.html,text:v.text,tags:split(v.tags),send_at:v.send_at?v.send_at+brasiliaOffset(v.send_at):null});
 const fromDefinition=input=>{const d=CampaignContract.normalize(input);return {brand:d.brand,initiative_name:d.initiative.name,initiative_key:d.initiative.key,utm_campaign:d.utm_campaign,name:d.name,subject:d.subject,from_email:d.from_email,reply_to:d.reply_to,list_ids:d.list_ids.join(', '),template_id:String(d.template_id),send_at:d.send_at?new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,hourCycle:'h23'}).format(new Date(d.send_at)).replace(' ','T').replace(',','.').replace(/\.000$/,''):'',tags:d.tags.join(', '),html:d.html,text:d.text};};
 function values(){return Object.fromEntries(fields.map(k=>[k,root.querySelector(`[name="${k}"]`).value]));}
 function message(text,error=false){const el=root.querySelector('[data-ce-status]');el.textContent=text;el.dataset.error=String(error);}
 function keep(){if(confirmation||remoteBusy||audienceFrozen())return;if(localError){message(localError,true);paintRemote();return;}dirty=true;try{saveLocal();message('Alterações guardadas neste navegador.');}catch(e){localError=e.message;message(e.message,true);}paintRemote();}
 function fill(v){for(const k of fields)root.querySelector(`[name="${k}"]`).value=typeof v[k]==='string'?v[k]:'';}
 const input=(name,label,placeholder='',extra='')=>`<label>${label}<input name="${name}" autocomplete="off" placeholder="${esc(placeholder)}" ${extra}></label>`;
 function mount({marca='fish',api:payload=null,onCatalog:catalogCallback=null}={}){
  api=payload;onCatalog=typeof catalogCallback==='function'?catalogCallback:null;
  const target=typeof document!=='undefined'?document.getElementById('campaign-composer'):null;
  if(!target)return;if(target===root){if(contextBrand!==marca)enterBrand(marca);else setupRemote();return;}confirmation?.finish(false);audienceView?.destroy();contextEpoch++;root=target;audienceView=null;queuedSavedAudience=null;
  root.innerHTML=`<details class="ce-shell"><summary><span class="ce-icon" aria-hidden="true">+</span><span class="ce-title"><strong>Preparar campanha</strong><span>Escolha o público, prepare a mensagem e revise o envio.</span></span><span class="ce-tag">Rascunho local</span></summary>
   <div class="ce-body"><ol class="crm-workflow-path" aria-label="Etapas da campanha"><li><b>1</b> Preparar conteúdo e público</li><li><b>2</b> Salvar rascunho</li><li><b>3</b> Conferir e agendar</li></ol><div class="ce-intro"><div><h3>Nova campanha de e-mail</h3><span class="ce-tag" title="A iniciativa reúne os disparos no relatório. Cada disparo mantém seu público e rastreamento próprios.">Agrupada por iniciativa</span></div><label class="ce-import">Importar JSON<input type="file" accept=".json,application/json" data-ce-import></label></div>
   <section class="ce-remote" data-ce-remote hidden aria-label="Campanhas salvas"><div class="ce-remote-access"><button type="button" class="ce-secondary" data-ce-access-open>Acesso de escrita de campanhas</button><span data-ce-key-state role="status"></span></div>
   <form data-ce-access-form hidden novalidate aria-labelledby="ce-access-title"><h4 id="ce-access-title">Acesso de escrita de campanhas</h4><p id="ce-access-help">A nova chave fica somente nesta página aberta. Preparar o acesso não salva, valida, agenda ou cancela; depois, escolha a ação desejada.</p><fieldset data-ce-access-fields><div class="ce-grid"><label for="ce-access-key">Chave de escrita de campanhas<input id="ce-access-key" type="password" data-ce-key autocomplete="off" spellcheck="false" maxlength="256" aria-describedby="ce-access-help ce-access-message"></label><label for="ce-access-file">Importar arquivo de acesso de campanhas<input id="ce-access-file" type="file" data-ce-access-file accept="application/json,.json" aria-describedby="ce-access-help ce-access-message"></label></div><button type="submit" class="ce-secondary" data-ce-key-save>Usar nesta página</button></fieldset><button type="button" class="ce-secondary" data-ce-access-cancel>Cancelar</button><p id="ce-access-message" data-ce-access-message role="status" aria-live="polite"></p></form><div class="ce-actions"><button type="button" class="ce-secondary" data-ce-refresh>Carregar catálogo e campanhas</button><button type="button" class="ce-secondary" data-ce-new>Preparar novo rascunho</button><button type="button" class="ce-secondary" data-ce-consult>Consultar tentativa</button><button type="button" class="ce-secondary" data-ce-release hidden>Liberar tentativa sem efeito</button><button type="button" class="ce-secondary" data-ce-recover hidden>Recuperar rascunho existente</button></div><p data-ce-server-state role="status" aria-live="polite"></p><div data-ce-campaigns></div><div data-ce-catalog></div><div class="ce-tracking" data-ce-audience role="status" aria-live="polite"></div><div class="ce-action-stages"><div class="ce-actions"><span>1 · Rascunho</span><button type="button" class="ce-primary" data-ce-save>Salvar campanha</button></div><div class="ce-actions"><span>2 · Conferência</span><button type="button" class="ce-secondary" data-ce-validate>Conferir conteúdo e público</button></div><div class="ce-actions"><span>3 · Agendamento</span><button type="button" class="ce-primary" data-ce-schedule>Agendar campanha</button><button type="button" class="ce-secondary" data-ce-cancel>Cancelar agendamento</button></div></div><span class="ce-tag" title="Salvar mantém o rascunho sem envio. Confira o público antes de agendar. Se o resultado ficar incerto, consulte a mesma tentativa antes de continuar.">Envio exige confirmação</span></section><section class="ce-saved-audience" data-ce-saved-audience hidden></section><form data-ce-definition novalidate><fieldset><legend><span>01</span> Campanha e iniciativa</legend><div class="ce-grid"><label>Marca<input name="brand" type="hidden"><strong data-ce-brand></strong></label>${input('initiative_name','Iniciativa comercial','Ex.: Semana do Cliente')}${input('initiative_key','Identificador da iniciativa','Ex.: semana-do-cliente-2026')}${input('utm_campaign','UTM da campanha','Use o identificador já adotado na iniciativa')}${input('name','Nome deste disparo','Ex.: Abertura · clientes recorrentes')}${input('subject','Assunto do e-mail','O assunto que aparece na caixa de entrada','maxlength="250"')}</div></fieldset>
   <fieldset><legend><span>02</span> Público e remetente</legend><div class="ce-grid">${input('list_ids','IDs das listas','Ex.: 123, 124')}${input('template_id','ID do template de campanha','Consulte o catálogo de templates','inputmode="numeric"')}${input('from_email','Remetente','Marca <email@dominio-da-marca>')}${input('reply_to','Endereço para respostas','email@dominio-da-marca')}${input('send_at','Data desejada · Brasília, UTC−3 (opcional)','','type="datetime-local" step="60"')}${input('tags','Tags (opcional)','abertura, clientes-recorrentes')}</div><span class="ce-tag" title="A data só é aplicada após conferir o público e confirmar Agendar campanha.">Data ainda não agendada</span></fieldset>
   <fieldset><legend><span>03</span> Conteúdo</legend><div class="ce-grid ce-content"><label>HTML do e-mail<textarea name="html" spellcheck="false" placeholder="Cole o HTML com os links da loja e {{ UnsubscribeURL }}"></textarea></label><label>Versão em texto<textarea name="text" placeholder="Cole a versão em texto, incluindo os links e {{ UnsubscribeURL }}"></textarea></label></div></fieldset>
   <div data-ce-utms></div><div class="ce-tracking"><span class="ce-tag" data-ce-tracking-note title="O arquivo exportado prepara a campanha; não confirma envio ou agendamento.">Rastreamento conferido ao salvar</span></div>
   <div class="ce-actions"><button type="button" class="ce-secondary" data-ce-preview>Abrir prévia do HTML</button><button type="button" class="ce-primary" data-ce-export>Verificar e exportar JSON</button><button type="button" class="ce-secondary" data-ce-reset>Limpar rascunho</button><span data-ce-status role="status" aria-live="polite">Rascunho local. Ainda não cadastrado para envio.</span></div>
   </form></div></details><dialog class="ce-confirm" data-ce-confirm aria-labelledby="ce-confirm-title" aria-describedby="ce-confirm-text"><h3 id="ce-confirm-title">Confirmar ação</h3><p id="ce-confirm-text" data-ce-confirm-text></p><div class="ce-confirm-actions"><button type="button" class="ce-secondary" data-ce-confirm-no autofocus>Voltar sem alterar</button><button type="button" class="ce-primary" data-ce-confirm-yes>Confirmar</button></div></dialog>`;
  enterBrand(marca);
  root.querySelector('[data-ce-definition]').addEventListener('submit',e=>e.preventDefault());
  root.querySelector('[data-ce-definition]').addEventListener('input',keep);
  root.querySelector('[data-ce-import]').addEventListener('change',async e=>{
   const field=e.target,f=field.files?.[0];if(!f||confirmation||remoteBusy||audienceFrozen()||localError)return;
   try{if(remote?.locked())throw Error('Consulte a tentativa pendente antes de importar outro conteúdo.');if(f.size>800000)throw Error('Use um arquivo JSON de até 800 KB.');const before=confirmationContext(),v=fromDefinition(JSON.parse(await f.text()));if(v.brand!==contextBrand)throw Error('Este arquivo é de outra marca. Abra a marca do arquivo no cabeçalho antes de importar.');if(audienceFrozen()||!sameContext(before))throw Error('O rascunho mudou durante a leitura. Confira o conteúdo e importe novamente.');
    const apply=()=>{if(audienceFrozen())throw Error('Conclua a tentativa de público antes de importar.');fill(v);setupRemote();saveLocal();message('JSON importado e campos conferidos. Catálogo e UTMs finais serão validados na integração de envio.');};
    if(dirty)await confirmAction('Substituir o rascunho local pelo conteúdo deste arquivo?','Substituir rascunho',apply);else apply();
   }catch(err){message(err instanceof SyntaxError?'O arquivo não contém um JSON válido.':err.message,true);}finally{field.value='';}
  });
  root.querySelector('[data-ce-export]').addEventListener('click',()=>{
   if(confirmation||remoteBusy)return;
   try{const d=definition(values()),blob=new Blob([JSON.stringify(d,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`campanha-${d.brand}-${d.utm_campaign}.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);keep();message('JSON exportado. Estrutura conferida; envio e rastreamento final ainda dependem da integração.');}
   catch(err){message(err.message,true);const mapped={'initiative.key':'initiative_key','initiative.name':'initiative_name'};root.querySelector(`[name="${mapped[err.field]||err.field}"]`)?.focus();}
  });
  root.querySelector('[data-ce-preview]').addEventListener('click',()=>{if(confirmation||remoteBusy)return;const v=values();GMP.openEmail({source:v.html||'<p>Escreva o HTML para visualizar o e-mail.</p>',subject:v.subject,label:'Prévia do conteúdo da campanha'});});
  root.querySelector('[data-ce-reset]').addEventListener('click',()=>{if(localError){message(localError,true);return;}if(remote?.locked()){message('Consulte a tentativa pendente antes de limpar o conteúdo.',true);return;}confirmAction('Limpar o rascunho salvo neste navegador?','Limpar rascunho',()=>{fill(blank(values().brand));saveLocal();dirty=false;message('Rascunho limpo. Nenhuma campanha de envio foi alterada.');});});
  bindRemote();setupRemote();
 }
 const q=selector=>root.querySelector(selector);
 function saveLocal({recover=false}={}){if(localError&&!recover)throw Error(localError);if(!GBS.validBrand(contextBrand))return;dirty=true;const c=remote?.snapshot()?.campaign,anchor=remote?(c?{id:c.id,version:c.version}:null):(localCampaign??null);GBS.save('campaign',contextBrand,{...values(),_campaign:anchor},{...Object.fromEntries(fields.map(k=>[k,k==='brand'?contextBrand:''])),_campaign:null});localCampaign=anchor;checkCampaign=!remote;localError='';}
 // reading: a navegação só está presa por leituras (catálogo, campanhas, públicos salvos); confirming: diálogo aberto.
 function contextStatus(){const a=audienceState(),confirming=dialogOpen||!!a.confirming,reading=!confirming&&!accessImporting&&(remoteBusy?remoteRead:!confirmation)&&(!a.activeOperation||!!a.reading)&&!!(remoteBusy||a.activeOperation);return {blocked:!!(remoteBusy||confirmation||accessImporting||a.blocked||a.pending),navigationBlocked:!!(remoteBusy||confirmation||accessImporting||a.activeOperation),dirty:!!localError,pending:!!(remote?.locked()||a.pending),brand:contextBrand,reading,confirming};}
 function preserve(){if(localError)throw Error(localError);if(root&&GBS.validBrand(contextBrand))saveLocal();}
 function enterBrand(brand){
  if(contextStatus().navigationBlocked)return false;
  if(brand!==contextBrand){audienceView?.destroy();audienceView=null;queuedSavedAudience=null;} // Per-brand journals remain in storage for consultation on return.
  contextBrand=brand;contextEpoch++;remote=null;remoteBrand=null;remoteCampaigns=[];hiddenCampaigns=[];localError='';clearCatalog();
  let initial=blank(brand);try{initial={...initial,...(GBS.campaign(brand)||{})};}catch(e){localError=e.message;}
  checkCampaign=Object.hasOwn(initial,'_campaign');localCampaign=checkCampaign?initial._campaign:undefined;
  initial.brand=GBS.validBrand(brand)?brand:'';fill(initial);dirty=fields.some(k=>k!=='brand'&&initial[k]);
  q('[data-ce-brand]').textContent=({fish:'Fishermans',aristo:'O Aristocrata',olivas:'Olivas do Campo'})[brand]||'Escolha uma marca no cabeçalho';
  q('[data-ce-definition]').hidden=!GBS.validBrand(brand);setupRemote();
  if(localError)message(localError,true);else message(GBS.validBrand(brand)?'Preparação desta marca. Salvar localmente não envia a campanha.':'Escolha uma marca no cabeçalho para preparar uma campanha.');
 return true;
 }
 function checkLocalCampaign(){
  // Missing capabilities are not evidence of a missing campaign. Keep the saved
  // anchor until a client has loaded and validated the actual persisted journal.
  if(localError||!checkCampaign||!remote)return;
  const c=remote.snapshot().campaign,anchor=c?{id:c.id,version:c.version}:null;
  if(JSON.stringify(localCampaign)!==JSON.stringify(anchor)){localError='A campanha ou revisão desta marca mudou em outra aba. Exporte a preparação local e reabra a campanha antes de editar.';message(localError,true);}
  checkCampaign=false;
 }

 function confirmationContext(){
  return {root,client:remote,epoch:contextEpoch,brand:values().brand,draft:JSON.stringify(values()),dirty,server:JSON.stringify(remote?.snapshot()||null),caps:JSON.stringify(remoteCaps),writer:currentWriteKey(),journal:remote?localStorage.getItem(GCA.JOURNAL+remoteBrand):null};
 }
 function sameContext(before,{allowRecovery=false,allowRelease=false}={}){
  const after=confirmationContext();return before.root===after.root&&before.client===after.client&&['epoch','brand','draft','dirty','server','caps','writer','journal'].every(k=>before[k]===after[k])&&(!remote?.locked()||(allowRecovery&&remote?.canRecover())||(allowRelease&&remote?.canReleaseUnapplied?.()));
 }
 async function confirmAction(text,label,work,{allowRecovery=false,allowRelease=false}={}){
  if(confirmation||remoteBusy||audienceFrozen()||(remote?.locked()&&!(allowRecovery&&remote.canRecover())&&!(allowRelease&&remote.canReleaseUnapplied?.()))||accessImporting)return;
  const dialog=q('[data-ce-confirm]'),caller=document.activeElement;
  if(typeof dialog?.showModal!=='function'||typeof dialog?.close!=='function'){message('Este navegador não conseguiu abrir a confirmação. Nenhuma ação foi executada.',true);return;}
  let token;
  try{
   const before=confirmationContext();token={finish:()=>{}};confirmation=token;paintRemote();
   const accepted=await new Promise(resolve=>{
    let settled=false;
    const finish=yes=>{if(settled)return;settled=true;dialogOpen=false;dialog.oncancel=null;dialog.onclose=null;q('[data-ce-confirm-yes]').onclick=null;q('[data-ce-confirm-no]').onclick=null;try{dialog.close();}catch{dialog.removeAttribute('open');}resolve(yes);};
    token.finish=finish;q('[data-ce-confirm-text]').textContent=text;q('[data-ce-confirm-yes]').textContent=label;
    q('[data-ce-confirm-yes]').onclick=()=>finish(true);q('[data-ce-confirm-no]').onclick=()=>finish(false);
    dialog.oncancel=e=>{e.preventDefault();finish(false);};dialog.onclose=()=>finish(false);
    try{dialog.showModal();dialogOpen=!settled;q('[data-ce-confirm-no]').focus();}catch{message('Não foi possível abrir a confirmação. Nenhuma ação foi executada.',true);finish(false);}
   });
   if(!accepted)return;
   if(confirmation!==token||!sameContext(before,{allowRecovery,allowRelease})){message('A campanha, o acesso ou o rascunho mudou durante a confirmação. Confira o estado atual antes de continuar.',true);return;}
   await work(token,before.client);
  }catch{message('Não foi possível confirmar o estado desta ação. Nenhuma nova tentativa será iniciada; confira o registro existente.',true);}
  finally{if(confirmation===token)confirmation=null;paintRemote();finishSavedAudienceRead();if(deferredAccess){const text=deferredAccess;deferredAccess='';showAccess(text);}else if(root?.isConnected){const target=caller?.isConnected&&!caller.disabled?caller:q('.ce-shell > summary');target?.focus();}}
 }
 const keyValue=slot=>{try{return localStorage.getItem(slot)||'';}catch{return '';}};
 const validWriteKey=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(v.trim());
 const operatorWriteKey=()=>legacyWrite&&typeof shrigmaChaveOperador==='function'?shrigmaChaveOperador('growth','draft'):'';
 const currentWriteKey=()=>{const k=sessionWrite||(legacyWrite?((typeof shrigmaChaveOperador==='function'?shrigmaChaveOperador('growth','draft'):'')||(typeof GTA!=='undefined'?keyValue(GTA.CHAVE_ESCRITA):'')):'');return validWriteKey(k)?k.trim():'';};
 const currentReadKey=()=>typeof GTA!=='undefined'&&typeof GTA.chaveLeitura==='function'?GTA.chaveLeitura():typeof shrigmaChave==='function'?shrigmaChave('growth'):typeof GTA!=='undefined'?keyValue(GTA.CHAVE_LEITURA):'';
 function catalogContext(){return {client:remote,brand:contextBrand,epoch:contextEpoch,endpoint:remoteCaps?.endpoint,reader:currentReadKey(),writer:currentWriteKey()};}
 function catalogCurrent(before){const now=catalogContext();return !!before&&!!now.client&&!!now.reader&&remoteCaps?.read===true&&remoteCaps.brands.includes(now.brand)&&Object.keys(now).every(k=>now[k]===before[k]);}
 function notifyCatalog(){try{onCatalog?.();}catch{/* A read-only consumer must not interrupt campaign operations. */}}
 function clearCatalog(){if(!confirmedCatalog)return;confirmedCatalog=null;notifyCatalog();}
 function catalogs(){return confirmedCatalog&&catalogCurrent(confirmedCatalog.context)?JSON.parse(JSON.stringify([confirmedCatalog.value])):[];}
 async function readCatalog(client){
  const context=catalogContext();clearCatalog();
  const catalog=await client.catalog();if(!catalogCurrent(context)||client!==context.client)return null;
  confirmedCatalog={context,value:{brand:catalog.brand,current:true,lists:catalog.lists.filter(l=>l?.brand===context.brand&&Number.isSafeInteger(l.id)&&l.id>0&&typeof l.available==='boolean').map(l=>({id:l.id,brand:l.brand,name:typeof l.name==='string'?l.name:typeof l.label==='string'?l.label:'Lista '+l.id,available:l.available}))}};
  notifyCatalog();return catalog;
 }
 function parseAccessFile(text){
  if(typeof text!=='string'||text.length>8192)throw Error('invalid_access_file');
  let p;try{p=JSON.parse(text);}catch(_){throw Error('invalid_access_file');}
  const fields=['schema','panel','role','key'];
  if(!p||Array.isArray(p)||typeof p!=='object'||p.schema!=='shrigma_panel_access_v1'||p.panel!=='campaign'||p.role!=='write'||!validWriteKey(p.key)||fields.some(k=>!Object.hasOwn(p,k))||Object.keys(p).some(k=>!fields.includes(k)))throw Error('invalid_access_file');
  return {key:p.key.trim()};
 }
 function showAccess(text=''){
  if(remoteBusy||confirmation||audienceFrozen())return;
  const form=q('[data-ce-access-form]');if(!form.hidden){if(text)q('[data-ce-access-message]').textContent=text;return;}
  accessCaller=document.activeElement;accessEpoch++;accessImporting=false;accessFileError=false;
  q('[data-ce-key]').value='';q('[data-ce-key]').removeAttribute('aria-invalid');q('[data-ce-access-file]').value='';
  q('[data-ce-access-message]').textContent=text||'Informe o acesso. Depois, clique novamente na ação desejada.';
  form.hidden=false;q('[data-ce-access-fields]').disabled=false;q('[data-ce-key]').focus();
 }
 function closeAccess(){
  if(confirmation||audienceFrozen())return;
  accessEpoch++;accessImporting=false;accessFileError=false;q('[data-ce-key]').value='';q('[data-ce-access-file]').value='';q('[data-ce-access-form]').hidden=true;q('[data-ce-access-fields]').disabled=remoteBusy;
  const target=accessCaller?.isConnected&&!accessCaller.disabled?accessCaller:q('[data-ce-access-open]');
  (target.disabled?q('.ce-shell > summary'):target).focus();
 }
 function requireWriteAccess(){if(!currentWriteKey()||!q('[data-ce-access-form]').hidden){showAccess();return false;}return true;}
 function bindAccess(){
  const form=q('[data-ce-access-form]'),field=q('[data-ce-key]'),file=q('[data-ce-access-file]'),notice=q('[data-ce-access-message]');
  q('[data-ce-access-open]').onclick=()=>showAccess();q('[data-ce-access-cancel]').onclick=closeAccess;
  form.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeAccess();}};
  field.oninput=()=>{accessFileError=false;field.removeAttribute('aria-invalid');};
  form.onsubmit=e=>{
   e.preventDefault();if(form.hidden||remoteBusy||confirmation||audienceFrozen()||accessImporting)return;
   const k=field.value.trim();if(accessFileError||!validWriteKey(k)){notice.textContent='Informe uma chave válida de escrita de campanhas.';field.setAttribute('aria-invalid','true');field.focus();return;}
   sessionWrite=k;legacyWrite=false;clearCatalog();closeAccess();paintRemote();message('Acesso preparado somente nesta página. Nenhuma operação foi enviada; confira e clique na ação desejada.');
  };
  file.onchange=async()=>{
   if(form.hidden||remoteBusy||confirmation||audienceFrozen())return;
   const f=file.files?.[0],ticket=++accessEpoch;if(!f)return;let focusWhenReady=false;
   accessImporting=true;accessFileError=false;field.value='';q('[data-ce-access-fields]').disabled=true;notice.textContent='Lendo arquivo de acesso…';
   try{if(f.size>8192)throw Error('invalid_access_file');const parsed=parseAccessFile(await f.text());if(ticket!==accessEpoch)return;field.value=parsed.key;notice.textContent='Arquivo conferido. Clique em Usar nesta página; nenhuma operação será enviada.';focusWhenReady=true;}
   catch(_){if(ticket===accessEpoch){field.value='';accessFileError=true;notice.textContent='Arquivo inválido ou de outro painel/papel. Use o acesso de escrita de campanhas.';}}
   finally{if(ticket===accessEpoch){accessImporting=false;q('[data-ce-access-fields]').disabled=remoteBusy;file.value='';if(focusWhenReady&&!remoteBusy)field.focus();}}
  };
 }
 const stamp=v=>v?new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}).format(new Date(v))+' · Brasília':'Sem data';
 const statusName=s=>({draft:'Rascunho',scheduled:'Agendada',running:'Em envio',paused:'Pausada',finished:'Concluída',cancelled:'Cancelada'}[s]||s||'Não confirmado');
 function setupRemote(){
  if(typeof GCA==='undefined'){clearCatalog();return;}
  const next=GCA.caps(api),brand=contextBrand;
  if(confirmedCatalog&&(!catalogCurrent(confirmedCatalog.context)||next.endpoint!==remoteCaps?.endpoint||!next.read||!next.brands.includes(brand)))clearCatalog();
  if(remote&&remoteBrand===brand&&remoteCaps?.endpoint===next.endpoint){remoteCaps=next;remote.updateCapabilities(next);checkLocalCampaign();paintRemote();return;}
  remote=null;remoteCaps=next;remoteBrand=brand;remoteCampaigns=[];hiddenCampaigns=[];
  q('[data-ce-catalog]').innerHTML='';q('[data-ce-campaigns]').innerHTML='';
  for(const n of ['list_ids','template_id'])q(`[name=${n}]`).closest('label').hidden=false;
  if(next.endpoint&&next.brands.includes(brand)){
   try{remote=GCA.createClient({capabilities:next,brand,readKey:currentReadKey,writeKey:currentWriteKey});}
   catch(err){message(err.message,true);}
  }
  checkLocalCampaign();paintRemote();
 }
 const audienceNumber=n=>new Intl.NumberFormat('pt-BR').format(n);
 // Sem data salva, o contrato recusa como "15 minutos"; o que falta é preencher a data.
 const scheduleReason=(e,c)=>e?.code==='SCHEDULE_TOO_SOON'&&!c?.send_at?'Preencha a data e a hora de envio (horário de Brasília), salve a campanha e confira de novo antes de agendar.':e?.message;
 // Nomes das listas conferidas: catálogo confirmado desta marca quando houver; senão, o ID.
 const audienceLists=ids=>{const known=confirmedCatalog&&catalogCurrent(confirmedCatalog.context)?confirmedCatalog.value.lists:[];return (Array.isArray(ids)?ids:[]).map(id=>known.find(l=>l.id===id&&l.brand===contextBrand)?.name||'lista '+id).join(', ');};
 function paintAudience(s,c,clean){
  if(audienceTimer!==null){clearTimeout(audienceTimer);audienceTimer=null;}
  const el=q('[data-ce-audience]');el.hidden=false;
  if(!c||c.status!=='draft'||!clean){el.hidden=!!c&&c.status!=='draft';el.textContent=c&&c.status!=='draft'?'':!clean&&c?'Salve as alterações e confira o público antes de agendar.':'Salve a campanha para conferir quantas pessoas podem receber.';return null;}
  if(remoteCaps.audience_review!==CampaignContract.AUDIENCE_POLICY){el.textContent='A conferência do público ainda não está disponível. O agendamento aguarda essa atualização.';return null;}
  const a=s.validation?.audience;
  try{CampaignContract.audienceReview(a,c,{now:Date.parse(a?.checked_at),allowBlocked:true});}catch{el.textContent='Confira o conteúdo e o público antes de agendar.';return null;}
  let ready=true,reason='';
  try{CampaignContract.schedule({confirm:'agendar',expected_version:c.version,audience_review_id:a.review_id},{...c,validation:s.validation},{canPublish:remoteCaps.schedule===true});}catch(e){ready=false;reason=e.code==='AUDIENCE_DISABLED'?'Há contatos desativados. Revise o público antes de agendar.':scheduleReason(e,c);}
  const count=audienceNumber(a.eligible_count),label=a.eligible_count===1?'pessoa pode receber agora':'pessoas podem receber agora';
  el.innerHTML=`<strong>${count} ${label}</strong><p data-ce-audience-lists>Listas conferidas: ${esc(audienceLists(a.list_ids))}</p><div class="ce-audience-tags"><span class="ce-tag">Descadastros e bloqueios conferidos</span><span class="ce-tag" title="Contatos repetidos entre as listas selecionadas são contados uma vez.">Sem duplicatas</span></div><div class="ce-audience-validity"><span>Conferido em ${esc(stamp(a.checked_at))}</span><span>Válido até ${esc(stamp(a.expires_at))}</span></div><p>O total pode mudar até o envio; novos descadastros serão respeitados.</p>${reason?`<p class="ce-audience-warning"><strong>${esc(reason)}</strong></p>`:''}<details class="ce-audience-details"><summary>Inscrições e exclusões</summary><p>${audienceNumber(a.excluded_blocklisted_count)} bloqueados · ${audienceNumber(a.excluded_subscription_count)} sem inscrição válida · ${audienceNumber(a.native_disabled_count)} desativados.</p><p>Contatos repetidos entre listas são contados uma vez. Quem saiu de uma lista não entra por ela; a pessoa ainda pode estar inscrita em outra lista selecionada.</p></details>`;
  const remaining=Date.parse(a.expires_at)-Date.now();
  if(remaining>0){audienceTimer=setTimeout(()=>{audienceTimer=null;if(root?.isConnected)paintRemote();},Math.min(remaining+1,2147483647));audienceTimer?.unref?.();}
  return ready?a:null;
 }
 function paintUTMs(campaign){
  const el=q('[data-ce-utms]'),v=values(),open=el.dataset.brand===v.brand&&el.querySelector('details')?.open;
  el.hidden=!['fish','aristo'].includes(v.brand);if(el.hidden){el.innerHTML='';return;}
  const saved=campaign?.definition&&v.html===campaign.definition.html&&v.text===campaign.definition.text,content=v.html+'\n'+v.text;
  el.innerHTML=typeof GUT==='undefined'?'<span class="mini">UTMs do conteúdo indisponíveis.</span>':GUT.render({rows:GUT.fromContent(content),dynamic:GUT.dynamicFields(content),label:'UTMs do conteúdo',mode:'content',evidence:saved?'Conteúdo salvo desta campanha':'Rascunho em edição · ainda não salvo',empty:'Nenhuma UTM literal encontrada nos links deste conteúdo.'});
  el.dataset.brand=v.brand;if(open&&el.querySelector('details'))el.querySelector('details').open=true;
 }
 function paintSavedAudience(c,clean){
  if(typeof GCAudienceUI==='undefined')return;
  if(!audienceView)audienceView=GCAudienceUI.create({element:q('[data-ce-saved-audience]'),key:()=>typeof shrigmaChaveOperador==='function'?shrigmaChaveOperador('growth','draft'):'',onChange:()=>paintRemote(),getCampaignContext:()=>JSON.stringify({brand:contextBrand,values:values(),writer:currentWriteKey(),journal:remote?localStorage.getItem(GCA.JOURNAL+remoteBrand):null}),onBound:async id=>{
   const client=remote,epoch=contextEpoch;
   if(!client||client.locked()||client.snapshot().campaign?.id!==id||!client.clean(definition(values())))throw Error('CAMPAIGN_AUDIENCE_REOPEN_REQUIRED');
   remoteBusy=true;paintRemote();
   try{const latest=await client.reopen(id);if(epoch!==contextEpoch||client!==remote)throw Error('CAMPAIGN_AUDIENCE_REOPEN_REQUIRED');fill(fromDefinition(latest.campaign.definition));saveLocal();dirty=false;renderCampaigns([...remoteCampaigns.filter(x=>x.id!==id),latest.campaign]);}
   finally{remoteBusy=false;paintRemote();}
  }});
  audienceView.sync({api,brand:contextBrand,campaign:c||null,localCampaignId:!remote?localCampaign?.id:null,clean:!!clean,blocked:!!(remoteBusy||confirmation||accessImporting||remote?.locked()||localError)});
 }
 function paintRemote(){
  if(!root)return;
  if(confirmedCatalog&&!catalogCurrent(confirmedCatalog.context))clearCatalog();
  if(!confirmedCatalog)q('[data-ce-catalog]').innerHTML='';
  const exists=!!remote,section=q('[data-ce-remote]');section.hidden=!exists;
  for(const name of ['list_ids','template_id'])q(`[name=${name}]`).closest('label').hidden=exists;
  q('[data-ce-tracking-note]').title=exists?'Ao salvar, as UTMs são aplicadas aos links desta campanha. Confira a versão salva antes de agendar.':'O arquivo exportado prepara a campanha; não confirma envio ou agendamento.';
  const s=remote?.snapshot();let d=null;try{d=definition(values());}catch{}
  const c=s?.campaign,clean=d&&remote?.clean(d);paintSavedAudience(c,clean);
  const locked=!!remote?.locked(),frozen=locked||remoteBusy||!!confirmation||audienceFrozen();
  paintUTMs(s?.campaign);
  for(const name of fields)q(`[name="${name}"]`).disabled=frozen||name==='brand'||!GBS.validBrand(contextBrand)||!!localError;
  q('[data-ce-import]').disabled=frozen||!!localError;q('[data-ce-reset]').disabled=frozen||!!localError;
  q('[data-ce-export]').disabled=remoteBusy||!!confirmation;q('[data-ce-preview]').disabled=remoteBusy||!!confirmation;
  for(const el of q('[data-ce-catalog]').querySelectorAll('input,select'))el.disabled=frozen||!!localError;
  const selected=new Set(split(values().list_ids));for(const el of q('[data-ce-catalog]').querySelectorAll('[data-ce-list]'))el.checked=selected.has(el.value);
  if(q('[data-ce-template]'))q('[data-ce-template]').value=values().template_id;
  // Anúncio somente de leitura: não pedir chave para ações que este acesso não oferece.
  const readOnly=exists&&!remote.locked()&&!['save','validate','schedule','cancel','recover'].some(k=>remoteCaps[k]);
  q('[data-ce-key-state]').textContent=readOnly?'Seu acesso a campanhas é de leitura: consultar o catálogo e as campanhas está disponível; salvar, conferir, agendar e cancelar não estão liberados.':sessionWrite?'Acesso de edição disponível nesta página.':currentWriteKey()?(operatorWriteKey()?'Acesso de edição do CRM disponível.':'Acesso legado disponível neste navegador.'):'Informe a chave para salvar, validar, agendar ou cancelar.';
  q('[data-ce-access-open]').disabled=remoteBusy||!!confirmation||audienceFrozen();q('[data-ce-access-fields]').disabled=remoteBusy||accessImporting||!!confirmation||audienceFrozen();q('[data-ce-access-cancel]').disabled=!!confirmation||audienceFrozen();
  if(!exists){if(audienceTimer!==null){clearTimeout(audienceTimer);audienceTimer=null;}q('[data-ce-audience]').textContent='';return;}
  const writes=remote.canWrite()&&!localError,draft=c?.status==='draft'&&c.sent===0&&!c.started_at;
  const set=(name,shown,disabled)=>{const b=q(`[data-ce-${name}]`);b.hidden=!shown;b.disabled=disabled;};
  set('refresh',remoteCaps.read,remoteBusy||!!confirmation||audienceFrozen());set('new',remoteCaps.save,frozen||!writes);set('consult',remoteCaps.operation,remoteBusy||!!confirmation||audienceState().activeOperation||!s.operation);
  set('recover',remoteCaps.recover&&remote.canRecover(),remoteBusy||!!confirmation||!writes);
  set('release',remoteCaps.operation&&!!remote.canReleaseUnapplied?.(),remoteBusy||!!confirmation||!writes);
  set('save',remoteCaps.save,frozen||!writes||!!c&&!draft);set('validate',remoteCaps.validate,frozen||!writes||!draft||!clean||(audienceState().legacyBlocked&&!audienceState().canValidate));
  const audienceStatus=audienceState();
  const audienceMessage=audienceStatus.pending?'Há uma tentativa de público sem confirmação. Use Consultar tentativa antes de agendar.':remote?.locked()?'Há uma tentativa de campanha sem confirmação. Use Consultar tentativa antes de agendar.':audienceStatus.activeOperation?'Conferindo se esta campanha usa um público salvo…':audienceStatus.recoveryRequired?'O registro do público não foi confirmado. Preserve este navegador e restaure o acesso original.':audienceStatus.readError?'Não foi possível confirmar o vínculo do público. Tente Carregar públicos salvos novamente.':audienceStatus.bound?'Esta campanha usa um público salvo. Confira o vínculo e a liberação do agendamento.':'Confirme se há um público salvo vinculado antes de agendar.';
  const audience=audienceStatus.legacyBlocked?(q('[data-ce-audience]').textContent=audienceStatus.canSchedule?'Confira os dados do público salvo e confirme o agendamento.':audienceMessage,null):paintAudience(s,c,clean);
  set('schedule',remoteCaps.schedule,frozen||!writes||!draft||!clean||!(audienceState().legacyBlocked?audienceState().canSchedule:audience));
  set('cancel',remoteCaps.cancel,frozen||!writes||c?.status!=='scheduled'||c?.sent!==0||c?.started_at!==null||!c?.send_at||Date.parse(c.send_at)<=Date.now());
  const op=s.operation;
  const parts=[c?`${statusName(c.status)} · ${c.sent} enviados · ${stamp(c.send_at)}`:'Ainda sem campanha cadastrada neste editor.'];
  if(localError)parts.push(localError);else if(!writes)parts.push('Consulta disponível. Este navegador não oferece a proteção entre abas necessária para salvar, validar, agendar ou cancelar.');
  if(c)parts.push(clean?'Conteúdo corresponde à versão salva.':'Há alterações locais; salve antes de validar.');
  if(c&&s.validation?.ok===true&&s.validation.version===c.version)parts.push('Versão salva validada.');
  if(remote.canRecover())parts.push('Rascunho existente conferido. Recupere-o para corrigir o conteúdo sem criar outra campanha.');
  if(locked)parts.push('Resultado pendente ou incerto. Edição e novas tentativas bloqueadas; consulte a mesma operação.');
  // Saída do registro travado: o que fazer e a quem pedir, sem destravar o que não foi provado.
  if(locked&&!remote.canRecover()){const help=`peça ao responsável técnico do CRM a conciliação da operação ${op?.key||''}. Não repita a ação nem use outra chave.`;
   if(remote.canReleaseUnapplied?.())parts.push('O servidor registrou resultado incerto. Use Liberar tentativa sem efeito: o painel confere se a campanha continua na mesma versão e só então libera.');
   else if(op?.remote_state==='outcome_unknown')parts.push('O servidor registrou resultado incerto e o painel não consegue provar que nada mudou. Para continuar, '+help);
   else if(op?.remote_state==='pending')parts.push('O servidor ainda mostra esta tentativa em processamento. Consulte de novo em alguns minutos; se não mudar, '+help);
   else if(op?.remote_state==='missing')parts.push('O servidor ainda não tem registro desta tentativa; ela pode chegar atrasada. Consulte de novo mais tarde; se continuar sem registro, '+help);}
  else if(op?.phase==='rejected'&&op.absence)parts.push('Tentativa liberada: o servidor confirmou que ela não alterou a campanha. A versão atual foi relida; confira antes de repetir a ação.');
  else if(op?.phase==='rejected')parts.push('Tentativa recusada com estado confirmado. Confira o conteúdo antes de nova ação.');
  else if(op?.phase==='succeeded')parts.push('Última operação confirmada.');
  q('[data-ce-server-state]').textContent=parts.join(' ');
  q('.ce-tag').textContent=c?statusName(c.status):'Rascunho local';
  for(const btn of q('[data-ce-campaigns]').querySelectorAll('button'))btn.disabled=frozen;
 }
 function finishSavedAudienceRead(){
  if(!queuedSavedAudience||confirmation||remoteBusy)return;
  const {epoch,client}=queuedSavedAudience;queuedSavedAudience=null;
  if(epoch===contextEpoch&&client===remote)void audienceView?.confirmBindingRead();
 }
 async function runRemote(work,{fillSaved=false,write=false,read=false,confirmed=null,recoverLocal=false,confirmSavedAudience=false,allowAudiencePendingRecovery=false}={}){
  if(!remote||remoteBusy||(allowAudiencePendingRecovery?audienceState().activeOperation:audienceFrozen())||(confirmation&&confirmation!==confirmed))return;
  if(write&&localError&&!recoverLocal){message(localError,true);return;}
  if(write&&!requireWriteAccess())return;
  let accessDenied=null,contentError=false,readSavedAudience=false;
  const epoch=contextEpoch,client=remote,wasLocked=client.locked(),beforeValues=values();remoteBusy=true;remoteRead=read&&!write;paintRemote();
  try{const result=await work();if(epoch!==contextEpoch||client!==remote)return;if(fillSaved&&result?.campaign){const recovered=result.operation?.request?.acao==='campanha_recuperar'&&result.sourceOperation?.request?.definition;fill(recovered?(wasLocked?fromDefinition(recovered):beforeValues):fromDefinition(result.campaign.definition));saveLocal({recover:recoverLocal});dirty=!remote.clean(definition(values()));renderCampaigns([...remoteCampaigns.filter(c=>c.id!==result.campaign.id),result.campaign]);readSavedAudience=confirmSavedAudience&&!!result.campaign;}
   if(localError){message(localError,true);return;}
   if(result?.localOnly){message('Nova preparação local aberta. Nenhuma campanha foi criada ou enviada.');return;}
   if(result?.readOnly){const status={pending:'em processamento',outcome_unknown:'resultado incerto',succeeded:'concluída',rejected:'recusada'}[result.consultation?.state]||'estado não confirmado';message(`Consulta recebida: ${status}. O registro local foi preservado. A confirmação local depende da proteção entre abas deste navegador.`);return;}
   if(!remote.locked()&&result?.operation?.absence){message('Tentativa liberada sem efeito. A campanha foi relida do servidor; confira a versão atual antes de repetir a ação.');return;}
   if(!remote.locked()&&result?.operation?.request?.acao==='campanha_recuperar'){message('Rascunho existente recuperado. Seu conteúdo original foi preservado. Confira os links e salve as correções nesta mesma campanha.');return;}
   message(remote.locked()?'A tentativa continua pendente ou incerta. Consulte novamente; não crie outra tentativa.':'Operação conferida. Confira o resultado acima.',remote.locked());}
  catch(err){message(err.message,true);contentError=['NO_COMMERCIAL_LINK','TRACKING_INVALID','TRACKING_CONFLICT','TRACKING_POLICY'].includes(err.code);if(write&&['UNAUTHORIZED','CAPABILITY_MISSING'].includes(err.code)){sessionWrite='';legacyWrite=false;clearCatalog();accessDenied=err.code==='UNAUTHORIZED'?'Chave recusada. Confira a chave de escrita de campanhas.':'Esta chave não tem permissão para a ação. Confira o acesso; a tentativa foi preservada.';}}
  finally{remoteBusy=false;remoteRead=false;paintRemote();if(readSavedAudience)queuedSavedAudience={epoch,client};finishSavedAudienceRead();if(contentError&&!q('[name=html]').disabled)q('[name=html]').focus();if(accessDenied){if(confirmation)deferredAccess=accessDenied;else showAccess(accessDenied);}}
 }
 function renderCatalog(catalog){
  const e=esc,d=values(),selected=new Set(split(d.list_ids).map(Number)),templates=catalog.templates.filter(t=>Number.isSafeInteger(t.id)&&t.id>0&&t.available===true&&t.type==='campaign');
  const audienceNote='Os públicos chamados popup incluem inscritos sem compras e ainda não comprovam origem exclusiva no popup.'+(remoteBrand==='aristo'?' A lista VIP reúne Alma da Roça e Desodorante; ela não separa os lançamentos.':'');
  q('[data-ce-catalog]').innerHTML=`<div class="ce-catalog"><fieldset><legend>Públicos disponíveis</legend><p data-ce-audience-note>${e(audienceNote)}</p>${catalog.lists.filter(l=>Number.isSafeInteger(l.id)&&l.id>0&&l.available===true&&l.brand===remoteBrand).map(l=>`<label><input type="checkbox" data-ce-list value="${l.id}" ${selected.has(l.id)?'checked':''}> ${e(l.name||l.label||'Lista '+l.id)}</label>`).join('')||'<p>Nenhum público disponível nesta marca. Use Carregar catálogo e campanhas para conferir as listas sincronizadas.</p>'}</fieldset><label>Modelo de e-mail<select data-ce-template><option value="">Escolha um modelo</option>${templates.map(t=>`<option value="${t.id}" ${String(t.id)===d.template_id?'selected':''}>${e(t.name||'Template '+t.id)}</option>`).join('')}</select></label>${templates.length?'':'<p role="status">Nenhum modelo de campanha disponível. Use Carregar catálogo e campanhas antes de preparar o envio.</p>'}</div>`;
  q('[name=list_ids]').closest('label').hidden=true;q('[name=template_id]').closest('label').hidden=true;
  q('[data-ce-catalog]').querySelectorAll('[data-ce-list]').forEach(el=>el.addEventListener('change',()=>{if(localError||confirmation||remoteBusy||audienceFrozen()||remote?.locked()){paintRemote();return;}q('[name=list_ids]').value=[...q('[data-ce-catalog]').querySelectorAll('[data-ce-list]')].filter(x=>x.checked).map(x=>x.value).join(', ');keep();}));
  q('[data-ce-template]').addEventListener('change',e=>{if(localError||confirmation||remoteBusy||audienceFrozen()||remote?.locked()){paintRemote();return;}q('[name=template_id]').value=e.target.value;keep();});
 }
 function renderCampaigns(campaigns){
  remoteCampaigns=campaigns;
  q('[data-ce-campaigns]').innerHTML=`<div class="ce-campaign-list">${campaigns.map(c=>`<article><div><strong>${esc(c.definition.name)}</strong><span>${esc(statusName(c.status))} · ${c.sent} enviados · ${esc(stamp(c.send_at))}</span></div><button type="button" class="ce-secondary" data-ce-open="${c.id}">Reabrir</button></article>`).join('')||`<p>Nenhuma campanha salva nesta marca.${remoteCaps?.save?' Use Preparar novo rascunho para começar.':''}</p>`}</div>${hiddenCampaigns.length?`<div class="ce-campaign-hidden" data-ce-campaigns-hidden><p class="mini">${hiddenCampaigns.length===1?'1 campanha antiga desta marca está fora do contrato atual e não pode ser reaberta aqui':hiddenCampaigns.length+' campanhas antigas desta marca estão fora do contrato atual e não podem ser reabertas aqui'}. Continua${hiddenCampaigns.length===1?'':'m'} preservada${hiddenCampaigns.length===1?'':'s'} no serviço de envio.</p><ul>${hiddenCampaigns.map(c=>`<li data-ce-hidden-status="${esc(c.status)}"><strong>${esc(c.name||'Campanha '+c.id)}</strong> · ${esc(statusName(c.status))} · ${c.sent} enviados · ${esc(stamp(c.send_at))}${['scheduled','running','paused'].includes(c.status)?' · <strong>não pode ser cancelada por este painel; acione o responsável pelo serviço de envio.</strong>':''}</li>`).join('')}</ul></div>`:''}`;
  q('[data-ce-campaigns]').querySelectorAll('[data-ce-open]').forEach(btn=>btn.addEventListener('click',()=>{
   if(confirmation||remoteBusy)return;const id=Number(btn.dataset.ceOpen),client=remote;
   // Catálogo antes da reabertura: se a leitura falhar, o diário continua na campanha anterior
   // e o conteúdo local nunca fica vinculado (nem é salvo) sobre a campanha reaberta.
   const work=confirmed=>runRemote(async()=>{const catalog=await readCatalog(client);if(!catalog)return;const s=await client.reopen(id);fill(fromDefinition(s.campaign.definition));renderCatalog(catalog);return s;},{fillSaved:true,read:true,confirmed,recoverLocal:true,confirmSavedAudience:true});
   if(dirty)confirmAction('Substituir as alterações locais pelo conteúdo salvo desta campanha?','Reabrir campanha',work);else work(null);
  }));
 }
 function bindRemote(){
  bindAccess();
  q('[data-ce-refresh]').addEventListener('click',()=>{const client=remote;return runRemote(async()=>{const context=catalogContext(),catalog=await readCatalog(client);if(!catalog)return;const campaigns=await client.list();if(!catalogCurrent(context)){clearCatalog();return;}renderCatalog(catalog);hiddenCampaigns=client.listSkipped?.()||[];renderCampaigns(campaigns);},{read:true});});
  q('[data-ce-new]').addEventListener('click',()=>{
   if(!remote||remote.locked()||remoteBusy||confirmation||audienceFrozen()||localError)return;const client=remote,brand=values().brand;
   const work=confirmed=>runRemote(async()=>{await client.newDraft();fill(blank(brand));saveLocal();return {localOnly:true};},{confirmed});
   if(dirty)confirmAction('Guardar uma nova preparação local no lugar do conteúdo atual?','Preparar novo rascunho',work);else work(null);
  });
  q('[data-ce-consult]').addEventListener('click',()=>runRemote(()=>remote.consult(),{fillSaved:true,write:true,recoverLocal:true,confirmSavedAudience:true,allowAudiencePendingRecovery:true}));
  q('[data-ce-release]').addEventListener('click',()=>{
   const client=remote,op=client?.snapshot()?.operation;if(!client?.canReleaseUnapplied?.()||confirmation||remoteBusy||!requireWriteAccess())return;
   const what=op.request.acao==='campanha_agendar'?'agendamento':'cancelamento';
   confirmAction(`O servidor registrou esta tentativa de ${what} como resultado incerto. O painel vai conferir de novo a tentativa e a campanha e só libera se a campanha continuar na mesma versão do pedido, isto é, se nada foi alterado. A campanha será relida do servidor; nenhuma ação será repetida.`,'Liberar tentativa',confirmed=>runRemote(()=>client.releaseUnapplied('liberar'),{fillSaved:true,write:true,confirmed,recoverLocal:true,confirmSavedAudience:true}),{allowRelease:true});
  });
  q('[data-ce-recover]').addEventListener('click',()=>{
   const client=remote,proof=client?.snapshot()?.recoveryProof;if(!client?.canRecover()||confirmation||remoteBusy||!requireWriteAccess())return;
   const c=proof.campaign,brand=contextBrand==='fish'?'Fishermans':'O Aristocrata';
   confirmAction(`Recuperar ${brand} · “${c.definition.name}” (campanha ${c.id})? Foi confirmado um rascunho com 0 envios, ainda não iniciado. Seu conteúdo original será preservado para correção. Esta ação não cria outra campanha, não agenda e não envia.`, 'Recuperar este rascunho',confirmed=>runRemote(()=>client.recover(proof,'recuperar'),{fillSaved:true,write:true,confirmed,recoverLocal:true}),{allowRecovery:true});
  });
  q('[data-ce-save]').addEventListener('click',()=>{if(remote?.locked())return;const client=remote;runRemote(async()=>{if(!await readCatalog(client))return;return client.save(definition(values()));},{fillSaved:true,write:true,confirmSavedAudience:true});});
  q('[data-ce-validate]').addEventListener('click',()=>{if(audienceState().legacyBlocked){if(audienceState().canValidate)void audienceView.validate();return;}runRemote(()=>remote.validate(definition(values())),{fillSaved:true,write:true,confirmSavedAudience:true});});
  q('[data-ce-cancel]').addEventListener('click',()=>{
   const client=remote,c=client?.snapshot()?.campaign;if(!c||confirmation||remoteBusy)return;
   if(!requireWriteAccess())return;
   confirmAction(`Cancelar o agendamento de “${c.definition.name}” para ${stamp(c.send_at)}? A campanha agendada será cancelada; as alterações locais não serão salvas.`,'Cancelar agendamento',confirmed=>runRemote(()=>client.cancel('cancelar'),{fillSaved:true,write:true,confirmed}));
  });
  q('[data-ce-schedule]').addEventListener('click',async()=>{
   if(audienceState().legacyBlocked){if(audienceState().canSchedule)void audienceView.schedule();return;}
   const client=remote,s=client?.snapshot(),c=s?.campaign;if(!c||confirmation||remoteBusy||audienceState().legacyBlocked)return;
   if(!requireWriteAccess())return;
   let d,a;try{d=definition(values());a=CampaignContract.audienceReview(s.validation?.audience,c);CampaignContract.schedule({confirm:'agendar',expected_version:c.version,audience_review_id:a.review_id},{...c,validation:s.validation},{canPublish:remoteCaps.schedule===true});}catch(e){message(scheduleReason(e,c),true);paintRemote();return;}
   // O vínculo de público pode mudar depois da conferência (outra aba ou pessoa). Antes de
   // abrir a confirmação, relê o vínculo atual: a conferência por listas não autoriza agendar
   // uma campanha que passou a ter público salvo vinculado.
   if(audienceState().active){
    const ok=await audienceView.confirmBindingRead();
    if(!ok||audienceState().legacyBlocked||remote!==client||client.snapshot()?.campaign?.version!==c.version){message('O vínculo de público desta campanha mudou ou não pôde ser confirmado agora. Nada foi agendado; confira o público e a campanha antes de agendar.',true);paintRemote();return;}
   }
   confirmAction(`Agendar ${contextBrand==='fish'?'Fishermans':contextBrand==='aristo'?'O Aristocrata':contextBrand} · “${c.definition.name}” para ${stamp(c.send_at)}? ${audienceNumber(a.eligible_count)} ${a.eligible_count===1?'pessoa pode':'pessoas podem'} receber agora, sem duplicar contatos entre listas. Listas: ${audienceLists(a.list_ids)}. Conferência válida até ${stamp(a.expires_at)}. O total pode mudar por inscrições e descadastros até o envio.`,'Agendar campanha',confirmed=>runRemote(()=>client.schedule(d,'agendar',a.review_id),{fillSaved:true,write:true,confirmed}));
  });
 }
 return {contextStatus,preserve,enterBrand,mount,catalogs,definition,fromDefinition,parseAccessFile,brasiliaOffset};
})();
if(typeof module!=='undefined')module.exports=GCE;
