'use strict';
// Synthetic identities in temporary SQLite only. Real auth, session/CSRF,
// encrypted READ journal and WRITER queue; no provider, socket or environment.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const REPOSITORY=path.resolve(__dirname,'..');
const SOURCE=path.join(REPOSITORY,'services/dashboard-operational');
const CANDIDATE=SOURCE;
const BASE_REVISION='c3f0ac329d04903078fc0a558ed89aa9f50696c9';
const {execFileSync}=require('node:child_process');
const BASE_PINS={
 'auth.cjs':'cdec138777a749e39d6318d799b8d704900450ba6ad3e0798d2642c3f79ac0d4',
 'crm-manager-journal.cjs':'8c233aca65b834086e8562a40cb53f0e30314a0fc3f9c1bba70faffc20296f07'
};
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const ORIGINAL=Object.fromEntries(Object.entries(BASE_PINS).map(([name,pin])=>{
 let bytes;try{bytes=execFileSync('git',['-C',REPOSITORY,'show',BASE_REVISION+':services/dashboard-operational/'+name],{stdio:['ignore','pipe','pipe'],maxBuffer:2*1024*1024});}catch{throw Error('ENROLLMENT_FROZEN_SOURCE_UNAVAILABLE');}
 if(sha(bytes)!==pin)throw Error('ENROLLMENT_FROZEN_SOURCE_CHANGED');return [name,bytes];
}));
const hosts={manager:'gerencial.shrigma.com.br',growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'};
const bootstrap='synthetic-enrollment-bootstrap-never-production';
const origin=h=>'https://'+h,cookie=login=>login.cookie.split(';')[0];
const owner='felipebandeira@oaristocrata.com',manager='synthetic-enrollment@fishermans.com.br';
async function fixture(t,{baseline=false,profile='read'}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crm-active-enrollment-')),runtime=path.join(dir,'runtime');fs.mkdirSync(runtime);
 let auth,db;t.after(()=>{try{auth?.close();}catch{}try{db?.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});
 for(const [name,pin]of Object.entries(BASE_PINS))assert.equal(sha(ORIGINAL[name]),pin,'frozen source remains byte exact');
 for(const entry of fs.readdirSync(SOURCE,{withFileTypes:true}))if(entry.isFile()&&/\.(cjs|js)$/.test(entry.name)&&!entry.name.endsWith('.test.cjs'))fs.copyFileSync(path.join(SOURCE,entry.name),path.join(runtime,entry.name));
 if(baseline)for(const name of Object.keys(BASE_PINS))fs.writeFileSync(path.join(runtime,name),ORIGINAL[name],{flag:'w'});
 const {createAuth,AuthError}=require(path.join(runtime,'auth.cjs'));
 let clock=Date.UTC(2026,9,6,12,0,0);
 const config={dbPath:path.join(dir,'identity.sqlite'),managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},allowedEmailDomains:['oaristocrata.com','shrigma.com.br','fishermans.com.br'],bootstrapAdminEmail:owner,bootstrapTokenSha256:sha(bootstrap),encryptionKey:Buffer.alloc(32,19),now:()=>clock};
 auth=createAuth(config);
 const boot={email:owner,token:bootstrap,host:hosts.manager,origin:origin(hosts.manager)};
 auth.beginBootstrap(boot);await auth.completeBootstrap({...boot,password:'synthetic-owner-password-enrollment'});
 const adminLogin=await auth.login({email:owner,password:'synthetic-owner-password-enrollment',host:hosts.manager,origin:origin(hosts.manager),ip:'192.0.2.1'});
 const context={cookieHeader:cookie(adminLogin),host:hosts.manager,origin:origin(hosts.manager),method:'POST',csrf:adminLogin.csrf};
 const invitation=auth.createInvite({context,email:manager,areas:['growth'],permissions:{growth:{read:true,edit:false}},brand:'fish'});
 await auth.acceptInvite({token:invitation.token,password:'synthetic-manager-password-enrollment',host:hosts.growth,origin:origin(hosts.growth)});
 const managerLogin=await auth.login({email:manager,password:'synthetic-manager-password-enrollment',host:hosts.growth,origin:origin(hosts.growth),ip:'192.0.2.2'});
 const read={issuerId:crypto.randomUUID(),namespaceId:crypto.randomUUID()};
 const managed=profile==='none'?{}:profile==='own'?{crmCampaignWriterProfile:'own-master-production-v1',crmCampaignSubmitWrite:true}:{crmManagedRead:read,...(profile==='corporate'?{crmManagedWriter:{mode:'corporate-read-writer-v1',issuerId:crypto.randomUUID(),namespaceId:crypto.randomUUID()},crmCampaignSubmitWrite:true}:{})};
 auth.close();auth=createAuth({...config,...managed});
 db=new DatabaseSync(config.dbPath);db.exec('PRAGMA foreign_keys=ON');
 // Opaque test markers represent protected history; this never reads a real
 // consumed marker or constructs a production proof/MAC/actor.
 db.prepare('INSERT INTO identity_metadata VALUES(?,?)').run('synthetic_consumed_832f','synthetic-opaque-original');
 db.prepare('INSERT INTO identity_metadata VALUES(?,?)').run('synthetic_consumed_73a','synthetic-opaque-master');
 const userId=invitation.userId;
 return {db,config,read,context,userId,AuthError,managerLogin,get auth(){return auth;},get clock(){return clock;},
  user:()=>auth.users({context}).find(u=>u.id===userId),
  request:access=>auth.setRequestedAccess({context,userId,requestedAccess:access}),
  restart(){auth.close();auth=createAuth({...config,...managed});},
  stable(){return {
   user:db.prepare('SELECT id,email,role,state,password_hash,totp_secret,totp_last_step,created_at FROM users WHERE id=?').get(userId),
   sessions:db.prepare('SELECT * FROM sessions WHERE user_id=? ORDER BY token_hash').all(userId),
   grants:db.prepare('SELECT * FROM grants WHERE user_id=? ORDER BY area').all(userId),
   brand:db.prepare('SELECT * FROM user_brand_grants_v1 WHERE user_id=?').get(userId),
   credentials:db.prepare('SELECT * FROM upstream_credentials ORDER BY user_id,slot').all(),
   markers:db.prepare('SELECT * FROM identity_metadata ORDER BY key').all()
  };}
 };
}
const count=(f,table)=>f.db.prepare('SELECT count(*) AS n FROM '+table).get().n;
const noAccess=f=>{assert.equal(f.auth.managedCrmJournal.credentialReady(f.userId),false);assert.equal(f.user().permissions.growth.edit,false);assert.equal(count(f,'upstream_credentials'),0);};
function completeSyntheticRead(f){
 const j=f.auth.managedCrmJournal,op=j.pendingOperations(8)[0],q=j.request(op),time=f.clock;
 const p={schema:'crm-manager-provision-receipt-v1',issuerId:f.read.issuerId,namespaceId:f.read.namespaceId,operationId:op,action:'prepare_read',userId:q.userId,lifecycleId:q.lifecycleId,owner:q.owner,state:'prepared',principalId:q.principalId,generation:q.generation,expectedGeneration:q.expectedGeneration,area:'growth',slot:'crm-panel-read',role:'manager',caps:['read_content','list_history','submission'],issuedAt:time,candidateExpiresAt:time+600000,expiresAt:time+14*86400000};
 j.recordPrepared(op,p);j.recordAttestation(op,{owner:p.owner,principalId:p.principalId,caps:p.caps});
 const commit=j.beginCommit(op);j.recordCommitted(op,{...p,action:'commit_read',state:'committed',operationId:commit.args.operationId,prepareOperationId:op,committedAt:time,revokedGeneration:null});j.promote(op);
 return op;
}
test('frozen c3f reproduces missing active READ enrollment and premature WRITER request',async t=>{
 const f=await fixture(t,{baseline:true,profile:'corporate'});
 assert.equal(f.auth.managedCrmJournal.status(f.userId),null);
 f.request('read');assert.equal(count(f,'crm_manager_lifecycles_v1'),0);
 assert.throws(()=>f.request('edit'),e=>e instanceof f.AuthError&&e.code==='MANAGED_WRITER_STORE_UNAVAILABLE');
 assert.equal(count(f,'crm_manager_operations_v1'),0);
});
test('Master READ selection enrolls active signed-brand account once without replacing password/session/data',async t=>{
 const f=await fixture(t),before=f.stable();
 assert.deepEqual(f.request('read'),{ok:true,requestedAccess:'read'});
 assert.deepEqual(f.stable(),before);noAccess(f);
 assert.equal(f.user().brand,'fish');assert.equal(f.user().brandAccess,'single');
 assert.equal(f.user().crmAccess.state,'provisioning');assert.equal(f.user().crmAccess.ready,false);
 const rows=f.db.prepare('SELECT * FROM crm_manager_operations_v1').all();assert.equal(rows.length,1);assert.equal(rows[0].phase,'queued');
 assert.match(rows[0].candidate_ciphertext,/^v1\./);assert.equal(rows[0].generation,1);assert.equal(rows[0].expected_generation,0);
 const life=f.db.prepare('SELECT * FROM crm_manager_lifecycles_v1').get();assert.equal(life.version,2);assert.equal(life.active_generation,0);
 f.request('read');f.restart();f.request('read');assert.deepEqual(f.db.prepare('SELECT * FROM crm_manager_operations_v1').all(),rows);assert.deepEqual(f.stable(),before);
 assert.equal(f.auth.session({cookieHeader:cookie(f.managerLogin),host:hosts.growth}).authenticated,true);
 assert.equal(count(f,'user_brand_lifecycles_v1'),1);
});
test('same-profile update uses existing action and optimistic revision for active enrollment',async t=>{
 const f=await fixture(t),before=f.stable(),u=f.user();
 assert.throws(()=>f.auth.updateUserProfile({context:f.context,userId:f.userId,expectedRevision:'0'.repeat(64),email:manager,area:'growth',brand:'fish',access:'read'}),e=>e.code==='USER_CHANGED');
 assert.equal(count(f,'crm_manager_lifecycles_v1'),0);
 const r=f.auth.updateUserProfile({context:f.context,userId:f.userId,expectedRevision:u.profileRevision,email:manager,area:'growth',brand:'fish',access:'read'});
 assert.equal(r.state,'configured');assert.deepEqual(f.stable(),before);noAccess(f);
 assert.equal(f.user().crmAccess.state,'provisioning');
});
test('EDIT intent remains signed pending; WRITER queue waits for complete existing READ proofs',async t=>{
 const f=await fixture(t,{profile:'corporate'}),before=f.stable();
 assert.deepEqual(f.request('edit'),{ok:true,requestedAccess:'edit'});assert.deepEqual(f.stable(),before);noAccess(f);
 assert.equal(f.user().requestedAccess,'edit');assert.equal(count(f,'crm_writer_request_authority_v1'),1);
 assert.equal(f.auth.managedCampaignWriterJournal.pending(8).length,0);
 assert.deepEqual(f.auth.fulfillManagedCampaignWriterRequests(),{queued:0});
 assert.throws(()=>f.auth.managedCrmJournal.promote(f.auth.managedCrmJournal.pendingOperations(8)[0]),/PROMOTION_DENIED/);
 completeSyntheticRead(f);assert.equal(f.auth.managedCrmJournal.credentialReady(f.userId),true);
 assert.deepEqual(f.auth.fulfillManagedCampaignWriterRequests(),{queued:1});assert.deepEqual(f.auth.fulfillManagedCampaignWriterRequests(),{queued:0});
 assert.equal(f.auth.managedCampaignWriterJournal.pending(8).length,1);
 assert.equal(f.user().permissions.growth.edit,false);assert.equal(f.db.prepare("SELECT count(*) n FROM upstream_credentials WHERE slot='growth-campaign'").get().n,0);
 assert.equal(f.auth.session({cookieHeader:cookie(f.managerLogin),host:hosts.growth}).authenticated,true);
});
test('Master host/origin/method/CSRF and signed brand remain mandatory before enrollment',async t=>{
 const f=await fixture(t),before=f.stable();
 const bad=[{...f.context,csrf:'bad'},{...f.context,origin:origin(hosts.growth)},{...f.context,host:hosts.growth,origin:origin(hosts.growth)},{...f.context,method:'GET'},{cookieHeader:cookie(f.managerLogin),host:hosts.growth,origin:origin(hosts.growth),method:'POST',csrf:f.managerLogin.csrf}];
 for(const context of bad)assert.throws(()=>f.auth.setRequestedAccess({context,userId:f.userId,requestedAccess:'read'}),e=>e instanceof f.AuthError&&[401,403,405].includes(e.status));
 assert.equal(count(f,'crm_manager_lifecycles_v1'),0);assert.deepEqual(f.stable(),before);
 f.db.prepare('UPDATE user_brand_grants_v1 SET scope_mac=? WHERE user_id=?').run('0'.repeat(64),f.userId);
 assert.throws(()=>f.request('read'),e=>e.code==='BRAND_REPROVISION_REQUIRED');assert.equal(count(f,'crm_manager_operations_v1'),0);
});
test('manual key and unresolved business operation refuse enrollment without partial rows',async t=>{
 const f=await fixture(t),before=f.stable();
 f.db.prepare('INSERT INTO upstream_credentials VALUES(?,?,?,?,?)').run(f.userId,'growth-read','synthetic-opaque-manual','synthetic-digest',f.clock);
 assert.throws(()=>f.request('read'),e=>e.code==='CRM_ENROLLMENT_CREDENTIAL_REVOCATION_REQUIRED');assert.equal(count(f,'crm_manager_lifecycles_v1'),0);
 assert.equal(count(f,'upstream_credentials'),1);f.db.prepare('DELETE FROM upstream_credentials WHERE user_id=?').run(f.userId);
 f.db.prepare("INSERT INTO campaign_draft_operations(user_id,brand,operation_key,phase,updated_at) VALUES(?,'fish','synthetic-pending','uncertain',?)").run(f.userId,f.clock);
 assert.throws(()=>f.request('edit'),e=>e.code==='CAMPAIGN_RECONCILIATION_REQUIRED');assert.equal(count(f,'crm_manager_operations_v1'),0);
 f.db.prepare('DELETE FROM campaign_draft_operations WHERE user_id=?').run(f.userId);assert.deepEqual(f.stable(),before);
 f.db.exec("CREATE TRIGGER synthetic_brand_failure BEFORE INSERT ON user_brand_lifecycles_v1 BEGIN SELECT RAISE(ABORT,'SYNTHETIC_BINDING_FAILURE'); END");
 assert.throws(()=>f.request('read'));assert.equal(count(f,'crm_manager_lifecycles_v1'),0);assert.equal(count(f,'crm_manager_current_v1'),0);assert.equal(count(f,'crm_manager_operations_v1'),0);assert.deepEqual(f.stable(),before);
});
test('own-Master or absent READ integration preserves intent without enrolling or enabling credentials',async t=>{
 for(const profile of ['none','own']){
  const f=await fixture(t,{profile}),before=f.stable();f.request('edit');assert.deepEqual(f.stable(),before);
  assert.equal(f.auth.managedCrmJournal,undefined);assert.equal(f.user().permissions.growth.edit,false);
  assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='crm_manager_lifecycles_v1'").get().n,0);
  if(profile==='own'){assert.equal(f.user().crmAccess.operational,false);assert.equal(f.user().crmAccess.reason,'INDIVIDUAL_ACCESS_NOT_READY');}
 }
});
test('real auth revocation closes enrolled account immediately and never reenrolls its consumed lifecycle',async t=>{
 const f=await fixture(t);f.request('read');
 const original=f.db.prepare('SELECT * FROM crm_manager_operations_v1').get(),markers=f.stable().markers;
 const result=f.auth.revokeUser({context:f.context,userId:f.userId});assert.equal(result.ok,true);
 assert.equal(f.user().status,'disabled');assert.equal(f.db.prepare('SELECT password_hash FROM users WHERE id=?').get(f.userId).password_hash,null);
 assert.equal(f.auth.session({cookieHeader:cookie(f.managerLogin),host:hosts.growth}).authenticated,false);
 assert.equal(f.auth.managedCrmJournal.status(f.userId).state,'revoking');assert.equal(count(f,'crm_manager_lifecycles_v1'),1);
 assert.throws(()=>f.request('read'),e=>e.code==='USER_DENIED');assert.equal(count(f,'crm_manager_operations_v1'),2);
 assert.equal(f.auth.managedCrmJournal.pendingOperations(8).length,1);
 assert.equal(f.db.prepare('SELECT candidate_ciphertext FROM crm_manager_operations_v1 WHERE operation_id=?').get(original.operation_id).candidate_ciphertext,original.candidate_ciphertext);
 assert.deepEqual(f.stable().markers,markers);assert.equal(count(f,'upstream_credentials'),0);
});
test('journal enrollment requires its identity transaction, active exclusive READ and no history/rearm',t=>{
 const {createManagerJournal}=require(path.join(CANDIDATE,'crm-manager-journal.cjs'));
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,role TEXT,state TEXT);CREATE TABLE grants(user_id TEXT,area TEXT,can_read INTEGER,can_edit INTEGER);CREATE TABLE upstream_credentials(user_id TEXT,slot TEXT,encrypted_key TEXT,key_digest TEXT,updated_at INTEGER,PRIMARY KEY(user_id,slot));');
 const key=Buffer.alloc(32,31),encrypt=value=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),raw=Buffer.concat([c.update(value),c.final()]);return ['v1',iv.toString('base64url'),c.getAuthTag().toString('base64url'),raw.toString('base64url')].join('.');};
 const j=createManagerJournal({db,issuerId:crypto.randomUUID(),namespaceId:crypto.randomUUID(),encrypt,decrypt:()=>{throw Error('NOT_USED');},digest:v=>crypto.createHmac('sha256',key).update(v).digest('hex'),now:()=>1791288000000});
 const add=(state='active',role='manager',area='growth',edit=0)=>{const id=crypto.randomUUID();db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id,id+'@synthetic.invalid',role,state);db.prepare('INSERT INTO grants VALUES(?,?,1,?)').run(id,area,edit);return id;};
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const id=add();assert.throws(()=>j.enrollActiveLifecycle(id),/TRANSACTION_REQUIRED/);assert.throws(()=>tx(()=>j.createLifecycle(id)),/MANAGER_DENIED/);
 for(const denied of [add('invited'),add('active','superadmin'),add('active','manager','influs'),add('active','manager','growth',1)])assert.throws(()=>tx(()=>j.enrollActiveLifecycle(denied)),/MANAGER_DENIED/);
 const r=tx(()=>j.enrollActiveLifecycle(id));assert.equal(j.status(id).state,'provisioning');assert.throws(()=>tx(()=>j.enrollActiveLifecycle(id)),/LIFECYCLE_CHANGED/);
 tx(()=>j.stageRevoke(id));assert.throws(()=>tx(()=>j.enrollActiveLifecycle(id)),/LIFECYCLE_CHANGED/);
 const history=add();db.prepare("INSERT INTO crm_manager_lifecycles_v1(lifecycle_id,user_id,owner,version,state,updated_at) VALUES(?,?,?,1,'revoked',1)").run(crypto.randomUUID(),history,history+'@synthetic.invalid');assert.throws(()=>tx(()=>j.enrollActiveLifecycle(history)),/LIFECYCLE_CHANGED/);
 assert.equal(db.prepare('SELECT count(*) n FROM crm_manager_operations_v1 WHERE lifecycle_id=?').get(r.lifecycleId).n,2);assert.equal(j.credentialReady(id),false);
});
