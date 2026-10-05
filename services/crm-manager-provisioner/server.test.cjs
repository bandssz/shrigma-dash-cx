'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createServer,config,GatewayError,HOST,ROLE,QUERIES,canonical,sha,PG_HOST,ADMISSION_KEYS,admissionSql}=require('./server.cjs');
const {createProvisioningClient}=require('../dashboard-operational/crm-manager-provisioning.cjs');
const NOW=1790980000000,id=n=>'123e4567-e89b-42d3-a456-'+String(n).padStart(12,'0'),TOKEN='SYNTHETIC_SERVICE_TOKEN_'.repeat(3),RAW='PRIVATE_RAW_SENTINEL_NOT_FOR_RESPONSE';
const options={issuerId:id(90),namespaceId:id(91),allowedEmailDomains:['synthetic.invalid'],provisionerToken:TOKEN,revision:'a'.repeat(40),enabled:true,now:()=>NOW};
const args=(n=1)=>({operationId:id(n),userId:id(10),lifecycleId:id(20),owner:'gestor@synthetic.invalid',principalId:'dcrm-'+'a'.repeat(32),keySha256:sha('SYNTHETIC_MANAGER_KEY_ONLY_HASH')});
const policy={area:'growth',slot:'crm-panel-read',role:'manager',caps:['read_content','list_history','submission'],candidateTtlMs:600000,lifetimeMs:1209600000};
function command(n=1){return {schema:'crm-manager-provision-request-v1',issuerId:options.issuerId,namespaceId:options.namespaceId,action:'prepare_read',...args(n),generation:1,expectedGeneration:0,...policy};}
function receipt(c){
 const base={schema:'crm-manager-provision-receipt-v1',issuerId:c.issuerId,namespaceId:c.namespaceId,operationId:c.operationId,action:c.action,requestSha256:sha(canonical(c)),userId:c.userId,lifecycleId:c.lifecycleId,owner:c.owner};
 if(c.action==='revoke_read')return {...base,state:'revoked',revocationMode:'lifecycle',allGenerationsRevoked:true,effectiveAt:NOW,revokedCount:2};
 const issuedAt=c.issuedAt??NOW;return {...base,state:c.action==='commit_read'?'committed':'prepared',principalId:c.principalId,generation:c.generation,expectedGeneration:c.expectedGeneration,area:'growth',slot:'crm-panel-read',role:'manager',caps:[...policy.caps],issuedAt,candidateExpiresAt:issuedAt+600000,expiresAt:issuedAt+1209600000,...(c.action==='commit_read'?{prepareOperationId:c.prepareOperationId,committedAt:issuedAt+100,revokedGeneration:c.expectedGeneration===0?null:c.expectedGeneration}:{})};
}
function admittedPool(query){return {query,connect:async()=>Object.assign(new EventEmitter(),{connectionParameters:{host:PG_HOST,port:5432,database:'listmonk',user:ROLE,password:RAW,ssl:false},connection:{stream:{destroy(){}}},release(){},query:(sql,params)=>sql===admissionSql(false)?Promise.resolve({rows:[Object.fromEntries(ADMISSION_KEYS.map(k=>[k,true]))]}):query(sql,params)})};}
function setup(handler=c=>receipt(c),extra={}){
 const calls=[],pool=admittedPool(async(sql,parameters)=>{calls.push({sql,parameters});return {rows:[{body:await handler(JSON.parse(parameters[0]),calls.length)}]};});
 const app=createServer({...options,pool,...extra});return {app,calls,pool};
}
function send(app,body=command(),changes={}){
 const req=new EventEmitter(),res=new EventEmitter(),wire=changes.wire??canonical(body);
 req.socket=changes.socket;req.headers={host:HOST,authorization:'CRM-Provisioner '+TOKEN,'content-type':'application/json; charset=utf-8',...changes.headers};req.rawHeaders=changes.rawHeaders??Object.entries(req.headers).flat();req.method=changes.method??'POST';req.url=changes.path??'/internal/v1/crm-managers/prepare';req.complete=false;req.resume=()=>{};req.destroy=()=>{req.destroyed=true;req.emit('close');};
 res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;};res.end=bytes=>{res.bytes=Buffer.from(bytes);res.body=JSON.parse(res.bytes);res.writableEnded=true;};res.destroy=()=>{res.destroyed=true;res.emit('close');};
 const done=app.handle(req,res);queueMicrotask(()=>{if(changes.holdBody)return;for(const chunk of changes.chunks??[Buffer.from(wire)])req.emit('data',chunk);req.complete=true;req.emit('end');});
 return {req,res,done};
}
function clientBridge(app,{dropFirstReply=false}={}){
 return (url,opts,callback)=>{const request=new EventEmitter();request.setTimeout=()=>{};request.destroy=()=>{};request.end=wire=>{const response=new EventEmitter();response.destroy=()=>{};
  const req=new EventEmitter(),res=new EventEmitter();req.headers={host:HOST,...Object.fromEntries(Object.entries(opts.headers).map(([k,v])=>[k.toLowerCase(),String(v)]))};req.rawHeaders=Object.entries(req.headers).flat();req.method='POST';req.url=new URL(url).pathname;req.complete=false;res.writeHead=(status,headers)=>{response.statusCode=status;response.headers=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),String(v)]));};res.end=bytes=>{res.writableEnded=true;if(dropFirstReply){dropFirstReply=false;request.emit('error',Error('SYNTHETIC_LOST_ACK'));return;}callback(response);response.emit('data',Buffer.from(bytes));response.emit('end');};res.destroy=()=>{};
  // Feed the factory handler in process. No listen, fetch or https request.
  app.handle(req,res).catch(e=>request.emit('error',e));queueMicrotask(()=>{req.emit('data',Buffer.from(wire));req.complete=true;req.emit('end');});
 };return request;};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('fixed read RPC authenticates scope and calls exactly one bound query',async()=>{
 const {app,calls}=setup(),r=send(app);await r.done;assert.equal(r.res.status,200);assert.equal(calls.length,1);assert.equal(calls[0].sql,QUERIES.prepare_read);assert.deepEqual(calls[0].parameters,[canonical(command())]);assert.equal(r.res.body.requestSha256,sha(canonical(command())));assert.equal(r.res.headers['Access-Control-Allow-Origin'],undefined);assert.ok(r.res.bytes.length<8192);
});

