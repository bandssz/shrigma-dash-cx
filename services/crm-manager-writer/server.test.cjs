'use strict';
// All pool/HTTP transports below are deliberate fakes. SQL integration uses PGlite,
// never a native connection or a claimed deployed catalog/transport proof.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{EventEmitter}=require('node:events'),crypto=require('node:crypto'),fs=require('node:fs'),{spawnSync}=require('node:child_process');
const S=require('./server.cjs'),{createServer,HOST,ROLE,PG_HOST,QUERIES,ADMISSION_KEYS,admissionSql,canonical,sha}=S;
const root=process.env.CRM_WRITER_PUBLIC_SOURCE_ROOT||path.resolve(__dirname,'../..');
const {createWriterClient,FUNCTIONS}=require(path.join(root,'services/dashboard-operational/crm-manager-writer-client.cjs'));
const NOW=1791028800000,id=n=>'123e4567-e89b-42d3-a456-'+String(n).padStart(12,'0');
const TOKEN='SYNTHETIC_BFF_TOKEN_FOR_WRITER_ONLY_'.repeat(2),PASSWORD='SYNTHETIC_PG_PASSWORD_FOR_WRITER_ONLY_'.repeat(2),RAW='PRIVATE_CAUSE_SENTINEL_FOR_NEGATIVE_TESTS';
const options={enabled:true,issuerId:id(90),namespaceId:id(91),allowedEmailDomains:['oaristocrata.com','shrigma.com.br','fishermans.com.br'],provisionerToken:TOKEN,revision:'a'.repeat(40),now:()=>NOW};
const policy={area:'growth',slot:'growth-campaign',role:'manager',caps:['read_content','draft','validate','submit'],candidateTtlMs:600000,lifetimeMs:1209600000};
const args=(n=1)=>({operationId:id(n),userId:id(10),lifecycleId:id(20),owner:'gestor@oaristocrata.com',brand:'fish',principalId:'dcrmw-'+'a'.repeat(32),keySha256:sha('SYNTHETIC_MANAGER_BEARER')});
const command=(n=1)=>({schema:'crm-manager-writer-request-v1',issuerId:options.issuerId,namespaceId:options.namespaceId,action:'prepare_writer',...args(n),generation:1,expectedGeneration:0,...policy});
function receipt(c){const base={schema:'crm-manager-writer-receipt-v1',issuerId:c.issuerId,namespaceId:c.namespaceId,operationId:c.operationId,action:c.action,requestSha256:sha(canonical(c)),userId:c.userId,lifecycleId:c.lifecycleId,owner:c.owner};
 if(c.action==='revoke_writer')return {...base,state:'revoked',revocationMode:'lifecycle',allGenerationsRevoked:true,effectiveAt:NOW,revokedCount:2};
 const issuedAt=c.issuedAt??NOW;return {...base,state:c.action==='commit_writer'?'committed':'prepared',principalId:c.principalId,generation:c.generation,expectedGeneration:c.expectedGeneration,area:'growth',slot:'growth-campaign',role:'manager',brand:c.brand,caps:[...policy.caps],issuedAt,candidateExpiresAt:issuedAt+600000,expiresAt:issuedAt+1209600000,...(c.action==='commit_writer'?{prepareOperationId:c.prepareOperationId,committedAt:issuedAt+100,revokedGeneration:c.expectedGeneration===0?null:c.expectedGeneration}:{})};}
