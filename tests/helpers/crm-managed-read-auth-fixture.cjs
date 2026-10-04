'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events'),{DatabaseSync}=require('node:sqlite');
function sourceRoot(){let dir=__dirname;for(let i=0;i<6;i++,dir=path.dirname(dir))if(fs.existsSync(path.join(dir,'services/dashboard-operational/auth.cjs')))return dir;throw Error('TEST_SOURCE_ROOT_MISSING');}
const ROOT=sourceRoot();
const {createAuth}=require(path.join(ROOT,'services/dashboard-operational/auth.cjs'));
const {createProvisioningClient,POLICY}=require(path.join(ROOT,'services/dashboard-operational/crm-manager-provisioning.cjs'));
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
module.exports={fixture,hosts};