test('all four exact routes, policy and error status agree with BFF client without sockets',async()=>{
 const saved=new Map(),{app,calls}=setup(c=>{
  if(c.action==='status')return {schema:'crm-manager-provision-status-v1',issuerId:c.issuerId,namespaceId:c.namespaceId,operationId:c.operationId,found:saved.has(c.operationId),...(saved.has(c.operationId)?{receipt:saved.get(c.operationId)}:{})};
  const value=receipt(c);saved.set(c.operationId,value);return value;
 });
 const client=createProvisioningClient({issuerId:options.issuerId,namespaceId:options.namespaceId,allowedEmailDomains:['synthetic.invalid'],provisionerToken:TOKEN,requestImpl:clientBridge(app),now:()=>NOW});
 const prepared=await client.prepareRead(args());assert.equal(prepared.state,'prepared');const committed=await client.commitRead({operationId:id(2),prepared});assert.equal(committed.state,'committed');const status=await client.operationStatus({...client.describeRead(args()),requireFound:true});assert.equal(status.receipt.principalId,prepared.principalId);
 const renewal=await client.prepareRenewalRead({...args(3),generation:2,expectedGeneration:1,principalId:'dcrm-'+'b'.repeat(32)});assert.equal(renewal.expectedGeneration,1);
 const revoked=await client.revokeRead({operationId:id(4),userId:id(10),lifecycleId:id(20),owner:'gestor@synthetic.invalid'});assert.equal(revoked.allGenerationsRevoked,true);assert.equal(calls.length,5);assert.ok(calls.some(c=>c.sql===QUERIES.status));assert.ok(calls.some(c=>c.sql===QUERIES.revoke_read));
});

test('missing/wrong/Bearer/duplicate auth, Origin and foreign Host never reach SQL',async()=>{
 for(const change of [{headers:{authorization:undefined}},{headers:{authorization:'CRM-Provisioner '+'X'.repeat(43)}},{headers:{authorization:'Bearer '+TOKEN}},{headers:{origin:'https://browser.invalid'}},{headers:{origin:'null'}},{headers:{host:'evil.invalid'}},{rawHeaders:['Authorization','CRM-Provisioner '+TOKEN,'Authorization','CRM-Provisioner '+TOKEN]}]){const {app,calls}=setup(),r=send(app,command(),change);await r.done;assert.ok([401,403].includes(r.res.status));assert.equal(calls.length,0);assert.equal(JSON.stringify(r.res.body).includes(TOKEN),false);}
});

test('method route query aliases preflight and wrong Content-Type are closed',async()=>{
 for(const change of [{method:'GET'},{method:'OPTIONS'},{path:'/internal/v1/crm-managers/prepare?x=1'},{path:'/internal/v1/crm-managers/prepare/'},{path:'https://evil.invalid/internal/v1/crm-managers/prepare'},{path:'/internal/v1/crm-managers/arbitrary-sql'},{headers:{'content-type':'text/plain'}},{headers:{'content-encoding':'gzip'}},{headers:{'content-length':'4097'}},{headers:{'content-length':'-1'}},{headers:{'content-length':'1','transfer-encoding':'chunked'}}]){const {app,calls}=setup(),r=send(app,command(),change);await r.done;assert.ok(r.res.status>=400);assert.equal(calls.length,0);}
});

