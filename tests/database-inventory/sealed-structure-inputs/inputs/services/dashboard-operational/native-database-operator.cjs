'use strict';
const {readJson}=require('./proxy.cjs');
const FOUNDATION=require('./native-foundation-preview.cjs');
const PAGE='/auth/native-database',API='/auth/native-database-settings',SCRIPT='/auth/native-database.js';
const HTML=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Banco próprio · Shrigma</title></head><body><main><h1>Vincular o banco existente</h1><p>Destino confirmado: comunicacao / postgres / listmonk. A conexão usa a rede interna do seu servidor. Esta etapa permite inventariar metadados; a instalação de migrações exige revisão e admissão próprias.</p><form id="bind"><p><label>Usuário PostgreSQL existente <input name="username" maxlength="63" autocomplete="off" required></label></p><p><label>Senha privada desse usuário <input name="password" type="password" maxlength="4096" autocomplete="off" required></label></p><p><label><input name="privateNetwork" type="checkbox" required> Confirmo a conexão pela rede privada do servidor com esse banco existente.</label></p><button type="submit">Vincular credencial privada</button></form><p id="status" role="status"></p><p id="linked"></p><button id="revoke" type="button" hidden>Revogar vínculo com o banco</button><h2>Autorizar o integrador a consultar metadados</h2><form id="scope"><label>Conexão existente <select id="connections" name="connectionId" required></select></label><p>A autorização acrescenta somente a consulta do banco à conexão escolhida. A chave atual é preservada.</p><button type="submit">Autorizar inventário de leitura</button></form><h2>Preparar a consolidação neste banco</h2><p>Verifique a base própria do CRM no banco vinculado. A verificação não instala nem altera dados.</p><button id="foundation" type="button">Verificar preparação no banco</button><p id="foundation-status" role="status"></p><ul id="foundation-blockers"></ul><p><a href="/auth/native-connection">Gerenciar conexões</a></p></main><script src="/auth/native-database.js"></script></body></html>`;
const JS=`'use strict';
(()=>{
 const status=document.getElementById('status'),bind=document.getElementById('bind'),scope=document.getElementById('scope'),linked=document.getElementById('linked'),revoke=document.getElementById('revoke');let csrf;
 async function request(body){const r=await fetch('/auth/native-database-settings',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)}),v=await r.json();if(!r.ok)throw Error(v.error||'REQUEST_DENIED');return v;}
 async function refresh(){const v=await request({action:'status'});linked.textContent=v.database.linked?'Credencial privada vinculada para '+v.database.username+'. As migrações continuam desativadas.':'Credencial do banco ainda não vinculada.';revoke.hidden=!v.database.linked;document.getElementById('foundation').disabled=!v.database.linked;const select=document.getElementById('connections');select.replaceChildren();for(const c of v.connections){const option=document.createElement('option');option.value=c.id;option.textContent=c.label+(c.scopes.includes('db.inspect')?' · inventário autorizado':'');select.append(option);}scope.querySelector('button').disabled=!v.database.linked||!select.options.length;}
 bind.onsubmit=async e=>{e.preventDefault();const button=bind.querySelector('button'),password=bind.elements.password;button.disabled=true;try{const value=password.value;password.value='';await request({action:'bind',username:bind.elements.username.value,password:value,privateNetwork:bind.elements.privateNetwork.checked});status.textContent='Credencial cifrada no servidor. Autorize a consulta na conexão abaixo.';await refresh();}catch(e){status.textContent='Não foi possível vincular: '+e.message;}finally{password.value='';button.disabled=false;}};
 scope.onsubmit=async e=>{e.preventDefault();const button=scope.querySelector('button');button.disabled=true;try{await request({action:'authorize-inspection',connectionId:scope.elements.connectionId.value});status.textContent='Inventário de leitura autorizado. Recarregue a conexão no Codex para carregar as novas ferramentas.';await refresh();}catch(e){status.textContent=e.message;}finally{button.disabled=false;}};
 revoke.onclick=async()=>{try{await request({action:'revoke'});await refresh();status.textContent='Vínculo privado revogado.';}catch(e){status.textContent=e.message;}};
 document.getElementById('foundation').onclick=async()=>{
  const button=document.getElementById('foundation'),label=document.getElementById('foundation-status'),list=document.getElementById('foundation-blockers');button.disabled=true;list.replaceChildren();
  try{const v=await request({action:'foundation-preview'});label.textContent=v.catalogEligible?'O banco permite preparar a base própria. A instalação aguarda os aceites abaixo.':'A preparação encontrou dependências a resolver. Nenhuma alteração foi feita.';
   const names={INSTALLER_SUPERUSER_REQUIRED:'A credencial vinculada precisa de permissão para instalação.',INSTALLER_CREATE_PRIVILEGES_REQUIRED:'Faltam permissões para preparar a base própria.',NAMESPACE_PREEXISTS:'Já existe uma base com o mesmo nome; é necessário reconciliá-la.',RUNTIME_ROLE_PREEXISTS:'Já existe um acesso com o mesmo nome; é necessário reconciliá-lo.',DDL_EVENT_TRIGGERS_PRESENT:'Há regras automáticas de instalação que precisam de revisão.',INSTALLER_DEFAULT_ACL_UNSAFE:'As permissões padrão de instalação precisam de revisão.',PUBLIC_THIRD_PARTY_PRIVILEGES:'Há permissões gerais sobre dados de outros serviços que precisam de revisão.',ROOT_APPLY_ADMISSION_AND_RECOVERY_REQUIRED:'É necessário comprovar a recuperação e admitir a instalação revisada.'};
   for(const code of v.blockers){const li=document.createElement('li');li.textContent=names[code]||'Dependência de instalação pendente.';list.append(li);}
  }catch(e){label.textContent='Não foi possível verificar a preparação: '+e.message;}finally{button.disabled=false;}
 };

 fetch('/auth/session',{credentials:'same-origin',cache:'no-store'}).then(r=>r.json()).then(async v=>{if(!v.authenticated||v.user?.role!=='superadmin')throw Error('Entre com sua conta Mestre original e volte a esta página.');csrf=v.csrf;await refresh();}).catch(e=>{status.textContent=e.message;for(const b of document.querySelectorAll('button'))b.disabled=true;});
 window.addEventListener('pagehide',()=>{bind.elements.password.value='';csrf=undefined;});
})();`;
const fail=(code,status=403)=>{throw Object.assign(Error(code),{code,status});};
const output=(res,status,body)=>{res.statusCode=status;res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(body));};
async function handleDatabaseOperator({req,res,url,ctx,auth,managerHost,nativeInstaller}){
 if(![PAGE,API,SCRIPT].includes(url.pathname))return false;
 if(ctx.host!==managerHost||url.search)fail('HOST_DENIED');
 if(!auth.nativeDatabaseVault)fail('DB_PRIVATE_LINK_NOT_ENABLED',503);
 auth.authorize({...ctx,admin:true});
 if(url.pathname!==API){
  if(req.method!=='GET')fail('METHOD_DENIED',405);
  // Original browser only; native delegation never edits private custody.
  if(ctx.nativeBearer!==undefined)fail('NATIVE_BROWSER_CONSENT_REQUIRED');
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('Content-Type',url.pathname===PAGE?'text/html; charset=utf-8':'text/javascript; charset=utf-8');res.end(url.pathname===PAGE?HTML:JS);return true;
 }
 if(req.method!=='POST')fail('METHOD_DENIED',405);
 if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')fail('CONTENT_TYPE_DENIED',415);
 const body=await readJson(req,16384),exact=keys=>body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).sort().join(',')===keys.sort().join(',');
 if(body?.action==='status'&&exact(['action']))output(res,200,{database:auth.nativeDatabaseVault.status(ctx),connections:auth.nativeConnections.list(ctx).filter(c=>!c.revoked&&c.expiresAt>Date.now())});
 else if(body?.action==='bind'&&exact(['action','username','password','privateNetwork'])){const {action,...q}=body;output(res,200,auth.nativeDatabaseVault.bind({context:ctx,...q}));}
 else if(body?.action==='revoke'&&exact(['action']))output(res,200,auth.nativeDatabaseVault.revoke(ctx));
 else if(body?.action==='foundation-preview'&&exact(['action'])){
  auth.nativeDatabaseVault.status(ctx);if(typeof nativeInstaller?.preview!=='function')fail('FOUNDATION_PREVIEW_OFF',503);
  const ownerId=auth.session(ctx).user.id;output(res,200,await nativeInstaller.preview({migrationId:FOUNDATION.capsuleId,expectedSha256:FOUNDATION.capsuleHash},{ownerId,connectionId:'original-browser'}));
 }
 else if(body?.action==='authorize-inspection'&&exact(['action','connectionId'])){
  if(!auth.nativeDatabaseVault.status(ctx).linked)fail('DB_PRIVATE_CREDENTIAL_REQUIRED',503);
  output(res,200,auth.nativeConnections.permitInspection({context:ctx,connectionId:body.connectionId}));
 }else fail('ACTION_DENIED',400);
 return true;
}
module.exports={handleDatabaseOperator,PAGE,API,SCRIPT};
