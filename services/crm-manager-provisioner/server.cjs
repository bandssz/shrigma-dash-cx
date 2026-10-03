'use strict';
// Dormant internal gateway. No socket, environment, pg import or pool is opened
// by requiring this module. It never receives an individual manager bearer.
const http=require('node:http'),crypto=require('node:crypto');
const HOST='comunicacao-crm-manager-provisioner.tazdb8.easypanel.host';
const ROLE='crm_manager_provisioner',DATABASE='listmonk';
const REQUEST='crm-manager-provision-request-v1',RECEIPT='crm-manager-provision-receipt-v1',STATUS='crm-manager-provision-status-v1',ERROR='crm-manager-provision-error-v1';
const CAPS=Object.freeze(['read_content','list_history','submission']);
const CANDIDATE_TTL=600000,LIFETIME=1209600000,MAX_BODY=4096,MAX_RESPONSE=8192;
const ROUTES=Object.freeze({'/internal/v1/crm-managers/prepare':['prepare_read','renew_read'],'/internal/v1/crm-managers/commit':['commit_read'],'/internal/v1/crm-managers/revoke':['revoke_read'],'/internal/v1/crm-managers/status':['status']});
const QUERIES=Object.freeze({prepare_read:'SELECT public.shrigma_crm_manager_prepare_v1($1::jsonb) AS body',renew_read:'SELECT public.shrigma_crm_manager_prepare_v1($1::jsonb) AS body',commit_read:'SELECT public.shrigma_crm_manager_commit_v1($1::jsonb) AS body',revoke_read:'SELECT public.shrigma_crm_manager_revoke_v1($1::jsonb) AS body',status:'SELECT public.shrigma_crm_manager_status_v1($1::jsonb) AS body'});
const ERROR_STATUS=Object.freeze({INPUT_INVALID:400,AUTH_REQUIRED:401,ISSUER_DENIED:403,SUBJECT_NOT_FOUND:404,IDEMPOTENCY_CONFLICT:409,GENERATION_CONFLICT:409,LIFECYCLE_REVOKED:409,CANDIDATE_EXPIRED:409,CREDENTIAL_CONFLICT:409,EDIT_NOT_READY:403,UNAVAILABLE:503});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const uuid=v=>typeof v==='string'&&UUID.test(v),hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),principal=v=>typeof v==='string'&&/^dcrm-[a-f0-9]{32}$/.test(v);
const time=v=>Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-LIFETIME;
const generation=v=>Number.isSafeInteger(v)&&v>=0&&v<=999999999;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
function exact(v,keys){return plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return d&&d.enumerable&&Object.hasOwn(d,'value');});}
function canonical(v){if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';}
const sha=v=>crypto.createHash('sha256').update(v,'utf8').digest('hex');
const caps=v=>Array.isArray(v)&&v.length===CAPS.length&&Object.keys(v).length===v.length&&v.every((x,i)=>x===CAPS[i]);
class GatewayError extends Error{constructor(code,status=ERROR_STATUS[code]||503){super(code);this.code=code;this.status=status;}}
const refuse=(code='INPUT_INVALID',status)=>{throw new GatewayError(code,status);};
function domainsValid(v){return Array.isArray(v)&&v.length>0&&v.length<=8&&Object.keys(v).length===v.length&&new Set(v).size===v.length&&v.every(d=>typeof d==='string'&&d.length<=253&&/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(d));}
function ownerValid(v,domains){return typeof v==='string'&&v.length<=254&&v===v.toLowerCase()&&/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@([a-z0-9-]+\.)+[a-z]{2,63}$/.test(v)&&v.split('@')[0].length<=64&&domains.has(v.split('@')[1]);}
const COMMON=['schema','issuerId','namespaceId','action','operationId'];
const SUBJECT=['userId','lifecycleId','owner'];
const POLICY=['area','slot','role','caps','candidateTtlMs','lifetimeMs'];
const CREDENTIAL=['principalId','keySha256','generation','expectedGeneration'];
function validateRequest(value,path,{issuerId,namespaceId,domains}){
 if(!plain(value)||!Object.hasOwn(ROUTES,path)||!ROUTES[path].includes(value.action))refuse();
 const keys=[...COMMON,...(value.action==='status'?['expectedRequestSha256']:[...SUBJECT,...(value.action==='revoke_read'?[]:[...POLICY,...CREDENTIAL,...(value.action==='commit_read'?['prepareOperationId','issuedAt','candidateExpiresAt','expiresAt']:[])])])];
 if(!exact(value,keys)||value.schema!==REQUEST||!uuid(value.issuerId)||!uuid(value.namespaceId)||!uuid(value.operationId))refuse();
 if(value.issuerId!==issuerId||value.namespaceId!==namespaceId)refuse('ISSUER_DENIED');
 if(value.action==='status'){if(!hash(value.expectedRequestSha256))refuse();return value;}
 if(!uuid(value.userId)||!uuid(value.lifecycleId)||!ownerValid(value.owner,domains))refuse();
 if(value.action==='revoke_read')return value;
 if(value.area!=='growth'||value.slot!=='crm-panel-read'||value.role!=='manager'||!caps(value.caps)||value.candidateTtlMs!==CANDIDATE_TTL||value.lifetimeMs!==LIFETIME||!principal(value.principalId)||!hash(value.keySha256)||!generation(value.generation)||!generation(value.expectedGeneration)||value.generation!==value.expectedGeneration+1)refuse();
 if(value.action==='prepare_read'&&(value.generation!==1||value.expectedGeneration!==0)||value.action==='renew_read'&&value.expectedGeneration<1)refuse();
 if(value.action==='commit_read'&&(!uuid(value.prepareOperationId)||value.prepareOperationId===value.operationId||!time(value.issuedAt)||value.candidateExpiresAt!==value.issuedAt+CANDIDATE_TTL||value.expiresAt!==value.issuedAt+LIFETIME))refuse();
 return value;
}
function validateReceipt(value,command,scope,now,{statusLookup=false}={}){
 const base=['schema','issuerId','namespaceId','operationId','action','requestSha256','userId','lifecycleId','owner','state'];
 const action=statusLookup?value?.action:command.action;
 const extra=action==='revoke_read'?['revocationMode','allGenerationsRevoked','effectiveAt','revokedCount']:['principalId','generation','expectedGeneration','area','slot','role','caps','issuedAt','candidateExpiresAt','expiresAt',...(action==='commit_read'?['prepareOperationId','committedAt','revokedGeneration']:[])];
 if(!['prepare_read','renew_read','commit_read','revoke_read'].includes(action)||!exact(value,[...base,...extra])||value.schema!==RECEIPT||value.issuerId!==scope.issuerId||value.namespaceId!==scope.namespaceId||value.operationId!==command.operationId||value.action!==action||value.requestSha256!==(statusLookup?command.expectedRequestSha256:sha(canonical(command)))||!uuid(value.userId)||!uuid(value.lifecycleId)||!ownerValid(value.owner,scope.domains))refuse('UNAVAILABLE');
 if(!statusLookup&&(value.userId!==command.userId||value.lifecycleId!==command.lifecycleId||value.owner!==command.owner))refuse('UNAVAILABLE');
 if(action==='revoke_read'){
  if(value.state!=='revoked'||value.revocationMode!=='lifecycle'||value.allGenerationsRevoked!==true||!time(value.effectiveAt)||value.effectiveAt>now+30000||!generation(value.revokedCount))refuse('UNAVAILABLE');return value;
 }
 if(!principal(value.principalId)||!generation(value.generation)||!generation(value.expectedGeneration)||value.generation!==value.expectedGeneration+1||value.area!=='growth'||value.slot!=='crm-panel-read'||value.role!=='manager'||!caps(value.caps)||!time(value.issuedAt)||value.issuedAt>now+30000||value.candidateExpiresAt!==value.issuedAt+CANDIDATE_TTL||value.expiresAt!==value.issuedAt+LIFETIME)refuse('UNAVAILABLE');
 if(!statusLookup&&(value.principalId!==command.principalId||value.generation!==command.generation||value.expectedGeneration!==command.expectedGeneration))refuse('UNAVAILABLE');
 if(action==='prepare_read'&&(value.generation!==1||value.expectedGeneration!==0)||action==='renew_read'&&value.expectedGeneration<1)refuse('UNAVAILABLE');
 if(action==='commit_read'){
  if(value.state!=='committed'||!uuid(value.prepareOperationId)||value.prepareOperationId===value.operationId||!time(value.committedAt)||value.committedAt<value.issuedAt||value.committedAt>=value.candidateExpiresAt||value.committedAt>now+30000||value.revokedGeneration!==(value.expectedGeneration===0?null:value.expectedGeneration))refuse('UNAVAILABLE');
  if(!statusLookup&&(value.prepareOperationId!==command.prepareOperationId||value.issuedAt!==command.issuedAt||value.candidateExpiresAt!==command.candidateExpiresAt||value.expiresAt!==command.expiresAt))refuse('UNAVAILABLE');
 }else if(value.state!=='prepared')refuse('UNAVAILABLE');return value;
}
function validateResult(value,command,scope,now){
 if(value?.schema===ERROR){
  if(!exact(value,['schema','issuerId','namespaceId','operationId','requestSha256','code'])||value.issuerId!==scope.issuerId||value.namespaceId!==scope.namespaceId||value.operationId!==command.operationId||value.requestSha256!==sha(canonical(command))||typeof value.code!=='string'||!Object.hasOwn(ERROR_STATUS,value.code))refuse('UNAVAILABLE');return {status:ERROR_STATUS[value.code],body:value};
 }
 if(command.action==='status'){
  if(!exact(value,['schema','issuerId','namespaceId','operationId','found',...(value?.found===true?['receipt']:[])])||value.schema!==STATUS||value.issuerId!==scope.issuerId||value.namespaceId!==scope.namespaceId||value.operationId!==command.operationId||typeof value.found!=='boolean')refuse('UNAVAILABLE');
  if(value.found)validateReceipt(value.receipt,command,scope,now,{statusLookup:true});return {status:200,body:value};
 }
 validateReceipt(value,command,scope,now);return {status:200,body:value};
}
function readBody(req,timeoutMs){
 return new Promise((resolve,reject)=>{
  const chunks=[];let bytes=0,finished=false;
  const cleanup=()=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',failed);req.off('aborted',failed);req.off('close',closed);};
  const finish=(error,value)=>{if(finished)return;finished=true;cleanup();error?reject(error):resolve(value);};
  const data=chunk=>{if(!(chunk instanceof Uint8Array))return finish(new GatewayError('INPUT_INVALID'));bytes+=chunk.byteLength;if(bytes>MAX_BODY)return finish(new GatewayError('INPUT_INVALID',413));chunks.push(Buffer.from(chunk));};
  const end=()=>{let text,value;try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));value=JSON.parse(text);if(text!==canonical(value))throw Error();}catch{return finish(new GatewayError('INPUT_INVALID'));}finish(null,value);};
  const failed=()=>finish(new GatewayError('INPUT_INVALID'));
  const closed=()=>{if(!req.complete&&!finished)failed();};
  const timer=setTimeout(failed,timeoutMs);
  req.on('data',data);req.once('end',end);req.once('error',failed);req.once('aborted',failed);req.once('close',closed);
 });
}
function createServer(options){
 if(!plain(options))refuse('UNAVAILABLE');
 const required=['pool','issuerId','namespaceId','allowedEmailDomains','provisionerToken','revision'];
 const optional=['enabled','maxQueued','deadlineMs','bodyTimeoutMs','now'];
 if(!exact(options,[...required,...optional.filter(k=>Object.hasOwn(options,k))]))refuse('UNAVAILABLE');
 const {pool,issuerId,namespaceId,revision,provisionerToken}=options;
 if(!pool||typeof pool.query!=='function'||!uuid(issuerId)||!uuid(namespaceId)||typeof revision!=='string'||!/^[a-f0-9]{40}$/.test(revision)||typeof provisionerToken!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(provisionerToken)||!domainsValid(options.allowedEmailDomains))refuse('UNAVAILABLE');
 const option=(key,fallback)=>Object.hasOwn(options,key)?options[key]:fallback;
 const enabled=option('enabled',false),maxQueued=option('maxQueued',2),deadlineMs=option('deadlineMs',4000),bodyTimeoutMs=option('bodyTimeoutMs',1000),now=option('now',Date.now);
 if(typeof enabled!=='boolean'||!Number.isInteger(maxQueued)||maxQueued<0||maxQueued>2||!Number.isInteger(deadlineMs)||deadlineMs<10||deadlineMs>4500||!Number.isInteger(bodyTimeoutMs)||bodyTimeoutMs<10||bodyTimeoutMs>1000||bodyTimeoutMs>deadlineMs||typeof now!=='function')refuse('UNAVAILABLE');
 const scope={issuerId,namespaceId,domains:new Set(options.allowedEmailDomains)},authHash=Buffer.from(sha('CRM-Provisioner '+provisionerToken),'hex');
 const current=()=>{let t;try{t=now();}catch{refuse('UNAVAILABLE');}if(!time(t))refuse('UNAVAILABLE');return t;};
 let active=null,handling=0,closing=false;const queue=[];
 function errorBody(code,command){return command?{schema:ERROR,issuerId,namespaceId,operationId:command.operationId,requestSha256:sha(canonical(command)),code}:{schema:ERROR,code};}
 function reply(res,status,body){
  if(res.destroyed||res.writableEnded)return;
  let bytes;try{bytes=Buffer.from(JSON.stringify(body));}catch{status=503;bytes=Buffer.from(JSON.stringify(errorBody('UNAVAILABLE')));}
  if(bytes.length>MAX_RESPONSE){status=503;bytes=Buffer.from(JSON.stringify(errorBody('UNAVAILABLE')));}
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length,'Cache-Control':'no-store, private',Pragma:'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',...(status===503?{'Retry-After':'5'}:{})});res.end(bytes);
 }
 function finish(job,result){if(job.done)return;job.done=true;clearTimeout(job.timer);job.res.off('close',job.onClose);const index=queue.indexOf(job);if(index>=0)queue.splice(index,1);job.resolve(result);}
 function pump(){
  if(active||closing)return;
  let job;while(queue.length){const next=queue.shift();if(next.done||next.res.destroyed||next.res.writableEnded)continue;job=next;break;}
  if(!job)return;active=job;
  // Keep active occupied until the query promise itself settles, even when the
  // HTTP deadline/peer disconnect has already completed the response.
  Promise.resolve().then(()=>pool.query(QUERIES[job.command.action],[job.wire])).then(result=>{
   if(!result||!Array.isArray(result.rows)||result.rows.length!==1||!exact(result.rows[0],['body']))refuse('UNAVAILABLE');
   finish(job,validateResult(result.rows[0].body,job.command,scope,current()));
  }).catch(()=>finish(job,{status:503,body:errorBody('UNAVAILABLE',job.command)})).finally(()=>{active=null;pump();});
 }
 function schedule(command,res,remainingMs){
  const waiting=queue.filter(j=>!j.done).length;
  if(active&&waiting>=maxQueued)return Promise.resolve({status:503,body:errorBody('UNAVAILABLE',command)});
  return new Promise(resolve=>{
   const job={command,wire:canonical(command),res,resolve,done:false,timer:null,onClose:null};
   job.timer=setTimeout(()=>{finish(job,{status:503,body:errorBody('UNAVAILABLE',command)});pump();},remainingMs);
   job.onClose=()=>{if(!job.done){finish(job,{status:503,body:errorBody('UNAVAILABLE',command)});pump();}};res.once('close',job.onClose);
   queue.push(job);pump();
  });
 }
 async function handle(req,res){
  let reserved=false,command;
  const started=Date.now();
  // A late stream error after body/response completion must not become an
  // unhandled EventEmitter error or reveal its raw cause.
  req.on('error',()=>{});res.on('error',()=>{});
  try{
   if(req.headers.origin!==undefined)refuse('ISSUER_DENIED');
   if(req.method==='GET'&&req.url==='/healthz')return reply(res,closing?503:200,{service:'crm-manager-provisioner',revision,enabled,stopping:closing,policy:{databaseRole:ROLE,namespaceBound:true,crmReadOnly:true}});
   if(typeof req.url!=='string'||!Object.hasOwn(ROUTES,req.url))refuse('INPUT_INVALID',404);
   if(req.method!=='POST')refuse('INPUT_INVALID',405);
   if(req.headers.host!==HOST)refuse('ISSUER_DENIED');
   const count=name=>Array.isArray(req.rawHeaders)?req.rawHeaders.filter((_,i)=>i%2===0).filter(h=>String(h).toLowerCase()===name).length:(req.headers[name]===undefined?0:1);
   const authorization=req.headers.authorization;
   if(count('authorization')!==1||typeof authorization!=='string'||!/^CRM-Provisioner [A-Za-z0-9_-]{43,128}$/.test(authorization)||!crypto.timingSafeEqual(authHash,Buffer.from(sha(authorization),'hex')))refuse('AUTH_REQUIRED');
   if(!enabled||closing||handling>=1+maxQueued)refuse('UNAVAILABLE');
   const length=req.headers['content-length'];
   if(count('content-type')!==1||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||'')||req.headers['content-encoding']!==undefined&&req.headers['content-encoding']!=='identity'||count('content-length')>1||length!==undefined&&(!/^\d+$/.test(length)||Number(length)>MAX_BODY)||req.headers['transfer-encoding']!==undefined&&length!==undefined)refuse('INPUT_INVALID');
   handling++;reserved=true;current();
   command=validateRequest(await readBody(req,bodyTimeoutMs),req.url,scope);
   if(length!==undefined&&Number(length)!==Buffer.byteLength(canonical(command),'utf8'))refuse();
   const remaining=deadlineMs-(Date.now()-started);if(remaining<=0)refuse('UNAVAILABLE');
   const result=await schedule(command,res,remaining);reply(res,result.status,result.body);
  }catch(error){const known=error instanceof GatewayError?error:new GatewayError('UNAVAILABLE');reply(res,known.status,errorBody(known.code,command));}
  finally{if(reserved)handling--;}
 }
 const server=http.createServer({maxHeaderSize:8192,requestTimeout:5500,headersTimeout:5000},(req,res)=>{handle(req,res).catch(()=>{try{res.destroy();}catch{}});});
 const stop=()=>{closing=true;for(const job of [...queue])finish(job,{status:503,body:errorBody('UNAVAILABLE',job.command)});if(active)finish(active,{status:503,body:errorBody('UNAVAILABLE',active.command)});server.closeIdleConnections();return new Promise(resolve=>server.close(resolve));};
 return {server,handle,stop,pending:()=>({active:active?1:0,queued:queue.filter(j=>!j.done).length,handling})};
}
function config(env){
 if(env===null||typeof env!=='object'||Array.isArray(env)||env.PGUSER!==ROLE||env.PGDATABASE!==DATABASE||typeof env.PGHOST!=='string'||!env.PGHOST||typeof env.PGPASSWORD!=='string'||!env.PGPASSWORD||!uuid(env.CRM_MANAGER_ISSUER_ID)||!uuid(env.CRM_MANAGER_NAMESPACE_ID)||typeof env.CRM_MANAGER_REVISION!=='string'||!/^[a-f0-9]{40}$/.test(env.CRM_MANAGER_REVISION)||typeof env.CRM_MANAGER_PROVISIONER_TOKEN!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(env.CRM_MANAGER_PROVISIONER_TOKEN))refuse('UNAVAILABLE');
 let domains;try{domains=JSON.parse(env.CRM_MANAGER_ALLOWED_EMAIL_DOMAINS);}catch{refuse('UNAVAILABLE');}if(!domainsValid(domains))refuse('UNAVAILABLE');
 const port=Number(env.PORT||8080),pgPort=Number(env.PGPORT||5432);if(!Number.isInteger(port)||port<1024||port>65535||!Number.isInteger(pgPort)||pgPort<1||pgPort>65535||env.CRM_MANAGER_ENABLED!==undefined&&!['true','false'].includes(env.CRM_MANAGER_ENABLED))refuse('UNAVAILABLE');
 return {port,enabled:env.CRM_MANAGER_ENABLED==='true',issuerId:env.CRM_MANAGER_ISSUER_ID,namespaceId:env.CRM_MANAGER_NAMESPACE_ID,revision:env.CRM_MANAGER_REVISION,allowedEmailDomains:domains,provisionerToken:env.CRM_MANAGER_PROVISIONER_TOKEN,pg:{host:env.PGHOST,port:pgPort,database:DATABASE,user:ROLE,password:env.PGPASSWORD,max:1,connectionTimeoutMillis:1000,idleTimeoutMillis:30000,statement_timeout:3000,query_timeout:3500,application_name:'crm-manager-provisioner'}};
}
function start(env,{Pool=require('pg').Pool}={}){
 const settings=config(env),pool=new Pool(settings.pg);pool.on('error',()=>process.stderr.write('CRM_MANAGER_DATABASE_UNAVAILABLE\n'));
 const {pg,port,...options}=settings,app=createServer({...options,pool});app.server.listen(port,'0.0.0.0');
 let stopping;const stop=()=>stopping||=(async()=>{await app.stop();await pool.end();})();process.once('SIGTERM',stop);process.once('SIGINT',stop);return {app,stop};
}
if(require.main===module){try{start(process.env);}catch{process.stderr.write('CRM_MANAGER_STARTUP_UNAVAILABLE\n');process.exitCode=1;}}
module.exports={createServer,config,start,GatewayError,HOST,ROLE,DATABASE,ROUTES,QUERIES,ERROR_STATUS,MAX_BODY,MAX_RESPONSE,canonical,sha};
