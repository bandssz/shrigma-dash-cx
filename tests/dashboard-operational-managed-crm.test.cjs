'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events'),{DatabaseSync}=require('node:sqlite');
const {createAuth}=require('../services/dashboard-operational/auth.cjs');
const {createProvisioningClient,POLICY}=require('../services/dashboard-operational/crm-manager-provisioning.cjs');
const hosts={manager:'gerencial.synthetic.invalid',growth:'crm.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'};
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
async function fixture(managed=true){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'managed-crm-auth-')),dbPath=path.join(dir,'identity.sqlite'),issuerId=crypto.randomUUID(),namespaceId=crypto.randomUUID();let time=1790980000000;
 const config={dbPath,managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'owner@synthetic.invalid',bootstrapTokenSha256:sha('bootstrap-synthetic'),encryptionKey:crypto.randomBytes(32),now:()=>time,...(managed?{crmManagedRead:{issuerId,namespaceId}}:{})};
 let auth=createAuth(config);
 await auth.completeBootstrap({email:config.bootstrapAdminEmail,token:'bootstrap-synthetic',password:'synthetic-owner-password-2026',host:hosts.manager,origin:'https://'+hosts.manager});
 const master=await auth.login({email:config.bootstrapAdminEmail,password:'synthetic-owner-password-2026',host:hosts.manager,origin:'https://'+hosts.manager});
 const context={host:hosts.manager,origin:'https://'+hosts.manager,method:'POST',cookieHeader:master.cookie.split(';')[0],csrf:master.csrf};
 const inspect=fn=>{const d=new DatabaseSync(dbPath);try{return fn(d);}finally{d.close();}};
 const baseline=()=>inspect(d=>({user:d.prepare("SELECT * FROM users WHERE role='superadmin'").get(),grants:d.prepare('SELECT * FROM grants WHERE user_id=? ORDER BY area').all(master.user.id),slot:d.prepare('SELECT * FROM upstream_credentials WHERE user_id=?').all(master.user.id)}));
 const masterKey='synthetic-master-reader-'+crypto.randomBytes(16).toString('hex');
 await auth.setCrmPanelReadCredential({context,userId:master.user.id,slot:'crm-panel-read',bearer:masterKey,fetchImpl:async()=>new Response(JSON.stringify({schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',owner:config.bootstrapAdminEmail,allowedPanels:['growth'],permissions:{growth:{who:'panel:legacy-master',label:config.bootstrapAdminEmail,caps:[...POLICY.caps]},influs:null}}),{status:200,headers:{'content-type':'application/json'}})});
 const calls=[],receipts=new Map();
 const requestImpl=(url,options,callback)=>{const req=new EventEmitter();req.destroy=()=>{};req.setTimeout=()=>{};req.end=wire=>{const b=JSON.parse(wire);calls.push({url,wire,headers:options.headers});queueMicrotask(()=>{
  let value;
  if(b.action==='status')value={schema:'crm-manager-provision-status-v1',issuerId,namespaceId,operationId:b.operationId,found:receipts.has(b.operationId),...(receipts.has(b.operationId)?{receipt:receipts.get(b.operationId)}:{})};
  else{const base={schema:'crm-manager-provision-receipt-v1',issuerId,namespaceId,operationId:b.operationId,action:b.action,requestSha256:sha(canonical(b)),userId:b.userId,lifecycleId:b.lifecycleId,owner:b.owner};
   if(b.action==='revoke_read')value={...base,state:'revoked',revocationMode:'lifecycle',allGenerationsRevoked:true,effectiveAt:time,revokedCount:1};
   else{const at=b.issuedAt??time;value={...base,state:b.action==='commit_read'?'committed':'prepared',principalId:b.principalId,generation:b.generation,expectedGeneration:b.expectedGeneration,area:'growth',slot:'crm-panel-read',role:'manager',caps:[...POLICY.caps],issuedAt:at,candidateExpiresAt:at+POLICY.candidateTtlMs,expiresAt:at+POLICY.lifetimeMs,...(b.action==='commit_read'?{prepareOperationId:b.prepareOperationId,committedAt:time,revokedGeneration:b.expectedGeneration===0?null:b.expectedGeneration}:{})};}
   receipts.set(b.operationId,value);
  }
  const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'application/json'};res.destroy=()=>{};callback(res);res.emit('data',Buffer.from(JSON.stringify(value)));res.emit('end');res.emit('close');
 });};return req;};
 const client=()=>createProvisioningClient({issuerId,namespaceId,allowedEmailDomains:['synthetic.invalid'],provisionerToken:'synthetic-service-token-'.repeat(3),requestImpl,now:()=>time});
 const invite=(email,area='growth')=>auth.createInvite({context,email,areas:[area],requestedAccess:'edit'});
 const accept=i=>auth.acceptInvite({token:i.token,password:'synthetic-manager-password-2026',host:i.host,origin:'https://'+i.host});
 const login=email=>auth.login({email,password:'synthetic-manager-password-2026',host:hosts.growth,origin:'https://'+hosts.growth});
 const reader=l=>({cookieHeader:l.cookie.split(';')[0],host:hosts.growth,method:'GET',area:'growth',edit:false,slot:'crm-panel-read'});
 const queued=userId=>inspect(d=>d.prepare("SELECT o.operation_id FROM crm_manager_operations_v1 o JOIN crm_manager_current_v1 c USING(lifecycle_id) WHERE c.user_id=? AND o.kind='issue'").get(userId).operation_id);
 const prepare=async(c,op)=>{const j=auth.managedCrmJournal,r=j.beginPrepare(op),{generation,expectedGeneration,...issue}=r;const p=expectedGeneration===0?await c.prepareRead(issue):await c.prepareRenewalRead(r);j.recordPrepared(op,p);const bearer=j.candidateForAttestation(op);assert.equal(sha(bearer),r.keySha256);j.recordAttestation(op,{owner:p.owner,principalId:p.principalId,caps:p.caps});return {prepared:p,bearer};};
 const commit=async(c,op,p)=>{const j=auth.managedCrmJournal,descriptor=j.beginCommit(op),proof=await c.commitRead({operationId:descriptor.args.operationId,prepared:p});j.recordCommitted(op,proof);j.promote(op);return proof;};
 return {config,context,masterKey,master,baseline,calls,client,invite,accept,login,reader,queued,prepare,commit,inspect,get auth(){return auth;},advance:n=>{time+=n;},restart:()=>{auth.close();auth=createAuth(config);},close:()=>{auth.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
test('real identity hooks and private RPC client provision two managers, renew and revoke independently',async()=>{
 const f=await fixture();try{
  const admin=f.baseline(),a=f.invite('a@synthetic.invalid'),b=f.invite('b@synthetic.invalid');assert.equal(f.calls.length,0);
  await f.accept(a);await f.accept(b);const al=await f.login('a@synthetic.invalid'),bl=await f.login('b@synthetic.invalid');assert.equal(al.user.permissions.growth.edit,false);
  assert.throws(()=>f.auth.getUpstreamCredential(f.reader(al)),{code:'CRM_ACCESS_NOT_READY'});
  assert.throws(()=>f.auth.setUpstreamCredential({context:f.context,userId:a.userId,slot:'growth-read',bearer:f.masterKey}),{code:'MANAGED_CREDENTIAL_DENIED'});
  const c=f.client(),ao=f.queued(a.userId),bo=f.queued(b.userId),ap=await f.prepare(c,ao),bp=await f.prepare(c,bo);assert.notEqual(ap.bearer,bp.bearer);
  await f.commit(c,ao,ap.prepared);await f.commit(c,bo,bp.prepared);assert.equal(f.auth.getUpstreamCredential(f.reader(al)),ap.bearer);assert.equal(f.auth.getUpstreamCredential(f.reader(bl)),bp.bearer);
  const publicJson=JSON.stringify({users:f.auth.users({context:f.context}),session:f.auth.session(f.reader(al))});assert.ok(!publicJson.includes(ap.bearer)&&!publicJson.includes(bp.bearer));assert.ok(!f.calls.some(call=>call.wire.includes(ap.bearer)||call.wire.includes(bp.bearer)||call.wire.includes(f.masterKey)));
  const renew=f.auth.managedCrmJournal.renew(a.userId).operationId,rp=await f.prepare(c,renew);assert.equal(f.auth.getUpstreamCredential(f.reader(al)),ap.bearer);await f.commit(c,renew,rp.prepared);assert.equal(f.auth.getUpstreamCredential(f.reader(al)),rp.bearer);
  assert.throws(()=>f.auth.setGrants({context:f.context,userId:a.userId,permissions:{growth:{read:true,edit:true}}}),{code:'EDIT_NOT_READY'});assert.throws(()=>f.auth.setGrants({context:f.context,userId:a.userId,permissions:{organico:{read:true,edit:false}}}),{code:'AREA_CHANGE_REQUIRES_REINVITE'});
  const revoked=f.auth.revokeUser({context:f.context,userId:a.userId});assert.equal(revoked.crmRevocationPending,true);assert.equal(f.auth.session(f.reader(al)).authenticated,false);assert.equal(f.auth.getUpstreamCredential(f.reader(bl)),bp.bearer);
  const rev=f.inspect(d=>d.prepare("SELECT operation_id FROM crm_manager_operations_v1 WHERE kind='revoke'").get().operation_id),rr=await c.revokeRead(f.auth.managedCrmJournal.request(rev));f.auth.managedCrmJournal.confirmRevoked(rev,rr);f.restart();assert.equal(f.auth.managedCrmJournal.status(a.userId).state,'revoked');assert.deepEqual(f.baseline(),admin);
  assert.equal(f.auth.getUpstreamCredential({...f.reader(bl),cookieHeader:f.master.cookie.split(';')[0],host:hosts.manager}),f.masterKey);
  const reinvite=f.invite('a@synthetic.invalid','organico');await f.accept(reinvite);assert.equal(f.auth.managedCrmJournal.status(a.userId).state,'revoked');
 }finally{f.close();}
});
test('accept failure rolls back password, invite consumption and issue intent together',async()=>{
 const f=await fixture();try{
  const i=f.invite('failure@synthetic.invalid');f.inspect(d=>d.exec("CREATE TRIGGER synthetic_job_failure BEFORE INSERT ON crm_manager_operations_v1 BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;"));
  await assert.rejects(f.accept(i),{code:'MANAGED_STORE_UNAVAILABLE'});
  const state=f.inspect(d=>({user:d.prepare('SELECT state,password_hash FROM users WHERE id=?').get(i.userId),invite:d.prepare('SELECT used_at FROM invites WHERE user_id=?').get(i.userId),ops:d.prepare('SELECT COUNT(*) n FROM crm_manager_operations_v1').get().n}));
  assert.equal(state.user.state,'invited');assert.equal(state.user.password_hash,null);assert.equal(state.invite.used_at,null);assert.equal(state.ops,0);assert.equal(f.calls.length,0);
  f.inspect(d=>d.exec('DROP TRIGGER synthetic_job_failure'));await f.accept(i);assert.equal(f.auth.managedCrmJournal.status(i.userId).state,'provisioning');
 }finally{f.close();}
});
test('invite expiry is rechecked after password hashing and the disabled profile creates no managed objects',async()=>{
 const f=await fixture(false);try{
  assert.equal(Object.hasOwn(f.auth,'managedCrmJournal'),false);assert.equal(f.inspect(d=>d.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'crm_manager_%'").get().n),0);
  const i=f.auth.createInvite({context:f.context,email:'expiry@synthetic.invalid',areas:['growth'],expiresMs:300000});const pending=f.accept(i);f.advance(300001);await assert.rejects(pending,{code:'INVITE_DENIED'});
  assert.equal(f.inspect(d=>d.prepare('SELECT state FROM users WHERE id=?').get(i.userId).state),'invited');assert.equal(f.calls.length,0);
 }finally{f.close();}
});