test('unknown fields, digest/UUID/owner/TTL/generation or edition requests never reach SQL',async()=>{
 const bad=[{bearer:RAW},{password:RAW},{sql:'DROP TABLE x'},{caps:['draft']},{role:'master'},{area:'influs'},{action:'prepare_edit'},{issuerId:id(89)},{namespaceId:id(89)},{operationId:'not-uuid'},{keySha256:'A'.repeat(64)},{owner:'Gestor@synthetic.invalid'},{owner:'gestor@synthetic.invalid.evil'},{candidateTtlMs:600001},{lifetimeMs:1209600001},{expectedGeneration:1},{generation:2},{principalId:'master'}];
 for(const change of bad){const {app,calls}=setup(),r=send(app,{...command(),...change});await r.done;assert.ok(r.res.status>=400);assert.equal(calls.length,0);assert.equal(JSON.stringify(r.res.body).includes(RAW),false);}
});

test('canonical duplicate-key JSON, malformed JSON, strict UTF8 and incremental 4 KiB boundary refuse',async()=>{
 for(const change of [{wire:'{"schema":"x","schema":"x"}'},{wire:' '+canonical(command())},{wire:'notjson '+RAW},{chunks:[Buffer.from(canonical(command())),Buffer.from([0xc3])]},{chunks:[Buffer.alloc(4096,32),Buffer.from('x')]},{headers:{'content-length':'1'}}]){const {app,calls}=setup(),r=send(app,command(),change);await r.done;assert.ok(r.res.status>=400);assert.equal(calls.length,0);assert.equal(JSON.stringify(r.res.body).includes(RAW),false);}
});

test('body timeout and stream error are bounded before SQL; late errors are consumed',async()=>{
 const {app,calls}=setup(undefined,{bodyTimeoutMs:15,deadlineMs:30}),r=send(app,command(),{holdBody:true});await r.done;assert.equal(r.res.status,400);assert.equal(calls.length,0);assert.doesNotThrow(()=>r.req.emit('error',Error(RAW)));
 const other=send(app,command(),{holdBody:true});other.req.emit('error',Error(RAW));await other.done;assert.equal(other.res.status,400);assert.equal(calls.length,0);
});

test('SQL failures and invalid nested receipts cannot release raw secrets or data',async()=>{
 const changes=[r=>r.bearer=RAW,r=>r.owner='other@synthetic.invalid',r=>r.namespaceId=id(89),r=>r.requestSha256='b'.repeat(64),r=>r.caps=[policy.caps.join(',')],r=>r.role='master',r=>r.candidateExpiresAt++,r=>r.expiresAt++,r=>r.generation=2];
 for(const mutate of changes){const {app}=setup(c=>{const value=receipt(c);mutate(value);return value;}),r=send(app);await r.done;assert.equal(r.res.status,503);assert.equal(r.res.body.code,'UNAVAILABLE');assert.equal(JSON.stringify(r.res.body).includes(RAW),false);assert.equal(r.res.body.requestSha256,sha(canonical(command())));}
 const failed=setup(()=>{throw Error('SQL ERROR '+RAW);}),r=send(failed.app);await r.done;assert.equal(r.res.status,503);assert.equal(JSON.stringify(r.res.body).includes(RAW),false);
});

test('SQL typed conflicts project code with closed fingerprint and never raw error fields',async()=>{
 const {app}=setup(c=>({schema:'crm-manager-provision-error-v1',issuerId:c.issuerId,namespaceId:c.namespaceId,operationId:c.operationId,requestSha256:sha(canonical(c)),code:'GENERATION_CONFLICT'})),r=send(app);await r.done;assert.equal(r.res.status,409);assert.equal(r.res.body.code,'GENERATION_CONFLICT');
 const raw=setup(c=>({schema:'crm-manager-provision-error-v1',issuerId:c.issuerId,namespaceId:c.namespaceId,operationId:c.operationId,requestSha256:sha(canonical(c)),code:'GENERATION_CONFLICT',error:{connection:RAW}})),bad=send(raw.app);await bad.done;assert.equal(bad.res.status,503);assert.equal(JSON.stringify(bad.res.body).includes(RAW),false);
});

test('status nested receipt scope, hash and capability are revalidated before replying',async()=>{
 const status={schema:command().schema,issuerId:options.issuerId,namespaceId:options.namespaceId,operationId:id(1),action:'status',expectedRequestSha256:sha(canonical(command()))};
 for(const mutate of [r=>r.namespaceId=id(89),r=>r.receipt.caps=['draft'],r=>r.receipt.requestSha256='b'.repeat(64),r=>r.receipt.secret=RAW,r=>r.receipt.owner='hidden@external.invalid']){const {app}=setup(()=>{const r={schema:'crm-manager-provision-status-v1',issuerId:options.issuerId,namespaceId:options.namespaceId,operationId:id(1),found:true,receipt:receipt(command())};mutate(r);return r;}),sent=send(app,status,{path:'/internal/v1/crm-managers/status'});await sent.done;assert.equal(sent.res.status,503);assert.equal(JSON.stringify(sent.res.body).includes(RAW),false);}
});

