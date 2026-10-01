'use strict';
const {createHash,randomUUID}=require('node:crypto'),{performance}=require('node:perf_hooks'),fs=require('node:fs'),path=require('node:path');
const VERSION='journey_graph_worker_lease_v1';
const WORKER_FILES=Object.freeze([
 'n8n/growth/journey-graph-worker.cjs','n8n/growth/journey-graph-runtime.cjs','n8n/growth/journey-graph-cart.cjs',
 'n8n/growth/journey-graph-message.cjs','n8n/growth/journey-graph-delivery.cjs','n8n/growth/journey-graph-shopify.cjs',
 'n8n/growth/journey-graph-source.cjs','n8n/growth/journey-graph-native.cjs','n8n/growth/journey-graph-worker-http.cjs',
 'n8n/growth/journey-graph-contract.js','n8n/growth/journey-graph-release.cjs','n8n/growth/journey-graph-refresh.cjs',
 'n8n/growth/journey-graph-purchase.cjs','n8n/growth/journey-graph-worker-lease.cjs',
 'services/crm-flows/main.cjs','services/crm-flows/config.cjs','services/crm-flows/oauth.cjs','services/crm-flows/server.cjs',
 'services/crm-flows/package.json','services/crm-flows/package-lock.json','growth-email-contract.js','growth-email-expressions.js'
]);
const fail=code=>Object.assign(Error(code),{code});
const digest=value=>createHash('sha256').update(value).digest('hex');
function stable(value){
 if(value===null||typeof value==='string'||typeof value==='boolean'||Number.isSafeInteger(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
 if(value&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
 throw fail('GRAPH_WORKER_LEASE_IDENTITY');
}
function workerSha256({readFile=fs.readFileSync,root=path.resolve(__dirname,'../..'),files=WORKER_FILES}={}){
 if(typeof readFile!=='function'||typeof root!=='string'||!Array.isArray(files)||!files.length||files.some(f=>typeof f!=='string'||!/^[A-Za-z0-9][A-Za-z0-9./-]*$/.test(f)||f.split('/').some(p=>p==='.'||p==='..')))throw fail('GRAPH_WORKER_LEASE_CONFIG');
 const h=createHash('sha256');for(const file of [...files].sort()){const bytes=readFile(path.join(root,file));if(!Buffer.isBuffer(bytes)&&!(bytes instanceof Uint8Array))throw fail('GRAPH_WORKER_LEASE_IDENTITY');h.update(file+'\0');h.update(bytes);h.update('\0');}return h.digest('hex');
}
const runtimeSha256=value=>digest(stable(value));
function validateReply(v){
 if(!v||typeof v!=='object'||Array.isArray(v)||typeof v.ready!=='boolean'||v.authorizes_activate!==false||!['deployment_unavailable','identity_unavailable','lease_suspended','competing_instance','executor_ready'].includes(v.reason))throw fail('GRAPH_WORKER_LEASE_UNCONFIRMED');
 const keys=Object.keys(v).sort().join(',');if(v.ready){const a=Date.parse(v.checked_at),b=Date.parse(v.expires_at);if(keys!=='authorizes_activate,cache_identity_live_verified,checked_at,expires_at,ready,reason'||v.reason!=='executor_ready'||v.cache_identity_live_verified!==false||!Number.isFinite(a)||!Number.isFinite(b)||b<=a||b-a>60000)throw fail('GRAPH_WORKER_LEASE_UNCONFIRMED');}
 else if(keys!=='authorizes_activate,ready,reason'||v.reason==='executor_ready')throw fail('GRAPH_WORKER_LEASE_UNCONFIRMED');
 return v;
}
function createGraphWorkerLease({pool,enabled=false,runtimeIdentity,intervalMs=20000,clock=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout,instanceId=randomUUID(),workerSha=workerSha256()}={}){
 if(typeof pool?.connect!=='function'||typeof enabled!=='boolean'||typeof runtimeIdentity!=='function'||!Number.isInteger(intervalMs)||intervalMs<1000||intervalMs>30000||typeof clock!=='function'||typeof setTimer!=='function'||typeof clearTimer!=='function'||!/^[a-f0-9-]{36}$/.test(instanceId)||!/^[a-f0-9]{64}$/.test(workerSha))throw fail('GRAPH_WORKER_LEASE_CONFIG');
 let timer=null,active=null,stopped=true,local={ready:false,reason:enabled?'not_started':'disabled',expiresAtMonotonic:0};
 const clear=reason=>{local={ready:false,reason,expiresAtMonotonic:0};};
 async function beat(){
  if(!enabled||stopped)return {ready:false,reason:enabled?'stopped':'disabled',authorizes_activate:false};
  if(active)return active;
  active=(async()=>{let client,began=false,commitSent=false,commitConfirmed=false,discard=false;clear('refreshing');try{
   const started=clock();if(!Number.isFinite(started))throw fail('GRAPH_WORKER_LEASE_CLOCK');const runtimeSha=runtimeSha256(runtimeIdentity());client=await pool.connect();
   await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');began=true;
   await client.query("SET LOCAL statement_timeout='10s'");await client.query("SET LOCAL lock_timeout='500ms'");
   const r=await client.query('SELECT crm_graph_candidate.graph_worker_heartbeat_v1($1,$2,$3) result',[instanceId,workerSha,runtimeSha]);
   if(r.rows?.length!==1)throw fail('GRAPH_WORKER_LEASE_UNCONFIRMED');const value=validateReply(r.rows[0].result);
   commitSent=true;const committed=await client.query('COMMIT');began=false;if(committed?.command!=='COMMIT')throw fail('GRAPH_WORKER_LEASE_OUTCOME_UNKNOWN');commitConfirmed=true;
   if(runtimeSha256(runtimeIdentity())!==runtimeSha){clear('identity_changed');throw fail('GRAPH_WORKER_LEASE_IDENTITY_CHANGED');}
   if(!value.ready){clear(value.reason);return value;}
   const window=Date.parse(value.expires_at)-Date.parse(value.checked_at),now=clock(),deadline=started+window;if(!Number.isFinite(now)||window<=0||now>=deadline){clear('expired');throw fail('GRAPH_WORKER_LEASE_EXPIRED');}
   local={ready:true,reason:'executor_ready',expiresAtMonotonic:deadline};return value;
  }catch(e){if(commitConfirmed&&['GRAPH_WORKER_LEASE_IDENTITY_CHANGED','GRAPH_WORKER_LEASE_EXPIRED'].includes(e?.code))throw e;if(began&&!commitSent)try{const rolled=await client.query('ROLLBACK');if(rolled?.command!=='ROLLBACK')discard=true;}catch{discard=true;}clear(commitSent?'outcome_unknown':'unavailable');throw fail(commitSent?'GRAPH_WORKER_LEASE_OUTCOME_UNKNOWN':'GRAPH_WORKER_LEASE_UNAVAILABLE');
  }finally{try{client?.release(local.reason==='outcome_unknown'||discard?Error('uncertain'):undefined);}catch{}active=null;}})();
  return active;
 }
 function schedule(){if(stopped)return;timer=setTimer(async()=>{timer=null;try{await beat();}catch{}schedule();},intervalMs);timer?.unref?.();}
 async function start(){if(!enabled)return {ready:false,reason:'disabled',authorizes_activate:false};if(!stopped)return active||Promise.resolve(status());stopped=false;try{return await beat();}finally{schedule();}}
 async function stop(){if(stopped)return;stopped=true;if(timer!==null){clearTimer(timer);timer=null;}if(active)try{await active;}catch{}clear('stopped');}
 function status(){const ready=local.ready&&clock()<local.expiresAtMonotonic;if(!ready&&local.ready)clear('expired');return Object.freeze({contract:VERSION,enabled,executor_ready:ready,reason:local.reason,cache_identity_live_verified:false,authorizes_activate:false});}
 return Object.freeze({start,stop,heartbeat:beat,status,instanceId});
}
module.exports={VERSION,WORKER_FILES,stable,workerSha256,runtimeSha256,createGraphWorkerLease};
