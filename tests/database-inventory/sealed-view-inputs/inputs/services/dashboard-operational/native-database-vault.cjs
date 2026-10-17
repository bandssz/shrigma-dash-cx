'use strict';
const crypto=require('node:crypto');
const RESOURCE=Object.freeze({project:'comunicacao',service:'postgres',host:'comunicacao_postgres',port:5432,database:'listmonk',network:'easypanel'});
const PURPOSE='read-only-migration-inventory',H=/^[a-f0-9]{64}$/,N=/^[a-z][a-z0-9_]{0,62}$/;
const validUsername=x=>typeof x==='string'&&Buffer.byteLength(x)>0&&Buffer.byteLength(x)<=63&&!/[\x00-\x1f\x7f]/.test(x);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const canonical=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const fail=(code,status=403)=>{throw Object.assign(Error(code),{code,status});};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&H.test(a)&&H.test(b)&&crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
function createDatabaseVault({enabled=false,db,consent,identity,encrypt,decrypt,mac,now=Date.now}={}){
 if(enabled!==true)return undefined;
 if(!db?.prepare||[consent,identity,encrypt,decrypt,mac,now].some(f=>typeof f!=='function'))fail('DB_VAULT_CONFIG_REFUSED',500);
 db.exec(`CREATE TABLE IF NOT EXISTS shrigma_native_database_credential_v1(
 owner_id TEXT PRIMARY KEY REFERENCES users(id),revision INTEGER NOT NULL,
 username TEXT NOT NULL,encrypted_credential TEXT NOT NULL,owner_revision TEXT NOT NULL,
 consent_session_hash TEXT NOT NULL,linked_at INTEGER NOT NULL,revoked_at INTEGER,binding_mac TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS shrigma_native_database_credential_audit_v1(
 id INTEGER PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),revision INTEGER NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('bind','revoke')),happened_at INTEGER NOT NULL,binding_mac TEXT NOT NULL);`);
 const time=()=>{const t=now();if(!Number.isSafeInteger(t)||t<0)fail('DB_VAULT_CLOCK_REFUSED',500);return t;};
 const binding=r=>mac(canonical([r.owner_id,r.revision,r.username,r.encrypted_credential,r.owner_revision,r.consent_session_hash,r.linked_at,r.revoked_at]));
 const valid=r=>r&&validUsername(r.username)&&Number.isSafeInteger(r.revision)&&r.revision>0&&same(r.binding_mac,binding(r));
 function owner(id){const o=identity(id);if(!o||o.role!=='superadmin'||o.active!==true||!H.test(o.revision||''))fail('DB_ORIGINAL_MASTER_REQUIRED');return o;}
 function consentProof(context){const p=consent(context);if(!p||typeof p.userId!=='string'||!H.test(p.sessionHash||''))fail('DB_BROWSER_CONSENT_REQUIRED');return {...p,identity:owner(p.userId)};}
 function row(id){const r=db.prepare('SELECT * FROM shrigma_native_database_credential_v1 WHERE owner_id=?').get(id);if(r&&!valid(r))fail('DB_PRIVATE_CREDENTIAL_INTEGRITY',409);return r;}
 const view=r=>({linked:!!r&&r.revoked_at===null,username:r?.username||null,revision:r?.revision||null,resource:RESOURCE,purpose:PURPOSE,sqlInstallerEnabled:false,operational:false});
 function status(context){const p=consentProof(context);return view(row(p.userId));}
 function bind({context,username,password,privateNetwork}={}){
  const p=consentProof(context);
  if(!validUsername(username)||typeof password!=='string'||!password||Buffer.byteLength(password)>4096||password.includes('\0')||privateNetwork!==true)fail('DB_PRIVATE_INPUT_REFUSED',400);
  db.exec('BEGIN IMMEDIATE');try{
   const prior=row(p.userId),t=time(),r={owner_id:p.userId,revision:(prior?.revision||0)+1,username,encrypted_credential:encrypt(JSON.stringify({password})),owner_revision:p.identity.revision,consent_session_hash:p.sessionHash,linked_at:t,revoked_at:null};
   r.binding_mac=binding(r);
   db.prepare('INSERT INTO shrigma_native_database_credential_v1 VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision,username=excluded.username,encrypted_credential=excluded.encrypted_credential,owner_revision=excluded.owner_revision,consent_session_hash=excluded.consent_session_hash,linked_at=excluded.linked_at,revoked_at=NULL,binding_mac=excluded.binding_mac').run(r.owner_id,r.revision,r.username,r.encrypted_credential,r.owner_revision,r.consent_session_hash,r.linked_at,r.revoked_at,r.binding_mac);
   db.prepare("INSERT INTO shrigma_native_database_credential_audit_v1(owner_id,revision,action,happened_at,binding_mac) VALUES(?,?,'bind',?,?)").run(r.owner_id,r.revision,t,mac(canonical(['bind',r.owner_id,r.revision,t,r.binding_mac])));
   db.exec('COMMIT');return view(r);
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 function revoke(context){
  const p=consentProof(context);
  db.exec('BEGIN IMMEDIATE');try{const r=row(p.userId);if(!r||r.revoked_at!==null){db.exec('COMMIT');return {linked:false,sqlInstallerEnabled:false};}
   const t=time(),next={...r,revoked_at:t};db.prepare('UPDATE shrigma_native_database_credential_v1 SET revoked_at=?,binding_mac=? WHERE owner_id=?').run(t,binding(next),p.userId);
   db.prepare("INSERT INTO shrigma_native_database_credential_audit_v1(owner_id,revision,action,happened_at,binding_mac) VALUES(?,?,'revoke',?,?)").run(p.userId,r.revision,t,mac(canonical(['revoke',p.userId,r.revision,t,binding(next)])));
   db.exec('COMMIT');return {linked:false,sqlInstallerEnabled:false};
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 function getPrivateCredential({ownerId}={}){
  const o=owner(ownerId),r=row(ownerId);
  if(!r||r.revoked_at!==null)fail('DB_PRIVATE_CREDENTIAL_REQUIRED',503);
  if(o.revision!==r.owner_revision)fail('DB_ORIGINAL_MASTER_CHANGED',409);
  let value;try{value=JSON.parse(decrypt(r.encrypted_credential));}catch{fail('DB_PRIVATE_CREDENTIAL_INTEGRITY',409);}
  if(!value||Object.keys(value).join(',')!=='password'||typeof value.password!=='string'||!value.password||Buffer.byteLength(value.password)>4096||value.password.includes('\0'))fail('DB_PRIVATE_CREDENTIAL_INTEGRITY',409);
  return {schema:'shrigma-private-database-credential-v1',revision:r.revision,ownerId,username:r.username,password:value.password,resource:{...RESOURCE},transport:{mode:'admitted-private-network'}};
 }
 function admitInspection(input){
  if(!input||!['connect','catalog'].includes(input.phase)||input.purpose!==PURPOSE)fail('DB_INSPECTION_ADMISSION_REFUSED');
  const profile=getPrivateCredential({ownerId:input.ownerId}),{password,...publicPart}=profile,bh=sha(canonical(publicPart)),rh=sha(canonical(RESOURCE));
  if(input.profileRevision!==profile.revision||!same(input.credentialBindingHash,bh)||!same(input.resourceHash,rh))fail('DB_INSPECTION_ADMISSION_CHANGED',409);
  if(input.phase==='catalog'){
   const p=input.peer;
   if(!p||p.database!=='listmonk'||p.sessionRole!==profile.username||p.currentRole!==profile.username||!Number.isSafeInteger(p.engine)||Math.floor(p.engine/10000)!==17)fail('DB_AUTHENTICATED_PEER_REFUSED');
  }
  return {admitted:true,ownerId:profile.ownerId,profileRevision:profile.revision,credentialBindingHash:bh,resourceHash:rh,purpose:PURPOSE};
 }
 function inspectionBinding(ownerId){const {password,...pub}=getPrivateCredential({ownerId});return Object.freeze({profileRevision:pub.revision,credentialBindingHash:sha(canonical(pub)),resourceHash:sha(canonical(RESOURCE))});}
 return Object.freeze({status,bind,revoke,getPrivateCredential,admitInspection,inspectionBinding});
}
module.exports=Object.freeze({createDatabaseVault,RESOURCE,PURPOSE,canonical});