test('one SQL query in flight, two small queued requests and overload has no extra query',async()=>{
 let release;const blocked=new Promise(resolve=>release=resolve),{app,calls}=setup(async(c,n)=>{if(n===1)await blocked;return receipt(c);});
 const a=send(app,command(1)),b=send(app,command(2)),c=send(app,command(3));await tick();assert.deepEqual(app.pending(),{active:1,queued:2,handling:3});assert.equal(calls.length,1);
 const excess=send(app,command(4));await excess.done;assert.equal(excess.res.status,503);assert.equal(calls.length,1);release();await Promise.all([a.done,b.done,c.done]);await tick();assert.equal(calls.length,3);assert.deepEqual(app.pending(),{active:0,queued:0,handling:0});
});

test('HTTP timeout retains SQL admission and expired queue entries never execute',async()=>{
 let release;const blocked=new Promise(resolve=>release=resolve),{app,calls}=setup(async(c,n)=>{if(n===1)await blocked;return receipt(c);},{deadlineMs:30,bodyTimeoutMs:15});
 const a=send(app,command(1)),b=send(app,command(2));await Promise.all([a.done,b.done]);assert.equal(a.res.status,503);assert.equal(b.res.status,503);assert.equal(calls.length,1);assert.equal(app.pending().active,1);assert.equal(app.pending().queued,0);
 const c=send(app,command(3));await c.done;assert.equal(calls.length,1);assert.equal(app.pending().queued,0);release();await tick();assert.equal(calls.length,1);assert.equal(app.pending().active,0);
});

test('disconnected queued request never queries, active disconnect keeps SQL slot occupied',async()=>{
 let release;const blocked=new Promise(resolve=>release=resolve),{app,calls}=setup(async(c,n)=>{if(n===1)await blocked;return receipt(c);});
 const a=send(app,command(1)),b=send(app,command(2));await tick();b.res.destroy();await b.done;a.res.destroy();await a.done;assert.equal(calls.length,1);assert.equal(app.pending().active,1);assert.equal(app.pending().queued,0);release();await tick();assert.equal(calls.length,1);assert.equal(app.pending().active,0);
});

test('stop drains every queued job without SQL and keeps active query bounded by its pool',async()=>{
 let release;const blocked=new Promise(resolve=>release=resolve),{app,calls}=setup(async(c,n)=>{if(n===1)await blocked;return receipt(c);});const a=send(app,command(1)),b=send(app,command(2)),c=send(app,command(3));await tick();await app.stop();await Promise.all([a.done,b.done,c.done]);assert.equal(calls.length,1);assert.equal(app.pending().queued,0);release();await tick();assert.equal(app.pending().active,0);
});

test('remote/static health cannot pretend database readiness or expose private configuration',async()=>{
 const {app,calls}=setup(),r=send(app,{}, {method:'GET',path:'/healthz',headers:{authorization:undefined,host:'127.0.0.1:8080'}});await r.done;assert.equal(r.res.status,503);assert.equal(r.res.body.ready,false);assert.equal(r.res.body.policy.namespaceBound,false);const wire=JSON.stringify(r.res.body);for(const value of [TOKEN,options.issuerId,options.namespaceId,RAW])assert.equal(wire.includes(value),false);assert.equal(calls.length,0);
});

test('disabled defaults and invalid explicit dependencies are fail closed',async()=>{
 const {app,calls}=setup(undefined,{enabled:false}),r=send(app);await r.done;assert.equal(r.res.status,503);assert.equal(calls.length,0);
 const base={...options,pool:admittedPool(async()=>({rows:[]}))};for(const bad of [null,undefined,{...base,enabled:null},{...base,now:null},{...base,maxQueued:3},{...base,deadlineMs:5000},{...base,bodyTimeoutMs:2000},{...base,pool:{}},{...base,endpoint:'https://evil.invalid'}])assert.throws(()=>createServer(bad),e=>e instanceof GatewayError);
});

test('runtime config only accepts dedicated PG role and server-side synthetic settings',()=>{
 const env={PGHOST:PG_HOST,CRM_MANAGER_PG_TLS:'false',PGUSER:ROLE,PGDATABASE:'listmonk',PGPASSWORD:'SYNTHETIC_ONLY',CRM_MANAGER_ISSUER_ID:options.issuerId,CRM_MANAGER_NAMESPACE_ID:options.namespaceId,CRM_MANAGER_REVISION:options.revision,CRM_MANAGER_ALLOWED_EMAIL_DOMAINS:'["synthetic.invalid"]',CRM_MANAGER_PROVISIONER_TOKEN:TOKEN};const c=config(env);assert.equal(c.enabled,false);assert.equal(c.pg.max,1);assert.equal(c.pg.statement_timeout,3000);assert.equal(c.pg.query_timeout,3500);
 for(const changed of [{PGUSER:'postgres'},{PGUSER:'crm_panel_reader'},{PGDATABASE:'other'},{CRM_MANAGER_ENABLED:'yes'},{CRM_MANAGER_ALLOWED_EMAIL_DOMAINS:'["evil.invalid/"]'}])assert.throws(()=>config({...env,...changed}),e=>e instanceof GatewayError);
});

