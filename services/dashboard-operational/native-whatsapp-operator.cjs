'use strict';
const fail=(code,status=403)=>{throw Object.assign(Error(code),{code,status});};
const exact=(x,keys)=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
const PATH='/auth/native-whatsapp-settings',CATALOG='/api/whatsapp-templates',METADATA='/api/whatsapp-token-metadata',ENTRY='/auth/meta-whatsapp',SCRIPT='/auth/meta-whatsapp.js';
// SPEC: Can the owner connect the two brands to Meta? No token redisplay,
// storage, query string, telemetry or third-party asset is used by this page.
const HTML=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectar WhatsApp · Shrigma</title><link rel="stylesheet" href="/app/crm/vendor/tabler.min.css"></head><body><main class="container-xl py-4"><header class="mb-4"><span class="badge bg-yellow-lt">Proprietário</span><h1 class="page-title mt-2">Conectar WhatsApp</h1></header><section class="card"><div class="card-header"><h2 class="card-title">Fish e Aristo</h2><span id="state" class="badge bg-secondary-lt ms-auto">Conferindo</span></div><div class="card-body"><form id="connect" autocomplete="off"><label for="token" class="form-label">Token de usuário de sistema da Meta</label><input id="token" class="form-control" type="password" autocomplete="off" spellcheck="false" autocapitalize="none" required minlength="32" maxlength="8192" disabled><button id="save" class="btn btn-primary mt-3" type="submit" disabled>Criar vínculo nas duas marcas</button></form><div id="result" class="mt-3" role="status" aria-live="polite"></div><dl id="scope" class="mt-3 mb-0"></dl></div></section></main><script src="/auth/meta-whatsapp.js" defer></script></body></html>`;
function mount(){
 const $=id=>document.getElementById(id);let csrf='',busy=false,closed=false,expectedConnections;
 const messages={WA_META_MANAGEMENT_SCOPE_REQUIRED:'Falta a permissão whatsapp_business_management na Meta.',WA_META_SCOPE_UNCONFIRMED:'A Meta não confirmou as permissões do token.',WA_META_WABA_UNCONFIRMED:'A Meta não confirmou acesso às duas marcas.',WA_META_TOKEN_CHECK_REFUSED:'A Meta recusou a conferência do token ou das marcas.',WA_META_TOKEN_CHECK_UNAVAILABLE:'A Meta está indisponível. Nenhum vínculo foi criado.',WA_CONNECTION_ALREADY_BOUND:'Já existe um vínculo. Confira o estado antes de continuar.'};
 const lock=()=>{$('token').disabled=busy||closed;$('save').disabled=busy||closed;};
 async function post(data){const r=await fetch('/auth/native-whatsapp-settings',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(data)});if(!r.ok){let v;try{v=await r.json();}catch{}const e=Error('REQUEST_FAILED');e.safeCode=typeof v?.error==='string'?v.error:v?.code;throw e;}return r.json();}
 function render(v){const rows=v?.connections;if(!Array.isArray(rows)||rows.length!==2||rows.some(x=>!['fish','aristo'].includes(x.brand))||new Set(rows.map(x=>x.brand)).size!==2)throw Error('STATUS_UNCONFIRMED');closed=false;const existing=rows.some(x=>x.connectionRef),all=rows.every(x=>x.linked);expectedConnections=existing?['fish','aristo'].map(brand=>{const row=rows.find(x=>x.brand===brand);return {brand,connectionRef:row.connectionRef||null,revision:row.revision||0,binding:row.binding||null};}):undefined;$('save').textContent=existing?'Substituir token nas duas marcas':'Criar vínculo nas duas marcas';$('state').textContent=all?'Conectado':existing?'Conferir':'Pendente';$('result').textContent=all?'Vínculo criado: Fish/Aristo. Você pode substituir o token.':existing?'Cole o token para atualizar as duas marcas.':'Cole o token para conectar as duas marcas.';$('scope').replaceChildren();for(const row of rows.filter(x=>x.linked)){const label=document.createElement('dt'),value=document.createElement('dd');label.textContent=row.brand==='fish'?'Fish · permissões na Meta':'Aristo · permissões na Meta';value.textContent=(row.permissions||[]).join(', ')||'Não consultadas';$('scope').append(label,value);}lock();}
 $('connect').addEventListener('submit',async event=>{event.preventDefault();if(busy||closed)return;let token=$('token').value;$('token').value='';busy=true;lock();$('state').textContent='Conferindo';try{render(await post(expectedConnections?{action:'replace-system-user-read',token,expectedConnections}:{action:'bind-system-user-read',token}));}catch(e){token='';try{render(await post({action:'status'}));$('result').textContent=messages[e.safeCode]||'Estado relido. Confira as marcas e as permissões antes de colar novamente.';}catch{closed=true;$('state').textContent='Conferir';$('result').textContent='Estado não confirmado. Reabra esta página antes de continuar.';}}finally{token='';busy=false;lock();}});
 window.addEventListener('pagehide',()=>{$('token').value='';csrf='';});
 (async()=>{try{const r=await fetch('/auth/session',{credentials:'same-origin',cache:'no-store',redirect:'error'});if(!r.ok)throw Error('SESSION');const s=await r.json();if(s.authenticated!==true||s.user?.role!=='superadmin'||typeof s.csrf!=='string')throw Error('SESSION');csrf=s.csrf;render(await post({action:'status'}));}catch{closed=true;lock();$('state').textContent='Indisponível';$('result').textContent='Entre com a conta proprietária no gerencial e reabra esta página.';}})();
}
const JS='('+mount.toString()+')();';
async function handle({req,res,url,ctx,auth,managerHost,crmHost}={}){
 if(![PATH,CATALOG,METADATA,ENTRY,SCRIPT].includes(url.pathname))return false;
 res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
 const send=value=>{res.statusCode=200;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));return true;};
 if([ENTRY,SCRIPT].includes(url.pathname)){
  if(ctx.host!==managerHost||ctx.nativeBearer!==undefined||url.search||req.method!=='GET')fail('WA_OWNER_BROWSER_SESSION_REQUIRED');auth.authorize({...ctx,admin:true});auth.whatsAppConnectionStore().authorizeOwnerRead(ctx);
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");res.setHeader('Content-Type',url.pathname===SCRIPT?'text/javascript; charset=utf-8':'text/html; charset=utf-8');res.statusCode=200;res.end(url.pathname===SCRIPT?JS:HTML);return true;
 }
 if(url.pathname===METADATA){
  if(ctx.nativeBearer!==undefined||![managerHost,crmHost].includes(ctx.host))fail('WA_RESTRICTED_SESSION_REQUIRED');
  if(req.method!=='GET')fail('WA_READ_ONLY',405);if(url.searchParams.size!==1||!url.searchParams.has('brand'))fail('WA_READ_INPUT_REFUSED',400);
  const brand=url.searchParams.get('brand'),connection=auth.whatsAppConnectionStore().resolve({context:ctx,brand});return send(await connection.inspectToken());
 }
 if(url.pathname===CATALOG){
  if(ctx.nativeBearer!==undefined||![managerHost,crmHost].includes(ctx.host))fail('WA_RESTRICTED_SESSION_REQUIRED');
  if(req.method!=='GET')fail('WA_READ_ONLY',405);const keys=[...url.searchParams.keys()];if(![1,2].includes(keys.length)||new Set(keys).size!==keys.length||!keys.includes('brand')||keys.some(k=>!['brand','after'].includes(k)))fail('WA_READ_INPUT_REFUSED',400);
  const brand=url.searchParams.get('brand'),after=url.searchParams.has('after')?url.searchParams.get('after'):undefined,connection=auth.whatsAppConnectionStore().resolve({context:ctx,brand});
  return send(await connection.listTemplates({after}));
 }
 if(ctx.host!==managerHost||ctx.nativeBearer!==undefined||url.search)fail('WA_OWNER_BROWSER_SESSION_REQUIRED');auth.authorize({...ctx,admin:true});
 const store=auth.whatsAppConnectionStore();if(req.method!=='POST')fail('WA_OWNER_METHOD_REFUSED',405);
 if(req.headers['content-encoding']||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))fail('WA_OWNER_CONTENT_TYPE_REFUSED',415);
 let size=0,parts=[];for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>16384)fail('WA_OWNER_INPUT_TOO_LARGE',413);parts.push(Buffer.from(chunk));}auth.authorize({...ctx,admin:true});let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{fail('WA_OWNER_INPUT_REFUSED',400);}
 try{
  if(body?.action==='status'&&exact(body,['action']))return send(store.status(ctx));
  if(body?.action==='bind-system-user-read'&&exact(body,['action','token']))return send(await store.bindSystemUser({context:ctx,token:body.token}));
  if(body?.action==='replace-system-user-read'&&exact(body,['action','token','expectedConnections']))return send(await store.bindSystemUser({context:ctx,token:body.token,expectedConnections:body.expectedConnections}));
  if(body?.action==='bind-original-read'&&exact(body,['action','brand','token','original','expectedRevision']))return send(store.bind({context:ctx,brand:body.brand,token:body.token,original:body.original,expectedRevision:body.expectedRevision}));
  if(body?.action==='readmit-revoked-original-read'&&exact(body,['action','brand','token','original','expectedRevision','connectionRef']))return send(store.bind({context:ctx,brand:body.brand,token:body.token,original:body.original,expectedRevision:body.expectedRevision,connectionRef:body.connectionRef}));
  if(body?.action==='revoke'&&exact(body,['action','brand','connectionRef','expectedRevision']))return send(store.revoke({context:ctx,brand:body.brand,connectionRef:body.connectionRef,expectedRevision:body.expectedRevision}));
  fail('WA_OWNER_ACTION_REFUSED',400);
 }finally{if(body&&typeof body==='object')body.token='';for(const b of parts)b.fill(0);parts=[];}
}
module.exports=Object.freeze({handle,PATH,CATALOG,METADATA,ENTRY,SCRIPT,HTML,JS});
