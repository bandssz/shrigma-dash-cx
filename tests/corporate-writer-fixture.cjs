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
const CAPS=['read_content','draft','validate','submit'],hosts={manager:'gerencial.shrigma.com.br',growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'};
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const PASSWORD='Synthetic writer manager password 2026!';
async function fixture(t,fixtureHosts){
 const hosts=fixtureHosts||module.exports.hosts;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'writer-auth-hook-')),dbPath=path.join(dir,'identity.sqlite'),key=crypto.randomBytes(32),issuerId=crypto.randomUUID(),namespaceId=crypto.randomUUID();let time=1791000000000;
 const config={dbPath,managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},allowedEmailDomains:['oaristocrata.com'],bootstrapAdminEmail:'felipebandeira@oaristocrata.com',bootstrapTokenSha256:sha('synthetic-bootstrap'),encryptionKey:key,now:()=>time,crmCampaignSubmitWrite:true,crmManagedRead:{issuerId:crypto.randomUUID(),namespaceId:crypto.randomUUID()},crmManagedWriter:{mode:'corporate-read-writer-v1',issuerId,namespaceId}};
 let auth=createAuth(config);
 await auth.completeBootstrap({email:config.bootstrapAdminEmail,token:'synthetic-bootstrap',password:PASSWORD,host:hosts.manager,origin:'https://'+hosts.manager});
 const master=await auth.login({email:config.bootstrapAdminEmail,password:PASSWORD,host:hosts.manager,origin:'https://'+hosts.manager});
 const context={host:hosts.manager,method:'POST',origin:'https://'+hosts.manager,cookieHeader:master.cookie.split(';')[0],csrf:master.csrf};
 const db=new DatabaseSync(dbPath);db.exec('PRAGMA foreign_keys=ON');
 const inspect=f=>f(db),events=[],store=new Map(),active=new Set();let duringAttest=null,invalidIdentity=false;
 const digest=v=>crypto.createHmac('sha256',key).update('upstream-key:'+v).digest('hex');
 const encrypt=v=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),out=Buffer.concat([c.update(v,'utf8'),c.final()]);return ['v1',iv.toString('base64url'),c.getAuthTag().toString('base64url'),out.toString('base64url')].join('.');};
 const decrypt=v=>{const[,iv,tag,data]=v.split('.'),c=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));c.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([c.update(Buffer.from(data,'base64url')),c.final()]).toString('utf8');};
 const adapter=createWriterAuthAdapter({db,enabled:true,profile:'corporate-read-writer-v1',readReady:id=>auth.managedCrmJournal.credentialReady(id)===true,issuerId,namespaceId,allowedEmailDomains:['oaristocrata.com'],encrypt,decrypt,digest,now:()=>time});
 async function invoke({procedure,parameters}){
  assert.equal(db.isTransaction,false);assert.equal(parameters.length,1);const q=JSON.parse(parameters[0]);assert.equal(Object.hasOwn(q,'bearer'),false);assert.ok(/^public\.crm_manager_writer_(prepare|commit|revoke|status)_v1$/.test(procedure));events.push(q.action);
  if(q.action==='writer_status'){const r=store.get(q.operationId);return{schema:'crm-manager-writer-status-v1',issuerId,namespaceId,operationId:q.operationId,found:!!r,...(r?{receipt:r}:{})};}
  const old=store.get(q.operationId);if(old){assert.equal(old.requestSha256,sha(canonical(q)));return old;}
  const base={schema:'crm-manager-writer-receipt-v1',issuerId,namespaceId,operationId:q.operationId,action:q.action,requestSha256:sha(canonical(q)),userId:q.userId,lifecycleId:q.lifecycleId,owner:q.owner};let r;
  if(q.action==='revoke_writer'){for(const old of store.values())if(old.lifecycleId===q.lifecycleId)active.delete(old.principalId);r={...base,state:'revoked',revocationMode:'lifecycle',allGenerationsRevoked:true,effectiveAt:time,revokedCount:1};}
  else{const issued=q.issuedAt??time;r={...base,state:q.action==='commit_writer'?'committed':'prepared',principalId:q.principalId,generation:q.generation,expectedGeneration:q.expectedGeneration,area:'growth',slot:'growth-campaign',role:'manager',caps:[...CAPS],issuedAt:issued,candidateExpiresAt:issued+600000,expiresAt:issued+1209600000,...(q.action==='commit_writer'?{prepareOperationId:q.prepareOperationId,committedAt:time,revokedGeneration:q.expectedGeneration===0?null:q.expectedGeneration}:{})};if(q.action==='commit_writer'){for(const old of store.values())if(old.lifecycleId===q.lifecycleId)active.delete(old.principalId);active.add(q.principalId);}}
  store.set(q.operationId,r);return r;
 }
 const client=createWriterClient({issuerId,namespaceId,allowedEmailDomains:['oaristocrata.com'],now:()=>time,invoke});
 const attest=async input=>{events.push('FULL_ATTEST');if(duringAttest)await duringAttest(input);return verifyCampaignWriterCredential(input,{fetchImpl:async(url,options)=>{assert.equal(url,IDENTITY_URL);assert.equal(options.redirect,'manual');assert.equal(active.has(input.principalId),true);const response=new Response(JSON.stringify({schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',owner:input.owner,allowedPanels:['growth'],permissions:{growth:{who:'panel:'+input.principalId,label:input.owner,caps:invalidIdentity?['read_content']:[...CAPS]},influs:null}}),{status:200,headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:IDENTITY_URL});return response;}});};
 const coordinator=createWriterCoordinator({journal:auth.managedCampaignWriterJournal,client,attest,now:()=>time});
 const invite=(email='manager@oaristocrata.com',area='growth')=>auth.createInvite({context,email,areas:[area],requestedAccess:'edit'});
 const accept=i=>auth.acceptInvite({token:i.token,password:PASSWORD,host:i.host,origin:'https://'+i.host});
 const manager=async(email='manager@oaristocrata.com')=>{const i=invite(email);await accept(i);promoteRead(i.userId);return i.userId;};
 const login=async(email='manager@oaristocrata.com')=>{const l=await auth.login({email,password:PASSWORD,host:hosts.growth,origin:'https://'+hosts.growth});return{host:hosts.growth,origin:'https://'+hosts.growth,method:'POST',cookieHeader:l.cookie.split(';')[0],csrf:l.csrf};};
 function promoteRead(id){
  const journal=auth.managedCrmJournal,operation=journal.pendingOperations(8).find(op=>journal.request(op).userId===id);assert.ok(operation);
  const q=journal.beginPrepare(operation),kind=f=>({schema:'crm-manager-provision-receipt-v1',issuerId:config.crmManagedRead.issuerId,namespaceId:config.crmManagedRead.namespaceId,operationId:operation,action:q.expectedGeneration===0?'prepare_read':'renew_read',userId:q.userId,lifecycleId:q.lifecycleId,owner:q.owner,state:'prepared',principalId:q.principalId,generation:q.generation,expectedGeneration:q.expectedGeneration,area:'growth',slot:'crm-panel-read',role:'manager',caps:['read_content','list_history','submission'],issuedAt:time,candidateExpiresAt:time+600000,expiresAt:time+1209600000,...f});
  journal.recordPrepared(operation,kind());journal.candidateForAttestation(operation);journal.recordAttestation(operation,{owner:q.owner,principalId:q.principalId,caps:['read_content','list_history','submission']});const command=journal.beginCommit(operation);
  journal.recordCommitted(operation,kind({operationId:command.args.operationId,action:'commit_read',state:'committed',prepareOperationId:operation,committedAt:time,revokedGeneration:q.expectedGeneration===0?null:q.expectedGeneration}));journal.promote(operation);return journal.readBinding(id);
 }
 function confirmReadRevoke(id){const op=auth.managedCrmJournal.pendingOperations(8).find(op=>auth.managedCrmJournal.operationState(op).kind==='revoke'&&auth.managedCrmJournal.request(op).userId===id);const q=auth.managedCrmJournal.request(op);auth.managedCrmJournal.confirmRevoked(op,{schema:'crm-manager-provision-receipt-v1',issuerId:config.crmManagedRead.issuerId,namespaceId:config.crmManagedRead.namespaceId,...q,action:'revoke_read',state:'revoked',revocationMode:'lifecycle',allGenerationsRevoked:true,effectiveAt:time,revokedCount:1});}
 const operation=id=>db.prepare("SELECT o.operation_id FROM crm_writer_bridge_op_v1 o JOIN crm_writer_bridge_life_v1 l USING(lifecycle_id) WHERE l.user_id=? AND o.kind<>'revoke' ORDER BY o.rowid DESC").get(id)?.operation_id;
 const approval=id=>auth.approveManagedCampaignWriter({context,userId:id});
 const issue=async id=>{approval(id);return coordinator.run(operation(id));};
 const atomic=f=>{db.exec('BEGIN IMMEDIATE');try{const r=f();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const masterBaseline=()=>({user:db.prepare('SELECT * FROM users WHERE id=?').get(master.user.id),grants:db.prepare('SELECT * FROM grants WHERE user_id=? ORDER BY area').all(master.user.id),slots:db.prepare('SELECT * FROM upstream_credentials WHERE user_id=? ORDER BY slot').all(master.user.id)});
 t.after(()=>{auth.close();db.close();fs.rmSync(dir,{recursive:true,force:true});});
 return{config,db,inspect,get now(){return time;},promoteRead,confirmReadRevoke,invoke,context,master,masterBaseline,events,client,coordinator,adapter,invite,accept,manager,login,operation,approval,issue,atomic,digest,encrypt,decrypt,get auth(){return auth;},set duringAttest(f){duringAttest=f;},set invalidIdentity(v){invalidIdentity=v;},restart(){auth.close();auth=createAuth(config);},advance(n){time+=n;}};
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

module.exports={fixture,pending,hosts,CAPS,canonical,sha};
