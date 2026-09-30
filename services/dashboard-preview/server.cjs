'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fixture}=require('./fixtures.cjs');
const PANELS=['cx','growth','organico','influs'];
const ROUTES={cx:{scope:null,actions:['identity'],parameters:['painel','access']},cache:{scope:null,actions:[],parameters:['painel']},'crm-read':{scope:'growth',actions:['identity','cache_growth'],parameters:['painel']},influ:{scope:'influs',actions:['listar'],parameters:['ini','fim','pilot','conciliacao_pedidos','marca']},tts:{scope:'influs',actions:['listar'],parameters:['ini','fim','marca']},'tts-cobranca':{scope:'influs',actions:['ler','produtos'],parameters:['marca']},'organico-links':{scope:'organico',actions:['listar'],parameters:['marca']},candidaturas:{scope:'influs',actions:['ler'],parameters:['marca']},aprovacao:{scope:'influs',actions:['ler'],parameters:['marca']},escopo:{scope:'influs',actions:['ler'],parameters:['marca','mes']}};
const PRODUCTION_ENV=/(?:^|_)(?:DATABASE_URL|DB_HOST|DB_PASSWORD|POSTGRES|PGHOST|PGPASSWORD|PGUSER|PGDATABASE|SHOPIFY|GLEAP|LISTMONK|SMTP|SES|N8N|WEBHOOK|WORKER|CRON|SYNC|UPSTREAM|PRODUCTION)(?:_|$)/i;
function config(env=process.env){
 if(env.NODE_ENV==='production'||env.PREVIEW_MODE!=='synthetic')throw Error('Preview mode required; production startup forbidden.');
 if(env.PREVIEW_EXPECT_UID!==undefined&&(!/^\d+$/.test(env.PREVIEW_EXPECT_UID)||typeof process.getuid!=='function'||process.getuid()!==Number(env.PREVIEW_EXPECT_UID)))throw Error('Unexpected runtime user.');
 if(Object.keys(env).some(k=>PRODUCTION_ENV.test(k)&&env[k]))throw Error('Production integration environment forbidden.');
 let hashes;try{hashes=JSON.parse(env.PREVIEW_ACCESS_HASHES||'');}catch(_){throw Error('PREVIEW_ACCESS_HASHES must be a nonempty SHA256-to-scope JSON mapping.');}
 if(!hashes||Array.isArray(hashes)||typeof hashes!=='object'||!Object.keys(hashes).length||Object.keys(hashes).length>50)throw Error('Invalid preview access mapping.');
 for(const [digest,scope]of Object.entries(hashes))if(!/^[a-f0-9]{64}$/.test(digest)||!['master','todos',...PANELS].includes(scope))throw Error('Invalid preview access mapping.');
 const port=Number(env.PORT||3000);if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid port.');
 let origin=null;if(env.PREVIEW_ORIGIN){try{const u=new URL(env.PREVIEW_ORIGIN);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error();origin=u.origin;}catch(_){throw Error('Invalid preview origin.');}}
 return {hashes,port,host:env.HOST||'127.0.0.1',origin,publicDir:path.resolve(env.PREVIEW_PUBLIC_DIR||path.join(__dirname,'public'))};
}
function identity(scope){
 const master=scope==='master'||scope==='todos',allowedPanels=master?[...PANELS]:[scope];
 return {schema:'shrigma_access_identity_v1',role:master?'master':'manager',panel:master?'todos':scope,allowedPanels,owner:master?'TESTE · Acesso mestre':'TESTE · Gestor '+scope,preview:true,permissions:Object.fromEntries(allowedPanels.map(p=>[p,{caps:['read'],label:'TESTE · somente leitura',read:true,write:false}]))};
}
function authenticate(req,hashes){
 const value=req.headers.authorization||'';if(typeof value!=='string'||!/^Bearer [a-z0-9-]{8,128}$/.test(value))return null;
 const digest=crypto.createHash('sha256').update(value.slice(7)).digest();
 for(const [known,scope]of Object.entries(hashes))if(crypto.timingSafeEqual(Buffer.from(known,'hex'),digest))return scope;
 return null;
}
function createServer(settings){
 const fileTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'};
 const server=http.createServer({maxHeaderSize:8192},(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  const send=(code,body)=>{res.statusCode=code;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'self'; base-uri 'none'; connect-src 'self'");res.end(req.method==='HEAD'?undefined:JSON.stringify(body));};
  if(req.headers.origin){const expected=settings.origin||'http://'+req.headers.host;if(req.headers.origin!==expected)return send(403,{erro:'Origem recusada.'});}
  let url;try{if(!req.url.startsWith('/')||req.url.startsWith('//'))throw Error();url=new URL(req.url,'http://preview.invalid');}catch(_){return send(400,{erro:'Invalid request.'});}
  // Reject encoded separators/traversal before WHATWG URL normalization.
  let rawPath;try{rawPath=decodeURIComponent(req.url.split('?')[0]);}catch(_){return send(400,{erro:'Invalid path.'});}
  if(rawPath.includes('\\')||rawPath.includes('\0')||rawPath.split('/').some(p=>p==='..'||p==='.')||/%(?:2e|2f|5c)/i.test(rawPath))return send(400,{erro:'Invalid path.'});
  if(!['GET','HEAD'].includes(req.method)){req.resume();return send(403,{erro:'TESTE: escrita bloqueada.',preview:true});}
  if(url.pathname==='/healthz')return send(200,{ok:true,mode:'synthetic-read-only',externalIntegrations:false,writes:false,production:false,runtimeUid:typeof process.getuid==='function'?process.getuid():null,runtimeGid:typeof process.getgid==='function'?process.getgid():null});
  if(url.pathname.startsWith('/preview-api/')){
   const route=url.pathname.slice('/preview-api/'.length),spec=ROUTES[route];
   if(!spec)return send(403,{erro:'TESTE: operação bloqueada.',preview:true});
   const scope=authenticate(req,settings.hashes);if(!scope)return send(401,{erro:'Acesso de teste recusado.'});
   const master=scope==='master'||scope==='todos';
   const actions=[...url.searchParams.getAll('action'),...url.searchParams.getAll('acao')];
   if(actions.length>1||actions.some(a=>!spec.actions.includes(a)))return send(403,{erro:'TESTE: operação bloqueada.',preview:true});
   const allowed=new Set(['action','acao',...spec.parameters]);
   if([...url.searchParams.keys()].some(k=>!allowed.has(k)||url.searchParams.getAll(k).length>1)||[...url.searchParams.values()].some(v=>v.length>256))return send(403,{erro:'TESTE: parâmetro bloqueado.',preview:true});
   if(url.searchParams.has('mes')&&!/^\d{4}-\d{2}$/.test(url.searchParams.get('mes')))return send(403,{erro:'TESTE: mês bloqueado.'});
   const requested=url.searchParams.get('painel'),panel=spec.scope||requested||'cx';
   if(!['todos',...PANELS].includes(panel))return send(403,{erro:'Área recusada.'});
   if((panel==='todos'&&!master)||(!master&&scope!==panel))return send(403,{erro:'Acesso não permite esta área.'});
   if(spec.scope&&requested&&requested!==spec.scope)return send(403,{erro:'Área recusada.'});
   const action=actions[0]||'',access=url.searchParams.get('access');
   if(access!==null&&access!=='1')return send(403,{erro:'TESTE: operação bloqueada.'});
   if(action==='identity'||access==='1')return send(200,identity(scope));
   if(panel==='todos')return send(403,{erro:'Selecione uma área para leitura.'});
   return send(200,fixture(['cx','cache','crm-read'].includes(route)?panel:route==='influ'?'influs':route,Object.fromEntries(url.searchParams)));
  }
  let file=url.pathname==='/'?'/gestao/index.html':url.pathname;
  if(file.endsWith('/'))file+='index.html';
  if(file.startsWith('/.'))return send(404,{erro:'Not found.'});
  const resolved=path.resolve(settings.publicDir,'.'+file);
  if(!resolved.startsWith(settings.publicDir+path.sep))return send(404,{erro:'Not found.'});
  let data;try{const real=fs.realpathSync(resolved);if(!real.startsWith(fs.realpathSync(settings.publicDir)+path.sep)||!fs.statSync(resolved).isFile()||fs.lstatSync(resolved).isSymbolicLink())throw Error();data=fs.readFileSync(resolved);}catch(_){return send(404,{erro:'Not found.'});}
  const type=fileTypes[path.extname(resolved)];if(!type)return send(404,{erro:'Not found.'});
  res.statusCode=200;res.setHeader('Content-Type',type);res.setHeader('Cache-Control',file.endsWith('.html')?'no-store':'public, max-age=300');
  const hashes=file.endsWith('.html')?[...data.toString().matchAll(/<script\s*>([\s\S]*?)<\/script>/g)].map(m=>`'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`):[];
  res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' ${hashes.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-src 'self' blob:; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`);
  res.end(req.method==='HEAD'?undefined:data);
 });
 server.headersTimeout=10000;server.requestTimeout=15000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=200;
 return server;
}
if(require.main===module){try{const settings=config();createServer(settings).listen(settings.port,settings.host,()=>console.log('Synthetic read-only dashboard preview listening.'));}catch(_){console.error('Preview startup refused: invalid isolation or access configuration.');process.exitCode=1;}}
module.exports={config,createServer,authenticate,identity,ROUTES};
