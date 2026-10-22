'use strict';
// Inert import. Four closed WRITER RPCs; never accepts a manager bearer or SQL.
const http=require('node:http'),crypto=require('node:crypto');
const W=require('./wire.cjs'),A=require('./admission.cjs');
const {HOST,ROLE,DATABASE,PG_HOST,PG_PORT,REQUEST,ERROR,ROUTES,QUERIES,MAX_BODY,MAX_RESPONSE,uuid,time,plain,exact,canonical,sha,GatewayError,refuse,validateRequest,validateResult}=W;
const {admissionSql,ADMISSION_KEYS}=A;
const DOMAINS=Object.freeze(['oaristocrata.com','shrigma.com.br','fishermans.com.br']),AUTH='CRM-Writer-Provisioner ';
function containsSecret(value,secrets){
 let encoded;try{encoded=canonical(value).toLowerCase();for(let n=0;n<3;n++){const next=encoded.replace(/%([a-f0-9]{2})/gi,(_,b)=>String.fromCharCode(parseInt(b,16)));if(next===encoded)break;encoded=next.toLowerCase();}}catch{}
 return typeof encoded!=='string'||secrets.filter(x=>typeof x==='string'&&x.length>0).flatMap(x=>[x,Buffer.from(x).toString('base64'),Buffer.from(x).toString('base64url'),Buffer.from(x).toString('hex')]).some(x=>encoded.includes(x.toLowerCase()));
}
function result(value,command,scope,now,secrets){if(containsSecret(value,secrets))refuse('UNAVAILABLE');const wire=canonical(value);if(Buffer.byteLength(wire)>MAX_RESPONSE)refuse('UNAVAILABLE');return validateResult(value,command,scope,now);}
function requireConnection(client,tls){
 const p=client?.connectionParameters,s=client?.connection?.stream;
 if(!p||!s||typeof s.destroy!=='function'||p.host!==PG_HOST||p.port!==PG_PORT||p.database!==DATABASE||p.user!==ROLE||typeof p.password!=='string'||!p.password||typeof client.query!=='function'||typeof client.release!=='function'||typeof client.on!=='function'||typeof client.removeListener!=='function')refuse('UNAVAILABLE');
 if(tls){if(!exact(p.ssl,['rejectUnauthorized','ca','servername'])||p.ssl.rejectUnauthorized!==true||typeof p.ssl.ca!=='string'||!p.ssl.ca||p.ssl.servername!==PG_HOST||s.encrypted!==true||s.authorized!==true||s.servername!==PG_HOST)refuse('UNAVAILABLE');}
 else if(p.ssl!==false||s.encrypted===true)refuse('UNAVAILABLE');
}
async function withLease(pool,tls,allowed,capture,work,readOnly){
 let client,clean=false,failed=false;const onError=()=>{failed=true;},valid=()=>allowed()&&!failed;
 try{
  if(!allowed())refuse('UNAVAILABLE');client=await pool.connect();requireConnection(client,tls);capture(client);client.on('error',onError);if(!valid())refuse('UNAVAILABLE');
  const begun=await client.query(readOnly?'BEGIN READ ONLY':'BEGIN');if(begun?.command!=='BEGIN'||!valid())refuse('UNAVAILABLE');
  const path=await client.query('SET LOCAL search_path=pg_catalog');if(path?.command!=='SET'||!valid())refuse('UNAVAILABLE');
  const meta=await client.query(admissionSql(tls));if(!valid()||!meta||!Array.isArray(meta.rows)||meta.rows.length!==1||!exact(meta.rows[0],ADMISSION_KEYS)||ADMISSION_KEYS.some(k=>meta.rows[0][k]!==true))refuse('UNAVAILABLE');
  const answer=await work(client,valid);if(!valid())refuse('UNAVAILABLE');
  const committed=await client.query(readOnly?'ROLLBACK':'COMMIT');if(committed?.command!==(readOnly?'ROLLBACK':'COMMIT')||!valid())refuse('UNAVAILABLE');clean=true;return answer;
 }finally{if(client){try{const r=client.release(!clean);r?.catch?.(()=>{});client.removeListener('error',onError);}catch{}}}
}
function readBody(req,timeoutMs){
 return new Promise((resolve,reject)=>{
  const chunks=[];let bytes=0,finished=false;const cleanup=()=>{clearTimeout(timer);for(const [event,fn]of [['data',data],['end',end],['error',failed],['aborted',failed],['close',closed]])req.off(event,fn);};
  const finish=(error,value)=>{if(finished)return;finished=true;cleanup();error?reject(error):resolve(value);};
  const data=chunk=>{if(!(chunk instanceof Uint8Array))return finish(new GatewayError('INPUT_INVALID'));bytes+=chunk.byteLength;if(bytes>MAX_BODY)return finish(new GatewayError('INPUT_INVALID',413));chunks.push(Buffer.from(chunk));};
  const end=()=>{let value;try{const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));value=JSON.parse(text);if(text!==canonical(value))throw Error();}catch{return finish(new GatewayError('INPUT_INVALID'));}finish(null,value);};
  const failed=()=>finish(new GatewayError('INPUT_INVALID')),closed=()=>{if(!req.complete&&!finished)failed();},timer=setTimeout(failed,timeoutMs);
  req.on('data',data);req.once('end',end);req.once('error',failed);req.once('aborted',failed);req.once('close',closed);
 });
}
function createServer(options){
 if(!plain(options)||typeof options.revision!=='string'||!/^[a-f0-9]{40}$/.test(options.revision))refuse('UNAVAILABLE');
 const enabled=options.enabled??false,optional=['maxQueued','deadlineMs','bodyTimeoutMs','now','pgTlsRequired'];
 const required=enabled?['enabled','revision','pool','issuerId','namespaceId','allowedEmailDomains','provisionerToken']:['revision',...(Object.hasOwn(options,'enabled')?['enabled']:[])];
 if(typeof enabled!=='boolean'||!exact(options,[...required,...(enabled?optional.filter(k=>Object.hasOwn(options,k)):[])]))refuse('UNAVAILABLE');
 const {revision,pool,issuerId,namespaceId,provisionerToken}=options;
 if(enabled&&(!pool||typeof pool.connect!=='function'||!uuid(issuerId)||!uuid(namespaceId)||issuerId===namespaceId||!(Array.isArray(options.allowedEmailDomains)&&options.allowedEmailDomains.length===3&&Object.keys(options.allowedEmailDomains).length===3&&new Set(options.allowedEmailDomains).size===3&&['oaristocrata.com','shrigma.com.br','fishermans.com.br'].every(d=>options.allowedEmailDomains.includes(d)))||!/^[A-Za-z0-9_-]{43,128}$/.test(provisionerToken||'')))refuse('UNAVAILABLE');
 const maxQueued=options.maxQueued??2,deadlineMs=options.deadlineMs??4000,bodyTimeoutMs=options.bodyTimeoutMs??1000,now=options.now??Date.now,pgTlsRequired=options.pgTlsRequired??false;
 if(!Number.isInteger(maxQueued)||maxQueued<0||maxQueued>2||!Number.isInteger(deadlineMs)||deadlineMs<10||deadlineMs>4500||!Number.isInteger(bodyTimeoutMs)||bodyTimeoutMs<10||bodyTimeoutMs>1000||bodyTimeoutMs>deadlineMs||typeof now!=='function'||typeof pgTlsRequired!=='boolean')refuse('UNAVAILABLE');
 const scope={issuerId,namespaceId,domains:new Set(DOMAINS)},authHash=enabled?Buffer.from(sha(AUTH+provisionerToken),'hex'):null;
 const current=()=>{const t=now();if(t&&typeof t.then==='function'){Promise.resolve(t).catch(()=>{});refuse('UNAVAILABLE');}if(!time(t))refuse('UNAVAILABLE');return t;};
 let active=null,handling=0,closing=false,stopping,drained;const queue=[];
 const errorBody=(code,command)=>command?{schema:ERROR,issuerId,namespaceId,operationId:command.operationId,requestSha256:sha(canonical(command)),code}:{schema:ERROR,code};
 function reply(res,status,body){
  if(res.destroyed||res.writableEnded)return;let bytes;try{bytes=Buffer.from(JSON.stringify(body));}catch{status=503;bytes=Buffer.from(JSON.stringify(errorBody('UNAVAILABLE')));}
  if(bytes.length>MAX_RESPONSE){status=503;bytes=Buffer.from(JSON.stringify(errorBody('UNAVAILABLE')));}
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length,'Cache-Control':'no-store, private',Pragma:'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end(bytes);
 }
 function health(ready){return {service:'crm-manager-writer',revision,enabled,stopping:closing,ready,policy:{databaseRole:ROLE,namespaceBound:ready,coreVerified:ready,writerCaps4:ready,connectionVerified:ready,tlsRequired:pgTlsRequired}};}
 function finish(job,answer){if(job.done)return;job.done=true;clearTimeout(job.timer);job.res.off('close',job.onClose);const i=queue.indexOf(job);if(i>=0)queue.splice(i,1);job.resolve(answer);}
 const stopLease=job=>{try{job.client?.connection?.stream?.destroy();}catch{}};
 function pump(){
  if(active||closing)return;let job;while(queue.length){const next=queue.shift();if(!next.done&&!next.res.destroyed&&!next.res.writableEnded){job=next;break;}}if(!job)return;active=job;
  withLease(pool,pgTlsRequired,()=>!job.done&&!closing,c=>{job.client=c;},async(client,valid)=>{
   const secrets=[provisionerToken,client.connectionParameters.password];
   // Closed STATUS proves this session's active issuer binding before any mutation.
   const probe={schema:REQUEST,issuerId,namespaceId,action:'writer_status',operationId:crypto.randomUUID(),expectedRequestSha256:crypto.randomBytes(32).toString('hex')};
   const checked=await client.query(QUERIES.writer_status,[canonical(probe)]);
   if(!valid()||!checked||!Array.isArray(checked.rows)||checked.rows.length!==1||!exact(checked.rows[0],['body']))refuse('UNAVAILABLE');
   const proof=result(checked.rows[0].body,probe,scope,current(),secrets);if(proof.status!==200||proof.body.schema!==W.STATUS||proof.body.found!==false)refuse('UNAVAILABLE');
   if(job.health)return {status:200,body:health(true)};
   const value=await client.query(QUERIES[job.command.action],[job.wire]);if(!valid()||!value||!Array.isArray(value.rows)||value.rows.length!==1||!exact(value.rows[0],['body']))refuse('UNAVAILABLE');
   return result(value.rows[0].body,job.command,scope,current(),secrets);
  },job.health||job.command.action==='writer_status').then(answer=>finish(job,answer)).catch(()=>finish(job,{status:503,body:job.health?health(false):errorBody('UNAVAILABLE',job.command)})).finally(()=>{active=null;drained?.();drained=null;pump();});
 }
 function schedule(command,res,remaining,healthRequest=false){
  if(active&&queue.filter(j=>!j.done).length>=maxQueued)return Promise.resolve({status:503,body:healthRequest?health(false):errorBody('UNAVAILABLE',command)});
  return new Promise(resolve=>{const job={command,wire:healthRequest?null:canonical(command),health:healthRequest,res,resolve,done:false,client:null};
   const abort=()=>{finish(job,{status:503,body:healthRequest?health(false):errorBody('UNAVAILABLE',command)});stopLease(job);pump();};
   job.timer=setTimeout(abort,remaining);job.onClose=abort;res.once('close',job.onClose);queue.push(job);pump();});
 }
 async function handle(req,res){
  let reserved=false,command;const began=Date.now();req.on('error',()=>{});res.on('error',()=>{});
  const count=name=>Array.isArray(req.rawHeaders)?req.rawHeaders.filter((_,i)=>i%2===0).filter(h=>String(h).toLowerCase()===name).length:(req.headers[name]===undefined?0:1);
  try{
   if(req.headers.origin!==undefined||count('origin'))refuse('ISSUER_DENIED');
   if(req.method==='GET'&&req.url==='/healthz'){
    const local=['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);
    if(!local||closing||handling>=1+maxQueued)return reply(res,503,health(false));
    if(!enabled)return reply(res,200,health(false));handling++;reserved=true;const answer=await schedule(null,res,deadlineMs,true);return reply(res,answer.status,answer.body);
   }
   if(typeof req.url!=='string'||!Object.hasOwn(ROUTES,req.url))refuse('INPUT_INVALID',404);
   if(req.method!=='POST')refuse('INPUT_INVALID',405);
   if(req.headers.host!==HOST||count('host')!==1)refuse('ISSUER_DENIED');
   if(!enabled||closing||handling>=1+maxQueued)refuse('UNAVAILABLE');
   const auth=req.headers.authorization;if(count('authorization')!==1||typeof auth!=='string'||!/^CRM-Writer-Provisioner [A-Za-z0-9_-]{43,128}$/.test(auth)||!crypto.timingSafeEqual(authHash,Buffer.from(sha(auth),'hex')))refuse('AUTH_REQUIRED');
   const length=req.headers['content-length'];
   if(count('content-type')!==1||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||'')||count('content-encoding')>1||req.headers['content-encoding']!==undefined&&req.headers['content-encoding']!=='identity'||count('content-length')>1||length!==undefined&&(!/^\d+$/.test(length)||Number(length)>MAX_BODY)||req.headers['transfer-encoding']!==undefined&&length!==undefined)refuse('INPUT_INVALID');
   handling++;reserved=true;current();command=validateRequest(await readBody(req,bodyTimeoutMs),req.url,scope);
   if(containsSecret(command,[provisionerToken])||length!==undefined&&Number(length)!==Buffer.byteLength(canonical(command)))refuse();
   const remaining=deadlineMs-(Date.now()-began);if(remaining<=0)refuse('UNAVAILABLE');const answer=await schedule(command,res,remaining);reply(res,answer.status,answer.body);
  }catch(error){const safe=error instanceof GatewayError?error:new GatewayError('UNAVAILABLE');reply(res,safe.status,errorBody(safe.code,command));}finally{if(reserved)handling--;}
 }
 const server=http.createServer({maxHeaderSize:8192,requestTimeout:5500,headersTimeout:5000},(req,res)=>{handle(req,res).catch(()=>{try{res.destroy();}catch{}});});
 function stop(){if(stopping)return stopping;closing=true;for(const job of [...queue])finish(job,{status:503,body:job.health?health(false):errorBody('UNAVAILABLE',job.command)});if(active){finish(active,{status:503,body:active.health?health(false):errorBody('UNAVAILABLE',active.command)});stopLease(active);}
  const lease=active?new Promise(resolve=>{drained=resolve;}):Promise.resolve();server.closeIdleConnections();const socket=new Promise(resolve=>server.close(resolve));stopping=Promise.allSettled([lease,socket]).then(()=>undefined);return stopping;}
 return Object.freeze({server,handle,stop,pending:()=>Object.freeze({active:active?1:0,queued:queue.filter(j=>!j.done).length,handling})});
}
function config(env){
 // Node's native environment has a special prototype; validate a string copy.
 if(env===process.env)env={...env};
 const accepted=new Set(['CRM_WRITER_ENABLED','CRM_WRITER_REVISION','CRM_WRITER_ISSUER_ID','CRM_WRITER_NAMESPACE_ID','CRM_WRITER_PROVISIONER_TOKEN','CRM_WRITER_PG_TLS','CRM_WRITER_PG_CA','CRM_WRITER_PG_SERVERNAME']);
 if(!plain(env)||Object.keys(env).some(k=>k.startsWith('CRM_WRITER_')&&!accepted.has(k))||env.CRM_WRITER_ENABLED!==undefined&&!['true','false'].includes(env.CRM_WRITER_ENABLED)||typeof env.CRM_WRITER_REVISION!=='string'||!/^[a-f0-9]{40}$/.test(env.CRM_WRITER_REVISION)||env.PORT!==undefined&&env.PORT!=='8080')refuse('UNAVAILABLE');
 const enabled=env.CRM_WRITER_ENABLED==='true',privateNames=['CRM_WRITER_ISSUER_ID','CRM_WRITER_NAMESPACE_ID','CRM_WRITER_PROVISIONER_TOKEN','CRM_WRITER_PG_TLS','CRM_WRITER_PG_CA','CRM_WRITER_PG_SERVERNAME'];
 if(!enabled){if(Object.keys(env).some(k=>k.startsWith('PG')||k==='DATABASE_URL'||privateNames.includes(k)))refuse('UNAVAILABLE');return {port:8080,enabled:false,revision:env.CRM_WRITER_REVISION};}
 const permitted=new Set(['PGHOST','PGPORT','PGUSER','PGDATABASE','PGPASSWORD']);
 if(Object.keys(env).some(k=>k.startsWith('PG')&&!permitted.has(k))||env.DATABASE_URL!==undefined||env.PGHOST!==PG_HOST||env.PGPORT!==undefined&&env.PGPORT!=='5432'||env.PGDATABASE!==DATABASE||env.PGUSER!==ROLE||!/^[A-Za-z0-9_-]{43,128}$/.test(env.PGPASSWORD||'')||!/^[A-Za-z0-9_-]{43,128}$/.test(env.CRM_WRITER_PROVISIONER_TOKEN||'')||env.PGPASSWORD===env.CRM_WRITER_PROVISIONER_TOKEN||!uuid(env.CRM_WRITER_ISSUER_ID)||!uuid(env.CRM_WRITER_NAMESPACE_ID)||env.CRM_WRITER_ISSUER_ID===env.CRM_WRITER_NAMESPACE_ID||!['true','false'].includes(env.CRM_WRITER_PG_TLS))refuse('UNAVAILABLE');
 const pgTlsRequired=env.CRM_WRITER_PG_TLS==='true';let ssl=false;
 if(pgTlsRequired){const ca=env.CRM_WRITER_PG_CA;if(typeof ca!=='string'||Buffer.byteLength(ca)>16384||env.CRM_WRITER_PG_SERVERNAME!==PG_HOST)refuse('UNAVAILABLE');const certs=ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);if(!certs||certs.length>8||certs.join('').replace(/\s/g,'')!==ca.replace(/\s/g,''))refuse('UNAVAILABLE');try{for(const pem of certs)if(new crypto.X509Certificate(pem).ca!==true)refuse('UNAVAILABLE');}catch{refuse('UNAVAILABLE');}ssl={rejectUnauthorized:true,ca,servername:PG_HOST};}
 else if(env.CRM_WRITER_PG_CA!==undefined||env.CRM_WRITER_PG_SERVERNAME!==undefined)refuse('UNAVAILABLE');
 return {port:8080,enabled:true,revision:env.CRM_WRITER_REVISION,issuerId:env.CRM_WRITER_ISSUER_ID,namespaceId:env.CRM_WRITER_NAMESPACE_ID,allowedEmailDomains:[...DOMAINS],provisionerToken:env.CRM_WRITER_PROVISIONER_TOKEN,pgTlsRequired,pg:{host:PG_HOST,port:PG_PORT,database:DATABASE,user:ROLE,password:env.PGPASSWORD,ssl,max:1,connectionTimeoutMillis:1000,idleTimeoutMillis:30000,statement_timeout:3000,query_timeout:3500,application_name:'crm-manager-writer',options:'-c search_path=pg_catalog -c statement_timeout=3000 -c lock_timeout=500 -c idle_in_transaction_session_timeout=5000 -c transaction_timeout=3000'}};
}
function start(env,adapters={}){
 const settings=config(env);let pool;
 if(settings.enabled){const Pool=adapters.Pool||require('pg').Pool;pool=new Pool(settings.pg);pool.on('error',()=>process.stderr.write('CRM_WRITER_DATABASE_UNAVAILABLE\n'));}
 for(const k of Object.keys(env))if(k.startsWith('PG')||['DATABASE_URL','CRM_WRITER_PROVISIONER_TOKEN','CRM_WRITER_PG_CA'].includes(k))delete env[k];
 const {pg,port,...options}=settings,app=createServer({...options,...(pool?{pool}:{})});let stopping;
 const stop=()=>stopping||=(async()=>{await app.stop();if(pool)await pool.end();process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);})();
 app.server.on('error',()=>{process.stderr.write('CRM_WRITER_SERVER_UNAVAILABLE\n');process.exitCode=1;stop().catch(()=>{});});app.server.listen(port,'0.0.0.0');process.once('SIGTERM',stop);process.once('SIGINT',stop);return {app,stop};
}
if(require.main===module){try{start(process.env);}catch{process.stderr.write('CRM_WRITER_STARTUP_UNAVAILABLE\n');process.exitCode=1;}}
module.exports={createServer,config,start,containsSecret,requireConnection,...W,...A};