function fakePool(handle=c=>receipt(c),changes={}){
 const saved=new Map(),calls=[],leases=[];let connects=0;
 const pool={connect:async()=>{connects++;const c=Object.assign(new EventEmitter(),{connectionParameters:{host:PG_HOST,port:5432,database:'listmonk',user:ROLE,password:PASSWORD,ssl:false,...changes.parameters},connection:{stream:{destroy(){c.destroyed=true;}}},release(kill){leases.push(kill);},query:async(sql,params)=>{
  calls.push({sql,params});if(sql==='SET LOCAL search_path=pg_catalog')return{command:'SET'};if(['BEGIN','BEGIN READ ONLY','COMMIT','ROLLBACK'].includes(sql)){if(changes.transactionError===sql)throw Error(RAW);return {command:sql.startsWith('BEGIN')?'BEGIN':sql};}
  if(sql===admissionSql(false))return {rows:[{...Object.fromEntries(ADMISSION_KEYS.map(k=>[k,true])),...changes.meta}]};
  assert.ok(Object.values(QUERIES).includes(sql));assert.equal(params.length,1);const q=JSON.parse(params[0]);let body;
  if(q.action==='writer_status')body={schema:'crm-manager-writer-status-v1',issuerId:q.issuerId,namespaceId:q.namespaceId,operationId:q.operationId,found:saved.has(q.operationId),...(saved.has(q.operationId)?{receipt:saved.get(q.operationId)}:{})};
  else{body=await handle(q,c);saved.set(q.operationId,body);}return {rows:[{body}]};
 }});return c;}};
 return {pool,calls,leases,saved,get connects(){return connects;}};
}
function setup(handle,change={}){const f=fakePool(handle,change.poolChanges||{});return {...f,app:createServer({...options,pool:f.pool,...change.appOptions}),fixture:f};}
function send(app,body=command(),change={}){
 const req=new EventEmitter(),res=new EventEmitter();req.socket=change.socket||{remoteAddress:'127.0.0.1'};
 req.headers={host:HOST,authorization:'CRM-Writer-Provisioner '+TOKEN,'content-type':'application/json; charset=utf-8',...change.headers};req.rawHeaders=change.rawHeaders||Object.entries(req.headers).flat();req.url=change.path||'/internal/v1/crm-writers/prepare';req.method=change.method||'POST';req.complete=false;
 res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;};res.end=bytes=>{res.body=JSON.parse(Buffer.from(bytes));res.writableEnded=true;};res.destroy=()=>{res.destroyed=true;res.emit('close');};
 const done=app.handle(req,res);queueMicrotask(()=>{if(change.holdBody)return;for(const b of change.chunks||[Buffer.from(change.wire??canonical(body))])req.emit('data',b);req.complete=true;req.emit('end');});return {req,res,done};
}
const tick=()=>new Promise(r=>setImmediate(r));
const rpcCalls=f=>f.calls.filter(x=>Object.values(QUERIES).includes(x.sql));
function client(app){return createWriterClient({issuerId:options.issuerId,namespaceId:options.namespaceId,allowedEmailDomains:['oaristocrata.com','shrigma.com.br','fishermans.com.br'],now:()=>NOW,invoke:async q=>{
 const body=JSON.parse(q.parameters[0]);assert.equal(q.procedure,FUNCTIONS[body.action]);const path=Object.entries(S.ROUTES).find(([,a])=>a.includes(body.action))[0],r=send(app,body,{path});await r.done;if(r.res.status!==200)throw Error('SYNTHETIC_TRANSPORT_REFUSED');return r.res.body;
 }});}

