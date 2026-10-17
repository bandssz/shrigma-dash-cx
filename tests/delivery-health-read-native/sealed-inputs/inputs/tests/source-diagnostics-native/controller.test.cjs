'use strict';
const test=require('node:test'),a=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path'),{DatabaseSync}=require('node:sqlite'),{EventEmitter}=require('node:events');
const root=process.env.SOURCE_DIAGNOSTICS_TEST_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational');
const {createDelegationStore}=require(root+'/crm-native-delegation.cjs'),{createDatabaseVault}=require(root+'/native-database-vault.cjs'),S=require(root+'/native-source-sync.cjs'),D=require(root+'/native-source-diagnostics.cjs'),{createDiagnosticsController}=require(root+'/native-source-diagnostics-controller.cjs');
const requestId='11111111-1111-4111-8111-111111111111',otherRequest='22222222-2222-4222-8222-222222222222',operationId='33333333-3333-4333-8333-333333333333';
const secret='SyntheticOnly.DiagnosticPassword',sourceKey='SyntheticOnly.SourceKey.1234567890123456789',canon=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
async function fixture(t,{enabled=true}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL;CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES('fixture-master'),('fixture-other');");
 const key=crypto.randomBytes(32),state={revision:'a'.repeat(64),binding:'b'.repeat(64),active:true,edit:true},browser={method:'POST',csrf:'fixture-csrf',host:'fixture.invalid',origin:'https://fixture.invalid'},calls=[],sql=[],gates=[];
 const mac=x=>crypto.createHmac('sha256',key).update(x).digest('hex');
 const encrypt=x=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);const b=Buffer.concat([c.update(x,'utf8'),c.final()]);return [iv.toString('hex'),b.toString('hex'),c.getAuthTag().toString('hex')].join('.');};
 const decrypt=x=>{const [iv,b,tag]=x.split('.'),c=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'hex'));c.setAuthTag(Buffer.from(tag,'hex'));return Buffer.concat([c.update(Buffer.from(b,'hex')),c.final()]).toString('utf8');};
 const identity=()=>({role:'superadmin',active:state.active,canEditGrowth:state.edit,revision:state.revision});
 const consent=c=>{if(c?.nativeBearer!==undefined||c?.method!=='POST'||c.csrf!==browser.csrf)throw Error('Fixture browser denied');return {userId:c.owner||'fixture-master',sessionHash:'c'.repeat(64)};};
 const store=createDelegationStore({db,managerHost:'fixture.invalid',identity,consent,mac});
 const issue=()=>store.issue({context:browser,brands:['fish'],scopes:['crm.read','db.inspect']});
 const connection=issue();store.permitSourceSync({context:browser,connectionId:connection.connection.id});
 const native=store.context(connection.token);
 const vault=createDatabaseVault({enabled:true,db,consent,identity,encrypt,decrypt,mac});
 vault.bind({context:browser,username:'fixture_reader',password:secret,privateNetwork:true});
 const authorize=(ctx,{brand})=>{let ownerId;if(ctx.nativeBearer!==undefined)ownerId=store.authenticate(ctx.nativeBearer,{scope:'crm.source-sync',brand}).userId;else ownerId=consent(ctx).userId;if(!state.active||!state.edit||ownerId!=='fixture-master')throw Error('Fixture original denied');return {ownerId,ownerRevision:state.revision,binding:state.binding};};
 const transport=async q=>{calls.push(q);if(q.path==='/healthz')return {status:200,revision:S.REVISION,body:{service:'crm-shopify-sync',enabled:true,revision:S.REVISION,product_semantics:'v2',stopping:false}};a.equal(q.method,'POST');return {status:202,revision:S.REVISION,body:{operation_id:operationId,idempotency_key:q.body.idempotency_key,brand:'fish',state:'chunk_uncertain',query_sha256:S.QUERY,bulk_operation_id:'gid://shopify/BulkOperation/123',next_chunk:34,chunks:35,error_code:null}};};
 const source=S.createSourceSync({enabled:true,db,consent,identity,authorize,encrypt,decrypt,mac,transport});
 source.bind({context:browser,bearer:sourceKey,brands:['fish'],privateNetwork:true});
 await source.run({context:browser,brand:'fish',requestId});
 let hook=()=>{},readHold;
 class Client extends EventEmitter{
  constructor(config){super();this.connection=new EventEmitter();this.connection.stream={encrypted:false};this.processID=123;sql.push({kind:'construct',config});}
  async connect(){this.connection.emit('readyForQuery',{status:'I'});}
  async query(q){const text=typeof q==='string'?q:q.text;sql.push(text);await hook(text);if(text===D.READ_SQL&&readHold)await readHold;
   let r,status='T';
   if(text===D.PEER){status='I';r={command:'SELECT',rowCount:1,rows:[{database:'listmonk',sessionRole:'fixture_reader',currentRole:'fixture_reader',pid:123,port:5432,engine:170005,ssl:false,read_only:'on'}]};}
   else if(text===D.BEGIN)r={command:'BEGIN',rowCount:null,rows:[]};
   else if(text===D.ROLLBACK){status='I';r={command:'ROLLBACK',rowCount:null,rows:[]};}
   else{a.equal(text,D.READ_SQL);a.deepEqual(q.values,[operationId,'fish']);r={command:'SELECT',rowCount:1,rows:[{original_chunk_evidence:{schema:'shrigma-original-last-chunk-read-v1',database:'listmonk',transactionReadOnly:true,operationFound:true,operationId,brand:'fish',originalState:'chunk_uncertain',nextChunk:34,totalChunks:35,lastAttemptIndex:34,storedChunks:34,storedPrefixChunks:34,lastAttemptStored:false,lastAttemptHashMatches:null,productBatchReady:false,originalErrorCode:null,originalUpdatedAt:'2026-10-08T10:00:00Z',completedByOriginal:false,authorizesRecovery:false,authorizesAudienceRefresh:false,operational:false}}]};}
   this.connection.emit('readyForQuery',{status});return r;
  }
  async end(){sql.push('end');await hook('end');this.emit('end');}
 }
 const auth={nativeConnections:store,nativeDatabaseVault:vault,nativeSourceSync:source};
 const controller=createDiagnosticsController({enabled,driver:{Client,version:'8.23.1',packageSha256:'d'.repeat(64)},auth});
 t.after(()=>controller.close());
 const grant=()=>controller.authorize({context:browser,connectionId:connection.connection.id,brand:'fish',requestId,consent:true});
 const inspect=()=>controller.inspect({context:native,brand:'fish',requestId});
 return {db,state,browser,native,store,vault,source,controller,connection,issue,grant,inspect,calls,sql,setHook:f=>hook=f,setHold:p=>readHold=p};
}
test('fresh diagnostics scope cannot be obtained through generic issue or db.inspect/source-sync',async t=>{
 const f=await fixture(t);
 a.throws(()=>f.store.issue({context:f.browser,brands:['fish'],scopes:['crm.source-diagnostics']}),{code:'NATIVE_DIAGNOSTICS_SEPARATE_CONSENT_REQUIRED'});
 await a.rejects(f.inspect(),{code:'NATIVE_SCOPE_DENIED'});a.equal(f.sql.length,0);
 a.equal(f.controller.status(f.browser).connections[0].diagnosticsAuthorized,false);a.equal(f.sql.length,0);
});
test('same original request is resolved from sealed custody; one specific grant enables pure READ then closes',async t=>{
 const f=await fixture(t),transportBefore=f.calls.length,p=await f.grant();a.equal(p.operationId,operationId);a.equal(p.operational,false);a.equal(f.sql.length,0);
 const before=f.db.prepare('SELECT * FROM crm_native_connections_v1 WHERE id=?').get(f.connection.connection.id);
 const result=await f.inspect();a.equal(result.operation.originalState,'chunk_uncertain');a.equal(result.operation.completedByOriginal,false);a.equal(result.operation.lastAttemptStored,false);a.equal(result.authorizesRecovery,false);
 a.equal(f.calls.length,transportBefore);a.equal(f.sql.filter(x=>x===D.READ_SQL).length,1);a.deepEqual(f.sql.slice(1),[D.PEER,D.BEGIN,D.READ_SQL,D.ROLLBACK,'end']);
 const again=f.db.prepare('SELECT * FROM crm_native_connections_v1 WHERE id=?').get(f.connection.connection.id);a.deepEqual(again,before);
 a.equal(JSON.stringify(result).includes(secret),false);a.equal(JSON.stringify(result).includes(sourceKey),false);
 a.equal(f.db.prepare('SELECT COUNT(*) AS n FROM crm_native_source_diagnostics_consent_v1').get().n,1);
 f.grant();a.equal(f.db.prepare('SELECT COUNT(*) AS n FROM crm_native_source_diagnostics_consent_v1').get().n,1);
});
test('no supplied operation UUID, another request, another brand or selected connection can reach PG',async t=>{
 const f=await fixture(t);f.grant();
 for(const q of [{context:f.native,brand:'fish',requestId,operationId},{context:f.native,brand:'fish',requestId:otherRequest},{context:f.native,brand:'aristo',requestId},{context:f.browser,brand:'fish',requestId,connectionId:f.issue().connection.id}])await a.rejects(f.controller.inspect(q));
 a.equal(f.sql.length,0);
});
test('consent requires the real browser purpose and checkbox, with original source and DB bindings',async t=>{
 const f=await fixture(t);
 for(const q of [{context:f.native,consent:true},{context:{...f.browser,csrf:'wrong'},consent:true},{context:f.browser,consent:false}])a.throws(()=>f.controller.authorize({...q,connectionId:f.connection.connection.id,brand:'fish',requestId}));
 a.equal(f.sql.length,0);a.equal(f.db.prepare('SELECT COUNT(*) AS n FROM crm_native_source_diagnostics_consent_v1').get().n,0);
});
for(const delta of ['connection','owner','database','source','grant'])test('CURRENT '+delta+' change refuses before opening a PG session',async t=>{
 const f=await fixture(t);f.grant();
 if(delta==='connection')f.store.revoke({context:f.browser,connectionId:f.connection.connection.id});
 if(delta==='owner')f.state.revision='e'.repeat(64);
 if(delta==='database')f.vault.bind({context:f.browser,username:'fixture_reader',password:secret+'2',privateNetwork:true});
 if(delta==='source')f.source.bind({context:f.browser,bearer:sourceKey,brands:['fish'],privateNetwork:true});
 if(delta==='grant')f.db.prepare("UPDATE crm_native_source_diagnostics_consent_v1 SET binding_json=replace(binding_json,'fish','aristo')").run();
 await a.rejects(f.inspect());a.equal(f.sql.length,0);
});
for(const at of [D.PEER,'end'])test('revocation during '+(at===D.PEER?'peer read':'confirmed end')+' suppresses evidence and confirms closure',async t=>{
 const f=await fixture(t);f.grant();f.setHook(text=>{if(text===at)f.store.revoke({context:f.browser,connectionId:f.connection.connection.id});});
 await a.rejects(f.inspect());a.ok(f.sql.includes('end'));a.equal(f.calls.filter(c=>c.method==='POST').length,1);
 if(at===D.PEER)a.equal(f.sql.includes(D.READ_SQL),false);
});
test('reload retains original audited grant and sealed operation without upstream transport',async t=>{
 const f=await fixture(t);f.grant();const before=f.calls.length;
 const b=f.source.diagnosticsBinding({context:f.native,brand:'fish',requestId});a.equal(b.operationId,operationId);a.equal(b.brand,'fish');
 a.equal(f.store.sourceDiagnosticsConsent({context:f.native,connectionId:f.connection.connection.id,brand:'fish',requestId}).operationId,operationId);
 a.equal(f.calls.length,before);a.equal(JSON.stringify(b).includes(sourceKey),false);
});
test('capability OFF cannot grant consent or open PG',async t=>{
 const f=await fixture(t,{enabled:false});a.throws(f.grant,{code:'SOURCE_DIAGNOSTICS_NOT_ADMITTED'});await a.rejects(f.inspect(),{code:'SOURCE_DIAGNOSTICS_NOT_ADMITTED'});a.equal(f.sql.length,0);
});
