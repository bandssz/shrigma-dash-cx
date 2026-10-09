'use strict';
const crypto=require('node:crypto');
const {isProxy}=require('node:util').types;
const RESOURCE=Object.freeze({project:'comunicacao',service:'postgres',host:'comunicacao_postgres',port:5432,database:'listmonk',network:'easypanel'}),PURPOSE='read-only-original-email-health';
const BEGIN='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',ROLLBACK='ROLLBACK';
const PEER="SELECT pg_catalog.current_database() AS database,session_user::text AS \"sessionRole\",current_user::text AS \"currentRole\",pg_catalog.pg_backend_pid() AS pid,pg_catalog.inet_server_port() AS port,pg_catalog.current_setting('server_version_num')::integer AS engine,(SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid()) AS ssl,pg_catalog.current_setting('transaction_read_only') AS read_only";
const READ_SQL="SELECT payload FROM public.shrigma_growth_email_ses_health_v1 WHERE pg_catalog.current_database()='listmonk'";
const queryHash=crypto.createHash('sha256').update(READ_SQL).digest('hex');
const own=new WeakSet();function error(code,status=503){const e=Object.assign(new Error(code),{code,status});own.add(e);return e;}
function plain(x){if(!x||typeof x!=='object'||Array.isArray(x)||![Object.prototype,null].includes(Object.getPrototypeOf(x)))throw error('HEALTH_INPUT_REFUSED',400);const o={};for(const k of Reflect.ownKeys(x)){const d=Object.getOwnPropertyDescriptor(x,k);if(typeof k!=='string'||!d.enumerable||!Object.hasOwn(d,'value')||['__proto__','constructor','prototype'].includes(k))throw error('HEALTH_INPUT_REFUSED',400);o[k]=d.value;}return o;}
function exact(x,keys){if(Object.keys(x).sort().join(',')!==[...keys].sort().join(','))throw error('HEALTH_INPUT_REFUSED',400);}
function sorted(x){if(x===null||typeof x!=='object')return x;if(Array.isArray(x))return x.map(sorted);return Object.fromEntries(Object.keys(x).sort().map(k=>[k,sorted(x[k])]));}function canon(x){return JSON.stringify(sorted(x));}const hash=x=>crypto.createHash('sha256').update(x).digest('hex'),resourceHash=hash(canon(RESOURCE));
function timeout(p,ms){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(error('HEALTH_TIMEOUT')),ms);})]).finally(()=>clearTimeout(timer));}
function credential(raw,ownerId){const p=plain(raw);exact(p,['schema','revision','ownerId','username','password','resource','transport']);const r=plain(p.resource),t=plain(p.transport);exact(r,Object.keys(RESOURCE));exact(t,['mode']);if(p.schema!=='shrigma-private-database-credential-v1'||p.ownerId!==ownerId||!Number.isSafeInteger(p.revision)||p.revision<1||typeof p.username!=='string'||!p.username||Buffer.byteLength(p.username)>63||/[\x00-\x1f\x7f]/.test(p.username)||typeof p.password!=='string'||!p.password||Buffer.byteLength(p.password)>4096||p.password.includes('\0')||canon(r)!==canon(RESOURCE)||t.mode!=='admitted-private-network')throw error('HEALTH_CREDENTIAL_REFUSED');return {...p,resource:r,transport:t};}