test('OFF factory/config require no PG or token and cannot dispatch; closed health means not ready',async()=>{
 const app=createServer({revision:'a'.repeat(40)}),r=send(app);await r.done;assert.equal(r.res.status,503);assert.deepEqual(app.pending(),{active:0,queued:0,handling:0});
 const h=send(app,{}, {path:'/healthz',method:'GET'});await h.done;assert.equal(h.res.status,200);assert.equal(h.res.body.enabled,false);assert.equal(h.res.body.ready,false);assert.equal(h.res.body.policy.namespaceBound,false);
 assert.deepEqual(S.config({CRM_WRITER_REVISION:'a'.repeat(40)}),{port:8080,enabled:false,revision:'a'.repeat(40)});
 for(const extra of [{PGPASSWORD:PASSWORD},{PGHOST:PG_HOST},{CRM_WRITER_PROVISIONER_TOKEN:TOKEN},{DATABASE_URL:'postgres://synthetic'}])assert.throws(()=>S.config({CRM_WRITER_REVISION:'a'.repeat(40),...extra}),/UNAVAILABLE/);
 assert.throws(()=>createServer({enabled:false,revision:'a'.repeat(40),pool:{connect(){throw Error(RAW);}}}),/UNAVAILABLE/);
});
test('OFF explicit start/import needs no pg module, secret, sockets or pool in an isolated child',()=>{
 const script="const assert=require('node:assert/strict'),Module=require('node:module'),E=require('node:events');const load=Module._load;let pools=0,listens=0;Module._load=function(n,...a){if(n==='pg')throw Error('PG_MUST_NOT_LOAD');if(n==='node:http')return {createServer(){return Object.assign(new E(),{listen(){listens++},close(f){f()},closeIdleConnections(){}})}};return load.call(this,n,...a)};const S=require(process.argv[1]);assert.equal(listens,0);process.env.CRM_WRITER_REVISION='a'.repeat(40);const r=S.start(process.env,{Pool:class{constructor(){pools++}}});r.stop().then(()=>{assert.equal(pools,0);assert.equal(listens,1);process.stdout.write('OFF_START_CLOSED\\n')});";
 const r=spawnSync(process.execPath,['-e',script,path.join(__dirname,'server.cjs')],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:3000});assert.equal(r.status,0);assert.equal(r.stdout,'OFF_START_CLOSED\n');assert.equal(r.stderr,'');
});
test('same real BFF client handles prepare→commit→status→renew→revoke with four pinned procedures',async()=>{
 const f=setup(),c=client(f.app),q=c.command('prepare_writer',args()),p=await c.prepare(q),cq=c.command('commit_writer',{...args(2),prepareOperationId:q.operationId,generation:1,expectedGeneration:0,issuedAt:p.issuedAt,candidateExpiresAt:p.candidateExpiresAt,expiresAt:p.expiresAt});
 const committed=await c.commit({operationId:id(2),proof:p,expectedRequest:cq});assert.equal(committed.state,'committed');assert.equal((await c.status(cq,{requireFound:true})).receipt.principalId,q.principalId);
 const renewal=c.command('renew_writer',{...args(3),generation:2,expectedGeneration:1,principalId:'dcrmw-'+'b'.repeat(32)});assert.equal((await c.prepare(renewal)).state,'prepared');
 const rev=c.command('revoke_writer',{operationId:id(4),userId:id(10),lifecycleId:id(20),owner:'gestor@oaristocrata.com'});assert.equal((await c.revoke(rev)).allGenerationsRevoked,true);
 const calls=rpcCalls(f);assert.equal(calls.length,10);assert.equal(calls.filter(x=>x.sql===QUERIES.commit_writer).length,1);assert.ok(calls.every(x=>x.params.length===1));assert.deepEqual(f.leases,[false,false,false,false,false]);assert.equal(f.calls.filter(x=>x.sql==='BEGIN READ ONLY').length,1);assert.equal(f.calls.filter(x=>x.sql==='ROLLBACK').length,1);assert.equal(f.calls.filter(x=>x.sql==='COMMIT').length,4);
});
test('Origin, Host, token scheme/duplication and missing secret refuse before connect',async()=>{
 for(const change of [{headers:{origin:'https://browser.invalid'}},{headers:{host:'elsewhere.invalid'}},{headers:{authorization:'CRM-Provisioner '+TOKEN}},{headers:{authorization:'Bearer '+TOKEN}},{headers:{authorization:undefined}},{rawHeaders:['Host',HOST,'Authorization','CRM-Writer-Provisioner '+TOKEN,'Authorization','CRM-Writer-Provisioner '+TOKEN]}]){const f=setup(),r=send(f.app,command(),change);await r.done;assert.ok(r.res.status>=400);assert.equal(f.fixture.connects,0);assert.equal(JSON.stringify(r.res.body).includes(TOKEN),false);}
});
test('exact routes/methods/content type/encoding/length deny without transport',async()=>{
 for(const change of [{method:'GET'},{method:'OPTIONS'},{path:'/internal/v1/crm-writers/prepare?x=1'},{path:'/internal/v1/crm-writers/prepare/'},{path:'/internal/v1/crm-managers/prepare'},{headers:{'content-type':'text/plain'}},{headers:{'content-encoding':'gzip'}},{headers:{'content-length':'4097'}},{headers:{'content-length':'1','transfer-encoding':'chunked'}}]){const f=setup(),r=send(f.app,command(),change);await r.done;assert.ok(r.res.status>=400);assert.equal(f.fixture.connects,0);}
});
test('READ principal/caps, edit_content, owner/scope/generation/TTL and arbitrary fields never reach SQL',async()=>{
 for(const bad of [{bearer:RAW},{sql:'SELECT secrets'},{schema:'crm-manager-provision-request-v1'},{principalId:'dcrm-'+'a'.repeat(32)},{caps:['read_content','draft','submit']},{caps:['read_content','draft','validate','submit','edit_content']},{area:'influs'},{slot:'crm-panel-read'},{role:'superadmin'},{issuerId:id(89)},{namespaceId:id(89)},{owner:'gestor@example.test'},{keySha256:'A'.repeat(64)},{candidateTtlMs:600001},{lifetimeMs:1209600001},{generation:2},{expectedGeneration:1}]){const f=setup(),r=send(f.app,{...command(),...bad});await r.done;assert.ok(r.res.status>=400);assert.equal(f.fixture.connects,0);assert.equal(JSON.stringify(r.res.body).includes(RAW),false);}
});
test('canonical JSON, duplicate keys, fatal UTF8 and incremental 4 KiB refusal',async()=>{
 for(const change of [{wire:' '+canonical(command())},{wire:'{"a":1,"a":2}'},{wire:'malformed '+RAW},{chunks:[Buffer.alloc(4096,32),Buffer.from('x')]},{chunks:[Buffer.from(canonical(command())),Buffer.from([0xc3])]},{headers:{'content-length':'1'}}]){const f=setup(),r=send(f.app,command(),change);await r.done;assert.ok(r.res.status>=400);assert.equal(f.fixture.connects,0);assert.equal(JSON.stringify(r.res.body).includes(RAW),false);}
});
test('body timeout/errors are consumed before SQL, including late stream errors',async()=>{
 const f=setup(undefined,{appOptions:{deadlineMs:40,bodyTimeoutMs:10}}),r=send(f.app,command(),{holdBody:true});await r.done;assert.equal(r.res.status,400);assert.equal(f.fixture.connects,0);assert.doesNotThrow(()=>r.req.emit('error',Error(RAW)));assert.doesNotThrow(()=>r.res.emit('error',Error(RAW)));
});
test('each catalog/role/TLS admission flag refuses before even issuer STATUS',async()=>{
 for(const key of ADMISSION_KEYS){const f=setup(undefined,{poolChanges:{meta:{[key]:false}}}),r=send(f.app);await r.done;assert.equal(r.res.status,503);assert.equal(rpcCalls(f).length,0);assert.deepEqual(f.leases,[true]);}
 for(const parameters of [{host:'127.0.0.1'},{port:5440},{database:'crm_manager_writer_fixture'},{user:'postgres'},{ssl:{rejectUnauthorized:false}}]){const f=setup(undefined,{poolChanges:{parameters}}),r=send(f.app);await r.done;assert.equal(r.res.status,503);assert.equal(f.calls.length,0);}
});
test('inactive/misbound issuer STATUS refuses before mutation and never claims ready',async()=>{
 const f=setup();f.pool.connect=async()=>Object.assign(new EventEmitter(),{connectionParameters:{host:PG_HOST,port:5432,database:'listmonk',user:ROLE,password:PASSWORD,ssl:false},connection:{stream:{destroy(){}}},release(){},query:async(sql,params)=>{if(sql==='BEGIN')return{command:'BEGIN'};if(sql==='SET LOCAL search_path=pg_catalog')return{command:'SET'};if(sql===admissionSql(false))return{rows:[Object.fromEntries(ADMISSION_KEYS.map(k=>[k,true]))]};const q=JSON.parse(params[0]);f.calls.push({sql,params});return {rows:[{body:{schema:'crm-manager-writer-error-v1',issuerId:null,namespaceId:null,operationId:q.operationId,requestSha256:sha(canonical(q)),code:'ISSUER_DENIED'}}]};}});
 const r=send(f.app);await r.done;assert.equal(r.res.status,503);assert.equal(f.calls.length,1);assert.equal(f.calls[0].sql,QUERIES.writer_status);
});
test('typed SQL conflict uses HTTP200 and exact error correlation required by existing client',async()=>{
 const f=setup(c=>({schema:'crm-manager-writer-error-v1',issuerId:c.issuerId,namespaceId:c.namespaceId,operationId:c.operationId,requestSha256:sha(canonical(c)),code:'GENERATION_CONFLICT'})),r=send(f.app);await r.done;assert.equal(r.res.status,200);assert.equal(r.res.body.code,'GENERATION_CONFLICT');assert.ok(f.calls.some(x=>x.sql==='COMMIT'));
 const c=client(f.app);await assert.rejects(c.prepare(c.command('prepare_writer',args(5))),e=>e.code==='CRM_WRITER_BRIDGE_REFUSED');
});
test('invalid/nested/oversize receipts and raw driver causes never reach stdout or response',async()=>{
 for(const mutate of [r=>r.bearer=RAW,r=>r.extra={nested:[PASSWORD]},r=>r.owner='other@oaristocrata.com',r=>r.caps=['read_content','draft','submit'],r=>r.caps.push('edit_content'),r=>r.candidateExpiresAt++,r=>r.requestSha256='b'.repeat(64),r=>r.extra='x'.repeat(8192)]){const f=setup(c=>{const r=receipt(c);mutate(r);return r;}),r=send(f.app);await r.done;assert.equal(r.res.status,503);assert.equal(JSON.stringify(r.res.body).includes(RAW),false);assert.equal(JSON.stringify(r.res.body).includes(PASSWORD),false);assert.equal(f.calls.some(x=>x.sql==='COMMIT'),false);}
 const f=setup(()=>{throw Error(RAW+PASSWORD);}),r=send(f.app);await r.done;assert.equal(r.res.status,503);assert.equal(JSON.stringify(r.res.body).includes(RAW),false);
});
test('service secret scanning refuses case/percent/base64/base64url/hex echoes, including a malformed unrelated percent',()=>{
 for(const secret of [TOKEN,PASSWORD])for(const value of [secret,secret.toLowerCase(),...['base64','base64url','hex'].map(enc=>Buffer.from(secret).toString(enc).toLowerCase()),'%bad '+[...secret].map(x=>'%'+x.charCodeAt(0).toString(16)).join('')])assert.equal(S.containsSecret({nested:[value]},[TOKEN,PASSWORD]),true);
 assert.equal(S.containsSecret(receipt(command()),[TOKEN,PASSWORD]),false);
});
test('deadline/backpressure retains one active lease, never retries dispatched RPC',async()=>{
 let release;const gate=new Promise(r=>release=r),f=setup(async c=>{await gate;return receipt(c);},{appOptions:{deadlineMs:45,bodyTimeoutMs:10}});
 const a=send(f.app,command(1));await tick();const b=send(f.app,command(2)),c=send(f.app,command(3)),d=send(f.app,command(4));await d.done;assert.equal(d.res.status,503);assert.equal(f.fixture.connects,1);await Promise.all([a.done,b.done,c.done]);assert.equal(rpcCalls(f).filter(x=>x.sql===QUERIES.prepare_writer).length,1);assert.equal(f.app.pending().active,1);release();await tick();await tick();assert.equal(f.app.pending().active,0);assert.deepEqual(f.leases,[true]);assert.equal(f.fixture.connects,1);
});
test('shutdown refuses queued work, waits active lease and does not commit after closing',async()=>{
 let release;const gate=new Promise(r=>release=r),f=setup(async c=>{await gate;return receipt(c);}),a=send(f.app);await tick();const b=send(f.app,command(2));await tick();let closed=false;const stop=f.app.stop().then(()=>{closed=true;});await Promise.all([a.done,b.done]);assert.equal(closed,false);release();await stop;assert.equal(closed,true);assert.equal(f.calls.some(x=>x.sql==='COMMIT'),false);assert.deepEqual(f.leases,[true]);assert.equal(f.fixture.connects,1);
});
test('health is loopback-only READ ONLY and projects no issuer IDs, key, counts or snapshots',async()=>{
 const f=setup(),r=send(f.app,{}, {path:'/healthz',method:'GET'});await r.done;assert.equal(r.res.status,200);assert.equal(r.res.body.ready,true);assert.equal(r.res.body.policy.coreVerified,true);assert.equal(f.calls[0].sql,'BEGIN READ ONLY');assert.equal(f.calls.at(-1).sql,'ROLLBACK');assert.equal(JSON.stringify(r.res.body).includes(options.issuerId),false);assert.equal(JSON.stringify(r.res.body).includes(PASSWORD),false);
 const other=send(f.app,{}, {path:'/healthz',method:'GET',socket:{remoteAddress:'192.0.2.4'}});await other.done;assert.equal(other.res.status,503);
});
test('production configuration fixes own role/host/domain and refuses unsupported transport/material',()=>{
 const env={CRM_WRITER_ENABLED:'true',CRM_WRITER_REVISION:'a'.repeat(40),CRM_WRITER_ISSUER_ID:id(90),CRM_WRITER_NAMESPACE_ID:id(91),CRM_WRITER_PROVISIONER_TOKEN:TOKEN,CRM_WRITER_PG_TLS:'false',PGHOST:PG_HOST,PGDATABASE:'listmonk',PGUSER:ROLE,PGPASSWORD:PASSWORD};const cfg=S.config(env);assert.equal(cfg.pg.ssl,false);assert.equal(cfg.pg.max,1);assert.equal(cfg.pg.user,ROLE);assert.deepEqual(cfg.allowedEmailDomains,['oaristocrata.com','shrigma.com.br','fishermans.com.br']);
 for(const extra of [{PGHOST:'127.0.0.1'},{PGUSER:'postgres'},{PGDATABASE:'other'},{PGPORT:'5440'},{PGSERVICE:'other'},{DATABASE_URL:'postgres://other'},{PGPASSWORD:TOKEN},{CRM_WRITER_PG_TLS:'true',CRM_WRITER_PG_CA:'not-pem'},{CRM_WRITER_PG_TLS:'false',CRM_WRITER_PG_CA:'material'},{CRM_WRITER_ALLOWED_EMAIL_DOMAINS:'["other.test"]'}])assert.throws(()=>S.config({...env,...extra}),/UNAVAILABLE/);
});
test('lost ACK recovers from same STATUS; historical expired prepare never extends its dates',async()=>{
 const f=setup(),c=client(f.app),q=c.command('prepare_writer',args()),first=send(f.app,q);await first.done;const saved=first.res.body;
 const recovery=await c.status(q,{requireFound:true});assert.deepEqual(recovery.receipt,saved);assert.equal(rpcCalls(f).filter(x=>x.sql===QUERIES.prepare_writer).length,1);
 const late=createWriterClient({issuerId:options.issuerId,namespaceId:options.namespaceId,allowedEmailDomains:['oaristocrata.com','shrigma.com.br','fishermans.com.br'],now:()=>NOW+660001,invoke:async x=>{const body=JSON.parse(x.parameters[0]),r=send(f.app,body,{path:'/internal/v1/crm-writers/status'});await r.done;return r.res.body;}});
 assert.deepEqual((await late.status(q)).receipt,saved);assert.equal(f.saved.get(q.operationId).candidateExpiresAt,saved.candidateExpiresAt);
});
test('exact public SQL parses in PGlite; service status→prepare→commit→revoke preserves READ/legacy',async t=>{
 const {PGlite}=require('@electric-sql/pglite'),R=require(path.join(root,'tests/crm-manager-provision-postgres.test.cjs')),F=require(path.join(root,'tools/crm-manager-writer-review/writer-provision.test.cjs'));
 const f=await F.createWriterFixture(t,{Engine:PGlite,readFixture:R.createFixture,register:false});
 await f.db.exec('ALTER ROLE crm_manager_writer_service_v1 LOGIN');await f.db.query('INSERT INTO public.crm_manager_writer_issuer_v1(issuer_id,namespace_id,login_role,allowed_email_domains,active) VALUES($1,$2,$3,$4::text[],true)',[options.issuerId,options.namespaceId,ROLE,['oaristocrata.com','shrigma.com.br','fishermans.com.br']]);assert.equal(await f.profile(),S.PROFILE);
 // PGlite has no native SCRAM/transport. This adapter deliberately bypasses
 // service metadata only in the fake lease; the actual SQL/core is asserted separately.
 const sql=fakePool(),pool={connect:async()=>{const c=await sql.pool.connect();const original=c.query;c.query=async(text,p)=>{
  if(Object.values(QUERIES).includes(text)){const q=JSON.parse(p[0]);return {rows:[{body:await f.call(q,{issuerId:options.issuerId,namespaceId:options.namespaceId,login:ROLE})}]};}return original(text,p);};return c;}};
 const app=createServer({...options,pool,now:Date.now}),c=createWriterClient({issuerId:options.issuerId,namespaceId:options.namespaceId,allowedEmailDomains:['oaristocrata.com','shrigma.com.br','fishermans.com.br'],now:Date.now,invoke:async x=>{const q=JSON.parse(x.parameters[0]),p=Object.entries(S.ROUTES).find(([,a])=>a.includes(q.action))[0],r=send(app,q,{path:p});await r.done;assert.equal(r.res.status,200);return r.res.body;}});
 const q=c.command('prepare_writer',args()),p=await c.prepare(q);assert.equal((await f.key(q)).ativo,false);const cq=c.command('commit_writer',{...args(2),prepareOperationId:q.operationId,generation:1,expectedGeneration:0,issuedAt:p.issuedAt,candidateExpiresAt:p.candidateExpiresAt,expiresAt:p.expiresAt});assert.equal((await c.commit({operationId:id(2),proof:p,expectedRequest:cq})).state,'committed');assert.equal((await f.key(q)).ativo,true);
 const rev=c.command('revoke_writer',{operationId:id(4),userId:id(10),lifecycleId:id(20),owner:args().owner});assert.equal((await c.revoke(rev)).allGenerationsRevoked,true);assert.equal((await f.key(q)).ativo,false);await f.unchanged();
 // PGlite refuses its shared pg_database catalog to this synthetic role even
 // though its displayed ACL contains PUBLIC SELECT. Do not add catalog grants or
 // describe this as native admission: actual service transport belongs to OCI CI.
 await f.db.exec('SET SESSION AUTHORIZATION crm_manager_writer_service_v1');try{await assert.rejects(f.db.query(admissionSql(false)),e=>e.code==='42501');}finally{await f.db.exec('SET SESSION AUTHORIZATION postgres');}
 await f.db.exec('SET search_path=pg_catalog');const actual=(await f.db.query(admissionSql(false))).rows[0];assert.equal(actual.core_ok,true);assert.equal(actual.owner_ok,true);assert.equal(actual.database_ok,false);assert.equal(actual.session_ok,false);
 await f.db.exec('ALTER FUNCTION public.crm_manager_writer_prepare_v1(jsonb) IMMUTABLE');assert.equal((await f.db.query(admissionSql(false))).rows[0].core_ok,false);
});
