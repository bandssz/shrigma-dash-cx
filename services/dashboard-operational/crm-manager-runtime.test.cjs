'use strict';
// Real SQLite journal/client/coordinator/attestor/dispatcher; all origins are
// EventEmitter/Response fixtures. No socket, real identity file or environment.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const {DatabaseSync}=require('node:sqlite');
const {createManagerJournal}=require('./crm-manager-journal.cjs');
const {createManagerRuntime,ManagedCrmRuntimeError}=require('./crm-manager-runtime.cjs');
const {MANAGEMENT_ORIGIN,PATHS,POLICY}=require('./crm-manager-provisioning.cjs');
const IDENTITY='https://comunicacao-crm-panel-read.tazdb8.easypanel.host/read?action=identity&painel=growth';
const RAW='SYNTHETIC_RUNTIME_PRIVATE_ERROR',TOKEN='SYNTHETIC_SERVICE_TOKEN_'.repeat(3);
const counts=(ready=0,pending=0,expired=0,revoked=0)=>({ready,pending,expired,revoked});
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,role TEXT,state TEXT);CREATE TABLE grants(user_id TEXT,area TEXT,can_read INTEGER,can_edit INTEGER);CREATE TABLE upstream_credentials(user_id TEXT,slot TEXT,encrypted_key TEXT,key_digest TEXT,updated_at INTEGER,PRIMARY KEY(user_id,slot));');
 const key=Buffer.alloc(32,11);let clock=1790956800000,clockCalls=0,maximum=0,active=0;
 const encrypt=v=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),b=Buffer.concat([c.update(v),c.final()]);return ['v1',iv.toString('base64url'),c.getAuthTag().toString('base64url'),b.toString('base64url')].join('.');};
 const decrypt=v=>{const[,i,t,b]=v.split('.'),d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(i,'base64url'));d.setAuthTag(Buffer.from(t,'base64url'));return Buffer.concat([d.update(Buffer.from(b,'base64url')),d.final()]).toString();};
 const issuerId=crypto.randomUUID(),namespaceId=crypto.randomUUID();
 const journal=createManagerJournal({db,issuerId,namespaceId,encrypt,decrypt,digest:v=>crypto.createHmac('sha256',key).update(v).digest('hex'),now:()=>clock});
 const events=[],journalCalls=[],ledger=new Map(),digests=new Map(),faults=new Map();
 const tracked=Object.fromEntries(Object.entries(journal).map(([name,fn])=>[name,(...args)=>{journalCalls.push(name);return fn(...args);} ]));
 const auth={managedCrmJournal:tracked};
 const config={auth,issuerId,namespaceId,allowedEmailDomains:['example.test'],provisionerToken:TOKEN};
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const add=()=>{const id=crypto.randomUUID();db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id,'gestor+'+id+'@example.test','manager','invited');db.prepare("INSERT INTO grants VALUES(?,'growth',1,0)").run(id);return id;};
 const start=id=>tx(()=>{journal.createLifecycle(id);db.prepare("UPDATE users SET state='active' WHERE id=?").run(id);return journal.activateLifecycle(id).operationId;});
 const revoke=id=>tx(()=>{const r=journal.stageRevoke(id);db.prepare("UPDATE users SET state='disabled' WHERE id=?").run(id);db.prepare('DELETE FROM upstream_credentials WHERE user_id=?').run(id);return r.operationId;});
 const admin=crypto.randomUUID();db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(admin,'admin@example.test','superadmin','active');
 db.prepare('INSERT INTO upstream_credentials VALUES(?,?,?,?,?)').run(admin,'crm-panel-read','SYNTHETIC_ADMIN_CIPHER','SYNTHETIC_ADMIN_DIGEST',1);
 const baseline=db.prepare('SELECT * FROM upstream_credentials WHERE user_id=?').get(admin);
 const hook=async action=>{const fn=faults.get(action);if(fn){faults.delete(action);await fn();}};
 function receipt(q){
  const base={schema:'crm-manager-provision-receipt-v1',issuerId,namespaceId,operationId:q.operationId,action:q.action,requestSha256:sha(canonical(q)),userId:q.userId,lifecycleId:q.lifecycleId,owner:q.owner};
  if(q.action==='revoke_read')return {...base,state:'revoked',revocationMode:'lifecycle',allGenerationsRevoked:true,effectiveAt:clock,revokedCount:1};
  const issuedAt=q.issuedAt??clock;
  return {...base,state:q.action==='commit_read'?'committed':'prepared',principalId:q.principalId,generation:q.generation,expectedGeneration:q.expectedGeneration,area:'growth',slot:'crm-panel-read',role:'manager',caps:[...POLICY.caps],issuedAt,candidateExpiresAt:issuedAt+POLICY.candidateTtlMs,expiresAt:issuedAt+POLICY.lifetimeMs,...(q.action==='commit_read'?{prepareOperationId:q.prepareOperationId,committedAt:clock,revokedGeneration:q.expectedGeneration===0?null:q.expectedGeneration}:{})};
 }
 const requestImpl=(url,options,callback)=>{
  const req=new EventEmitter();req.destroy=()=>{};req.setTimeout=()=>{};
  req.end=wire=>{
   const q=JSON.parse(wire);events.push({type:q.action,operationId:q.operationId});
   assert.equal(url,MANAGEMENT_ORIGIN+PATHS[q.action]);assert.equal(options.rejectUnauthorized,true);assert.equal(options.agent,false);assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,'CRM-Provisioner '+TOKEN);assert.equal(Object.hasOwn(q,'bearer'),false);
   maximum=Math.max(maximum,++active);
   queueMicrotask(async()=>{
    try{
     let value;
     if(q.action==='status'){
      const found=ledger.get(q.operationId);if(found)assert.equal(found.requestSha256,q.expectedRequestSha256);
      value={schema:'crm-manager-provision-status-v1',issuerId,namespaceId,operationId:q.operationId,found:!!found,...(found?{receipt:found}:{})};
     }else{value=ledger.get(q.operationId)||receipt(q);ledger.set(q.operationId,value);if(['prepare_read','renew_read'].includes(q.action))digests.set(q.operationId,q.keySha256);}
     await hook(q.action);
     const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'application/json; charset=utf-8'};res.destroy=()=>{};callback(res);res.emit('data',Buffer.from(JSON.stringify(value)));res.emit('end');res.emit('close');
    }catch(e){req.emit('error',e);}finally{active--;}
   });
  };return req;
 };
 const fetchImpl=async(url,options)=>{
  events.push({type:'attest'});assert.equal(url,IDENTITY);assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');
  const bearer=options.headers.Authorization.slice(7),entry=[...ledger.values()].find(q=>['prepare_read','renew_read'].includes(q.action)&&digests.get(q.operationId)===sha(bearer));
  assert.ok(entry);assert.match(bearer,/^[a-f0-9]{64}$/);await hook('attest');
  const identity={schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',owner:entry.owner,allowedPanels:['growth'],permissions:{growth:{who:'panel:'+entry.principalId,label:entry.owner,caps:[...POLICY.caps]},influs:null}};
  const bytes=Buffer.from(JSON.stringify(identity));let used=false;
  return {status:200,ok:true,redirected:false,url:IDENTITY,type:'basic',headers:{get:name=>name==='content-type'?'application/json':name==='content-length'?String(bytes.length):null},body:{getReader:()=>({read:async()=>used?{done:true}:(used=true,{done:false,value:bytes}),cancel:()=>{},releaseLock:()=>{}})}};
 };
 const adapters={requestImpl,fetchImpl,now:()=>{clockCalls++;return clock;}};
 const make=(c=config,a=adapters)=>createManagerRuntime(c,a);
 return {db,journal,tracked,auth,config,adapters,events,journalCalls,ledger,faults,add,start,revoke,make,advance:n=>clock+=n,clock:()=>clock,clockCalls:()=>clockCalls,maximum:()=>maximum,unchanged:()=>assert.deepEqual(db.prepare('SELECT * FROM upstream_credentials WHERE user_id=?').get(admin),baseline)};
}

