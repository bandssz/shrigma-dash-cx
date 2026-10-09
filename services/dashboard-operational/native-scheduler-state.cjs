'use strict';
const crypto=require('node:crypto');
const {isProxy}=require('node:util').types;
const PURPOSE='crm.scheduler-state-read';
const RESOURCE=Object.freeze({project:'comunicacao',service:'postgres',host:'comunicacao_postgres',port:5432,database:'listmonk',network:'easypanel'});
const BEGIN='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',ROLLBACK='ROLLBACK';
const EXPECTED_SELECTION_QUERY='084a9493713b21b618d24daae98b38db59fb84febf0c367914bea1ed7aa84c2d';
const H=/^[a-f0-9]{64}$/;
const canonical=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const resourceHash=sha(canonical(RESOURCE));
const own=new WeakSet();
function error(code,status=503){const e=Object.assign(Error(code),{code,status});own.add(e);return e;}
function object(v,keys){
 if(!v||isProxy(v)||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');
 const names=Reflect.ownKeys(v);if(names.length!==keys.length||names.some(k=>typeof k!=='string'||!keys.includes(k)))throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');
 const copy={};for(const k of names){const d=Object.getOwnPropertyDescriptor(v,k);if(!d?.enumerable||!Object.hasOwn(d,'value'))throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');copy[k]=d.value;}return copy;
}
function iso(x){if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(x)||!Number.isFinite(Date.parse(x)))return false;const d=new Date(0);d.setUTCFullYear(+x.slice(0,4),+x.slice(5,7)-1,+x.slice(8,10));return d.getUTCFullYear()===+x.slice(0,4)&&d.getUTCMonth()+1===+x.slice(5,7)&&d.getUTCDate()===+x.slice(8,10)&&+x.slice(11,13)<24&&+x.slice(14,16)<60&&+x.slice(17,19)<60&&(!x.includes('+')||+x.slice(-5,-3)<24&&+x.slice(-2)<60);}
function bounded(p,ms,code='SCHEDULER_STATE_TIMEOUT'){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(error(code)),ms);})]).finally(()=>clearTimeout(timer));}
// Metadata is inspected before references to private relations are executed.
// Only pg_catalog and the closed three-relation set are used here.
const CATALOG_SQL=`WITH expected(relation,name) AS (VALUES
 ('deployment','regular_worker_deployment'),('lease','regular_worker_lease'),('selection','selection_runtime'))
SELECT e.relation,c.relkind::text AS kind,
 CASE WHEN c.oid IS NULL THEN false ELSE pg_catalog.has_schema_privilege(n.oid,'USAGE') AND pg_catalog.has_table_privilege(c.oid,'SELECT') END AS readable,
 COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',a.attname,'oid',a.atttypid::integer,'typmod',a.atttypmod) ORDER BY a.attnum)
 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 AND ((e.relation='deployment' AND a.attname IN ('singleton','enabled','worker_sha256','runtime_sha256','query_sha256','database_role','approved_at','approved_by','topology_receipt_sha256'))
  OR (e.relation='lease' AND a.attname IN ('singleton','instance_id','worker_sha256','runtime_sha256','database_role','heartbeat_at','expires_at','suspended','suspension_reason'))
  OR (e.relation='selection' AND a.attname IN ('singleton','enabled','candidate_query_sha256','verified_at')))),'[]'::jsonb) AS columns
FROM expected e LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='crm_audience_v2'
LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=e.name
WHERE pg_catalog.current_database()='listmonk' ORDER BY e.relation`;
const READ_SQL=`WITH at AS (SELECT pg_catalog.statement_timestamp() AS at)
SELECT pg_catalog.jsonb_build_object(
 'checkedAt',at.at,
 'deployment',pg_catalog.jsonb_build_object('present',d.singleton IS NOT NULL,'enabled',d.enabled,
  'approvalPresent',d.worker_sha256 IS NOT NULL AND d.runtime_sha256 IS NOT NULL AND d.query_sha256 IS NOT NULL AND d.database_role IS NOT NULL AND d.approved_at IS NOT NULL AND pg_catalog.isfinite(d.approved_at) AND d.approved_by IS NOT NULL AND pg_catalog.length(d.approved_by)>0 AND d.topology_receipt_sha256 IS NOT NULL,
  'approvalTiming',CASE WHEN d.approved_at IS NULL THEN 'missing' WHEN d.approved_at>at.at THEN 'future' ELSE 'effective' END,
  'queryExpected',d.query_sha256='${EXPECTED_SELECTION_QUERY}'),
 'lease',pg_catalog.jsonb_build_object('present',l.singleton IS NOT NULL,
  'live',CASE WHEN l.singleton IS NULL THEN NULL ELSE l.heartbeat_at<=at.at AND l.expires_at>at.at END,
  'suspended',l.suspended,'reason',l.suspension_reason),
 'deploymentLeaseMatch',pg_catalog.jsonb_build_object('worker',d.worker_sha256=l.worker_sha256,'runtime',d.runtime_sha256=l.runtime_sha256,'databaseRole',d.database_role=l.database_role),
 'selection',pg_catalog.jsonb_build_object('present',s.singleton IS NOT NULL,'enabled',s.enabled,'queryExpected',s.candidate_query_sha256='${EXPECTED_SELECTION_QUERY}','verifiedAt',s.verified_at)) AS payload
FROM at LEFT JOIN crm_audience_v2.regular_worker_deployment d ON d.singleton
LEFT JOIN crm_audience_v2.regular_worker_lease l ON l.singleton
LEFT JOIN crm_audience_v2.selection_runtime s ON s.singleton
WHERE pg_catalog.current_database()='listmonk'`;
const PEER="SELECT pg_catalog.current_database() AS database,session_user::text AS \"sessionRole\",current_user::text AS \"currentRole\",pg_catalog.pg_backend_pid() AS pid,pg_catalog.inet_server_port() AS port,pg_catalog.current_setting('server_version_num')::integer AS engine,(SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid()) AS ssl,pg_catalog.current_setting('transaction_read_only') AS read_only";
// Consent binds the complete fixed SQL protocol, not an arbitrary caller query.
const queryHash=sha([PEER,BEGIN,CATALOG_SQL,READ_SQL,ROLLBACK].join('\n'));
const COLUMN_TYPES=Object.freeze({deployment:{singleton:16,enabled:16,worker_sha256:25,runtime_sha256:25,query_sha256:25,database_role:19,approved_at:1184,approved_by:25,topology_receipt_sha256:25},lease:{singleton:16,instance_id:2950,worker_sha256:25,runtime_sha256:25,database_role:19,heartbeat_at:1184,expires_at:1184,suspended:16,suspension_reason:25},selection:{singleton:16,enabled:16,candidate_query_sha256:25,verified_at:1184}});
for(const columns of Object.values(COLUMN_TYPES))Object.freeze(columns);
function validateCatalog(rows){
 if(!Array.isArray(rows)||rows.length!==3)throw error('SCHEDULER_STATE_DEPENDENCY_MISSING');const seen=new Set();
 for(const raw of rows){const r=object(raw,['relation','kind','readable','columns']);if(!Object.hasOwn(COLUMN_TYPES,r.relation)||seen.has(r.relation))throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');seen.add(r.relation);if(r.kind===null)throw error('SCHEDULER_STATE_DEPENDENCY_MISSING');if(r.kind!=='r')throw error('SCHEDULER_STATE_SCHEMA_REFUSED');if(r.readable!==true)throw error('SCHEDULER_STATE_ACL_REFUSED');
  const expected=COLUMN_TYPES[r.relation];if(!Array.isArray(r.columns)||r.columns.length!==Object.keys(expected).length)throw error('SCHEDULER_STATE_SCHEMA_REFUSED');const cols=new Set();
  for(const v of r.columns){const c=object(v,['name','oid','typmod']);if(!Object.hasOwn(expected,c.name)||cols.has(c.name)||c.oid!==expected[c.name]||c.typmod!==-1)throw error('SCHEDULER_STATE_SCHEMA_REFUSED');cols.add(c.name);}
 }
}
function validateState(raw){
 const v=object(raw,['checkedAt','deployment','lease','deploymentLeaseMatch','selection']),d=object(v.deployment,['present','enabled','approvalPresent','approvalTiming','queryExpected']),l=object(v.lease,['present','live','suspended','reason']),m=object(v.deploymentLeaseMatch,['worker','runtime','databaseRole']),s=object(v.selection,['present','enabled','queryExpected','verifiedAt']);
 const bool=x=>typeof x==='boolean',nullableBool=x=>x===null||bool(x),bad=()=>{throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');};
 if(!iso(v.checkedAt)||!bool(d.present)||!nullableBool(d.enabled)||!bool(d.approvalPresent)||!['missing','future','effective'].includes(d.approvalTiming)||!nullableBool(d.queryExpected)||!bool(l.present)||!nullableBool(l.live)||!nullableBool(l.suspended)||!['competing_instance','identity_changed','deployment_off',null].includes(l.reason)||!Object.values(m).every(nullableBool)||!bool(s.present)||!nullableBool(s.enabled)||!nullableBool(s.queryExpected)||!(s.verifiedAt===null||iso(s.verifiedAt)))bad();
 if(!d.present&&(d.enabled!==null||d.approvalPresent||d.approvalTiming!=='missing'||d.queryExpected!==null)||!l.present&&(l.live!==null||l.suspended!==null||l.reason!==null)||l.present&&(!bool(l.live)||!bool(l.suspended)||l.suspended!==(l.reason!==null))||!s.present&&(s.enabled!==null||s.queryExpected!==null||s.verifiedAt!==null)||d.present&&!bool(d.enabled)||s.present&&!bool(s.enabled)||(!d.present||!l.present)&&Object.values(m).some(x=>x!==null))bad();
 return Object.freeze({schema:'shrigma-original-scheduler-stored-state-v1',checkedAt:v.checkedAt,deployment:Object.freeze(d),lease:Object.freeze(l),deploymentLeaseMatch:Object.freeze(m),selection:Object.freeze(s),storedStateOnly:true,runtimeMeasured:false,causeEstablished:false,authorizesSend:false,authorizesRecovery:false,operational:false});
}
function credential(raw,ownerId){const p=object(raw,['schema','revision','ownerId','username','password','resource','transport']);object(p.resource,Object.keys(RESOURCE));object(p.transport,['mode']);if(p.schema!=='shrigma-private-database-credential-v1'||p.ownerId!==ownerId||!Number.isSafeInteger(p.revision)||p.revision<1||typeof p.username!=='string'||!p.username||Buffer.byteLength(p.username)>63||/[\x00-\x1f\x7f]/.test(p.username)||typeof p.password!=='string'||!p.password||Buffer.byteLength(p.password)>4096||p.password.includes('\0')||canonical(p.resource)!==canonical(RESOURCE)||p.transport.mode!=='admitted-private-network')throw error('SCHEDULER_STATE_CREDENTIAL_REFUSED');return p;}
function credentialBinding(p){const {password,...pub}=p;return sha(canonical(pub));}
function createSchedulerStateRead({enabled=false,driver,getPrivateCredential,admitState,now=Date.now}={}){
 const ready=enabled===true&&typeof driver?.Client==='function'&&driver.version==='8.23.1'&&H.test(driver.packageSha256||'')&&[getPrivateCredential,admitState,now].every(f=>typeof f==='function');
 let active=null,closing=false,blocked=false,closePromise;
 function valid(t){if(active!==t||!t.valid||t.fatal||closing)throw error('SCHEDULER_STATE_SESSION_REFUSED');}
 async function end(s){if(!s)return;if(!s.endPromise){s.endRequested=true;s.endPromise=(async()=>{try{await bounded(Promise.resolve().then(()=>s.raw.end()),5000);if(!s.ended)throw error('SCHEDULER_STATE_CLOSE_UNCONFIRMED');}catch(e){blocked=true;throw own.has(e)?e:error('SCHEDULER_STATE_CLOSE_FAILED');}})();s.endPromise.catch(()=>{});}return s.endPromise;}
 async function admission(t,phase,p,peer){const expected={admitted:true,ownerId:p.ownerId,credentialRevision:p.revision,credentialBindingHash:credentialBinding(p),resourceHash,queryHash,purpose:PURPOSE};let a;try{a=object(await bounded(Promise.resolve().then(()=>admitState({phase,...Object.fromEntries(Object.entries(expected).filter(([k])=>k!=='admitted')),...(peer?{peer:Object.freeze({...peer})}:{})})),5000),Object.keys(expected));}catch{throw error('SCHEDULER_STATE_ADMISSION_REFUSED');}valid(t);if(canonical(a)!==canonical(expected))throw error('SCHEDULER_STATE_ADMISSION_REFUSED');}
 async function query(t,sql,command,state){valid(t);const s=t.session,seq=s.seq;s.awaiting=true;s.expected=state;let r;try{r=await bounded(Promise.resolve().then(()=>s.raw.query(sql)),12000);}catch{t.fatal=true;throw error('SCHEDULER_STATE_QUERY_FAILED');}valid(t);if(s.seq===seq){await bounded(new Promise(resolve=>s.waiters.add(resolve)),2000);valid(t);}s.awaiting=false;if(s.seq!==seq+1||s.tx!==state||!r||isProxy(r)||Array.isArray(r)||r.command!==command||!Array.isArray(r.rows)||(command==='SELECT'?(!Number.isSafeInteger(r.rowCount)||r.rowCount!==r.rows.length):(r.rowCount!==null||r.rows.length!==0))){t.fatal=true;throw error('SCHEDULER_STATE_ACK_UNKNOWN');}return r.rows;}
 async function inspect(raw={},context){
  if(!ready)throw error('SCHEDULER_STATE_OFF');if(closing||blocked)throw error('SCHEDULER_STATE_UNAVAILABLE');if(active)throw error('SCHEDULER_STATE_BUSY',409);object(raw,[]);const c=object(context,['ownerId']);if(typeof c.ownerId!=='string'||!c.ownerId||c.ownerId.length>256||/[\x00-\x1f]/.test(c.ownerId))throw error('SCHEDULER_STATE_OWNER_REFUSED');
  const t={valid:true,fatal:false,session:null};t.done=new Promise(resolve=>t.finish=resolve);active=t;
  const work=(async()=>{
   let p;try{p=credential(await bounded(Promise.resolve().then(()=>getPrivateCredential({ownerId:c.ownerId})),5000),c.ownerId);}catch{throw error('SCHEDULER_STATE_CREDENTIAL_REFUSED');}valid(t);await admission(t,'connect',p);
   const rawClient=new driver.Client({host:RESOURCE.host,port:RESOURCE.port,database:RESOURCE.database,user:p.username,password:p.password,ssl:false,connectionTimeoutMillis:3000,query_timeout:12000,statement_timeout:8000,lock_timeout:2000,idle_in_transaction_session_timeout:10000,application_name:'shrigma-original-scheduler-state-read',client_encoding:'UTF8',options:'-c search_path=pg_catalog -c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=10000',keepAlive:true,pipeline:false});
   const s={raw:rawClient,ended:false,endRequested:false,endPromise:null,tx:null,seq:0,awaiting:true,expected:'I',waiters:new Set()};t.session=s;
   if(typeof rawClient.on!=='function'||typeof rawClient.connection?.on!=='function'||['connect','query','end'].some(k=>typeof rawClient[k]!=='function'))throw error('SCHEDULER_STATE_DRIVER_REFUSED');
   const wake=()=>{for(const w of s.waiters)w();s.waiters.clear();};rawClient.on('error',()=>{t.fatal=true;wake();end(s).catch(()=>{});});rawClient.on('end',()=>{s.ended=true;if(!s.endRequested)t.fatal=true;wake();});rawClient.connection.on('readyForQuery',m=>{if(!s.awaiting||m?.status!==s.expected){t.fatal=true;end(s).catch(()=>{});}else{s.tx=m.status;s.seq++;}wake();});
   await bounded(Promise.resolve().then(()=>rawClient.connect()),5000);valid(t);s.awaiting=false;if(s.seq!==1||s.tx!=='I'||rawClient.connection.stream?.encrypted===true)throw error('SCHEDULER_STATE_PEER_REFUSED');
   await admission(t,'peer',p);const rows=await query(t,PEER,'SELECT','I');if(rows.length!==1)throw error('SCHEDULER_STATE_PEER_REFUSED');const peer=object(rows[0],['database','sessionRole','currentRole','pid','port','engine','ssl','read_only']);
   if(peer.database!==RESOURCE.database||peer.sessionRole!==p.username||peer.currentRole!==p.username||peer.port!==5432||!Number.isInteger(peer.engine)||Math.floor(peer.engine/10000)!==17||!Number.isSafeInteger(peer.pid)||peer.pid<=0||peer.pid!==rawClient.processID||peer.ssl!==false||peer.read_only!=='on')throw error('SCHEDULER_STATE_PEER_REFUSED');
   await admission(t,'begin',p,peer);await query(t,BEGIN,'BEGIN','T');
   await admission(t,'catalog',p,peer);validateCatalog(await query(t,CATALOG_SQL,'SELECT','T'));
   await admission(t,'read',p,peer);const state=await query(t,READ_SQL,'SELECT','T');if(state.length!==1)throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');const payload=validateState(object(state[0],['payload']).payload);
   await admission(t,'rollback',p,peer);await query(t,ROLLBACK,'ROLLBACK','I');
   await admission(t,'end',p,peer);await end(s);valid(t);await admission(t,'release',p,peer);valid(t);
   const clock=now();if(!Number.isSafeInteger(clock)||clock<0||clock>8640000000000000)throw error('SCHEDULER_STATE_CLOCK_REFUSED');return payload;
  })();
  let result,failure;try{result=await bounded(work,60000);}catch(e){failure=own.has(e)?e:error('SCHEDULER_STATE_REFUSED');}
  finally{
   // Cleanup has no data read and requires no surviving authorization. Fatal
   // or unacknowledged sessions are ended; PG rolls their transaction back.
   if(failure&&t.valid&&!t.fatal&&t.session?.tx==='T'&&!closing){try{await query(t,ROLLBACK,'ROLLBACK','I');}catch(e){failure=own.has(e)?e:error('SCHEDULER_STATE_REFUSED');}}
   t.valid=false;try{await end(t.session);}catch(e){failure=own.has(e)?e:error('SCHEDULER_STATE_CLOSE_FAILED');}active=null;t.finish();
  }
  if(failure)throw failure;return result;
 }
 function close(){if(closePromise)return closePromise;closing=true;closePromise=(async()=>{if(active){const t=active;t.valid=false;await end(t.session);await bounded(t.done,15000);}if(blocked)throw error('SCHEDULER_STATE_CLOSE_UNCONFIRMED');return Object.freeze({closed:true,operational:false});})();closePromise.catch(()=>{});return closePromise;}
 return Object.freeze({inspect,close});
}
module.exports=Object.freeze({createSchedulerStateRead,PURPOSE,RESOURCE,PEER,BEGIN,ROLLBACK,CATALOG_SQL,READ_SQL,queryHash,resourceHash,EXPECTED_SELECTION_QUERY,COLUMN_TYPES,validateCatalog,validateState,credentialBinding,canonical});
