/* Campaign editor. Server actions require explicitly announced capabilities. */
'use strict';
const GCE=(()=>{
 let contextBrand=null,contextEpoch=0,localError='';
 const fields=['brand','initiative_name','initiative_key','utm_campaign','name','subject','from_email','reply_to','list_ids','template_id','send_at','tags','html','text'];
 let root=null,dirty=false,api=null,remote=null,remoteCaps=null,remoteBusy=false,remoteBrand=null,remoteCampaigns=[];
 let sessionWrite='',legacyWrite=true,accessImporting=false,accessEpoch=0,accessFileError=false,accessCaller=null;
 let confirmation=null,deferredAccess='',audienceTimer=null;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const blank=brand=>({brand:['fish','aristo','olivas'].includes(brand)?brand:'fish',initiative_name:'',initiative_key:'',utm_campaign:'',name:'',subject:'',from_email:'',reply_to:'',list_ids:'',template_id:'',send_at:'',tags:'',html:'',text:''});
 const split=v=>String(v||'').split(',').map(v=>v.trim()).filter(Boolean);
 const definition=v=>CampaignContract.normalize({schema_version:CampaignContract.VERSION,brand:v.brand,channel:'email',initiative:{key:v.initiative_key,name:v.initiative_name},utm_campaign:v.utm_campaign,name:v.name,subject:v.subject,from_email:v.from_email,reply_to:v.reply_to,list_ids:split(v.list_ids).map(Number),template_id:Number(v.template_id),html:v.html,text:v.text,tags:split(v.tags),send_at:v.send_at?v.send_at+'-03:00':null});
 const fromDefinition=input=>{const d=CampaignContract.normalize(input);return {brand:d.brand,initiative_name:d.initiative.name,initiative_key:d.initiative.key,utm_campaign:d.utm_campaign,name:d.name,subject:d.subject,from_email:d.from_email,reply_to:d.reply_to,list_ids:d.list_ids.join(', '),template_id:String(d.template_id),send_at:d.send_at?new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,hourCycle:'h23'}).format(new Date(d.send_at)).replace(' ','T').replace(',','.').replace(/\.000$/,''):'',tags:d.tags.join(', '),html:d.html,text:d.text};};
 function values(){return Object.fromEntries(fields.map(k=>[k,root.querySelector(`[name="${k}"]`).value]));}
 function message(text,error=false){const el=root.querySelector('[data-ce-status]');el.textContent=text;el.dataset.error=String(error);}
 function keep(){if(confirmation||remoteBusy)return;if(localError){message(localError,true);paintRemote();return;}dirty=true;try{saveLocal();message('Alterações guardadas neste navegador.');}catch(e){localError=e.message;message(e.message,true);}paintRemote();}
 function fill(v){for(const k of fields)root.querySelector(`[name="${k}"]`).value=typeof v[k]==='string'?v[k]:'';}
 const input=(name,label,placeholder='',extra='')=>`<label>${label}<input name="${name}" autocomplete="off" placeholder="${esc(placeholder)}" ${extra}></label>`;
 function mount({marca='fish',api:payload=null}={}){
  api=payload;
  const target=typeof document!=='undefined'?document.getElementById('campaign-composer'):null;
  if(!target)return;if(target===root){if(contextBrand!==marca)enterBrand(marca);else setupRemote();return;}confirmation?.finish(false);root=target;
  root.innerHTML=`<details class="ce-shell"><summary><span class="ce-icon" aria-hidden="true">+</span><span class="ce-title"><strong>Preparar campanha</strong><span>Escolha o público, prepare a mensagem e revise o envio.</span></span><span class="ce-tag">Rascunho local</span></summary>
   <div class="ce-body"><div class="ce-intro"><div><h3>Nova campanha de e-mail</h3><span class="ce-tag" title="A iniciativa reúne os disparos no relatório. Cada disparo mantém seu público e rastreamento próprios.">Agrupada por iniciativa</span></div><label class="ce-import">Importar JSON<input type="file" accept=".json,application/json" data-ce-import></label></div>
   <section class="ce-remote" data-ce-remote hidden aria-label="Campanhas no servidor"><div class="ce-remote-access"><button type="button" class="ce-secondary" data-ce-access-open>Acesso de escrita de campanhas</button><span data-ce-key-state role="status"></span></div>
   <form data-ce-access-form hidden novalidate aria-labelledby="ce-access-title"><h4 id="ce-access-title">Acesso de escrita de campanhas</h4><p id="ce-access-help">A nova chave fica somente nesta página aberta. Preparar o acesso não salva, valida, agenda ou cancela; depois, escolha a ação desejada.</p><fieldset data-ce-access-fields><div class="ce-grid"><label for="ce-access-key">Chave de escrita de campanhas<input id="ce-access-key" type="password" data-ce-key autocomplete="off" spellcheck="false" maxlength="256" aria-describedby="ce-access-help ce-access-message"></label><label for="ce-access-file">Importar arquivo de acesso de campanhas<input id="ce-access-file" type="file" data-ce-access-file accept="application/json,.json" aria-describedby="ce-access-help ce-access-message"></label></div><button type="submit" class="ce-secondary" data-ce-key-save>Usar nesta página</button></fieldset><button type="button" class="ce-secondary" data-ce-access-cancel>Cancelar</button><p id="ce-access-message" data-ce-access-message role="status" aria-live="polite"></p></form><div class="ce-actions"><button type="button" class="ce-secondary" data-ce-refresh>Carregar catálogo e campanhas</button><button type="button" class="ce-secondary" data-ce-new>Preparar novo rascunho</button><button type="button" class="ce-secondary" data-ce-consult>Consultar tentativa</button></div><p data-ce-server-state role="status" aria-live="polite"></p><div data-ce-campaigns></div><div data-ce-catalog></div><div class="ce-tracking" data-ce-audience role="status" aria-live="polite"></div><div class="ce-actions"><button type="button" class="ce-primary" data-ce-save>Salvar no servidor</button><button type="button" class="ce-secondary" data-ce-validate>Conferir conteúdo e público</button><button type="button" class="ce-primary" data-ce-schedule>Agendar campanha</button><button type="button" class="ce-secondary" data-ce-cancel>Cancelar agendamento</button></div><span class="ce-tag" title="Salvar mantém o rascunho sem envio. Confira o público antes de agendar. Se o resultado ficar incerto, consulte a mesma tentativa antes de continuar.">Envio exige confirmação</span></section><form data-ce-definition novalidate><fieldset><legend><span>01</span> Campanha e iniciativa</legend><div class="ce-grid"><label>Marca<input name="brand" type="hidden"><strong data-ce-brand></strong></label>${input('initiative_name','Iniciativa comercial','Ex.: Semana do Cliente')}${input('initiative_key','Identificador da iniciativa','Ex.: semana-do-cliente-2026')}${input('utm_campaign','UTM da campanha','Use o identificador já adotado na iniciativa')}${input('name','Nome deste disparo','Ex.: Abertura · clientes recorrentes')}${input('subject','Assunto do e-mail','O assunto que aparece na caixa de entrada','maxlength="250"')}</div></fieldset>
   <fieldset><legend><span>02</span> Público e remetente</legend><div class="ce-grid">${input('list_ids','IDs das listas','Ex.: 123, 124')}${input('template_id','ID do template de campanha','Consulte o catálogo de templates','inputmode="numeric"')}${input('from_email','Remetente','Marca <email@dominio-da-marca>')}${input('reply_to','Endereço para respostas','email@dominio-da-marca')}${input('send_at','Data desejada · Brasília, UTC−3 (opcional)','','type="datetime-local" step="60"')}${input('tags','Tags (opcional)','abertura, clientes-recorrentes')}</div><span class="ce-tag" title="A data só é aplicada após conferir o público e confirmar Agendar campanha.">Data ainda não agendada</span></fieldset>
   <fieldset><legend><span>03</span> Conteúdo</legend><div class="ce-grid ce-content"><label>HTML do e-mail<textarea name="html" spellcheck="false" placeholder="Cole o HTML com os links da loja e {{ UnsubscribeURL }}"></textarea></label><label>Versão em texto<textarea name="text" placeholder="Cole a versão em texto, incluindo os links e {{ UnsubscribeURL }}"></textarea></label></div></fieldset>
   <div class="ce-tracking"><span class="ce-tag" data-ce-tracking-note title="O arquivo exportado prepara a campanha; não confirma envio ou agendamento.">Rastreamento conferido ao salvar</span></div>
   <div class="ce-actions"><button type="button" class="ce-secondary" data-ce-preview>Abrir prévia do HTML</button><button type="button" class="ce-primary" data-ce-export>Verificar e exportar JSON</button><button type="button" class="ce-secondary" data-ce-reset>Limpar rascunho</button><span data-ce-status role="status" aria-live="polite">Rascunho local. Ainda não cadastrado para envio.</span></div>
   </form></div></details><dialog class="ce-confirm" data-ce-confirm aria-labelledby="ce-confirm-title" aria-describedby="ce-confirm-text"><h3 id="ce-confirm-title">Confirmar ação</h3><p id="ce-confirm-text" data-ce-confirm-text></p><div class="ce-confirm-actions"><button type="button" class="ce-secondary" data-ce-confirm-no autofocus>Voltar sem alterar</button><button type="button" class="ce-primary" data-ce-confirm-yes>Confirmar</button></div></dialog>`;
  enterBrand(marca);
  root.querySelector('[data-ce-definition]').addEventListener('submit',e=>e.preventDefault());
  root.querySelector('[data-ce-definition]').addEventListener('input',keep);
  root.querySelector('[data-ce-import]').addEventListener('change',async e=>{
   const field=e.target,f=field.files?.[0];if(!f||confirmation||remoteBusy||localError)return;
   try{if(remote?.locked())throw Error('Consulte a tentativa pendente antes de importar outro conteúdo.');if(f.size>800000)throw Error('Use um arquivo JSON de até 800 KB.');const before=confirmationContext(),v=fromDefinition(JSON.parse(await f.text()));if(v.brand!==contextBrand)throw Error('Este arquivo é de outra marca. Abra a marca do arquivo no cabeçalho antes de importar.');if(!sameContext(before))throw Error('O rascunho mudou durante a leitura. Confira o conteúdo e importe novamente.');
    const apply=()=>{fill(v);setupRemote();saveLocal();message('JSON importado e campos conferidos. Catálogo e UTMs finais serão validados na integração de envio.');};
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
 function saveLocal({recover=false}={}){if(localError&&!recover)throw Error(localError);if(!GBS.validBrand(contextBrand))return;dirty=true;const c=remote?.snapshot()?.campaign;GBS.save('campaign',contextBrand,{...values(),_campaign:c?{id:c.id,version:c.version}:null});localError='';}
 function contextStatus(){return {blocked:!!(remoteBusy||confirmation||accessImporting),dirty:!!localError,pending:!!remote?.locked()};}
 function preserve(){if(localError)throw Error(localError);if(root&&GBS.validBrand(contextBrand))saveLocal();}
 function enterBrand(brand){
  if(remoteBusy||confirmation||accessImporting)return false;
  contextBrand=brand;contextEpoch++;remote=null;remoteBrand=null;remoteCampaigns=[];localError='';
  let initial=blank(brand);try{initial={...initial,...(GBS.campaign(brand)||{})};}catch(e){localError=e.message;}
  initial.brand=GBS.validBrand(brand)?brand:'';fill(initial);dirty=fields.some(k=>k!=='brand'&&initial[k]);
  q('[data-ce-brand]').textContent=({fish:'Fishermans',aristo:'O Aristocrata',olivas:'Olivas do Campo'})[brand]||'Escolha uma marca no cabeçalho';
  q('[data-ce-definition]').hidden=!GBS.validBrand(brand);setupRemote();
  if(!localError&&Object.hasOwn(initial,'_campaign')){
   const c=remote?.snapshot()?.campaign,anchor=c?{id:c.id,version:c.version}:null;
   if(JSON.stringify(initial._campaign)!==JSON.stringify(anchor)){localError='A campanha ou revisão desta marca mudou em outra aba. Exporte a preparação local e reabra a campanha antes de editar.';paintRemote();}
  }
  if(localError)message(localError,true);else message(GBS.validBrand(brand)?'Preparação desta marca. Salvar localmente não envia a campanha.':'Escolha uma marca no cabeçalho para preparar uma campanha.');
  return true;
 }

 function confirmationContext(){
  return {root,client:remote,epoch:contextEpoch,brand:values().brand,draft:JSON.stringify(values()),dirty,server:JSON.stringify(remote?.snapshot()||null),caps:JSON.stringify(remoteCaps),writer:currentWriteKey(),journal:remote?localStorage.getItem(GCA.JOURNAL+remoteBrand):null};
 }
 function sameContext(before){
  const after=confirmationContext();return before.root===after.root&&before.client===after.client&&['epoch','brand','draft','dirty','server','caps','writer','journal'].every(k=>before[k]===after[k])&&!remote?.locked();
 }
 async function confirmAction(text,label,work){
  if(confirmation||remoteBusy||remote?.locked()||accessImporting)return;
  const dialog=q('[data-ce-confirm]'),caller=document.activeElement;
  if(typeof dialog?.showModal!=='function'||typeof dialog?.close!=='function'){message('Este navegador não conseguiu abrir a confirmação. Nenhuma ação foi executada.',true);return;}
  let token;
  try{
   const before=confirmationContext();token={finish:()=>{}};confirmation=token;paintRemote();
   const accepted=await new Promise(resolve=>{
    let settled=false;
    const finish=yes=>{if(settled)return;settled=true;dialog.oncancel=null;dialog.onclose=null;q('[data-ce-confirm-yes]').onclick=null;q('[data-ce-confirm-no]').onclick=null;try{dialog.close();}catch{dialog.removeAttribute('open');}resolve(yes);};
    token.finish=finish;q('[data-ce-confirm-text]').textContent=text;q('[data-ce-confirm-yes]').textContent=label;
    q('[data-ce-confirm-yes]').onclick=()=>finish(true);q('[data-ce-confirm-no]').onclick=()=>finish(false);
    dialog.oncancel=e=>{e.preventDefault();finish(false);};dialog.onclose=()=>finish(false);
    try{dialog.showModal();q('[data-ce-confirm-no]').focus();}catch{message('Não foi possível abrir a confirmação. Nenhuma ação foi executada.',true);finish(false);}
   });
   if(!accepted)return;
   if(confirmation!==token||!sameContext(before)){message('A campanha, o acesso ou o rascunho mudou durante a confirmação. Confira o estado atual antes de continuar.',true);return;}
   await work(token,before.client);
  }catch{message('Não foi possível confirmar o estado desta ação. Nenhuma nova tentativa será iniciada; confira o registro existente.',true);}
  finally{if(confirmation===token)confirmation=null;paintRemote();if(deferredAccess){const text=deferredAccess;deferredAccess='';showAccess(text);}else if(root?.isConnected){const target=caller?.isConnected&&!caller.disabled?caller:q('.ce-shell > summary');target?.focus();}}
 }
 const keyValue=slot=>{try{return localStorage.getItem(slot)||'';}catch{return '';}};
 const validWriteKey=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(v.trim());
 const currentWriteKey=()=>{const k=sessionWrite||(legacyWrite?((typeof shrigmaChaveOperador==='function'?shrigmaChaveOperador('growth','draft'):'')||(typeof GTA!=='undefined'?keyValue(GTA.CHAVE_ESCRITA):'')):'');return validWriteKey(k)?k.trim():'';};
 function parseAccessFile(text){
  if(typeof text!=='string'||text.length>8192)throw Error('invalid_access_file');
  let p;try{p=JSON.parse(text);}catch(_){throw Error('invalid_access_file');}
  const fields=['schema','panel','role','key'];
  if(!p||Array.isArray(p)||typeof p!=='object'||p.schema!=='shrigma_panel_access_v1'||p.panel!=='campaign'||p.role!=='write'||!validWriteKey(p.key)||fields.some(k=>!Object.hasOwn(p,k))||Object.keys(p).some(k=>!fields.includes(k)))throw Error('invalid_access_file');
  return {key:p.key.trim()};
 }
 function showAccess(text=''){
  if(remoteBusy||confirmation)return;
  const form=q('[data-ce-access-form]');if(!form.hidden){if(text)q('[data-ce-access-message]').textContent=text;return;}
  accessCaller=document.activeElement;accessEpoch++;accessImporting=false;accessFileError=false;
  q('[data-ce-key]').value='';q('[data-ce-key]').removeAttribute('aria-invalid');q('[data-ce-access-file]').value='';
  q('[data-ce-access-message]').textContent=text||'Informe o acesso. Depois, clique novamente na ação desejada.';
  form.hidden=false;q('[data-ce-access-fields]').disabled=false;q('[data-ce-key]').focus();
 }
 function closeAccess(){
  if(confirmation)return;
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
   e.preventDefault();if(form.hidden||remoteBusy||confirmation||accessImporting)return;
   const k=field.value.trim();if(accessFileError||!validWriteKey(k)){notice.textContent='Informe uma chave válida de escrita de campanhas.';field.setAttribute('aria-invalid','true');field.focus();return;}
   sessionWrite=k;legacyWrite=false;closeAccess();paintRemote();message('Acesso preparado somente nesta página. Nenhuma operação foi enviada; confira e clique na ação desejada.');
  };
  file.onchange=async()=>{
   if(form.hidden||remoteBusy||confirmation)return;
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
  if(typeof GCA==='undefined')return;
  const next=GCA.caps(api),brand=contextBrand;
  if(remote&&remoteBrand===brand&&remoteCaps?.endpoint===next.endpoint){remoteCaps=next;remote.updateCapabilities(next);paintRemote();return;}
  remote=null;remoteCaps=next;remoteBrand=brand;remoteCampaigns=[];
  q('[data-ce-catalog]').innerHTML='';q('[data-ce-campaigns]').innerHTML='';
  for(const n of ['list_ids','template_id'])q(`[name=${n}]`).closest('label').hidden=false;
  if(next.endpoint&&next.brands.includes(brand)){
   try{remote=GCA.createClient({capabilities:next,brand,readKey:()=>typeof GTA.chaveLeitura==='function'?GTA.chaveLeitura():typeof shrigmaChave==='function'?shrigmaChave('growth'):keyValue(GTA.CHAVE_LEITURA),writeKey:currentWriteKey});}
   catch(err){message(err.message,true);}
  }
  paintRemote();
 }
 const audienceNumber=n=>new Intl.NumberFormat('pt-BR').format(n);
 function paintAudience(s,c,clean){
  if(audienceTimer!==null){clearTimeout(audienceTimer);audienceTimer=null;}
  const el=q('[data-ce-audience]');el.hidden=false;
  if(!c||c.status!=='draft'||!clean){el.hidden=!!c&&c.status!=='draft';el.textContent=c&&c.status!=='draft'?'':!clean&&c?'Salve as alterações e confira o público antes de agendar.':'Salve a campanha para conferir quantas pessoas podem receber.';return null;}
  if(remoteCaps.audience_review!==CampaignContract.AUDIENCE_POLICY){el.textContent='A conferência do público ainda não está disponível. O agendamento aguarda essa atualização.';return null;}
  const a=s.validation?.audience;
  try{CampaignContract.audienceReview(a,c,{now:Date.parse(a?.checked_at),allowBlocked:true});}catch{el.textContent='Confira o conteúdo e o público antes de agendar.';return null;}
  let ready=true,reason='';
  try{CampaignContract.schedule({confirm:'agendar',expected_version:c.version,audience_review_id:a.review_id},{...c,validation:s.validation},{canPublish:remoteCaps.schedule===true});}catch(e){ready=false;reason=e.code==='AUDIENCE_DISABLED'?'Há contatos desativados. Revise o público antes de agendar.':e.message;}
  const count=audienceNumber(a.eligible_count),label=a.eligible_count===1?'pessoa pode receber agora':'pessoas podem receber agora';
  el.innerHTML=`<strong>${count} ${label}</strong><span class="ce-tag">Descadastros e bloqueios conferidos</span><p>Contatos repetidos entre listas são contados uma vez. Quem saiu de uma lista não entra por ela; a pessoa ainda pode estar inscrita em outra lista selecionada.</p><p>${audienceNumber(a.excluded_blocklisted_count)} bloqueados · ${audienceNumber(a.excluded_subscription_count)} sem inscrição válida · ${audienceNumber(a.native_disabled_count)} desativados.</p><p>Conferido em ${esc(stamp(a.checked_at))}. Válido até ${esc(stamp(a.expires_at))}. O total pode mudar até o envio; novos descadastros serão respeitados.</p>${reason?`<p><strong>${esc(reason)}</strong></p>`:''}`;
  const remaining=Date.parse(a.expires_at)-Date.now();
  if(remaining>0){audienceTimer=setTimeout(()=>{audienceTimer=null;if(root?.isConnected)paintRemote();},Math.min(remaining+1,2147483647));audienceTimer?.unref?.();}
  return ready?a:null;
 }
 function paintRemote(){
  if(!root)return;
  const exists=!!remote,section=q('[data-ce-remote]');section.hidden=!exists;
  for(const name of ['list_ids','template_id'])q(`[name=${name}]`).closest('label').hidden=exists;
  q('[data-ce-tracking-note]').title=exists?'Ao salvar, as UTMs são aplicadas aos links desta campanha. Confira a versão salva antes de agendar.':'O arquivo exportado prepara a campanha; não confirma envio ou agendamento.';
  const s=remote?.snapshot(),locked=!!remote?.locked(),frozen=locked||remoteBusy||!!confirmation;
  for(const name of fields)q(`[name="${name}"]`).disabled=frozen||name==='brand'||!GBS.validBrand(contextBrand)||!!localError;
  q('[data-ce-import]').disabled=frozen||!!localError;q('[data-ce-reset]').disabled=frozen||!!localError;
  q('[data-ce-export]').disabled=remoteBusy||!!confirmation;q('[data-ce-preview]').disabled=remoteBusy||!!confirmation;
  for(const el of q('[data-ce-catalog]').querySelectorAll('input,select'))el.disabled=frozen||!!localError;
  const selected=new Set(split(values().list_ids));for(const el of q('[data-ce-catalog]').querySelectorAll('[data-ce-list]'))el.checked=selected.has(el.value);
  if(q('[data-ce-template]'))q('[data-ce-template]').value=values().template_id;
  q('[data-ce-key-state]').textContent=sessionWrite?'Acesso de edição disponível nesta página.':currentWriteKey()?'Acesso legado disponível neste navegador.':'Informe a chave para salvar, validar, agendar ou cancelar.';
  q('[data-ce-access-open]').disabled=remoteBusy||!!confirmation;q('[data-ce-access-fields]').disabled=remoteBusy||accessImporting||!!confirmation;q('[data-ce-access-cancel]').disabled=!!confirmation;
  if(!exists){if(audienceTimer!==null){clearTimeout(audienceTimer);audienceTimer=null;}q('[data-ce-audience]').textContent='';return;}
  let d=null;try{d=definition(values());}catch{}
  const writes=remote.canWrite()&&!localError,c=s.campaign,clean=d&&remote.clean(d),draft=c?.status==='draft'&&c.sent===0&&!c.started_at;
  const set=(name,shown,disabled)=>{const b=q(`[data-ce-${name}]`);b.hidden=!shown;b.disabled=disabled;};
  set('refresh',remoteCaps.read,remoteBusy||!!confirmation);set('new',remoteCaps.save,frozen||!writes);set('consult',remoteCaps.operation,remoteBusy||!!confirmation||!s.operation);
  set('save',remoteCaps.save,frozen||!writes||!!c&&!draft);set('validate',remoteCaps.validate,frozen||!writes||!draft||!clean);
  const audience=paintAudience(s,c,clean);
  set('schedule',remoteCaps.schedule,frozen||!writes||!draft||!clean||!audience);
  set('cancel',remoteCaps.cancel,frozen||!writes||c?.status!=='scheduled'||c?.sent!==0||c?.started_at!==null||!c?.send_at||Date.parse(c.send_at)<=Date.now());
  const op=s.operation;
  const parts=[c?`${statusName(c.status)} · ${c.sent} enviados · ${stamp(c.send_at)}`:'Ainda sem campanha cadastrada neste editor.'];
  if(localError)parts.push(localError);else if(!writes)parts.push('Consulta disponível. Este navegador não oferece a proteção entre abas necessária para salvar, validar, agendar ou cancelar.');
  if(c)parts.push(clean?'Conteúdo corresponde à versão salva.':'Há alterações locais; salve antes de validar.');
  if(c&&s.validation?.ok===true&&s.validation.version===c.version)parts.push('Versão salva validada.');
  if(locked)parts.push('Resultado pendente ou incerto. Edição e novas tentativas bloqueadas; consulte a mesma operação.');
  else if(op?.phase==='rejected')parts.push('Tentativa recusada com estado confirmado. Confira o conteúdo antes de nova ação.');
  else if(op?.phase==='succeeded')parts.push('Última operação confirmada pelo servidor.');
  q('[data-ce-server-state]').textContent=parts.join(' ');
  q('.ce-tag').textContent=c?statusName(c.status):'Rascunho local';
  for(const btn of q('[data-ce-campaigns]').querySelectorAll('button'))btn.disabled=frozen;
 }
 async function runRemote(work,{fillSaved=false,write=false,confirmed=null,recoverLocal=false}={}){
  if(!remote||remoteBusy||(confirmation&&confirmation!==confirmed))return;
  if(write&&localError&&!recoverLocal){message(localError,true);return;}
  if(write&&!requireWriteAccess())return;
  let accessDenied=null;
  const epoch=contextEpoch,client=remote;remoteBusy=true;paintRemote();
  try{const result=await work();if(epoch!==contextEpoch||client!==remote)return;if(fillSaved&&result?.campaign){fill(fromDefinition(result.campaign.definition));saveLocal({recover:recoverLocal});dirty=false;renderCampaigns([...remoteCampaigns.filter(c=>c.id!==result.campaign.id),result.campaign]);}
   if(localError){message(localError,true);return;}
   if(result?.localOnly){message('Nova preparação local aberta. Nenhuma campanha foi criada ou enviada.');return;}
   if(result?.readOnly){const status={pending:'em processamento',outcome_unknown:'resultado incerto',succeeded:'concluída no servidor',rejected:'recusada no servidor'}[result.consultation?.state]||'estado não confirmado';message(`Consulta recebida: ${status}. O registro local foi preservado. A confirmação local depende da proteção entre abas deste navegador.`);return;}
   message(remote.locked()?'A tentativa continua pendente ou incerta. Consulte novamente; não crie outra tentativa.':'Operação conferida. O estado acima mostra o que o servidor confirmou.',remote.locked());}
  catch(err){message(err.message,true);if(write&&['UNAUTHORIZED','CAPABILITY_MISSING'].includes(err.code)){sessionWrite='';legacyWrite=false;accessDenied=err.code==='UNAUTHORIZED'?'Chave recusada. Confira a chave de escrita de campanhas.':'Esta chave não tem permissão para a ação. Confira o acesso; a tentativa foi preservada.';}}
  finally{remoteBusy=false;paintRemote();if(accessDenied){if(confirmation)deferredAccess=accessDenied;else showAccess(accessDenied);}}
 }
 function renderCatalog(catalog){
  const e=esc,d=values(),selected=new Set(split(d.list_ids).map(Number)),templates=catalog.templates.filter(t=>Number.isSafeInteger(t.id)&&t.id>0&&t.available===true&&t.type==='campaign');
  q('[data-ce-catalog]').innerHTML=`<div class="ce-catalog"><fieldset><legend>Públicos disponíveis</legend>${catalog.lists.filter(l=>Number.isSafeInteger(l.id)&&l.id>0&&l.available===true&&l.brand===remoteBrand).map(l=>`<label><input type="checkbox" data-ce-list value="${l.id}" ${selected.has(l.id)?'checked':''}> ${e(l.name||l.label||'Lista '+l.id)}</label>`).join('')||'<p>Nenhum público disponível nesta marca. Use Carregar catálogo e campanhas para conferir as listas sincronizadas.</p>'}</fieldset><label>Modelo de e-mail<select data-ce-template><option value="">Escolha um modelo</option>${templates.map(t=>`<option value="${t.id}" ${String(t.id)===d.template_id?'selected':''}>${e(t.name||'Template '+t.id)}</option>`).join('')}</select></label>${templates.length?'':'<p role="status">Nenhum modelo de campanha disponível. Use Carregar catálogo e campanhas antes de preparar o envio.</p>'}</div>`;
  q('[name=list_ids]').closest('label').hidden=true;q('[name=template_id]').closest('label').hidden=true;
  q('[data-ce-catalog]').querySelectorAll('[data-ce-list]').forEach(el=>el.addEventListener('change',()=>{if(localError||confirmation||remoteBusy||remote?.locked()){paintRemote();return;}q('[name=list_ids]').value=[...q('[data-ce-catalog]').querySelectorAll('[data-ce-list]')].filter(x=>x.checked).map(x=>x.value).join(', ');keep();}));
  q('[data-ce-template]').addEventListener('change',e=>{if(localError||confirmation||remoteBusy||remote?.locked()){paintRemote();return;}q('[name=template_id]').value=e.target.value;keep();});
 }
 function renderCampaigns(campaigns){
  remoteCampaigns=campaigns;
  q('[data-ce-campaigns]').innerHTML=`<div class="ce-campaign-list">${campaigns.map(c=>`<article><div><strong>${esc(c.definition.name)}</strong><span>${esc(statusName(c.status))} · ${c.sent} enviados · ${esc(stamp(c.send_at))}</span></div><button type="button" class="ce-secondary" data-ce-open="${c.id}">Reabrir</button></article>`).join('')||'<p>Nenhuma campanha salva nesta marca. Use Preparar novo rascunho para começar.</p>'}</div>`;
  q('[data-ce-campaigns]').querySelectorAll('[data-ce-open]').forEach(btn=>btn.addEventListener('click',()=>{
   if(confirmation||remoteBusy)return;const id=Number(btn.dataset.ceOpen),client=remote;
   const work=confirmed=>runRemote(async()=>{const s=await client.reopen(id);const catalog=await client.catalog();fill(fromDefinition(s.campaign.definition));renderCatalog(catalog);return s;},{fillSaved:true,confirmed,recoverLocal:true});
   if(dirty)confirmAction('Substituir as alterações locais pelo conteúdo salvo desta campanha?','Reabrir campanha',work);else work(null);
  }));
 }
 function bindRemote(){
  bindAccess();
  q('[data-ce-refresh]').addEventListener('click',()=>runRemote(async()=>{const catalog=await remote.catalog(),campaigns=await remote.list();renderCatalog(catalog);renderCampaigns(campaigns);}));
  q('[data-ce-new]').addEventListener('click',()=>{
   if(!remote||remote.locked()||remoteBusy||confirmation||localError)return;const client=remote,brand=values().brand;
   const work=confirmed=>runRemote(async()=>{await client.newDraft();fill(blank(brand));saveLocal();q('[data-ce-catalog]').innerHTML='';for(const n of ['list_ids','template_id'])q(`[name=${n}]`).closest('label').hidden=false;return {localOnly:true};},{confirmed});
   if(dirty)confirmAction('Guardar uma nova preparação local no lugar do conteúdo atual?','Preparar novo rascunho',work);else work(null);
  });
  q('[data-ce-consult]').addEventListener('click',()=>runRemote(()=>remote.consult(),{fillSaved:true,write:true,recoverLocal:true}));
  q('[data-ce-save]').addEventListener('click',()=>{if(remote?.locked())return;runRemote(async()=>{await remote.catalog();return remote.save(definition(values()));},{fillSaved:true,write:true});});
  q('[data-ce-validate]').addEventListener('click',()=>runRemote(()=>remote.validate(definition(values())),{fillSaved:true,write:true}));
  q('[data-ce-cancel]').addEventListener('click',()=>{
   const client=remote,c=client?.snapshot()?.campaign;if(!c||confirmation||remoteBusy)return;
   if(!requireWriteAccess())return;
   confirmAction(`Cancelar o agendamento de “${c.definition.name}” para ${stamp(c.send_at)}? A campanha agendada será cancelada; as alterações locais não serão salvas.`,'Cancelar agendamento',confirmed=>runRemote(()=>client.cancel('cancelar'),{fillSaved:true,write:true,confirmed}));
  });
  q('[data-ce-schedule]').addEventListener('click',()=>{
   const client=remote,s=client?.snapshot(),c=s?.campaign;if(!c||confirmation||remoteBusy)return;
   if(!requireWriteAccess())return;
   let d,a;try{d=definition(values());a=CampaignContract.audienceReview(s.validation?.audience,c);CampaignContract.schedule({confirm:'agendar',expected_version:c.version,audience_review_id:a.review_id},{...c,validation:s.validation},{canPublish:remoteCaps.schedule===true});}catch(e){message(e.message,true);paintRemote();return;}
   confirmAction(`Agendar ${contextBrand==='fish'?'Fishermans':contextBrand==='aristo'?'O Aristocrata':contextBrand} · “${c.definition.name}” para ${stamp(c.send_at)}? ${audienceNumber(a.eligible_count)} ${a.eligible_count===1?'pessoa pode':'pessoas podem'} receber agora, sem duplicar contatos entre listas. Conferência válida até ${stamp(a.expires_at)}. O total pode mudar por inscrições e descadastros até o envio.`,'Agendar campanha',confirmed=>runRemote(()=>client.schedule(d,'agendar',a.review_id),{fillSaved:true,write:true,confirmed}));
  });
 }
 return {contextStatus,preserve,enterBrand,mount,definition,fromDefinition,parseAccessFile};
})();
if(typeof module!=='undefined')module.exports=GCE;
