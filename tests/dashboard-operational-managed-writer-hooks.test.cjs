'use strict';
// Actual auth and SQLite schemas; synthetic identities, in-memory issuer and
// fixed-origin FULL attestation fetch only. No external connection or sends.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
function sourceRoot(){let d=__dirname;for(let i=0;i<8;i++,d=path.dirname(d))if(fs.existsSync(path.join(d,'services/dashboard-operational/auth.cjs')))return d;throw Error('WRITER_AUTH_TEST_SOURCE_MISSING');}
const ROOT=sourceRoot();
const {createAuth}=require(ROOT+'/services/dashboard-operational/auth.cjs');
const {createWriterAuthAdapter}=require(ROOT+'/services/dashboard-operational/crm-manager-writer-auth-adapter.cjs');
const {createWriterClient}=require(ROOT+'/services/dashboard-operational/crm-manager-writer-client.cjs');
const {createWriterCoordinator}=require(ROOT+'/services/dashboard-operational/crm-manager-writer-coordinator.cjs');
const {verifyCampaignWriterCredential,IDENTITY_URL}=require(ROOT+'/services/dashboard-operational/crm-campaign-writer-attestation.cjs');
const CAPS=['read_content','draft','validate','submit'],hosts={manager:'gerencial.synthetic.invalid',growth:'crm.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'};
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const PASSWORD='Synthetic writer manager password 2026!';
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'writer-auth-hook-')),dbPath=path.join(dir,'identity.sqlite'),key=crypto.randomBytes(32),issuerId=crypto.randomUUID(),namespaceId=crypto.randomUUID();let time=1791000000000;
 const config={dbPath,managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'master@synthetic.invalid',bootstrapTokenSha256:sha('synthetic-bootstrap'),encryptionKey:key,now:()=>time,crmCampaignSubmitWrite:true,crmManagedWriter:{issuerId,namespaceId}};
 let auth=createAuth(config);
 await auth.completeBootstrap({email:config.bootstrapAdminEmail,token:'synthetic-bootstrap',password:PASSWORD,host:hosts.manager,origin:'https://'+hosts.manager});
 const master=await auth.login({email:config.bootstrapAdminEmail,password:PASSWORD,host:hosts.manager,origin:'https://'+hosts.manager});
 const context={host:hosts.manager,method:'POST',origin:'https://'+hosts.manager,cookieHeader:master.cookie.split(';')[0],csrf:master.csrf};
 const db=new DatabaseSync(dbPath);db.exec('PRAGMA foreign_keys=ON');
 const inspect=f=>f(db),events=[],store=new Map(),active=new Set();let duringAttest=null,invalidIdentity=false;
 const digest=v=>crypto.createHmac('sha256',key).update('upstream-key:'+v).digest('hex');
 const encrypt=v=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),out=Buffer.concat([c.update(v,'utf8'),c.final()]);return ['v1',iv.toString('base64url'),c.getAuthTag().toString('base64url'),out.toString('base64url')].join('.');};
 const decrypt=v=>{const[,iv,tag,data]=v.split('.'),c=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));c.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([c.update(Buffer.from(data,'base64url')),c.final()]).toString('utf8');};
 const adapter=createWriterAuthAdapter({db,enabled:true,profile:'crm-sandbox',issuerId,namespaceId,allowedEmailDomains:['synthetic.invalid'],encrypt,decrypt,digest,now:()=>time});
 async function invoke({procedure,parameters}){
  assert.equal(db.isTransaction,false);assert.equal(parameters.length,1);const q=JSON.parse(parameters[0]);assert.equal(Object.hasOwn(q,'bearer'),false);assert.ok(/^public\.crm_manager_writer_(prepare|commit|revoke|status)_v1$/.test(procedure));events.push(q.action);
  if(q.action==='writer_status'){const r=store.get(q.operationId);return{schema:'crm-manager-writer-status-v1',issuerId,namespaceId,operationId:q.operationId,found:!!r,...(r?{receipt:r}:{})};}
  const old=store.get(q.operationId);if(old){assert.equal(old.requestSha256,sha(canonical(q)));return old;}
  const base={schema:'crm-manager-writer-receipt-v1',issuerId,namespaceId,operationId:q.operationId,action:q.action,requestSha256:sha(canonical(q)),userId:q.userId,lifecycleId:q.lifecycleId,owner:q.owner};let r;
  if(q.action==='revoke_writer'){for(const old of store.values())if(old.lifecycleId===q.lifecycleId)active.delete(old.principalId);r={...base,state:'revoked',revocationMode:'lifecycle',allGenerationsRevoked:true,effectiveAt:time,revokedCount:1};}
  else{const issued=q.issuedAt??time;r={...base,state:q.action==='commit_writer'?'committed':'prepared',principalId:q.principalId,generation:q.generation,expectedGeneration:q.expectedGeneration,area:'growth',slot:'growth-campaign',role:'manager',caps:[...CAPS],issuedAt:issued,candidateExpiresAt:issued+600000,expiresAt:issued+1209600000,...(q.action==='commit_writer'?{prepareOperationId:q.prepareOperationId,committedAt:time,revokedGeneration:q.expectedGeneration===0?null:q.expectedGeneration}:{})};if(q.action==='commit_writer'){for(const old of store.values())if(old.lifecycleId===q.lifecycleId)active.delete(old.principalId);active.add(q.principalId);}}
  store.set(q.operationId,r);return r;
 }
 const client=createWriterClient({issuerId,namespaceId,allowedEmailDomains:['synthetic.invalid'],now:()=>time,invoke});
 const attest=async input=>{events.push('FULL_ATTEST');if(duringAttest)await duringAttest(input);return verifyCampaignWriterCredential(input,{fetchImpl:async(url,options)=>{assert.equal(url,IDENTITY_URL);assert.equal(options.redirect,'manual');assert.equal(active.has(input.principalId),true);const response=new Response(JSON.stringify({schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',owner:input.owner,allowedPanels:['growth'],permissions:{growth:{who:'panel:'+input.principalId,label:input.owner,caps:invalidIdentity?['read_content']:[...CAPS]},influs:null}}),{status:200,headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:IDENTITY_URL});return response;}});};
 const coordinator=createWriterCoordinator({journal:auth.managedCampaignWriterJournal,client,attest,now:()=>time});
 const invite=(email='manager@synthetic.invalid',area='growth')=>auth.createInvite({context,email,areas:[area],brand:'fish',requestedAccess:'edit'});
 const accept=i=>auth.acceptInvite({token:i.token,password:PASSWORD,host:i.host,origin:'https://'+i.host});
 const manager=async(email='manager@synthetic.invalid')=>{const i=invite(email);await accept(i);return i.userId;};
 const login=async(email='manager@synthetic.invalid')=>{const l=await auth.login({email,password:PASSWORD,host:hosts.growth,origin:'https://'+hosts.growth});return{host:hosts.growth,origin:'https://'+hosts.growth,method:'POST',cookieHeader:l.cookie.split(';')[0],csrf:l.csrf};};
 const operation=id=>db.prepare("SELECT o.operation_id FROM crm_writer_bridge_op_v1 o JOIN crm_writer_bridge_life_v1 l USING(lifecycle_id) WHERE l.user_id=? AND o.kind<>'revoke' ORDER BY o.rowid DESC").get(id)?.operation_id;
 const approval=id=>auth.approveManagedCampaignWriter({context,userId:id});
 const issue=async id=>{approval(id);return coordinator.run(operation(id));};
 const atomic=f=>{db.exec('BEGIN IMMEDIATE');try{const r=f();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const masterBaseline=()=>({user:db.prepare('SELECT * FROM users WHERE id=?').get(master.user.id),grants:db.prepare('SELECT * FROM grants WHERE user_id=? ORDER BY area').all(master.user.id),slots:db.prepare('SELECT * FROM upstream_credentials WHERE user_id=? ORDER BY slot').all(master.user.id)});
 t.after(()=>{auth.close();db.close();fs.rmSync(dir,{recursive:true,force:true});});
 return{config,db,inspect,context,master,masterBaseline,events,client,coordinator,adapter,invite,accept,manager,login,operation,approval,issue,atomic,digest,encrypt,decrypt,get auth(){return auth;},set duringAttest(f){duringAttest=f;},set invalidIdentity(v){invalidIdentity=v;},restart(){auth.close();auth=createAuth(config);},advance(n){time+=n;}};
}
function pending(f,id,table,phase,brand='aristo'){
 if(table==='campaign_draft_operations')f.db.prepare('INSERT INTO campaign_draft_operations VALUES(?,?,?,?,NULL,NULL,?)').run(id,brand,'synthetic_prior_operation',phase,1791000000000);
 else if(table==='crm_campaign_create_v1'){
  f.auth.campaignDeliveryFor(async()=>null);f.auth.campaignCreateFor(async()=>null);
  f.db.prepare(`INSERT INTO crm_campaign_create_v1(user_id,client_key,remote_key,brand,payload_sha256,credential_mac,phase,input_ciphertext,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,'synthetic_client_key','synthetic_remote_key',brand,'a'.repeat(64),'b'.repeat(64),phase,'synthetic_encrypted',1791000000000,1791000000000);
 }else{
  f.auth.campaignDeliveryFor(async()=>null);
  f.db.prepare(`INSERT INTO crm_campaign_delivery_v1(user_id,client_key,remote_key,brand,action,campaign_id,expected_version,payload_sha256,credential_mac,phase,created_at,updated_at) VALUES(?,?,?,?,'agendar',7,?,?,?,?,?,?)`).run(id,'synthetic_client_key','synthetic_remote_key',brand,'a'.repeat(32),'b'.repeat(64),'c'.repeat(64),phase,1791000000000,1791000000000);
 }
}
test('requested edit remains inactive; actual admin approval queues before RPC; FULL proof promotes only owned campaign slot',async t=>{
 const f=await fixture(t),master=f.masterBaseline(),id=await f.manager();
 assert.equal(f.adapter.getSubject(id).writeApproved,false);assert.equal(f.adapter.getSubject(id).canEdit,false);assert.equal(f.auth.managedCampaignWriterJournal.pending().length,0);
 f.db.prepare("INSERT INTO upstream_credentials VALUES(?,'crm-panel-read',?,?,?)").run(id,f.encrypt('synthetic-existing-read'),f.digest('synthetic-existing-read'),1791000000000);const reader=f.db.prepare("SELECT * FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").get(id);
 assert.deepEqual(f.approval(id),{ok:true});assert.equal(f.events.length,0);assert.equal(f.adapter.getSubject(id).writeApproved,true);assert.equal(f.adapter.getSubject(id).canEdit,false);
 assert.deepEqual(await f.coordinator.run(f.operation(id)),{state:'ready'});assert.equal(f.adapter.getSubject(id).canEdit,true);
 assert.ok(f.events.indexOf('commit_writer')<f.events.indexOf('FULL_ATTEST'));
 const slots=f.db.prepare('SELECT slot,encrypted_key FROM upstream_credentials WHERE user_id=?').all(id);assert.deepEqual(slots.map(s=>s.slot).sort(),['crm-panel-read','growth-campaign']);assert.ok(slots.every(s=>s.encrypted_key.startsWith('v1.')));assert.deepEqual(f.db.prepare("SELECT * FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").get(id),reader);assert.equal(f.db.prepare('SELECT phase FROM crm_writer_bridge_op_v1 WHERE operation_id=?').get(f.operation(id)).phase,'promoted');
 assert.equal(f.auth.campaignWriterReady(await f.login()),true);assert.deepEqual(f.masterBaseline(),master);assert.doesNotMatch(JSON.stringify(f.auth.users({context:f.context})),/dcrmw-|encrypted_key|credential_mac|namespaceId|lifecycleId|operationId/);
});
test('master, requested permission and grants API cannot bypass private writer approval; session Origin and CSRF remain required',async t=>{
 const f=await fixture(t),id=await f.manager(),ctx=await f.login();
 assert.throws(()=>f.auth.approveManagedCampaignWriter({context:ctx,userId:id}),e=>e.code==='ADMIN_REQUIRED');
 assert.throws(()=>f.auth.approveManagedCampaignWriter({context:{...f.context,csrf:'forged'},userId:id}),e=>e.code==='CSRF_DENIED');
 assert.throws(()=>f.auth.approveManagedCampaignWriter({context:{...f.context,origin:'https://evil.synthetic.invalid'},userId:id}),e=>e.code==='ORIGIN_DENIED');
 assert.throws(()=>f.approval(f.master.user.id));
 assert.throws(()=>f.auth.setGrants({context:f.context,userId:id,permissions:{growth:{read:true,edit:true}}}),e=>e.code==='EDIT_NOT_READY');
 await assert.rejects(f.auth.installCampaignWriter({context:f.context,userId:id,bearer:'a'.repeat(64),principalId:'dcrmw-'+'b'.repeat(32),expiresAt:1791000001000}),e=>e.code==='EDIT_NOT_READY');
 assert.equal(f.adapter.getSubject(id).writeApproved,false);
});
for(const [table,phase] of [['campaign_draft_operations','uncertain'],['crm_campaign_delivery_v1','confirmed'],['crm_campaign_create_v1','confirmed']])test('historical '+table+' '+phase+' in another brand blocks admission without deleting the reservation',async t=>{
 const f=await fixture(t),id=await f.manager();pending(f,id,table,phase);const before=f.db.prepare('SELECT * FROM '+table).all();
 assert.equal(f.adapter.getSubject(id).hasPendingCampaigns,true);assert.throws(()=>f.approval(id));assert.deepEqual(f.db.prepare('SELECT * FROM '+table).all(),before);assert.equal(f.adapter.getSubject(id).writeApproved,false);assert.equal(f.auth.managedCampaignWriterJournal.pending().length,0);
});
test('legacy campaign slot is preserved and refuses promotion into a managed lifecycle',async t=>{
 const f=await fixture(t),id=await f.manager();f.db.prepare("INSERT INTO upstream_credentials VALUES(?,'growth-campaign',?,?,?)").run(id,f.encrypt('a'.repeat(64)),f.digest('a'.repeat(64)),1791000000000);const before=f.db.prepare('SELECT * FROM upstream_credentials WHERE user_id=?').get(id);
 assert.throws(()=>f.approval(id));assert.deepEqual(f.db.prepare('SELECT * FROM upstream_credentials WHERE user_id=?').get(id),before);
});
test('identity revocation during actual FULL proof stages lifecycle revoke atomically and never exposes editing',async t=>{
 const f=await fixture(t),id=await f.manager();f.approval(id);const op=f.operation(id),old=f.adapter.getSubject(id);f.duringAttest=()=>f.auth.revokeUser({context:f.context,userId:id});
 assert.deepEqual(await f.coordinator.run(op),{state:'revoked'});const now=f.adapter.getSubject(id);assert.equal(now.state,'disabled');assert.equal(now.canEdit,false);assert.equal(now.writeApproved,false);assert.ok(now.version>old.version);assert.equal(f.db.prepare('SELECT count(*) AS n FROM upstream_credentials WHERE user_id=?').get(id).n,0);assert.equal(f.db.prepare("SELECT count(*) AS n FROM crm_writer_bridge_op_v1 WHERE kind='revoke' AND phase='revoked'").get().n,1);
});
test('grant downgrade and durable lifecycle revocation roll back together on SQLite failure',async t=>{
 const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});const before={adm:f.db.prepare('SELECT * FROM crm_writer_auth_admission_v1 WHERE user_id=?').get(id),binding:f.db.prepare('SELECT * FROM crm_writer_auth_binding_v1 WHERE user_id=?').get(id),slot:f.db.prepare('SELECT * FROM upstream_credentials WHERE user_id=?').get(id)};
 f.db.exec("CREATE TRIGGER synthetic_downgrade_abort BEFORE DELETE ON access_requests BEGIN SELECT RAISE(ABORT,'SYNTHETIC_ABORT'); END");
 assert.throws(()=>f.auth.setRequestedAccess({context:f.context,userId:id,requestedAccess:'read'}));
 assert.equal(f.adapter.getSubject(id).canEdit,true);assert.deepEqual(f.db.prepare('SELECT * FROM crm_writer_auth_admission_v1 WHERE user_id=?').get(id),before.adm);assert.deepEqual(f.db.prepare('SELECT * FROM crm_writer_auth_binding_v1 WHERE user_id=?').get(id),before.binding);assert.deepEqual(f.db.prepare('SELECT * FROM upstream_credentials WHERE user_id=?').get(id),before.slot);assert.equal(f.db.prepare("SELECT count(*) AS n FROM crm_writer_bridge_op_v1 WHERE kind='revoke'").get().n,0);
 f.db.exec('DROP TRIGGER synthetic_downgrade_abort');f.auth.setRequestedAccess({context:f.context,userId:id,requestedAccess:'read'});assert.equal(f.adapter.getSubject(id).canEdit,false);assert.equal(f.adapter.getSubject(id).writeApproved,false);assert.equal(f.db.prepare("SELECT count(*) AS n FROM crm_writer_bridge_op_v1 WHERE kind='revoke' AND phase='revoke_pending'").get().n,1);
});
test('SQLite failure after slot and attestation mutations rolls back the complete promotion; retry obtains a fresh FULL proof',async t=>{
 const f=await fixture(t),id=await f.manager();f.approval(id);const op=f.operation(id);f.db.exec("CREATE TRIGGER synthetic_promote_abort BEFORE UPDATE OF can_edit ON grants WHEN NEW.can_edit=1 BEGIN SELECT RAISE(ABORT,'SYNTHETIC_ABORT'); END");
 assert.deepEqual(await f.coordinator.run(op),{state:'pending'});assert.equal(f.adapter.getSubject(id).canEdit,false);assert.equal(f.db.prepare('SELECT count(*) AS n FROM upstream_credentials WHERE user_id=?').get(id).n,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM campaign_writer_attestation_v1 WHERE user_id=?').get(id).n,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM crm_writer_auth_binding_v1 WHERE user_id=?').get(id).n,0);assert.equal(f.db.prepare('SELECT phase FROM crm_writer_bridge_op_v1 WHERE operation_id=?').get(op).phase,'attested');
 const calls=f.events.filter(e=>e==='FULL_ATTEST').length;f.db.exec('DROP TRIGGER synthetic_promote_abort');assert.deepEqual(await f.coordinator.run(op),{state:'ready'});assert.equal(f.events.filter(e=>e==='FULL_ATTEST').length,calls+1);
});
test('another user owning the candidate MAC prevents ready and preserves their credential',async t=>{
 const f=await fixture(t),id=await f.manager(),other=await f.manager('other@synthetic.invalid');f.approval(id);const op=f.operation(id),candidate=f.db.prepare('SELECT bearer_mac FROM crm_writer_bridge_op_v1 WHERE operation_id=?').get(op);
 f.db.prepare("INSERT INTO upstream_credentials VALUES(?,'growth-read',?,?,?)").run(other,f.encrypt('synthetic-other-key'),candidate.bearer_mac,1791000000000);const before=f.db.prepare('SELECT * FROM upstream_credentials WHERE user_id=?').get(other);
 assert.deepEqual(await f.coordinator.run(op),{state:'pending'});assert.equal(f.adapter.getSubject(id).canEdit,false);assert.deepEqual(f.db.prepare('SELECT * FROM upstream_credentials WHERE user_id=?').get(other),before);
});
test('new reservation between COMMIT and FULL proof refuses local promotion and keeps both intents for reconciliation',async t=>{
 const f=await fixture(t),id=await f.manager();f.approval(id);f.duringAttest=()=>pending(f,id,'crm_campaign_create_v1','confirmed');
 assert.deepEqual(await f.coordinator.run(f.operation(id)),{state:'pending'});assert.equal(f.adapter.getSubject(id).canEdit,false);assert.equal(f.db.prepare('SELECT phase FROM crm_campaign_create_v1 WHERE user_id=?').get(id).phase,'confirmed');assert.equal(f.db.prepare('SELECT phase FROM crm_writer_bridge_op_v1 WHERE operation_id=?').get(f.operation(id)).phase,'attested');
});
test('reinvite gets a monotonic version and new lifecycle; old revoke replay does not remove new writer',async t=>{
 const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});const old=f.adapter.getSubject(id);f.auth.revokeUser({context:f.context,userId:id});const revoke=f.db.prepare("SELECT operation_id FROM crm_writer_bridge_op_v1 WHERE kind='revoke'").get().operation_id;assert.deepEqual(await f.coordinator.run(revoke),{state:'revoked'});
 const invite=f.invite();assert.equal(invite.userId,id);await f.accept(invite);const next=f.adapter.getSubject(id);assert.notEqual(next.lifecycleId,old.lifecycleId);assert.ok(next.version>old.version);assert.deepEqual(await f.issue(id),{state:'ready'});const before=f.db.prepare('SELECT * FROM upstream_credentials WHERE user_id=?').get(id);assert.deepEqual(await f.coordinator.run(revoke),{state:'revoked'});assert.deepEqual(f.db.prepare('SELECT * FROM upstream_credentials WHERE user_id=?').get(id),before);assert.equal(f.adapter.getSubject(id).canEdit,true);
});
test('quiescence refuses every unresolved campaign brand; exact old binding rotates only after reservations close',async t=>{
 const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});pending(f,id,'campaign_draft_operations','pending');assert.throws(()=>f.atomic(()=>f.adapter.quiesce(id)));assert.equal(f.adapter.getSubject(id).canEdit,true);
 f.db.prepare("UPDATE campaign_draft_operations SET phase='rejected' WHERE user_id=?").run(id);f.atomic(()=>f.adapter.quiesce(id));const request=f.auth.managedCampaignWriterJournal.enqueue(id,'renew');assert.deepEqual(await f.coordinator.run(request.operationId),{state:'ready'});assert.equal(f.db.prepare('SELECT generation FROM crm_writer_auth_binding_v1 WHERE user_id=?').get(id).generation,2);assert.equal(f.adapter.getSubject(id).canEdit,true);
});
test('local binding ciphertext corruption refuse writer authorization without mutating master',async t=>{
 const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});const ctx=await f.login(),master=f.masterBaseline();assert.equal(f.auth.campaignWriterReady(ctx),true);
 f.db.prepare("UPDATE upstream_credentials SET encrypted_key='synthetic_corrupt' WHERE user_id=? AND slot='growth-campaign'").run(id);assert.equal(f.auth.campaignWriterReady(ctx),false);assert.throws(()=>f.auth.campaignWriterAuthorization(ctx,{brand:'fish',action:'agendar'}));assert.deepEqual(f.masterBaseline(),master);
});
test('configuration remains synthetic only; default auth creates no writer adapter schema or API',()=>{
 const base={dbPath:':memory:',managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'master@synthetic.invalid',bootstrapTokenSha256:sha('synthetic-bootstrap'),encryptionKey:crypto.randomBytes(32)};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'writer-auth-default-')),dbPath=path.join(dir,'identity.sqlite'),auth=createAuth({...base,dbPath});try{assert.equal(Object.hasOwn(auth,'approveManagedCampaignWriter'),false);assert.equal(Object.hasOwn(auth,'managedCampaignWriterJournal'),false);const d=new DatabaseSync(dbPath);try{assert.deepEqual(d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'crm_writer_%'").all(),[]);}finally{d.close();}}finally{auth.close();fs.rmSync(dir,{recursive:true,force:true});}
 assert.throws(()=>createAuth({...base,crmManagedWriter:{issuerId:crypto.randomUUID(),namespaceId:crypto.randomUUID()}}),e=>e.code==='MANAGED_WRITER_CONFIG_INVALID');
 assert.throws(()=>createAuth({...base,allowedEmailDomains:['oaristocrata.com'],bootstrapAdminEmail:'master@oaristocrata.com',crmCampaignSubmitWrite:true,crmManagedWriter:{issuerId:crypto.randomUUID(),namespaceId:crypto.randomUUID()}}),e=>e.code==='CAMPAIGN_WRITE_CONFIG_INVALID');
});
test('failed FULL identity can be reapproved only after the old lifecycle revoke is confirmed; reapproval allocates a new version and lifecycle',async t=>{
 const f=await fixture(t),id=await f.manager(),before=f.adapter.getSubject(id);f.invalidIdentity=true;assert.deepEqual(await f.issue(id),{state:'revoked'});const retired=f.adapter.getSubject(id);assert.equal(retired.canEdit,false);assert.equal(f.db.prepare("SELECT state FROM crm_writer_bridge_life_v1 WHERE lifecycle_id=?").get(retired.lifecycleId).state,'revoked');
 f.invalidIdentity=false;assert.deepEqual(await f.issue(id),{state:'ready'});const next=f.adapter.getSubject(id);assert.notEqual(next.lifecycleId,retired.lifecycleId);assert.ok(next.version>retired.version);assert.ok(next.version>before.version);
});
test('real HTTP handler downgrade writes the revoke outbox before response without opening a socket',async t=>{
 const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});
 const {Readable}=require('node:stream'),{EventEmitter}=require('node:events'),{createServer}=require(ROOT+'/services/dashboard-operational/server.cjs');
 const server=createServer({mode:'preview',managerHost:hosts.manager,areaHosts:f.config.areaHosts,publicDir:ROOT+'/services/dashboard-operational/public'},{auth:f.auth,fetchImpl:()=>{throw Error('NO_UPSTREAM_EXPECTED');}});
 const reply=await new Promise(resolve=>{
  const req=Readable.from([Buffer.from(JSON.stringify({action:'access_request',userId:id,requestedAccess:'read'}))],{objectMode:false});
  Object.assign(req,{url:'/auth/users',method:'POST',headers:{host:hosts.manager,origin:f.context.origin,cookie:f.context.cookieHeader,'x-csrf-token':f.context.csrf,'content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'}});
  const res=new EventEmitter();res.setHeader=()=>{};res.end=body=>{const revokeCommitted=f.db.prepare("SELECT count(*) AS n FROM crm_writer_bridge_op_v1 WHERE kind='revoke' AND phase='revoke_pending'").get().n;res.emit('finish');resolve({status:res.statusCode,body:String(body),revokeCommitted});};
  server.emit('request',req,res);
 });
 server.removeAllListeners('request');assert.equal(reply.revokeCommitted,1);
 assert.equal(reply.status,200);assert.deepEqual(JSON.parse(reply.body),{ok:true,requestedAccess:'read'});assert.equal(f.adapter.getSubject(id).canEdit,false);assert.equal(f.adapter.getSubject(id).writeApproved,false);assert.equal(f.db.prepare("SELECT count(*) AS n FROM crm_writer_bridge_op_v1 WHERE kind='revoke' AND phase='revoke_pending'").get().n,1);assert.doesNotMatch(reply.body,/dcrmw-|encrypted|credential|namespace|lifecycle|operationId/);
});
test('identity restart preserves the owned writer binding; expiry refuses authorization after a fresh login',async t=>{
 const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});const before=f.db.prepare('SELECT * FROM crm_writer_auth_admission_v1 WHERE user_id=?').get(id);
 f.restart();assert.equal(f.auth.campaignWriterReady(await f.login()),true);assert.deepEqual(f.db.prepare('SELECT * FROM crm_writer_auth_admission_v1 WHERE user_id=?').get(id),before);
 f.advance(1209600001);const ctx=await f.login();assert.equal(f.auth.campaignWriterReady(ctx),false);assert.throws(()=>f.auth.campaignWriterAuthorization(ctx,{brand:'fish',action:'agendar'}),e=>e.code==='CREDENTIAL_ATTESTATION_REQUIRED');
});
test('changing a writer area is denied without mutation; explicit revocation still stages its exact outbox',async t=>{
 const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});
 const state=()=>({subject:f.adapter.getSubject(id),slots:f.db.prepare('SELECT * FROM upstream_credentials WHERE user_id=?').all(id),grants:f.db.prepare('SELECT * FROM grants WHERE user_id=?').all(id),outbox:f.db.prepare('SELECT * FROM crm_writer_bridge_op_v1 ORDER BY operation_id').all(),scope:f.db.prepare('SELECT * FROM user_brand_grants_v1 WHERE user_id=?').get(id)}),before=state(),master=f.masterBaseline();
 assert.throws(()=>f.auth.setGrants({context:f.context,userId:id,permissions:{organico:{read:true,edit:false}}}),e=>e.code==='AREA_CHANGE_REQUIRES_REINVITE');
 assert.deepEqual(state(),before);assert.equal(f.adapter.getSubject(id).canEdit,true);assert.equal(f.db.prepare("SELECT count(*) AS n FROM crm_writer_bridge_op_v1 WHERE kind='revoke'").get().n,0);
 // Revocation is a separate explicit action; changing area never silently
 // closes a working writer or authorizes the new area's credentials.
 f.auth.revokeUser({context:f.context,userId:id});assert.equal(f.adapter.getSubject(id).state,'disabled');assert.equal(f.adapter.getSubject(id).canEdit,false);assert.equal(f.db.prepare("SELECT count(*) AS n FROM upstream_credentials WHERE user_id=? AND slot='growth-campaign'").get(id).n,0);
 const revoke=f.db.prepare("SELECT operation_id FROM crm_writer_bridge_op_v1 WHERE kind='revoke' AND phase='revoke_pending'").get().operation_id;assert.deepEqual(await f.coordinator.run(revoke),{state:'revoked'});assert.throws(()=>f.approval(id));
 assert.throws(()=>f.invite('manager@synthetic.invalid','organico'),e=>e.code==='BRAND_CHANGE_REQUIRES_NEW_IDENTITY');assert.deepEqual(f.db.prepare('SELECT area,can_read,can_edit FROM grants WHERE user_id=?').all(id).map(r=>({...r})),[{area:'growth',can_read:1,can_edit:0}]);assert.deepEqual(f.masterBaseline(),master);
});
test('public writer readiness requires the exact promoted generation and principal in the durable journal',async t=>{
 const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});const ctx=await f.login();assert.equal(f.auth.campaignWriterReady(ctx),true);
 f.db.prepare('UPDATE crm_writer_auth_binding_v1 SET generation=2 WHERE user_id=?').run(id);assert.equal(f.auth.campaignWriterReady(ctx),false);assert.throws(()=>f.auth.campaignWriterAuthorization(ctx,{brand:'fish',action:'agendar'}),e=>e.code==='CREDENTIAL_ATTESTATION_REQUIRED');
 f.db.prepare('UPDATE crm_writer_auth_binding_v1 SET generation=1 WHERE user_id=?').run(id);assert.equal(f.auth.campaignWriterReady(ctx),true);f.db.prepare("UPDATE crm_writer_bridge_op_v1 SET phase='attested' WHERE operation_id=?").run(f.operation(id));assert.equal(f.auth.campaignWriterReady(ctx),false);assert.throws(()=>f.auth.campaignWriterAuthorization(ctx,{brand:'fish',action:'agendar'}),e=>e.code==='CREDENTIAL_ATTESTATION_REQUIRED');
});
