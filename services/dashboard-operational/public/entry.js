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
if(typeof module==='object'&&module.exports)module.exports={inviteUrlForArea,readOnlyStyles,audienceDraftOperation};
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
   const operations=await Promise.all(Object.keys(AUDIENCE_BRANDS).map(async brand=>{
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
   await Promise.all(Object.keys(AUDIENCE_BRANDS).map(async brand=>{
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
  if(audienceConsulting||selected!=='growth'||!session||!Object.hasOwn(AUDIENCE_BRANDS,brand))return;
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
  if(s?.authenticated!==true||!u||typeof u.email!=='string'||!uiKeyOk(s.uiKey)||typeof s.csrf!=='string'||!Array.isArray(u.areas)||!u.areas.length)return false;
  if(!u.areas.every(a=>Object.hasOwn(AREAS,a))||new Set(u.areas).size!==u.areas.length)return false;
  if(requested==='todos')return u.role==='superadmin'&&Object.keys(AREAS).every(a=>u.areas.includes(a));
  return Object.hasOwn(AREAS,requested)&&u.areas.includes(requested)&&(u.role==='superadmin'||u.role==='manager'&&u.areas.length===1);
 }
 function showLogin(text=''){
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
 function openPanel(area){
  if(!session||!session.user.areas.includes(area)||!AREAS[area])return;
  admin.hidden=true;manage.setAttribute('aria-pressed','false');frameHost.hidden=false;selected=area;frame?.remove();
  audienceGate={state:area==='growth'&&session.features?.audienceDraft===true?'checking':'off'};
  audienceGatePromise=area==='growth'?loadAudienceGate(session):Promise.resolve(audienceGate);
  frame=document.createElement('iframe');frame.title=AREAS[area].label;frame.referrerPolicy='no-referrer';
  const target=new URL(AREAS[area].page,location.origin);target.searchParams.set('embed','1');frame.src=target.href;
  frameHost.replaceChildren(frame);showAudienceNotice(audienceGate);$('entry-area').textContent=AREAS[area].label;
  for(const button of nav.querySelectorAll('button'))button.setAttribute('aria-current',button.dataset.area===area?'page':'false');
 }
 function showShell(s){
  if(!validSession(s)){showLogin('Este acesso não está autorizado para este endereço.');return;}
  clearLegacy();bootstrapToken='';inviteToken='';session=s;loginScreen.hidden=true;shell.hidden=false;message.textContent='';$('entry-owner').textContent=s.user.email;
  const managerial=s.user.role==='superadmin'&&requested==='todos';
  nav.replaceChildren();nav.hidden=!managerial;manage.hidden=!managerial;
  if(managerial)for(const area of s.user.areas){const button=document.createElement('button');button.type='button';button.dataset.area=area;button.textContent=AREAS[area].label;button.addEventListener('click',()=>openPanel(area));nav.append(button);}
  openPanel(requested==='todos'?s.user.areas[0]:requested);
 }
 window.addEventListener('message',async event=>{
  if(!session||!frame||event.source!==frame.contentWindow||event.origin!==location.origin)return;
  if(event.data?.type==='shrigma:session-expired'){showLogin('Sua sessão terminou. Entre novamente.');return;}
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
   const {response}=await post('/auth/login',{email,password});if(ticket!==version)return;
   if(!response.ok){
    message.textContent=response.status===429?'Muitas tentativas. Aguarde antes de tentar novamente.':'E-mail ou senha não conferem. Confira os dados e tente novamente.';return;
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
 function userRow(user){
  const row=document.createElement('div');row.className='user-row';const info=document.createElement('div');
  const email=document.createElement('strong');email.textContent=String(user.email||'');const details=document.createElement('small');
  const areas=Array.isArray(user.areas)?user.areas.filter(a=>AREAS[a]).map(a=>AREAS[a].label).join(', '):'';
  const granted=Array.isArray(user.areas)&&user.areas.length===1&&user.permissions?.[user.areas[0]]?.edit===true;
  const access=granted?'Edição ativa':user.requestedAccess==='edit'?'Somente leitura · edição solicitada':'Somente leitura';
  const state={active:'Ativo',invited:'Convite pendente',disabled:'Revogado',bootstrap:'Ativação pendente'}[user.status]||'';
  details.textContent=[areas,access,state].filter(Boolean).join(' · ');info.append(email,details);row.append(info);
  if(user.role==='manager'&&['active','invited'].includes(user.status)&&user.id){
   const actions=document.createElement('div');actions.className='user-row-actions';
   const label=document.createElement('label');label.textContent='Nível solicitado';
   const select=document.createElement('select');select.setAttribute('aria-label',`Nível de acesso de ${user.email}`);
   for(const [value,title] of [['read','Somente leitura'],['edit','Edição geral do painel (pendente)']]){const option=document.createElement('option');option.value=value;option.textContent=title;select.append(option);}
   const currentAccess=granted||user.requestedAccess==='edit'?'edit':'read';
   select.value=currentAccess;
   const save=document.createElement('button');save.type='button';save.textContent='Salvar';save.disabled=true;
   select.addEventListener('change',()=>{save.disabled=select.value===currentAccess;});
   save.addEventListener('click',()=>saveAccessRequest(user,select,save));
   const revokeButton=document.createElement('button');revokeButton.type='button';revokeButton.textContent='Revogar acesso';revokeButton.addEventListener('click',()=>revoke(user,revokeButton));
   label.append(select);actions.append(label,save,revokeButton);row.append(actions);
  }
  return row;
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
 }
 manage.addEventListener('click',async()=>{
  if(session?.user?.role!=='superadmin'||requested!=='todos')return;
  if(!admin.hidden){openPanel(selected||session.user.areas[0]);return;}
  frame?.remove();frame=null;frameHost.hidden=true;admin.hidden=false;manage.setAttribute('aria-pressed','true');
  adminMessage.textContent='Carregando gestores…';try{await loadUsers();adminMessage.textContent='';}catch(_){adminMessage.textContent='Não foi possível carregar os gestores.';}
 });
 $('admin-invite-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy||session?.user?.role!=='superadmin'||requested!=='todos')return;
  const email=$('admin-email').value.trim().toLowerCase(),area=$('admin-area').value,requestedAccess=$('admin-access').value;
  if(!AREAS[area]||!['read','edit'].includes(requestedAccess))return;
  if(typeof session.areaHosts?.[area]!=='string'){
   adminMessage.textContent='Não foi possível confirmar o endereço deste painel. Atualize a página e tente novamente.';return;
  }
  busy=true;const button=$('admin-invite-form').querySelector('button');button.disabled=true;
  inviteResult.hidden=true;inviteLink.value='';adminMessage.textContent='Criando convite…';
  try{
   const body={action:'invite',email,role:'manager',areas:[area],permissions:{[area]:{read:true,edit:false}},requestedAccess};
   const {response,data}=await post('/auth/users',body);
   if(!response.ok)throw Error('invite_failed');
   const safeUrl=inviteUrlForArea(data?.inviteUrl,area,session.areaHosts);
   if(!safeUrl)throw Error('invite_failed');
   inviteLink.value=safeUrl;inviteResult.hidden=false;adminMessage.textContent=requestedAccess==='edit'?'Convite criado em somente leitura. O pedido de edição ficou pendente de validação; compartilhe o link por um canal seguro.':'Convite de leitura criado. Compartilhe o link por um canal seguro com a pessoa indicada.';
   $('admin-email').value='';$('admin-access').value='read';await loadUsers();
  }catch(_){adminMessage.textContent='Não foi possível criar o convite. Confira os dados e tente novamente.';}
  finally{busy=false;button.disabled=false;}
 });
 async function revoke(user,button){
  if(session?.user?.role!=='superadmin'||requested!=='todos'||!window.confirm(`Revogar o acesso de ${user.email} ao portal? Chaves individuais dos serviços de origem exigem revogação separada.`))return;
  button.disabled=true;adminMessage.textContent='Revogando acesso…';
  try{const {response}=await post('/auth/users',{action:'revoke',userId:user.id});if(!response.ok)throw Error('revoke_failed');inviteResult.hidden=true;inviteLink.value='';await loadUsers();adminMessage.textContent='Acesso ao portal revogado. Revogue também a chave individual no serviço de origem, se existir.';}
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
