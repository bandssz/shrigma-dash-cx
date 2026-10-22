'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events'),{DatabaseSync}=require('node:sqlite');
const {createAuth}=require('../services/dashboard-operational/auth.cjs');
const {createServer}=require('../services/dashboard-operational/server.cjs');
const {FIXED_DESTINATIONS}=require('../services/dashboard-operational/proxy.cjs');
const {Readable}=require('node:stream');
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
 const invite=(email,area='growth',brand='fish')=>auth.createInvite({context,email,areas:[area],brand,requestedAccess:'edit'});
 const accept=i=>auth.acceptInvite({token:i.token,password:'synthetic-manager-password-2026',host:i.host,origin:'https://'+i.host});
 const login=email=>auth.login({email,password:'synthetic-manager-password-2026',host:hosts.growth,origin:'https://'+hosts.growth});
 const reader=l=>({cookieHeader:l.cookie.split(';')[0],host:hosts.growth,method:'GET',area:'growth',edit:false,slot:'crm-panel-read',...(l.user.role==='manager'?{brand:l.user.brand}:{})});
 const queued=userId=>inspect(d=>d.prepare("SELECT o.operation_id FROM crm_manager_operations_v1 o JOIN crm_manager_current_v1 c USING(lifecycle_id) WHERE c.user_id=? AND o.kind='issue'").get(userId).operation_id);
 const renewal=userId=>inspect(d=>d.prepare("SELECT o.* FROM crm_manager_operations_v1 o JOIN crm_manager_current_v1 c USING(lifecycle_id) WHERE c.user_id=? AND o.kind='renew' ORDER BY o.created_at DESC").get(userId));
 const refreshAdmin=async()=>{const login=await auth.login({email:config.bootstrapAdminEmail,password:'synthetic-owner-password-2026',host:hosts.manager,origin:'https://'+hosts.manager});Object.assign(context,{cookieHeader:login.cookie.split(';')[0],csrf:login.csrf});};
 const prepare=async(c,op)=>{const j=auth.managedCrmJournal,r=j.beginPrepare(op),{generation,expectedGeneration,...issue}=r;const p=expectedGeneration===0?await c.prepareRead(issue):await c.prepareRenewalRead(r);j.recordPrepared(op,p);const bearer=j.candidateForAttestation(op);assert.equal(sha(bearer),r.keySha256);j.recordAttestation(op,{owner:p.owner,principalId:p.principalId,caps:p.caps});return {prepared:p,bearer};};
 const commit=async(c,op,p)=>{const j=auth.managedCrmJournal,descriptor=j.beginCommit(op),proof=await c.commitRead({operationId:descriptor.args.operationId,prepared:p});j.recordCommitted(op,proof);j.promote(op);return proof;};
 return {config,context,masterKey,master,baseline,calls,client,invite,accept,login,reader,queued,renewal,refreshAdmin,prepare,commit,inspect,get auth(){return auth;},advance:n=>{time+=n;},restart:()=>{auth.close();auth=createAuth(config);},close:()=>{auth.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
// Exercise the HTTP listener directly: no sockets, startup kick or real fetch.
function adminPost(server,context,body){return new Promise(resolve=>{
 const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST';req.url='/auth/users';req.headers={host:context.host,origin:context.origin,cookie:context.cookieHeader,'x-csrf-token':context.csrf,'content-type':'application/json'};
 const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(raw){resolve({status:this.statusCode,body:JSON.parse(raw),headers:this.headers});}};
 server.emit('request',req,res);
});}
test('real identity hooks and private RPC client provision two managers, renew and revoke independently',async()=>{
 const f=await fixture();try{
  const admin=f.baseline(),a=f.invite('a@synthetic.invalid'),b=f.invite('b@synthetic.invalid','growth','aristo');assert.equal(f.calls.length,0);
  await f.accept(a);await f.accept(b);const al=await f.login('a@synthetic.invalid'),bl=await f.login('b@synthetic.invalid');assert.equal(al.user.permissions.growth.edit,false);assert.equal(al.user.brand,'fish');assert.equal(bl.user.brand,'aristo');
  assert.throws(()=>f.auth.getUpstreamCredential(f.reader(al)),{code:'CRM_ACCESS_NOT_READY'});
  assert.throws(()=>f.auth.setUpstreamCredential({context:f.context,userId:a.userId,slot:'growth-read',bearer:f.masterKey}),{code:'MANAGED_CREDENTIAL_DENIED'});
  const c=f.client(),ao=f.queued(a.userId),bo=f.queued(b.userId),ap=await f.prepare(c,ao),bp=await f.prepare(c,bo);assert.notEqual(ap.bearer,bp.bearer);
  await f.commit(c,ao,ap.prepared);await f.commit(c,bo,bp.prepared);assert.equal(f.auth.getUpstreamCredential(f.reader(al)),ap.bearer);assert.equal(f.auth.getUpstreamCredential(f.reader(bl)),bp.bearer);assert.throws(()=>f.auth.getUpstreamCredential({...f.reader(al),brand:'aristo'}),{code:'BRAND_DENIED'});assert.throws(()=>f.auth.getUpstreamCredential({...f.reader(bl),brand:'fish'}),{code:'BRAND_DENIED'});
  const publicJson=JSON.stringify({users:f.auth.users({context:f.context}),session:f.auth.session(f.reader(al))});assert.ok(!publicJson.includes(ap.bearer)&&!publicJson.includes(bp.bearer));assert.ok(!f.calls.some(call=>call.wire.includes(ap.bearer)||call.wire.includes(bp.bearer)||call.wire.includes(f.masterKey)));
  assert.deepEqual(f.auth.renewManagedCrm({context:f.context,userId:a.userId}),{ok:true});
  const renew=f.renewal(a.userId).operation_id,rp=await f.prepare(c,renew);assert.equal(f.auth.getUpstreamCredential(f.reader(al)),ap.bearer);await f.commit(c,renew,rp.prepared);assert.equal(f.auth.getUpstreamCredential(f.reader(al)),rp.bearer);
  assert.throws(()=>f.auth.setGrants({context:f.context,userId:a.userId,permissions:{growth:{read:true,edit:true}}}),{code:'EDIT_NOT_READY'});assert.throws(()=>f.auth.setGrants({context:f.context,userId:a.userId,permissions:{organico:{read:true,edit:false}}}),{code:'AREA_CHANGE_REQUIRES_REINVITE'});
  const revoked=f.auth.revokeUser({context:f.context,userId:a.userId});assert.equal(revoked.crmRevocationPending,true);assert.equal(f.auth.session(f.reader(al)).authenticated,false);assert.equal(f.auth.getUpstreamCredential(f.reader(bl)),bp.bearer);
  const rev=f.inspect(d=>d.prepare("SELECT operation_id FROM crm_manager_operations_v1 WHERE kind='revoke'").get().operation_id),rr=await c.revokeRead(f.auth.managedCrmJournal.request(rev));f.auth.managedCrmJournal.confirmRevoked(rev,rr);f.restart();assert.equal(f.auth.managedCrmJournal.status(a.userId).state,'revoked');assert.deepEqual(f.baseline(),admin);
  assert.equal(f.auth.getUpstreamCredential({...f.reader(bl),cookieHeader:f.master.cookie.split(';')[0],host:hosts.manager}),f.masterKey);
  assert.throws(()=>f.invite('a@synthetic.invalid','organico'),{code:'BRAND_CHANGE_REQUIRES_NEW_IDENTITY'});
  const otherArea=f.invite('organic@synthetic.invalid','organico');await f.accept(otherArea);assert.notEqual(otherArea.userId,a.userId);assert.equal(f.auth.managedCrmJournal.status(a.userId).state,'revoked');assert.equal(f.auth.managedCrmJournal.status(otherArea.userId),null);
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
  assert.throws(()=>f.auth.renewManagedCrm({context:f.context,userId:f.master.user.id}),{code:'CRM_PROVISIONING_NOT_READY',status:403});
  const i=f.auth.createInvite({context:f.context,email:'expiry@synthetic.invalid',areas:['growth'],brand:'fish',expiresMs:300000});const pending=f.accept(i);f.advance(300001);await assert.rejects(pending,{code:'INVITE_DENIED'});
  assert.equal(f.inspect(d=>d.prepare('SELECT state FROM users WHERE id=?').get(i.userId).state),'invited');assert.equal(f.calls.length,0);
 }finally{f.close();}
});
test('manual renewal requires an authorized admin and the current valid managed read credential',async()=>{
 const f=await fixture();try{
  const a=f.invite('renew@synthetic.invalid'),invited=f.invite('invited@synthetic.invalid'),other=f.invite('other@synthetic.invalid','organico');await f.accept(a);await f.accept(other);
  assert.throws(()=>f.auth.renewManagedCrm({context:f.context,userId:a.userId}),{code:'CRM_RENEWAL_NOT_READY',status:409});
  const c=f.client(),op=f.queued(a.userId),p=await f.prepare(c,op);await f.commit(c,op,p.prepared);const login=await f.login('renew@synthetic.invalid');
  const count=()=>f.inspect(d=>d.prepare('SELECT COUNT(*) n FROM crm_manager_operations_v1').get().n),before=count(),master=f.baseline();
  for(const context of [{...f.context,method:'GET'},{...f.context,csrf:undefined},{...f.context,origin:'https://wrong.synthetic.invalid'},{...f.context,host:hosts.growth},{host:hosts.growth,origin:'https://'+hosts.growth,method:'POST',cookieHeader:login.cookie.split(';')[0],csrf:login.csrf}])assert.throws(()=>f.auth.renewManagedCrm({context,userId:a.userId}));
  for(const userId of [undefined,null,'not-a-uuid',a.userId.toUpperCase(),'11111111-1111-1111-8111-111111111111'])assert.throws(()=>f.auth.renewManagedCrm({context:f.context,userId}),{code:'USER_INVALID',status:400});
  for(const userId of [f.master.user.id,invited.userId,other.userId,crypto.randomUUID()])assert.throws(()=>f.auth.renewManagedCrm({context:f.context,userId}),{code:'USER_DENIED',status:404});
  assert.equal(count(),before);assert.deepEqual(f.baseline(),master);
  const ready=f.auth.users({context:f.context}).find(u=>u.id===a.userId).crmAccess;
  assert.deepEqual(Object.keys(ready).sort(),['canRenew','expired','expiresAt','generation','ready','renewalPhase','state']);assert.equal(ready.canRenew,true);assert.equal(ready.expired,false);assert.equal(ready.renewalPhase,null);
  f.inspect(d=>d.prepare("UPDATE upstream_credentials SET encrypted_key='synthetic-drift' WHERE user_id=? AND slot='crm-panel-read'").run(a.userId));
  assert.throws(()=>f.auth.renewManagedCrm({context:f.context,userId:a.userId}),{code:'CRM_RENEWAL_NOT_READY',status:409});assert.equal(count(),before);
  assert.equal(f.auth.users({context:f.context}).find(u=>u.id===a.userId).crmAccess.canRenew,false);assert.deepEqual(f.baseline(),master);
 }finally{f.close();}
});
test('renewal retries preserve durable operation identity, ciphertext and uncertain phases across restart',async()=>{
 const f=await fixture();try{
  const a=f.invite('durable@synthetic.invalid');await f.accept(a);const c=f.client(),first=f.queued(a.userId),initial=await f.prepare(c,first);await f.commit(c,first,initial.prepared);
  const beforeCalls=f.calls.length,master=f.baseline();assert.deepEqual(f.auth.renewManagedCrm({context:f.context,userId:a.userId}),{ok:true});assert.equal(f.calls.length,beforeCalls);
  const queued=f.renewal(a.userId),id=queued.operation_id;
  const retry=phase=>{const before=f.renewal(a.userId);assert.equal(before.phase,phase);assert.throws(()=>f.auth.renewManagedCrm({context:f.context,userId:a.userId}),{code:'CRM_RENEWAL_PENDING',status:409});assert.deepEqual(f.renewal(a.userId),before);const dto=f.auth.users({context:f.context}).find(u=>u.id===a.userId).crmAccess;assert.equal(dto.renewalPhase,phase);assert.equal(dto.canRenew,false);assert.equal(dto.ready,!['commit_uncertain','committed'].includes(phase));};
  retry('queued');f.restart();retry('queued');const args=f.auth.managedCrmJournal.beginPrepare(id);retry('prepare_uncertain');f.restart();retry('prepare_uncertain');
  const prepared=await c.prepareRenewalRead(args);f.auth.managedCrmJournal.recordPrepared(id,prepared);retry('prepared');
  f.auth.managedCrmJournal.recordAttestation(id,{owner:prepared.owner,principalId:prepared.principalId,caps:prepared.caps});retry('attested');const descriptor=f.auth.managedCrmJournal.beginCommit(id);retry('commit_uncertain');f.restart();retry('commit_uncertain');
  assert.equal(f.renewal(a.userId).operation_id,queued.operation_id);assert.equal(f.renewal(a.userId).commit_operation_id,queued.commit_operation_id);assert.equal(f.renewal(a.userId).candidate_ciphertext,queued.candidate_ciphertext);
  const committed=await c.commitRead({operationId:descriptor.args.operationId,prepared});f.auth.managedCrmJournal.recordCommitted(id,committed);retry('committed');f.restart();retry('committed');f.auth.managedCrmJournal.promote(id);
  const done=f.auth.users({context:f.context}).find(u=>u.id===a.userId).crmAccess;assert.equal(done.generation,2);assert.equal(done.renewalPhase,null);assert.equal(done.canRenew,true);assert.equal(done.ready,true);assert.deepEqual(f.baseline(),master);
  const json=JSON.stringify(done);for(const value of [queued.operation_id,queued.commit_operation_id,queued.candidate_ciphertext,queued.candidate_digest,queued.principal_id])assert.ok(!json.includes(value));
 }finally{f.close();}
});
test('expired access and local renewal persistence failure preserve the existing lifecycle and credential',async()=>{
 const f=await fixture();try{
  const a=f.invite('expiry-renew@synthetic.invalid');await f.accept(a);const c=f.client(),op=f.queued(a.userId),prepared=await f.prepare(c,op);await f.commit(c,op,prepared.prepared);
  const store=()=>f.inspect(d=>({ops:d.prepare('SELECT * FROM crm_manager_operations_v1 ORDER BY operation_id').all(),life:d.prepare('SELECT * FROM crm_manager_lifecycles_v1').all(),slot:d.prepare('SELECT * FROM upstream_credentials ORDER BY user_id').all()})),before=store(),master=f.baseline(),calls=f.calls.length;
  f.inspect(d=>d.exec("CREATE TRIGGER synthetic_renew_failure BEFORE INSERT ON crm_manager_operations_v1 WHEN NEW.kind='renew' BEGIN SELECT RAISE(ABORT,'private-synthetic-error'); END;"));
  assert.throws(()=>f.auth.renewManagedCrm({context:f.context,userId:a.userId}),{code:'MANAGED_STORE_UNAVAILABLE',status:503});assert.deepEqual(store(),before);assert.equal(f.calls.length,calls);
  f.inspect(d=>d.exec('DROP TRIGGER synthetic_renew_failure'));f.advance(POLICY.lifetimeMs);await f.refreshAdmin();
  assert.throws(()=>f.auth.renewManagedCrm({context:f.context,userId:a.userId}),{code:'CRM_ACCESS_EXPIRED',status:409});assert.deepEqual(store(),before);assert.deepEqual(f.baseline(),master);
  const dto=f.auth.users({context:f.context}).find(u=>u.id===a.userId).crmAccess;assert.equal(dto.expired,true);assert.equal(dto.canRenew,false);assert.equal(dto.ready,false);assert.equal(dto.state,'ready');assert.equal(dto.generation,1);
 }finally{f.close();}
});
test('renewal HTTP action stays closed when disabled and kicks only after the local intent is durable',async()=>{
 const f=await fixture();try{
  const a=f.invite('route@synthetic.invalid');await f.accept(a);const c=f.client(),op=f.queued(a.userId),p=await f.prepare(c,op);await f.commit(c,op,p.prepared);const before=f.baseline();
  const settings={mode:'operational',managerHost:hosts.manager,areaHosts:f.config.areaHosts,upstreams:{'crm-read':new URL(FIXED_DESTINATIONS['crm-read'])},allowedUpstreamHosts:[new URL(FIXED_DESTINATIONS['crm-read']).hostname],publicDir:'/synthetic-unused'};
  let kicks=0;const runtime={kick(){kicks++;const row=f.renewal(a.userId);assert.equal(row.phase,'queued');assert.ok(row.candidate_ciphertext&&row.commit_operation_id);assert.ok(f.auth.managedCrmJournal.pendingOperations(8).includes(row.operation_id));return Promise.resolve({ready:0,pending:1,expired:0,revoked:0});},close:async()=>{}};
  const fetchImpl=()=>{throw Error('synthetic network forbidden');},off=createServer(settings,{auth:f.auth,fetchImpl}),on=createServer({...settings,crmManagedRead:{issuerId:f.config.crmManagedRead.issuerId,namespaceId:f.config.crmManagedRead.namespaceId}},{auth:f.auth,fetchImpl,managedCrmRuntime:runtime});
  const body={action:'crm_renew',userId:a.userId};assert.deepEqual((await adminPost(off,f.context,body)).body,{error:'CRM_PROVISIONING_NOT_READY'});assert.equal(f.renewal(a.userId),undefined);assert.equal(kicks,0);
  for(const invalid of [null,[],{action:'crm_renew'},{...body,bearer:'synthetic-private-canary'},{...body,userId:'invalid'},{...body,userId:null}])assert.equal((await adminPost(on,f.context,invalid)).status,400);
  assert.equal(kicks,0);assert.equal(f.renewal(a.userId),undefined);
  f.inspect(d=>d.exec("CREATE TRIGGER synthetic_route_renew_failure BEFORE INSERT ON crm_manager_operations_v1 WHEN NEW.kind='renew' BEGIN SELECT RAISE(ABORT,'private-route-failure'); END;"));
  const failed=await adminPost(on,f.context,body);assert.equal(failed.status,503);assert.deepEqual(failed.body,{error:'MANAGED_STORE_UNAVAILABLE'});assert.equal(kicks,0);assert.equal(f.renewal(a.userId),undefined);
  f.inspect(d=>d.exec('DROP TRIGGER synthetic_route_renew_failure'));
  const accepted=await adminPost(on,f.context,body);assert.equal(accepted.status,202);assert.deepEqual(accepted.body,{ok:true});await Promise.resolve();assert.equal(kicks,1);const pending=f.renewal(a.userId);
  const replay=await adminPost(on,f.context,body);assert.equal(replay.status,409);assert.deepEqual(replay.body,{error:'CRM_RENEWAL_PENDING'});assert.equal(kicks,1);assert.deepEqual(f.renewal(a.userId),pending);assert.deepEqual(f.baseline(),before);
  f.advance(POLICY.lifetimeMs);await f.refreshAdmin();const expired=await adminPost(on,f.context,body);assert.equal(expired.status,409);assert.deepEqual(expired.body,{error:'CRM_ACCESS_EXPIRED'});assert.equal(kicks,1);assert.deepEqual(f.renewal(a.userId),pending);
 }finally{f.close();}
});
test('a legacy CRM credential cannot be renewed or adopted by enabling the managed profile',async()=>{
 const f=await fixture(false);try{
  const a=f.invite('legacy@synthetic.invalid');await f.accept(a);const bearer='synthetic-legacy-reader-'+crypto.randomBytes(16).toString('hex');
  await f.auth.setCrmPanelReadCredential({context:f.context,userId:a.userId,slot:'crm-panel-read',bearer,fetchImpl:async()=>new Response(JSON.stringify({schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',owner:'legacy@synthetic.invalid',allowedPanels:['growth'],permissions:{growth:{who:'panel:legacy-manager',label:'legacy@synthetic.invalid',caps:[...POLICY.caps]},influs:null}}),{status:200,headers:{'content-type':'application/json'}})});
  const snapshot=()=>f.inspect(d=>d.prepare('SELECT * FROM upstream_credentials ORDER BY user_id').all()),before=snapshot();f.config.crmManagedRead={issuerId:crypto.randomUUID(),namespaceId:crypto.randomUUID()};f.restart();
  assert.equal(Object.hasOwn(f.auth.users({context:f.context}).find(u=>u.id===a.userId),'crmAccess'),false);
  assert.throws(()=>f.auth.renewManagedCrm({context:f.context,userId:a.userId}),{code:'CRM_RENEWAL_NOT_READY',status:409});assert.deepEqual(snapshot(),before);
  assert.equal(f.inspect(d=>d.prepare('SELECT COUNT(*) n FROM crm_manager_operations_v1').get().n),0);assert.equal(f.inspect(d=>d.prepare('SELECT COUNT(*) n FROM crm_manager_lifecycles_v1').get().n),0);assert.equal(f.calls.length,0);
 }finally{f.close();}
});