test('pinned client through gateway runs exact four RPCs in disposable PostgreSQL without sockets',async t=>{
 const {createFixture,createPrepare,createRenewal,createRevoke,issuerA}=require('../../tests/crm-manager-provision-postgres.test.cjs');
 const f=await createFixture(t),calls=[],pool=admittedPool(async(sql,parameters)=>{assert.equal(parameters.length,1);const q=JSON.parse(parameters[0]);assert.equal(parameters[0],canonical(q));assert.equal(sql,QUERIES[q.action]);calls.push(q);return {rows:[{body:await f.call(q)}]};});
 const scope={issuerId:issuerA.issuerId,namespaceId:issuerA.namespaceId,allowedEmailDomains:['example.test'],provisionerToken:TOKEN,revision:options.revision};
 const app=createServer({...scope,pool,enabled:true});t.after(()=>app.stop());
 const {revision,...clientScope}=scope,client=createProvisioningClient({...clientScope,requestImpl:clientBridge(app)});
 const asArgs=q=>Object.fromEntries(['operationId','userId','lifecycleId','owner','principalId','keySha256'].map(k=>[k,q[k]]));
 const q=createPrepare(),a=asArgs(q),p=await client.prepareRead(a);assert.equal(p.state,'prepared');assert.equal((await f.key(q)).chave_hash,q.keySha256);assert.equal((await f.key(q)).chave_hash_curta,null);assert.deepEqual(await f.permissions(q),[{area:'growth',caps:policy.caps}]);
 assert.deepEqual(await client.prepareRead(a),p,'prepare retry has identical receipt and fixed TTL');
 const firstCommit=createRevoke(q).operationId,c=await client.commitRead({operationId:firstCommit,prepared:p});assert.equal(c.state,'committed');assert.equal(c.expiresAt,p.expiresAt);
 const found=await client.operationStatus({...client.describeRead(a),requireFound:true});assert.equal(found.receipt.principalId,q.principalId);
 const next=createRenewal(q),na={...asArgs(next),generation:2,expectedGeneration:1},np=await client.prepareRenewalRead(na);assert.equal((await f.key(q)).ativo,true,'predecessor remains live while renewal is prepared');
 const nextCommit=createRevoke(next).operationId,nc=await client.commitRead({operationId:nextCommit,prepared:np});assert.equal(nc.revokedGeneration,1);assert.equal((await f.key(q)).ativo,false);assert.deepEqual(await f.permissions(q),[]);assert.equal((await f.key(next)).ativo,true);
 const r=createRevoke(q),ra={operationId:r.operationId,userId:r.userId,lifecycleId:r.lifecycleId,owner:r.owner},revoked=await client.revokeRead(ra);assert.equal(revoked.allGenerationsRevoked,true);assert.equal(revoked.revokedCount,1,'only the remaining active generation changes during revoke');assert.deepEqual(await client.revokeRead(ra),revoked);
 assert.equal((await f.key(next)).ativo,false);assert.deepEqual(await f.permissions(next),[]);await assert.rejects(client.operationStatus({...client.describeRead(a),requireFound:true}),e=>e.code==='PROVISIONING_LIFECYCLE_REVOKED');
 const before=calls.length;assert.throws(()=>client.prepareEdit(a),e=>e.code==='EDIT_NOT_READY');assert.equal(calls.length,before,'edit cannot reach gateway or SQL');await f.unchanged();assert.equal(calls.length,9);
 for(const sent of calls){assert.equal(Object.hasOwn(sent,'bearer'),false);assert.equal(Object.hasOwn(sent,'password'),false);assert.equal(Object.hasOwn(sent,'authorization'),false);}
});

