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
   if(url==='/auth/users'&&response.status===401)showLogin('Sua sessão expirou. Entre novamente para gerenciar os acessos.');
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
    const {response,data}=await request('/api/segments?'+query,{editReceipt:true,deadlineMs:20000});
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
  $('admin-users').replaceChildren();$('admin-crm-reconcile').hidden=true;
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
  // Tentativa sem confirmação guardada neste navegador (diário do editor): fica preservada e não é repetida.
  let preserved=false;
  if(waiting)try{const raw=window.localStorage.getItem('shrigma_campaign_bff_v1:'+session.uiKey+':'+session.user.brand);preserved=typeof raw==='string'&&raw.length<=300000&&['pending','uncertain'].includes(JSON.parse(raw)?.phase);}catch(_){preserved=true;}
  note.hidden=!waiting;note.textContent=!waiting?'':preserved?'Edição de campanhas aguardando validação · tentativa sem confirmação preservada, não será repetida':'Edição de campanhas aguardando validação · CRM em leitura';
  note.title=!waiting?'':preserved?'Uma tentativa de campanha ficou sem confirmação neste navegador. Ela está guardada e não será enviada de novo. Quando a edição voltar a valer, abra Campanhas para conferir o resultado antes de qualquer nova ação.':'O acesso de edição foi solicitado ou aprovado, mas a escrita individual de campanhas ainda não está pronta. Nada pode ser salvo ou agendado por aqui; a leitura do CRM continua disponível.';
 }
 function openPanel(area){
  if(!session||!session.user.areas.includes(area)||!AREAS[area])return;
  admin.hidden=true;manage.setAttribute('aria-pressed','false');frameHost.hidden=false;selected=area;frame?.remove();
  campaignUi?.close();if(campaignButton){
   const writer=session.features?.campaignSubmitWrite===true,history=session.features?.campaignHistoryRead===true;
   campaignButton.hidden=!(area==='growth'&&(writer||history)&&sessionBrandScope(session.user)&&(session.user.role==='superadmin'&&session.user.areas.length===3&&new Set(session.user.areas).size===3&&Object.keys(AREAS).every(a=>session.user.areas.includes(a))||session.user.role==='manager'&&session.user.areas.length===1)&&session.user.permissions?.growth?.read===true&&session.user.permissions.growth.edit===true);
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
 // The current Master manages its own CRM permission through the authenticated
 // endpoint. The browser never selects another identity, key or capability.
 function ownMasterRow(user){
  return typeof requested==='string'&&typeof session!=='undefined'&&requested==='todos'&&session?.authenticated===true&&session.user?.role==='superadmin'&&typeof session.user.id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(session.user.id)&&sessionBrandScope(session.user)?.brandAccess==='all'&&session.user.areas?.length===3&&new Set(session.user.areas).size===3&&Object.keys(AREAS).every(a=>session.user.areas.includes(a))&&user?.role==='superadmin'&&user.status==='active'&&user.id===session.user.id&&user.email===session.user.email;
 }
 function ownMasterCrmReady(user){
  return ownMasterRow(user)&&session.features?.campaignSubmitWrite===true&&session.user.permissions?.growth?.read===true&&session.user.permissions.growth.edit===true&&user.permissions?.growth?.read===true&&user.permissions.growth.edit===true;
 }
 async function activateOwnMasterCrm(user,button){
  if(busy||!ownMasterRow(user)||session.features?.campaignMasterActivation!==true||ownMasterCrmReady(user))return;
  const original=session,ticket=version;busy=true;button.disabled=true;adminMessage.textContent='Validando sua edição do CRM…';
  let refused=false,uncertain=false;
  try{
   try{
    const {response,data}=await post('/auth/master/campaign-writer/activate',{});
    if(ticket!==version||session!==original)return;
    if(response.status===401){showLogin('Sua sessão expirou. Entre novamente para ativar a edição do CRM.');return;}
    refused=!response.ok||data?.ok!==true||data?.ready!==true;
   }catch(_){uncertain=true;}
   if(ticket!==version||session!==original)return;
   // An unconfirmed reply is followed only by reads. No activation is replayed.
   const next=await readSession();
   if(ticket!==version||session!==original)return;
   if(!validSession(next)||next.user.id!==original.user.id||next.user.email!==original.user.email){showLogin('Sua sessão mudou. Entre novamente para conferir seu acesso ao CRM.');return;}
   session=next;await loadUsers();
   if(ticket!==version||session!==next)return;
   const ready=next.features?.campaignSubmitWrite===true&&next.user.permissions?.growth?.read===true&&next.user.permissions.growth.edit===true;
   adminMessage.textContent=ready?'Edição de campanhas no CRM confirmada. Abra CRM e use “Editar campanhas”.':uncertain?'Não foi possível confirmar a ativação. Confira os acessos antes de tentar novamente.':refused?'A edição do CRM ainda não está disponível. Seu acesso continua em leitura.':'A edição do CRM ainda aguarda confirmação. Seu acesso continua em leitura.';
  }catch(_){if(ticket===version&&session)adminMessage.textContent='Não foi possível conferir a ativação. Atualize os acessos antes de tentar novamente.';}
  finally{busy=false;button.disabled=false;}
 }
 function profileRevisionValid(user){return typeof user?.profileRevision==='string'&&/^[a-f0-9]{64}$/.test(user.profileRevision);}
 function profileEditor(row,user){
  if(!profileRevisionValid(user)||user.role!=='manager')return;
  const update=user.profileUpdate;
  if(update&&['revoking','ready','completed'].includes(update.state)){
   const note=document.createElement('div');note.className='user-profile-update';
   note.textContent=update.state==='revoking'?`Alteração para ${update.email} · ${AREAS[update.area]?.label||''} · ${AUDIENCE_BRANDS[update.brand]||''} em configuração. O acesso anterior está bloqueado; o novo convite aguarda a confirmação da revogação.`:update.state==='ready'?'Acesso anterior revogado. O novo convite está pronto para concluir a atualização.':update.inviteAvailable===true?'Cadastro atualizado. Compartilhe o novo convite para a pessoa criar a senha.':'';
   if(update.state==='ready'||update.state==='completed'&&update.inviteAvailable===true){const button=document.createElement('button');button.type='button';button.textContent='Mostrar novo convite';button.setAttribute('data-user-action','update-finish');button.addEventListener('click',()=>finishProfileUpdate(user,button));note.append(button);}
   row.append(note);
  }
  const correcting=update?.canCorrect===true&&['revoking','ready'].includes(update.state);
  if((!correcting&&!['active','invited'].includes(user.status))||user.brandAccess!=='single'||!AREAS[user.areas?.[0]])return;
  const details=document.createElement('details');details.className='user-profile-editor';const summary=document.createElement('summary');summary.textContent=correcting?'Corrigir alteração pendente':'Editar cadastro';details.append(summary);
  const form=document.createElement('form');form.className='user-profile-form';form.setAttribute('data-user-profile',user.id);
  const field=(labelText,node,name)=>{const field=document.createElement('div');field.className='admin-field';const label=document.createElement('label');label.textContent=labelText;node.name=name;node.setAttribute('data-profile-field',name);node.setAttribute('aria-label',`${labelText} de ${user.email}`);label.append(node);field.append(label);form.append(field);return node;};
  const email=field('E-mail corporativo',document.createElement('input'),'email');email.type='email';email.autocomplete='off';email.required=true;email.value=correcting?update.email:user.email;
  const area=field('Setor',document.createElement('select'),'area');for(const [value,definition]of Object.entries(AREAS)){const option=document.createElement('option');option.value=value;option.textContent=definition.label;area.append(option);}area.value=correcting?update.area:user.areas[0];
  const brand=field('Marca',document.createElement('select'),'brand');for(const [value,title]of Object.entries(AUDIENCE_BRANDS)){const option=document.createElement('option');option.value=value;option.textContent=title;brand.append(option);}brand.value=correcting?update.brand:user.brand;
  const access=field('Nível de acesso',document.createElement('select'),'access');for(const [value,title]of [['read','Leitura'],['edit','Edição']]){const option=document.createElement('option');option.value=value;option.textContent=title;access.append(option);}access.value=correcting?update.access:user.requestedAccess==='edit'||user.permissions?.[user.areas[0]]?.edit===true?'edit':'read';
  const button=document.createElement('button');button.type='submit';button.textContent='Salvar alterações';form.append(button);
  const note=document.createElement('p');note.className='admin-access-note';note.textContent=correcting?'Corrigir os dados mantém o acesso anterior bloqueado e preserva as revogações em andamento. O novo convite aguarda a confirmação da revogação.':'Alterar e-mail, setor ou marca encerra o acesso anterior e gera um novo convite após a confirmação da revogação. Alterar somente leitura/edição preserva a senha.';
  form.addEventListener('submit',event=>{event.preventDefault();void saveProfile(user,form,{email:email.value.trim().toLowerCase(),area:area.value,brand:brand.value,access:access.value});});details.append(form,note);row.append(details);
 }
 async function saveProfile(user,form,fields){
  if(busy||session?.user?.role!=='superadmin'||requested!=='todos'||!profileRevisionValid(user)||!AREAS[fields.area]||!Object.hasOwn(AUDIENCE_BRANDS,fields.brand)||!['read','edit'].includes(fields.access))return;
  const original=session,ticket=version,changed=fields.email!==user.email||fields.area!==user.areas?.[0]||fields.brand!==user.brand;
  busy=true;form.setAttribute('aria-busy','true');for(const input of form.querySelectorAll('input,select,button'))input.disabled=true;adminMessage.textContent='Salvando cadastro…';let uncertain=false;
  try{
   let response,data;try{({response,data}=await post('/auth/users',{action:'update',userId:user.id,expectedRevision:user.profileRevision,...fields}));}catch(_){uncertain=true;}
   if(ticket!==version||session!==original)return;
   if(response?.status===401){showLogin('Sua sessão expirou. Entre novamente para conferir o cadastro.');return;}
   if(response&&!response.ok){
    await refreshUsersAfterChange();if(ticket!==version||session!==original)return;
    const messages={USER_CHANGED:'O cadastro mudou. Confira os dados atualizados antes de salvar novamente.',USER_UPDATE_PENDING:'Já há uma alteração em configuração para este cadastro.',USER_EXISTS:'Este e-mail já possui outro acesso.',USER_UPDATE_CREDENTIAL_REVOCATION_REQUIRED:'A chave anterior deste setor precisa ter a revogação confirmada antes de trocar o cadastro.',CAMPAIGN_RECONCILIATION_REQUIRED:'Confira as tentativas de campanhas pendentes antes de alterar este cadastro.',AUDIENCE_RECONCILIATION_REQUIRED:'Confira a tentativa de público pendente antes de alterar este cadastro.'};
    adminMessage.textContent=messages[data?.error]||'Não foi possível salvar o cadastro. Confira o estado do acesso.';return;
   }
   const loaded=await refreshUsersAfterChange();if(ticket!==version||session!==original)return;
   inviteResult.hidden=true;inviteLink.value='';
   const confirmedMessage=uncertain?'A resposta não foi confirmada. Confira o cadastro atualizado; nenhuma alteração foi reenviada.':changed?'Alteração registrada. O acesso anterior foi bloqueado; o novo convite aparece após a confirmação da revogação.':user.crmAccess?.operational===false&&user.crmAccess?.reason==='INDIVIDUAL_ACCESS_NOT_READY'?`Solicitação de ${fields.access==='edit'?'Edição':'Leitura'} registrada; acesso individual ainda não habilitado. A senha foi preservada.`:fields.access==='edit'?'Edição configurada. O estado do acesso mostra quando a integração confirmar a edição.':'Leitura definida. A senha foi preservada.';
   adminMessage.textContent=confirmedMessage+(loaded?'':' A lista de acessos ainda não pôde ser atualizada.');
  }catch(_){if(ticket===version&&session===original)adminMessage.textContent='Não foi possível conferir o cadastro agora. Atualize os acessos antes de tentar novamente.';}
  finally{busy=false;form.setAttribute('aria-busy','false');for(const input of form.querySelectorAll('input,select,button'))input.disabled=false;}
 }
 async function finishProfileUpdate(user,button){
  if(busy||session?.user?.role!=='superadmin'||requested!=='todos'||!profileRevisionValid(user)||!user.profileUpdate||!['ready','completed'].includes(user.profileUpdate.state))return;
  const original=session,ticket=version;let response,data;busy=true;button.disabled=true;inviteResult.hidden=true;inviteLink.value='';adminMessage.textContent='Conferindo novo convite…';
  try{
   ({response,data}=await post('/auth/users',{action:'update_finish',userId:user.id,expectedRevision:user.profileRevision}));
   if(ticket!==version||session!==original)return;
   if(response.status===401){showLogin('Sua sessão expirou. Entre novamente para conferir o novo convite.');return;}
   if(!response.ok){await refreshUsersAfterChange();if(ticket!==version||session!==original)return;adminMessage.textContent=response.status===409?'A configuração ainda não foi confirmada. Confira os acessos e tente novamente depois.':'Não foi possível obter o novo convite. Confira o estado do cadastro.';return;}
   const url=inviteUrlForArea(data?.inviteUrl,user.profileUpdate.area,session.areaHosts);if(!url)throw Error('invite_failed');
   inviteLink.value=url;inviteResult.hidden=false;const loaded=await refreshUsersAfterChange();if(ticket!==version||session!==original){inviteResult.hidden=true;inviteLink.value='';return;}
   adminMessage.textContent='Cadastro atualizado. Compartilhe o novo convite para a pessoa criar a senha. A edição depende da confirmação mostrada no estado do acesso.'+(loaded?'':' A lista de acessos ainda não pôde ser atualizada; o link recebido continua disponível.');
  }catch(_){if(ticket===version&&session===original){await refreshUsersAfterChange();if(ticket!==version||session!==original)return;adminMessage.textContent='A resposta do convite não foi confirmada. Confira o cadastro; o mesmo convite pode ser recuperado sem repetir a alteração.';}}
  finally{busy=false;button.disabled=false;}
 }
 function userRow(user){
  const row=document.createElement('div');row.className='user-row';const info=document.createElement('div');
  const email=document.createElement('strong');email.textContent=String(user.email||'');const details=document.createElement('small');
  const areas=Array.isArray(user.areas)?user.areas.filter(a=>AREAS[a]).map(a=>AREAS[a].label).join(', '):'';
  const granted=Array.isArray(user.areas)&&user.areas.length===1&&user.permissions?.[user.areas[0]]?.edit===true;
  const writerLabels={requested:'Edição configurada · aguardando preparo',provisioning:'Preparando edição de campanhas',ready:'Edição de campanhas ativa',revoking:'Revogando edição de campanhas',revoked:'Edição de campanhas revogada',renewing:'Renovando edição de campanhas · leitura preservada',blocked:'Edição indisponível · confira os acessos antes de renovar'};
  // Issuer readiness is not proof that content is admitted by the BFF.
  // This content gate excludes cancellation/history, which keep their own
  // authorization contract. Absent metadata preserves the isolated legacy UI.
  const contentUnavailable=user.role==='manager'&&user.areas?.length===1&&user.areas[0]==='growth'&&(user.campaignContentAccess?.available===false||user.campaignContentAccess?.writeReady===false&&(granted||user.crmWriter?.state==='ready'));
  const individualUnavailable=user.role==='manager'&&user.crmAccess?.operational===false&&user.crmAccess?.reason==='INDIVIDUAL_ACCESS_NOT_READY';
  const access=ownMasterRow(user)?(ownMasterCrmReady(user)?'CRM · edição de campanhas ativa':'CRM · somente leitura'):individualUnavailable?'Cadastro preservado · acesso individual ainda não habilitado':contentUnavailable&&(granted||user.requestedAccess==='edit'||user.crmWriter?.state==='ready')?'Conteúdo em leitura · criação, edição e agendamento aguardam validação':user.crmWriter&&Object.hasOwn(writerLabels,user.crmWriter.state)?writerLabels[user.crmWriter.state]:granted?'Edição ativa':user.requestedAccess==='edit'?'Edição configurada · aguardando confirmação':'Somente leitura';
  const state=individualUnavailable&&user.status==='active'?'Cadastro ativo':{active:'Ativo',invited:'Convite pendente',disabled:'Revogado',bootstrap:'Ativação pendente'}[user.status]||'';
  const brandLabel=user.role==='superadmin'?'Todas as marcas':user.brandAccess==='single'&&['fish','aristo'].includes(user.brand)?({fish:'Fishermans',aristo:'O Aristocrata'})[user.brand]:'Marca pendente · recrie o acesso';
  details.setAttribute('data-brand-access',user.brandAccess==='single'?'single':user.role==='superadmin'?'all':'reprovision_required');
  details.textContent=[areas,brandLabel,access,state,crmAccessLabel(user)].filter(Boolean).join(' · ');info.append(email,details);row.append(info);
  if(ownMasterRow(user)&&session.features?.campaignMasterActivation===true&&!ownMasterCrmReady(user)&&session.user.permissions?.growth?.read===true){
   const actions=document.createElement('div');actions.className='user-row-actions';
   const activate=document.createElement('button');activate.type='button';activate.id='admin-master-crm-activate';activate.textContent='Ativar edição do CRM';activate.addEventListener('click',()=>activateOwnMasterCrm(user,activate));actions.append(activate);row.append(actions);
  }
  if(user.role==='manager'&&['active','invited'].includes(user.status)&&user.id){
   const brandReady=user.brandAccess==='single'&&['fish','aristo'].includes(user.brand);
   const actions=document.createElement('div');actions.className='user-row-actions';
   const label=document.createElement('label');label.textContent='Nível de acesso';
   const select=document.createElement('select');select.setAttribute('aria-label',`Nível de acesso de ${user.email}`);
   for(const [value,title] of [['read','Leitura'],['edit','Edição']]){const option=document.createElement('option');option.value=value;option.textContent=title;select.append(option);}
   const currentAccess=granted||user.requestedAccess==='edit'?'edit':'read';
   select.value=currentAccess;select.disabled=!brandReady;
   const save=document.createElement('button');save.type='button';save.textContent='Salvar';save.disabled=true;
   select.addEventListener('change',()=>{save.disabled=!brandReady||select.value===currentAccess;});
   save.addEventListener('click',()=>saveAccessRequest(user,select,save));
   const revokeButton=document.createElement('button');revokeButton.type='button';revokeButton.textContent='Revogar acesso';revokeButton.addEventListener('click',()=>revoke(user,revokeButton));
   label.append(select);if(!profileRevisionValid(user))actions.append(label,save);
   if(brandReady&&user.status==='active'&&user.areas?.length===1&&user.areas[0]==='growth'&&user.permissions?.growth?.read===true&&(user.permissions.growth.edit===false||user.crmWriter)&&user.crmAccess?.state==='ready'&&user.crmAccess.canRenew===true&&user.crmAccess.renewalPhase===null&&(user.crmAccess.ready===true&&user.crmAccess.expired===false||Object.hasOwn(user.crmAccess,'writerRevocationPending'))){
    const renewButton=document.createElement('button');renewButton.type='button';renewButton.textContent='Renovar acesso CRM';renewButton.setAttribute('aria-label',`Renovar acesso CRM de ${user.email}`);renewButton.addEventListener('click',()=>renewCrm(user,renewButton));actions.append(renewButton);
   }
   if(brandReady&&!contentUnavailable&&user.status==='active'&&user.crmWriter?.canRenew===true){
    const renew=document.createElement('button');renew.type='button';renew.textContent='Renovar edição de campanhas';renew.setAttribute('aria-label',`Renovar edição de campanhas de ${user.email}`);renew.addEventListener('click',()=>renewCampaignWriter(user,renew));actions.append(renew);
   }
   if(!profileRevisionValid(user)&&brandReady&&!contentUnavailable&&user.status==='active'&&user.requestedAccess==='edit'&&user.crmWriter?.canApprove===true&&user.crmAccess?.ready===true){
    const approve=document.createElement('button');approve.type='button';approve.textContent='Aprovar edição de campanhas';approve.setAttribute('aria-label',`Aprovar edição de campanhas de ${user.email}`);approve.addEventListener('click',()=>approveCampaignWriter(user,approve));actions.append(approve);
   }
   actions.append(revokeButton);row.append(actions);
  }
 if(typeof profileEditor==='function')profileEditor(row,user);return row;
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
  if(busy||session?.user?.role!=='superadmin'||requested!=='todos')return;
  const requestedAccess=select.value;if(!['read','edit'].includes(requestedAccess))return;
  if(requestedAccess==='read'&&user.permissions?.[user.areas?.[0]]?.edit===true&&!window.confirm(`Retirar agora a edição de ${user.email}? A sessão atual será encerrada.`))return;
  const original=session,ticket=version;let response;busy=true;button.disabled=true;select.disabled=true;adminMessage.textContent='Salvando nível de acesso…';
  try{
   ({response}=await post('/auth/users',{action:'access_request',userId:user.id,requestedAccess}));if(ticket!==version||session!==original)return;
   if(!response.ok)throw Error('access_request_failed');
   const loaded=await refreshUsersAfterChange();if(ticket!==version||session!==original)return;
   const confirmedMessage=user.crmAccess?.operational===false&&user.crmAccess?.reason==='INDIVIDUAL_ACCESS_NOT_READY'?`Solicitação de ${requestedAccess==='edit'?'Edição':'Leitura'} registrada; acesso individual ainda não habilitado.`:requestedAccess==='edit'?'Edição configurada. O estado do acesso mostra quando a integração confirmar a edição.':'Acesso definido como somente leitura.';
   adminMessage.textContent=confirmedMessage+(loaded?'':' A lista de acessos ainda não pôde ser atualizada.');
  }catch(_){if(ticket!==version||session!==original)return;await refreshUsersAfterChange();if(ticket!==version||session!==original)return;adminMessage.textContent=!response||response.ok||response.status>=500?'A resposta da alteração não foi confirmada. Confira o estado na lista de acessos; nenhuma alteração foi reenviada.':'O nível de acesso foi recusado. Confira o estado do cadastro.';}
  finally{busy=false;button.disabled=false;select.disabled=false;}
 }
 async function loadUsers(){
  const original=session,ticket=version;
  const {response,data}=await request('/auth/users',{editReceipt:true});if(!response.ok)throw Error('users_unavailable');
  if(ticket!==version||session!==original)return;
  const users=Array.isArray(data)?data:data?.users;if(!Array.isArray(users))throw Error('users_unavailable');
  $('admin-users').replaceChildren(...users.map(userRow));
  $('admin-crm-reconcile').hidden=!users.some(user=>user.role==='manager'&&(user.profileUpdate?.state==='revoking'||['provisioning','revoking','renewing'].includes(user.crmWriter?.state)||['provisioning','revoking'].includes(user.crmAccess?.state)||user.crmAccess?.state==='ready'&&(user.crmAccess.ready===false||typeof user.crmAccess.renewalPhase==='string')));
 }
 async function refreshUsersAfterChange(){
  const original=session,ticket=version;
  try{await loadUsers();return ticket===version&&session===original;}
  catch(_){
   if(ticket!==version||session!==original||session?.user?.role!=='superadmin'||requested!=='todos')return false;
   const notice=document.createElement('p');notice.setAttribute('role','status');notice.textContent='A lista de acessos está indisponível. Consulte novamente antes de alterar outro cadastro.';
   const retry=document.createElement('button');retry.type='button';retry.id='admin-users-refresh';retry.textContent='Atualizar lista';
   retry.addEventListener('click',async()=>{
    if(busy||session?.user?.role!=='superadmin'||requested!=='todos')return;
    const original=session,ticket=version;busy=true;retry.disabled=true;
    try{const loaded=await refreshUsersAfterChange();if(ticket===version&&session===original)adminMessage.textContent=loaded?'Lista de acessos atualizada. Confira o estado de cada cadastro.':'A lista de acessos continua indisponível. Nenhuma alteração foi reenviada.';}
    finally{busy=false;retry.disabled=false;}
   });
   $('admin-users').replaceChildren(notice,retry);$('admin-crm-reconcile').hidden=true;return false;
  }
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
  const original=session,ticket=version;let response,data;
  busy=true;const form=$('admin-invite-form'),button=form.querySelector('button');form.setAttribute('aria-busy','true');for(const field of form.querySelectorAll('input,select,button'))field.disabled=true;
  inviteResult.hidden=true;inviteLink.value='';adminMessage.textContent='Criando convite…';
  try{
   const body={action:'invite',email,brand,role:'manager',areas:[area],permissions:{[area]:{read:true,edit:false}},requestedAccess};
   ({response,data}=await post('/auth/users',body));
   if(ticket!==version||session!==original)return;
   if(!response.ok)throw Error('invite_failed');
   const safeUrl=inviteUrlForArea(data?.inviteUrl,area,session.areaHosts);
   if(!safeUrl)throw Error('invite_failed');
   inviteLink.value=safeUrl;inviteResult.hidden=false;adminMessage.textContent=area==='growth'&&session.features?.crmIndividualAccessUnavailable===true?`Convite criado para ${AREAS[area].label} · ${AUDIENCE_BRANDS[brand]}. Solicitação de ${requestedAccess==='edit'?'Edição':'Leitura'} registrada; acesso individual ainda não habilitado. Compartilhe o link por um canal seguro.`:`Convite com ${requestedAccess==='edit'?'Edição':'Leitura'} criado para ${AREAS[area].label} · ${AUDIENCE_BRANDS[brand]}. ${requestedAccess==='edit'?'A configuração da edição acontece após o aceite; confira o estado do acesso. ':''}Compartilhe o link por um canal seguro.`;
   $('admin-email').value='';$('admin-brand').value='';$('admin-access').value='read';
   const confirmedMessage=adminMessage.textContent,loaded=await refreshUsersAfterChange();
   if(ticket===version&&session===original)adminMessage.textContent=confirmedMessage+(loaded?'':' A lista de acessos ainda não pôde ser atualizada; o link recebido continua disponível.');
  }catch(_){
   if(ticket!==version||session!==original)return;
   const uncertain=!response||response.ok||response.status>=500;
   await refreshUsersAfterChange();if(ticket!==version||session!==original)return;
   adminMessage.textContent=uncertain?'A resposta do convite não foi confirmada. Confira a lista de acessos; o convite não foi reenviado.':data?.error==='USER_EXISTS'?'Este e-mail já possui um cadastro. Confira o acesso existente antes de criar outro convite.':'O convite foi recusado. Confira os dados e o estado do cadastro.';
  }
  finally{busy=false;form.setAttribute('aria-busy','false');for(const field of form.querySelectorAll('input,select,button'))field.disabled=false;}
 });
 async function revoke(user,button){
  if(busy||session?.user?.role!=='superadmin'||requested!=='todos'||!window.confirm(`Revogar o acesso de ${user.email} ao portal? ${user.crmAccess&&user.crmAccess.operational!==false?'A revogação do CRM será confirmada antes de um novo convite.':'Chaves individuais dos serviços de origem exigem revogação separada.'}`))return;
  const original=session,ticket=version;let response,data;busy=true;button.disabled=true;adminMessage.textContent='Revogando acesso…';
  try{
   ({response,data}=await post('/auth/users',{action:'revoke',userId:user.id}));if(ticket!==version||session!==original)return;if(!response.ok)throw Error('revoke_failed');
   inviteResult.hidden=true;inviteLink.value='';
   const loaded=await refreshUsersAfterChange();if(ticket!==version||session!==original)return;
   const confirmedMessage=data?.crmRevocationPending===true?'Acesso ao portal revogado. A confirmação da revogação no CRM está pendente.':data?.crmRevocationPending===false?'Acesso ao portal e ao CRM revogado.':'Acesso ao portal revogado. Revogue também a chave individual no serviço de origem, se existir.';
   adminMessage.textContent=confirmedMessage+(loaded?'':' A lista de acessos ainda não pôde ser atualizada.');
  }catch(_){
   if(ticket!==version||session!==original)return;
   const uncertain=!response||response.ok||response.status>=500;
   await refreshUsersAfterChange();if(ticket!==version||session!==original)return;
   adminMessage.textContent=uncertain?'A resposta da revogação não foi confirmada. Confira o estado na lista de acessos; nenhuma revogação foi reenviada.':'A revogação foi recusada. Confira o estado do cadastro.';
  }
  finally{busy=false;button.disabled=false;}
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
