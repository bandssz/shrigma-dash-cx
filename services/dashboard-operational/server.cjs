'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createAuth,AuthError,CREDENTIAL_SLOTS}=require('./auth.cjs');
const {decide,validateUpstreams,readJson,forward,ProxyError,MAX_CAMPAIGN_REQUEST,MAX_AUDIENCE_REQUEST,audiencePayloadHash,verifiedAudienceScope,verifiedAudienceOperation}=require('./proxy.cjs');
const AudienceContract=require('./segment-audience-contract.js');
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
  const crmDraftWrite=env.DASHBOARD_CRM_DRAFT_WRITE==='enabled';
  if(env.DASHBOARD_CRM_DRAFT_WRITE!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_CRM_DRAFT_WRITE)||crmDraftWrite&&mode!=='operational')throw Error('DASHBOARD_CRM_DRAFT_WRITE invalid');
  const crmAudienceDraft=env.DASHBOARD_CRM_AUDIENCE_DRAFT==='enabled';
  if(env.DASHBOARD_CRM_AUDIENCE_DRAFT!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_CRM_AUDIENCE_DRAFT)||crmAudienceDraft&&mode!=='operational')throw Error('DASHBOARD_CRM_AUDIENCE_DRAFT invalid');
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
  return {mode,crmDraftWrite,crmAudienceDraft,managerHost,areaHosts,allowedEmailDomains:domains,upstreams,allowedUpstreamHosts:allowedHosts,dynamicRouteManifest,port,host:env.HOST||'127.0.0.1',publicDir:path.resolve(env.DASHBOARD_PUBLIC_DIR||path.join(__dirname,'public')),dbPath:env.DASHBOARD_DB_PATH,bootstrapAdminEmail:env.DASHBOARD_ADMIN_EMAIL,bootstrapTokenSha256:env.DASHBOARD_BOOTSTRAP_SHA256,encryptionKey:env.DASHBOARD_ENCRYPTION_KEY};
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
  if(['/growth-diagnostico.html','/growth-control.js','/growth-delivery.js','/growth-diagnostic.js','/growth-diagnostic-ui.js','/media-read.js'].includes(pathname)&&host!==s.managerHost&&area!=='growth')return null;
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
  if(!file||!/^\/(?:gestao\/index\.html|crm\/index\.html|organico\/index\.html|creators\/index\.html|growth\.html|growth-diagnostico\.html|growth-(?:control|delivery|diagnostic|diagnostic-ui)\.js|media-read\.js|organico\.html|influs\.html|entry\.(?:js|css)|guard\.js|assets\/panels\/[A-Za-z0-9._-]+\.(?:js|css)|logos\/[A-Za-z0-9._-]+\.(?:png|jpg|svg))$/.test(file))throw jsonError(404,'NOT_FOUND');
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
  if(s.crmDraftWrite!==undefined&&typeof s.crmDraftWrite!=='boolean'||s.crmDraftWrite===true&&s.mode!=='operational')throw Error('Invalid CRM draft write gate');
  if(s.crmAudienceDraft!==undefined&&typeof s.crmAudienceDraft!=='boolean'||s.crmAudienceDraft===true&&s.mode!=='operational')throw Error('Invalid CRM audience draft gate');
  const allowCampaignDraft=s.mode==='operational'&&s.crmDraftWrite===true;
  const allowAudienceDraft=s.mode==='operational'&&s.crmAudienceDraft===true;
  if(allowCampaignDraft&&!upstreams.campaigns)throw Error('CRM draft write needs pinned campaigns upstream');
  if(allowAudienceDraft&&!upstreams.segments)throw Error('CRM audience draft needs pinned segments upstream');
  const crmReadOnly=s.mode==='operational'&&Object.keys(upstreams).length===1&&Boolean(upstreams['crm-read'])&&!allowCampaignDraft&&!allowAudienceDraft;
  const editGrantsAllowed=permissions=>Object.entries(permissions||{}).every(([area,grant])=>grant?.edit!==true||(allowCampaignDraft||allowAudienceDraft)&&area==='growth');
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
      if(url.pathname==='/auth/session'&&req.method==='GET'){
        const state=auth.session(ctx);
        // The owner view validates invite links against this service's exact
        // host configuration, so a new isolated canary needs no JS allowlist.
        if(state.authenticated&&state.user?.role==='superadmin'&&host===s.managerHost)
          return sendJson(req,res,200,{...state,areaHosts:s.areaHosts});
        return sendJson(req,res,200,state);
      }
      if(url.pathname==='/auth/users'&&req.method==='GET')return sendJson(req,res,200,{users:auth.users({context:ctx})});
      if(url.pathname==='/auth/campaign-draft'&&req.method==='GET'){
        if(!allowCampaignDraft)throw jsonError(403,'EDIT_NOT_READY');
        if([...url.searchParams.keys()].some(key=>key!=='brand')||url.searchParams.getAll('brand').length!==1)throw jsonError(400,'QUERY_DENIED');
        return sendJson(req,res,200,{operation:auth.campaignDraft(ctx,url.searchParams.get('brand'))});
      }
      if(url.pathname==='/auth/audience-draft'&&req.method==='GET'){
        if(!allowAudienceDraft)throw jsonError(403,'EDIT_NOT_READY');
        if([...url.searchParams.keys()].some(key=>key!=='brand')||url.searchParams.getAll('brand').length!==1)throw jsonError(400,'QUERY_DENIED');
        const operation=auth.audienceDraft(ctx,url.searchParams.get('brand'));
        return sendJson(req,res,200,{operation:operation&&{operationKey:operation.operationKey,action:operation.action,phase:operation.phase,receiptStatus:operation.receiptStatus,receiptCode:operation.receiptCode,segmentId:operation.segmentId,segmentVersion:operation.segmentVersion,updatedAt:operation.updatedAt}});
      }
      if(url.pathname==='/auth/login'&&req.method==='POST'){
        const release=reserveLogin(req.socket.remoteAddress);
        try{
          if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw jsonError(415,'CONTENT_TYPE_DENIED');
          const b=await readLoginJson(req,loginBodyTimeoutMs);
          const result=await auth.login({email:b.email,password:b.password,host,origin:ctx.origin,ip:req.socket.remoteAddress||'unknown'});
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
        if(url.pathname==='/auth/bootstrap/complete')return sendJson(req,res,200,await auth.completeBootstrap({email:b.email,token:b.token,password:b.password,host,origin:ctx.origin}));
        if(url.pathname==='/auth/invite/accept')return sendJson(req,res,200,await auth.acceptInvite({token:b.token,password:b.password,host,origin:ctx.origin}));
        if(url.pathname==='/auth/users'){
          if(b.action==='invite'){
            if(b.role!=='manager')throw jsonError(400,'ROLE_DENIED');
            if(!editGrantsAllowed(b.permissions))throw jsonError(403,'EDIT_NOT_READY');
            const invite=auth.createInvite({context:ctx,email:b.email,areas:b.areas,permissions:b.permissions,requestedAccess:b.requestedAccess});
            return sendJson(req,res,201,{userId:invite.userId,inviteUrl:'https://'+invite.host+'/#invite='+encodeURIComponent(invite.token)});
          }
          if(b.action==='revoke')return sendJson(req,res,200,auth.revokeUser({context:ctx,userId:b.userId}));
          if(b.action==='access_request')return sendJson(req,res,200,auth.setRequestedAccess({context:ctx,userId:b.userId,requestedAccess:b.requestedAccess}));
          if(b.action==='grant'){
            if(!editGrantsAllowed(b.permissions))throw jsonError(403,'EDIT_NOT_READY');
            return sendJson(req,res,200,auth.setGrants({context:ctx,userId:b.userId,permissions:b.permissions}));
          }
          if(b.action==='credential'){
            if(crmReadOnly&&b.slot!=='crm-panel-read')throw jsonError(403,'CREDENTIAL_SLOT_DENIED');
            if(b.slot==='crm-panel-read'){
              if(!crmReadOnly)throw jsonError(403,'CREDENTIAL_ATTESTATION_NOT_READY');
              return sendJson(req,res,200,await auth.setCrmPanelReadCredential({context:ctx,userId:b.userId,slot:b.slot,bearer:b.bearer,fetchImpl}));
            }
            if(CREDENTIAL_SLOTS[b.slot]?.mayWrite&&!(allowCampaignDraft&&b.slot==='growth-campaign')&&!(allowAudienceDraft&&b.slot==='growth-audience'))throw jsonError(403,'EDIT_NOT_READY');
            return sendJson(req,res,200,auth.setUpstreamCredential({context:ctx,userId:b.userId,slot:b.slot,bearer:b.bearer}));
          }
          throw jsonError(400,'ACTION_DENIED');
        }
        throw jsonError(404,'NOT_FOUND');
      }
      if(url.pathname.startsWith('/api/')){
        if(!['GET','POST'].includes(req.method))throw jsonError(405,'METHOD_DENIED');
        const route=url.pathname.slice('/api/'.length);
        if(!/^[a-z0-9_-]{1,48}$/.test(route))throw jsonError(404,'NOT_FOUND');
        if(req.method==='POST'&&req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw jsonError(415,'CONTENT_TYPE_DENIED');
        const body=req.method==='POST'?await readJson(req,route==='campaigns'?MAX_CAMPAIGN_REQUEST:route==='segments'?MAX_AUDIENCE_REQUEST:undefined):undefined;
        const d=decide(route,req.method,url.searchParams,body);
        const audienceAction=route==='segments'&&['segmento_criar','segmento_salvar','segmento_arquivar','segmento_operacao'].includes(d.action);
        if(route==='segments'&&d.action==='segmento_contexto_v2')throw jsonError(403,'ACTION_DENIED');
        if(d.edit&&!(allowCampaignDraft&&route==='campaigns'&&['campanha_salvar','campanha_operacao'].includes(d.action))&&!(allowAudienceDraft&&audienceAction))throw jsonError(403,'EDIT_NOT_READY');
        const user=auth.authorize({...ctx,area:d.area,edit:d.edit});
        const identity=route==='cx'&&url.searchParams.get('access')==='1'||route==='crm-read'&&d.action==='identity';
        if(identity)return sendJson(req,res,200,{schema:'shrigma_access_identity_v1',role:user.role==='superadmin'?'master':'manager',panel:user.role==='superadmin'?'todos':d.area,allowedPanels:user.areas,owner:user.email});
        if(s.mode==='synthetic'){
          const result=fixture(['cx','cache','crm-read'].includes(route)?d.area:route,Object.fromEntries(url.searchParams));
          return sendJson(req,res,200,result);
        }
        const credential=auth.getUpstreamCredential({...ctx,slot:d.credentialSlot,area:d.area,edit:d.edit});
        if(allowCampaignDraft&&route==='campaigns'&&d.action==='campanha_salvar'&&!credential)throw jsonError(503,'INDIVIDUAL_CREDENTIAL_MISSING');
        if(audienceAction&&!credential)throw jsonError(503,'INDIVIDUAL_CREDENTIAL_MISSING');
        const principal=user.id;
        if(typeof principal!=='string'||upstreamInFlight>=16||(upstreamByUser.get(principal)||0)>=4)throw jsonError(429,'UPSTREAM_BUSY');
        upstreamInFlight++;upstreamByUser.set(principal,(upstreamByUser.get(principal)||0)+1);
        let result;
        const draftSave=allowCampaignDraft&&route==='campaigns'&&d.action==='campanha_salvar';
        const draftReceipt=allowCampaignDraft&&route==='campaigns'&&d.action==='campanha_operacao';
        const draftBrand=draftSave?body.brand:draftReceipt?url.searchParams.get('brand'):null;
        const draftKey=draftSave?body.idempotency_key:draftReceipt?url.searchParams.get('idempotency_key'):null;
        try{
          if(audienceAction){
            const writing=req.method==='POST',brand=writing?body.brand:url.searchParams.get('brand'),key=writing?body.idempotency_key:url.searchParams.get('idempotency_key');
            let journal;
            if(writing){
              const scopeQuery=new URLSearchParams({acao:'segmento_contexto_v2',brand});
              const scope=await forward({route:'segments',method:'GET',query:scopeQuery,user,credential,upstreams,origin,crmAudienceDraft:true,fetchImpl});
              if(scope.status!==200)throw jsonError(502,'UPSTREAM_SCOPE_UNCONFIRMED');
              const actorSha256=verifiedAudienceScope(scope.body,brand),payloadSha256=audiencePayloadHash(body);
              auth.reserveAudienceDraft(ctx,brand,key,d.action,payloadSha256,actorSha256,{
                id:d.action==='segmento_criar'?null:body.id,
                expectedVersion:d.action==='segmento_criar'?null:body.expected_version,
                definitionSha256:d.action==='segmento_arquivar'?null:audiencePayloadHash(AudienceContract.normalize(body.definition))
              });
              journal=auth.audienceDraft(ctx,brand);
              try{await forward({route,method:'POST',query:url.searchParams,body,user,credential,upstreams,origin,crmAudienceDraft:true,fetchImpl});}
              catch(error){auth.audienceDraftOutcome(principal,brand,key,d.action,'uncertain');throw error;}
            }else{
              journal=auth.audienceDraft(ctx,brand);
              if(!journal||journal.operationKey!==key)throw jsonError(404,'OPERATION_NOT_FOUND');
            }
            const receiptQuery=new URLSearchParams({acao:'segmento_operacao',brand,idempotency_key:key});
            let lookup;
            try{lookup=await forward({route:'segments',method:'GET',query:receiptQuery,user,credential,upstreams,origin,crmAudienceDraft:true,fetchImpl});}
            catch(error){if(writing)auth.audienceDraftOutcome(principal,brand,key,d.action,'uncertain');throw error;}
            if(lookup.status!==200){
              if(writing){auth.audienceDraftOutcome(principal,brand,key,d.action,'uncertain');throw jsonError(502,'UPSTREAM_RECEIPT_UNCONFIRMED');}
              return sendJson(req,res,lookup.status,lookup.body);
            }
            let verified;
            try{verified=verifiedAudienceOperation(lookup.body,{brand,key,action:journal.action,requestId:journal.requestId,expectedVersion:journal.expectedVersion,payloadMatches:hash=>auth.audiencePayloadMatches(journal.payloadMac,hash),actorMatches:hash=>auth.audienceActorMatches(journal.actorMac,hash),definitionMatches:hash=>auth.audienceDefinitionMatches(journal.definitionMac,hash)});}
            catch(error){if(writing)auth.audienceDraftOutcome(principal,brand,key,d.action,'uncertain');throw error;}
            auth.audienceDraftOutcome(principal,brand,key,journal.action,verified.phase,{receiptStatus:verified.status,receiptCode:verified.receiptCode,segmentId:verified.segmentId,segmentVersion:verified.segmentVersion});
            return sendJson(req,res,verified.status,verified.body);
          }
          if(draftReceipt){
            const existing=auth.campaignDraft(ctx,draftBrand);
            if(!existing||existing.operationKey!==draftKey)throw jsonError(404,'OPERATION_NOT_FOUND');
          }
          if(draftSave)auth.reserveCampaignDraft(ctx,draftBrand,draftKey);
          try{result=await forward({route,method:req.method,query:url.searchParams,body,user,credential,upstreams,origin,crmDraftWrite:allowCampaignDraft,fetchImpl});}
          catch(error){if(draftSave)auth.campaignDraftOutcome(principal,draftBrand,draftKey,'uncertain');throw error;}
          if(draftSave){
            const campaign=result.body?.campaign;
            const confirmed=result.status>=200&&result.status<300&&campaign?.status==='draft'&&campaign.sent===0&&campaign.started_at==null&&campaign.send_at===null&&campaign.definition?.brand===draftBrand&&Number.isSafeInteger(campaign.id)&&campaign.id>0;
            auth.campaignDraftOutcome(principal,draftBrand,draftKey,confirmed?'succeeded':'uncertain',{receiptState:confirmed?'succeeded':null,campaignId:confirmed?campaign.id:null});
            if(result.status>=200&&result.status<300&&!confirmed)throw jsonError(502,'UPSTREAM_DRAFT_UNCONFIRMED');
          }
          if(draftReceipt&&result.status===200){
            const receipt=result.body?.operation;
            if(receipt?.operation_key!==draftKey)throw jsonError(502,'UPSTREAM_RECEIPT_UNCONFIRMED');
            let phase='uncertain',campaignId=null;
            if(receipt.state==='succeeded'){
              const saved=receipt.response?.body?.campaign;
              if(receipt.response?.status>=200&&receipt.response.status<300&&saved?.status==='draft'&&saved.sent===0&&saved.started_at==null&&saved.send_at===null&&saved.definition?.brand===draftBrand&&Number.isSafeInteger(saved.id)&&saved.id>0){phase='succeeded';campaignId=saved.id;}
            }else if(receipt.state==='rejected'&&receipt.action==='salvar'&&
              typeof receipt.id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.id)&&
              receipt.providerId===null&&receipt.response&&typeof receipt.response==='object'&&!Array.isArray(receipt.response)&&
              Number.isInteger(receipt.response.status)&&receipt.response.status>=400&&receipt.response.status<=599&&
              receipt.response.body&&typeof receipt.response.body==='object'&&!Array.isArray(receipt.response.body)&&
              receipt.response.body.provider_id===null&&typeof receipt.response.body.error==='string'&&receipt.response.body.error.length>0)phase='rejected';
            auth.campaignDraftOutcome(principal,draftBrand,draftKey,phase,{receiptState:receipt.state,campaignId});
          }
        }
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
