'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createAuth,AuthError,CREDENTIAL_SLOTS}=require('./auth.cjs');
const {decide,validateUpstreams,readJson,forward,ProxyError,MAX_CAMPAIGN_REQUEST,MAX_AUDIENCE_REQUEST,audiencePayloadHash,verifiedAudienceScope,verifiedAudienceOperation}=require('./proxy.cjs');
const AudienceContract=require('./segment-audience-contract.js');
const ManagedRead=require('./crm-manager-read-bridge.cjs');
const AudienceRead=require('./crm-audience-read-bridge.cjs');
const TemplateRead=require('./crm-template-read-bridge.cjs');
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
  const upstreamProfile=env.DASHBOARD_UPSTREAM_PROFILE||'production';
  if(!['production','crm-sandbox'].includes(upstreamProfile)||upstreamProfile==='crm-sandbox'&&mode!=='operational')throw Error('DASHBOARD_UPSTREAM_PROFILE invalid');
  const crmDraftWrite=env.DASHBOARD_CRM_DRAFT_WRITE==='enabled';
  if(env.DASHBOARD_CRM_DRAFT_WRITE!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_CRM_DRAFT_WRITE)||crmDraftWrite&&mode!=='operational')throw Error('DASHBOARD_CRM_DRAFT_WRITE invalid');
  const crmAudienceDraft=env.DASHBOARD_CRM_AUDIENCE_DRAFT==='enabled';
  if(env.DASHBOARD_CRM_AUDIENCE_DRAFT!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_CRM_AUDIENCE_DRAFT)||crmAudienceDraft&&mode!=='operational')throw Error('DASHBOARD_CRM_AUDIENCE_DRAFT invalid');
  const writerMode=env.DASHBOARD_CRM_MANAGED_WRITER||'disabled';
  if(!['disabled','enabled'].includes(writerMode))throw Error('Managed CRM writer mode invalid');
  const crmCampaignSubmitWrite=env.DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE==='enabled';
  if(env.DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE)||crmCampaignSubmitWrite&&(mode!=='operational'||upstreamProfile!=='crm-sandbox'&&writerMode!=='enabled'||crmDraftWrite||crmAudienceDraft))throw Error('DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE invalid');
  const managerHost=env.DASHBOARD_MANAGER_HOST;
  let areaHosts,domains,upstreamConfig,allowedHosts,dynamicRouteManifest;
  try{areaHosts=JSON.parse(env.DASHBOARD_AREA_HOSTS);domains=JSON.parse(env.DASHBOARD_EMAIL_DOMAINS);upstreamConfig=JSON.parse(env.DASHBOARD_UPSTREAMS||'{}');allowedHosts=JSON.parse(env.DASHBOARD_UPSTREAM_HOSTS||'[]');dynamicRouteManifest=JSON.parse(env.DASHBOARD_DYNAMIC_ROUTE_MANIFEST||'null');}catch{throw Error('Dashboard configuration invalid');}
  if(!areaHosts||!domains||!Array.isArray(domains)||!domains.length||!Array.isArray(allowedHosts))throw Error('Dashboard configuration invalid');
  let crmManagedWriter,corporateWriter;
  if(writerMode==='enabled'){
    let descriptor;try{descriptor=JSON.parse(env.DASHBOARD_CRM_WRITER_DESCRIPTOR);}catch{throw Error('Managed writer descriptor invalid');}
    corporateWriter=require('./crm-manager-runtime.cjs').corporateWriterDescriptor(descriptor,{issuerId:env.DASHBOARD_CRM_MANAGER_ISSUER_ID,namespaceId:env.DASHBOARD_CRM_MANAGER_NAMESPACE_ID},domains);
    if(mode!=='operational'||upstreamProfile!=='production'||env.DASHBOARD_CRM_MANAGED_READ!=='enabled'||env.DASHBOARD_CRM_MANAGED_READ_UI!=='enabled'||!crmCampaignSubmitWrite||!require('./crm-manager-runtime.cjs').corporateHostsAllowed(managerHost,areaHosts)||env.DASHBOARD_ADMIN_EMAIL!=='felipebandeira@oaristocrata.com'||!/^[A-Za-z0-9_-]{43,128}$/.test(env.DASHBOARD_CRM_WRITER_PROVISIONER_TOKEN||''))throw Error('Corporate writer configuration invalid');
    crmManagedWriter=Object.freeze({...corporateWriter,provisionerToken:env.DASHBOARD_CRM_WRITER_PROVISIONER_TOKEN});
  }else if(env.DASHBOARD_CRM_WRITER_DESCRIPTOR!==undefined||env.DASHBOARD_CRM_WRITER_PROVISIONER_TOKEN!==undefined)throw Error('Inactive writer material refused');
  const crmCorporateCreate=env.DASHBOARD_CRM_CORPORATE_CREATE==='enabled';
  if(env.DASHBOARD_CRM_CORPORATE_CREATE!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_CRM_CORPORATE_CREATE)||crmCorporateCreate&&(!corporateWriter||!crmCampaignSubmitWrite))throw Error('Corporate campaign create gate invalid');
  const upstreams=validateUpstreams(upstreamConfig,allowedHosts,dynamicRouteManifest,upstreamProfile,{crmCampaignSubmitWrite,...(corporateWriter?{crmCorporateWriter:corporateWriter}:{})});
  if(upstreamProfile==='crm-sandbox'&&(crmDraftWrite||domains.length!==1||domains[0]!=='synthetic.invalid'||!String(env.DASHBOARD_ADMIN_EMAIL).endsWith('@synthetic.invalid')))throw Error('Sandbox identity or write configuration invalid');
  if(mode==='synthetic'&&Object.keys(upstreams).length)throw Error('Synthetic mode cannot configure external upstreams');
  if(mode==='operational'&&!Object.keys(upstreams).length)throw Error('Operational mode needs explicit upstreams');
  const managedMode=env.DASHBOARD_CRM_MANAGED_READ===undefined?'disabled':env.DASHBOARD_CRM_MANAGED_READ;
  if(!['disabled','enabled'].includes(managedMode))throw Error('DASHBOARD_CRM_MANAGED_READ invalid');
  const crmManagedReadUi=env.DASHBOARD_CRM_MANAGED_READ_UI==='enabled';
  if(env.DASHBOARD_CRM_MANAGED_READ_UI!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_CRM_MANAGED_READ_UI)||crmManagedReadUi&&managedMode!=='enabled')throw Error('Managed CRM read UI configuration invalid');
  const crmManagedAudienceRead=env.DASHBOARD_CRM_MANAGED_AUDIENCE_READ==='enabled';
  const crmManagedTemplateRead=env.DASHBOARD_CRM_MANAGED_TEMPLATE_READ==='enabled';
  for(const name of ['DASHBOARD_CRM_MANAGED_AUDIENCE_READ','DASHBOARD_CRM_MANAGED_TEMPLATE_READ'])if(env[name]!==undefined&&!['disabled','enabled'].includes(env[name]))throw Error('Managed CRM parity flag invalid');
  let crmManagedRead;
  if(managedMode==='enabled'){
    if(mode!=='operational'||upstreamProfile!=='production'||crmDraftWrite||crmAudienceDraft||crmCampaignSubmitWrite&&!corporateWriter||(!crmManagedReadUi&&Object.keys(upstreams).length!==1)||!upstreams['crm-read'])throw Error('Managed CRM profile invalid');
    if(crmManagedReadUi)ManagedRead.validateReadUpstreams(upstreams);
    const issuerId=env.DASHBOARD_CRM_MANAGER_ISSUER_ID,namespaceId=env.DASHBOARD_CRM_MANAGER_NAMESPACE_ID,provisionerToken=env.DASHBOARD_CRM_MANAGER_PROVISIONER_TOKEN;
    const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    if(typeof issuerId!=='string'||!uuid.test(issuerId)||typeof namespaceId!=='string'||!uuid.test(namespaceId)||typeof provisionerToken!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(provisionerToken))throw Error('Managed CRM configuration invalid');
    crmManagedRead=Object.freeze({issuerId,namespaceId,provisionerToken});
  }
  if(crmManagedAudienceRead||crmManagedTemplateRead){
    if(!crmManagedRead||!crmManagedReadUi||mode!=='operational'||upstreamProfile!=='production'||crmDraftWrite||crmAudienceDraft||crmCampaignSubmitWrite||corporateWriter)throw Error('Managed CRM parity profile invalid');
    if(crmManagedAudienceRead&&!allowedHosts.includes(new URL(AudienceRead.DESTINATIONS['audience-read']).hostname))throw Error('Managed audience read host not admitted');
    // TODO: admit the exact template listener revision/pins and isolated proofs first.
    // A proposed URL or an environment flag cannot establish backend readiness.
    if(crmManagedTemplateRead)throw Error('Managed template read backend not admitted');
  }
  const port=Number(env.PORT||3000);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
  if(typeof process.getuid==='function'&&env.DASHBOARD_EXPECT_UID&&process.getuid()!==Number(env.DASHBOARD_EXPECT_UID))throw Error('Unexpected runtime UID');
  return {mode,upstreamProfile,crmDraftWrite,crmAudienceDraft,crmCampaignSubmitWrite,crmCorporateCreate,crmManagedReadUi,crmManagedAudienceRead,crmManagedTemplateRead,managerHost,areaHosts,allowedEmailDomains:domains,upstreams,allowedUpstreamHosts:allowedHosts,dynamicRouteManifest,port,host:env.HOST||'127.0.0.1',publicDir:path.resolve(env.DASHBOARD_PUBLIC_DIR||path.join(__dirname,'public')),dbPath:env.DASHBOARD_DB_PATH,bootstrapAdminEmail:env.DASHBOARD_ADMIN_EMAIL,bootstrapTokenSha256:env.DASHBOARD_BOOTSTRAP_SHA256,encryptionKey:env.DASHBOARD_ENCRYPTION_KEY,...(crmManagedRead?{crmManagedRead}:{}),...(crmManagedWriter?{crmManagedWriter}:{})};
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
  if(!file||!/^\/(?:gestao\/index\.html|crm\/index\.html|organico\/index\.html|creators\/index\.html|growth\.html|growth-diagnostico\.html|growth-(?:control|delivery|diagnostic|diagnostic-ui)\.js|media-read\.js|campaign-(?:edit|bff-client)\.js|organico\.html|influs\.html|entry\.(?:js|css)|guard\.js|assets\/panels\/[A-Za-z0-9._-]+\.(?:js|css)|logos\/[A-Za-z0-9._-]+\.(?:png|jpg|svg))$/.test(file))throw jsonError(404,'NOT_FOUND');
  const area=file==='/growth-diagnostico.html'?'growth':Object.entries(AREA_PAGE).find(([,p])=>p===file)?.[0];
  if(area)auth.authorize({cookieHeader:req.headers.cookie,host,method:'GET',area});
  const realRoot=fs.realpathSync(s.publicDir),candidate=path.resolve(realRoot,'.'+file);
  if(!candidate.startsWith(realRoot+path.sep))throw jsonError(404,'NOT_FOUND');
  let data;try{const real=fs.realpathSync(candidate);if(!real.startsWith(realRoot+path.sep)||fs.lstatSync(candidate).isSymbolicLink()||!fs.statSync(candidate).isFile())throw Error();data=fs.readFileSync(candidate);}catch{throw jsonError(404,'NOT_FOUND');}
  const metadata=typeAndCsp(file,data);if(!metadata)throw jsonError(404,'NOT_FOUND');
  res.statusCode=200;res.setHeader('Content-Type',metadata.type);res.setHeader('Content-Security-Policy',metadata.csp);
  res.setHeader('Cache-Control',file.endsWith('.html')?'no-store':'public, max-age=300');res.end(req.method==='HEAD'?undefined:data);
}
function createServer(s,{auth,fetchImpl=fetch,loginBodyTimeoutMs=LOGIN_BODY_TIMEOUT_MS,managedCrmRuntime}={}){
  if(!auth)throw Error('Auth required');
  if(!Number.isInteger(loginBodyTimeoutMs)||loginBodyTimeoutMs<1||loginBodyTimeoutMs>LOGIN_BODY_TIMEOUT_MS)throw Error('Invalid login body timeout');
  const upstreamProfile=s.upstreamProfile||'production',sandbox=upstreamProfile==='crm-sandbox';
  const corporateWriter=s.crmManagedWriter?require('./crm-manager-runtime.cjs').corporateWriterDescriptor(s.crmManagedWriter,s.crmManagedRead,s.allowedEmailDomains):undefined;
  if(corporateWriter&&(!require('./crm-manager-runtime.cjs').corporateHostsAllowed(s.managerHost,s.areaHosts)||s.bootstrapAdminEmail!=='felipebandeira@oaristocrata.com'||s.mode!=='operational'||sandbox||s.crmManagedReadUi!==true))throw Error('Corporate writer profile invalid');
  if(s.crmCampaignSubmitWrite!==undefined&&typeof s.crmCampaignSubmitWrite!=='boolean'||s.crmCampaignSubmitWrite===true&&(!sandbox&&!corporateWriter||s.mode!=='operational'||s.crmDraftWrite===true||s.crmAudienceDraft===true||s.crmManagedRead!==undefined&&!corporateWriter))throw Error('Invalid CRM campaign submit write gate');
  const allowCampaignSubmit=s.crmCampaignSubmitWrite===true;
  const crmCorporateCreate=s.crmCorporateCreate===true;
  if(s.crmCorporateCreate!==undefined&&typeof s.crmCorporateCreate!=='boolean'||crmCorporateCreate&&(!corporateWriter||!allowCampaignSubmit))throw Error('Corporate campaign create gate invalid');
  if(!['production','crm-sandbox'].includes(upstreamProfile)||sandbox&&(s.mode!=='operational'||s.crmDraftWrite===true||s.allowedEmailDomains?.length!==1||s.allowedEmailDomains[0]!=='synthetic.invalid'||!String(s.bootstrapAdminEmail).endsWith('@synthetic.invalid')))throw Error('Invalid sandbox settings');
  const upstreams=s.mode==='operational'?validateUpstreams({...s.upstreams},s.allowedUpstreamHosts,s.dynamicRouteManifest,upstreamProfile,{crmCampaignSubmitWrite:allowCampaignSubmit,...(corporateWriter?{crmCorporateWriter:corporateWriter}:{})}):Object.freeze(Object.create(null));
  if(s.mode==='operational'&&!Object.keys(upstreams).length)throw Error('Operational mode needs explicit upstreams');
  if(s.crmDraftWrite!==undefined&&typeof s.crmDraftWrite!=='boolean'||s.crmDraftWrite===true&&s.mode!=='operational')throw Error('Invalid CRM draft write gate');
  if(s.crmAudienceDraft!==undefined&&typeof s.crmAudienceDraft!=='boolean'||s.crmAudienceDraft===true&&s.mode!=='operational')throw Error('Invalid CRM audience draft gate');
  const allowCampaignDraft=s.mode==='operational'&&s.crmDraftWrite===true;
  const allowAudienceDraft=s.mode==='operational'&&s.crmAudienceDraft===true;
  if(allowCampaignDraft&&!upstreams.campaigns)throw Error('CRM draft write needs pinned campaigns upstream');
  if(allowAudienceDraft&&!upstreams.segments)throw Error('CRM audience draft needs pinned segments upstream');
  // The dedicated CRM credential remains individually attested when this
  // gateway also serves the two reviewed read routes. A writer-family route
  // or either draft gate must never admit that credential through HTTP.
  const crmReadCredentialEligible=s.mode==='operational'&&!sandbox&&Boolean(upstreams['crm-read'])&&!allowCampaignDraft&&!allowAudienceDraft&&
    Object.keys(upstreams).every(route=>['crm-read','cx','influ'].includes(route));
  const crmExclusiveReadProfile=crmReadCredentialEligible&&Object.keys(upstreams).length===1;
  const crmManagedReadUi=s.crmManagedReadUi===true;
  if(s.crmManagedReadUi!==undefined&&typeof s.crmManagedReadUi!=='boolean'||crmManagedReadUi&&(!s.crmManagedRead||s.mode!=='operational'||sandbox||allowCampaignDraft||allowAudienceDraft||allowCampaignSubmit&&!corporateWriter))throw Error('Managed CRM read UI profile invalid');
  if(crmManagedReadUi)ManagedRead.validateReadUpstreams(upstreams);
  const crmManagedAudienceRead=s.crmManagedAudienceRead===true,crmManagedTemplateRead=s.crmManagedTemplateRead===true;
  if(s.crmManagedAudienceRead!==undefined&&typeof s.crmManagedAudienceRead!=='boolean'||s.crmManagedTemplateRead!==undefined&&typeof s.crmManagedTemplateRead!=='boolean')throw Error('Managed CRM parity flag invalid');
  if(crmManagedAudienceRead||crmManagedTemplateRead){
    if(!crmManagedReadUi||!s.crmManagedRead||s.mode!=='operational'||sandbox||allowCampaignDraft||allowAudienceDraft||allowCampaignSubmit||corporateWriter)throw Error('Managed CRM parity profile invalid');
    if(crmManagedAudienceRead&&!s.allowedUpstreamHosts?.includes(new URL(AudienceRead.DESTINATIONS['audience-read']).hostname))throw Error('Managed audience read host not admitted');
    // Template integration remains inert until its listener is reviewed and admitted.
    if(crmManagedTemplateRead)throw Error('Managed template read backend not admitted');
  }
  const managedReadBridge=crmManagedReadUi?ManagedRead.createManagedReadBridge({auth,upstreams,enabled:true},{fetchImpl}):undefined;
  const audienceReadBridge=crmManagedAudienceRead?AudienceRead.createAudienceReadBridge({auth,upstreams:{'audience-read':new URL(AudienceRead.DESTINATIONS['audience-read'])},enabled:true},{fetchImpl}):undefined;
  const templateReadBridge=crmManagedTemplateRead?TemplateRead.createTemplateReadBridge({auth,upstreams:{'template-read':new URL(TemplateRead.DESTINATIONS['template-read'])},enabled:true},{fetchImpl}):undefined;
  if(Boolean(s.crmManagedRead)!==(managedCrmRuntime!==undefined)||managedCrmRuntime!==undefined&&(!crmExclusiveReadProfile&&!crmManagedReadUi||!auth.managedCrmJournal||typeof managedCrmRuntime?.kick!=='function'||typeof managedCrmRuntime?.close!=='function'))throw Error('Managed CRM runtime invalid');
  // Private callbacks run only after the identity method has committed. They
  // cannot block HTTP completion or expose a provisioning exception to a user.
  const kickManagedCrm=()=>{if(managedCrmRuntime)Promise.resolve().then(()=>managedCrmRuntime.kick()).catch(()=>{});};
  const editGrantsAllowed=permissions=>Object.entries(permissions||{}).every(([area,grant])=>grant?.edit!==true||(allowCampaignDraft||allowAudienceDraft||allowCampaignSubmit)&&area==='growth');
  if(allowCampaignSubmit&&typeof auth.campaignDeliveryFor!=='function')throw Error('Campaign writer identity configuration required');
  const campaignTransport=async(context,{method,command})=>{
    const user=auth.authorize({...context,area:'growth',edit:true});
    const credential=auth.getUpstreamCredential({...context,slot:'growth-campaign',area:'growth',edit:true});
    if(!credential)throw jsonError(503,'INDIVIDUAL_CREDENTIAL_MISSING');
    const query=method==='GET'?new URLSearchParams(Object.entries(command).map(([k,v])=>[k,String(v)])):new URLSearchParams();
    return forward({route:'campaigns',method,query,body:method==='POST'?command:undefined,user,credential,upstreams,origin:'https://'+context.host,crmCampaignSubmitWrite:true,...(corporateWriter?{crmCorporateWriter:corporateWriter}:{}),fetchImpl});
  };
  const campaignDelivery=allowCampaignSubmit?auth.campaignDeliveryFor(campaignTransport):null;
  if(allowCampaignSubmit&&typeof auth.campaignCreateFor!=='function')throw Error('Campaign create configuration required');
  const campaignCreator=allowCampaignSubmit?auth.campaignCreateFor(campaignTransport):null;
  const campaignDto=(action,key,value)=>({schema:'crm-campaign-bff-operation-v1',action,attemptKey:key,state:value.state,campaign:value.campaign,validation:value.validation??null});
  const campaignStatus=value=>value.state==='pending'?202:value.state==='rejected'?409:200;
  const audienceFeature=ctx=>{
    if(!sandbox||!allowAudienceDraft)return false;
    try{return auth.audienceDraftReady(ctx)===true;}catch{return false;}
  };
  const allowedHosts=new Set([s.managerHost,...Object.values(s.areaHosts)]);
  const reserveLogin=loginGate();
  let upstreamInFlight=0,crmCacheInFlight=false;const upstreamByUser=new Map();
  const reserveCampaignWork=principal=>{
    if(typeof principal!=='string'||upstreamInFlight>=16||(upstreamByUser.get(principal)||0)>=4)throw jsonError(429,'UPSTREAM_BUSY');
    upstreamInFlight++;upstreamByUser.set(principal,(upstreamByUser.get(principal)||0)+1);
    return ()=>{upstreamInFlight--;const left=upstreamByUser.get(principal)-1;if(left)upstreamByUser.set(principal,left);else upstreamByUser.delete(principal);};
  };
  const reserveCrmCache=res=>{
    if(crmCacheInFlight)throw jsonError(503,'CRM_CACHE_BUSY');
    crmCacheInFlight=true;
    let workDone=false,responseDone=res.destroyed||res.writableFinished,released=false;
    const release=()=>{
      if(released||!workDone||!responseDone)return;
      released=true;crmCacheInFlight=false;
      res.off('finish',onResponse);res.off('close',onResponse);
    };
    const onResponse=()=>{responseDone=true;release();};
    res.once('finish',onResponse);res.once('close',onResponse);
    // A client disconnect alone cannot free the slot while the upstream
    // read/parse still retains the large payload in this process.
    return ()=>{workDone=true;release();};
  };
  const server=http.createServer({maxHeaderSize:8192},(req,res)=>{
    headers(res);
    const handle=async()=>{
      const host=String(req.headers.host||'').toLowerCase();
      if(!allowedHosts.has(host))throw jsonError(421,'HOST_DENIED');
      const url=safeRequestPath(req.url),origin='https://'+host;
      if(url.pathname==='/healthz'&&['GET','HEAD'].includes(req.method))return sendJson(req,res,200,{ok:true,mode:s.mode,...(sandbox?{synthetic:true,upstreamProfile}:{}),identity:true,runtimeUid:typeof process.getuid==='function'?process.getuid():null});
      // Same-origin browser GET fetches may omit Origin. Receipt reads still
      // require the real session's CSRF secret, and may derive their origin
      // only from browser-controlled Fetch Metadata on this allowed host.
      // An explicit foreign Origin or missing metadata never gets this path.
      const browserReadOrigin=req.method==='GET'&&req.headers.origin===undefined&&req.headers['sec-fetch-site']==='same-origin'&&['cors','same-origin'].includes(req.headers['sec-fetch-mode'])&&req.headers['sec-fetch-dest']==='empty'&&typeof req.headers['x-csrf-token']==='string'?origin:undefined;
      const ctx={cookieHeader:req.headers.cookie,host,method:req.method,origin:req.headers.origin??browserReadOrigin,csrf:req.headers['x-csrf-token']};
      if(url.pathname==='/auth/session'&&req.method==='GET'){
        const found=auth.session(ctx),state=found.authenticated?{...found,features:{audienceDraft:audienceFeature(ctx),...(allowCampaignSubmit?{campaignSubmitWrite:auth.campaignWriterReady(ctx),...(corporateWriter?{campaignCreate:crmCorporateCreate&&auth.campaignWriterReady(ctx),campaignHistoryRead:typeof auth.campaignHistoryRead==='function'&&auth.campaignHistoryRead(ctx)===true}:{})}:{})}}:found;
        // The owner view validates invite links against this service's exact
        // host configuration, so a new isolated canary needs no JS allowlist.
        if(state.authenticated&&state.user?.role==='superadmin'&&host===s.managerHost)
          return sendJson(req,res,200,{...state,areaHosts:s.areaHosts});
        return sendJson(req,res,200,state);
      }
      if(url.pathname==='/auth/users'&&req.method==='GET')return sendJson(req,res,200,{users:auth.users({context:ctx})});
      if(url.pathname==='/auth/campaign-create'){
        // Corporate CREATE needs its own explicit gate and the existing FULL
        // individual WRITER authorization; historical GET recovery is unchanged.
        if(!campaignCreator||corporateWriter&&req.method==='POST'&&!crmCorporateCreate)throw jsonError(403,'EDIT_NOT_READY');
        if(!['GET','POST'].includes(req.method))throw jsonError(405,'METHOD_DENIED');
        let q;
        if(req.method==='POST'){
          if(url.search||req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw jsonError(400,'REQUEST_DENIED');
          q=await readJson(req,MAX_CAMPAIGN_REQUEST);
        }else{
          if([...url.searchParams.keys()].some(k=>!['brand','idempotency_key'].includes(k))||url.searchParams.getAll('brand').length!==1||url.searchParams.getAll('idempotency_key').length!==1)throw jsonError(400,'QUERY_DENIED');
          q={brand:url.searchParams.get('brand'),idempotency_key:url.searchParams.get('idempotency_key')};
        }
        const release=reserveCampaignWork(auth.campaignWriterAuthorization(ctx,{brand:q.brand,action:req.method==='POST'?'criar':'operacao_criar'}).userId);
        try{const value=await campaignCreator[req.method==='POST'?'submit':'reconcile'](ctx,q);return sendJson(req,res,campaignStatus(value),campaignDto('campanha_criar',q.idempotency_key,value));}finally{release();}
      }
      if(url.pathname==='/auth/campaign-delivery'&&req.method==='GET'){
        if(!campaignDelivery)throw jsonError(403,'EDIT_NOT_READY');
        if([...url.searchParams.keys()].some(k=>!['brand','idempotency_key'].includes(k))||url.searchParams.getAll('brand').length!==1||url.searchParams.getAll('idempotency_key').length!==1)throw jsonError(400,'QUERY_DENIED');
        const q={brand:url.searchParams.get('brand'),idempotency_key:url.searchParams.get('idempotency_key')},descriptor=campaignDelivery.describe(ctx,q);
        const release=reserveCampaignWork(auth.campaignWriterAuthorization(ctx,{brand:q.brand,action:'operacao'}).userId);
        try{const value=await campaignDelivery.reconcile(ctx,q);return sendJson(req,res,campaignStatus(value),campaignDto(descriptor.action,q.idempotency_key,value));}finally{release();}
      }
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
        if(url.pathname==='/auth/invite/accept'){
          const result=await auth.acceptInvite({token:b.token,password:b.password,host,origin:ctx.origin});
          kickManagedCrm();return sendJson(req,res,200,result);
        }
        if(url.pathname==='/auth/users'){
          if(!b||typeof b!=='object'||Array.isArray(b))throw jsonError(400,'ACTION_DENIED');
          if(b.action==='crm_writer_approve'){
            auth.authorize({...ctx,admin:true});
            if(!corporateWriter||!managedCrmRuntime||typeof auth.approveManagedCampaignWriter!=='function')throw jsonError(403,'EDIT_NOT_READY');
            if(Object.keys(b).length!==2||typeof b.userId!=='string')throw jsonError(400,'ACTION_DENIED');
            const result=auth.approveManagedCampaignWriter({context:ctx,userId:b.userId});
            kickManagedCrm();return sendJson(req,res,202,{...result,state:'provisioning'});
          }
          if(b.action==='crm_writer_renew'){
            auth.authorize({...ctx,admin:true});
            if(!corporateWriter||!managedCrmRuntime||typeof auth.renewManagedCampaignWriter!=='function')throw jsonError(403,'EDIT_NOT_READY');
            if(Object.keys(b).length!==2||typeof b.userId!=='string')throw jsonError(400,'ACTION_DENIED');
            const result=auth.renewManagedCampaignWriter({context:ctx,userId:b.userId});
            kickManagedCrm();return sendJson(req,res,202,result);
          }
          if(b.action==='crm_renew'){
            auth.authorize({...ctx,admin:true});
            if(!managedCrmRuntime||!crmExclusiveReadProfile&&!crmManagedReadUi)throw jsonError(403,'CRM_PROVISIONING_NOT_READY');
            if(Object.keys(b).length!==2||!Object.hasOwn(b,'userId'))throw jsonError(400,'ACTION_DENIED');
            const result=auth.renewManagedCrm({context:ctx,userId:b.userId});
            kickManagedCrm();return sendJson(req,res,202,result);
          }
          if(b.action==='crm_reconcile'){
            auth.authorize({...ctx,admin:true});
            if(!managedCrmRuntime)throw jsonError(403,'CRM_PROVISIONING_NOT_READY');
            if(Object.keys(b).length!==1)throw jsonError(400,'ACTION_DENIED');
            kickManagedCrm();return sendJson(req,res,202,{ok:true});
          }
          if(b.action==='invite'){
            if(b.role!=='manager')throw jsonError(400,'ROLE_DENIED');
            if(!editGrantsAllowed(b.permissions))throw jsonError(403,'EDIT_NOT_READY');
            const invite=auth.createInvite({context:ctx,email:b.email,areas:b.areas,permissions:b.permissions,requestedAccess:b.requestedAccess});
            return sendJson(req,res,201,{userId:invite.userId,inviteUrl:'https://'+invite.host+'/#invite='+encodeURIComponent(invite.token)});
          }
          if(b.action==='revoke'){
            const result=auth.revokeUser({context:ctx,userId:b.userId});
            kickManagedCrm();return sendJson(req,res,200,result);
          }
          if(b.action==='access_request'){const result=auth.setRequestedAccess({context:ctx,userId:b.userId,requestedAccess:b.requestedAccess});kickManagedCrm();return sendJson(req,res,200,result);}
          if(b.action==='grant'){
            if(!editGrantsAllowed(b.permissions))throw jsonError(403,'EDIT_NOT_READY');
            const result=auth.setGrants({context:ctx,userId:b.userId,permissions:b.permissions});kickManagedCrm();return sendJson(req,res,200,result);
          }
          if(b.action==='credential'){
            if(sandbox){
              if(!['growth-read','growth-audience-read','growth-audience'].includes(b.slot)||b.slot==='growth-audience'&&!allowAudienceDraft)throw jsonError(403,'CREDENTIAL_SLOT_DENIED');
              return sendJson(req,res,200,await auth.setSandboxCredential({context:ctx,userId:b.userId,slot:b.slot,bearer:b.bearer,fetchImpl}));
            }
            if(crmExclusiveReadProfile&&b.slot!=='crm-panel-read')throw jsonError(403,'CREDENTIAL_SLOT_DENIED');
            if(b.slot==='crm-panel-read'){
              if(!crmReadCredentialEligible)throw jsonError(403,'CREDENTIAL_ATTESTATION_NOT_READY');
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
        let releaseCacheWork;
        try{
        if(!['GET','POST'].includes(req.method))throw jsonError(405,'METHOD_DENIED');
        const route=url.pathname.slice('/api/'.length);
        if(!/^[a-z0-9_-]{1,48}$/.test(route))throw jsonError(404,'NOT_FOUND');
        if(req.method==='POST'&&req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw jsonError(415,'CONTENT_TYPE_DENIED');
        const body=req.method==='POST'?await readJson(req,route==='campaigns'?MAX_CAMPAIGN_REQUEST:route==='segments'?MAX_AUDIENCE_REQUEST:undefined):undefined;
        const parityAction=req.method==='GET'&&(crmManagedAudienceRead&&Object.hasOwn(AudienceRead.ACTIONS[route]||{},url.searchParams.get('acao'))||crmManagedTemplateRead&&Object.hasOwn(TemplateRead.ACTIONS[route]||{},url.searchParams.get('acao')));
        const parityUser=parityAction?auth.authorize({...ctx,area:'growth',edit:false}):null;
        const individualParity=parityUser?.role==='manager'&&auth.managedCrmJournal.status(parityUser.id)!==null;
        const audienceReadRoute=individualParity&&crmManagedAudienceRead&&Object.hasOwn(AudienceRead.ACTIONS[route]||{},url.searchParams.get('acao'));
        const templateReadRoute=individualParity&&crmManagedTemplateRead&&Object.hasOwn(TemplateRead.ACTIONS[route]||{},url.searchParams.get('acao'));
        const parityDecision=audienceReadRoute?AudienceRead.decision(route,req.method,url.searchParams):templateReadRoute?TemplateRead.decision(route,req.method,url.searchParams):null;
        const d=parityDecision?{...parityDecision,area:'growth',edit:false,credentialSlot:'crm-panel-read'}:decide(route,req.method,url.searchParams,body,{crmCampaignSubmitWrite:allowCampaignSubmit});
        const audienceAction=route==='segments'&&['segmento_criar','segmento_salvar','segmento_arquivar','segmento_operacao'].includes(d.action);
        if(route==='segments'&&d.action==='segmento_contexto_v2')throw jsonError(403,'ACTION_DENIED');
        if(d.edit&&!(allowCampaignSubmit&&route==='campaigns')&&!(allowCampaignDraft&&route==='campaigns'&&['campanha_salvar','campanha_operacao'].includes(d.action))&&!(allowAudienceDraft&&audienceAction))throw jsonError(403,'EDIT_NOT_READY');
        const campaignSubmitRoute=allowCampaignSubmit&&route==='campaigns'&&(d.edit||!corporateWriter);
        const user=parityDecision?parityUser:auth.authorize({...ctx,area:d.area,edit:d.edit||campaignSubmitRoute});
        const managedReadRoute=audienceReadRoute||templateReadRoute||crmManagedReadUi&&user.role==='manager'&&auth.managedCrmJournal.status(user.id)!==null&&Object.hasOwn(ManagedRead.ACTIONS,route);
        const identity=route==='cx'&&url.searchParams.get('access')==='1'||route==='crm-read'&&d.action==='identity';
        if(identity)return sendJson(req,res,200,{schema:'shrigma_access_identity_v1',role:user.role==='superadmin'?'master':'manager',panel:user.role==='superadmin'?'todos':d.area,allowedPanels:user.areas,owner:user.email});
        if(s.mode==='synthetic'){
          const result=fixture(['cx','cache','crm-read'].includes(route)?d.area:route,Object.fromEntries(url.searchParams));
          return sendJson(req,res,200,result);
        }
        // The current CRM UI reads cache_growth through crm-read. Only this
        // explicit synthetic profile translates that validated GET to its
        // already pinned dashboard reader; production keeps its own slot and
        // destination. No additional upstream or credential scope is admitted.
        const sandboxCache=sandbox&&route==='crm-read'&&d.action==='cache_growth';
        const proxyRoute=sandboxCache?'cache':route;
        const proxyQuery=sandboxCache?new URLSearchParams({painel:'growth'}):url.searchParams;
        if(campaignSubmitRoute)auth.campaignWriterAuthorization(ctx,{brand:req.method==='POST'?body.brand:url.searchParams.get('brand'),action:d.action==='campanha_operacao'?'operacao':d.action.replace('campanha_','')});
        const credential=managedReadRoute?null:auth.getUpstreamCredential({...ctx,slot:campaignSubmitRoute?'growth-campaign':sandboxCache?'growth-read':d.credentialSlot,area:d.area,edit:d.edit||campaignSubmitRoute});
        if(allowCampaignDraft&&route==='campaigns'&&d.action==='campanha_salvar'&&!credential)throw jsonError(503,'INDIVIDUAL_CREDENTIAL_MISSING');
        if(audienceAction&&!credential)throw jsonError(503,'INDIVIDUAL_CREDENTIAL_MISSING');
        const principal=user.id;
        if(typeof principal!=='string'||upstreamInFlight>=16||(upstreamByUser.get(principal)||0)>=4)throw jsonError(429,'UPSTREAM_BUSY');
        if(route==='crm-read'&&d.action==='cache_growth')releaseCacheWork=reserveCrmCache(res);
        upstreamInFlight++;upstreamByUser.set(principal,(upstreamByUser.get(principal)||0)+1);
        let result,managedReadSettled,released=false;
        const releaseUpstream=()=>{
          if(released)return;released=true;upstreamInFlight--;
          const remaining=upstreamByUser.get(principal)-1;
          if(remaining)upstreamByUser.set(principal,remaining);else upstreamByUser.delete(principal);
        };
        const draftSave=allowCampaignDraft&&route==='campaigns'&&d.action==='campanha_salvar';
        const draftReceipt=allowCampaignDraft&&route==='campaigns'&&d.action==='campanha_operacao';
        const draftBrand=draftSave?body.brand:draftReceipt?url.searchParams.get('brand'):null;
        const draftKey=draftSave?body.idempotency_key:draftReceipt?url.searchParams.get('idempotency_key'):null;
        try{
          if(campaignSubmitRoute){
            if(req.method==='POST'){
              if(d.action==='campanha_salvar'&&!Object.hasOwn(body,'id'))throw jsonError(403,'EDIT_NOT_READY');
              const command={...body};delete command.k;
              const value=await campaignDelivery.submit(ctx,command);
              return sendJson(req,res,campaignStatus(value),campaignDto(d.action,body.idempotency_key,value));
            }
            if(d.action==='campanha_operacao'){
              const q={brand:url.searchParams.get('brand'),idempotency_key:url.searchParams.get('idempotency_key')},descriptor=campaignDelivery.describe(ctx,q),value=await campaignDelivery.reconcile(ctx,q);
              return sendJson(req,res,campaignStatus(value),campaignDto(descriptor.action,q.idempotency_key,value));
            }
            result=await forward({route,method:'GET',query:url.searchParams,user,credential,upstreams,origin,crmCampaignSubmitWrite:true,fetchImpl});
            return sendJson(req,res,result.status,result.body);
          }
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
          try{result=managedReadRoute?await (audienceReadRoute?audienceReadBridge:templateReadRoute?templateReadBridge:managedReadBridge).read({context:ctx,route,method:req.method,query:url.searchParams,origin},settled=>{managedReadSettled=settled;}):await forward({route:proxyRoute,method:req.method,query:proxyQuery,body,user,credential,upstreams,origin,crmDraftWrite:allowCampaignDraft,sandboxAudienceDraft:audienceFeature(ctx),fetchImpl});}
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
          if(managedReadSettled)managedReadSettled.then(releaseUpstream,releaseUpstream);else releaseUpstream();
        }
        if(crmManagedAudienceRead&&route==='crm-read'&&d.action==='cache_growth'&&result.status===200&&user.role==='manager'&&auth.managedCrmJournal.status(user.id)!==null){
          let ready=false;try{const proof=auth.managedCrmReadAuthorization({...ctx,area:'growth',edit:false});if(proof&&typeof proof.then==='function')Promise.resolve(proof).catch(()=>{});else ready=Boolean(proof);}catch{}
          if(ready)result={...result,body:require('./proxy.cjs').rewriteCapabilities(result.body,upstreams,origin,{route,managedAudienceRead:true})};
        }
        return sendJson(req,res,result.status,result.body);
        }finally{if(releaseCacheWork)releaseCacheWork();}
      }
      return serveFile(req,res,url,host,s,auth);
    };
    handle().catch(error=>{
      if(res.destroyed)return;
      if(res.headersSent)return res.destroy();
      const status=error instanceof AuthError||error instanceof ProxyError||Number.isInteger(error.status)?error.status:500;
      const code=status===500?'INTERNAL_ERROR':error.code||'REQUEST_DENIED';
      if(status===503&&code==='CRM_CACHE_BUSY')res.setHeader('Retry-After','2');
      sendJson(req,res,status,{error:code});
    });
  });
  server.headersTimeout=10000;server.requestTimeout=100000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=200;
  if(managedCrmRuntime){server.once('listening',kickManagedCrm);server.once('close',()=>{Promise.resolve().then(()=>managedCrmRuntime.close()).catch(()=>{});});}
  return server;
}
function authOptionsFor(settings){
  return {dbPath:settings.dbPath,managerHost:settings.managerHost,areaHosts:settings.areaHosts,allowedEmailDomains:settings.allowedEmailDomains,bootstrapAdminEmail:settings.bootstrapAdminEmail,bootstrapTokenSha256:settings.bootstrapTokenSha256,encryptionKey:settings.encryptionKey,...(settings.crmCampaignSubmitWrite===true?{crmCampaignSubmitWrite:true}:{}),...(settings.crmManagedWriter?{crmManagedWriter:require('./crm-manager-runtime.cjs').corporateWriterDescriptor(settings.crmManagedWriter,settings.crmManagedRead,settings.allowedEmailDomains)}:{}),...(settings.crmManagedRead?{crmManagedRead:{issuerId:settings.crmManagedRead.issuerId,namespaceId:settings.crmManagedRead.namespaceId}}:{})};
}
function managedRuntimeFor(settings,auth){
  if(!settings.crmManagedRead)return undefined;
  const {issuerId,namespaceId,provisionerToken}=settings.crmManagedRead;
  const {createManagerRuntime,createWriterManagerRuntime}=require('./crm-manager-runtime.cjs');
  const read=createManagerRuntime({auth,issuerId,namespaceId,provisionerToken,allowedEmailDomains:settings.allowedEmailDomains});
  if(!settings.crmManagedWriter)return read;
  const writer=createWriterManagerRuntime({auth,descriptor:settings.crmManagedWriter,readDescriptor:settings.crmManagedRead,allowedEmailDomains:settings.allowedEmailDomains,provisionerToken:settings.crmManagedWriter.provisionerToken});
  return Object.freeze({kick:()=>Promise.allSettled([read.kick(),writer.kick()]),close:()=>Promise.allSettled([read.close(),writer.close()]).then(()=>undefined)});
}
if(require.main===module){
  try{
    const settings=settingsFromEnv();
    const auth=createAuth(authOptionsFor(settings)),managedCrmRuntime=managedRuntimeFor(settings,auth);
    createServer(settings,{auth,managedCrmRuntime}).listen(settings.port,settings.host,()=>console.log('Dashboard operational service listening'));
  }catch{console.error('Dashboard operational startup refused: invalid configuration');process.exitCode=1;}
}
module.exports={settingsFromEnv,safeRequestPath,fileForHost,createServer,typeAndCsp,authOptionsFor,managedRuntimeFor};
