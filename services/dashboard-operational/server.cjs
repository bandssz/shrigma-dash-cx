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
  const crmNativeMode=env.DASHBOARD_NATIVE_MCP||'disabled';
  if(!['disabled','enabled'].includes(crmNativeMode))throw Error('Native MCP mode invalid');
  const mode=env.DASHBOARD_MODE;if(!['synthetic','operational'].includes(mode))throw Error('DASHBOARD_MODE invalid');
  const upstreamProfile=env.DASHBOARD_UPSTREAM_PROFILE||'production';
  if(!['production','crm-sandbox'].includes(upstreamProfile)||upstreamProfile==='crm-sandbox'&&mode!=='operational')throw Error('DASHBOARD_UPSTREAM_PROFILE invalid');
  const crmDraftWrite=env.DASHBOARD_CRM_DRAFT_WRITE==='enabled';
  if(env.DASHBOARD_CRM_DRAFT_WRITE!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_CRM_DRAFT_WRITE)||crmDraftWrite&&mode!=='operational')throw Error('DASHBOARD_CRM_DRAFT_WRITE invalid');
  const crmAudienceDraft=env.DASHBOARD_CRM_AUDIENCE_DRAFT==='enabled';
  if(env.DASHBOARD_CRM_AUDIENCE_DRAFT!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_CRM_AUDIENCE_DRAFT)||crmAudienceDraft&&mode!=='operational')throw Error('DASHBOARD_CRM_AUDIENCE_DRAFT invalid');
  const crmMasterAudienceRead=env.DASHBOARD_CRM_MASTER_AUDIENCE_READ==='enabled';
  if(env.DASHBOARD_CRM_MASTER_AUDIENCE_READ!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_CRM_MASTER_AUDIENCE_READ)||crmMasterAudienceRead&&(mode!=='operational'||env.DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE!=='own-master-production-v1'||crmAudienceDraft))throw Error('Original Master audience READ configuration invalid');
  const crmMasterAudienceWrite=env.DASHBOARD_CRM_MASTER_AUDIENCE_WRITE==='enabled';
  if(env.DASHBOARD_CRM_MASTER_AUDIENCE_WRITE!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_CRM_MASTER_AUDIENCE_WRITE)||crmMasterAudienceWrite&&!crmMasterAudienceRead)throw Error('Original Master audience WRITE configuration invalid');
  const crmMasterAudienceCount=env.DASHBOARD_CRM_MASTER_AUDIENCE_COUNT==='enabled';
  if(env.DASHBOARD_CRM_MASTER_AUDIENCE_COUNT!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_CRM_MASTER_AUDIENCE_COUNT)||crmMasterAudienceCount&&!crmMasterAudienceWrite)throw Error('Original Master audience COUNT configuration invalid');
  const crmMasterAudienceContextReview=env.DASHBOARD_CRM_MASTER_AUDIENCE_CONTEXT_REVIEW==='enabled';
  if(env.DASHBOARD_CRM_MASTER_AUDIENCE_CONTEXT_REVIEW!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_CRM_MASTER_AUDIENCE_CONTEXT_REVIEW)||crmMasterAudienceContextReview&&!crmMasterAudienceRead)throw Error('Original Master audience CONTEXT READ configuration invalid');
  const crmPublishedJourneyRead=env.DASHBOARD_CRM_PUBLISHED_JOURNEY_READ==='enabled';
  if(env.DASHBOARD_CRM_PUBLISHED_JOURNEY_READ!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_CRM_PUBLISHED_JOURNEY_READ)||crmPublishedJourneyRead&&(mode!=='operational'||upstreamProfile!=='production'||env.DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE!=='own-master-production-v1'))throw Error('Original published journey READ configuration invalid');
  const crmMasterTemplateRead=env.DASHBOARD_CRM_MASTER_TEMPLATE_READ==='enabled';
  if(env.DASHBOARD_CRM_MASTER_TEMPLATE_READ!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_CRM_MASTER_TEMPLATE_READ)||crmMasterTemplateRead&&(!crmPublishedJourneyRead||mode!=='operational'||upstreamProfile!=='production'||env.DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE!=='own-master-production-v1'))throw Error('Original Master template READ configuration invalid');
  const crmNativeSourceSyncEnabled=env.DASHBOARD_NATIVE_SHOPIFY_SOURCE==='enabled';
  const crmNativeSourceDiagnosticsEnabled=env.DASHBOARD_NATIVE_SOURCE_DIAGNOSTICS==='enabled';
  const crmNativeSchedulerBindingEnabled=env.DASHBOARD_NATIVE_SCHEDULER_BINDING==='enabled';
  if(env.DASHBOARD_NATIVE_SCHEDULER_BINDING!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_NATIVE_SCHEDULER_BINDING)||crmNativeSchedulerBindingEnabled&&(crmNativeMode!=='enabled'||mode!=='operational'||upstreamProfile!=='production'||!crmPublishedJourneyRead))throw Error('Original scheduler binding configuration invalid');
  const crmNativeSchedulerStateEnabled=env.DASHBOARD_NATIVE_SCHEDULER_STATE==='enabled';
  if(env.DASHBOARD_NATIVE_SCHEDULER_STATE!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_NATIVE_SCHEDULER_STATE)||crmNativeSchedulerStateEnabled&&(crmNativeMode!=='enabled'||mode!=='operational'||upstreamProfile!=='production'||!crmPublishedJourneyRead))throw Error('Original scheduler state READ configuration invalid');
  const crmNativeDeliveryHealthEnabled=env.DASHBOARD_NATIVE_DELIVERY_HEALTH==='enabled';
  if(env.DASHBOARD_NATIVE_DELIVERY_HEALTH!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_NATIVE_DELIVERY_HEALTH)||crmNativeDeliveryHealthEnabled&&(crmNativeMode!=='enabled'||mode!=='operational'||upstreamProfile!=='production'||!crmPublishedJourneyRead))throw Error('Original delivery health READ configuration invalid');
  if(env.DASHBOARD_NATIVE_SOURCE_DIAGNOSTICS!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_NATIVE_SOURCE_DIAGNOSTICS)||crmNativeSourceDiagnosticsEnabled&&!crmNativeSourceSyncEnabled)throw Error('Original source diagnostic configuration invalid');
  if(env.DASHBOARD_NATIVE_SHOPIFY_SOURCE!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_NATIVE_SHOPIFY_SOURCE)||crmNativeSourceSyncEnabled&&(crmNativeMode!=='enabled'||mode!=='operational'||upstreamProfile!=='production'||!crmMasterAudienceWrite))throw Error('Original Shopify source connection configuration invalid');
  const coexistenceMode=env.DASHBOARD_CRM_INDIVIDUAL_COEXISTENCE||'disabled';
  if(!['disabled','enabled'].includes(coexistenceMode))throw Error('Individual coexistence mode invalid');
  const crmIndividualCoexistence=coexistenceMode==='enabled';
  const writerMode=env.DASHBOARD_CRM_MANAGED_WRITER||'disabled';
  if(!['disabled','enabled'].includes(writerMode))throw Error('Managed CRM writer mode invalid');
  const crmCampaignWriterProfile=env.DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE;
  if(crmCampaignWriterProfile!==undefined&&crmCampaignWriterProfile!=='own-master-production-v1')throw Error('Own Master campaign profile invalid');
  const crmCampaignSubmitWrite=env.DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE==='enabled';
  if(env.DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE)||crmCampaignSubmitWrite&&(mode!=='operational'||upstreamProfile!=='crm-sandbox'&&writerMode!=='enabled'&&!crmCampaignWriterProfile||crmDraftWrite||crmAudienceDraft&&writerMode!=='enabled'))throw Error('DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE invalid');
  const managerHost=env.DASHBOARD_MANAGER_HOST;
  let areaHosts,domains,upstreamConfig,allowedHosts,dynamicRouteManifest;
  try{areaHosts=JSON.parse(env.DASHBOARD_AREA_HOSTS);domains=JSON.parse(env.DASHBOARD_EMAIL_DOMAINS);upstreamConfig=JSON.parse(env.DASHBOARD_UPSTREAMS||'{}');allowedHosts=JSON.parse(env.DASHBOARD_UPSTREAM_HOSTS||'[]');dynamicRouteManifest=JSON.parse(env.DASHBOARD_DYNAMIC_ROUTE_MANIFEST||'null');}catch{throw Error('Dashboard configuration invalid');}
  if(!areaHosts||!domains||!Array.isArray(domains)||!domains.length||!Array.isArray(allowedHosts))throw Error('Dashboard configuration invalid');
  let crmManagedWriter,corporateWriter;
  const ownMasterWriter=crmCampaignWriterProfile?require('./crm-manager-runtime.cjs').ownMasterWriterDescriptor(crmCampaignWriterProfile,domains):undefined;
  if(ownMasterWriter&&(mode!=='operational'||upstreamProfile!=='production'||!crmCampaignSubmitWrite||crmDraftWrite||crmAudienceDraft||!crmIndividualCoexistence&&(writerMode!=='disabled'||env.DASHBOARD_CRM_MANAGED_READ!==undefined&&env.DASHBOARD_CRM_MANAGED_READ!=='disabled'||env.DASHBOARD_CRM_MANAGED_READ_UI!==undefined&&env.DASHBOARD_CRM_MANAGED_READ_UI!=='disabled')||!require('./crm-manager-runtime.cjs').corporateHostsAllowed(managerHost,areaHosts)||env.DASHBOARD_ADMIN_EMAIL!=='felipebandeira@oaristocrata.com'||!crmIndividualCoexistence&&['DASHBOARD_CRM_MANAGER_ISSUER_ID','DASHBOARD_CRM_MANAGER_NAMESPACE_ID','DASHBOARD_CRM_MANAGER_PROVISIONER_TOKEN'].some(k=>env[k]!==undefined)))throw Error('Own Master campaign configuration invalid');
  if(writerMode==='enabled'){
    let descriptor;try{descriptor=JSON.parse(env.DASHBOARD_CRM_WRITER_DESCRIPTOR);}catch{throw Error('Managed writer descriptor invalid');}
    corporateWriter=require('./crm-manager-runtime.cjs').corporateWriterDescriptor(descriptor,{issuerId:env.DASHBOARD_CRM_MANAGER_ISSUER_ID,namespaceId:env.DASHBOARD_CRM_MANAGER_NAMESPACE_ID},domains);
    if(mode!=='operational'||upstreamProfile!=='production'||env.DASHBOARD_CRM_MANAGED_READ!=='enabled'||env.DASHBOARD_CRM_MANAGED_READ_UI!=='enabled'||!crmCampaignSubmitWrite||!require('./crm-manager-runtime.cjs').corporateHostsAllowed(managerHost,areaHosts)||env.DASHBOARD_ADMIN_EMAIL!=='felipebandeira@oaristocrata.com'||!/^[A-Za-z0-9_-]{43,128}$/.test(env.DASHBOARD_CRM_WRITER_PROVISIONER_TOKEN||''))throw Error('Corporate writer configuration invalid');
    crmManagedWriter=Object.freeze({...corporateWriter,provisionerToken:env.DASHBOARD_CRM_WRITER_PROVISIONER_TOKEN});
  }else if(env.DASHBOARD_CRM_WRITER_DESCRIPTOR!==undefined||env.DASHBOARD_CRM_WRITER_PROVISIONER_TOKEN!==undefined)throw Error('Inactive writer material refused');
  const crmCorporateCreate=env.DASHBOARD_CRM_CORPORATE_CREATE==='enabled';
  if(env.DASHBOARD_CRM_CORPORATE_CREATE!==undefined&&!['disabled','enabled'].includes(env.DASHBOARD_CRM_CORPORATE_CREATE)||crmCorporateCreate&&(!corporateWriter&&!ownMasterWriter||!crmCampaignSubmitWrite))throw Error('Corporate campaign create gate invalid');
  const upstreams=validateUpstreams(upstreamConfig,allowedHosts,dynamicRouteManifest,upstreamProfile,{crmCampaignSubmitWrite,crmAudienceDraft,crmMasterAudienceRead,...(corporateWriter||ownMasterWriter?{crmCorporateWriter:crmIndividualCoexistence?ownMasterWriter:corporateWriter||ownMasterWriter}:{})});
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
    if(mode!=='operational'||upstreamProfile!=='production'||crmDraftWrite||crmAudienceDraft&&!corporateWriter||crmCampaignSubmitWrite&&!corporateWriter||(!crmManagedReadUi&&Object.keys(upstreams).length!==1)||!upstreams['crm-read'])throw Error('Managed CRM profile invalid');
    if(crmManagedReadUi)ManagedRead.validateReadUpstreams(corporateWriter&&(crmAudienceDraft||crmIndividualCoexistence&&crmMasterAudienceRead)?Object.fromEntries(Object.entries(upstreams).filter(([route])=>route!=='segments')):upstreams);
    const issuerId=env.DASHBOARD_CRM_MANAGER_ISSUER_ID,namespaceId=env.DASHBOARD_CRM_MANAGER_NAMESPACE_ID,provisionerToken=env.DASHBOARD_CRM_MANAGER_PROVISIONER_TOKEN;
    const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    if(typeof issuerId!=='string'||!uuid.test(issuerId)||typeof namespaceId!=='string'||!uuid.test(namespaceId)||typeof provisionerToken!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(provisionerToken))throw Error('Managed CRM configuration invalid');
    crmManagedRead=Object.freeze({issuerId,namespaceId,provisionerToken});
  }
  if(crmManagedAudienceRead||crmManagedTemplateRead){
    if(!crmManagedRead||!crmManagedReadUi||mode!=='operational'||upstreamProfile!=='production'||crmDraftWrite||crmAudienceDraft&&!corporateWriter||crmCampaignSubmitWrite&&!corporateWriter)throw Error('Managed CRM parity profile invalid');
    if(crmManagedAudienceRead&&!allowedHosts.includes(new URL(AudienceRead.DESTINATIONS['audience-read']).hostname))throw Error('Managed audience read host not admitted');
    // #222 serves the registered_email_only contract through the fixed bridge;
    // its per-request SQL attestation and response validator remain authoritative.
    if(crmManagedTemplateRead&&!allowedHosts.includes(new URL(TemplateRead.DESTINATIONS['template-read']).hostname))throw Error('Managed template read host not admitted');
  }
  if(crmIndividualCoexistence)require('./crm-individual-coexistence.cjs').validate({crmIndividualCoexistence,crmCampaignWriterProfile,crmCampaignSubmitWrite,crmManagedRead,crmManagedWriter,allowedEmailDomains:domains},{requireTokens:true});
  const port=Number(env.PORT||3000);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
  if(typeof process.getuid==='function'&&env.DASHBOARD_EXPECT_UID&&process.getuid()!==Number(env.DASHBOARD_EXPECT_UID))throw Error('Unexpected runtime UID');
  return {mode,...(crmIndividualCoexistence?{crmIndividualCoexistence:true}:{}),...(crmNativeMode==='enabled'?{crmNativeEnabled:true}:{}),...(crmNativeSourceSyncEnabled?{crmNativeSourceSyncEnabled:true}:{}),...(crmNativeSourceDiagnosticsEnabled?{crmNativeSourceDiagnosticsEnabled:true}:{}),...(crmNativeDeliveryHealthEnabled?{crmNativeDeliveryHealthEnabled:true}:{}),...(crmNativeSchedulerBindingEnabled?{crmNativeSchedulerBindingEnabled:true}:{}),...(crmNativeSchedulerStateEnabled?{crmNativeSchedulerStateEnabled:true}:{}),upstreamProfile,crmPublishedJourneyRead,crmMasterTemplateRead,crmDraftWrite,crmAudienceDraft,crmMasterAudienceRead,crmMasterAudienceWrite,crmMasterAudienceCount,crmMasterAudienceContextReview,crmCampaignSubmitWrite,crmCorporateCreate,crmManagedReadUi,crmManagedAudienceRead,crmManagedTemplateRead,managerHost,areaHosts,allowedEmailDomains:domains,upstreams,allowedUpstreamHosts:allowedHosts,dynamicRouteManifest,port,host:env.HOST||'127.0.0.1',publicDir:path.resolve(env.DASHBOARD_PUBLIC_DIR||path.join(__dirname,'public')),dbPath:env.DASHBOARD_DB_PATH,bootstrapAdminEmail:env.DASHBOARD_ADMIN_EMAIL,bootstrapTokenSha256:env.DASHBOARD_BOOTSTRAP_SHA256,encryptionKey:env.DASHBOARD_ENCRYPTION_KEY,...(crmCampaignWriterProfile?{crmCampaignWriterProfile}:{}),...(crmManagedRead?{crmManagedRead}:{}),...(crmManagedWriter?{crmManagedWriter}:{})};
}
// Apply the new bounded READ projection AFTER the immutable existing-grant
// verifier. Its historical pins/controller/consumed operation stay untouched.
function environmentForOriginalMasterCampaignCreate(requested,preserved){
 const flag=requested.DASHBOARD_CRM_CORPORATE_CREATE;
 if(flag!==undefined&&!['enabled','disabled'].includes(flag))throw Error('Original Master campaign CREATE projection invalid');
 if(flag!=='enabled')return preserved;
 const out={...preserved,DASHBOARD_CRM_CORPORATE_CREATE:'enabled'};
 // Called only after the immutable continuity verifier. This opt-in enables
 // the new route; original current writer authorization remains mandatory.
 settingsFromEnv(out);return out;
}
function environmentForOriginalMasterAudienceRead(env){
 const flag=env.DASHBOARD_CRM_MASTER_AUDIENCE_READ;
 if(flag!==undefined&&!['enabled','disabled'].includes(flag))throw Error('Original Master audience READ projection invalid');
 if(flag!=='enabled')return env;
 const P=require('./proxy.cjs');let routes,manifest,hosts;
 try{routes=JSON.parse(env.DASHBOARD_UPSTREAMS);manifest=JSON.parse(env.DASHBOARD_DYNAMIC_ROUTE_MANIFEST);hosts=JSON.parse(env.DASHBOARD_UPSTREAM_HOSTS);}catch{throw Error('Original Master audience READ projection invalid');}
 const expected={schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:P.REVIEWED_DYNAMIC.routes.campaigns}};
 if(env.DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE!=='own-master-production-v1'||Object.keys(routes||{}).sort().join(',')!=='campaigns,crm-read'||routes['crm-read']!==P.FIXED_DESTINATIONS['crm-read']||routes.campaigns!==P.REVIEWED_DYNAMIC.routes.campaigns||JSON.stringify(manifest)!==JSON.stringify(expected)||!Array.isArray(hosts))throw Error('Original Master audience READ projection invalid');
 const audienceHost=new URL(P.REVIEWED_DYNAMIC.routes.segments).hostname;
 const out={...env,DASHBOARD_UPSTREAMS:JSON.stringify({...routes,segments:P.REVIEWED_DYNAMIC.routes.segments}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(hosts.includes(audienceHost)?hosts:[...hosts,audienceHost]),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify({...expected,routes:{...expected.routes,segments:P.REVIEWED_DYNAMIC.routes.segments}})};
 settingsFromEnv(out);return out;
}
// New purpose is projected only after the original continuity verifier.
function environmentForOriginalMasterPublishedJourneyRead(requested,preserved){
 const flag=requested.DASHBOARD_CRM_PUBLISHED_JOURNEY_READ;
 if(flag!==undefined&&!['enabled','disabled'].includes(flag))throw Error('Original published journey READ projection invalid');
 if(flag!=='enabled')return preserved;
 const out={...preserved,DASHBOARD_CRM_PUBLISHED_JOURNEY_READ:'enabled'};settingsFromEnv(out);return out;
}
function environmentForOriginalMasterTemplateRead(requested,preserved){
 const flag=requested.DASHBOARD_CRM_MASTER_TEMPLATE_READ;
 if(flag!==undefined&&!['enabled','disabled'].includes(flag))throw Error('Original Master template READ projection invalid');
 if(flag!=='enabled')return preserved;
 const out={...preserved,DASHBOARD_CRM_MASTER_TEMPLATE_READ:'enabled'};settingsFromEnv(out);return out;
}
// Keep historical operator references private in every browser/native DTO.
// This representation is display/history only; no auth/journal uses it.
function publicAudienceBody(body){
 const project=s=>({...s,updated_by:/^panel:sha256:[a-f0-9]{64}$/.test(s.updated_by)?s.updated_by:'panel:sha256:'+crypto.createHash('sha256').update(s.updated_by).digest('hex')});
 return body?.segment?{...body,segment:project(body.segment)}:Array.isArray(body?.segments)?{...body,segments:body.segments.map(project)}:body;
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
// This CSS is an explicit immutable native asset. The inherited public pack and
// its historical presentation verifier remain unchanged.
function presentationStyle(s){
  const v=s.crmPresentationStyle;if(v===undefined)return null;
  if(s.crmNativeEnabled!==true||!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).sort().join(',')!=='bytes,path,sha256'||typeof v.path!=='string'||!path.isAbsolute(v.path)||path.basename(v.path)!=='crm-presentation.css'||!Number.isSafeInteger(v.bytes)||v.bytes<1||v.bytes>262144||!/^[a-f0-9]{64}$/.test(v.sha256||''))throw jsonError(503,'CRM_PRESENTATION_STYLE_UNAVAILABLE');
  try{const st=fs.lstatSync(v.path);if(fs.realpathSync(v.path)!==v.path||!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size!==v.bytes)throw Error();const data=fs.readFileSync(v.path);if(data.length!==v.bytes||crypto.createHash('sha256').update(data).digest('hex')!==v.sha256)throw Error();return data;}catch{throw jsonError(503,'CRM_PRESENTATION_STYLE_UNAVAILABLE');}
}
function serveFile(req,res,url,host,s,auth){
  if(!['GET','HEAD'].includes(req.method))throw jsonError(405,'METHOD_DENIED');
  const file=fileForHost(url.pathname,host,s);
  if(!file||!/^\/(?:gestao\/index\.html|crm\/index\.html|organico\/index\.html|creators\/index\.html|growth\.html|growth-diagnostico\.html|growth-(?:control|delivery|diagnostic|diagnostic-ui)\.js|media-read\.js|campaign-(?:edit|bff-client)\.js|organico\.html|influs\.html|entry\.(?:js|css)|guard\.js|assets\/panels\/[A-Za-z0-9._-]+\.(?:js|css)|logos\/[A-Za-z0-9._-]+\.(?:png|jpg|svg))$/.test(file))throw jsonError(404,'NOT_FOUND');
  const area=file==='/growth-diagnostico.html'?'growth':Object.entries(AREA_PAGE).find(([,p])=>p===file)?.[0];
  if(area)auth.authorize({cookieHeader:req.headers.cookie,host,method:'GET',area});
  const realRoot=fs.realpathSync(s.publicDir),candidate=path.resolve(realRoot,'.'+file);
  if(!candidate.startsWith(realRoot+path.sep))throw jsonError(404,'NOT_FOUND');
  let data;if(file==='/assets/panels/growth.css'&&s.crmPresentationStyle!==undefined)data=presentationStyle(s);else try{const real=fs.realpathSync(candidate);if(!real.startsWith(realRoot+path.sep)||fs.lstatSync(candidate).isSymbolicLink()||!fs.statSync(candidate).isFile())throw Error();data=fs.readFileSync(candidate);}catch{throw jsonError(404,'NOT_FOUND');}
  const metadata=typeAndCsp(file,data);if(!metadata)throw jsonError(404,'NOT_FOUND');
  res.statusCode=200;res.setHeader('Content-Type',metadata.type);res.setHeader('Content-Security-Policy',metadata.csp);
  res.setHeader('Cache-Control',file.endsWith('.html')?'no-store':'public, max-age=300');res.end(req.method==='HEAD'?undefined:data);
}
// A brand grant is enforced before selecting an individual upstream principal.
// Aggregate payloads have a separate, explicit projection; a client selector
// or an upstream query parameter does not establish that response scope.
const BRAND_ROWS=Object.freeze({
 growth:new Set('crm_diario crm_intradia crm_fluxo crm_conversao crm_carrinho crm_familia_campanha crm_campanha_receita crm_campanha_grupo crm_fontes crm_ab crm_teste crm_testes crm_teste_ab crm_campanha crm_pix crm_utm_orfa crm_arvore_snapshot crm_wa_envios crm_collection_receipt wa_saude wa_fluxo_saude wa_template wa_fluxo'.split(' ')),
 organico:new Set('cx_post cx_story cx_organico_receita cx_conta_dia cx_comentario cx_post_midia cx_post_comentario cx_organico_attribution'.split(' ')),
 influs:new Set('influs cupons roi custos receita_cupom termos receita_link receita_sku escopo historias pedidos'.split(' '))
});
const BRAND_METADATA=new Set(['preview','synthetic','gerado_em','_cache_gerado_em']);
const ATTRIBUTION_ROWS=new Set(['daily','quality','coverage','campaigns','reconciliation','pieces','dispatches','hourly','conv']);
const ATTRIBUTION_METADATA=new Set(['schema_version','window_days','default_model','money_basis','generated_at','basis','checked_at']);
const brandDate=value=>typeof value==='string'&&value.length<=64&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value));
function attributionMetadata(key,value){
 if(['generated_at','checked_at'].includes(key))return value===null||brandDate(value);
 if(key==='schema_version')return value===1||value===2;
 if(key==='window_days')return value===30;
 if(key==='default_model')return ['last_click','last_non_direct'].includes(value);
 if(key==='money_basis')return value==='net_payment_brl';
 if(key==='basis')return ['utm_and_chronology','original_emv_appmax_event'].includes(value);
 return false;
}
const canonicalDataBrand=value=>value==='fish'||value==='fishermans'?'fish':value==='aristo'||value==='aristocrata'?'aristo':value==='olivas'?'olivas':null;
const brandRecord=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const scalar=value=>value===null||typeof value==='boolean'||typeof value==='string'||typeof value==='number'&&Number.isFinite(value);
// Column selection is relation-specific. Matching a brand marker never makes
// an arbitrary scalar field safe: extra revenue/secret fields are omitted.
const rowSpec=(text='',metrics='',dates='',bools='',arrays={})=>Object.freeze({
 ...Object.fromEntries(text.split(' ').filter(Boolean).map(k=>[k,'text'])),
 ...Object.fromEntries(metrics.split(' ').filter(Boolean).map(k=>[k,'metric'])),
 ...Object.fromEntries(dates.split(' ').filter(Boolean).map(k=>[k,'date'])),
 ...Object.fromEntries(bools.split(' ').filter(Boolean).map(k=>[k,'bool'])),...arrays
});
const CACHE_ROW_FIELDS=Object.freeze({
 crm_diario:rowSpec('janela canal utm_medium','enviados entregues abriram clicaram abertos cliques hard complaints descadastros','dia coletado_em'),
 crm_intradia:rowSpec('canal utm_medium','hora pedidos receita cliques','dia coletado_em'),
 crm_fluxo:rowSpec('canal flow piece utm_medium','enviados pedidos_ultimo receita_ultimo pedidos_assistido receita_assistida','dia coletado_em'),
 crm_conversao:rowSpec('canal utm_source utm_medium utm_campaign utm_content utm_term','pedidos_ultimo receita_ultimo pedidos_assistido receita_assistida clientes_novos clientes_recorrentes','dia coletado_em'),
 crm_carrinho:rowSpec('','carrinhos valor_em_jogo com_consent voltaram_72h receita_voltaram recuperados receita_recuperada','dia coletado_em'),
 crm_familia_campanha:rowSpec('utm_campaign familia','', 'coletado_em'),
 crm_campanha_receita:rowSpec('canal','campanha_id pedidos receita assistidos receita_assistida','coletado_em','utm_ambiguo'),
 crm_campanha_grupo:rowSpec('grupo canal','pedidos receita assistidos receita_assistida','coletado_em','utm_ambiguo',{campanha_ids:'ids'}),
 crm_fontes:rowSpec('source fonte canal utm_source utm_medium tipo status','pedidos receita cliques cadencia_seg','dia coletado_em'),
 crm_campanha:rowSpec('nome canal status tipo familia','campanha_id enviados publico entregues abriram clicaram abertos cliques hard complaints','enviado_em agendado_em coletado_em','medido medido_clique truncado',{segmentos:'strings',tags:'strings'}),
 crm_pix:rowSpec('estado canal','pedidos receita aceitos entregues','dia coletado_em'),
 crm_utm_orfa:rowSpec('utm_source utm_medium utm_campaign utm_content utm_term canal','pedidos receita cliques','dia coletado_em'),
 crm_wa_envios:rowSpec('flow piece canal','registros aceitos enviados_provedor entregues lidos falhas falhas_reportadas erros_sincronos pendentes_entrega sem_disparo_confirmado conflitos_status','dia coletado_em ultimo_registro_em ultimo_status_em'),
 crm_collection_receipt:rowSpec('source','pages','checked_at observed_at'),
 wa_saude:rowSpec('chave estado nome','erros ocorrencias total','coletado_em checked_at verificado_em alerta_desde'),
 wa_fluxo_saude:rowSpec('chave estado flow piece nome','erros ocorrencias total n_aceites n_gatilho n_saida','coletado_em checked_at verificado_em alerta_desde'),
 wa_template:rowSpec('name status category channel','enviados entregues lidos falhas','coletado_em checked_at'),
 wa_fluxo:rowSpec('flow piece estado canal','enviados aceitos entregues falhas','coletado_em checked_at'),
 // These candidate CRM relations have no admitted column contract. They
 // are omitted below, including empty arrays; a marker alone is not data.
 crm_ab:rowSpec(),crm_teste:rowSpec(),crm_testes:rowSpec(),crm_teste_ab:rowSpec(),crm_arvore_snapshot:rowSpec(),
 cx_post:rowSpec('rede conta post_id tipo legenda','alcance curtidas comentarios salvos compartilhamentos','dia publicado_em coletado_em'),
 cx_story:rowSpec('rede conta story_id tipo','alcance respostas saidas','dia publicado_em coletado_em'),
 cx_organico_receita:rowSpec('rede canal','pedidos receita','dia coletado_em'),
 cx_conta_dia:rowSpec('rede conta','seguidores alcance','dia coletado_em'),
 cx_comentario:rowSpec(),cx_post_midia:rowSpec(),cx_post_comentario:rowSpec(),cx_organico_attribution:rowSpec(),
 influs:rowSpec('influ nome handle nicho modelo','comissao_pct','','ativo'),
 cupons:rowSpec('codigo tipo influ','','','ativo'),
 roi:rowSpec('influ','receita custo roi'),custos:rowSpec('influ','custo'),receita_cupom:rowSpec('influ codigo','pedidos receita'),
 termos:rowSpec(),receita_link:rowSpec('influ','pedidos receita'),receita_sku:rowSpec('influ sku','pedidos receita'),escopo:rowSpec(),historias:rowSpec(),pedidos:rowSpec()
});
const ATTRIBUTION_ROW_FIELDS=Object.freeze({
 daily:rowSpec('model grain','pedidos receita assistidos receita_assistida novos recorrentes','dia','',{dimension:'strings'}),
 quality:rowSpec('model evidence','pedidos_lidos pagos_elegiveis jornada_pendente jornada_parcial atribuidos_crm receita_elegivel pedidos receita candidatos_posteriores_a_visita pagos_com_ultima_sessao pagos_sem_ultima_sessao receita_sem_ultima_sessao pagos_sem_origem_nao_direta','dia leitura_mais_antiga coletado_em'),
 coverage:rowSpec('','', 'day checked_at'),
 // UTM membership is the closed SQL tuple from crm_growth_campaign_members_v2.
 campaigns:Object.freeze({...CACHE_ROW_FIELDS.crm_campanha,utms:'utm-tuples'}),
 reconciliation:rowSpec('model','pagos_elegiveis origem_desconhecida credito_crm direto_outros receita_elegivel','dia'),
 hourly:rowSpec('model canal','hora pedidos receita','dia'),
 conv:CACHE_ROW_FIELDS.crm_conversao,
 pieces:CACHE_ROW_FIELDS.crm_campanha_receita,
 dispatches:CACHE_ROW_FIELDS.crm_campanha,
 dispatch_daily:rowSpec('model','campanha_id pedidos receita novos recorrentes enviados','dia'),
 pix_daily:rowSpec('','pedidos_com_cobranca_registrada pedidos_cobranca_original_paga sem_confirmacao_cobranca','dia ultimo_evento_pagamento','comprova_incrementalidade conciliacao_final')
});
const REQUIRED_CRM_CART_FIELDS=Object.freeze('dia carrinhos valor_em_jogo com_consent voltaram_72h receita_voltaram recuperados receita_recuperada'.split(' '));
const UTM_TUPLE_FIELDS=Object.freeze(['source','medium','campaign','content','term']);
function selectedRowProjection(value,type){
 if(type==='utm-tuples'&&value!==null)return value.map(tuple=>Object.fromEntries(UTM_TUPLE_FIELDS.map(key=>[key,tuple[key]])));
 return value;
}
function selectedRowField(value,type){
 if(value===null)return true;
 if(type==='text')return typeof value==='string'&&value.length<=500&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
 if(type==='metric')return typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&/^-?[0-9]{1,16}(?:\.[0-9]{1,6})?$/.test(value);
 if(type==='date')return typeof value==='string'&&value.length<=64&&/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)&&Number.isFinite(Date.parse(value));
 if(type==='bool')return typeof value==='boolean';
 if(type==='strings')return Array.isArray(value)&&value.length<=100&&value.every(v=>typeof v==='string'&&v.length<=500&&!/[\x00-\x1f\x7f]/.test(v));
 if(type==='utm-tuples')return Array.isArray(value)&&value.length<=200&&value.every(tuple=>brandRecord(tuple)&&UTM_TUPLE_FIELDS.every(key=>Object.hasOwn(tuple,key)&&typeof tuple[key]==='string'&&selectedRowField(tuple[key],'text')));
 if(type==='ids')return Array.isArray(value)&&value.length<=100&&value.every(v=>Number.isSafeInteger(v)&&v>0);
 return false;
}
function brandedRows(rows,brand,fields,relation){
 if(!Array.isArray(rows)||!fields)throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');
 const out=[];
 for(const row of rows){
  if(!brandRecord(row))throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');
  const markers=['brand','marca'].filter(k=>Object.hasOwn(row,k)),brands=markers.map(k=>canonicalDataBrand(row[k]));
  if(!markers.length||brands.some(b=>!b)||brands.some(b=>b!==brands[0]))throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');
  if(brands[0]!==brand)continue;
  if(relation==='crm_carrinho'&&(REQUIRED_CRM_CART_FIELDS.some(key=>!Object.hasOwn(row,key))||REQUIRED_CRM_CART_FIELDS.filter(key=>!['recuperados','receita_recuperada'].includes(key)).some(key=>row[key]===null)))throw jsonError(503,'BRAND_READ_CONTRACT_NOT_READY');
  // G.carrinho uses the recovery count to decide whether revenue is measured.
  // A mismatched pair would silently turn unknown revenue into a numeric zero.
  if(relation==='crm_carrinho'&&(row.recuperados===null)!==(row.receita_recuperada===null))throw jsonError(503,'BRAND_READ_CONTRACT_NOT_READY');
  const projected=Object.fromEntries(markers.map(k=>[k,brand]));let selected=0;
  for(const [key,type]of Object.entries(fields))if(Object.hasOwn(row,key)){
   if(!selectedRowField(row[key],type))throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');
   projected[key]=selectedRowProjection(row[key],type);selected++;
  }
  if(!selected)throw jsonError(503,'BRAND_READ_CONTRACT_NOT_READY');
  out.push(projected);
 }
 return out;
}
function attributionProjection(value,brand,depth=0,section='root'){
 if(depth>4||!brandRecord(value))throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');
 const out={};
 for(const [key,item]of Object.entries(value)){
  if(ATTRIBUTION_ROWS.has(key)){
   const spec=section==='pix_charge'&&key==='daily'?'pix_daily':section==='dispatch_evidence'&&key==='daily'?'dispatch_daily':key;
   out[key]=brandedRows(item,brand,ATTRIBUTION_ROW_FIELDS[spec]);
  }else if(ATTRIBUTION_METADATA.has(key)&&attributionMetadata(key,item))out[key]=item;
  else if(['dispatch_evidence','pix_charge'].includes(key))out[key]=attributionProjection(item,brand,depth+1,key);
 }
 return out;
}
function capabilityProjection(value,origin,{templateReadAdmitted=false,audienceReadAdmitted=false,isolatedSandbox=false,brand}={}){
 if(!brandRecord(value))return {};
 const out={},families=new Set(['templates','campaigns','segments','campaign_audience','ab_experiment','workflows','email_test','journey_graph']),flags=new Set(['read','view','get','list','catalog','status','identity','print','read_content','list_history','write','save','draft','validate','submit','schedule','cancel','operation','bind','release','inspect','count','send','enabled','create','upload','editor','dispatch']);
 for(const [key,item]of Object.entries(value)){
  if(flags.has(key)&&typeof item==='boolean')out[key]=item;
  else if(key==='endpoints'&&brandRecord(item)){
   out.endpoints={};for(const [name,url]of Object.entries(item))if(typeof url==='string'&&url===origin+'/api/'+(name==='read'?'crm-read':name)&&Object.hasOwn(require('./proxy.cjs').READ,name==='read'?'crm-read':name))out.endpoints[name]=url;
  }else if(families.has(key)&&brandRecord(item)){
   const projected={};for(const [flag,enabled]of Object.entries(item))if(flags.has(flag)&&typeof enabled==='boolean')projected[flag]=enabled;
   if(key==='templates'&&templateReadAdmitted===true&&item.read_contract==='crm-template-read-v1')projected.read_contract='crm-template-read-v1';
   if(key==='segments'&&(audienceReadAdmitted===true||isolatedSandbox===true)&&item.contract_version===AudienceContract.VERSION)projected.contract_version=AudienceContract.VERSION;
   if(['fish','aristo'].includes(brand)&&Array.isArray(item.brands)&&item.brands.length<=2&&item.brands.every(b=>['fish','aristo'].includes(b))&&item.brands.includes(brand))projected.brands=[brand];
   if(Object.keys(projected).length)out[key]=projected;
  }
 }
 return out;
}
function projectBrandCache(value,brand,area,origin,{templateReadAdmitted=false,audienceReadAdmitted=false,isolatedSandbox=false}={}){
 if(!brandRecord(value)||!['fish','aristo'].includes(brand)||!Object.hasOwn(BRAND_ROWS,area))throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');
 const out={brand,brands:[brand],brandAccess:'single',_escopo:area,_painel:area,crm_credencial:[]};let contract=false;
 for(const [key,item]of Object.entries(value)){
  if(BRAND_ROWS[area].has(key)){
   const fields=CACHE_ROW_FIELDS[key];
   if(area==='growth'&&(!fields||!Object.keys(fields).length))continue;
   out[key]=brandedRows(item,brand,fields,key);contract=true;
  }
  else if(BRAND_METADATA.has(key)&&(['preview','synthetic'].includes(key)?typeof item==='boolean':brandDate(item)))out[key]=item;
  else if(area==='growth'&&key==='crm_attribution'){out[key]=attributionProjection(item,brand);contract=true;}
  else if(area==='growth'&&key==='_attribution_legacy')out[key]=attributionProjection(item,brand);
  else if(key==='capabilities')out[key]=capabilityProjection(item,origin,{templateReadAdmitted,audienceReadAdmitted,isolatedSandbox,brand});
 }
 if(!contract)throw jsonError(503,'BRAND_READ_CONTRACT_NOT_READY');
 return out;
}
function projectCampaignRecord(value,brand){
 if(!brandRecord(value)||value.definition?.brand!==brand||!Number.isSafeInteger(value.id)||value.id<1)throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');
 const out={id:value.id,definition:{brand}},definition=value.definition;
 const fields={version:'text',status:'text',sent:'metric',started_at:'date',send_at:'date'};
 for(const [key,type]of Object.entries(fields))if(Object.hasOwn(value,key)){
  if(!selectedRowField(value[key],type))throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');out[key]=value[key];
 }
 const texts=new Set(['schema_version','channel','utm_campaign','name','subject','from_email','reply_to','html','text']);
 for(const key of texts)if(Object.hasOwn(definition,key)){
  const v=definition[key],max=key==='html'?300000:key==='text'?100000:1000;
  if(typeof v!=='string'||v.length>max)throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');out.definition[key]=v;
 }
 for(const [key,type]of Object.entries({list_ids:'ids',tags:'strings',send_at:'date',template_id:'metric'}))if(Object.hasOwn(definition,key)){
  if(!selectedRowField(definition[key],type))throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');out.definition[key]=definition[key];
 }
 if(Object.hasOwn(definition,'initiative')){
  if(!brandRecord(definition.initiative)||!selectedRowField(definition.initiative.key,'text')||!selectedRowField(definition.initiative.name,'text'))throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');
  out.definition.initiative={key:definition.initiative.key,name:definition.initiative.name};
 }
 return out;
}
// The already admitted crm-sandbox profile speaks the legacy audience API,
// without the production private bridge's freshness proof. Validate this
// closed synthetic response locally; it grants no production admission.
function validateSandboxAudienceRead(body,action,brand,query,credential){
 const denied=()=>{throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');};
 const exact=(v,keys)=>brandRecord(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
 const bool=v=>typeof v==='boolean',positive=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
 const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),text=(v,max=500)=>typeof v==='string'&&v.length<=max;
 const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':brandRecord(v)?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
 const encoded=JSON.stringify(body);
 if(Buffer.byteLength(encoded)>2000000||typeof credential!=='string'||!credential||encoded.toLowerCase().includes(credential.toLowerCase()))denied();
 const segment=s=>{
  if(!exact(s,['id','brand','name','definition','version','archived','created_at','updated_at','updated_by','semantic_context'])||!text(s.id,36)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s.id)||s.brand!==brand||!positive(s.version)||s.version>999999999||!bool(s.archived)||!brandDate(s.created_at)||!brandDate(s.updated_at)||!text(s.updated_by,200)||!/^panel:[A-Za-z0-9_.:-]{1,194}$/.test(s.updated_by)||!exact(s.semantic_context,['currency','timezone','current'])||!bool(s.semantic_context.current)||s.semantic_context.currency!==null&&(typeof s.semantic_context.currency!=='string'||!/^[A-Z]{3}$/.test(s.semantic_context.currency))||s.semantic_context.timezone!==null&&!text(s.semantic_context.timezone,100))return false;
  try{const d=AudienceContract.normalize(s.definition);return d.brand===brand&&d.name===s.name&&canonical(d)===canonical(s.definition);}catch{return false;}
 };
 const catalog=c=>{
  if(!brandRecord(c))return false;
  if(!exact(c,['brand','current','currency','timezone','shop_id','fields','products','origins','lists','coverage','checked_at','catalog_hash',...(Object.hasOwn(c,'recorded_origins')?['recorded_origins']:[]),...(Object.hasOwn(c,'shopify_snapshot')?['shopify_snapshot']:[])])||c.brand!==brand||!bool(c.current)||c.coverage!=='unconfirmed'||!brandDate(c.checked_at)||!hash(c.catalog_hash)||c.currency!==null&&(typeof c.currency!=='string'||!/^[A-Z]{3}$/.test(c.currency))||c.shop_id!==null&&(typeof c.shop_id!=='string'||!/^gid:\/\/shopify\/Shop\/[1-9]\d{0,19}$/.test(c.shop_id))||c.timezone!==null&&!text(c.timezone,100))return false;
  if(c.timezone!==null)try{new Intl.DateTimeFormat('en',{timeZone:c.timezone});}catch{return false;}
  const rows=(v,max,key,check)=>Array.isArray(v)&&v.length<=max&&new Set(v.map(x=>x?.[key])).size===v.length&&v.every(check);
  if(!rows(c.fields,Object.keys(AudienceContract.FIELDS).length,'key',f=>exact(f,['key','available','source_hash'])&&Object.hasOwn(AudienceContract.FIELDS,f.key)&&bool(f.available)&&(f.source_hash===null||hash(f.source_hash))&&(!f.available||f.source_hash!==null))||!rows(c.lists,1000,'id',l=>exact(l,['id','brand','name','available'])&&positive(l.id)&&l.brand===brand&&text(l.name)&&bool(l.available))||!rows(c.products,1000,'id',p=>exact(p,['id','brand','name','available'])&&p.brand===brand&&typeof p.id==='string'&&/^gid:\/\/shopify\/Product\/[1-9]\d{0,19}$/.test(p.id)&&text(p.name)&&bool(p.available))||!rows(c.origins,3,'key',o=>exact(o,['key','brand','name','available','provenance_hash'])&&['popup','vip_alma','vip_desodorante'].includes(o.key)&&o.brand===brand&&text(o.name)&&bool(o.available)&&(o.provenance_hash===null||hash(o.provenance_hash))&&(!o.available||o.provenance_hash!==null)))return false;
  if(Object.hasOwn(c,'recorded_origins')){
   if(!AudienceContract.recordedOriginsValid(c.recorded_origins,brand))return false;
   for(const o of c.recorded_origins){const pinned={contract:'crm-recorded-origin-exists-v1',brand:o.brand,origin:o.key,scope_id:o.scope_id,producer_id:o.producer_id,producer_revision:o.producer_revision,coverage_started_at:o.coverage_started_at};if(o.provenance_hash!==crypto.createHash('sha256').update(canonical(pinned)).digest('hex'))return false;}
  }
  if(Object.hasOwn(c,'shopify_snapshot')){
   const v=c.shopify_snapshot;
   if(!brandRecord(v)||!bool(v.current)||!(exact(v,['current'])&&!v.current||exact(v,['current','started_at','observed_at','expires_at'])&&[v.started_at,v.observed_at,v.expires_at].every(brandDate)&&Date.parse(v.started_at)<=Date.parse(v.observed_at)&&Date.parse(v.expires_at)-Date.parse(v.started_at)===93600000))return false;
  }
  return true;
 };
 if(action==='segmentos_listar'){
  const limit=Number(query.get('limit')||50),offset=Number(query.get('offset')||0);
  if(!exact(body,['segments','limit','offset','catalog','capabilities'])||body.limit!==limit||body.offset!==offset||!Array.isArray(body.segments)||body.segments.length>limit||!body.segments.every(segment)||!catalog(body.catalog)||!exact(body.capabilities,['draft','count','send'])||!bool(body.capabilities.draft)||body.capabilities.count!==false||body.capabilities.send!==false||!body.catalog.current&&body.capabilities.draft)denied();
 }else if(action==='segmento_obter'){
  if(!exact(body,['segment'])||!segment(body.segment)||body.segment.id.toLowerCase()!==query.get('id')?.toLowerCase())denied();
 }else throw jsonError(503,'BRAND_READ_CONTRACT_NOT_READY');
 return body;
}
function validateScopedRead(body,route,action,brand,query,credential,{isolatedSandbox=false,corporateAudience=false,contentProfile=false}={}){
 if(!brandRecord(body))throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');
 if((isolatedSandbox||corporateAudience)&&route==='segments')return validateSandboxAudienceRead(body,action,brand,query,credential);
 if(route==='campaigns_media'){
  try{return require('./crm-media-read-validator.cjs').validateMediaLibraryResponse(body,{brand,page:Number(query.get('page')||1),per_page:Number(query.get('per_page')||24),secrets:[credential]}).body;}catch{throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');}
 }
 if(route==='campaigns'){
  if(action==='campanha_catalogo'){
   if(body.brand!==brand||!Array.isArray(body.lists)||!Array.isArray(body.templates)||!Array.isArray(body.initiatives))throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');
   // Only the private current SQL/IAM proof admits the exclusive ownership
   // catalogue. A brand field in a response alone cannot establish authority.
   if(!isolatedSandbox&&!contentProfile&&(body.templates.length||body.initiatives.length))throw jsonError(503,'BRAND_CATALOG_SCOPE_NOT_READY');
   const lists=brandedRows(body.lists,brand,rowSpec('name','id','','available'));
   if(lists.length!==body.lists.length)throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');
   let out;
   if(isolatedSandbox){
    // This pre-existing constructor profile pins an isolated synthetic host,
    // synthetic.invalid identity and closed routes. These fields exercise its
    // test engine; they establish no production template ownership.
    const columns=(rows,spec)=>rows.map(row=>{
     if(!brandRecord(row)||['brand','marca'].some(k=>Object.hasOwn(row,k)&&canonicalDataBrand(row[k])!==brand))throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');
     const value={};for(const [key,type]of Object.entries(spec))if(Object.hasOwn(row,key)){
      if(!selectedRowField(row[key],type))throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');value[key]=row[key];
     }return value;
    });
    out={brand,current:body.current===true,lists,templates:columns(body.templates,rowSpec('name type version','id','','available')),initiatives:columns(body.initiatives,rowSpec('utm_campaign key'))};
   }else if(contentProfile){
    if(body.template_ownership_contract!==require('./crm-campaign-content-profile.cjs').TEMPLATE_CONTRACT||typeof body.current!=='boolean'||body.templates.length>10000||body.initiatives.length>10000)throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');
    const seen=new Set(),templates=body.templates.map(t=>{if(!brandRecord(t)||Object.keys(t).sort().join(',')!=='available,brand,id,name,type,version'||t.brand!==brand||t.type!=='campaign'||t.available!==true||!Number.isSafeInteger(t.id)||t.id<1||seen.has(t.id)||typeof t.name!=='string'||t.name.length>500||!/^[a-f0-9]{32}$/.test(t.version||''))throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');seen.add(t.id);return{id:t.id,name:t.name,brand,type:'campaign',available:true,version:t.version};});
    const initiatives=body.initiatives.map(i=>{if(!brandRecord(i)||Object.keys(i).sort().join(',')!=='key,utm_campaign'||!selectedRowField(i.key,'text')||!selectedRowField(i.utm_campaign,'text'))throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');return{key:i.key,utm_campaign:i.utm_campaign};});
    out={brand,current:body.current,lists,templates,initiatives,template_ownership_contract:body.template_ownership_contract,template_selection_available:templates.length>0};
   }else out={brand,current:false,lists,templates:[],initiatives:[],template_selection_available:false,write:false,scope_status:'catalog_ownership_unavailable'};
   if(brandDate(body.read_at))out.read_at=body.read_at;
   return out;
  }
  if(action==='campanha_listar'){
   if(!Array.isArray(body.campaigns))throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');
   return{campaigns:body.campaigns.map(v=>projectCampaignRecord(v,brand))};
  }
  if(action==='campanha_obter'){
   const campaign=projectCampaignRecord(body.campaign,brand);if(campaign.id!==Number(query.get('id')))throw jsonError(502,'BRAND_RESPONSE_UNSCOPED');return{campaign};
  }
  throw jsonError(503,'BRAND_READ_CONTRACT_NOT_READY');
 }
 // Saved-audience rows have their own exact bridge validator; the broad legacy
 // response without that admission is unavailable to a single-brand manager.
 throw jsonError(503,'BRAND_READ_CONTRACT_NOT_READY');
}
async function templateOwnershipWriteGate(user,action,{isolatedSandbox=false,admit}={}){
 if(!isolatedSandbox&&user.role==='manager'&&['campanha_criar','campanha_salvar','campanha_validar','campanha_agendar','criar'].includes(action)){
  if(typeof admit!=='function')throw jsonError(503,'BRAND_TEMPLATE_OWNERSHIP_NOT_READY');await admit();
 }
}
function createServer(s,{auth,fetchImpl=fetch,loginBodyTimeoutMs=LOGIN_BODY_TIMEOUT_MS,managedCrmRuntime,nativeInstaller,sourcePeerTransport,sourceDiagnostics,deliveryHealth,schedulerState}={}){
  if(!auth)throw Error('Auth required');
  if(!Number.isInteger(loginBodyTimeoutMs)||loginBodyTimeoutMs<1||loginBodyTimeoutMs>LOGIN_BODY_TIMEOUT_MS)throw Error('Invalid login body timeout');
  const coexistence=require('./crm-individual-coexistence.cjs').validate(s,{requireTokens:true});
  const upstreamProfile=s.upstreamProfile||'production',sandbox=upstreamProfile==='crm-sandbox';
  const corporateWriter=s.crmManagedWriter?require('./crm-manager-runtime.cjs').corporateWriterDescriptor(s.crmManagedWriter,s.crmManagedRead,s.allowedEmailDomains):undefined;
  const ownMasterWriter=s.crmCampaignWriterProfile!==undefined?require('./crm-manager-runtime.cjs').ownMasterWriterDescriptor(s.crmCampaignWriterProfile,s.allowedEmailDomains):undefined,campaignWriter=coexistence?ownMasterWriter:corporateWriter||ownMasterWriter;
  if(ownMasterWriter&&(s.mode!=='operational'||sandbox||s.crmCampaignSubmitWrite!==true||s.crmDraftWrite===true||s.crmAudienceDraft===true||!coexistence&&(s.crmManagedRead!==undefined||s.crmManagedWriter!==undefined||s.crmManagedReadUi===true||s.crmManagedAudienceRead===true||s.crmManagedTemplateRead===true)||!require('./crm-manager-runtime.cjs').corporateHostsAllowed(s.managerHost,s.areaHosts)||s.bootstrapAdminEmail!=='felipebandeira@oaristocrata.com'))throw Error('Own Master campaign profile invalid');
  if(corporateWriter&&(!require('./crm-manager-runtime.cjs').corporateHostsAllowed(s.managerHost,s.areaHosts)||s.bootstrapAdminEmail!=='felipebandeira@oaristocrata.com'||s.mode!=='operational'||sandbox||s.crmManagedReadUi!==true))throw Error('Corporate writer profile invalid');
  if(s.crmCampaignSubmitWrite!==undefined&&typeof s.crmCampaignSubmitWrite!=='boolean'||s.crmCampaignSubmitWrite===true&&(!sandbox&&!campaignWriter||s.mode!=='operational'||s.crmDraftWrite===true||s.crmAudienceDraft===true&&!corporateWriter||s.crmManagedRead!==undefined&&!corporateWriter))throw Error('Invalid CRM campaign submit write gate');
  const crmPublishedJourneyRead=s.crmPublishedJourneyRead===true;
  if(s.crmPublishedJourneyRead!==undefined&&typeof s.crmPublishedJourneyRead!=='boolean'||crmPublishedJourneyRead&&(!ownMasterWriter||typeof auth.ownMasterPublishedJourneyReadBinding!=='function'||typeof auth.ownMasterPublishedJourneyReadReady!=='function'))throw Error('Original published journey READ profile invalid');
  const publishedJourneyReader=crmPublishedJourneyRead?require('./crm-published-journey-read.cjs').createReader({authorize:(ctx,q)=>auth.ownMasterPublishedJourneyReadBinding(ctx,q),fetchImpl}):null;
  if(s.crmNativeSchedulerBindingEnabled!==undefined&&typeof s.crmNativeSchedulerBindingEnabled!=='boolean'||s.crmNativeSchedulerBindingEnabled===true&&(s.crmNativeEnabled!==true||s.mode!=='operational'||sandbox||!ownMasterWriter||!crmPublishedJourneyRead||!auth.nativeSchedulerBinding?.enabled))throw Error('Original scheduler binding profile invalid');
  if(s.crmNativeSchedulerStateEnabled!==undefined&&typeof s.crmNativeSchedulerStateEnabled!=='boolean'||s.crmNativeSchedulerStateEnabled===true&&(s.crmNativeEnabled!==true||s.mode!=='operational'||sandbox||!ownMasterWriter||!crmPublishedJourneyRead||!auth.nativeSchedulerStateConsent||schedulerState?.enabled!==true))throw Error('Original scheduler state READ profile invalid');
  if(s.crmNativeDeliveryHealthEnabled!==undefined&&typeof s.crmNativeDeliveryHealthEnabled!=='boolean'||s.crmNativeDeliveryHealthEnabled===true&&(s.crmNativeEnabled!==true||s.mode!=='operational'||sandbox||!ownMasterWriter||!crmPublishedJourneyRead))throw Error('Original delivery health READ profile invalid');
  const crmMasterTemplateRead=s.crmMasterTemplateRead===true;
  if(s.crmMasterTemplateRead!==undefined&&typeof s.crmMasterTemplateRead!=='boolean'||crmMasterTemplateRead&&(!ownMasterWriter||!crmPublishedJourneyRead))throw Error('Original Master template READ profile invalid');
  // The CURRENT original read_content owner binding is reused; no new slot, actor or grant.
  const masterTemplateReader=crmMasterTemplateRead?require('./crm-master-template-read.cjs').createReader({authorize:(ctx,q)=>auth.ownMasterPublishedJourneyReadBinding(ctx,q),fetchImpl}):null;
  const crmMasterAudienceRead=s.crmMasterAudienceRead===true;
  if(s.crmMasterAudienceRead!==undefined&&typeof s.crmMasterAudienceRead!=='boolean'||crmMasterAudienceRead&&(!ownMasterWriter||s.crmAudienceDraft===true||typeof auth.ownMasterAudienceReadBinding!=='function'||typeof auth.ownMasterAudienceReadReady!=='function'))throw Error('Original Master audience READ profile invalid');
  const crmMasterAudienceWrite=s.crmMasterAudienceWrite===true;
  if(s.crmMasterAudienceWrite!==undefined&&typeof s.crmMasterAudienceWrite!=='boolean'||crmMasterAudienceWrite&&(!crmMasterAudienceRead||!ownMasterWriter||typeof auth.ownMasterAudienceWriteBinding!=='function'||typeof auth.audienceWriterAuthorization!=='function'))throw Error('Original Master audience WRITE profile invalid');
  const crmMasterAudienceCount=s.crmMasterAudienceCount===true;
  if(s.crmMasterAudienceCount!==undefined&&typeof s.crmMasterAudienceCount!=='boolean'||crmMasterAudienceCount&&!crmMasterAudienceWrite)throw Error('Original Master audience COUNT profile invalid');
  const crmMasterAudienceContextReview=s.crmMasterAudienceContextReview===true;
  if(s.crmMasterAudienceContextReview!==undefined&&typeof s.crmMasterAudienceContextReview!=='boolean'||crmMasterAudienceContextReview&&!crmMasterAudienceRead)throw Error('Original Master audience CONTEXT READ profile invalid');
  const allowCampaignSubmit=s.crmCampaignSubmitWrite===true;
  const crmCorporateCreate=s.crmCorporateCreate===true;
  if(s.crmCorporateCreate!==undefined&&typeof s.crmCorporateCreate!=='boolean'||crmCorporateCreate&&(!campaignWriter||!allowCampaignSubmit))throw Error('Corporate campaign create gate invalid');
  if(!['production','crm-sandbox'].includes(upstreamProfile)||sandbox&&(s.mode!=='operational'||s.crmDraftWrite===true||s.allowedEmailDomains?.length!==1||s.allowedEmailDomains[0]!=='synthetic.invalid'||!String(s.bootstrapAdminEmail).endsWith('@synthetic.invalid')))throw Error('Invalid sandbox settings');
  const upstreams=s.mode==='operational'?validateUpstreams({...s.upstreams},s.allowedUpstreamHosts,s.dynamicRouteManifest,upstreamProfile,{crmCampaignSubmitWrite:allowCampaignSubmit,crmAudienceDraft:s.crmAudienceDraft===true,crmMasterAudienceRead,...(campaignWriter?{crmCorporateWriter:coexistence?ownMasterWriter:campaignWriter}:{})}):Object.freeze(Object.create(null));
  if(s.mode==='operational'&&!Object.keys(upstreams).length)throw Error('Operational mode needs explicit upstreams');
  if(s.crmDraftWrite!==undefined&&typeof s.crmDraftWrite!=='boolean'||s.crmDraftWrite===true&&s.mode!=='operational')throw Error('Invalid CRM draft write gate');
  if(s.crmAudienceDraft!==undefined&&typeof s.crmAudienceDraft!=='boolean'||s.crmAudienceDraft===true&&s.mode!=='operational')throw Error('Invalid CRM audience draft gate');
  const allowCampaignDraft=s.mode==='operational'&&s.crmDraftWrite===true;
  const allowAudienceDraft=s.mode==='operational'&&(s.crmAudienceDraft===true||crmMasterAudienceWrite);
  if(allowCampaignDraft&&!upstreams.campaigns)throw Error('CRM draft write needs pinned campaigns upstream');
  if(crmMasterAudienceRead&&!upstreams.segments)throw Error('Original Master audience READ needs pinned segments upstream');
  if(allowAudienceDraft&&!upstreams.segments)throw Error('CRM audience draft needs pinned segments upstream');
  // The dedicated CRM credential remains individually attested when this
  // gateway also serves the two reviewed read routes. A writer-family route
  // or either draft gate must never admit that credential through HTTP.
  const crmReadCredentialEligible=s.mode==='operational'&&!sandbox&&Boolean(upstreams['crm-read'])&&!allowCampaignDraft&&!allowAudienceDraft&&
    Object.keys(upstreams).every(route=>['crm-read','cx','influ'].includes(route));
  const crmExclusiveReadProfile=crmReadCredentialEligible&&Object.keys(upstreams).length===1;
  const crmManagedReadUi=s.crmManagedReadUi===true;
  if(s.crmManagedReadUi!==undefined&&typeof s.crmManagedReadUi!=='boolean'||crmManagedReadUi&&(!s.crmManagedRead||s.mode!=='operational'||sandbox||allowCampaignDraft||allowAudienceDraft&&!corporateWriter||allowCampaignSubmit&&!corporateWriter))throw Error('Managed CRM read UI profile invalid');
  const managedReadUpstreams=corporateWriter&&(allowAudienceDraft||coexistence&&crmMasterAudienceRead)?Object.fromEntries(Object.entries(upstreams).filter(([route])=>route!=='segments')):upstreams;
  if(crmManagedReadUi)ManagedRead.validateReadUpstreams(managedReadUpstreams);
  const crmManagedAudienceRead=s.crmManagedAudienceRead===true,crmManagedTemplateRead=s.crmManagedTemplateRead===true;
  if(s.crmManagedAudienceRead!==undefined&&typeof s.crmManagedAudienceRead!=='boolean'||s.crmManagedTemplateRead!==undefined&&typeof s.crmManagedTemplateRead!=='boolean')throw Error('Managed CRM parity flag invalid');
  if(crmManagedAudienceRead||crmManagedTemplateRead){
    if(!crmManagedReadUi||!s.crmManagedRead||s.mode!=='operational'||sandbox||allowCampaignDraft||allowAudienceDraft&&!corporateWriter||allowCampaignSubmit&&!corporateWriter)throw Error('Managed CRM parity profile invalid');
    if(crmManagedAudienceRead&&!s.allowedUpstreamHosts?.includes(new URL(AudienceRead.DESTINATIONS['audience-read']).hostname))throw Error('Managed audience read host not admitted');
    if(crmManagedTemplateRead&&!s.allowedUpstreamHosts?.includes(new URL(TemplateRead.DESTINATIONS['template-read']).hostname))throw Error('Managed template read host not admitted');
  }
  const contentAdmission=corporateWriter&&upstreams.campaigns?require('./crm-campaign-content-admission.cjs').createContentAdmission({auth,corporateWriter,upstreams},{fetchImpl}):null;
  const managedReadBridge=crmManagedReadUi?ManagedRead.createManagedReadBridge({auth,upstreams:managedReadUpstreams,enabled:true},{fetchImpl}):undefined;
  const audienceReadBridge=crmManagedAudienceRead?AudienceRead.createAudienceReadBridge({auth,upstreams:{'audience-read':new URL(AudienceRead.DESTINATIONS['audience-read'])},enabled:true},{fetchImpl}):undefined;
  const templateReadBridge=crmManagedTemplateRead?TemplateRead.createTemplateReadBridge({auth,upstreams:{'template-read':new URL(TemplateRead.DESTINATIONS['template-read'])},enabled:true},{fetchImpl}):undefined;
  if(Boolean(s.crmManagedRead)!==(managedCrmRuntime!==undefined)||managedCrmRuntime!==undefined&&(!crmExclusiveReadProfile&&!crmManagedReadUi||!auth.managedCrmJournal||typeof managedCrmRuntime?.kick!=='function'||typeof managedCrmRuntime?.close!=='function'))throw Error('Managed CRM runtime invalid');
  // Private callbacks run only after the identity method has committed. They
  // cannot block HTTP completion or expose a provisioning exception to a user.
  function managedReadReady(ctx,user){try{const proof=auth.managedCrmReadAuthorization({...ctx,method:'GET',area:'growth',brand:user.brand,edit:false});if(proof&&typeof proof.then==='function'){Promise.resolve(proof).catch(()=>{});return false;}return Boolean(proof);}catch{return false;}}
  const kickManagedCrm=()=>{if(managedCrmRuntime)Promise.resolve().then(()=>managedCrmRuntime.kick()).catch(()=>{});};
  const editGrantsAllowed=permissions=>Object.entries(permissions||{}).every(([area,grant])=>grant?.edit!==true||(allowCampaignDraft||allowAudienceDraft||allowCampaignSubmit)&&area==='growth');
  if(allowCampaignSubmit&&typeof auth.campaignDeliveryFor!=='function')throw Error('Campaign writer identity configuration required');
  const campaignTransport=async(context,{method,command})=>{
    const brandedContext={...context,brand:command.brand};
    const user=auth.authorizeBrand({...brandedContext,area:'growth',edit:true},command.brand);
    if(method==='POST')await templateOwnershipWriteGate(user,command.acao,{isolatedSandbox:sandbox,admit:contentAdmission?()=>contentAdmission.requireWrite(context,{brand:command.brand}):undefined});
    const credential=auth.getUpstreamCredential({...brandedContext,slot:'growth-campaign',area:'growth',edit:true});
    if(!credential)throw jsonError(503,'INDIVIDUAL_CREDENTIAL_MISSING');
    const query=method==='GET'?new URLSearchParams(Object.entries(command).map(([k,v])=>[k,String(v)])):new URLSearchParams();
    return forward({route:'campaigns',method,query,body:method==='POST'?command:undefined,user,credential,upstreams,origin:'https://'+context.host,crmCampaignSubmitWrite:true,...(campaignWriter?{crmCorporateWriter:coexistence&&user.role==='manager'?corporateWriter:campaignWriter}:{}),fetchImpl});
  };
  const campaignDelivery=allowCampaignSubmit?auth.campaignDeliveryFor(campaignTransport):null;
  if(allowCampaignSubmit&&typeof auth.campaignCreateFor!=='function')throw Error('Campaign create configuration required');
  const campaignCreator=allowCampaignSubmit?auth.campaignCreateFor(campaignTransport):null;
  const campaignDto=(action,key,value)=>({schema:'crm-campaign-bff-operation-v1',action,attemptKey:key,state:value.state,campaign:value.campaign,validation:value.validation??null});
  const campaignStatus=value=>value.state==='pending'?202:value.state==='rejected'?409:200;
  const audienceFeature=ctx=>{
    if(coexistence&&auth.session(ctx).user?.role==='manager'&&s.crmAudienceDraft!==true)return false;
    if(!allowAudienceDraft||!sandbox&&!corporateWriter&&!crmMasterAudienceWrite)return false;
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
  if(s.crmNativeEnabled!==undefined&&typeof s.crmNativeEnabled!=='boolean'||s.crmNativeEnabled===true&&!auth.nativeConnections)throw Error('Native MCP identity configuration required');
  let nativeMcp;
  const dispatch=(req,res,nativeContext)=>{
    headers(res);
    const handle=async()=>{
      const host=String(req.headers.host||'').toLowerCase();
      if(!allowedHosts.has(host))throw jsonError(421,'HOST_DENIED');
      const url=safeRequestPath(req.url),origin='https://'+host;
      if(url.pathname==='/healthz'&&['GET','HEAD'].includes(req.method)){
        const journeyPublicFiles=s.crmJourneyPresentationManifestSha256?['growth.html','assets/panels/growth.js',...(s.crmPresentationStyle?['assets/panels/growth.css']:[])].map(file=>{
          if(file==='assets/panels/growth.css'){const b=presentationStyle(s);return {path:file,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};}
          const root=fs.realpathSync(s.publicDir),p=path.join(root,file),st=fs.lstatSync(p);
          if(!st.isFile()||st.isSymbolicLink()||st.size>2*1024*1024||fs.realpathSync(p)!==p)throw jsonError(503,'JOURNEY_PUBLIC_FILES_UNAVAILABLE');
          const b=fs.readFileSync(p);return {path:file,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};
        }):undefined;
        return sendJson(req,res,200,{ok:true,mode:s.mode,...(sandbox?{synthetic:true,upstreamProfile}:{}),identity:true,...(s.crmNativeEnabled===true?{nativeMcp:true,nativeBackendManifestSha256:s.crmNativeManifestSha256,...(s.crmJourneyPresentationManifestSha256?{journeyPresentationManifestSha256:s.crmJourneyPresentationManifestSha256,journeyConfiguredRead:true,journeyPublicFiles}:{}),...(s.crmNativeDatabaseInspection===true?{nativeDatabaseInspection:true}:{})}:{}),runtimeUid:typeof process.getuid==='function'?process.getuid():null});
      }
      // Same-origin browser GET fetches may omit Origin. Receipt reads still
      // require the real session's CSRF secret, and may derive their origin
      // only from browser-controlled Fetch Metadata on this allowed host.
      // An explicit foreign Origin or missing metadata never gets this path.
      const browserReadOrigin=req.method==='GET'&&req.headers.origin===undefined&&req.headers['sec-fetch-site']==='same-origin'&&['cors','same-origin'].includes(req.headers['sec-fetch-mode'])&&req.headers['sec-fetch-dest']==='empty'&&typeof req.headers['x-csrf-token']==='string'?origin:undefined;
      if(!nativeContext&&nativeMcp&&await nativeMcp.handle(req,res,url))return;
      const ctx=nativeContext||{cookieHeader:req.headers.cookie,host,method:req.method,origin:req.headers.origin??browserReadOrigin,csrf:req.headers['x-csrf-token']};
      if(s.crmNativeEnabled===true&&!nativeContext&&await require('./crm-native-operator.cjs').handleOperator({req,res,url,ctx,auth,managerHost:s.managerHost}))return;
       if(s.crmNativeEnabled===true&&!nativeContext&&await require('./native-database-operator.cjs').handleDatabaseOperator({req,res,url,ctx,auth,managerHost:s.managerHost,nativeInstaller}))return;
      if(s.crmNativeSourceSyncEnabled===true&&!nativeContext&&await require('./native-source-operator.cjs').handleSourceOperator({req,res,url,ctx,auth,managerHost:s.managerHost,source:auth.nativeSourceSync,diagnostics:s.crmNativeSourceDiagnosticsEnabled===true?sourceDiagnostics:undefined}))return;
      if(s.crmNativeSchedulerBindingEnabled===true&&!nativeContext&&await require('./native-scheduler-binding-operator.cjs').handleSchedulerBindingOperator({req,res,url,ctx,auth,managerHost:s.managerHost}))return;
      if(url.pathname==='/api/scheduler-binding-status'){
        if(s.crmNativeSchedulerBindingEnabled!==true||!nativeContext||req.method!=='GET'||url.search)throw jsonError(403,'SCHEDULER_NATIVE_READ_REQUIRED');
        return sendJson(req,res,200,require('./native-scheduler-binding-operator.cjs').schedulerBindingStatus(auth,ctx));
      }
      if(['/auth/scheduler-state','/auth/scheduler-state-settings','/auth/scheduler-state.js'].includes(url.pathname)){
        if(s.crmNativeSchedulerStateEnabled!==true||schedulerState?.enabled!==true)throw jsonError(503,'SCHEDULER_STATE_NOT_ADMITTED');
        if(host!==s.managerHost||nativeContext||ctx.nativeBearer!==undefined||url.search)throw jsonError(403,'SCHEDULER_STATE_BROWSER_REQUIRED');
        auth.authorize({...ctx,admin:true});
        res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
        res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
        if(url.pathname!=='/auth/scheduler-state-settings'){
          if(req.method!=='GET')throw jsonError(405,'METHOD_DENIED');
          const operator=require('./native-scheduler-state-operator.cjs');
          res.setHeader('Content-Type',url.pathname==='/auth/scheduler-state'?'text/html; charset=utf-8':'text/javascript; charset=utf-8');
          if(url.pathname==='/auth/scheduler-state.js'){res.end(operator.SCHEDULER_STATE_JS);return;}
          const session=auth.session(ctx);
          // Listing native connections requires the original browser POST and CSRF.
          // The page loads that list through the existing protected operator API.
          res.end(operator.renderSchedulerStateOperator({csrf:session.csrf,connections:[]}));return;
        }
        if(req.method!=='POST')throw jsonError(405,'METHOD_DENIED');
        if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'||req.headers['content-encoding'])throw jsonError(415,'CONTENT_TYPE_DENIED');
        const body=await readJson(req,4096);
        if(!body||Object.getPrototypeOf(body)!==Object.prototype||Object.keys(body).sort().join(',')!=='action,connectionId,consent'||body.action!=='authorize'||body.consent!==true)throw jsonError(400,'SCHEDULER_STATE_ARGUMENTS_REFUSED');
        return sendJson(req,res,200,await schedulerState.authorize({context:ctx,connectionId:body.connectionId,consent:true}));
      }
      if(url.pathname==='/api/scheduler-state-receipt'){
        if(s.crmNativeSchedulerStateEnabled!==true||schedulerState?.enabled!==true)throw jsonError(503,'SCHEDULER_STATE_NOT_ADMITTED');
        if(host!==s.managerHost||ctx.nativeBearer===undefined)throw jsonError(403,'SCHEDULER_STATE_NATIVE_REQUIRED');
        auth.authorize({...ctx,admin:true});
        if(req.method!=='GET')throw jsonError(405,'METHOD_DENIED');
        if(url.search)throw jsonError(400,'SCHEDULER_STATE_ARGUMENTS_REFUSED');
        const result=await schedulerState.nativeReadReceipt({context:ctx});
        return sendJson(req,res,result.status,result.body);
      }
      if(s.crmNativeDeliveryHealthEnabled===true&&!nativeContext&&await require('./native-delivery-health-operator.cjs').handleDeliveryHealthOperator({req,res,url,ctx,auth,managerHost:s.managerHost,health:deliveryHealth}))return;
      if(url.pathname==='/api/delivery-health-receipts'){
        if(s.crmNativeDeliveryHealthEnabled!==true||deliveryHealth?.enabled!==true)throw jsonError(503,'DELIVERY_HEALTH_NOT_ADMITTED');
        if(host!==s.managerHost||ctx.nativeBearer===undefined)throw jsonError(403,'DELIVERY_HEALTH_NATIVE_REQUIRED');
        auth.authorize({...ctx,admin:true});
        if(req.method!=='GET')throw jsonError(405,'METHOD_DENIED');
        if(url.search)throw jsonError(400,'DELIVERY_HEALTH_ARGUMENTS_INVALID');
        return sendJson(req,res,200,await deliveryHealth.nativeStatusReceipts({context:ctx}));
      }
      if(url.pathname==='/api/delivery-health'){
        if(s.crmNativeDeliveryHealthEnabled!==true||deliveryHealth?.enabled!==true)throw jsonError(503,'DELIVERY_HEALTH_NOT_ADMITTED');
        if(host!==s.managerHost||ctx.nativeBearer===undefined)throw jsonError(403,'DELIVERY_HEALTH_NATIVE_REQUIRED');
        auth.authorize({...ctx,admin:true});
        if(req.method!=='GET')throw jsonError(405,'METHOD_DENIED');
        const keys=[...url.searchParams.keys()];
        if(keys.length!==1||keys[0]!=='brand'||!['fish','aristo'].includes(url.searchParams.get('brand')))throw jsonError(400,'DELIVERY_HEALTH_ARGUMENTS_INVALID');
        return sendJson(req,res,200,await deliveryHealth.inspect({context:ctx,brand:url.searchParams.get('brand')}));
      }
      if(url.pathname==='/api/source-diagnostics'){
        if(s.crmNativeSourceDiagnosticsEnabled!==true||sourceDiagnostics?.enabled!==true)throw jsonError(503,'SOURCE_DIAGNOSTICS_NOT_ADMITTED');
        if(host!==s.managerHost||ctx.nativeBearer===undefined)throw jsonError(403,'SOURCE_DIAGNOSTICS_NATIVE_REQUIRED');
        auth.authorize({...ctx,admin:true});
        if(req.method!=='GET')throw jsonError(405,'METHOD_DENIED');
        const keys=[...url.searchParams.keys()];
        if(keys.length!==2||keys.sort().join(',')!=='brand,requestId')throw jsonError(400,'SOURCE_DIAGNOSTICS_ARGUMENTS_INVALID');
        return sendJson(req,res,200,await sourceDiagnostics.inspect({context:ctx,brand:url.searchParams.get('brand'),requestId:url.searchParams.get('requestId')}));
      }
      if(url.pathname==='/api/source-peer'&&req.method==='GET'){
        if(s.crmNativeSourceSyncEnabled!==true||url.search||host!==s.managerHost)throw jsonError(503,'SOURCE_CONNECTION_NOT_ADMITTED');
        auth.authorize({...ctx,admin:true});
        const brands=ctx.nativeBearer?auth.nativeConnections.authenticate(ctx.nativeBearer,{scope:'crm.read'}).brands:['fish','aristo'];
        const before=auth.ownMasterAudienceReadBinding(ctx,{brand:brands[0]});
        let peer;
        try{
          const transport=sourcePeerTransport||require('./native-source-transport.cjs').createOriginalSourceTransport();
          const r=await transport({method:'GET',path:'/healthz'}),b=r.body;
          if(r.status!==200||r.revision!=='79861de6f9c3628885e7840858011180b5af9899'||!b||Object.keys(b).sort().join(',')!=='enabled,product_semantics,revision,service,stopping'||b.service!=='crm-shopify-sync'||b.revision!==r.revision||b.enabled!==true||b.product_semantics!=='v2'||b.stopping!==false)throw Error('SOURCE_PEER_UNCONFIRMED');
          peer={schema:'crm-native-source-peer-v1',reachable:true,revision:r.revision,productSemantics:'v2',keyAuthenticationProven:false,operational:false};
        }catch{peer={schema:'crm-native-source-peer-v1',reachable:false,code:'SOURCE_PEER_UNCONFIRMED',keyAuthenticationProven:false,operational:false};}
        const after=auth.ownMasterAudienceReadBinding(ctx,{brand:brands[0]});if(before.userId!==after.userId||before.binding!==after.binding)throw jsonError(409,'SOURCE_ORIGINAL_MASTER_CHANGED');
        return sendJson(req,res,200,peer);
      }
      if(url.pathname==='/api/source-sync'){
        if(s.crmNativeSourceSyncEnabled!==true||!auth.nativeSourceSync)throw jsonError(503,'SOURCE_CONNECTION_NOT_ADMITTED');
        if(host!==s.managerHost)throw jsonError(403,'HOST_DENIED');
        auth.authorize({...ctx,admin:true});
        const source=auth.nativeSourceSync;
        if(req.method==='GET'){
          const keys=[...url.searchParams.keys()],action=url.searchParams.get('action');
          if(new Set(keys).size!==keys.length)throw jsonError(400,'SOURCE_ARGUMENTS_INVALID');
          if(['status','list'].includes(action)&&keys.length===1)return sendJson(req,res,200,await source[action](ctx));
          if(action==='inspect'&&keys.sort().join(',')==='action,brand,requestId')return sendJson(req,res,200,await source.inspect({context:ctx,brand:url.searchParams.get('brand'),requestId:url.searchParams.get('requestId')}));
          throw jsonError(400,'SOURCE_ARGUMENTS_INVALID');
        }
        if(req.method!=='POST')throw jsonError(405,'METHOD_DENIED');
        if(url.search||req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'||req.headers['content-encoding'])throw jsonError(415,'CONTENT_TYPE_DENIED');
        const body=await readJson(req,2048);
        if(!body||Object.getPrototypeOf(body)!==Object.prototype||Object.keys(body).sort().join(',')!=='action,brand,requestId'||body.action!=='run')throw jsonError(400,'SOURCE_ARGUMENTS_INVALID');
        return sendJson(req,res,200,await source.run({context:ctx,brand:body.brand,requestId:body.requestId}));
      }
      if(url.pathname==='/auth/session'&&req.method==='GET'){
        const initial=auth.session(ctx),admission=initial.authenticated&&initial.user?.role==='manager'&&initial.user.areas?.join(',')==='growth'&&contentAdmission?await contentAdmission.inspect(ctx,{brand:initial.user.brand}):{read:false,write:false};
        const found=auth.session(ctx);
        if(initial.authenticated&&(!found.authenticated||found.user.id!==initial.user.id||found.user.email!==initial.user.email||found.user.brand!==initial.user.brand))return sendJson(req,res,200,{authenticated:false});
        const state=found.authenticated?{...found,features:{templateRead:found.user?.role==='manager'&&coexistence?crmManagedTemplateRead&&managedReadReady(ctx,found.user):crmMasterTemplateRead&&auth.ownMasterPublishedJourneyReadReady(ctx),publishedJourneyRead:crmPublishedJourneyRead&&auth.ownMasterPublishedJourneyReadReady(ctx),nativeSourceSync:s.crmNativeSourceSyncEnabled===true&&!!auth.nativeSourceSync,nativeSourceDiagnostics:s.crmNativeSourceDiagnosticsEnabled===true&&sourceDiagnostics?.enabled===true,nativeDeliveryHealth:s.crmNativeDeliveryHealthEnabled===true&&deliveryHealth?.enabled===true,nativeSchedulerBinding:s.crmNativeSchedulerBindingEnabled===true&&auth.nativeSchedulerBinding?.enabled===true,nativeSchedulerState:s.crmNativeSchedulerStateEnabled===true&&schedulerState?.enabled===true,audienceDraft:audienceFeature(ctx),audienceRead:found.user?.role==='manager'&&coexistence?crmManagedAudienceRead&&managedReadReady(ctx,found.user):crmMasterAudienceRead&&auth.ownMasterAudienceReadReady(ctx),audienceCount:crmMasterAudienceCount&&audienceFeature(ctx),audienceContextReview:crmMasterAudienceContextReview&&auth.ownMasterAudienceReadReady(ctx),...(ownMasterWriter?{crmIndividualAccessUnavailable:!coexistence,...(coexistence?{crmIndividualCoexistence:true,operational:false}: {})}:{}),...(allowCampaignSubmit?{campaignSubmitWrite:(sandbox||found.user?.role==='superadmin'||admission.write)&&auth.campaignWriterReady(ctx),campaignTemplateOwnershipUnavailable:!sandbox&&found.user?.role==='manager'&&!admission.read,...(campaignWriter?{campaignMasterActivation:found.user?.role==='superadmin'&&found.user?.permissions?.growth?.read===true,campaignCreate:(sandbox||found.user?.role==='superadmin'||admission.write)&&crmCorporateCreate&&auth.campaignWriterReady(ctx),campaignHistoryRead:typeof auth.campaignHistoryRead==='function'&&auth.campaignHistoryRead(ctx)===true}:{})}:{})}}:found;
        // The owner view validates invite links against this service's exact
        // host configuration, so a new isolated canary needs no JS allowlist.
        if(state.authenticated&&state.user?.role==='superadmin'&&host===s.managerHost)
          return sendJson(req,res,200,{...state,areaHosts:s.areaHosts});
        return sendJson(req,res,200,state);
      }
      if(url.pathname==='/auth/master/campaign-writer/activate'){
        if(req.method!=='POST')throw jsonError(405,'METHOD_DENIED');
        auth.authorize({...ctx,admin:true});
        if(!campaignWriter||!allowCampaignSubmit||typeof auth.activateOwnMasterCampaignWriter!=='function')throw jsonError(403,'EDIT_NOT_READY');
        if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw jsonError(415,'CONTENT_TYPE_DENIED');
        const body=await readJson(req,256);
        if(url.search||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==0)throw jsonError(400,'ACTION_DENIED');
        const result=await auth.activateOwnMasterCampaignWriter({context:ctx,fetchImpl});
        return sendJson(req,res,200,result);
      }
      if(url.pathname==='/auth/users'&&req.method==='GET'){
        const sourceUsers=auth.users({context:ctx});
        const users=[];
        // Bound each batch to the private bridge limit so a larger team is
        // inspected instead of being marked unavailable by its own fan-out.
        for(let i=0;i<sourceUsers.length;i+=8)users.push(...await Promise.all(sourceUsers.slice(i,i+8).map(async user=>{
          if(sandbox||user.role!=='manager'||!user.areas.includes('growth'))return user;
          const proof=contentAdmission?await contentAdmission.inspect(ctx,{brand:user.brand,userId:user.id}):{read:false,write:false,catalogueReady:false};
          return {...user,campaignContentAccess:{available:proof.read,writeReady:proof.write,catalogueReady:proof.catalogueReady,reason:proof.read?(proof.catalogueReady?null:'CATALOG_EMPTY'):'CONTENT_AUTHORITY_NOT_CONFIRMED'}};
        })));
        return sendJson(req,res,200,{users});
      }
      if(url.pathname==='/auth/campaign-create'){
        // Corporate CREATE needs its own explicit gate and the existing FULL
        // individual WRITER authorization; historical GET recovery is unchanged.
        if(!campaignCreator||campaignWriter&&req.method==='POST'&&!crmCorporateCreate)throw jsonError(403,'EDIT_NOT_READY');
        if(!['GET','POST'].includes(req.method))throw jsonError(405,'METHOD_DENIED');
        let q;
        if(req.method==='POST'){
          if(url.search||req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw jsonError(400,'REQUEST_DENIED');
          q=await readJson(req,MAX_CAMPAIGN_REQUEST);
        }else{
          if([...url.searchParams.keys()].some(k=>!['brand','idempotency_key'].includes(k))||url.searchParams.getAll('brand').length!==1||url.searchParams.getAll('idempotency_key').length!==1)throw jsonError(400,'QUERY_DENIED');
          q={brand:url.searchParams.get('brand'),idempotency_key:url.searchParams.get('idempotency_key')};
        }
        const createUser=auth.authorizeBrand({...ctx,area:'growth',edit:true},q.brand);
        if(req.method==='POST')await templateOwnershipWriteGate(createUser,'campanha_criar',{isolatedSandbox:sandbox,admit:contentAdmission?()=>contentAdmission.requireWrite(ctx,{brand:q.brand}):undefined});
        const release=reserveCampaignWork(auth.campaignWriterAuthorization(ctx,{brand:q.brand,action:req.method==='POST'?'criar':'operacao_criar'}).userId);
        try{const value=await campaignCreator[req.method==='POST'?'submit':'reconcile'](ctx,q);return sendJson(req,res,campaignStatus(value),campaignDto('campanha_criar',q.idempotency_key,value));}finally{release();}
      }
      if(url.pathname==='/auth/campaign-delivery'&&req.method==='GET'){
        if(!campaignDelivery)throw jsonError(403,'EDIT_NOT_READY');
        if([...url.searchParams.keys()].some(k=>!['brand','idempotency_key'].includes(k))||url.searchParams.getAll('brand').length!==1||url.searchParams.getAll('idempotency_key').length!==1)throw jsonError(400,'QUERY_DENIED');
        const q={brand:url.searchParams.get('brand'),idempotency_key:url.searchParams.get('idempotency_key')};auth.authorizeBrand({...ctx,area:'growth',edit:true},q.brand);const descriptor=campaignDelivery.describe(ctx,q);
        const release=reserveCampaignWork(auth.campaignWriterAuthorization(ctx,{brand:q.brand,action:'operacao'}).userId);
        try{const value=await campaignDelivery.reconcile(ctx,q);return sendJson(req,res,campaignStatus(value),campaignDto(descriptor.action,q.idempotency_key,value));}finally{release();}
      }
      if(url.pathname==='/auth/campaign-draft'&&req.method==='GET'){
        if(!allowCampaignDraft)throw jsonError(403,'EDIT_NOT_READY');
        if([...url.searchParams.keys()].some(key=>key!=='brand')||url.searchParams.getAll('brand').length!==1)throw jsonError(400,'QUERY_DENIED');
        auth.authorizeBrand({...ctx,area:'growth'},url.searchParams.get('brand'));
        return sendJson(req,res,200,{operation:auth.campaignDraft(ctx,url.searchParams.get('brand'))});
      }
      if(url.pathname==='/auth/audience-draft'&&req.method==='GET'){
        if(!allowAudienceDraft)throw jsonError(403,'EDIT_NOT_READY');
        if([...url.searchParams.keys()].some(key=>key!=='brand')||url.searchParams.getAll('brand').length!==1)throw jsonError(400,'QUERY_DENIED');
        auth.authorizeBrand({...ctx,area:'growth'},url.searchParams.get('brand'));
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
          if(b.action==='update'){
            if(Object.keys(b).sort().join(',')!=='access,action,area,brand,email,expectedRevision,userId')throw jsonError(400,'ACTION_DENIED');
            const result=auth.updateUserProfile({context:ctx,userId:b.userId,expectedRevision:b.expectedRevision,email:b.email,area:b.area,brand:b.brand,access:b.access});
            kickManagedCrm();if(!managedCrmRuntime)auth.reconcileUserProfileUpdates();return sendJson(req,res,result.state==='configured'?200:202,result);
          }
          if(b.action==='update_finish'){
            if(Object.keys(b).sort().join(',')!=='action,expectedRevision,userId')throw jsonError(400,'ACTION_DENIED');
            const result=auth.finishUserProfileUpdate({context:ctx,userId:b.userId,expectedRevision:b.expectedRevision});
            return sendJson(req,res,200,{ok:true,state:result.state,userId:result.userId,inviteUrl:'https://'+result.host+'/#invite='+encodeURIComponent(result.token)});
          }
          if(b.action==='invite'){
            if(b.role!=='manager')throw jsonError(400,'ROLE_DENIED');
            if(!editGrantsAllowed(b.permissions))throw jsonError(403,'EDIT_NOT_READY');
            const invite=auth.createInvite({context:ctx,email:b.email,areas:b.areas,permissions:b.permissions,requestedAccess:b.requestedAccess,brand:b.brand});
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
      if(url.pathname==='/api/templates'&&crmPublishedJourneyRead&&(!coexistence||auth.session(ctx).user?.role==='superadmin'||['fluxos_listar','fluxos_capacidade'].includes(url.searchParams.get('acao')))){
        const action=url.searchParams.get('acao');
        const result=crmMasterTemplateRead&&action==='listar'?await masterTemplateReader.read(ctx,url.searchParams):action==='fluxos_capacidade'?publishedJourneyReader.capability(ctx,url.searchParams):await publishedJourneyReader.read(ctx,url.searchParams);
        return sendJson(req,res,result.status,result.body);
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
        const individualParity=!(corporateWriter&&allowAudienceDraft&&route==='segments'&&audienceFeature(ctx))&&parityUser?.role==='manager'&&auth.managedCrmJournal.status(parityUser.id)!==null;
        const audienceReadRoute=individualParity&&crmManagedAudienceRead&&Object.hasOwn(AudienceRead.ACTIONS[route]||{},url.searchParams.get('acao'));
        const templateReadRoute=individualParity&&crmManagedTemplateRead&&Object.hasOwn(TemplateRead.ACTIONS[route]||{},url.searchParams.get('acao'));
        const parityDecision=audienceReadRoute?AudienceRead.decision(route,req.method,url.searchParams):templateReadRoute?TemplateRead.decision(route,req.method,url.searchParams):null;
        const d=parityDecision?{...parityDecision,area:'growth',edit:false,credentialSlot:'crm-panel-read'}:decide(route,req.method,url.searchParams,body,{crmCampaignSubmitWrite:allowCampaignSubmit});
        if(coexistence&&route==='segments'&&d.edit&&auth.session(ctx).user?.role==='manager'&&!audienceFeature(ctx))throw jsonError(403,'EDIT_NOT_READY');
        const audienceAction=route==='segments'&&['segmento_criar','segmento_salvar','segmento_arquivar','segmento_operacao'].includes(d.action);
        const audienceCount=crmMasterAudienceCount&&route==='segments'&&d.action==='segmento_contar';
        const audienceContextReview=crmMasterAudienceContextReview&&route==='segments'&&d.action==='segmento_contexto_revisao';
        if(route==='segments'&&d.action==='segmento_contexto_revisao'&&!audienceContextReview)throw jsonError(403,'ACTION_DENIED');
        const audienceScopeRead=route==='segments'&&d.action==='segmento_contexto_v2'&&!!nativeContext&&crmMasterAudienceWrite;
        if(route==='segments'&&d.action==='segmento_contexto_v2'&&!audienceScopeRead)throw jsonError(403,'ACTION_DENIED');
        if(d.edit&&!audienceCount&&!(allowCampaignSubmit&&route==='campaigns')&&!(allowCampaignDraft&&route==='campaigns'&&['campanha_salvar','campanha_operacao'].includes(d.action))&&!(allowAudienceDraft&&(audienceAction||audienceScopeRead)))throw jsonError(403,'EDIT_NOT_READY');
        // An attested own master WRITER includes read_content. Keep all other
        // production data readers on their existing individual READ slot.
        const ownMasterAudienceRoute=crmMasterAudienceRead&&(!coexistence||auth.session(ctx).user?.role==='superadmin')&&route==='segments'&&req.method==='GET'&&!d.edit&&['segmentos_listar','segmento_obter'].includes(d.action);
        const ownMasterAudienceWriteRoute=crmMasterAudienceWrite&&(!coexistence||auth.session(ctx).user?.role==='superadmin')&&route==='segments'&&(audienceAction||audienceScopeRead);
        const corporateAudienceRoute=(!!corporateWriter||crmMasterAudienceWrite)&&allowAudienceDraft&&route==='segments'&&(audienceAction||audienceFeature(ctx));
        const campaignSubmitRoute=allowCampaignSubmit&&route==='campaigns'&&(d.edit||!campaignWriter||auth.session(ctx).user?.role==='superadmin'&&auth.campaignWriterReady(ctx));
        const user=parityDecision?parityUser:auth.authorize({...ctx,area:d.area,edit:d.edit||campaignSubmitRoute||corporateAudienceRoute});
        const managedReadRoute=audienceReadRoute||templateReadRoute||crmManagedReadUi&&user.role==='manager'&&auth.managedCrmJournal.status(user.id)!==null&&Object.hasOwn(ManagedRead.ACTIONS,route);
        const identity=route==='cx'&&url.searchParams.get('access')==='1'||route==='crm-read'&&d.action==='identity';
        if(identity)return sendJson(req,res,200,{schema:'shrigma_access_identity_v1',role:user.role==='superadmin'?'master':'manager',panel:user.role==='superadmin'?'todos':d.area,allowedPanels:user.areas,owner:user.email,brand:user.brand,brands:user.brands,brandAccess:user.brandAccess});
        const fields=req.method==='POST'?body:Object.fromEntries(url.searchParams),explicitBrand=fields.brand??fields.marca;
        const aggregate=['cx','cache','crm-read'].includes(route),requestBrand=explicitBrand??(user.role==='manager'&&(aggregate||['organico','influs'].includes(d.area))?user.brand:undefined);
        if(user.role==='manager'){
          if(typeof auth.authorizeBrand!=='function')throw jsonError(503,'BRAND_AUTH_NOT_READY');
          auth.authorizeBrand({...ctx,area:d.area,edit:d.edit||campaignSubmitRoute},requestBrand);
        }
        // Superadmin retains the selectors already admitted by the proxy (for
        // example Influencer 'todas'); those legacy selectors are not IAM grants.
        const brandedCtx={...ctx,...(user.role==='manager'?{brand:requestBrand}:{})};
        if(req.method==='POST'&&route==='campaigns')await templateOwnershipWriteGate(user,d.action,{isolatedSandbox:sandbox,admit:contentAdmission?()=>contentAdmission.requireWrite(ctx,{brand:requestBrand}):undefined});
        // Their legacy contracts return mixed aggregates and have not yet
        // established a server-verified per-brand projection. Preserve master
        // access; single-brand production access waits for that contract.
        if(s.mode==='operational'&&user.role==='manager'&&['organico','influs'].includes(d.area))throw jsonError(503,'BRAND_READ_CONTRACT_NOT_READY');
        if(s.mode==='operational'&&user.role==='manager'&&!aggregate&&!managedReadRoute&&!campaignSubmitRoute&&!['campaigns','campaigns_media','segments'].includes(route)&&!audienceAction)throw jsonError(503,'BRAND_READ_CONTRACT_NOT_READY');
        if(s.mode==='synthetic'){
          const fixturePanel=aggregate?d.area:route==='influ'?'influs':route;
          const scopedInflu=user.role==='manager'&&route==='influ';
          const result=fixture(fixturePanel,fields,scopedInflu?requestBrand:undefined);
          // Influ's synthetic fixture has a closed authored, scoped payload;
          // the operational manager gate above remains unchanged.
          return sendJson(req,res,200,user.role==='manager'&&!scopedInflu?projectBrandCache(result,requestBrand,d.area,origin,{templateReadAdmitted:crmManagedTemplateRead,audienceReadAdmitted:crmManagedAudienceRead,isolatedSandbox:sandbox}):result);
        }
        // The current CRM UI reads cache_growth through crm-read. Only this
        // explicit synthetic profile translates that validated GET to its
        // already pinned dashboard reader; production keeps its own slot and
        // destination. No additional upstream or credential scope is admitted.
        const sandboxCache=sandbox&&route==='crm-read'&&d.action==='cache_growth';
        const proxyRoute=sandboxCache?'cache':route;
        const proxyQuery=sandboxCache?new URLSearchParams({painel:'growth'}):url.searchParams;
        if(campaignSubmitRoute)auth.campaignWriterAuthorization(ctx,{brand:req.method==='POST'?body.brand:url.searchParams.get('brand'),action:d.action==='campanha_operacao'?'operacao':d.action.replace('campanha_','')});
        if(corporateAudienceRoute)auth.audienceWriterAuthorization(ctx,{brand:requestBrand});
        const ownMasterAudienceBinding=ownMasterAudienceRoute||audienceContextReview?auth.ownMasterAudienceReadBinding(ctx,{brand:requestBrand}):ownMasterAudienceWriteRoute||audienceCount?auth.ownMasterAudienceWriteBinding(ctx,{brand:requestBrand}):null;
        const credential=ownMasterAudienceBinding?ownMasterAudienceBinding.credential:managedReadRoute?null:auth.getUpstreamCredential({...brandedCtx,slot:campaignSubmitRoute||corporateAudienceRoute?'growth-campaign':sandboxCache?'growth-read':d.credentialSlot,area:d.area,edit:d.edit||campaignSubmitRoute||corporateAudienceRoute});
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
          if(audienceContextReview){
            // Original authenticated READ only. Saved definition is custody;
            // context metadata does not authorize refresh, count, save or send.
            const assertBinding=()=>{const after=auth.ownMasterAudienceReadBinding(ctx,{brand:requestBrand});if(after.userId!==ownMasterAudienceBinding.userId||after.binding!==ownMasterAudienceBinding.binding)throw jsonError(403,'MASTER_AUDIENCE_READ_BINDING_CHANGED');};
            const source=require('./crm-master-audience-read.cjs'),expected={brand:requestBrand,id:url.searchParams.get('id'),expected_version:Number(url.searchParams.get('expected_version')),expected_catalog_hash:url.searchParams.get('expected_catalog_hash')};
            assertBinding();
            const recordQuery=new URLSearchParams({acao:'segmento_obter',brand:requestBrand,id:expected.id});
            const originalRaw=await forward({route,method:'GET',query:recordQuery,user,credential,upstreams,origin,ownMasterAudienceRead:true,crmCorporateWriter:ownMasterWriter,fetchImpl});assertBinding();
            const original=source.validateAudienceRead(originalRaw,{brand:requestBrand,action:'segmento_obter',query:recordQuery,secrets:[credential]});
            if(original.status!==200)return sendJson(req,res,original.status,original.body);
            if(original.body.segment.version!==expected.expected_version)return sendJson(req,res,409,{error:'SEGMENT_VERSION_CONFLICT',current_version:original.body.segment.version});
            if(original.body.segment.archived)return sendJson(req,res,409,{error:'SEGMENT_ARCHIVED'});
            const catalogQuery=new URLSearchParams({acao:'segmentos_listar',brand:requestBrand,offset:'0',limit:'1'});
            const getCatalog=async()=>{assertBinding();const raw=await forward({route,method:'GET',query:catalogQuery,user,credential,upstreams,origin,ownMasterAudienceRead:true,crmCorporateWriter:ownMasterWriter,fetchImpl});assertBinding();return source.validateAudienceRead(raw,{brand:requestBrand,action:'segmentos_listar',query:catalogQuery,secrets:[credential]});};
            const catalog=await getCatalog();
            if(catalog.status!==200)return sendJson(req,res,catalog.status,catalog.body);
            if(!catalog.body.catalog.current)return sendJson(req,res,503,{error:'SEGMENT_UNAVAILABLE'});
            if(catalog.body.catalog.catalog_hash!==expected.expected_catalog_hash)return sendJson(req,res,409,{error:'SEGMENT_CATALOG_CHANGED'});
            const raw=await forward({route,method:'GET',query:url.searchParams,user,credential,upstreams,origin,ownMasterAudienceContextReview:true,crmCorporateWriter:ownMasterWriter,fetchImpl});assertBinding();
            const checked=require('./segment-audience-context-review.cjs').validateResponse(raw,expected,{definition:original.body.segment.definition,secrets:[credential]});
            if(checked.status===200){
              const d=original.body.segment.definition,fields=catalog.body.catalog.fields;
              const unavailable=[...new Set(require('./segment-audience-contract.js').leaves(d).filter(l=>l.rule.op==='condition'&&fields.find(f=>f.key===l.rule.field)?.available===false).map(l=>l.rule.field))].sort(),review=checked.body.context_review;
              if(JSON.stringify(review.unavailable_fields)!==JSON.stringify(unavailable)||review.source_ready!==(unavailable.length===0))throw jsonError(503,'SEGMENT_READBACK_UNCONFIRMED');
            }
            const after=await getCatalog();
            if(after.status!==200)return sendJson(req,res,after.status,after.body);
            if(!after.body.catalog.current)return sendJson(req,res,503,{error:'SEGMENT_UNAVAILABLE'});
            if(after.body.catalog.catalog_hash!==expected.expected_catalog_hash)return sendJson(req,res,409,{error:'SEGMENT_CATALOG_CHANGED'});
            if(checked.status===200){const time=Date.parse(checked.body.context_review.checked_at),now=Date.now();if(time>now+30000||time<now-90000)throw jsonError(503,'SEGMENT_READBACK_UNCONFIRMED');}
            assertBinding();return sendJson(req,res,checked.status,checked.body);
          }
          if(audienceCount){
            // Count is a derived original read. No audience/operation mutation,
            // receipt reservation, arbitrary query or transport is admitted.
            const assertBinding=()=>{if(auth.ownMasterAudienceWriteBinding(ctx,{brand:requestBrand}).binding!==ownMasterAudienceBinding.binding)throw jsonError(403,'MASTER_AUDIENCE_COUNT_BINDING_CHANGED');};
            const source=require('./crm-master-audience-read.cjs');let originalDefinition;
            if(body.id){
              const q=new URLSearchParams({acao:'segmento_obter',brand:requestBrand,id:body.id});
              const raw=await forward({route,method:'GET',query:q,user,credential,upstreams,origin,ownMasterAudienceRead:true,crmCorporateWriter:ownMasterWriter,fetchImpl});assertBinding();
              const r=source.validateAudienceRead(raw,{brand:requestBrand,action:'segmento_obter',query:q,secrets:[credential]});
              if(r.status!==200)return sendJson(req,res,r.status,r.body);
              if(r.body.segment.version!==body.expected_version)return sendJson(req,res,409,{error:'SEGMENT_VERSION_CONFLICT',current_version:r.body.segment.version});
              originalDefinition=r.body.segment.definition;
            }
            const q=new URLSearchParams({acao:'segmentos_listar',brand:requestBrand,offset:'0',limit:'1'});
            const rawCatalog=await forward({route,method:'GET',query:q,user,credential,upstreams,origin,ownMasterAudienceRead:true,crmCorporateWriter:ownMasterWriter,fetchImpl});assertBinding();
            const cat=source.validateAudienceRead(rawCatalog,{brand:requestBrand,action:'segmentos_listar',query:q,secrets:[credential]});
            if(cat.status!==200)return sendJson(req,res,cat.status,cat.body);
            if(!cat.body.catalog.current||cat.sourceCapabilities.count!==true)return sendJson(req,res,503,{error:'SEGMENT_UNAVAILABLE'});
            if(cat.body.catalog.catalog_hash!==body.expected_catalog_hash)return sendJson(req,res,409,{error:'SEGMENT_CATALOG_CHANGED'});
            const counted=await forward({route,method:'POST',query:url.searchParams,body,user,credential,upstreams,origin,ownMasterAudienceCount:true,crmCorporateWriter:ownMasterWriter,fetchImpl});assertBinding();
            const rawAfter=await forward({route,method:'GET',query:q,user,credential,upstreams,origin,ownMasterAudienceRead:true,crmCorporateWriter:ownMasterWriter,fetchImpl});assertBinding();
            const after=source.validateAudienceRead(rawAfter,{brand:requestBrand,action:'segmentos_listar',query:q,secrets:[credential]});
            if(after.status!==200)return sendJson(req,res,after.status,after.body);
            if(!after.body.catalog.current||after.sourceCapabilities.count!==true)return sendJson(req,res,503,{error:'SEGMENT_UNAVAILABLE'});
            if(after.body.catalog.catalog_hash!==body.expected_catalog_hash)return sendJson(req,res,409,{error:'SEGMENT_CATALOG_CHANGED'});
            const checked=require('./crm-master-audience-count.cjs').validateAudienceCount(counted,{brand:requestBrand,request:body,originalDefinition,nowMs:Date.now(),secrets:[credential]});
            return sendJson(req,res,checked.status,checked.body);
          }
          if(audienceScopeRead){
            const scope=await forward({route,method:'GET',query:url.searchParams,user,credential,upstreams,origin,crmAudienceDraft:true,ownMasterAudienceWrite:true,crmCorporateWriter:ownMasterWriter,fetchImpl});
            if(auth.ownMasterAudienceWriteBinding(ctx,{brand:requestBrand}).binding!==ownMasterAudienceBinding.binding)throw jsonError(403,'MASTER_AUDIENCE_WRITE_BINDING_CHANGED');
            if(scope.status!==200)throw jsonError(502,'UPSTREAM_SCOPE_UNCONFIRMED');verifiedAudienceScope(scope.body,requestBrand);
            return sendJson(req,res,200,{schema:'shrigma-master-audience-write-admission-v1',brand:requestBrand,originalScopeAuthenticated:true,actorHashVerified:true,gatewayWrite:true,operational:false});
          }
          if(ownMasterAudienceRoute){
            const raw=await forward({route,method:req.method,query:url.searchParams,user,credential,upstreams,origin,ownMasterAudienceRead:true,crmCorporateWriter:ownMasterWriter,fetchImpl});
            const after=auth.ownMasterAudienceReadBinding(ctx,{brand:requestBrand});
            if(after.userId!==ownMasterAudienceBinding.userId||after.binding!==ownMasterAudienceBinding.binding)throw jsonError(403,'MASTER_AUDIENCE_READ_BINDING_CHANGED');
            const source=require('./crm-master-audience-read.cjs'),checked=source.validateAudienceRead(raw,{brand:requestBrand,action:d.action,query:url.searchParams,secrets:[credential]});
            const projected=publicAudienceBody(checked.body);
            const responseBody=checked.status===200&&d.action==='segmentos_listar'?{...projected,capabilities:{...projected.capabilities,draft:crmMasterAudienceWrite&&audienceFeature(ctx)&&checked.sourceCapabilities.draft===true&&projected.catalog.current===true,count:crmMasterAudienceCount&&audienceFeature(ctx)&&checked.sourceCapabilities.count===true&&projected.catalog.current===true},...(nativeContext?{read_admission:source.audienceSummary(checked,{brand:requestBrand})}:{} )}:projected;
            return sendJson(req,res,checked.status,responseBody);
          }
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
            result=await forward({route,method:'GET',query:url.searchParams,user,credential,upstreams,origin,crmCampaignSubmitWrite:true,...(campaignWriter?{crmCorporateWriter:coexistence&&user.role==='manager'?corporateWriter:campaignWriter}:{}),fetchImpl});
            if(user.role==='manager'&&result.status===200)result={...result,body:validateScopedRead(result.body,route,d.action,requestBrand,url.searchParams,credential,{isolatedSandbox:sandbox,contentProfile:route==='campaigns'&&d.action==='campanha_catalogo'&&!!contentAdmission&&(await contentAdmission.attest(ctx,{brand:requestBrand})).read})};
            auth.authorizeBrand({...brandedCtx,area:d.area,edit:true},requestBrand);
            return sendJson(req,res,result.status,result.body);
          }
          if(audienceAction){
            const writing=req.method==='POST',brand=writing?body.brand:url.searchParams.get('brand'),key=writing?body.idempotency_key:url.searchParams.get('idempotency_key');
            let journal;
            if(writing){
              const scopeQuery=new URLSearchParams({acao:'segmento_contexto_v2',brand});
              const scope=await forward({route:'segments',method:'GET',query:scopeQuery,user,credential,upstreams,origin,crmAudienceDraft:true,...(ownMasterAudienceWriteRoute?{ownMasterAudienceWrite:true,crmCorporateWriter:ownMasterWriter}:{}),fetchImpl});
              if(ownMasterAudienceWriteRoute&&auth.ownMasterAudienceWriteBinding(ctx,{brand}).binding!==ownMasterAudienceBinding.binding)throw jsonError(403,'MASTER_AUDIENCE_WRITE_BINDING_CHANGED');
              if(scope.status!==200)throw jsonError(502,'UPSTREAM_SCOPE_UNCONFIRMED');
              const actorSha256=verifiedAudienceScope(scope.body,brand),payloadSha256=audiencePayloadHash(body);
              if(corporateAudienceRoute)auth.audienceWriterAuthorization(ctx,{brand});
              auth.reserveAudienceDraft(ctx,brand,key,d.action,payloadSha256,actorSha256,{
                id:d.action==='segmento_criar'?null:body.id,
                expectedVersion:d.action==='segmento_criar'?null:body.expected_version,
                definitionSha256:d.action==='segmento_arquivar'?null:audiencePayloadHash(AudienceContract.normalize(body.definition))
              });
              journal=auth.audienceDraft(ctx,brand);
              try{await forward({route,method:'POST',query:url.searchParams,body,user,credential,upstreams,origin,crmAudienceDraft:true,...(ownMasterAudienceWriteRoute?{ownMasterAudienceWrite:true,crmCorporateWriter:ownMasterWriter}:{}),fetchImpl});}
              catch(error){auth.audienceDraftOutcome(principal,brand,key,d.action,'uncertain');throw error;}
            }else{
              journal=auth.audienceDraft(ctx,brand);
              if(!journal||journal.operationKey!==key)throw jsonError(404,'OPERATION_NOT_FOUND');
            }
            const receiptQuery=new URLSearchParams({acao:'segmento_operacao',brand,idempotency_key:key});
            let lookup;
            try{
              if(ownMasterAudienceWriteRoute&&auth.ownMasterAudienceWriteBinding(ctx,{brand}).binding!==ownMasterAudienceBinding.binding)throw jsonError(403,'MASTER_AUDIENCE_WRITE_BINDING_CHANGED');
              lookup=await forward({route:'segments',method:'GET',query:receiptQuery,user,credential,upstreams,origin,crmAudienceDraft:true,...(ownMasterAudienceWriteRoute?{ownMasterAudienceWrite:true,crmCorporateWriter:ownMasterWriter}:{}),fetchImpl});
            }
            catch(error){if(writing)auth.audienceDraftOutcome(principal,brand,key,d.action,'uncertain');throw error;}
            if(lookup.status!==200){
              if(writing){auth.audienceDraftOutcome(principal,brand,key,d.action,'uncertain');throw jsonError(502,'UPSTREAM_RECEIPT_UNCONFIRMED');}
              return sendJson(req,res,lookup.status,lookup.body);
            }
            let verified;
            try{verified=verifiedAudienceOperation(lookup.body,{brand,key,action:journal.action,requestId:journal.requestId,expectedVersion:journal.expectedVersion,payloadMatches:hash=>auth.audiencePayloadMatches(journal.payloadMac,hash),actorMatches:hash=>auth.audienceActorMatches(journal.actorMac,hash),definitionMatches:hash=>auth.audienceDefinitionMatches(journal.definitionMac,hash)});}
            catch(error){if(writing)auth.audienceDraftOutcome(principal,brand,key,d.action,'uncertain');throw error;}
            if(corporateAudienceRoute)auth.audienceWriterAuthorization(ctx,{brand});
            if(ownMasterAudienceWriteRoute&&auth.ownMasterAudienceWriteBinding(ctx,{brand}).binding!==ownMasterAudienceBinding.binding)throw jsonError(403,'MASTER_AUDIENCE_WRITE_BINDING_CHANGED');
            if(ownMasterAudienceWriteRoute&&verified.phase==='succeeded'){
              const check=require('./crm-master-audience-read.cjs').validateAudienceRead({status:200,body:{segment:verified.body.segment}},{brand,action:'segmento_obter',query:new URLSearchParams({id:verified.body.segment.id}),secrets:[credential]});
              if(check.status!==200)throw jsonError(502,'UPSTREAM_RECEIPT_UNCONFIRMED');
              verified={...verified,body:{...verified.body,segment:publicAudienceBody(check.body).segment}};
            }
            auth.audienceDraftOutcome(principal,brand,key,journal.action,verified.phase,{receiptStatus:verified.status,receiptCode:verified.receiptCode,segmentId:verified.segmentId,segmentVersion:verified.segmentVersion});
            return sendJson(req,res,verified.status,verified.body);
          }
          if(draftReceipt){
            const existing=auth.campaignDraft(ctx,draftBrand);
            if(!existing||existing.operationKey!==draftKey)throw jsonError(404,'OPERATION_NOT_FOUND');
          }
          if(draftSave)auth.reserveCampaignDraft(ctx,draftBrand,draftKey);
          try{result=managedReadRoute?await (audienceReadRoute?audienceReadBridge:templateReadRoute?templateReadBridge:managedReadBridge).read({context:brandedCtx,route,method:req.method,query:url.searchParams,origin},settled=>{managedReadSettled=settled;}):await forward({route:proxyRoute,method:req.method,query:proxyQuery,body,user,credential,upstreams,origin,crmDraftWrite:allowCampaignDraft,sandboxAudienceDraft:sandbox&&audienceFeature(ctx),corporateAudienceDraft:!!corporateWriter&&audienceFeature(ctx),fetchImpl});}
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
        if((crmManagedAudienceRead||crmManagedTemplateRead)&&route==='crm-read'&&d.action==='cache_growth'&&result.status===200&&user.role==='manager'&&auth.managedCrmJournal.status(user.id)!==null){
          let ready=false;try{const proof=auth.managedCrmReadAuthorization({...brandedCtx,area:'growth',edit:false});if(proof&&typeof proof.then==='function')Promise.resolve(proof).catch(()=>{});else ready=Boolean(proof);}catch{}
          if(ready)result={...result,body:require('./proxy.cjs').rewriteCapabilities(result.body,upstreams,origin,{route,managedAudienceRead:crmManagedAudienceRead,managedTemplateRead:crmManagedTemplateRead})};
        }
        if(crmMasterAudienceRead&&auth.ownMasterAudienceReadReady(ctx)&&route==='crm-read'&&d.action==='cache_growth'&&result.status===200)result={...result,body:require('./proxy.cjs').rewriteCapabilities(result.body,upstreams,origin,{route,ownMasterAudienceRead:true,ownMasterAudienceWrite:crmMasterAudienceWrite&&audienceFeature(ctx),ownMasterAudienceCount:crmMasterAudienceCount&&audienceFeature(ctx),ownMasterAudienceContextReview:crmMasterAudienceContextReview})};
        if(corporateAudienceRoute)auth.audienceWriterAuthorization(ctx,{brand:requestBrand});
        if(crmPublishedJourneyRead&&route==='crm-read'&&d.action==='cache_growth'&&result.status===200)result={...result,body:require('./crm-published-journey-read.cjs').capabilities(result.body,origin,auth.ownMasterPublishedJourneyReadReady(ctx))};
        if(crmMasterTemplateRead&&route==='crm-read'&&d.action==='cache_growth'&&result.status===200)result={...result,body:require('./crm-master-template-read.cjs').capabilities(result.body,origin,auth.ownMasterPublishedJourneyReadReady(ctx))};
        if(corporateWriter&&audienceFeature(ctx)&&route==='crm-read'&&d.action==='cache_growth'&&result.status===200)result={...result,body:require('./proxy.cjs').rewriteCapabilities(result.body,upstreams,origin,{route,corporateAudienceDraft:true,managedAudienceRead:crmManagedAudienceRead,managedTemplateRead:crmManagedTemplateRead})};
        if(user.role==='manager'){
          // Revocation or a changed grant during fetch cannot return the body.
          auth.authorizeBrand({...brandedCtx,area:d.area,edit:d.edit||campaignSubmitRoute},requestBrand);
          if(result.status>=200&&result.status<300){
            if(aggregate)result={...result,body:projectBrandCache(result.body,requestBrand,d.area,origin,{templateReadAdmitted:crmManagedTemplateRead,audienceReadAdmitted:crmManagedAudienceRead||!!corporateWriter&&audienceFeature(ctx),isolatedSandbox:sandbox})};
            else if(['campaigns','campaigns_media'].includes(route)||!managedReadRoute&&!draftSave&&!draftReceipt)result={...result,body:validateScopedRead(result.body,route,d.action,requestBrand,url.searchParams,credential,{isolatedSandbox:sandbox,corporateAudience:corporateAudienceRoute,contentProfile:route==='campaigns'&&d.action==='campanha_catalogo'&&!!contentAdmission&&(await contentAdmission.attest(ctx,{brand:requestBrand})).read})};
          }else result={...result,body:{error:result.status===503&&result.body?.error==='UPSTREAM_CREDENTIAL_REJECTED'?'UPSTREAM_CREDENTIAL_REJECTED':'UPSTREAM_REQUEST_DENIED'}};
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
  };
  if(s.crmNativeEnabled===true){
    const N=require('./crm-native-mcp.cjs');
    nativeMcp=N.createNativeMcp({auth,managerHost:s.managerHost,installer:nativeInstaller,createCampaignEnabled:crmCorporateCreate,publishedJourneyReadEnabled:crmPublishedJourneyRead,masterTemplateReadEnabled:crmMasterTemplateRead,sourceDiagnosticsEnabled:s.crmNativeSourceDiagnosticsEnabled===true&&sourceDiagnostics?.enabled===true,deliveryHealthEnabled:s.crmNativeDeliveryHealthEnabled===true&&deliveryHealth?.enabled===true,schedulerStateEnabled:s.crmNativeSchedulerStateEnabled===true&&schedulerState?.enabled===true,invoke:request=>N.dispatchJson(dispatch,request)});
  }
  const server=http.createServer({maxHeaderSize:8192},(req,res)=>dispatch(req,res));
  server.headersTimeout=10000;server.requestTimeout=100000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=200;
  if(managedCrmRuntime){if(!coexistence)server.once('listening',kickManagedCrm);server.once('close',()=>{Promise.resolve().then(()=>managedCrmRuntime.close()).catch(()=>{});});}
  return server;
}
function environmentForOriginalMasterIndividualCoexistence(requested,preserved){
 const flag=requested.DASHBOARD_CRM_INDIVIDUAL_COEXISTENCE;
 if(flag!==undefined&&!['enabled','disabled'].includes(flag))throw Error('Individual coexistence projection invalid');
 if(flag!=='enabled')return preserved;
 const keys=['DASHBOARD_CRM_INDIVIDUAL_COEXISTENCE','DASHBOARD_CRM_MANAGED_READ','DASHBOARD_CRM_MANAGED_READ_UI','DASHBOARD_CRM_MANAGER_ISSUER_ID','DASHBOARD_CRM_MANAGER_NAMESPACE_ID','DASHBOARD_CRM_MANAGER_PROVISIONER_TOKEN','DASHBOARD_CRM_MANAGED_WRITER','DASHBOARD_CRM_WRITER_DESCRIPTOR','DASHBOARD_CRM_WRITER_PROVISIONER_TOKEN','DASHBOARD_CRM_MANAGED_AUDIENCE_READ','DASHBOARD_CRM_MANAGED_TEMPLATE_READ'];
 const out={...preserved};for(const k of keys)if(Object.hasOwn(requested,k))out[k]=requested[k];
 settingsFromEnv(out);return out;
}
function authOptionsFor(settings){
  return {...(settings.crmIndividualCoexistence===true?{crmIndividualCoexistence:true}:{}),...(settings.crmNativeEnabled===true?{crmNativeEnabled:true}:{}),...(settings.crmNativeSourceSyncEnabled===true?{crmNativeSourceSyncEnabled:true}:{}),...(settings.crmNativeSchedulerBindingEnabled===true?{crmNativeSchedulerBindingEnabled:true}:{}),...(settings.crmNativeSchedulerStateEnabled===true?{crmNativeSchedulerStateEnabled:true}:{}),dbPath:settings.dbPath,managerHost:settings.managerHost,areaHosts:settings.areaHosts,allowedEmailDomains:settings.allowedEmailDomains,bootstrapAdminEmail:settings.bootstrapAdminEmail,bootstrapTokenSha256:settings.bootstrapTokenSha256,encryptionKey:settings.encryptionKey,...(settings.crmCampaignWriterProfile!==undefined?{crmCampaignWriterProfile:settings.crmCampaignWriterProfile}:{}),...(settings.crmCampaignSubmitWrite===true?{crmCampaignSubmitWrite:true}:{}),...(settings.crmMasterAudienceWrite===true?{crmMasterAudienceWrite:true}:{}),...(settings.crmManagedWriter?{crmManagedWriter:require('./crm-manager-runtime.cjs').corporateWriterDescriptor(settings.crmManagedWriter,settings.crmManagedRead,settings.allowedEmailDomains)}:{}),...(settings.crmManagedRead?{crmManagedRead:{issuerId:settings.crmManagedRead.issuerId,namespaceId:settings.crmManagedRead.namespaceId}}:{})};
}
function managedRuntimeFor(settings,auth){
  if(!settings.crmManagedRead)return undefined;
  const {issuerId,namespaceId,provisionerToken}=settings.crmManagedRead;
  const {createManagerRuntime,createWriterManagerRuntime}=require('./crm-manager-runtime.cjs');
  const read=createManagerRuntime({auth,issuerId,namespaceId,provisionerToken,allowedEmailDomains:settings.allowedEmailDomains});
  if(!settings.crmManagedWriter)return Object.freeze({kick:async()=>{const result=await Promise.allSettled([read.kick()]);try{auth.reconcileUserProfileUpdates();}catch{}return result;},close:()=>read.close()});
  const writer=createWriterManagerRuntime({auth,descriptor:settings.crmManagedWriter,readDescriptor:settings.crmManagedRead,allowedEmailDomains:settings.allowedEmailDomains,provisionerToken:settings.crmManagedWriter.provisionerToken});
  if(settings.crmIndividualCoexistence===true)return require('./crm-individual-coexistence.cjs').compose({read,writer,auth});
  return Object.freeze({kick:async()=>{const first=await Promise.allSettled([read.kick()]);if(first[0].status==='fulfilled')try{auth.fulfillManagedCampaignWriterRequests();}catch{}const last=await Promise.allSettled([writer.kick()]);try{auth.reconcileUserProfileUpdates();}catch{}return [...first,...last];},close:()=>Promise.allSettled([read.close(),writer.close()]).then(()=>undefined)});
}
if(require.main===module){
  try{
    const settings=settingsFromEnv();
    const auth=createAuth(authOptionsFor(settings)),managedCrmRuntime=managedRuntimeFor(settings,auth);
    createServer(settings,{auth,managedCrmRuntime}).listen(settings.port,settings.host,()=>console.log('Dashboard operational service listening'));
  }catch{console.error('Dashboard operational startup refused: invalid configuration');process.exitCode=1;}
}
module.exports={environmentForOriginalMasterIndividualCoexistence,environmentForOriginalMasterTemplateRead,environmentForOriginalMasterPublishedJourneyRead,environmentForOriginalMasterCampaignCreate,environmentForOriginalMasterAudienceRead,settingsFromEnv,safeRequestPath,fileForHost,createServer,typeAndCsp,authOptionsFor,managedRuntimeFor};
