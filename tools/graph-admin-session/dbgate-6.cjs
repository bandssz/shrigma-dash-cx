'use strict';
// Operator-side API client for the audited DbGate 6.0.0 protocol. Credentials
// remain in memory. No service management, saved-connection edits or SQL retries.
const crypto=require('node:crypto');
const VERSION='6.0.0',BUILD_TIME='2024-12-05T11:13:04.194Z',TIMEOUT_MS=20000;
const IDENTITY_SQL="SELECT current_database() AS database,current_user AS role,pg_backend_pid() AS pid,(SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') AS statement_timeout_ms,current_setting('application_name') AS application_name,current_setting('transaction_isolation') AS transaction_isolation,current_setting('transaction_read_only') AS transaction_read_only,txid_current()::text AS transaction_id;";
const IDENTITY_COLUMNS=['database','role','pid','statement_timeout_ms','application_name','transaction_isolation','transaction_read_only','transaction_id'];
const WORKER_IDENTITY_SQL="SELECT pg_catalog.current_database() AS database,current_user AS role,pg_catalog.pg_backend_pid() AS pid,(SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='statement_timeout') AS statement_timeout_ms,pg_catalog.current_setting('application_name') AS application_name,pg_catalog.current_setting('transaction_isolation') AS transaction_isolation,pg_catalog.current_setting('transaction_read_only') AS transaction_read_only,pg_catalog.txid_current()::text AS transaction_id,pg_catalog.to_json(pg_catalog.current_schemas(true)) AS search_schemas;";
const WORKER_IDENTITY_COLUMNS=[...IDENTITY_COLUMNS,'search_schemas'];
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const fail=code=>{throw Error('GRAPH_ADMIN_'+code);};
const check=(ok,code)=>{if(!ok)fail(code);};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);

