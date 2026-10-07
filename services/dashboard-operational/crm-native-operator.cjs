'use strict';
const {readJson}=require('./proxy.cjs');
const PAGE='/auth/native-connection',API='/auth/native-connections',SCRIPT='/auth/native-connection.js';
const HTML=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conexão privada · Shrigma</title></head><body><main><h1>Conectar o Shrigma</h1><p>Esta autorização usa sua conta Mestre. A chave permite apenas as ações selecionadas e continua sujeita às permissões reais do CRM.</p><form id="form"><p><label>Nome da conexão <input name="label" maxlength="80" value="Integrador Shrigma" required></label></p><fieldset><legend>Marcas</legend><label><input type="checkbox" name="brand" value="fish" checked> Fish</label><label><input type="checkbox" name="brand" value="aristo" checked> Aristo</label></fieldset><fieldset><legend>Ações</legend><label><input type="checkbox" name="scope" value="crm.read" checked> Consultar CRM</label><br><label><input type="checkbox" name="scope" value="crm.draft" checked> Editar rascunhos permitidos</label><br><label><input type="checkbox" name="scope" value="crm.iam" checked> Administrar acessos das marcas</label><br><label><input type="checkbox" name="scope" value="db.inspect"> Verificar banco próprio</label><br><label><input type="checkbox" name="scope" value="db.install"> Aplicar migrações próprias revisadas</label></fieldset><p><label>Validade <select name="expiresDays"><option value="7">7 dias</option><option value="1">1 dia</option><option value="30">30 dias</option></select></label></p><button type="submit">Autorizar conexão</button></form><p id="status" role="status"></p><section id="key" hidden><h2>Chave privada</h2><p>Copie para o campo privado de autenticação do conector. Ela será mostrada uma vez. Não envie no chat.</p><input id="token" readonly aria-label="Chave privada"><button id="clear" type="button">Ocultar chave</button></section><h2>Conexões autorizadas</h2><div id="connections"></div></main><script src="/auth/native-connection.js"></script></body></html>`;
const JS=`'use strict';
(()=>{
 const status=document.getElementById('status'),form=document.getElementById('form'),token=document.getElementById('token'),section=document.getElementById('key'),list=document.getElementById('connections');let csrf;
 async function request(body){const r=await fetch('/auth/native-connections',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)}),v=await r.json();if(!r.ok)throw Error(v.error||'REQUEST_DENIED');return v;}
 async function refresh(){const v=await request({action:'list'});list.replaceChildren();for(const c of v.connections){const row=document.createElement('p'),text=document.createElement('span');text.textContent=c.label+' · '+c.brands.join(', ')+' · '+(c.revoked?'revogada':'válida até '+new Date(c.expiresAt).toLocaleString());row.append(text);if(!c.revoked){const button=document.createElement('button');button.type='button';button.textContent='Revogar';button.onclick=async()=>{try{await request({action:'revoke',connectionId:c.id});await refresh();}catch(e){status.textContent=e.message;}};row.append(button);}list.append(row);}}
 form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('button[type=submit]');button.disabled=true;token.value='';section.hidden=true;try{const data=new FormData(form),v=await request({action:'issue',label:data.get('label'),brands:data.getAll('brand'),scopes:data.getAll('scope'),expiresDays:Number(data.get('expiresDays'))});token.value=v.token;section.hidden=false;status.textContent='Conexão autorizada. Guarde a chave no conector privado.';await refresh();}catch(e){status.textContent='Não foi possível autorizar: '+e.message;}finally{button.disabled=false;}};
 document.getElementById('clear').onclick=()=>{token.value='';section.hidden=true;};
 fetch('/auth/session',{credentials:'same-origin',cache:'no-store'}).then(r=>r.json()).then(async v=>{if(!v.authenticated||v.user?.role!=='superadmin')throw Error('Entre com sua conta Mestre no gerencial e volte a esta página.');csrf=v.csrf;await refresh();}).catch(e=>{status.textContent=e.message;form.querySelector('button[type=submit]').disabled=true;});
 window.addEventListener('pagehide',()=>{token.value='';csrf=undefined;});
})();`;
function output(res,status,body){res.statusCode=status;res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(body));}
async function handleOperator({req,res,url,ctx,auth,managerHost}){
 if(![PAGE,API,SCRIPT].includes(url.pathname))return false;
 if(ctx.host!==managerHost||url.search)throw Object.assign(Error('HOST_DENIED'),{status:403,code:'HOST_DENIED'});
 if(url.pathname!==API){
  if(req.method!=='GET')throw Object.assign(Error('METHOD_DENIED'),{status:405,code:'METHOD_DENIED'});
  auth.authorize({...ctx,admin:true});
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('Content-Type',url.pathname===PAGE?'text/html; charset=utf-8':'text/javascript; charset=utf-8');res.end(url.pathname===PAGE?HTML:JS);return true;
 }
 if(req.method!=='POST')throw Object.assign(Error('METHOD_DENIED'),{status:405,code:'METHOD_DENIED'});
 auth.authorize({...ctx,admin:true});
 if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw Object.assign(Error('CONTENT_TYPE_DENIED'),{status:415,code:'CONTENT_TYPE_DENIED'});
 const body=await readJson(req,16384);
 const exact=keys=>body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).sort().join(',')===keys.sort().join(',');
 if(body?.action==='issue'&&exact(['action','label','brands','scopes','expiresDays'])){
  const {action,...args}=body;output(res,201,auth.nativeConnections.issue({context:ctx,...args}));
 }else if(body?.action==='list'&&exact(['action']))output(res,200,{connections:auth.nativeConnections.list(ctx)});
 else if(body?.action==='revoke'&&exact(['action','connectionId']))output(res,200,auth.nativeConnections.revoke({context:ctx,connectionId:body.connectionId}));
 else throw Object.assign(Error('ACTION_DENIED'),{status:400,code:'ACTION_DENIED'});
 return true;
}
module.exports={handleOperator,PAGE,API,SCRIPT};