test('lost prepare ACK reconciles through historical status after expiry and replacement without extending TTL',async t=>{
 const {createFixture,createPrepare,createRevoke,issuerA}=require('../../tests/crm-manager-provision-postgres.test.cjs');
 const f=await createFixture(t),calls=[],replies=[],pool=admittedPool(async(sql,parameters)=>{assert.equal(parameters.length,1);const q=JSON.parse(parameters[0]);assert.equal(sql,QUERIES[q.action]);calls.push(q);const body=await f.call(q);replies.push(body);return {rows:[{body}]};});
 let clock=Date.now();const scope={issuerId:issuerA.issuerId,namespaceId:issuerA.namespaceId,allowedEmailDomains:['example.test'],provisionerToken:TOKEN,now:()=>clock};
 const app=createServer({...scope,pool,revision:options.revision,enabled:true});t.after(()=>app.stop());const client=createProvisioningClient({...scope,requestImpl:clientBridge(app,{dropFirstReply:true})});
 const asArgs=q=>Object.fromEntries(['operationId','userId','lifecycleId','owner','principalId','keySha256'].map(k=>[k,q[k]])),q=createPrepare(),a=asArgs(q);
 await assert.rejects(client.prepareRead(a),e=>e.code==='PROVISIONING_TRANSPORT_UNAVAILABLE'&&e.uncertain===true);const original=replies[0];assert.equal(original.state,'prepared');assert.ok(await f.key(q));
 clock+=660000;await f.age(q);const reconciled=await client.operationStatus({...client.describeRead(a),requireFound:true});assert.equal(reconciled.found,true);assert.equal(reconciled.receipt.candidateExpiresAt,original.candidateExpiresAt);assert.ok(reconciled.receipt.candidateExpiresAt<clock);assert.equal(reconciled.receipt.expiresAt,original.expiresAt);assert.deepEqual(replies.at(-1).receipt,original,'status returns the immutable original receipt after expiry');
 await assert.rejects(client.prepareRead(a),e=>e.code==='PROVISIONING_CANDIDATE_EXPIRED');const before=calls.length;await assert.rejects(client.commitRead({operationId:createRevoke(q).operationId,prepared:reconciled.receipt}),e=>e.code==='PROVISIONING_CANDIDATE_EXPIRED');assert.equal(calls.length,before,'expired recovered candidate cannot reach commit RPC');
 const fresh=createPrepare({userId:q.userId,lifecycleId:q.lifecycleId}),p=await client.prepareRead(asArgs(fresh));assert.notEqual(p.operationId,original.operationId);assert.notEqual(p.principalId,original.principalId);assert.equal(p.generation,1);assert.equal((await f.key(q)).ativo,false);assert.deepEqual(await f.permissions(q),[]);assert.equal((await f.key(fresh)).ativo,true);
 const recoveredAgain=await client.operationStatus({...client.describeRead(a),requireFound:true});assert.deepEqual(recoveredAgain,reconciled);assert.deepEqual(replies.at(-1).receipt,original,'replacement does not mutate historic receipt or TTL');assert.equal((await f.key(q)).ativo,false);await f.unchanged();assert.equal(calls.length,5);
});

