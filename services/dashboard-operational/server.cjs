'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createAuth,AuthError}=require('./auth.cjs');
const {decide,validateUpstreams,readJson,forward,ProxyError}=require('./proxy.cjs');
const {fixture}=require('./fixtures.cjs');
const AREA_PAGE=Object.freeze({growth:'/growth.html',organico:'/organico.html',influs:'/influs.html'});
const AREA_ENTRY=Object.freeze({growth:'/crm/index.html',organico:'/organico/index.html',influs:'/creators/index.html'});
const MIME=Object.freeze({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'});
const jsonError=(status,code)=>Object.assign(new Error(code),{status,code});
const LOGIN_PENDING_PER_SOCKET=8,LOGIN_SOCKET_KEYS_MAX=1024;
const LOGIN_BODY_TIMEOUT_MS=10*1000;
function loginGate(){
  const pendingBySocket=new Map();
  return socketAddress=>{
    // The socket peer is the only client identity available without a verified
    // proxy chain. Browser-supplied Forwarded/X-Forwarded-For must not split it.
    // A reverse proxy may present one peer for the whole team, so this is only
    // a concurrency cap; persistent account limits remain in auth.cjs.
    const key=typeof socketAddress==='string'&&socketAddress?socketAddress:'unknown';
    const pending=pendingBySocket.get(key)||0;
    if(pending>=LOGIN_PENDING_PER_SOCKET||pending===0&&pendingBySocket.size>=LOGIN_SOCKET_KEYS_MAX)throw jsonError(429,'AUTH_BUSY');
    pendingBySocket.set(key,pending+1);
    return ()=>{const remaining=pendingBySocket.get(key)-1;if(remaining)pendingBySocket.set(key,remaining);else pendingBySocket.delete(key);};
  };
}
async function readLoginJson(req,timeoutMs){
  let timer;
  const deadline=new Promise((_,reject)=>{
    timer=setTimeout(()=>{
      // A partial body must not occupy one of the login slots until the
      // server-wide request timeout. Drop this connection; never extend the
      // deadline into the password hash, which begins after readJson resolves.
      req.destroy();reject(jsonError(408,'LOGIN_BODY_TIMEOUT'));
    },timeoutMs);
  });
  try{return await Promise.race([readJson(req,32768),deadline]);}
  finally{clearTimeout(timer);}
}
// Keep in sync with build.cjs; build.test.cjs checks the resulting header against every meta tag.
const IMAGE_SOURCES='https://cdn.shopify.com/s/files/ https://email.shrigma.com.br/uploads/ https://cdninstagram.com/ https://*.cdninstagram.com/ https://fbcdn.net/ https://*.fbcdn.net/ https://*.ibyteimg.com/ https://*.tiktokcdn.com/ https://*.tiktokcdn-us.com/ https://*.byteimg.com/ https://*.ttwstatic.com/';
const CSP_BASE=`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${IMAGE_SOURCES}; connect-src 'self'; font-src 'self'; frame-src 'self' blob:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`;
function cspFor(html){
  const hashes=[...html.matchAll(/<script\s*>([\s\S]*?)<\/script>/gi)].map(m=>`'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  return `script-src 'self' ${hashes.join(' ')}; ${CSP_BASE}`;
}

function settingsFromEnv(env=process.env){
  const mode=env.DASHBOARD_MODE;if(!['synthetic','operational'].includes(mode))throw Error('DASHBOARD_MODE invalid');
  const managerHost=env.DASHBOARD_MANAGER_HOST;
  let areaHosts,domains,upstreamConfig,allowedHosts,dynamicRouteManifest;
  try{areaHosts=JSON.parse(env.DASHBOARD_AREA_HOSTS);domains=JSON.parse(env.DASHBOARD_EMAIL_DOMAINS);upstreamConfig=JSON.parse(env.DASHBOARD_UPSTREAMS||'{}');allowedHosts=JSON.parse(env.DASHBOARD_UPSTREAM_HOSTS||'[]');dynamicRouteManifest=JSON.parse(env.DASHBOARD_DYNAMIC_ROUTE_MANIFEST||'null');}catch{throw Error('Dashboard configuration invalid');}
  if(!areaHosts||!domains||!Array.isArray(domains)||!domains.length||!Array.isArray(allowedHosts))throw Error('Dashboard configuration invalid');
  const upstreams=validateUpstreams(upstreamConfig,allowedHosts,dynamicRouteManifest);
  if(mode==='synthetic'&&Object.keys(upstreams).length)throw Error('Synthetic mode cannot configure external upstreams');
  if(mode==='operational'&&!Object.keys(upstreams).length)throw Error('Operational mode needs explicit upstreams');
  const port=Number(env.PORT||3000);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
  if(typeof process.getuid==='function'&&env.DASHBOARD_EXPECT_UID&&process.getuid()!==Number(env.DASHBOARD_EXPECT_UID))throw Error('Unexpected runtime UID');
  return {mode,managerHost,areaHosts,allowedEmailDomains:domains,upstreams,allowedUpstreamHosts:allowedHosts,dynamicRouteManifest,port,host:env.HOST||'127.0.0.1',publicDir:path.resolve(env.DASHBOARD_PUBLIC_DIR||path.join(__dirname,'public')),dbPath:env.DASHBOARD_DB_PATH,bootstrapAdminEmail:env.DASHBOARD_ADMIN_EMAIL,bootstrapTokenSha256:env.DASHBOARD_BOOTSTRAP_SHA256,encryptionKey:env.DASHBOARD_ENCRYPTION_KEY};
}
function safeRequestPath(raw){
  if(typeof raw!=='string'||raw.length>4096||!raw.startsWith('/')||raw.startsWith('//'))throw jsonError(400,'PATH_INVALID');
  const beforeQuery=raw.split('?')[0];
  if(/%(?:2f|5c|2e|00)/i.test(beforeQuery))throw jsonError(400,'PATH_INVALID');
  let decoded;try{decoded=decodeURIComponent(beforeQuery);}catch{throw jsonError(400,'PATH_INVALID');}
  if(decoded.includes('\\')||decoded.includes('\0')||decoded.split('/').some(x=>x==='.'||x==='..'))throw jsonError(400,'PATH_INVALID');
  return new URL(raw,'http://dashboard.invalid');
}
function sendJson(req,res,status,body){
  res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.end(req.method==='HEAD'?undefined:JSON.stringify(body));
}
function headers(res){
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security','max-age=86400');
}
function typeAndCsp(file,data){
  const type=MIME[path.extname(file)];if(!type)return null;
  if(!file.endsWith('.html'))return {type,csp:"default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"};
  return {type,csp:cspFor(data.toString('utf8'))};
}
function fileForHost(pathname,host,s){
  const area=Object.entries(s.areaHosts).find(([,h])=>h===host)?.[0]||null;
  if(['/growth-diagnostico.html','/growth-control.js','/growth-delivery.js','/growth-diagnostic.js','/growth-diagnostic-ui.js'].includes(pathname)&&host!==s.managerHost&&area!=='growth')return null;
  if(pathname==='/'||pathname==='/index.html')return host===s.managerHost?'/gestao/index.html':area?AREA_ENTRY[area]:null;
  if(pathname==='/gestao/'||pathname==='/gestao/index.html')return host===s.managerHost?'/gestao/index.html':null;
  for(const [a,entry]of Object.entries(AREA_ENTRY))if(pathname===entry||pathname===path.posix.dirname(entry)+'/')return host===s.managerHost||area===a?entry:null;
  if(pathname==='/cx/'||pathname==='/cx/index.html'||pathname==='/index.html'||pathname.startsWith('/cx/'))return null;
  const panel=Object.entries(AREA_PAGE).find(([,p])=>p===pathname)?.[0];
  if(panel&&host!==s.managerHost&&area!==panel)return null;
  return pathname;
}
function serveFile(req,res,url,host,s,auth){
  if(!['GET','HEAD'].includes(req.method))throw jsonError(405,'METHOD_DENIED');
  const file=fileForHost(url.pathname,host,s);
  if(!file||!/^\/(?:gestao\/index\.html|crm\/index\.html|organico\/index\.html|creators\/index\.html|growth\.html|growth-diagnostico\.html|growth-(?:control|delivery|diagnostic|diagnostic-ui)\.js|organico\.html|influs\.html|entry\.(?:js|css)|guard\.js|assets\/panels\/[A-Za-z0-9._-]+\.(?:js|css)|logos\/[A-Za-z0-9._-]+\.(?:png|jpg|svg))$/.test(file))throw jsonError(404,'NOT_FOUND');
  const area=file==='/growth-diagnostico.html'?'growth':Object.entries(AREA_PAGE).find(([,p])=>p===file)?.[0];
  if(area)auth.authorize({cookieHeader:req.headers.cookie,host,method:'GET',area});
  const realRoot=fs.realpathSync(s.publicDir),candidate=path.resolve(realRoot,'.'+file);
  if(!candidate.startsWith(realRoot+path.sep))throw jsonError(404,'NOT_FOUND');
  let data;try{const real=fs.realpathSync(candidate);if(!real.startsWith(realRoot+path.sep)||fs.lstatSync(candidate).isSymbolicLink()||!fs.statSync(candidate).isFile())throw Error();data=fs.readFileSync(candidate);}catch{throw jsonError(404,'NOT_FOUND');}
  const metadata=typeAndCsp(file,data);if(!metadata)throw jsonError(404,'NOT_FOUND');
  res.statusCode=200;res.setHeader('Content-Type',metadata.type);res.setHeader('Content-Security-Policy',metadata.csp);
  res.setHeader('Cache-Control',file.endsWith('.html')?'no-store':'public, max-age=300');res.end(req.method==='HEAD'?undefined:data);
}
function createServer(s,{auth,fetchImpl=fetch,loginBodyTimeoutMs=LOGIN_BODY_TIMEOUT_MS}={}){
  if(!auth)throw Error('Auth required');
  if(!Number.isInteger(loginBodyTimeoutMs)||loginBodyTimeoutMs<1||loginBodyTimeoutMs>LOGIN_BODY_TIMEOUT_MS)throw Error('Invalid login body timeout');
  const upstreams=s.mode==='operational'?validateUpstreams({...s.upstreams},s.allowedUpstreamHosts,s.dynamicRouteManifest):Object.freeze(Object.create(null));
  if(s.mode==='operational'&&!Object.keys(upstreams).length)throw Error('Operational mode needs explicit upstreams');
  const allowedHosts=new Set([s.managerHost,...Object.values(s.areaHosts)]);
  const reserveLogin=loginGate();
  let upstreamInFlight=0;const upstreamByUser=new Map();
  const server=http.createServer({maxHeaderSize:8192},(req,res)=>{
    headers(res);
    const handle=async()=>{
      const host=String(req.headers.host||'').toLowerCase();
      if(!allowedHosts.has(host))throw jsonError(421,'HOST_DENIED');
      const url=safeRequestPath(req.url),origin='https://'+host;
      if(url.pathname==='/healthz'&&['GET','HEAD'].includes(req.method))return sendJson(req,res,200,{ok:true,mode:s.mode,identity:true,runtimeUid:typeof process.getuid==='function'?process.getuid():null});
      const ctx={cookieHeader:req.headers.cookie,host,method:req.method,origin:req.headers.origin,csrf:req.headers['x-csrf-token']};
      if(url.pathname==='/auth/session'&&req.method==='GET')return sendJson(req,res,200,auth.session(ctx));
      if(url.pathname==='/auth/users'&&req.method==='GET')return sendJson(req,res,200,{users:auth.users({context:ctx})});
      if(url.pathname==='/auth/login'&&req.method==='POST'){
        const release=reserveLogin(req.socket.remoteAddress);
        try{
          if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw jsonError(415,'CONTENT_TYPE_DENIED');
          const b=await readLoginJson(req,loginBodyTimeoutMs);
          const result=await auth.login({email:b.email,password:b.password,totp:b.totp,host,origin:ctx.origin,ip:req.socket.remoteAddress||'unknown'});
          res.setHeader('Set-Cookie',result.cookie);return sendJson(req,res,200,{authenticated:true,user:result.user,csrf:result.csrf,uiKey:result.uiKey});
        }finally{release();}
      }
      if(url.pathname.startsWith('/auth/')&&req.method==='POST'){
        if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw jsonError(415,'CONTENT_TYPE_DENIED');
        const b=await readJson(req,32768);
        if(url.pathname==='/auth/logout'){
          const result=auth.logout(ctx);res.setHeader('Set-Cookie',result.cookie);return sendJson(req,res,200,{ok:true});
        }
        if(url.pathname==='/auth/bootstrap/begin')return sendJson(req,res,200,auth.beginBootstrap({email:b.email,token:b.token,host,origin:ctx.origin}));
        if(url.pathname==='/auth/bootstrap/complete')return sendJson(req,res,200,await auth.completeBootstrap({email:b.email,token:b.token,password:b.password,totp:b.totp,host,origin:ctx.origin}));
        if(url.pathname==='/auth/invite/accept')return sendJson(req,res,200,await auth.acceptInvite({token:b.token,password:b.password,host,origin:ctx.origin}));
        if(url.pathname==='/auth/users'){
          if(b.action==='invite'){
            if(b.role!=='manager')throw jsonError(400,'ROLE_DENIED');
            if(Object.values(b.permissions||{}).some(grant=>grant?.edit===true))throw jsonError(403,'EDIT_NOT_READY');
            const invite=auth.createInvite({context:ctx,email:b.email,areas:b.areas,permissions:b.permissions,requestedAccess:b.requestedAccess});
            return sendJson(req,res,201,{userId:invite.userId,inviteUrl:'https://'+invite.host+'/#invite='+encodeURIComponent(invite.token)});
          }
          if(b.action==='revoke')return sendJson(req,res,200,auth.revokeUser({context:ctx,userId:b.userId}));
          if(b.action==='access_request')return sendJson(req,res,200,auth.setRequestedAccess({context:ctx,userId:b.userId,requestedAccess:b.requestedAccess}));
          if(b.action==='grant'){
            if(Object.values(b.permissions||{}).some(grant=>grant?.edit===true))throw jsonError(403,'EDIT_NOT_READY');
            return sendJson(req,res,200,auth.setGrants({context:ctx,userId:b.userId,permissions:b.permissions}));
          }
          if(b.action==='credential')return sendJson(req,res,200,auth.setUpstreamCredential({context:ctx,userId:b.userId,slot:b.slot,bearer:b.bearer}));
          throw jsonError(400,'ACTION_DENIED');
        }
        throw jsonError(404,'NOT_FOUND');
      }
      if(url.pathname.startsWith('/api/')){
        if(!['GET','POST'].includes(req.method))throw jsonError(405,'METHOD_DENIED');
        const route=url.pathname.slice('/api/'.length);
        if(!/^[a-z0-9_-]{1,48}$/.test(route))throw jsonError(404,'NOT_FOUND');
        if(req.method==='POST'&&req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw jsonError(415,'CONTENT_TYPE_DENIED');
        const body=req.method==='POST'?await readJson(req):undefined;
        const d=decide(route,req.method,url.searchParams,body);
        const user=auth.authorize({...ctx,area:d.area,edit:d.edit});
        const identity=route==='cx'&&url.searchParams.get('access')==='1'||route==='crm-read'&&d.action==='identity';
        if(identity)return sendJson(req,res,200,{schema:'shrigma_access_identity_v1',role:user.role==='superadmin'?'master':'manager',panel:user.role==='superadmin'?'todos':d.area,allowedPanels:user.areas,owner:user.email});
        if(s.mode==='synthetic'){
          const result=fixture(['cx','cache','crm-read'].includes(route)?d.area:route,Object.fromEntries(url.searchParams));
          return sendJson(req,res,200,result);
        }
        const credential=auth.getUpstreamCredential({...ctx,slot:d.credentialSlot,area:d.area,edit:d.edit});
        const principal=user.id;
        if(typeof principal!=='string'||upstreamInFlight>=16||(upstreamByUser.get(principal)||0)>=4)throw jsonError(429,'UPSTREAM_BUSY');
        upstreamInFlight++;upstreamByUser.set(principal,(upstreamByUser.get(principal)||0)+1);
        let result;
        try{result=await forward({route,method:req.method,query:url.searchParams,body,user,credential,upstreams,origin,fetchImpl});}
        finally{
          upstreamInFlight--;
          const remaining=upstreamByUser.get(principal)-1;
          if(remaining)upstreamByUser.set(principal,remaining);else upstreamByUser.delete(principal);
        }
        return sendJson(req,res,result.status,result.body);
      }
      return serveFile(req,res,url,host,s,auth);
    };
    handle().catch(error=>{
      if(res.destroyed)return;
      if(res.headersSent)return res.destroy();
      const status=error instanceof AuthError||error instanceof ProxyError||Number.isInteger(error.status)?error.status:500;
      const code=status===500?'INTERNAL_ERROR':error.code||'REQUEST_DENIED';
      sendJson(req,res,status,{error:code});
    });
  });
  server.headersTimeout=10000;server.requestTimeout=100000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=200;
  return server;
}
if(require.main===module){
  try{
    const settings=settingsFromEnv();
    const auth=createAuth({dbPath:settings.dbPath,managerHost:settings.managerHost,areaHosts:settings.areaHosts,allowedEmailDomains:settings.allowedEmailDomains,bootstrapAdminEmail:settings.bootstrapAdminEmail,bootstrapTokenSha256:settings.bootstrapTokenSha256,encryptionKey:settings.encryptionKey});
    createServer(settings,{auth}).listen(settings.port,settings.host,()=>console.log('Dashboard operational service listening'));
  }catch{console.error('Dashboard operational startup refused: invalid configuration');process.exitCode=1;}
}
module.exports={settingsFromEnv,safeRequestPath,fileForHost,createServer,typeAndCsp};