// Worker read specs are reviewed SQL, not caller-entered queries. Prevent a
// SELECT-prefixed batch from smuggling another command through that allowlist.
function singleSelect(sql){
 if(!/^\s*SELECT\b/i.test(sql))return false;
 for(let i=0;i<sql.length;i++){
  const c=sql[i];
  if(c==='\''||c==='"'){const quote=c,escaped=quote==="'"&&/(?:^|[^A-Za-z_0-9])E$/i.test(sql.slice(0,i));let ended=false;for(i++;i<sql.length;i++){if(escaped&&sql[i]==='\\'){i++;continue;}if(sql[i]===quote){if(sql[i+1]===quote){i++;continue;}ended=true;break;}}if(!ended)return false;continue;}
  if(sql.slice(i,i+2)==='--'){const end=sql.indexOf('\n',i+2);if(end<0)return true;i=end;continue;}
  if(sql.slice(i,i+2)==='/*'){let depth=1;i+=2;while(i<sql.length&&depth){if(sql.slice(i,i+2)==='/*'){depth++;i+=2;}else if(sql.slice(i,i+2)==='*/'){depth--;i+=2;}else i++;}if(depth)return false;i--;continue;}
  if(c==='$'){const delimiter=/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i))?.[0];if(delimiter){const end=sql.indexOf(delimiter,i+delimiter.length);if(end<0)return false;i=end+delimiter.length-1;continue;}}
  if(c===';')return sql.slice(i+1).trim()==='';
 }
 return true;
}
function createDbGateSession({origin:inputOrigin,accessToken,connection,mode='legacy',database,reads=[],authorizeWrite,fetch:fetchImpl=globalThis.fetch,timers={setTimeout,clearTimeout,setInterval,clearInterval}}){
 check(['legacy','worker-access','worker-scope-read'].includes(mode),'MODE');
 const scopedRead=mode==='worker-scope-read',workerMode=mode!=='legacy';
 check(scopedRead?(typeof database==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(database)&&!/^template[01]$/.test(database)):(database===undefined||database==='listmonk'),'DATABASE_CONFIG');
 const expectedDatabase=scopedRead?database:'listmonk',identitySQL=workerMode?WORKER_IDENTITY_SQL:IDENTITY_SQL,identityColumns=workerMode?WORKER_IDENTITY_COLUMNS:IDENTITY_COLUMNS;
 let origin;try{const u=new URL(inputOrigin);check(u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash&&(!u.port||u.port==='443'),'ORIGIN');origin=u.origin;}catch{fail('ORIGIN');}
 check(typeof accessToken==='string'&&/^[A-Za-z0-9_-]{16,256}$/.test(accessToken),'ACCESS_TOKEN');
 check(object(connection)&&typeof connection.id==='string'&&connection.id.length>0&&connection.id.length<=128&&/^[a-z][a-z0-9_-]{0,100}$/.test(connection.server),'CONNECTION_CONFIG');
 check(typeof fetchImpl==='function'&&(scopedRead?authorizeWrite===undefined:typeof authorizeWrite==='function')&&Array.isArray(reads),'CONFIG');
 const expected={id:connection.id,server:connection.server};
 const readSpecs=new Map();
 for(const item of reads){check(object(item)&&typeof item.sql==='string'&&/^\s*SELECT\b/i.test(item.sql)&&Array.isArray(item.columns)&&item.columns.length>0&&item.columns.every(x=>typeof x==='string'&&x.length>0)&&new Set(item.columns).size===item.columns.length&&Number.isSafeInteger(item.maxRows)&&item.maxRows>=1&&item.maxRows<=100,'READ_SPEC');if(workerMode)check(singleSelect(item.sql),'READ_SPEC_COMMAND');check(!readSpecs.has(item.sql),'DUPLICATE_READ');readSpecs.set(item.sql,{columns:[...item.columns],maxRows:item.maxRows});}
 let cookie=null,bearer=null,sid=null,streamController=null,streamReader=null,pingTimer=null,pending=null,closeWait=null;
 let state='new',busy=false,poisoned=false,writeAttempted=false,ownedClosed=false,pid=null;
 const appName=(mode==='legacy'?'crm-graph-install-':scopedRead?'crm-graph-worker-scope-':'crm-graph-worker-access-')+crypto.randomUUID(),streamId=crypto.randomUUID();
 function poison(){poisoned=true;if(pending){pending.reject(Error('GRAPH_ADMIN_SESSION_UNKNOWN'));pending=null;}}
 async function fetchRaw(path,{method='POST',body,bootstrap=false,stream=false,consume}={}){
  const url=new URL(path,origin);if(bootstrap)url.searchParams.set('easypanel-token',accessToken);
  const headers={accept:stream?'text/event-stream':'application/json'};if(cookie)headers.cookie=cookie;if(bearer)headers.authorization='Bearer '+bearer;
  if(body!==undefined)headers['content-type']='application/json';
  const controller=stream?streamController:new AbortController();let response,rejectDeadline;
  const deadline=new Promise((resolve,reject)=>{rejectDeadline=reject;});deadline.catch(()=>{});
  const timeout=timers.setTimeout(()=>{controller.abort();if(response?.body&&!response.body.locked)void response.body.cancel().catch(()=>{});rejectDeadline(Error('GRAPH_ADMIN_TRANSPORT_UNKNOWN'));},35000);
  const operation=(async()=>{response=await fetchImpl(url.href,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:controller.signal});return consume?consume(response,controller.signal):response;})();
  try{return await Promise.race([operation,deadline]);}catch(error){if(/^GRAPH_ADMIN_[A-Z_]+$/.test(error?.message))throw error;fail('TRANSPORT_UNKNOWN');}finally{timers.clearTimeout(timeout);}
 }
 async function parse(response,signal){
  check(response&&response.headers&&Number.isInteger(response.status),'HTTP_RESPONSE');let bytes=0;const chunks=[];
  const length=response.headers.get('content-length');if(length!==null)check(/^\d+$/.test(length)&&Number(length)<=1024*1024,'RESPONSE_LIMIT');
  let reader;const abort=()=>{void reader?.cancel().catch(()=>{});};
  try{reader=response.body.getReader();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>1024*1024){void reader.cancel().catch(()=>{});fail('RESPONSE_LIMIT');}chunks.push(Buffer.from(item.value));}}catch(error){if(error.message==='GRAPH_ADMIN_RESPONSE_LIMIT')throw error;fail('RESPONSE_UNKNOWN');}finally{signal.removeEventListener('abort',abort);reader?.releaseLock();}
  check(!signal.aborted,'TRANSPORT_UNKNOWN');try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('RESPONSE_JSON_UNKNOWN');}
 }
 async function post(path,body={}){return fetchRaw(path,{body,consume:async(response,signal)=>{check(response.status===200,'HTTP_UNKNOWN');const value=await parse(response,signal);check(!(object(value)&&('apiErrorMessage'in value||'error'in value||value.missingCredentials)),'API_REJECTED');return value;}});}
 async function authenticate(){
  const response=await fetchRaw('/',{method:'GET',bootstrap:true});let redirect;try{redirect=new URL(response.headers.get('location'),origin);}catch{fail('AUTH_REDIRECT');}
  check(response.status===302&&redirect.origin===origin&&redirect.pathname==='/'&&!redirect.search&&!redirect.hash&&!redirect.username&&!redirect.password,'AUTH_REDIRECT');
  const cookies=response.headers.getSetCookie?.();check(Array.isArray(cookies)&&cookies.length===1,'AUTH_COOKIE');
  const parts=cookies[0].split(';').map(x=>x.trim());check(/^easypanel_token=[A-Za-z0-9_.~%+-]{1,4096}$/.test(parts[0]),'AUTH_COOKIE');
  const attrs=Object.fromEntries(parts.slice(1).map(x=>{const i=x.indexOf('=');return [x.slice(0,i<0?undefined:i).toLowerCase(),i<0?true:x.slice(i+1)];}));
  check(!attrs.domain&&(attrs.path===undefined||attrs.path==='/')&&attrs.httponly===true,'AUTH_COOKIE_SCOPE');cookie=parts[0];void response.body?.cancel().catch(()=>{});
  const config=await post('/config/get');check(config.version===VERSION&&config.buildTime===BUILD_TIME&&config.isDocker===true&&config.isElectron===false,'VERSION');
  const providers=await post('/auth/get-providers');check(providers.default==='none'&&Array.isArray(providers.providers)&&providers.providers.length===1&&providers.providers[0].amoid==='none'&&providers.providers[0].workflowType==='anonymous','AUTH_PROVIDER');
  const login=await post('/auth/login',{amoid:'none'});check(typeof login.accessToken==='string'&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(login.accessToken),'AUTH_TOKEN');bearer=login.accessToken;
  const connections=await post('/connections/list');check(Array.isArray(connections),'CONNECTION_LIST');const matches=connections.filter(c=>c?._id===expected.id);check(matches.length===1,'CONNECTION_ID');const c=matches[0];
  check(c.engine==='postgres@dbgate-plugin-postgres'&&c.server===expected.server&&c.user==='postgres'&&(c.port===undefined||c.port===null||c.port===''||String(c.port)==='5432')&&c.useDatabaseUrl===false&&!c.isReadOnly&&!c.useSshTunnel&&(!c.authType||c.authType==='password'),'CONNECTION_DRIFT');
 }
 function acceptFrame(frame){
  let event='',data=[];for(const line of frame.split('\n')){if(line.startsWith('event:'))event=line.slice(6).trim();else if(line.startsWith('data:'))data.push(line.slice(5).trimStart());}
  if(!sid||!['session-info-'+sid,'session-recordset-'+sid,'session-done-'+sid,'session-closed-'+sid].includes(event))return;
  let value;try{value=JSON.parse(data.join('\n'));}catch{poison();return;}
  if(event==='session-closed-'+sid){ownedClosed=true;closeWait?.();poison();return;}
  if(!pending)return;
  if(event==='session-info-'+sid){if(value?.severity==='error')pending.error=true;return;}
  if(event==='session-recordset-'+sid){if(!uuid(value?.jslid)||value.resultIndex!==0||pending.records.length!==0){poison();return;}pending.records.push(value.jslid);return;}
  if(event==='session-done-'+sid){const current=pending;pending=null;current.resolve({error:current.error,records:current.records});}
 }
 async function startStream(){
  streamController=new AbortController();const response=await fetchRaw('/stream?strmid='+streamId,{method:'GET',stream:true});check(response.status===200&&response.headers.get('content-type')?.startsWith('text/event-stream'),'SSE_HTTP');streamReader=response.body.getReader();
  // No automatic EventSource reconnect. Lost events make outcome uncertain.
  (async()=>{const decoder=new TextDecoder();let buffer='';try{for(;;){const item=await streamReader.read();if(item.done){if(state!=='closed')poison();break;}buffer=(buffer+decoder.decode(item.value,{stream:true})).replaceAll('\r\n','\n');check(Buffer.byteLength(buffer)<=65536,'SSE_LIMIT');let end;while((end=buffer.indexOf('\n\n'))!==-1){acceptFrame(buffer.slice(0,end));buffer=buffer.slice(end+2);}}}catch{if(state!=='closed')poison();}})();
 }
 async function execute(sql,spec){
  check(sid&&!poisoned&&!pending,'SESSION_UNKNOWN');
  let resolve,reject;const completion=new Promise((a,b)=>{resolve=a;reject=b;});completion.catch(()=>{});
  pending={resolve,reject,error:false,records:[]};let rejectDeadline;const deadline=new Promise((resolve,reject)=>{rejectDeadline=reject;});deadline.catch(()=>{});
  const timeout=timers.setTimeout(()=>{poison();rejectDeadline(Error('GRAPH_ADMIN_SESSION_UNKNOWN'));},35000);
  const operation=(async()=>{
   const ack=await post('/sessions/execute-query',{sesid:sid,sql});check(ack?.state==='ok','EXECUTE_ACK_UNKNOWN');const done=await completion;
   check(!done.error,'SQL_REJECTED');
   if(!spec){check(done.records.length===0,'UNEXPECTED_RECORDSET');return [];}
   check(done.records.length===1,'RECORDSET_MISSING');const jslid=done.records[0];let stats;
   for(let attempt=0;attempt<10;attempt++){stats=await post('/jsldata/get-stats',{jslid});if(stats.isFinished===true)break;await new Promise(r=>timers.setTimeout(r,50));}
   check(stats.isFinished===true&&Number.isSafeInteger(stats.rowCount)&&stats.rowCount>=0&&stats.rowCount<=spec.maxRows,'RESULT_NOT_FINISHED_OR_LIMIT');
   const header=await post('/jsldata/get-info',{jslid});check(Array.isArray(header.columns)&&JSON.stringify(header.columns.map(c=>c.columnName).sort())===JSON.stringify([...spec.columns].sort()),'RESULT_COLUMNS');
   const rows=await post('/jsldata/get-rows',{jslid,offset:0,limit:spec.maxRows+1});check(Array.isArray(rows)&&rows.length===stats.rowCount&&rows.every(row=>object(row)&&JSON.stringify(Object.keys(row).sort())===JSON.stringify([...spec.columns].sort())),'RESULT_ROWS');check(!poisoned,'SESSION_UNKNOWN');return rows;
  })();
  try{return await Promise.race([operation,deadline]);}catch(error){if(error.message!=='GRAPH_ADMIN_SQL_REJECTED')poison();throw error;}finally{timers.clearTimeout(timeout);pending=null;}
 }
 async function identity(requireTimeout=true){
  let previous=null,proof;
  // Consecutive independently dispatched SELECTs must receive distinct transaction
  // IDs. Never publish those changing IDs as part of the pinned session identity.
  for(let attempt=0;attempt<2;attempt++){
   const rows=await execute(identitySQL,{columns:identityColumns,maxRows:1}),r=rows[0];check(rows.length===1&&r.database===expectedDatabase&&r.role==='postgres'&&Number.isSafeInteger(r.pid)&&r.pid>0&&(pid===null||pid===r.pid),'DB_IDENTITY');
   check(r.transaction_isolation==='read committed'&&(scopedRead?(requireTimeout?r.transaction_read_only==='on':['on','off'].includes(r.transaction_read_only)):r.transaction_read_only==='off')&&typeof r.transaction_id==='string'&&/^[0-9]+$/.test(r.transaction_id),'DB_TRANSACTION');
   check(previous===null||previous!==r.transaction_id,'AUTOCOMMIT_UNPROVEN');previous=r.transaction_id;
   if(requireTimeout){check(r.statement_timeout_ms===TIMEOUT_MS&&r.application_name===appName,'DB_TIMEOUT');if(workerMode)check(JSON.stringify(r.search_schemas)===JSON.stringify(['pg_catalog','public']),'DB_SEARCH_PATH');}
   pid=r.pid;const {transaction_id,...stable}=r;proof={version:VERSION,sessionid:sid,...stable,autocommit:true};
  }
  return proof;
 }
 async function exclusive(run){check(!busy,'BUSY');busy=true;try{return await run();}finally{busy=false;}}
 return Object.freeze({
  open:()=>exclusive(async()=>{
   check(state==='new','OPEN_ALREADY_ATTEMPTED');state='opening';await authenticate();await startStream();
   const created=await post('/sessions/create',{conid:expected.id,database:expectedDatabase});check(uuid(created.sesid)&&created.conid===expected.id&&created.database===expectedDatabase,'CREATE_UNKNOWN');sid=created.sesid;
   const ping=async()=>{try{const ack=await post('/sessions/ping',{sesid:sid});if(ack?.state!=='ok')poison();}catch{poison();}};
   await ping();check(!poisoned,'PING_UNKNOWN');pingTimer=timers.setInterval(ping,10000);pingTimer?.unref?.();
   await identity(false);await execute('SET statement_timeout = 20000;',null);await execute("SET application_name = '"+appName+"';",null);
   if(workerMode)await execute('SET search_path = pg_catalog,public;',null);
   if(scopedRead)await execute('SET default_transaction_read_only = on;',null);
   const proof=await identity();state='open';return {opened:true,...proof};
  }),
  identity:()=>exclusive(async()=>{check(state==='open'&&!poisoned,'NOT_OPEN');return identity();}),
  sql:sql=>exclusive(async()=>{
   check(state==='open'&&!poisoned,'NOT_OPEN');check(typeof sql==='string'&&Buffer.byteLength(sql)>0&&Buffer.byteLength(sql)<=1024*1024,'SQL_SIZE');
   const spec=readSpecs.get(sql);if(spec){if(workerMode)await identity();return execute(sql,spec);}
   check(!scopedRead,'SQL_NOT_ALLOWED');
   const block=sql.match(mode==='worker-access'?/^DO \$(credential_prepare|worker_access)\$([\s\S]*)\$\1\$;\s*$/:/^DO \$(graph_install|acl_preservation)\$([\s\S]*)\$\1\$;\s*$/);check(block&&!block[2].includes('$'+block[1]+'$'),'SQL_NOT_ALLOWED');check(!writeAttempted,'WRITE_ALREADY_ATTEMPTED');
   const proof=await identity();let authorized=false;try{authorized=await authorizeWrite({sql,sha256:sha(sql),session:proof});}catch{writeAttempted=true;fail('INTENT_UNKNOWN');}
   check(authorized===true,'WRITE_NOT_AUTHORIZED');writeAttempted=true;
   return execute(sql,null);
  }),
  close:()=>exclusive(async()=>{
   check(state!=='closed','NO_OWN_SESSION');state='closing';if(pingTimer)timers.clearInterval(pingTimer);
   let timeout;const closed=new Promise((resolve,reject)=>{closeWait=resolve;timeout=timers.setTimeout(()=>reject(Error('GRAPH_ADMIN_CLOSE_UNKNOWN')),5000);});closed.catch(()=>{});
   try{check(sid,'NO_OWN_SESSION');if(!ownedClosed){const ack=await post('/sessions/kill',{sesid:sid});check(ack?.state==='ok','CLOSE_UNKNOWN');await closed;}return {closed:true};}
   finally{state='closed';timers.clearTimeout(timeout);closeWait=null;await streamReader?.cancel().catch(()=>{});streamController?.abort();cookie=null;bearer=null;}
  })
 });
}
module.exports={createDbGateSession,VERSION,BUILD_TIME,TIMEOUT_MS,IDENTITY_SQL,IDENTITY_COLUMNS,WORKER_IDENTITY_SQL,WORKER_IDENTITY_COLUMNS};