test('construction invokes no adapter/journal and exposes only frozen kick/close',async t=>{
 const f=fixture(t),op=f.start(f.add()),r=f.make();assert.deepEqual(Object.keys(r),['kick','close']);assert.ok(Object.isFrozen(r));assert.equal(JSON.stringify(r),'{}');assert.equal(f.events.length,0);assert.equal(f.journalCalls.length,0);assert.equal(f.clockCalls(),0);assert.equal(f.journal.operationState(op).phase,'queued');await r.close();f.unchanged();
});
test('explicit kick joins the actual journal, client, exact attestor and coordinator',async t=>{
 const f=fixture(t),user=f.add(),op=f.start(user),r=f.make(),result=await r.kick();assert.deepEqual(result,counts(1));assert.ok(Object.isFrozen(result));assert.equal(f.journal.operationState(op).phase,'promoted');assert.equal(f.journal.credentialReady(user),true);assert.deepEqual(f.events.map(e=>e.type),['prepare_read','attest','status','commit_read']);assert.equal(JSON.stringify(result).includes(TOKEN),false);assert.equal(JSON.stringify(result).includes(user),false);assert.equal(f.maximum(),1);await r.close();f.unchanged();
});
test('one snapshot handles at most eight identities with no spontaneous next batch or renewal',async t=>{
 const f=fixture(t),ops=[];for(let i=0;i<10;i++){f.advance(1);ops.push(f.start(f.add()));}const r=f.make();assert.deepEqual(await r.kick(),counts(8));assert.equal(f.journal.pendingOperations(8).length,2);const first=f.events.length;await tick();assert.equal(f.events.length,first);assert.deepEqual(await r.kick(),counts(2));assert.deepEqual(await r.kick(),counts());f.advance(POLICY.lifetimeMs+1);await tick();assert.equal(f.db.prepare('SELECT count(*) n FROM crm_manager_operations_v1').get().n,10);assert.equal(f.events.filter(e=>e.type==='renew_read').length,0);await r.close();f.unchanged();
});
test('concurrent kicks coalesce and later mutation cannot replace captured configuration or callbacks',async t=>{
 const f=fixture(t),op=f.start(f.add()),g=gate();f.faults.set('prepare_read',()=>g.promise);const r=f.make();f.config.allowedEmailDomains[0]='evil.invalid';f.config.provisionerToken=RAW;f.auth.managedCrmJournal={};f.tracked.pendingOperations=()=>{throw Error(RAW);};f.adapters.requestImpl=()=>{throw Error(RAW);};const a=r.kick(),b=r.kick();assert.equal(a,b);await tick();assert.equal(f.events.length,1);g.resolve();assert.deepEqual(await a,counts(1));assert.equal(f.journal.operationState(op).phase,'promoted');assert.equal(f.maximum(),1);await r.close();f.unchanged();
});
test('close before discovery leaves durable intent queued and performs no callback or RPC',async t=>{
 const f=fixture(t),op=f.start(f.add()),r=f.make(),work=r.kick(),closed=r.close();assert.equal(closed,r.close());assert.deepEqual(await work,counts());assert.equal(await closed,undefined);assert.deepEqual(await r.kick(),counts());assert.equal(f.events.length,0);assert.equal(f.journalCalls.length,0);assert.equal(f.journal.operationState(op).phase,'queued');f.unchanged();
});
test('close waits for the active origin and prevents subsequent IDs without deleting intents',async t=>{
 const f=fixture(t),first=f.start(f.add());f.advance(1);const second=f.start(f.add()),g=gate();f.faults.set('prepare_read',()=>g.promise);const r=f.make(),work=r.kick();await tick();let settled=false;const closing=r.close().then(()=>{settled=true;});assert.deepEqual(await r.kick(),counts());await tick();assert.equal(settled,false);assert.equal(f.events.length,1);g.resolve();assert.deepEqual(await work,counts(1,1));await closing;assert.equal(settled,true);assert.equal(f.journal.operationState(first).phase,'promoted');assert.equal(f.journal.operationState(second).phase,'queued');assert.equal(f.events.filter(e=>e.type==='prepare_read').length,1);const n=f.journalCalls.length;assert.deepEqual(await r.kick(),counts());assert.equal(f.journalCalls.length,n);f.unchanged();
});
test('lost prepare acknowledgement recovers its expired historical receipt only on another explicit kick',async t=>{
 const f=fixture(t),user=f.add(),op=f.start(user);f.faults.set('prepare_read',()=>{throw Error(RAW);});const r=f.make();assert.deepEqual(await r.kick(),counts(0,1));assert.equal(f.journal.operationState(op).phase,'prepare_uncertain');await r.close();f.advance(POLICY.candidateTtlMs+1);const restarted=f.make();assert.deepEqual(await restarted.kick(),counts(0,0,1));assert.equal(f.journal.operationState(op).phase,'expired');assert.equal(f.events.filter(e=>['attest','commit_read'].includes(e.type)).length,0);assert.notEqual(f.journal.retryIssue(user).operationId,op);await restarted.close();f.unchanged();
});
test('explicit revoke batch compensates managed lifecycle without touching administrator',async t=>{
 const f=fixture(t),user=f.add();f.start(user);const r=f.make();assert.deepEqual(await r.kick(),counts(1));const rev=f.revoke(user);assert.deepEqual(await r.kick(),counts(0,0,0,1));assert.equal(f.journal.operationState(rev).phase,'revoked');assert.equal(f.db.prepare('SELECT count(*) n FROM upstream_credentials WHERE user_id=?').get(user).n,0);await r.close();f.unchanged();
});
test('factory refuses foreign fields, missing journal, invalid configuration and accessors without evaluation',async t=>{
 const f=fixture(t);let getters=0;const c={...f.config};Object.defineProperty(c,'provisionerToken',{enumerable:true,get(){getters++;throw Error(RAW);}});const auth={};Object.defineProperty(auth,'managedCrmJournal',{get(){getters++;throw Error(RAW);}});const journal={...f.tracked};Object.defineProperty(journal,'request',{get(){getters++;throw Error(RAW);}});const list=['example.test'];Object.defineProperty(list,'0',{enumerable:true,get(){getters++;throw Error(RAW);}});
 for(const config of [null,{},[],c,{...f.config,sql:RAW},{...f.config,issuerId:RAW},{...f.config,provisionerToken:'short'},{...f.config,allowedEmailDomains:list},{...f.config,auth:{}},{...f.config,auth},{...f.config,auth:{managedCrmJournal:journal}}])assert.throws(()=>f.make(config),e=>e instanceof ManagedCrmRuntimeError&&e.code==='MANAGED_CRM_RUNTIME_REFUSED'&&!e.message.includes(RAW));
 const a={};Object.defineProperty(a,'now',{enumerable:true,get(){getters++;throw Error(RAW);}});for(const adapters of [null,[],{client:RAW},{fetchImpl:null},a])assert.throws(()=>f.make(f.config,adapters),e=>e.code==='MANAGED_CRM_RUNTIME_REFUSED');assert.equal(getters,0);assert.equal(f.events.length,0);assert.equal(f.clockCalls(),0);f.unchanged();
});
test('identity transaction or private discovery error returns only aggregate pending',async t=>{
 const f=fixture(t),op=f.start(f.add()),r=f.make();f.db.exec('BEGIN IMMEDIATE');try{assert.deepEqual(await r.kick(),counts(0,1));assert.equal(f.events.length,0);assert.equal(f.db.isTransaction,true);}finally{f.db.exec('ROLLBACK');}await r.close();const broken=f.make({...f.config,auth:{managedCrmJournal:{...f.tracked,pendingOperations:()=>{throw Error(RAW);}}}});const result=await broken.kick();assert.deepEqual(result,counts(0,1));assert.equal(JSON.stringify(result).includes(RAW),false);assert.equal(f.journal.operationState(op).phase,'queued');await broken.close();f.unchanged();
});
test('import and construction do not read env, start timers or access an origin',()=>{
 const {spawnSync}=require('node:child_process'),modulePath=require.resolve('./crm-manager-runtime.cjs');
 const script=`'use strict';const assert=require('node:assert/strict'),https=require('node:https');require(${JSON.stringify(require.resolve('./crm-manager-provisioning.cjs'))});require(${JSON.stringify(require.resolve('./crm-manager-coordinator.cjs'))});require(${JSON.stringify(require.resolve('./crm-manager-attestation.cjs'))});require(${JSON.stringify(require.resolve('./crm-manager-dispatcher.cjs'))});const original=process.env;let calls=0;process.env=new Proxy({},{get(){calls++;throw Error('ENV_FORBIDDEN');}});https.request=globalThis.fetch=globalThis.setTimeout=globalThis.setInterval=()=>{calls++;throw Error('ORIGIN_FORBIDDEN');};const {createManagerRuntime}=require(${JSON.stringify(modulePath)}),journal=Object.fromEntries(['request','beginPrepare','recordPrepared','candidateForAttestation','recordAttestation','commitDescriptor','beginCommit','recordCommitted','promote','expireCandidate','confirmRevoked','operationState','pendingOperations'].map(k=>[k,()=>{calls++;throw Error('CALLBACK_FORBIDDEN');}]));const r=createManagerRuntime({auth:{managedCrmJournal:journal},issuerId:'123e4567-e89b-42d3-a456-000000000001',namespaceId:'123e4567-e89b-42d3-a456-000000000002',allowedEmailDomains:['example.test'],provisionerToken:'a'.repeat(64)});assert.deepEqual(Object.keys(r),['kick','close']);assert.equal(calls,0);process.env=original;process.stdout.write('dormant');`;
 const r=spawnSync(process.execPath,['-e',script],{env:{},encoding:'utf8',maxBuffer:4096});assert.equal(r.status,0);assert.equal(r.stdout,'dormant');assert.equal(r.stderr,'');
});
test('rejected asynchronous sync adapters are observed without private stderr or unhandled rejection',()=>{
 const {spawnSync}=require('node:child_process'),modulePath=require.resolve('./crm-manager-runtime.cjs');
 const script=`'use strict';const assert=require('node:assert/strict'),{createManagerRuntime}=require(${JSON.stringify(modulePath)}),CANARY='ASYNC_RUNTIME_PRIVATE_CANARY',id='123e4567-e89b-42d3-a456-000000000001',r={operationId:id,userId:'123e4567-e89b-42d3-a456-000000000003',lifecycleId:'123e4567-e89b-42d3-a456-000000000004',owner:'manager@example.test',principalId:'dcrm-'+'b'.repeat(32),keySha256:'c'.repeat(64),generation:1,expectedGeneration:0};(async()=>{for(const target of ['now','requestImpl','pendingOperations']){let phase='queued';const journal={request:()=>r,beginPrepare:()=>{phase='prepare_uncertain';},recordPrepared:()=>{},candidateForAttestation:()=>{},recordAttestation:()=>{},commitDescriptor:()=>{},beginCommit:()=>{},recordCommitted:()=>{},promote:()=>{},expireCandidate:()=>{},confirmRevoked:()=>{},operationState:()=>({kind:'issue',phase,candidateExpiresAt:null,lifecycleState:'provisioning',current:true}),pendingOperations:()=>[id]},adapters={now:()=>1790956800000,requestImpl:()=>{throw Error(CANARY);}};const rejected=()=>Promise.reject(Error(CANARY));if(target==='pendingOperations')journal[target]=rejected;else adapters[target]=rejected;const rt=createManagerRuntime({auth:{managedCrmJournal:journal},issuerId:'123e4567-e89b-42d3-a456-000000000002',namespaceId:'123e4567-e89b-42d3-a456-000000000005',allowedEmailDomains:['example.test'],provisionerToken:'a'.repeat(64)},adapters);assert.deepEqual(await rt.kick(),{ready:0,pending:1,expired:0,revoked:0});await rt.close();}await new Promise(resolve=>setImmediate(resolve));process.stdout.write('observed');})().catch(()=>{process.exitCode=2;});`;
 const r=spawnSync(process.execPath,['-e',script],{env:{},encoding:'utf8',maxBuffer:4096});assert.equal(r.status,0);assert.equal(r.stdout,'observed');assert.equal(r.stderr.includes('ASYNC_RUNTIME_PRIVATE_CANARY'),false);
});