function healthSetup(extra={}){
 const calls=[],released=[],flags={connects:0},meta=Object.fromEntries(ADMISSION_KEYS.map(k=>[k,true]));
 const client=Object.assign(new EventEmitter(),{connectionParameters:{host:PG_HOST,port:5432,database:'listmonk',user:ROLE,password:RAW,ssl:false},connection:{stream:{destroy(){}}},release:bad=>released.push(bad),query:async(sql,params)=>{
  calls.push({sql,params});if(sql===admissionSql(extra.pgTlsRequired===true)){if(extra.pendingMeta)await extra.pendingMeta;return{rows:[{...meta,...extra.meta}]};}
  if(sql==='BEGIN READ ONLY'||sql==='ROLLBACK')return {command:sql.startsWith('BEGIN')?'BEGIN':'ROLLBACK',rows:[]};
  assert.equal(sql,QUERIES.status);const q=JSON.parse(params[0]);return {rows:[{body:{schema:'crm-manager-provision-status-v1',issuerId:q.issuerId,namespaceId:q.namespaceId,operationId:q.operationId,found:false,...extra.status}}]};
 }});
 if(extra.alterClient)extra.alterClient(client);
 const pool={query:async()=>{throw Error(RAW);},connect:async()=>{flags.connects++;return client;}};
 const app=createServer({...options,pool,pgTlsRequired:extra.pgTlsRequired===true,...extra.server});
 function health(change={}){const h=send(app,{}, {method:'GET',path:'/healthz',headers:{authorization:undefined,host:'127.0.0.1:8080'},socket:{remoteAddress:'127.0.0.1'},...change});return h;}
 return {app,client,pool,calls,released,flags,health};
}
test('local health uses a real admitted lease, fresh readonly STATUS and closed no-secret readiness',async()=>{
 const f=healthSetup();assert.equal(f.flags.connects,0);const a=f.health();await a.done;assert.equal(a.res.status,200);assert.equal(a.res.body.ready,true);assert.equal(a.res.body.policy.connectionVerified,true);assert.deepEqual(f.calls.map(c=>c.sql),[admissionSql(false),'BEGIN READ ONLY',QUERIES.status,'ROLLBACK']);assert.deepEqual(f.released,[false]);
 const q=JSON.parse(f.calls[2].params[0]);assert.equal(q.action,'status');assert.equal(q.schema,'crm-manager-provision-request-v1');assert.equal(q.issuerId,options.issuerId);assert.equal(q.namespaceId,options.namespaceId);assert.match(q.operationId,/^[a-f0-9-]{36}$/);assert.match(q.expectedRequestSha256,/^[a-f0-9]{64}$/);
 const b=f.health();await b.done;assert.notEqual(JSON.parse(f.calls[6].params[0]).operationId,q.operationId);
 for(const secret of [RAW,TOKEN,options.issuerId,options.namespaceId,q.operationId,q.expectedRequestSha256])assert.equal(JSON.stringify(a.res.body).includes(secret),false);
 assert.equal(f.calls.some(c=>c.sql===QUERIES.prepare_read||c.sql===QUERIES.commit_read||c.sql===QUERIES.revoke_read),false);
});
test('every connection/role/ACL metadata false or foreign field denies before STATUS',async()=>{
 for(const field of ADMISSION_KEYS){const f=healthSetup({meta:{[field]:false}}),r=f.health();await r.done;assert.equal(r.res.status,503);assert.equal(r.res.body.ready,false);assert.equal(f.calls.length,1);assert.deepEqual(f.released,[true]);}
 const f=healthSetup({meta:{private_connection:RAW}}),r=f.health();await r.done;assert.equal(r.res.status,503);assert.equal(JSON.stringify(r.res.body).includes(RAW),false);
});
test('health STATUS must be exact foundfalse for the configured active issuer, no historical adoption',async()=>{
 for(const status of [{found:true},{issuerId:id(89)},{namespaceId:id(89)},{operationId:id(89)},{secret:RAW},{schema:'foreign'}]){const f=healthSetup({status}),r=f.health();await r.done;assert.equal(r.res.status,503);assert.equal(JSON.stringify(r.res.body).includes(RAW),false);assert.deepEqual(f.released,[true]);}
});
test('health refuses foreign/admin/plaintext TLS leases before even metadata SQL',async()=>{
 const mutations=[c=>{c.connectionParameters.host='foreign';},c=>{c.connectionParameters.user='postgres';},c=>{c.connectionParameters.database='other';},c=>{c.connectionParameters.port=5433;},c=>{c.connectionParameters.ssl={rejectUnauthorized:false};},c=>{c.connection.stream.encrypted=true;}];
 for(const alterClient of mutations){const f=healthSetup({alterClient}),r=f.health();await r.done;assert.equal(r.res.status,503);assert.equal(f.calls.length,0);assert.deepEqual(f.released,[true]);}
 const plain=healthSetup({pgTlsRequired:true}),r=plain.health();await r.done;assert.equal(r.res.status,503);assert.equal(plain.calls.length,0);
});
test('TLS health requires authorized stream and exact driver hostname; no permissive fallback',async()=>{
 const base=c=>{c.connectionParameters.ssl={rejectUnauthorized:true,ca:'SYNTHETIC_PUBLIC_CA',servername:PG_HOST};Object.assign(c.connection.stream,{encrypted:true,authorized:true,servername:PG_HOST});};
 const good=healthSetup({pgTlsRequired:true,alterClient:base}),r=good.health();await r.done;assert.equal(r.res.status,200);assert.equal(good.calls[0].sql,admissionSql(true));
 for(const patch of [c=>c.connectionParameters.ssl.rejectUnauthorized=false,c=>c.connection.stream.authorized=false,c=>c.connection.stream.servername='foreign',c=>c.connectionParameters.ssl.servername='foreign',c=>c.connectionParameters.ssl.extra=RAW]){const f=healthSetup({pgTlsRequired:true,alterClient:c=>{base(c);patch(c);}}),bad=f.health();await bad.done;assert.equal(bad.res.status,503);assert.equal(f.calls.length,0);}
});
test('health and RPC share one retained SQL slot and expired probes never dispatch STATUS later',async()=>{
 let release;const blocked=new Promise(resolve=>release=resolve),f=healthSetup({pendingMeta:blocked,server:{deadlineMs:30,bodyTimeoutMs:15}}),a=f.health(),b=f.health(),c=f.health();await tick();assert.deepEqual(f.app.pending(),{active:1,queued:2,handling:3});assert.equal(f.flags.connects,1);const excess=f.health();await excess.done;assert.equal(excess.res.status,503);await Promise.all([a.done,b.done,c.done]);assert.equal(f.app.pending().active,1);assert.equal(f.flags.connects,1);release();await tick();await tick();assert.equal(f.app.pending().active,0);assert.equal(f.calls.length,1);assert.deepEqual(f.released,[true]);
});
test('remote health and disabled service never open a lease or return healthy',async()=>{
 const f=healthSetup(),r=send(f.app,{}, {method:'GET',path:'/healthz',socket:{remoteAddress:'10.0.0.1'}});await r.done;assert.equal(r.res.status,503);assert.equal(f.flags.connects,0);
 const off=healthSetup({server:{enabled:false}}),bad=off.health();await bad.done;assert.equal(bad.res.status,503);assert.equal(off.flags.connects,0);
});
test('explicit PG TLS config pins host/port/role and rejects URL/ambient overrides',()=>{
 const env={PGHOST:PG_HOST,PGUSER:ROLE,PGDATABASE:'listmonk',PGPASSWORD:'SYNTHETIC_ONLY',CRM_MANAGER_PG_TLS:'false',CRM_MANAGER_ISSUER_ID:options.issuerId,CRM_MANAGER_NAMESPACE_ID:options.namespaceId,CRM_MANAGER_REVISION:options.revision,CRM_MANAGER_ALLOWED_EMAIL_DOMAINS:'["synthetic.invalid"]',CRM_MANAGER_PROVISIONER_TOKEN:TOKEN};
 const c=config(env);assert.equal(c.pg.ssl,false);assert.equal(c.pg.max,1);assert.equal(c.pg.host,PG_HOST);assert.equal(c.pg.port,5432);assert.equal(c.pg.options.includes('log_parameter'),false);
 for(const change of [{PGHOST:'foreign'},{PGPORT:'5433'},{PGUSER:'postgres'},{PGSSLMODE:'disable'},{PGOPTIONS:'private'},{DATABASE_URL:'postgres://private'},{CRM_MANAGER_PG_TLS:'true'},{CRM_MANAGER_PG_TLS:undefined},{CRM_MANAGER_PG_TLS:'prefer'},{CRM_MANAGER_PG_CA:'PRIVATE'}])assert.throws(()=>config({...env,...change}),e=>e instanceof GatewayError);
 const ca=require('node:tls').rootCertificates[0],secure=config({...env,CRM_MANAGER_PG_TLS:'true',CRM_MANAGER_PG_CA:ca,CRM_MANAGER_PG_SERVERNAME:PG_HOST});assert.equal(secure.pg.ssl.rejectUnauthorized,true);assert.equal(secure.pg.ssl.servername,PG_HOST);assert.equal(secure.pg.ssl.ca,ca);
 assert.throws(()=>config({...env,CRM_MANAGER_PG_TLS:'true',CRM_MANAGER_PG_CA:ca,CRM_MANAGER_PG_SERVERNAME:'different.invalid'}),e=>e instanceof GatewayError);
});

