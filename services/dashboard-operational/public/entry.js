/* Same-origin entry. The cookie session, not anything in this file, grants access. */
function inviteUrlForArea(raw,area,areaHosts){
 if(!areaHosts||typeof areaHosts!=='object'||!Object.hasOwn(areaHosts,area)||typeof areaHosts[area]!=='string')return null;
 const expectedHost=areaHosts[area];
 if(!/^[a-z0-9.-]{1,253}$/.test(expectedHost)||expectedHost.startsWith('.')||expectedHost.endsWith('.'))return null;
 let url;try{url=new URL(raw);}catch(_){return null;}
 if(url.protocol!=='https:'||url.port||url.username||url.password||url.pathname!=='/'||url.search||!/^#invite=[A-Za-z0-9_-]{16,256}$/.test(url.hash)||url.hostname!==expectedHost)return null;
 return url.href;
}
// Presentation only: the BFF still validates every operation on the server.
// The build can reuse the unscoped version for direct panel URLs, without
// changing the legacy source pages or the separate CX dashboard.
function readOnlyStyles(area,{embeddedOnly=true}={}){
 const common=['#growth-acesso','#organico-acesso-bar','#organico-acesso','#influ-access'];
 const audienceDraft=[
  '#crm-segments-panel .gs-shortcuts',
  '#crm-segments-panel [data-gs="new"]','#crm-segments-panel [data-gs-fields]',
  '#crm-segments-panel [data-gs="save"]','#crm-segments-panel [data-gs="archive"]',
  '#crm-segments-panel [data-gs-dialog]',
  '#crm-audience-create','#crm-audience-brand-choices','#area-arvore .ga-rfm-create'
 ];
 const areas={
  growth:[
   '#ab-acesso-legado','#ab-consultar','#btn-novo','#form-teste','.e-salvar','#ab-experiment-panel',
   '#control-tab-graph','#control-graph',
   '#control-drafts #drafts-create','#control-drafts #drafts-importar',
   '#control-drafts #drafts-arquivo','#control-drafts #drafts-native-email',
   '#control-drafts .drafts-key','#control-drafts #drafts-acesso',
   '#control-drafts #draft-editor','#control-drafts [data-draft-edit]',
   '#control-drafts [data-draft-dup]','#control-drafts [data-draft-delete]',
   '#control-drafts [data-email-replicate]',
   '#crm-segments-panel .gs-shell > header > p',
   '#crm-segments-panel [data-gs="count"]',
   '#crm-media-library-load','#crm-media .crm-media-integrated',
   '[data-crm-go="templates"]','[data-crm-open-tab="control-tab-drafts"]','#crm-campaign-open',
   '#campaign-composer .ce-import','#campaign-composer [data-ce-access-open]',
   '#campaign-composer [data-ce-access-form]','#campaign-composer [data-ce-new]',
   '#campaign-composer [data-ce-recover]','#campaign-composer [data-ce-save]',
   '#campaign-composer [data-ce-validate]','#campaign-composer [data-ce-schedule]',
   '#campaign-composer [data-ce-cancel]','#campaign-composer [data-ce-saved-audience]'
  ],
  organico:['#ol-form','.ol-arquivar'],
  influs:[
   '#i-form','#i-editor','#i-btn-novo','.cr-edit','.i-edit','.cp-salvar','.i-salvar','.nc-salvar',
   '[data-pilot-save]','[data-pilot-reconcile]','[data-link-new]','[data-candidate-edit]',
   '[data-pay-edit]','[data-map-save]','[data-cob]:not([data-cob="recarregar"])',
   '[data-pc="aprovar"]','[data-pc="recusar"]','[data-pc="encerrar"]',
   '[data-pc="envio"]','[data-pc="envio-desfaz"]','[data-pc^="confirma-"]',
   '[data-es="escopo"]','[data-es="story"]','[data-es="vincular"]','[data-es-form]',
   '#tts-acesso','.tts-ok','.tts-nao','.tts-salvar','.tts-salvar-cob','.tts-consultar'
  ]
 };
 if(!Object.hasOwn(areas,area))return '';
 const scope=embeddedOnly?'body.panel-embedded':'body';
 const always=[...common,...areas[area]].map(selector=>`${scope} ${selector}`).join(',')+'{display:none!important}';
 if(area!=='growth')return always;
 // Direct URLs and embedded panels start closed. Only the authenticated entry
 // can add this presentation class after checking both durable journals.
 const closed=audienceDraft.map(selector=>`${scope}:not(.dashboard-audience-draft-ready) ${selector}`).join(',')+'{display:none!important}';
 return always+closed;
}
function audienceDraftOperation(payload){
 if(!payload||typeof payload!=='object'||!Object.hasOwn(payload,'operation'))return undefined;
 const operation=payload.operation;
 if(operation===null)return null;
 if(!operation||typeof operation!=='object'||!['pending','uncertain','succeeded','rejected'].includes(operation.phase)
  ||!['segmento_criar','segmento_salvar','segmento_arquivar'].includes(operation.action)
  ||typeof operation.operationKey!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(operation.operationKey))return undefined;
 if(operation.phase==='succeeded'&&(![200,201].includes(operation.receiptStatus)||typeof operation.segmentId!=='string'||!Number.isSafeInteger(operation.segmentVersion)||operation.segmentVersion<1))return undefined;
 if(operation.phase==='rejected'&&(![404,409,422,503].includes(operation.receiptStatus)||typeof operation.receiptCode!=='string'||!operation.receiptCode))return undefined;
 return operation;
}
// This presentation contract never substitutes for the BFF's authorization.
function sessionBrandScope(user){
 const brands=['fish','aristo'];
 if(!user||!Array.isArray(user.brands)||new Set(user.brands).size!==user.brands.length)return null;
 if(user.role==='superadmin'&&user.brandAccess==='all'&&user.brand===null&&user.brands.length===2&&brands.every(b=>user.brands.includes(b)))return {brand:null,brands:[...brands],brandAccess:'all'};
 if(user.role==='manager'&&user.brandAccess==='single'&&brands.includes(user.brand)&&user.brands.length===1&&user.brands[0]===user.brand)return {brand:user.brand,brands:[user.brand],brandAccess:'single'};
 return null;
}
if(typeof module==='object'&&module.exports)module.exports={inviteUrlForArea,readOnlyStyles,audienceDraftOperation,sessionBrandScope};
else (function(){'use strict';
 const AREAS={growth:{label:'CRM',page:'/growth.html'},organico:{label:'Orgânico',page:'/organico.html'},influs:{label:'Influs & Afiliados',page:'/influs.html'}};
 const requested=document.body.dataset.accessPanel;
 const $=id=>document.getElementById(id);
 const loginScreen=$('entry-login'),loginForm=$('login-form'),inviteForm=$('invite-form'),bootstrapForm=$('bootstrap-form'),message=$('entry-message');
 const shell=$('entry-shell'),nav=$('entry-nav'),frameHost=$('entry-frame'),manage=$('entry-manage'),admin=$('admin-panel');
 const inviteResult=$('admin-invite-result'),inviteLink=$('admin-invite-link'),adminMessage=$('admin-message');
 const fragment=new URLSearchParams(location.hash.slice(1));
 let bootstrapToken=requested==='todos'?fragment.get('bootstrap')||'':'';
 let inviteToken=bootstrapToken?'':fragment.get('invite')||'';
 if(location.hash)history.replaceState(null,'',location.pathname+location.search);
 let session=null,frame=null,selected='',busy=false,version=0;
 const campaignButton=$('entry-campaign-open');
 const campaignUi=window.ShrigmaCampaignEdit?.createCampaignEditor({document,getSession:()=>session,storage:window.localStorage,locks:window.navigator?.locks,request:async q=>{
  const {response,data}=await request(q.path,{method:q.method,headers:q.headers,...(q.body?{body:JSON.stringify(q.body)}:{}),editReceipt:q.method==='GET',deadlineMs:q.method==='POST'?90000:20000});
  return {status:response.status,body:data};
 }});
 campaignButton?.addEventListener('click',()=>void campaignUi?.open());
 let audienceGate={state:'off'},audienceGatePromise=Promise.resolve(audienceGate),audienceConsulting=false;
 const uiKeyOk=x=>typeof x==='string'&&/^ui-[a-f0-9]{16,128}$/.test(x);
 const AUDIENCE_BRANDS={fish:'Fishermans',aristo:'O Aristocrata'};
 function clearLegacy(){
  const slots=['shrigma_k_cx','shrigma_k_growth','shrigma_k_organico','shrigma_k_influs','shrigma_k_mestre','shrigma_tpl_key','shrigma_ab_key','shrigma_influ_key','shrigma_tts_wkey'];
  for(const name of ['localStorage','sessionStorage'])for(const slot of slots)try{window[name].removeItem(slot);}catch(_){}
 }
 async function request(url,options={}){
  const {editReceipt=false,deadlineMs=60000,...fetchOptions}=options;
  const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),deadlineMs);
  try{
   const headers=new Headers(fetchOptions.headers||{});
   if(fetchOptions.body!==undefined)headers.set('Content-Type','application/json');
   if((fetchOptions.method&&fetchOptions.method!=='GET'||editReceipt)&&session?.csrf)headers.set('X-CSRF-Token',session.csrf);
   const response=await fetch(url,{...fetchOptions,headers,credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal});
   let data={};try{data=await response.json();}catch(_){}
   return {response,data};
  }finally{clearTimeout(deadline);}
 }
 const post=(url,body)=>request(url,{method:'POST',body:JSON.stringify(body)});
 async function readSession(){const {response,data}=await request('/auth/session');if(!response.ok)throw Error('session_unavailable');return data;}
 async function loadAudienceGate(currentSession){
  if(currentSession?.features?.audienceDraft!==true||currentSession.user?.permissions?.growth?.edit!==true)return {state:'off'};
  try{
   const allowedBrands=sessionBrandScope(currentSession?.user)?.brands||[];
   if(!allowedBrands.length)return {state:'unavailable'};
   const operations=await Promise.all(allowedBrands.map(async brand=>{
    const {response,data}=await request('/auth/audience-draft?brand='+brand,{editReceipt:true,deadlineMs:20000});
    if(!response.ok)throw Error('journal_unavailable');
    const operation=audienceDraftOperation(data);
    if(operation===undefined)throw Error('journal_invalid');
    return {brand,operation};
   }));
   const unresolved=operations.filter(({operation})=>['pending','uncertain'].includes(operation?.phase));
   if(unresolved.length)return {state:'pending',operations:unresolved};
   // A terminal receipt is useful only after a fresh read of the current
   // catalogue. It also prevents a stale page from presenting a new attempt.
   await Promise.all(allowedBrands.map(async brand=>{
    const query=new URLSearchParams({acao:'segmentos_listar',brand,offset:'0',limit:'50'});
    const {response,data}=await request('/api/segments?'+query,{deadlineMs:20000});
    if(!response.ok||!Array.isArray(data?.segments)||data?.catalog?.brand!==brand||data.catalog.current!==true
     ||data.capabilities?.draft!==true||data.capabilities?.send!==false)throw Error('catalog_unavailable');
   }));
   return {state:'ready'};
  }catch(_){return {state:'unavailable'};}
 }
 function showAudienceNotice(gate){
  frameHost.querySelector?.('#entry-audience-status')?.remove();
  if(selected!=='growth'||['ready','off'].includes(gate.state)){
   if(frameHost.style){frameHost.style.display='';frameHost.style.flexDirection='';}
   if(frame?.style){frame.style.flex='';frame.style.minHeight='';frame.style.height='';}
   return;
  }
  const notice=document.createElement('section');notice.id='entry-audience-status';notice.setAttribute('role','status');
  notice.style.cssText='display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 18px;background:#fff7e6;color:#65420a;border-bottom:1px solid #e1c788;font:14px system-ui,sans-serif';
  const label=document.createElement('span');notice.append(label);
  if(gate.state==='checking')label.textContent='Conferindo os públicos e tentativas anteriores…';
  else if(gate.state==='unavailable')label.textContent='A edição de públicos aguarda confirmação do diário e dos dados de origem. A leitura continua disponível.';
  else label.textContent='Há uma tentativa de público sem resultado confirmado. Consulte o mesmo registro antes de editar novamente.';
  if(gate.state==='pending')for(const {brand,operation} of gate.operations){
   const button=document.createElement('button');button.type='button';button.textContent='Consultar tentativa · '+AUDIENCE_BRANDS[brand];button.disabled=audienceConsulting;
   button.addEventListener('click',()=>void consultAudienceOperation(brand,operation.operationKey));notice.append(button);
  }
  if(gate.state==='unavailable'){
   const retry=document.createElement('button');retry.type='button';retry.textContent='Conferir novamente';
   retry.addEventListener('click',()=>{if(selected==='growth'&&session)openPanel('growth');});notice.append(retry);
  }
  frameHost.prepend(notice);
  frameHost.style.display='flex';frameHost.style.flexDirection='column';
  if(frame?.style){frame.style.flex='1 1 auto';frame.style.minHeight='0';frame.style.height='auto';}
 }
 async function consultAudienceOperation(brand,key){
  if(audienceConsulting||selected!=='growth'||!session||!sessionBrandScope(session.user)?.brands.includes(brand))return;
  const currentSession=session,currentFrame=frame;audienceConsulting=true;showAudienceNotice(audienceGate);
  try{
   const query=new URLSearchParams({acao:'segmento_operacao',brand,idempotency_key:key});
   await request('/api/segments?'+query,{editReceipt:true,deadlineMs:20000});
   const next=await loadAudienceGate(currentSession);
   if(session!==currentSession||frame!==currentFrame||selected!=='growth')return;
   audienceGate=next;
   if(next.state==='ready')openPanel('growth');else showAudienceNotice(next);
  }catch(_){if(session===currentSession&&frame===currentFrame)showAudienceNotice(audienceGate);}
  finally{audienceConsulting=false;if(session===currentSession&&frame===currentFrame)showAudienceNotice(audienceGate);}
 }
 function validSession(s){
  const u=s?.user;
  if(s?.authenticated!==true||!u||!sessionBrandScope(u)||typeof u.email!=='string'||!uiKeyOk(s.uiKey)||typeof s.csrf!=='string'||!Array.isArray(u.areas)||!u.areas.length)return false;
  if(!u.areas.every(a=>Object.hasOwn(AREAS,a))||new Set(u.areas).size!==u.areas.length)return false;
  if(requested==='todos')return u.role==='superadmin'&&Object.keys(AREAS).every(a=>u.areas.includes(a));
  return Object.hasOwn(AREAS,requested)&&u.areas.includes(requested)&&(u.role==='superadmin'||u.role==='manager'&&u.areas.length===1);
 }
 function showLogin(text=''){
  campaignUi?.close();if(campaignButton)campaignButton.hidden=true;
  version++;session=null;selected='';audienceGate={state:'off'};audienceGatePromise=Promise.resolve(audienceGate);frame?.remove();frame=null;frameHost.replaceChildren();nav.replaceChildren();nav.hidden=true;
  shell.hidden=true;loginScreen.hidden=false;admin.hidden=true;manage.hidden=true;inviteResult.hidden=true;inviteLink.value='';
  $('login-password').value='';
  loginForm.hidden=!!inviteToken||!!bootstrapToken;inviteForm.hidden=!inviteToken;bootstrapForm.hidden=!bootstrapToken;message.textContent=text;
  (bootstrapToken?$('bootstrap-email'):inviteToken?$('invite-password'):$('login-email')).focus();
 }
 function permission(area){
  return {caps:area==='growth'&&audienceGate.state==='ready'?['draft']:[],label:session.user.email};
 }
 function installReadOnlyPresentation(area){
  const doc=frame?.contentDocument;
  if(!doc?.head||doc.body?.dataset.panel!==area)return false;
  if(doc.getElementById('dashboard-operational-readonly'))return true;
  const css=readOnlyStyles(area);if(!css)return false;
  const style=doc.createElement('style');style.id='dashboard-operational-readonly';style.textContent=css;doc.head.append(style);
  return true;
 }
 // Edição aprovada no cadastro, mas a escrita individual ainda não está pronta: explicar
 // em vez de esconder em silêncio, sem prometer edição. O CRM segue em leitura.
 function showCampaignNote(area){
  if(!campaignButton)return;
  let note=document.getElementById('entry-campaign-note');
  const waiting=area==='growth'&&campaignButton.hidden&&session?.user?.role==='manager'&&session.user.permissions?.growth?.read===true&&session.user.permissions.growth.edit===true;
  if(waiting&&!note){note=document.createElement('span');note.id='entry-campaign-note';note.setAttribute('role','status');campaignButton.before(note);}
  if(!note)return;
  note.hidden=!waiting;note.textContent=waiting?'Edição de campanhas aguardando validação · CRM em leitura':'';
  note.title=waiting?'O acesso de edição foi solicitado ou aprovado, mas a escrita individual de campanhas ainda não está pronta. Nada pode ser salvo ou agendado por aqui; a leitura do CRM continua disponível.':'';
 }
 function openPanel(area){
  if(!session||!session.user.areas.includes(area)||!AREAS[area])return;
  admin.hidden=true;manage.setAttribute('aria-pressed','false');frameHost.hidden=false;selected=area;frame?.remove();
  campaignUi?.close();if(campaignButton){
   const writer=session.features?.campaignSubmitWrite===true,history=session.features?.campaignHistoryRead===true;
   campaignButton.hidden=!(area==='growth'&&(writer||history)&&session.user.role==='manager'&&session.user.areas.length===1&&session.user.permissions?.growth?.read===true&&session.user.permissions.growth.edit===true);
   campaignButton.textContent=writer?'Editar campanhas':'Consultar tentativas de campanhas';
  }
  audienceGate={state:area==='growth'&&session.features?.audienceDraft===true?'checking':'off'};
  audienceGatePromise=area==='growth'?loadAudienceGate(session):Promise.resolve(audienceGate);
  showCampaignNote(area);
  frame=document.createElement('iframe');frame.title=AREAS[area].label;frame.referrerPolicy='no-referrer';
  const target=new URL(AREAS[area].page,location.origin);target.searchParams.set('embed','1');frame.src=target.href;
  frameHost.replaceChildren(frame);showAudienceNotice(audienceGate);$('entry-area').textContent=AREAS[area].label;
  for(const button of nav.querySelectorAll('button'))button.setAttribute('aria-current',button.dataset.area===area?'page':'false');
 }
 function showShell(s){
  if(!validSession(s)){showLogin(s?.user?.brandAccess==='reprovision_required'?'Este acesso precisa ser vinculado a uma marca pelo administrador. Peça um novo acesso.':'Este acesso não está autorizado para este endereço.');return;}
  clearLegacy();bootstrapToken='';inviteToken='';session=s;loginScreen.hidden=true;shell.hidden=false;message.textContent='';$('entry-owner').textContent=s.user.email;
  $('entry-brand').textContent=s.user.brandAccess==='all'?'Visão gerencial · todas as marcas':AUDIENCE_BRANDS[s.user.brand];
  const managerial=s.user.role==='superadmin'&&requested==='todos';
  nav.replaceChildren();nav.hidden=!managerial;manage.hidden=!managerial;
  if(managerial)for(const area of s.user.areas){const button=document.createElement('button');button.type='button';button.dataset.area=area;button.textContent=AREAS[area].label;button.addEventListener('click',()=>openPanel(area));nav.append(button);}
  openPanel(requested==='todos'?s.user.areas[0]:requested);
 }
 window.addEventListener('message',async event=>{
  if(!session||!frame||event.source!==frame.contentWindow||event.origin!==location.origin)return;
  if(event.data?.type==='shrigma:session-expired'){showLogin('Sua sessão terminou. Entre novamente.');return;}
  if(event.data?.type==='shrigma:brand-read-unavailable'){
   const texts={BRAND_READ_CONTRACT_NOT_READY:'A leitura deste setor para a sua marca ainda aguarda validação. Nenhum dado de outra marca será apresentado.',BRAND_RESPONSE_UNSCOPED:'Esta leitura não confirmou o recorte da sua marca. Os dados novos não foram aplicados; peça uma revisão ao administrador.'};
   const text=Object.hasOwn(texts,event.data.code)?texts[event.data.code]:null;if(!text)return;
   let notice=frameHost.querySelector('#entry-access-status');if(!notice){notice=document.createElement('section');notice.id='entry-access-status';notice.setAttribute('role','status');frameHost.prepend(notice);}notice.textContent=text;
   frameHost.style.display='flex';frameHost.style.flexDirection='column';frame.style.flex='1 1 auto';frame.style.minHeight='0';frame.style.height='auto';return;
  }
  if(event.data?.type!=='shrigma:ready'||event.data.panel!==selected)return;
  const currentFrame=frame,currentSession=session,currentArea=selected;
  const gate=await audienceGatePromise;
  if(frame!==currentFrame||session!==currentSession||selected!==currentArea)return;
  audienceGate=gate;showAudienceNotice(gate);
  const target=new URL(AREAS[selected].page,location.origin);
  try{if(frame.contentWindow.location.pathname!==target.pathname)return;}catch(_){return;}
  if(!installReadOnlyPresentation(selected)){showLogin('A apresentação segura deste painel não pôde iniciar. Entre novamente.');return;}
  frame.contentDocument?.body?.classList.toggle('dashboard-audience-draft-ready',selected==='growth'&&gate.state==='ready');
  frame.contentWindow.postMessage({type:'shrigma:read-access',panel:selected,key:session.uiKey,permission:permission(selected)},location.origin);
 });
 loginForm.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;busy=true;const ticket=++version;
  const email=$('login-email').value.trim().toLowerCase(),password=$('login-password').value;
  message.textContent='Conferindo acesso…';loginForm.querySelector('button').disabled=true;
  try{
   const {response,data}=await post('/auth/login',{email,password});if(ticket!==version)return;
   if(!response.ok){
    message.textContent=data?.error==='BRAND_REPROVISION_REQUIRED'?'Seu acesso precisa ser vinculado a uma marca. Peça um novo acesso ao administrador.':response.status===429?'Muitas tentativas. Aguarde antes de tentar novamente.':'E-mail ou senha não conferem. Confira os dados e tente novamente.';return;
   }
   const s=await readSession();if(ticket!==version)return;showShell(s);
  }catch(_){if(ticket===version)message.textContent='Não foi possível confirmar o acesso agora. Tente novamente.';}
  finally{busy=false;loginForm.querySelector('button').disabled=false;}
 });
 inviteForm.addEventListener('submit',async event=>{
  event.preventDefault();if(busy||!inviteToken)return;
  const password=$('invite-password').value,confirm=$('invite-confirm').value;
  if(password!==confirm){message.textContent='As senhas não coincidem.';return;}
  busy=true;inviteForm.querySelector('button').disabled=true;message.textContent='Criando acesso…';
  try{
   const {response,data}=await post('/auth/invite/accept',{token:inviteToken,password});
   if(!response.ok){message.textContent=response.status===410?'Este convite expirou. Peça outro ao administrador.':'Não foi possível ativar o convite. Confira o link ou solicite outro.';return;}
   inviteToken='';$('invite-password').value='';$('invite-confirm').value='';$('login-email').value=typeof data?.user?.email==='string'?data.user.email:'';
   showLogin('Senha criada. Entre com seu e-mail corporativo.');
  }catch(_){message.textContent='Não foi possível ativar o convite agora.';}
  finally{busy=false;inviteForm.querySelector('button').disabled=false;}
 });
 bootstrapForm.addEventListener('submit',async event=>{
  event.preventDefault();if(busy||!bootstrapToken)return;
  const password=$('bootstrap-password').value,confirm=$('bootstrap-confirm').value;
  if(password!==confirm){message.textContent='As senhas não coincidem.';return;}
  busy=true;const button=bootstrapForm.querySelector('button[type=submit]');button.disabled=true;message.textContent='Ativando acesso superior…';
  try{
   const email=$('bootstrap-email').value.trim().toLowerCase();
   const {response}=await post('/auth/bootstrap/complete',{email,token:bootstrapToken,password});
   if(!response.ok)throw Error('bootstrap_failed');
   bootstrapToken='';$('bootstrap-password').value='';$('bootstrap-confirm').value='';
   $('login-email').value=email;showLogin('Acesso superior ativado. Entre com e-mail e senha.');
  }catch(_){message.textContent='Não foi possível ativar. Confira o link de ativação e tente novamente.';}
  finally{busy=false;button.disabled=false;}
 });
 $('entry-logout').addEventListener('click',async()=>{
  if(!session)return;const button=$('entry-logout');button.disabled=true;
  try{const {response}=await post('/auth/logout',{});if(!response.ok)throw Error('logout_failed');showLogin('Acesso encerrado.');}
  catch(_){adminMessage.textContent='Não foi possível encerrar a sessão. Tente novamente.';}
  finally{button.disabled=false;}
 });
 function crmAccessLabel(user){
  if(user.role!=='manager'||!Array.isArray(user.areas)||user.areas.length!==1||user.areas[0]!=='growth')return '';
  const access=user.crmAccess;if(!access||typeof access!=='object')return '';
  const renewals={queued:'renovação solicitada',prepare_uncertain:'renovação aguardando confirmação',prepared:'renovação em validação',attested:'renovação em confirmação',commit_uncertain:'renovação aguardando confirmação',committed:'renovação finalizando'};
  if(access.expired===true)return 'CRM acesso expirado'+(Object.hasOwn(renewals,access.renewalPhase)?' · '+renewals[access.renewalPhase]:'');
  if(Object.hasOwn(renewals,access.renewalPhase))return `CRM ${access.ready===true?'pronto':'acesso pendente'} · ${renewals[access.renewalPhase]}`;
  if(access.state==='ready')return access.ready===true?'CRM pronto':'CRM acesso pendente';
  const labels={awaiting_accept:'CRM aguarda aceite',provisioning:'CRM preparando acesso',revoking:'CRM revogação pendente',revoked:'CRM revogado',failed:'CRM indisponível'};
  return Object.hasOwn(labels,access.state)?labels[access.state]:'';
 }
 function userRow(user){
  const row=document.createElement('div');row.className='user-row';const info=document.createElement('div');
  const email=document.createElement('strong');email.textContent=String(user.email||'');const details=document.createElement('small');
  const areas=Array.isArray(user.areas)?user.areas.filter(a=>AREAS[a]).map(a=>AREAS[a].label).join(', '):'';
  const granted=Array.isArray(user.areas)&&user.areas.length===1&&user.permissions?.[user.areas[0]]?.edit===true;
  const writerLabels={requested:'Edição de campanhas solicitada',provisioning:'Preparando edição de campanhas',ready:'Edição de campanhas ativa',revoking:'Revogando edição de campanhas',revoked:'Edição de campanhas revogada',renewing:'Renovando edição de campanhas · leitura preservada',blocked:'Edição indisponível · confira os acessos antes de renovar'};
  // Issuer readiness is not proof that content is admitted by the BFF.
  // This content gate excludes cancellation/history, which keep their own
  // authorization contract. Absent metadata preserves the isolated legacy UI.
  const contentUnavailable=user.role==='manager'&&user.areas?.length===1&&user.areas[0]==='growth'&&user.campaignContentAccess?.available===false;
  const access=contentUnavailable&&(granted||user.requestedAccess==='edit'||user.crmWriter?.state==='ready')?'Conteúdo em leitura · criação, edição e agendamento aguardam validação':user.crmWriter&&Object.hasOwn(writerLabels,user.crmWriter.state)?writerLabels[user.crmWriter.state]:granted?'Edição ativa':user.requestedAccess==='edit'?'Somente leitura · edição solicitada':'Somente leitura';
  const state={active:'Ativo',invited:'Convite pendente',disabled:'Revogado',bootstrap:'Ativação pendente'}[user.status]||'';
  const brandLabel=user.role==='superadmin'?'Todas as marcas':user.brandAccess==='single'&&['fish','aristo'].includes(user.brand)?({fish:'Fishermans',aristo:'O Aristocrata'})[user.brand]:'Marca pendente · recrie o acesso';
  details.setAttribute('data-brand-access',user.brandAccess==='single'?'single':user.role==='superadmin'?'all':'reprovision_required');
  details.textContent=[areas,brandLabel,access,state,crmAccessLabel(user)].filter(Boolean).join(' · ');info.append(email,details);row.append(info);
  if(user.role==='manager'&&['active','invited'].includes(user.status)&&user.id){
   const brandReady=user.brandAccess==='single'&&['fish','aristo'].includes(user.brand);
   const actions=document.createElement('div');actions.className='user-row-actions';
   const label=document.createElement('label');label.textContent='Nível solicitado';
   const select=document.createElement('select');select.setAttribute('aria-label',`Nível de acesso de ${user.email}`);
   for(const [value,title] of [['read','Somente leitura'],['edit',user.crmWriter||user.crmAccess?'Edição de campanhas (pendente)':'Edição geral do painel (pendente)']]){const option=document.createElement('option');option.value=value;option.textContent=title;select.append(option);}
   const currentAccess=granted||user.requestedAccess==='edit'?'edit':'read';
   select.value=currentAccess;select.disabled=!brandReady;
   const save=document.createElement('button');save.type='button';save.textContent='Salvar';save.disabled=true;
   select.addEventListener('change',()=>{save.disabled=!brandReady||select.value===currentAccess;});
   save.addEventListener('click',()=>saveAccessRequest(user,select,save));
   const revokeButton=document.createElement('button');revokeButton.type='button';revokeButton.textContent='Revogar acesso';revokeButton.addEventListener('click',()=>revoke(user,revokeButton));
   label.append(select);actions.append(label,save);
   if(brandReady&&user.status==='active'&&user.areas?.length===1&&user.areas[0]==='growth'&&user.permissions?.growth?.read===true&&(user.permissions.growth.edit===false||user.crmWriter)&&user.crmAccess?.state==='ready'&&user.crmAccess.canRenew===true&&user.crmAccess.renewalPhase===null&&(user.crmAccess.ready===true&&user.crmAccess.expired===false||Object.hasOwn(user.crmAccess,'writerRevocationPending'))){
    const renewButton=document.createElement('button');renewButton.type='button';renewButton.textContent='Renovar acesso CRM';renewButton.setAttribute('aria-label',`Renovar acesso CRM de ${user.email}`);renewButton.addEventListener('click',()=>renewCrm(user,renewButton));actions.append(renewButton);
   }
   if(brandReady&&!contentUnavailable&&user.status==='active'&&user.crmWriter?.canRenew===true){
    const renew=document.createElement('button');renew.type='button';renew.textContent='Renovar edição de campanhas';renew.setAttribute('aria-label',`Renovar edição de campanhas de ${user.email}`);renew.addEventListener('click',()=>renewCampaignWriter(user,renew));actions.append(renew);
   }
   if(brandReady&&!contentUnavailable&&user.status==='active'&&user.requestedAccess==='edit'&&user.crmWriter?.canApprove===true&&user.crmAccess?.ready===true){
    const approve=document.createElement('button');approve.type='button';approve.textContent='Aprovar edição de campanhas';approve.setAttribute('aria-label',`Aprovar edição de campanhas de ${user.email}`);approve.addEventListener('click',()=>approveCampaignWriter(user,approve));actions.append(approve);
   }
   actions.append(revokeButton);row.append(actions);
  }
 return row;
 }
 async function approveCampaignWriter(user,button){
  if(busy||session?.user?.role!=='superadmin'||requested!=='todos'||user.crmWriter?.canApprove!==true||user.campaignContentAccess?.available===false)return;
  button.disabled=true;adminMessage.textContent='Validando acesso individual para edição de campanhas…';
  try{const {response}=await post('/auth/users',{action:'crm_writer_approve',userId:user.id});if(!response.ok)throw Error('writer_approval_failed');await loadUsers();adminMessage.textContent='Aprovação registrada. A leitura continua disponível; a edição será liberada após a validação do acesso.';}
  catch(_){try{await loadUsers();}catch(_){}adminMessage.textContent='Não foi possível aprovar. Confira o acesso de leitura e campanhas ainda pendentes.';}
  finally{button.disabled=false;}
 }
 async function renewCampaignWriter(user,button){
  if(busy||session?.user?.role!=='superadmin'||requested!=='todos'||user.crmWriter?.canRenew!==true||user.campaignContentAccess?.available===false)return;
  button.disabled=true;adminMessage.textContent='Solicitando renovação da edição de campanhas…';
  try{const {response,data}=await post('/auth/users',{action:'crm_writer_renew',userId:user.id});if(!response.ok&&!(response.status===409&&data?.error==='CRM_WRITER_RENEWAL_PENDING'))throw Error('writer_renewal_failed');await loadUsers();adminMessage.textContent='Renovação registrada. A leitura continua disponível; a edição aguarda nova validação individual.';}
  catch(_){try{await loadUsers();}catch(_){}adminMessage.textContent='Não foi possível renovar a edição. Confira a leitura e tentativas pendentes deste acesso.';}
  finally{button.disabled=false;}
 }
 async function renewCrm(user,button){
  if(busy||session?.user?.role!=='superadmin'||requested!=='todos'||user.crmAccess?.canRenew!==true)return;
  button.disabled=true;adminMessage.textContent='Solicitando renovação do acesso CRM…';
  try{
   const {response,data}=await post('/auth/users',{action:'crm_renew',userId:user.id});
   if(!response.ok&&!(response.status===409&&data?.error==='CRM_RENEWAL_PENDING'))throw Error('crm_renew_failed');
   await loadUsers();adminMessage.textContent=response.ok?(data?.state==='writer_revocation_pending'?'Edição encerrada localmente. Confira os acessos CRM; após a confirmação da revogação, solicite novamente a renovação de leitura. A edição precisará de nova aprovação.':'Renovação solicitada para leitura. Confira a fase do acesso; a confirmação ainda pode estar pendente.'):'Já há uma renovação pendente. Use “Conferir acessos CRM” para retomar a confirmação.';
  }catch(_){try{await loadUsers();}catch(_){}adminMessage.textContent='Não foi possível confirmar a solicitação. Confira a fase do acesso CRM e se ele ainda está válido.';}
  finally{button.disabled=false;}
 }
 async function saveAccessRequest(user,select,button){
  if(session?.user?.role!=='superadmin'||requested!=='todos')return;
  const requestedAccess=select.value;if(!['read','edit'].includes(requestedAccess))return;
  if(requestedAccess==='read'&&user.permissions?.[user.areas?.[0]]?.edit===true&&!window.confirm(`Retirar agora a edição de ${user.email}? A sessão atual será encerrada.`))return;
  button.disabled=true;select.disabled=true;adminMessage.textContent='Salvando nível solicitado…';
  try{
   const {response}=await post('/auth/users',{action:'access_request',userId:user.id,requestedAccess});
   if(!response.ok)throw Error('access_request_failed');
   await loadUsers();adminMessage.textContent=requestedAccess==='edit'?'Edição solicitada. O acesso continua somente leitura até a validação técnica.':'Acesso definido como somente leitura.';
  }catch(_){button.disabled=false;select.disabled=false;adminMessage.textContent='Não foi possível salvar o nível de acesso.';}
 }
 async function loadUsers(){
  const {response,data}=await request('/auth/users');if(!response.ok)throw Error('users_unavailable');
  const users=Array.isArray(data)?data:data?.users;if(!Array.isArray(users))throw Error('users_unavailable');
  $('admin-users').replaceChildren(...users.map(userRow));
  $('admin-crm-reconcile').hidden=!users.some(user=>user.role==='manager'&&(['provisioning','revoking','renewing'].includes(user.crmWriter?.state)||['provisioning','revoking'].includes(user.crmAccess?.state)||user.crmAccess?.state==='ready'&&(user.crmAccess.ready===false||typeof user.crmAccess.renewalPhase==='string')));
 }
 $('admin-crm-reconcile').addEventListener('click',async()=>{
  if(busy||session?.user?.role!=='superadmin'||requested!=='todos')return;
  const button=$('admin-crm-reconcile');button.disabled=true;adminMessage.textContent='Conferindo acessos CRM…';
  try{
   const {response}=await post('/auth/users',{action:'crm_reconcile'});if(!response.ok)throw Error('crm_reconcile_failed');
   await loadUsers();adminMessage.textContent='Conferência solicitada. Acessos ainda pendentes podem ser conferidos novamente em alguns segundos.';
  }catch(_){adminMessage.textContent='Não foi possível conferir os acessos CRM agora.';}
  finally{button.disabled=false;}
 });
 manage.addEventListener('click',async()=>{
  if(session?.user?.role!=='superadmin'||requested!=='todos')return;
  if(!admin.hidden){openPanel(selected||session.user.areas[0]);return;}
  frame?.remove();frame=null;frameHost.hidden=true;admin.hidden=false;manage.setAttribute('aria-pressed','true');
  adminMessage.textContent='Carregando gestores…';try{await loadUsers();adminMessage.textContent='';}catch(_){adminMessage.textContent='Não foi possível carregar os gestores.';}
 });
 $('admin-invite-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy||session?.user?.role!=='superadmin'||requested!=='todos')return;
  const email=$('admin-email').value.trim().toLowerCase(),area=$('admin-area').value,brand=$('admin-brand').value,requestedAccess=$('admin-access').value;
  if(!AREAS[area]||!['read','edit'].includes(requestedAccess))return;
  if(!Object.hasOwn(AUDIENCE_BRANDS,brand)){adminMessage.textContent='Escolha a marca antes de criar o acesso.';$('admin-brand').focus();return;}
  if(typeof session.areaHosts?.[area]!=='string'){
   adminMessage.textContent='Não foi possível confirmar o endereço deste painel. Atualize a página e tente novamente.';return;
  }
  busy=true;const form=$('admin-invite-form'),button=form.querySelector('button');form.setAttribute('aria-busy','true');for(const field of form.querySelectorAll('input,select,button'))field.disabled=true;
  inviteResult.hidden=true;inviteLink.value='';adminMessage.textContent='Criando convite…';
  try{
   const body={action:'invite',email,brand,role:'manager',areas:[area],permissions:{[area]:{read:true,edit:false}},requestedAccess};
   const {response,data}=await post('/auth/users',body);
   if(!response.ok)throw Error('invite_failed');
   const safeUrl=inviteUrlForArea(data?.inviteUrl,area,session.areaHosts);
   if(!safeUrl)throw Error('invite_failed');
   inviteLink.value=safeUrl;inviteResult.hidden=false;adminMessage.textContent=`Convite de leitura criado para ${AREAS[area].label} · ${AUDIENCE_BRANDS[brand]}. ${requestedAccess==='edit'?'A edição ficou solicitada e aguarda validação individual. ':''}Compartilhe o link por um canal seguro. A disponibilidade dos dados aparece no estado do acesso.`;
   $('admin-email').value='';$('admin-brand').value='';$('admin-access').value='read';await loadUsers();
  }catch(_){adminMessage.textContent='Não foi possível criar o convite. Confira os dados e tente novamente.';}
  finally{busy=false;form.setAttribute('aria-busy','false');for(const field of form.querySelectorAll('input,select,button'))field.disabled=false;}
 });
 async function revoke(user,button){
  if(session?.user?.role!=='superadmin'||requested!=='todos'||!window.confirm(`Revogar o acesso de ${user.email} ao portal? ${user.crmAccess?'A revogação do CRM será confirmada antes de um novo convite.':'Chaves individuais dos serviços de origem exigem revogação separada.'}`))return;
  button.disabled=true;adminMessage.textContent='Revogando acesso…';
  try{const {response,data}=await post('/auth/users',{action:'revoke',userId:user.id});if(!response.ok)throw Error('revoke_failed');inviteResult.hidden=true;inviteLink.value='';await loadUsers();adminMessage.textContent=data?.crmRevocationPending===true?'Acesso ao portal revogado. A confirmação da revogação no CRM está pendente.':data?.crmRevocationPending===false?'Acesso ao portal e ao CRM revogado.':'Acesso ao portal revogado. Revogue também a chave individual no serviço de origem, se existir.';}
  catch(_){adminMessage.textContent='Não foi possível revogar o acesso agora.';}
  finally{button.disabled=false;}
 }
 $('admin-copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(inviteLink.value);adminMessage.textContent='Link copiado.';}catch(_){inviteLink.select();adminMessage.textContent='Selecione e copie o link de convite.';}});
 $('admin-invite-hide').addEventListener('click',()=>{inviteLink.value='';inviteResult.hidden=true;});
 window.addEventListener('pagehide',()=>{version++;session=null;inviteToken='';bootstrapToken='';inviteLink.value='';frame?.remove();});
 (async()=>{
  // An invite is for a new identity. A cookie from another account on the
  // same team host must not consume or hide its one-time URL fragment.
  if(inviteToken||bootstrapToken){showLogin();return;}
  try{const s=await readSession();if(s?.authenticated===true)showShell(s);else showLogin();}
  catch(_){showLogin('Não foi possível consultar sua sessão agora. Você pode tentar entrar.');}
 })();
})();
