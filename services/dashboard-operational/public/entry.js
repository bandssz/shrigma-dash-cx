/* Same-origin entry. The cookie session, not anything in this file, grants access. */
function inviteUrlForArea(raw,area){
 const hosts={
  growth:['crm.shrigma.com.br','dashboard-op-crm.tazdb8.easypanel.host','dashboard-v4-crm.tazdb8.easypanel.host','dashboard-v5-crm.tazdb8.easypanel.host','dashboard-v6-crm.tazdb8.easypanel.host','dashboard-v7-crm.tazdb8.easypanel.host','dashboard-v8-crm.tazdb8.easypanel.host','dashboard-v9-crm.tazdb8.easypanel.host','dashboard-v10-crm.tazdb8.easypanel.host','dashboard-v11-crm.tazdb8.easypanel.host'],
  organico:['organico.shrigma.com.br','dashboard-op-organico.tazdb8.easypanel.host','dashboard-v4-organico.tazdb8.easypanel.host','dashboard-v5-organico.tazdb8.easypanel.host','dashboard-v6-organico.tazdb8.easypanel.host','dashboard-v7-organico.tazdb8.easypanel.host','dashboard-v8-organico.tazdb8.easypanel.host','dashboard-v9-organico.tazdb8.easypanel.host','dashboard-v10-organico.tazdb8.easypanel.host','dashboard-v11-organico.tazdb8.easypanel.host'],
  influs:['influs.shrigma.com.br','dashboard-op-influs.tazdb8.easypanel.host','dashboard-v4-influs.tazdb8.easypanel.host','dashboard-v5-influs.tazdb8.easypanel.host','dashboard-v6-influs.tazdb8.easypanel.host','dashboard-v7-influs.tazdb8.easypanel.host','dashboard-v8-influs.tazdb8.easypanel.host','dashboard-v9-influs.tazdb8.easypanel.host','dashboard-v10-influs.tazdb8.easypanel.host','dashboard-v11-influs.tazdb8.easypanel.host']
 };
 if(!Object.hasOwn(hosts,area))return null;
 let url;try{url=new URL(raw);}catch(_){return null;}
 if(url.protocol!=='https:'||url.port||url.username||url.password||url.pathname!=='/'||url.search||!/^#invite=[A-Za-z0-9_-]{16,256}$/.test(url.hash)||!hosts[area].includes(url.hostname))return null;
 return url.href;
}
// Presentation only: the BFF still validates every operation on the server.
// The build can reuse the unscoped version for direct panel URLs, without
// changing the legacy source pages or the separate CX dashboard.
function readOnlyStyles(area,{embeddedOnly=true}={}){
 const common=['#growth-acesso','#organico-acesso-bar','#organico-acesso','#influ-access'];
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
   '#crm-segments-panel [data-gs="new"]','#crm-segments-panel [data-gs-fields]',
   '#crm-segments-panel [data-gs="save"]','#crm-segments-panel [data-gs="count"]',
   '#crm-segments-panel [data-gs="archive"]','#crm-segments-panel [data-gs-dialog]',
   '#crm-audience-create','#crm-audience-brand-choices',
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
 return [...common,...areas[area]].map(selector=>`${scope} ${selector}`).join(',')+'{display:none!important}';
}
if(typeof module==='object'&&module.exports)module.exports={inviteUrlForArea,readOnlyStyles};
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
 const uiKeyOk=x=>typeof x==='string'&&/^ui-[a-f0-9]{16,128}$/.test(x);
 function clearLegacy(){
  const slots=['shrigma_k_cx','shrigma_k_growth','shrigma_k_organico','shrigma_k_influs','shrigma_k_mestre','shrigma_tpl_key','shrigma_ab_key','shrigma_influ_key','shrigma_tts_wkey'];
  for(const name of ['localStorage','sessionStorage'])for(const slot of slots)try{window[name].removeItem(slot);}catch(_){}
 }
 async function request(url,options={}){
  const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),60000);
  try{
   const headers=new Headers(options.headers||{});
   if(options.body!==undefined)headers.set('Content-Type','application/json');
   if(options.method&&options.method!=='GET'&&session?.csrf)headers.set('X-CSRF-Token',session.csrf);
   const response=await fetch(url,{...options,headers,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
   let data={};try{data=await response.json();}catch(_){}
   return {response,data};
  }finally{clearTimeout(deadline);}
 }
 const post=(url,body)=>request(url,{method:'POST',body:JSON.stringify(body)});
 async function readSession(){const {response,data}=await request('/auth/session');if(!response.ok)throw Error('session_unavailable');return data;}
 function validSession(s){
  const u=s?.user;
  if(s?.authenticated!==true||!u||typeof u.email!=='string'||!uiKeyOk(s.uiKey)||typeof s.csrf!=='string'||!Array.isArray(u.areas)||!u.areas.length)return false;
  if(!u.areas.every(a=>Object.hasOwn(AREAS,a))||new Set(u.areas).size!==u.areas.length)return false;
  if(requested==='todos')return u.role==='superadmin'&&Object.keys(AREAS).every(a=>u.areas.includes(a));
  return Object.hasOwn(AREAS,requested)&&u.areas.includes(requested)&&(u.role==='superadmin'||u.role==='manager'&&u.areas.length===1);
 }
 function showLogin(text=''){
  version++;session=null;selected='';frame?.remove();frame=null;frameHost.replaceChildren();nav.replaceChildren();nav.hidden=true;
  shell.hidden=true;loginScreen.hidden=false;admin.hidden=true;manage.hidden=true;inviteResult.hidden=true;inviteLink.value='';
  $('login-password').value='';$('login-totp').value='';$('totp-group').hidden=requested!=='todos';$('login-totp').required=requested==='todos';
  loginForm.hidden=!!inviteToken||!!bootstrapToken;inviteForm.hidden=!inviteToken;bootstrapForm.hidden=!bootstrapToken;message.textContent=text;
  (bootstrapToken?$('bootstrap-email'):inviteToken?$('invite-password'):$('login-email')).focus();
 }
 function permission(area){
  return {caps:[],label:session.user.email};
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
  frame=document.createElement('iframe');frame.title=AREAS[area].label;frame.referrerPolicy='no-referrer';
  const target=new URL(AREAS[area].page,location.origin);target.searchParams.set('embed','1');frame.src=target.href;
  frameHost.replaceChildren(frame);$('entry-area').textContent=AREAS[area].label;
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
 window.addEventListener('message',event=>{
  if(!session||!frame||event.source!==frame.contentWindow||event.origin!==location.origin)return;
  if(event.data?.type==='shrigma:session-expired'){showLogin('Sua sessão terminou. Entre novamente.');return;}
  if(event.data?.type!=='shrigma:ready'||event.data.panel!==selected)return;
  const target=new URL(AREAS[selected].page,location.origin);
  try{if(frame.contentWindow.location.pathname!==target.pathname)return;}catch(_){return;}
  if(!installReadOnlyPresentation(selected)){showLogin('A apresentação segura deste painel não pôde iniciar. Entre novamente.');return;}
  frame.contentWindow.postMessage({type:'shrigma:read-access',panel:selected,key:session.uiKey,permission:permission(selected)},location.origin);
 });
 loginForm.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;busy=true;const ticket=++version;
  const email=$('login-email').value.trim().toLowerCase(),password=$('login-password').value,totp=$('login-totp').value.trim();
  message.textContent='Conferindo acesso…';loginForm.querySelector('button').disabled=true;
  try{
   const {response,data}=await post('/auth/login',{email,password,...(totp?{totp}:{})});if(ticket!==version)return;
   if(!response.ok){
    if(data?.error==='mfa_required'||data?.code==='mfa_required'||data?.mfa_required===true){$('totp-group').hidden=false;message.textContent='Informe o código de verificação da sua conta.';$('login-totp').focus();return;}
    message.textContent=response.status===429?'Muitas tentativas. Aguarde antes de tentar novamente.':'E-mail, senha ou código não confirmados.';return;
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
 $('bootstrap-begin').addEventListener('click',async()=>{
  if(busy||!bootstrapToken||!$('bootstrap-email').reportValidity())return;
  const email=$('bootstrap-email').value.trim().toLowerCase();busy=true;$('bootstrap-begin').disabled=true;message.textContent='Preparando verificação…';
  try{
   const {response,data}=await post('/auth/bootstrap/begin',{email,token:bootstrapToken});
   if(!response.ok||typeof data?.totpSecret!=='string'||!data.totpSecret)throw Error('bootstrap_failed');
   $('bootstrap-secret').value=data.totpSecret;$('bootstrap-verify').hidden=false;message.textContent='Configure a chave no aplicativo autenticador e informe o código.';
  }catch(_){message.textContent='Não foi possível iniciar o acesso superior. Confira o convite inicial.';}
  finally{busy=false;$('bootstrap-begin').disabled=false;}
 });
 bootstrapForm.addEventListener('submit',async event=>{
  event.preventDefault();if(busy||!bootstrapToken||$('bootstrap-verify').hidden)return;
  const password=$('bootstrap-password').value,confirm=$('bootstrap-confirm').value;
  if(password!==confirm){message.textContent='As senhas não coincidem.';return;}
  busy=true;const button=bootstrapForm.querySelector('button[type=submit]');button.disabled=true;message.textContent='Ativando acesso superior…';
  try{
   const email=$('bootstrap-email').value.trim().toLowerCase(),totp=$('bootstrap-totp').value.trim();
   const {response}=await post('/auth/bootstrap/complete',{email,token:bootstrapToken,password,totp});
   if(!response.ok)throw Error('bootstrap_failed');
   bootstrapToken='';$('bootstrap-secret').value='';$('bootstrap-password').value='';$('bootstrap-confirm').value='';$('bootstrap-totp').value='';
   $('login-email').value=email;showLogin('Acesso superior ativado. Entre com senha e código do aplicativo.');
  }catch(_){message.textContent='Não foi possível ativar. Confira o código e tente novamente.';}
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
  busy=true;const button=$('admin-invite-form').querySelector('button');button.disabled=true;
  inviteResult.hidden=true;inviteLink.value='';adminMessage.textContent='Criando convite…';
  try{
   const body={action:'invite',email,role:'manager',areas:[area],permissions:{[area]:{read:true,edit:false}},requestedAccess};
   const {response,data}=await post('/auth/users',body);
   if(!response.ok)throw Error('invite_failed');
   const safeUrl=inviteUrlForArea(data?.inviteUrl,area);
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
 window.addEventListener('pagehide',()=>{version++;session=null;inviteToken='';bootstrapToken='';$('bootstrap-secret').value='';inviteLink.value='';frame?.remove();});
 (async()=>{try{const s=await readSession();if(s?.authenticated===true)showShell(s);else showLogin();}catch(_){showLogin('Não foi possível consultar sua sessão agora. Você pode tentar entrar.');}})();
})();