test('every authenticated RPC is admitted on its lease before any mutation query',async()=>{
 for(const field of ADMISSION_KEYS){const f=healthSetup({meta:{[field]:false}}),r=send(f.app);await r.done;assert.equal(r.res.status,503);assert.equal(f.calls.length,1);assert.equal(f.calls[0].sql,admissionSql(false));assert.deepEqual(f.released,[true]);assert.equal(JSON.stringify(r.res.body).includes(RAW),false);}
 const f=healthSetup({alterClient:c=>{c.connectionParameters.user='postgres';}}),r=send(f.app);await r.done;assert.equal(r.res.status,503);assert.equal(f.calls.length,0);assert.deepEqual(f.released,[true]);
});
test('RPC admission timeout cannot dispatch a late prepare or free an unsettled lease',async()=>{
 let release;const pendingMeta=new Promise(resolve=>release=resolve),f=healthSetup({pendingMeta,server:{deadlineMs:30,bodyTimeoutMs:15}}),r=send(f.app);await r.done;assert.equal(r.res.status,503);assert.equal(f.app.pending().active,1);assert.equal(f.calls.length,1);release();await tick();await tick();assert.equal(f.calls.length,1);assert.equal(f.app.pending().active,0);assert.deepEqual(f.released,[true]);
});


test('exact admission SELECT compiles in disposable catalog and never passes the fixture identity',async t=>{
 const {createFixture}=require('../../tests/crm-manager-provision-postgres.test.cjs'),f=await createFixture(t);for(const tls of [false,true]){const r=await f.db.query(admissionSql(tls));assert.equal(r.rows.length,1);assert.deepEqual(Object.keys(r.rows[0]).sort(),[...ADMISSION_KEYS].sort());for(const value of Object.values(r.rows[0]))assert.equal(typeof value,'boolean');assert.equal(r.rows[0].session_ok,false);assert.equal(r.rows[0].role_ok,false);}await f.unchanged();
});


test('leased client errors are observed generically and refuse before a late mutation dispatch',async()=>{
 let release;const pendingMeta=new Promise(resolve=>release=resolve),f=healthSetup({pendingMeta}),r=send(f.app);await tick();assert.equal(f.flags.connects,1);assert.doesNotThrow(()=>f.client.emit('error',Error(RAW)));release();await r.done;await tick();assert.equal(r.res.status,503);assert.equal(f.calls.length,1);assert.deepEqual(f.released,[true]);assert.equal(JSON.stringify(r.res.body).includes(RAW),false);assert.equal(f.client.listenerCount('error'),0);
});