function iso(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)||!Number.isFinite(Date.parse(v)))return false;const y=Number(v.slice(0,4)),m=Number(v.slice(5,7)),d=Number(v.slice(8,10)),date=new Date(0);date.setUTCFullYear(y,m-1,d);return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d&&Number(v.slice(11,13))<24&&Number(v.slice(14,16))<60&&Number(v.slice(17,19))<60;}
const METRICS=Object.freeze(['finalizacao_pendente','entregue_sem_gravacao','resultado_incerto','sem_confirmacao_15min','falhas_24h','reclamacoes_24h']);
// Diagnostics never contain payload values, arbitrary keys or upstream errors.
const refusalDiagnostics=new WeakMap();
function actualType(value){if(value===null)return 'null';if(isProxy(value))return 'other';if(Array.isArray(value))return 'array';const t=typeof value;return ['object','string','number','boolean','undefined'].includes(t)?t:'other';}
function rejectedBrandSet(value){
 // Called only for the existing length!=2 refusal on a non-proxy array.
 if(isProxy(value)||!Array.isArray(value))return null;
 const lengthDescriptor=Object.getOwnPropertyDescriptor(value,'length');
 if(!lengthDescriptor||!Object.hasOwn(lengthDescriptor,'value')||!Number.isSafeInteger(lengthDescriptor.value)||lengthDescriptor.value<0)return null;
 const length=lengthDescriptor.value;
 const unavailable=()=>Object.freeze({length,inspection:'unavailable',fish:null,aristo:null,other:null,malformed:null});
 if(length>64||Object.getPrototypeOf(value)!==Array.prototype)return unavailable();
 const arrayKeys=Reflect.ownKeys(value);
 if(arrayKeys.length!==length+1||!arrayKeys.includes('length'))return unavailable();
 const entries=[];
 for(let i=0;i<length;i++){
  const d=Object.getOwnPropertyDescriptor(value,String(i));
  if(!d||!d.enumerable||!Object.hasOwn(d,'value'))return unavailable();
  entries.push(d.value);
 }
 let fish=0,aristo=0,other=0,malformed=0;
 for(let i=0;i<entries.length;i++){
  const entry=entries[i];
  if(isProxy(entry))return unavailable();
  if(!entry||typeof entry!=='object'||Array.isArray(entry)||![Object.prototype,null].includes(Object.getPrototypeOf(entry))){malformed++;continue;}
  const keys=Reflect.ownKeys(entry),expected=['marca',...METRICS];
  if(keys.length!==expected.length||keys.some(k=>typeof k!=='string'||!expected.includes(k))){malformed++;continue;}
  let marcaDescriptor;
  for(let i=0;i<keys.length;i++){const k=keys[i],d=Object.getOwnPropertyDescriptor(entry,k);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))return unavailable();if(k==='marca')marcaDescriptor=d;}
  // Metric values are intentionally never accessed or interpreted here.
  const marca=marcaDescriptor.value;
  if(typeof marca!=='string')malformed++;else if(marca==='fish')fish++;else if(marca==='aristo')aristo++;else other++;
 }
 return Object.freeze({length,inspection:'complete',fish,aristo,other,malformed});
}
function protocolRefused(field,reason,value){const e=error('HEALTH_PROTOCOL_REFUSED');const diagnostic={schema:'shrigma-email-health-protocol-refusal-v1',field,reason,actualType:actualType(value)};if(field==='brands'&&reason==='brand-set'&&diagnostic.actualType==='array'){const brandSet=rejectedBrandSet(value);if(brandSet)diagnostic.brandSet=brandSet;}refusalDiagnostics.set(e,Object.freeze(diagnostic));return e;}
function protocolDiagnostic(e){return refusalDiagnostics.get(e)||null;}
function payloadObject(value,field,keys){
 if(!value||typeof value!=='object'||isProxy(value)||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw protocolRefused(field,'object',value);
 const names=Reflect.ownKeys(value),out={};
 if(names.length!==keys.length||names.some(k=>typeof k!=='string'||!keys.includes(k)))throw protocolRefused(field,'keys',value);
 for(const k of names){const d=Object.getOwnPropertyDescriptor(value,k);if(!d.enumerable||!Object.hasOwn(d,'value'))throw protocolRefused(field,'keys',value);out[k]=d.value;}
 return out;
}
const METRIC_FIELDS=Object.freeze({finalizacao_pendente:'brands.finalizacao_pendente',entregue_sem_gravacao:'brands.entregue_sem_gravacao',resultado_incerto:'brands.resultado_incerto',sem_confirmacao_15min:'brands.sem_confirmacao_15min',falhas_24h:'brands.falhas_24h',reclamacoes_24h:'brands.reclamacoes_24h'});
function validatePayload(raw,brand){
 try{
  if(!['fish','aristo'].includes(brand))throw protocolRefused('brands.marca','brand-set',brand);
  const v=payloadObject(raw,'payload',['schema_version','checked_at','collector','queue','pending_ingest_15min','conflicts','brands']);
  const collector=payloadObject(v.collector,'collector',['last_poll_ok_at','last_poll_count','last_error_at','last_error_code']);
  const queue=payloadObject(v.queue,'queue',['checked_at','visible','inflight','delayed','error_at']);
  const count=x=>Number.isSafeInteger(x)&&x>=0;
  const check=(ok,field,reason,value)=>{if(!ok)throw protocolRefused(field,reason,value);};
  check(v.schema_version===1,'schema_version','schema-version',v.schema_version);
  check(iso(v.checked_at),'checked_at','timestamp',v.checked_at);
  check(count(v.pending_ingest_15min),'pending_ingest_15min','count',v.pending_ingest_15min);
  check(count(v.conflicts),'conflicts','count',v.conflicts);
  check(collector.last_poll_ok_at===null||iso(collector.last_poll_ok_at),'collector.last_poll_ok_at','timestamp',collector.last_poll_ok_at);
  check(collector.last_poll_count===null||count(collector.last_poll_count),'collector.last_poll_count','count',collector.last_poll_count);
  check(collector.last_error_at===null||iso(collector.last_error_at),'collector.last_error_at','timestamp',collector.last_error_at);
  check(collector.last_error_code===null||typeof collector.last_error_code==='string'&&(/^[A-Z_]{1,80}$/).test(collector.last_error_code),'collector.last_error_code','error-code',collector.last_error_code);
  check(queue.checked_at===null||iso(queue.checked_at),'queue.checked_at','timestamp',queue.checked_at);
  check(queue.error_at===null||iso(queue.error_at),'queue.error_at','timestamp',queue.error_at);
  check(queue.visible===null||count(queue.visible),'queue.visible','count',queue.visible);
  check(queue.inflight===null||count(queue.inflight),'queue.inflight','count',queue.inflight);
  check(queue.delayed===null||count(queue.delayed),'queue.delayed','count',queue.delayed);
  if(isProxy(v.brands)||!Array.isArray(v.brands))throw protocolRefused('brands','array',v.brands);
  if(v.brands.length!==2)throw protocolRefused('brands','brand-set',v.brands);
  if(Object.getPrototypeOf(v.brands)!==Array.prototype||Reflect.ownKeys(v.brands).length!==3||['0','1'].some(k=>!Object.hasOwn(Object.getOwnPropertyDescriptor(v.brands,k)||{},'value')))throw protocolRefused('brands','array',v.brands);
  const seen=new Set(),safeBrands=[];let selected;
  for(let i=0;i<2;i++){
   const b=payloadObject(Object.getOwnPropertyDescriptor(v.brands,String(i)).value,'brands',['marca',...METRICS]);
   if(!['fish','aristo'].includes(b.marca)||seen.has(b.marca))throw protocolRefused('brands.marca','brand-set',b.marca);
   for(const k of METRICS)check(count(b[k]),METRIC_FIELDS[k],'count',b[k]);
   seen.add(b.marca);safeBrands.push(b);if(b.marca===brand)selected=Object.freeze(Object.fromEntries(METRICS.map(k=>[k,b[k]])));
  }
  // Serialize only the validated primitive copies, never the invalid source.
  if(Buffer.byteLength(canon({...v,collector,queue,brands:safeBrands}))>8192)throw protocolRefused('payload','size',raw);
  return {sourceCheckedAt:v.checked_at,collector:Object.freeze(collector),queue:Object.freeze(queue),brandMetrics:selected,pendingIngest15min:v.pending_ingest_15min,conflicts:v.conflicts};
 }catch(e){if(refusalDiagnostics.has(e))throw e;throw protocolRefused('payload','unknown',raw);}
}
// BEGIN PRIVATE FIXED SOURCE SCOPE PROJECTION
function validatePrivateSource(raw,brand){
 let original;
 try{return validatePayload(raw,brand);}catch(e){original=e;}
 const d=protocolDiagnostic(original),set=d?.brandSet;
 if(d?.field!=='brands'||d.reason!=='brand-set'||d.actualType!=='array'||set?.inspection!=='complete'||set.length<3||set.length>64||set.fish!==1||set.aristo!==1||set.malformed!==0)throw original;
 let projected;
 try{
  // Recheck every descriptor before copying; never read foreign metric values.
  const top=payloadObject(raw,'payload',['schema_version','checked_at','collector','queue','pending_ingest_15min','conflicts','brands']);
  const array=top.brands;
  if(isProxy(array)||!Array.isArray(array)||Object.getPrototypeOf(array)!==Array.prototype)throw original;
  const length=Object.getOwnPropertyDescriptor(array,'length');
  if(!length||!Object.hasOwn(length,'value')||length.value!==set.length||Reflect.ownKeys(array).length!==set.length+1)throw original;
  const selected=[];const seen=new Set();
  for(let i=0;i<set.length;i++){
   const item=Object.getOwnPropertyDescriptor(array,String(i));
   if(!item||!item.enumerable||!Object.hasOwn(item,'value'))throw original;
   const row=item.value,keys=['marca',...METRICS];
   if(!row||typeof row!=='object'||isProxy(row)||Array.isArray(row)||![Object.prototype,null].includes(Object.getPrototypeOf(row)))throw original;
   const names=Reflect.ownKeys(row),descriptors={};
   if(names.length!==keys.length||names.some(k=>typeof k!=='string'||!keys.includes(k)))throw original;
   for(let j=0;j<names.length;j++){const k=names[j],desc=Object.getOwnPropertyDescriptor(row,k);if(!desc||!desc.enumerable||!Object.hasOwn(desc,'value'))throw original;descriptors[k]=desc;}
   const marca=descriptors.marca.value;
   if(typeof marca!=='string')throw original;
   if(marca==='fish'||marca==='aristo'){
    if(seen.has(marca))throw original;seen.add(marca);
    const copy={marca};for(let j=0;j<METRICS.length;j++){const k=METRICS[j];copy[k]=descriptors[k].value;}selected.push(copy);
   }
  }
  if(seen.size!==2)throw original;
  projected={...top,brands:selected};
 }catch{throw original;}
 // Expected-brand metric failures are diagnosed by the unchanged validator.
 return validatePayload(projected,brand);
}
// END PRIVATE FIXED SOURCE SCOPE PROJECTION
function createDeliveryHealthRead({enabled=false,driver,getPrivateCredential,admitHealth,now=Date.now}={}){
 const ready=enabled===true&&typeof driver?.Client==='function'&&driver.version==='8.23.1'&&/^[a-f0-9]{64}$/.test(driver.packageSha256||'')&&typeof getPrivateCredential==='function'&&typeof admitHealth==='function'&&typeof now==='function';
 let active=null,closing=false,closed=false,closePromise=null,blocked=false;
 async function end(s){if(!s)return;if(!s.endPromise){s.endRequested=true;s.endPromise=(async()=>{try{await timeout(Promise.resolve().then(()=>s.raw.end()),5000);if(!s.ended)throw error('HEALTH_CLOSE_UNCONFIRMED');}catch(e){blocked=true;throw own.has(e)?e:error('HEALTH_CLOSE_FAILED');}})();s.endPromise.catch(()=>{});}return s.endPromise;}
 function valid(t){if(t!==active||!t.valid||t.fatal)throw error('HEALTH_SESSION_REFUSED');}
 async function admission(t,phase,p,peer){const expected={admitted:true,ownerId:p.ownerId,profileRevision:p.revision,credentialBindingHash:hash(canon({schema:p.schema,revision:p.revision,ownerId:p.ownerId,username:p.username,resource:p.resource,transport:p.transport})),resourceHash,queryHash,purpose:PURPOSE};let answer;try{answer=plain(await timeout(Promise.resolve().then(()=>admitHealth({phase,...Object.fromEntries(Object.entries(expected).filter(([key])=>key!=='admitted')),...(peer?{peer:Object.freeze({...peer})}:{})})),5000));}catch{throw error('HEALTH_ADMISSION_REFUSED');}valid(t);exact(answer,Object.keys(expected));if(canon(answer)!==canon(expected))throw error('HEALTH_ADMISSION_REFUSED');}
 async function query(t,sql,command,state,values){valid(t);const s=t.session,seq=s.seq;s.awaiting=true;s.expected=state;let r;try{r=await timeout(Promise.resolve().then(()=>s.raw.query(values?{text:sql,values:[...values]}:sql)),12000);}catch{t.fatal=true;throw error('HEALTH_QUERY_FAILED');}valid(t);if(s.seq<=seq){await timeout(new Promise(resolve=>s.waiters.add(resolve)),2000);valid(t);}s.awaiting=false;if(s.seq!==seq+1||s.tx!==state||!r||Array.isArray(r)||r.command!==command||!Array.isArray(r.rows)||(command==='SELECT'?(!Number.isSafeInteger(r.rowCount)||r.rowCount!==r.rows.length):(r.rowCount!==null||r.rows.length!==0)))throw error('HEALTH_ACK_UNKNOWN');return r.rows;}
 async function inspect(raw={},context){if(!ready)throw error('HEALTH_OFF');if(closing||closed||blocked)throw error('HEALTH_UNAVAILABLE');if(active)throw error('HEALTH_BUSY');const input=plain(raw);exact(input,['brand']);if(!['fish','aristo'].includes(input.brand))throw error('HEALTH_INPUT_REFUSED',400);const c=plain(context);exact(c,['ownerId']);if(typeof c.ownerId!=='string'||!c.ownerId||c.ownerId.length>256||/[\x00-\x1f]/.test(c.ownerId))throw error('HEALTH_OWNER_REFUSED',400);
 const t={valid:true,fatal:false,session:null,done:null,finish:null};t.done=new Promise(r=>t.finish=r);active=t;
 const work=(async()=>{let p;try{p=credential(await timeout(Promise.resolve().then(()=>getPrivateCredential({ownerId:c.ownerId})),5000),c.ownerId);}catch{throw error('HEALTH_CREDENTIAL_REFUSED');}valid(t);await admission(t,'connect',p);valid(t);if(closing)throw error('HEALTH_UNAVAILABLE');const rawClient=new driver.Client({host:RESOURCE.host,port:RESOURCE.port,database:RESOURCE.database,user:p.username,password:p.password,ssl:false,connectionTimeoutMillis:3000,query_timeout:12000,statement_timeout:8000,lock_timeout:2000,idle_in_transaction_session_timeout:10000,application_name:'shrigma-original-email-health-read',client_encoding:'UTF8',options:'-c search_path=pg_catalog -c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=10000',keepAlive:true,pipeline:false});
 const s={raw:rawClient,ended:false,endRequested:false,endPromise:null,tx:null,seq:0,awaiting:true,expected:'I',waiters:new Set()};t.session=s;
 if(typeof rawClient.on!=='function'||typeof rawClient.connection?.on!=='function'||typeof rawClient.connect!=='function'||typeof rawClient.query!=='function'||typeof rawClient.end!=='function')throw error('HEALTH_DRIVER_REFUSED');const wake=()=>{for(const w of s.waiters)w();s.waiters.clear();};rawClient.on('error',()=>{t.fatal=true;wake();end(s).catch(()=>{});});rawClient.on('end',()=>{s.ended=true;if(!s.endRequested)t.fatal=true;wake();});rawClient.connection.on('readyForQuery',m=>{if(!s.awaiting||m?.status!==s.expected){t.fatal=true;end(s).catch(()=>{});}else{s.tx=m.status;s.seq++;}wake();});
 await timeout(Promise.resolve().then(()=>rawClient.connect()),5000);valid(t);s.awaiting=false;if(s.seq!==1||s.tx!=='I'||rawClient.connection.stream?.encrypted===true)throw error('HEALTH_PEER_REFUSED');const rows=await query(t,PEER,'SELECT','I');if(rows.length!==1)throw error('HEALTH_PEER_REFUSED');const peer=plain(rows[0]);exact(peer,['database','sessionRole','currentRole','pid','port','engine','ssl','read_only']);if(peer.database!==RESOURCE.database||peer.sessionRole!==p.username||peer.currentRole!==p.username||peer.port!==5432||!Number.isInteger(peer.engine)||Math.floor(peer.engine/10000)!==17||!Number.isSafeInteger(peer.pid)||peer.pid<=0||peer.pid!==rawClient.processID||peer.ssl!==false||peer.read_only!=='on')throw error('HEALTH_PEER_REFUSED');await admission(t,'read',p,peer);await query(t,BEGIN,'BEGIN','T');
 const evidenceRows=await query(t,READ_SQL,'SELECT','T');
 if(evidenceRows.length!==1)throw protocolRefused('rows','row-count',evidenceRows);const row=plain(evidenceRows[0]);exact(row,['payload']);
 const payload=validatePrivateSource(row.payload,input.brand);
 await query(t,ROLLBACK,'ROLLBACK','I');valid(t);
 // Confirm closure before the final CURRENT gate: revocation during end()
 // must suppress the otherwise complete read, not race result publication.
 await end(s);valid(t);await admission(t,'release',p,peer);valid(t);
 const clock=now();if(!Number.isSafeInteger(clock)||clock<0||clock>8640000000000000)throw error('HEALTH_CLOCK_REFUSED');
 return Object.freeze({schema:'shrigma-original-email-health-read-v1',brand:input.brand,checkedAt:new Date(clock).toISOString(),...payload,sharedQueue:true,authorizesSend:false,authorizesRecovery:false,operational:false});})();
 let result,failure;try{result=await timeout(work,60000);}catch(e){failure=own.has(e)?e:error('HEALTH_REFUSED');}finally{t.valid=false;try{await end(t.session);}catch(e){failure=own.has(e)?e:error('HEALTH_CLOSE_FAILED');}active=null;t.finish();}if(failure)throw failure;return result;
 }
 function close(){if(closePromise)return closePromise;closing=true;closePromise=(async()=>{if(active){const t=active;try{await timeout(t.done,15000);}catch{t.valid=false;t.fatal=true;await end(t.session);}}if(blocked)throw error('HEALTH_CLOSE_UNCONFIRMED');closed=true;return Object.freeze({closed:true,operational:false});})();closePromise.catch(()=>{});return closePromise;}
 return Object.freeze({inspect,close});
}
module.exports=Object.freeze({createDeliveryHealthRead,PURPOSE,RESOURCE,PEER,BEGIN,ROLLBACK,READ_SQL,queryHash,validatePayload,protocolDiagnostic});
