'use strict';
/**
 * Dashboard identity store. Only the HTTP gateway may import this module.
 *
 * createAuth({dbPath, managerHost, areaHosts, allowedEmailDomains,
 *   bootstrapAdminEmail, bootstrapTokenSha256, encryptionKey, now?}) returns:
 *   beginBootstrap/completeBootstrap, login, session, authorize, logout,
 *   createInvite, acceptInvite, users, renewManagedCrm, setGrants, setRequestedAccess, revokeUser,
 *   setUpstreamCredential, getUpstreamCredential, audienceDraft,
 *   reserveAudienceDraft, audienceDraftOutcome, close.
 *
 * `context` is {cookieHeader, host, method, origin, csrf}. An admin mutation
 * requires a valid superadmin session plus POST, exact Origin and CSRF. The
 * gateway must never serialize getUpstreamCredential() or invite tokens into
 * logs. Invite tokens are delivered once, via a URL fragment or another secure
 * channel. No bearer key or password is stored in clear text in this database.
 * Admin activation uses a one-time private bootstrap token. There is no public
 * password reset route; recovery requires verified offline maintenance.
 */
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');
const crypto=require('node:crypto');
const {promisify}=require('node:util');
const {verifyCredential,verifySandboxCredential}=require('./backend-credential-attestation.cjs');
const scrypt=promisify(crypto.scrypt);

const AREAS=Object.freeze(['growth','organico','influs']);
const AREA_SET=new Set(AREAS);
// Only brands already admitted by the gateway's CRM/Influs contracts.
// Adding another brand requires review of each area's backend contract.
const BRANDS=Object.freeze(['fish','aristo']);
const AREA_BRANDS=Object.freeze(Object.fromEntries(AREAS.map(area=>[area,BRANDS])));
// The HTTP gateway, never browser input, selects one of these fixed slots.
// A slot can contain an individual upstream bearer for the named user only.
const CREDENTIAL_SLOTS=Object.freeze({
 'crm-panel-read':{area:'growth',mayWrite:false},
 'growth-read':{area:'growth',mayWrite:false},
 'growth-campaign-read':{area:'growth',mayWrite:false},
 'growth-campaign':{area:'growth',mayWrite:true},
 'growth-audience-read':{area:'growth',mayWrite:false},
 'growth-audience':{area:'growth',mayWrite:true},
 'growth-templates-read':{area:'growth',mayWrite:false},
 'growth-templates':{area:'growth',mayWrite:true},
 'growth-flows-read':{area:'growth',mayWrite:false},
 'growth-flows':{area:'growth',mayWrite:true},
 'growth-ab-read':{area:'growth',mayWrite:false},
 'growth-ab-write':{area:'growth',mayWrite:true},
 'organico-read':{area:'organico',mayWrite:false},
 // The organico-links backend bearer also permits writes. Until it has a
 // verified read-only identity, no user may provision or use that slot.
 'influs-read':{area:'influs',mayWrite:false},
 'influs-write':{area:'influs',mayWrite:true},
 'tts-read':{area:'influs',mayWrite:false},
 'tts-write':{area:'influs',mayWrite:true}
});
const COOKIE='__Host-shrigma_sid';
const SESSION_MS=8*60*60*1000;
const IDLE_MS=30*60*1000;
const INVITE_MS=48*60*60*1000;
const RATE_MS=15*60*1000;
const GLOBAL_LOGIN_ATTEMPTS=120;
const SCRYPT=Object.freeze({N:1<<17,r:8,p:1,maxmem:256*1024*1024});
const DUMMY_SALT=Buffer.from('shrigma-login-dummy-salt-v1');

class AuthError extends Error {
 constructor(code,status=403){super(code);this.name='AuthError';this.code=code;this.status=status;}
}
const err=(code,status)=>{throw new AuthError(code,status);};
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const random=()=>crypto.randomBytes(32).toString('base64url');
const equalHex=(a,b)=>typeof a==='string'&&typeof b==='string'&&/^[a-f0-9]{64}$/.test(a)&&/^[a-f0-9]{64}$/.test(b)&&crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);

function hostname(value){
 if(typeof value!=='string'||!/^[a-z0-9.-]{1,253}$/i.test(value)||value.startsWith('.')||value.endsWith('.'))err('HOST_INVALID',400);
 return value.toLowerCase();
}
function emailAddress(value,domains){
 if(typeof value!=='string'||value.length>254||!(/^[^\s@]{1,64}@[a-z0-9.-]+$/i).test(value))err('EMAIL_INVALID',400);
 const e=value.toLowerCase();if(!domains.has(e.split('@')[1]))err('EMAIL_DOMAIN_DENIED',400);return e;
}
function validPassword(value){
 if(typeof value!=='string'||value.length<12||value.length>128||Buffer.byteLength(value,'utf8')>256||value.includes('\0'))err('PASSWORD_INVALID',400);
 return value;
}
function cookieToken(header){
 if(typeof header!=='string'||header.length>4096)return null;
 const matches=header.split(';').map(x=>x.trim()).filter(x=>x.startsWith(COOKIE+'='));
 if(matches.length!==1)return null;
 const token=matches[0].slice(COOKIE.length+1);return /^[A-Za-z0-9_-]{43}$/.test(token)?token:null;
}
function cookie(value,maxAge){return `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;}
function normalizePermissions(input){
 if(!plain(input)||Object.keys(input).some(a=>!AREA_SET.has(a)))err('GRANTS_INVALID',400);
 const out={};
 for(const [area,grant]of Object.entries(input)){
  if(!plain(grant)||Object.keys(grant).some(k=>!['read','edit'].includes(k))||typeof grant.read!=='boolean'||typeof grant.edit!=='boolean'||grant.edit&&!grant.read||area==='organico'&&grant.edit)err('GRANTS_INVALID',400);
  if(grant.read)out[area]={read:true,edit:grant.edit};
 }
 if(!Object.keys(out).length)err('GRANTS_INVALID',400);return out;
}
function invitePermissions(areas,permissions){
 if(!Array.isArray(areas)||areas.length!==1||!AREA_SET.has(areas[0]))err('GRANTS_INVALID',400);
 const expected=new Set(areas);
 if(permissions===undefined)return Object.fromEntries(areas.map(a=>[a,{read:true,edit:false}]));
 const normalized=normalizePermissions(permissions);
 if(Object.keys(normalized).length!==expected.size||Object.keys(normalized).some(a=>!expected.has(a)))err('GRANTS_INVALID',400);
 return normalized;
}

function createAuth(options){
 if(!plain(options)||typeof options.dbPath!=='string'||!options.dbPath||!Array.isArray(options.allowedEmailDomains)||!options.allowedEmailDomains.length||!plain(options.areaHosts))err('CONFIG_INVALID',500);
 if(options.crmManagedRead!==undefined&&(!plain(options.crmManagedRead)||Object.keys(options.crmManagedRead).sort().join(',')!=='issuerId,namespaceId'||Object.values(options.crmManagedRead).some(v=>typeof v!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v))))err('MANAGED_CONFIG_INVALID',500);
 let corporateWriter=null;
 let ownMasterWriter=null;
 const ownMasterAudienceWrite=options.crmMasterAudienceWrite===true;
 if(options.crmMasterAudienceWrite!==undefined&&typeof options.crmMasterAudienceWrite!=='boolean')err('MASTER_AUDIENCE_CONFIG_INVALID',500);
 if(options.crmCampaignWriterProfile!==undefined)try{ownMasterWriter=require('./crm-manager-runtime.cjs').ownMasterWriterDescriptor(options.crmCampaignWriterProfile,options.allowedEmailDomains);}catch{err('MASTER_WRITER_CONFIG_INVALID',500);}
 if(ownMasterAudienceWrite&&!ownMasterWriter)err('MASTER_AUDIENCE_CONFIG_INVALID',500);
 if(ownMasterWriter&&(options.crmManagedRead!==undefined||options.crmManagedWriter!==undefined||options.crmCampaignSubmitWrite!==true||!require('./crm-manager-runtime.cjs').corporateHostsAllowed(options.managerHost,options.areaHosts)||options.bootstrapAdminEmail!=='felipebandeira@oaristocrata.com'))err('MASTER_WRITER_CONFIG_INVALID',500);
 if(options.crmManagedWriter?.mode!==undefined)try{corporateWriter=require('./crm-manager-runtime.cjs').corporateWriterDescriptor(options.crmManagedWriter,options.crmManagedRead,options.allowedEmailDomains);}catch{err('MANAGED_WRITER_CONFIG_INVALID',500);}
 if(corporateWriter&&(!require('./crm-manager-runtime.cjs').corporateHostsAllowed(options.managerHost,options.areaHosts)||options.bootstrapAdminEmail!=='felipebandeira@oaristocrata.com'))err('MANAGED_WRITER_CONFIG_INVALID',500);
 if(options.crmCampaignSubmitWrite!==undefined&&typeof options.crmCampaignSubmitWrite!=='boolean'||options.crmCampaignSubmitWrite===true&&!corporateWriter&&!ownMasterWriter&&(options.crmManagedRead!==undefined||options.allowedEmailDomains.length!==1||options.allowedEmailDomains[0]!=='synthetic.invalid'))err('CAMPAIGN_WRITE_CONFIG_INVALID',500);
 const campaignSubmit=options.crmCampaignSubmitWrite===true;
 const masterWriter=corporateWriter||ownMasterWriter;
 if(options.crmManagedWriter!==undefined&&(!campaignSubmit||!corporateWriter&&(options.crmManagedRead!==undefined||!plain(options.crmManagedWriter)||Object.keys(options.crmManagedWriter).sort().join(',')!=='issuerId,namespaceId'||Object.values(options.crmManagedWriter).some(v=>typeof v!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v)))))err('MANAGED_WRITER_CONFIG_INVALID',500);
 const {dbPath}=options,managerHost=hostname(options.managerHost);
 const areaHosts=Object.fromEntries(AREAS.map(a=>[a,hostname(options.areaHosts[a])]));
 if(new Set([managerHost,...Object.values(areaHosts)]).size!==4)err('CONFIG_INVALID',500);
 const domainSet=new Set(options.allowedEmailDomains.map(hostname));
 const adminEmail=emailAddress(options.bootstrapAdminEmail,domainSet);
 if(!/^[a-f0-9]{64}$/.test(options.bootstrapTokenSha256||''))err('CONFIG_INVALID',500);
 const encKey=Buffer.isBuffer(options.encryptionKey)?options.encryptionKey:typeof options.encryptionKey==='string'&&/^[a-f0-9]{64}$/.test(options.encryptionKey)?Buffer.from(options.encryptionKey,'hex'):null;
 if(!encKey||encKey.length!==32)err('CONFIG_INVALID',500);
 const now=typeof options.now==='function'?options.now:Date.now;
 const current=()=>{const n=now();if(!Number.isSafeInteger(n)||n<0)err('CLOCK_INVALID',500);return n;};
 const knownHost=host=>{const h=hostname(host);if(h!==managerHost&&!Object.values(areaHosts).includes(h))err('HOST_DENIED',403);return h;};
 const originFor=host=>'https://'+host;
 const checkOrigin=(host,origin)=>{if(origin!==originFor(host))err('ORIGIN_DENIED',403);};
 const requireWriteContext=ctx=>{if(!plain(ctx)||ctx.method!=='POST')err('METHOD_DENIED',405);const h=knownHost(ctx.host);checkOrigin(h,ctx.origin);return h;};
 const encrypt=value=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',encKey,iv);const payload=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),payload.toString('base64url')].join('.');};
 const decrypt=value=>{try{const [v,i,t,c]=value.split('.');if(v!=='v1'||!i||!t||!c)throw Error();const decipher=crypto.createDecipheriv('aes-256-gcm',encKey,Buffer.from(i,'base64url'));decipher.setAuthTag(Buffer.from(t,'base64url'));return Buffer.concat([decipher.update(Buffer.from(c,'base64url')),decipher.final()]).toString('utf8');}catch{err('CREDENTIAL_UNAVAILABLE',503);}};
 const db=new DatabaseSync(dbPath);
 try{db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');}catch{db.close();err('DATABASE_UNAVAILABLE',503);}
 if(dbPath!==':memory:')for(const path of [dbPath,dbPath+'-wal',dbPath+'-shm'])try{if(fs.existsSync(path))fs.chmodSync(path,0o600);}catch{db.close();err('DATABASE_PERMISSIONS',503);}
 db.exec(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,role TEXT NOT NULL CHECK(role IN ('superadmin','manager')),
  state TEXT NOT NULL CHECK(state IN ('bootstrap','invited','active','disabled')),
  password_hash TEXT,totp_secret TEXT,totp_last_step INTEGER NOT NULL DEFAULT -1,
  bootstrap_hash TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS grants (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  area TEXT NOT NULL CHECK(area IN ('growth','organico','influs')),
  can_read INTEGER NOT NULL CHECK(can_read IN (0,1)),can_edit INTEGER NOT NULL CHECK(can_edit IN (0,1)),
  PRIMARY KEY(user_id,area));
 CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host TEXT NOT NULL,ui_key TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,idle_expires_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
 CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host TEXT NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER);
 CREATE TABLE IF NOT EXISTS access_requests (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  requested_access TEXT NOT NULL CHECK(requested_access='edit'),
  requested_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS user_profile_updates_v1 (
  user_id TEXT PRIMARY KEY REFERENCES users(id),request_json TEXT NOT NULL,request_mac TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('revoking','completed','cancelled')),invite_ciphertext TEXT,invite_mac TEXT,
  requested_at INTEGER NOT NULL,completed_at INTEGER);
 CREATE TABLE IF NOT EXISTS upstream_credentials (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,slot TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,key_digest TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,slot));
 CREATE INDEX IF NOT EXISTS upstream_key_digest ON upstream_credentials(key_digest);
 CREATE TABLE IF NOT EXISTS campaign_draft_operations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand TEXT NOT NULL CHECK(brand IN ('fish','aristo')),
  operation_key TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('pending','uncertain','succeeded','rejected')),
  receipt_state TEXT,campaign_id INTEGER,updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,brand));
 CREATE TABLE IF NOT EXISTS audience_draft_operations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand TEXT NOT NULL CHECK(brand IN ('fish','aristo')),
  operation_key TEXT NOT NULL,payload_mac TEXT,actor_mac TEXT,definition_mac TEXT,request_id TEXT,expected_version INTEGER,
  action TEXT NOT NULL CHECK(action IN ('segmento_criar','segmento_salvar','segmento_arquivar')),
  phase TEXT NOT NULL CHECK(phase IN ('pending','uncertain','succeeded','rejected')),
  receipt_status INTEGER,receipt_code TEXT,segment_id TEXT,segment_version INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,brand),
  CHECK ((phase IN ('pending','uncertain') AND receipt_status IS NULL AND receipt_code IS NULL AND segment_id IS NULL AND segment_version IS NULL)
   OR (phase='succeeded' AND receipt_status IN (200,201) AND receipt_code IS NULL AND segment_id IS NOT NULL AND segment_version>0)
   OR (phase='rejected' AND receipt_status IN (404,409,422,503) AND receipt_code IS NOT NULL AND segment_id IS NULL AND segment_version IS NULL)));
 CREATE TABLE IF NOT EXISTS login_limits (
  bucket TEXT PRIMARY KEY,attempts INTEGER NOT NULL,first_at INTEGER NOT NULL,locked_until INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS identity_metadata (
  key TEXT PRIMARY KEY,encrypted_value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS user_brand_grants_v1 (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,area TEXT NOT NULL CHECK(area IN ('growth','organico','influs')),
  brand TEXT NOT NULL CHECK(brand IN ('fish','aristo')),scope_mac TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS user_brand_lifecycles_v1 (
  user_id TEXT NOT NULL REFERENCES user_brand_grants_v1(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('read','writer')),lifecycle_id TEXT NOT NULL,scope_mac TEXT NOT NULL,
  PRIMARY KEY(user_id,kind));
 CREATE TABLE IF NOT EXISTS upstream_brand_bindings_v1 (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,slot TEXT NOT NULL,
  binding_mac TEXT NOT NULL,PRIMARY KEY(user_id,slot));`);
 if(corporateWriter)db.exec(`CREATE TABLE IF NOT EXISTS crm_writer_request_authority_v1 (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,authority_mac TEXT NOT NULL);`);
 if(campaignSubmit)db.exec(`CREATE TABLE IF NOT EXISTS campaign_writer_attestation_v1 (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,owner TEXT NOT NULL,principal_id TEXT NOT NULL UNIQUE,
  credential_mac TEXT NOT NULL,expires_at INTEGER NOT NULL,attested_at INTEGER NOT NULL,master_proof_mac TEXT);`);
 if(campaignSubmit&&!db.prepare('PRAGMA table_info(campaign_writer_attestation_v1)').all().some(c=>c.name==='master_proof_mac'))
  db.exec('ALTER TABLE campaign_writer_attestation_v1 ADD COLUMN master_proof_mac TEXT');
 // Existing shadow volumes may already contain an unresolved v1 audience
 // journal. Keep that row locked; a missing MAC cannot authorize a v2 receipt.
 if(!db.prepare('PRAGMA table_info(audience_draft_operations)').all().some(column=>column.name==='payload_mac'))
  db.exec('ALTER TABLE audience_draft_operations ADD COLUMN payload_mac TEXT');
 if(!db.prepare('PRAGMA table_info(audience_draft_operations)').all().some(column=>column.name==='actor_mac'))
  db.exec('ALTER TABLE audience_draft_operations ADD COLUMN actor_mac TEXT');
 for(const [name,type]of [['definition_mac','TEXT'],['request_id','TEXT'],['expected_version','INTEGER']])
  if(!db.prepare('PRAGMA table_info(audience_draft_operations)').all().some(column=>column.name===name))
   db.exec(`ALTER TABLE audience_draft_operations ADD COLUMN ${name} ${type}`);
 const findUser=db.prepare('SELECT * FROM users WHERE email=?');
 db.exec('BEGIN IMMEDIATE');
 try{
  const admins=db.prepare("SELECT * FROM users WHERE role='superadmin'").all();
  if(admins.length>1||admins.length===1&&admins[0].email!==adminEmail)err('ADMIN_CONFIG_DRIFT',500);
  const verifier=db.prepare("SELECT encrypted_value FROM identity_metadata WHERE key='encryption_verifier'").get();
  // Older identity volumes kept an encrypted TOTP secret. Verify that key
  // before establishing the new encrypted verifier; never silently accept a
  // different key for an existing identity.
  if(verifier){if(decrypt(verifier.encrypted_value)!=='shrigma-identity-v1')err('CREDENTIAL_UNAVAILABLE',503);}
  else if(admins.length&&admins[0].totp_secret)decrypt(admins[0].totp_secret);
  if(!verifier)db.prepare("INSERT INTO identity_metadata(key,encrypted_value) VALUES('encryption_verifier',?)").run(encrypt('shrigma-identity-v1'));
  if(!admins.length){
   if(findUser.get(adminEmail))err('ADMIN_CONFIG_DRIFT',500);
   const id=crypto.randomUUID(),t=current();
   db.prepare('INSERT INTO users(id,email,role,state,bootstrap_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,adminEmail,'superadmin','bootstrap',options.bootstrapTokenSha256,t,t);
   for(const a of AREAS)db.prepare('INSERT INTO grants(user_id,area,can_read,can_edit) VALUES(?,?,1,0)').run(id,a);
  }else{
   const admin=admins[0],grants=db.prepare('SELECT area,can_read FROM grants WHERE user_id=?').all(admin.id);
   if(!['bootstrap','active'].includes(admin.state)||grants.length!==3||AREAS.some(a=>!grants.some(g=>g.area===a&&g.can_read===1))||admin.state==='bootstrap'&&admin.bootstrap_hash!==options.bootstrapTokenSha256)err('ADMIN_CONFIG_DRIFT',500);
  }
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');db.close();throw e;}
 // Off by default: records local identity jobs, never starts remote transport
 // or a worker. The private gateway constructor owns this configuration.
 let managedCrm=null,managedWriter=null,nativeConnections=null;
 if(options.crmNativeEnabled!==undefined&&typeof options.crmNativeEnabled!=='boolean')err('NATIVE_CONFIG_INVALID',500);
 if(options.crmManagedRead!==undefined)try{
  managedCrm=require('./crm-manager-journal.cjs').createManagerJournal({db,...options.crmManagedRead,...(corporateWriter?{writerBindingReady:id=>managedWriter?.bindingForUser(id)!==null&&managedWriter!==null,writerRenewalBindingReady:id=>managedWriter?.bindingForRenewal(id)===true}:{}),encrypt,decrypt,digest:value=>crypto.createHmac('sha256',encKey).update('upstream-key:'+value).digest('hex'),now:current});
 }catch{db.close();err('MANAGED_CONFIG_INVALID',500);}
 if(options.crmManagedWriter!==undefined)try{
  managedWriter=require('./crm-manager-writer-auth-adapter.cjs').createWriterAuthAdapter({db,enabled:true,profile:corporateWriter?'corporate-read-writer-v1':'crm-sandbox',issuerId:options.crmManagedWriter.issuerId,namespaceId:options.crmManagedWriter.namespaceId,...(corporateWriter?{readReady:id=>managedCrm.credentialReady(id)===true}:{}),allowedEmailDomains:options.allowedEmailDomains,encrypt,decrypt,digest:value=>crypto.createHmac('sha256',encKey).update('upstream-key:'+value).digest('hex'),brandForUser:id=>{try{return requireBrandScope(db.prepare('SELECT * FROM users WHERE id=?').get(id)).brand;}catch{return null;}},now:current});
 }catch{db.close();err('MANAGED_WRITER_CONFIG_INVALID',500);}
 function writerCall(fn){try{return fn();}catch{err('MANAGED_WRITER_STORE_UNAVAILABLE',503);}}
 function managedCall(fn){try{return fn();}catch(e){if(e?.code==='MANAGED_REVOCATION_REQUIRED')err(e.code,409);err('MANAGED_STORE_UNAVAILABLE',503);}}
 // Only the current lifecycle's open renewal is projected into the admin
 // list. Private operation IDs and candidate material never leave the store.
 function managedRenewalPhase(userId){
  if(!managedCrm)return null;
  return db.prepare("SELECT o.phase FROM crm_manager_operations_v1 o JOIN crm_manager_current_v1 c USING(lifecycle_id) JOIN crm_manager_lifecycles_v1 l USING(lifecycle_id) WHERE c.user_id=? AND o.kind='renew' AND o.lifecycle_version=l.version AND l.state='ready' AND o.phase IN ('queued','prepare_uncertain','prepared','attested','commit_uncertain','committed')").get(userId)?.phase??null;
 }
 function managedAccess(user){
  if(ownMasterWriter&&user.role==='manager'&&permissions(user.id).growth?.read===true)return {state:'unavailable',ready:false,operational:false,reason:'INDIVIDUAL_ACCESS_NOT_READY',renewalPhase:null,expired:false,canRenew:false};
  const status=managedCrm?.status(user.id);if(!status)return null;
  const scoped=brandScope(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)).brandAccess!=='reprovision_required';
  const renewalPhase=managedRenewalPhase(user.id),ready=scoped&&managedCrm.credentialReady(user.id)===true;
  const expired=status.state==='ready'&&Number.isSafeInteger(status.expiresAt)&&status.expiresAt<=current();
  const edit=permissions(user.id).growth?.edit,writer=corporateWriter?managedWriter.publicState(user.id):null;
  const writerRevocationPending=writer?.state==='revoking',writerRenewalPending=typeof writer?.renewalPhase==='string';
  const pending=corporateWriter&&(managedWriter.hasPendingCampaigns(user.id)||unresolvedAudienceDraft(user.id));
  const renewalReady=corporateWriter?managedCrm.renewalReady(user.id)===true:ready&&!expired;
  const canRenew=scoped&&(edit===false||corporateWriter&&managedWriter.bindingForRenewal(user.id)===true)&&user.role==='manager'&&user.state==='active'&&status.state==='ready'&&renewalReady&&renewalPhase===null&&!pending&&!writerRevocationPending&&!writerRenewalPending;
  return {...status,ready,renewalPhase,expired,canRenew,...(corporateWriter?{writerRevocationPending}: {})};
 }
 let hashing=false;const waiters=[];
 async function derive(password,salt){
  if(hashing){if(waiters.length>=8)err('AUTH_BUSY',503);await new Promise(resolve=>waiters.push(resolve));}
  else hashing=true;
  try{return await scrypt(password,salt,64,SCRYPT);}finally{
   // Keep the lock held while handing it to the next waiter. Releasing it
   // first lets a new login race the waiter and run a second 128 MiB scrypt.
   const next=waiters.shift();if(next)next();else hashing=false;
  }
 }
 async function hashPassword(password){const salt=crypto.randomBytes(16),hash=await derive(validPassword(password),salt);return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;}
 async function verifyPassword(password,encoded){
  if(typeof password!=='string'||password.length>128||Buffer.byteLength(password)>256)return false;
  let salt=DUMMY_SALT,expected=Buffer.alloc(64);
  if(typeof encoded==='string'){
   const parts=encoded.split('$');if(parts.length===6&&parts[0]==='scrypt'&&parts[1]===String(SCRYPT.N)&&parts[2]===String(SCRYPT.r)&&parts[3]===String(SCRYPT.p)){
    try{const s=Buffer.from(parts[4],'base64url'),h=Buffer.from(parts[5],'base64url');if(s.length===16&&h.length===64){salt=s;expected=h;}}catch{}
   }
  }
  const actual=await derive(password,salt);return crypto.timingSafeEqual(actual,expected);
 }
 const brandMac=value=>crypto.createHmac('sha256',encKey).update('identity-brand-v1:'+JSON.stringify(value)).digest('hex');
 const validBrand=(area,brand)=>AREA_SET.has(area)&&AREA_BRANDS[area].includes(brand);
 function brandScope(user){
  if(user.role==='superadmin')return {brand:null,brands:[...BRANDS],brandAccess:'all'};
  const row=db.prepare('SELECT * FROM user_brand_grants_v1 WHERE user_id=?').get(user.id);
  const p=permissions(user.id),areas=Object.keys(p);
  if(!row||row.owner!==user.email||areas.length!==1||areas[0]!==row.area||!validBrand(row.area,row.brand)||!equalHex(row.scope_mac,brandMac([user.id,user.email,row.area,row.brand])))return {brand:null,brands:[],brandAccess:'reprovision_required'};
  for(const [kind,table]of [['read','crm_manager_current_v1'],['writer','crm_writer_auth_admission_v1']]){
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
   const life=db.prepare(`SELECT lifecycle_id FROM ${table} WHERE user_id=?`).get(user.id);
   if(!life)continue;
   const bound=db.prepare('SELECT * FROM user_brand_lifecycles_v1 WHERE user_id=? AND kind=?').get(user.id,kind);
   if(!bound||bound.lifecycle_id!==life.lifecycle_id||!equalHex(bound.scope_mac,brandMac([row.scope_mac,kind,life.lifecycle_id])))return {brand:null,brands:[],brandAccess:'reprovision_required'};
  }
  return {brand:row.brand,brands:[row.brand],brandAccess:'single'};
 }
 function requireBrandScope(user){if(!user)err('USER_DENIED',404);const scope=brandScope(user);if(scope.brandAccess==='reprovision_required')err('BRAND_REPROVISION_REQUIRED',403);return scope;}
 function bindBrandLifecycle(userId,kind,lifecycleId){
  const row=db.prepare('SELECT * FROM user_brand_grants_v1 WHERE user_id=?').get(userId);
  if(!row||!['read','writer'].includes(kind)||typeof lifecycleId!=='string')err('BRAND_BINDING_INVALID',500);
  const owner=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if(!owner||row.owner!==owner.email||!equalHex(row.scope_mac,brandMac([owner.id,owner.email,row.area,row.brand])))err('BRAND_BINDING_INVALID',500);
  db.prepare('INSERT INTO user_brand_lifecycles_v1(user_id,kind,lifecycle_id,scope_mac) VALUES(?,?,?,?) ON CONFLICT(user_id,kind) DO UPDATE SET lifecycle_id=excluded.lifecycle_id,scope_mac=excluded.scope_mac').run(userId,kind,lifecycleId,brandMac([row.scope_mac,kind,lifecycleId]));
 }
 function bindCurrentBrandLifecycles(userId){
  if(managedCrm){const life=db.prepare('SELECT lifecycle_id FROM crm_manager_current_v1 WHERE user_id=?').get(userId);if(life)bindBrandLifecycle(userId,'read',life.lifecycle_id);}
  if(managedWriter){const life=db.prepare('SELECT lifecycle_id FROM crm_writer_auth_admission_v1 WHERE user_id=?').get(userId);if(life)bindBrandLifecycle(userId,'writer',life.lifecycle_id);}
 }
 // Written only by an original Master CSRF operation. Old unsigned edit
 // requests are never backfilled or silently promoted by the private worker.
 function writerRequestAuthority(userId){
  if(!corporateWriter)return null;
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(userId),r=db.prepare("SELECT requested_at FROM access_requests WHERE user_id=? AND requested_access='edit'").get(userId);
  if(!user||!r||user.role!=='manager'||!['active','invited'].includes(user.state))return null;
  const scope=requireBrandScope(user),read=db.prepare('SELECT lifecycle_id FROM crm_manager_current_v1 WHERE user_id=?').get(userId);
  if(scope.brandAccess!=='single'||!['fish','aristo'].includes(scope.brand)||!read)return null;
  const p=permissions(userId);if(Object.keys(p).length!==1||p.growth?.read!==true)return null;
  return brandMac(['writer-request-v1',user.id,user.email,'growth',scope.brand,read.lifecycle_id,r.requested_at]);
 }
 function recordWriterRequestAuthority(userId){
  if(!corporateWriter)return;
  db.prepare('DELETE FROM crm_writer_request_authority_v1 WHERE user_id=?').run(userId);
  const mac=writerRequestAuthority(userId);if(mac)db.prepare('INSERT INTO crm_writer_request_authority_v1 VALUES(?,?)').run(userId,mac);
 }
 // No session/context is fabricated: persistent exact Master-authorized intent
 // plus the current signed brand and actually committed READ are the authority.
 function fulfillManagedCampaignWriterRequests(){
  if(!corporateWriter||!campaignSubmit||!managedWriter||!managedCrm)return {queued:0};
  const rows=db.prepare("SELECT u.id FROM users u JOIN access_requests r ON r.user_id=u.id JOIN crm_writer_request_authority_v1 a ON a.user_id=u.id JOIN crm_manager_current_v1 c ON c.user_id=u.id JOIN crm_manager_lifecycles_v1 l ON l.lifecycle_id=c.lifecycle_id WHERE u.role='manager' AND u.state='active' AND r.requested_access='edit' AND l.state='ready' AND NOT EXISTS(SELECT 1 FROM crm_writer_bridge_life_v1 w WHERE w.user_id=u.id AND w.state<>'revoked') ORDER BY r.requested_at,u.id LIMIT 8").all();let queued=0;
  for(const {id}of rows){
   try{
    if(managedCrm.credentialReady(id)!==true||managedWriter.bindingForUser(id)||db.prepare("SELECT 1 FROM crm_writer_bridge_life_v1 WHERE user_id=? AND state<>'revoked'").get(id))continue;
    db.exec('BEGIN IMMEDIATE');try{
     const signed=db.prepare('SELECT authority_mac FROM crm_writer_request_authority_v1 WHERE user_id=?').get(id),mac=writerRequestAuthority(id),read=managedCrm.readBinding(id),user=db.prepare('SELECT * FROM users WHERE id=?').get(id);
     if(!signed||!mac||!equalHex(signed.authority_mac,mac)||user.state!=='active'||read.owner!==user.email||managedCrm.credentialReady(id)!==true||permissions(id).growth?.edit!==false)err('CRM_WRITER_REQUEST_REQUIRED',409);
     if(unresolvedAudienceDraft(id)||unresolvedCampaignDraft(id)||unresolvedCampaignDelivery(id)||managedWriter.hasPendingCampaigns(id))err('CAMPAIGN_RECONCILIATION_REQUIRED',409);
     if(managedWriter.publicState(id)===null){writerCall(()=>managedWriter.requestLifecycle(id));bindCurrentBrandLifecycles(id);}
     writerCall(()=>managedWriter.approve(id));bindCurrentBrandLifecycles(id);db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    // Original durable queue owns a separate transaction; a failed enqueue
    // leaves its exact inactive approval recoverable by this bounded scan.
    writerCall(()=>managedWriter.journal.enqueue(id,'issue'));queued++;
   }catch{}
  }
  return Object.freeze({queued});
 }
 function upstreamBindingMac(user,slot,row){
  const scope=requireBrandScope(user);
  return brandMac([user.id,user.email,slot,scope.brandAccess,scope.brand,row.key_digest,sha(row.encrypted_key)]);
 }
 function recordUpstreamBinding(user,slot,row){db.prepare('INSERT INTO upstream_brand_bindings_v1(user_id,slot,binding_mac) VALUES(?,?,?) ON CONFLICT(user_id,slot) DO UPDATE SET binding_mac=excluded.binding_mac').run(user.id,slot,upstreamBindingMac(user,slot,row));}
 function permissions(userId){const out={};for(const g of db.prepare('SELECT area,can_read,can_edit FROM grants WHERE user_id=? AND can_read=1').all(userId))out[g.area]={read:true,edit:g.can_edit===1};return out;}
 function publicUser(user){const p=permissions(user.id);return {id:user.id,email:user.email,role:user.role,areas:AREAS.filter(a=>p[a]?.read),permissions:p,...brandScope(user)};}
 function beginBootstrap({email,token,host,origin}){
  const h=knownHost(host);if(h!==managerHost)err('HOST_DENIED',403);checkOrigin(h,origin);
  const user=findUser.get(emailAddress(email,domainSet));
  if(!user||user.email!==adminEmail||user.role!=='superadmin'||user.state!=='bootstrap'||!equalHex(sha(String(token||'')),user.bootstrap_hash))err('BOOTSTRAP_DENIED',403);
  return {ready:true};
 }
 async function completeBootstrap({email,token,password,host,origin}){
  const h=knownHost(host);if(h!==managerHost)err('HOST_DENIED',403);checkOrigin(h,origin);
  const user=findUser.get(emailAddress(email,domainSet));
  if(!user||user.email!==adminEmail||user.state!=='bootstrap'||!equalHex(sha(String(token||'')),user.bootstrap_hash))err('BOOTSTRAP_DENIED',403);
  const hash=await hashPassword(password),t=current();
  const result=db.prepare("UPDATE users SET state='active',password_hash=?,bootstrap_hash=NULL,updated_at=? WHERE id=? AND state='bootstrap' AND bootstrap_hash=?").run(hash,t,user.id,user.bootstrap_hash);
  if(result.changes!==1)err('BOOTSTRAP_DENIED',403);return {ok:true};
 }
 function bucket(key,t){const row=db.prepare('SELECT * FROM login_limits WHERE bucket=?').get(key);if(!row||t-row.first_at>=RATE_MS){db.prepare('INSERT INTO login_limits(bucket,attempts,first_at,locked_until) VALUES(?,0,?,0) ON CONFLICT(bucket) DO UPDATE SET attempts=0,first_at=excluded.first_at,locked_until=0').run(key,t);return {attempts:0,locked_until:0};}return row;}
 function recordAttempt(keys,t){for(const [key,limit]of keys){const row=bucket(key,t),attempts=row.attempts+1;db.prepare('UPDATE login_limits SET attempts=?,locked_until=? WHERE bucket=?').run(attempts,attempts>=limit?t+RATE_MS:row.locked_until,key);}}
 function cleanSuccess(keys){for(const [key]of keys)db.prepare('DELETE FROM login_limits WHERE bucket=?').run(key);}
 async function login({email,password,host,origin,ip='unknown'}){
  const h=knownHost(host);checkOrigin(h,origin);const t=current();
  // Random nonexistent emails must not leave permanent rows. The process-wide
  // ceiling also bounds scrypt work and new buckets until the next window;
  // production still needs a trusted-client limit at the edge for availability.
  db.prepare('DELETE FROM login_limits WHERE first_at<=? AND locked_until<=?').run(t-RATE_MS,t);
  const globalKey=sha('login-global-v1');
  if(bucket(globalKey,t).locked_until>t)err('AUTH_RATE_LIMIT',429);
  let normalized;try{normalized=emailAddress(email,domainSet);}catch{normalized=String(email||'').slice(0,254).toLowerCase();}
  const client=typeof ip==='string'&&ip.length<=128?ip:'unknown';
  // The socket IP can be Traefik for every employee. Never trust a raw
  // X-Forwarded-For header supplied by the browser as a separate client.
  const keys=[[sha('account:'+normalized),10],[sha('account-ip:'+normalized+'|'+client),5]];
  if(keys.some(([key])=>bucket(key,t).locked_until>t))err('AUTH_RATE_LIMIT',429);
  // Reserve the attempt before the costly hash. Concurrent guesses cannot all
  // pass a stale counter and outrun the per-account ceiling.
  recordAttempt([[globalKey,GLOBAL_LOGIN_ATTEMPTS],...keys],t);
  const user=findUser.get(normalized),valid=await verifyPassword(password,user?.state==='active'?user.password_hash:null);
  const area=Object.entries(areaHosts).find(([,value])=>value===h)?.[0];
  const managerAreas=user?.role==='manager'?AREAS.filter(a=>permissions(user.id)[a]?.read):[];
  const allowed=!!(user&&user.state==='active'&&valid&&(user.role==='superadmin'?h===managerHost||ownMasterWriter&&h===areaHosts.growth:user.role==='manager'&&area&&managerAreas.length===1&&managerAreas[0]===area));
  if(!allowed)err('AUTH_INVALID',401);
  requireBrandScope(user);
  cleanSuccess(keys);
  // This public marker identifies a legacy browser journal, not a session.
  // Keep it stable across sign-ins so a lost acknowledgement can be consulted
  // by the same person. Cookies and CSRF secrets still rotate on every login.
  const token=random(),uiKey=publicUiKey(user.id),sessionMarker='ui-'+crypto.randomBytes(16).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at<=? OR idle_expires_at<=?').run(t,t);
  db.prepare('INSERT INTO sessions(token_hash,user_id,host,ui_key,created_at,expires_at,idle_expires_at) VALUES(?,?,?,?,?,?,?)').run(sha(token),user.id,h,sessionMarker,t,t+SESSION_MS,t+IDLE_MS);
  return {cookie:cookie(token,Math.floor(SESSION_MS/1000)),user:publicUser(user),csrf:crypto.createHmac('sha256',encKey).update('csrf:'+token).digest('base64url'),uiKey};
 }
 function lookup(ctx,refresh=true){
  const h=knownHost(ctx?.host);
  if(ctx?.nativeBearer!==undefined){
   if(!nativeConnections)return null;
   let proof;try{proof=nativeConnections.authenticate(ctx.nativeBearer);}catch{return null;}
   if(proof.host!==h)return null;
   const raw=db.prepare('SELECT * FROM users WHERE id=?').get(proof.userId);
   if(!raw||raw.role!=='superadmin'||raw.state!=='active'||h!==managerHost)return null;
   return {user:publicUser(raw),csrf:nativeConnections.context(ctx.nativeBearer).csrf,uiKey:publicUiKey(raw.id),tokenHash:null,host:h};
  }
  const token=cookieToken(ctx?.cookieHeader);if(!token)return null;
  const row=db.prepare('SELECT s.*,u.email,u.role,u.state FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.host=?').get(sha(token),h);
  const t=current();if(!row||row.state!=='active'||row.expires_at<=t||row.idle_expires_at<=t)return null;
  const area=Object.entries(areaHosts).find(([,v])=>v===h)?.[0],perms=permissions(row.user_id);
  const managerAreas=AREAS.filter(a=>perms[a]?.read);
  if(h===managerHost&&row.role!=='superadmin'||area&&!(ownMasterWriter&&area==='growth'&&row.role==='superadmin')&&(row.role!=='manager'||managerAreas.length!==1||managerAreas[0]!==area))return null;
  const scope=brandScope({id:row.user_id,email:row.email,role:row.role});if(scope.brandAccess==='reprovision_required')return null;
  if(refresh)db.prepare('UPDATE sessions SET idle_expires_at=? WHERE token_hash=?').run(Math.min(row.expires_at,t+IDLE_MS),row.token_hash);
  const user={id:row.user_id,email:row.email,role:row.role,areas:AREAS.filter(a=>perms[a]?.read),permissions:perms,...scope};
  const csrf=crypto.createHmac('sha256',encKey).update('csrf:'+token).digest('base64url');
  return {user,csrf,uiKey:publicUiKey(user.id),tokenHash:row.token_hash,host:h};
 }
 function publicUiKey(userId){return 'ui-'+crypto.createHmac('sha256',encKey).update('ui-principal-v2:'+userId).digest('hex').slice(0,32);}
 function session(ctx){const found=lookup(ctx);return found?{authenticated:true,user:found.user,csrf:found.csrf,uiKey:found.uiKey}:{authenticated:false};}
 function authorize(ctx={}){
  const found=lookup(ctx);if(!found)err('SESSION_REQUIRED',401);
  const method=ctx.method||'GET';if(!['GET','HEAD','POST'].includes(method))err('METHOD_DENIED',405);
  // Legacy upstream mutations use GET. Treat the edit policy as a mutation
  // regardless of the HTTP verb, including for same-site sibling origins.
  if(method==='POST'||ctx.edit===true){
   if(method==='POST')requireWriteContext(ctx);
   else checkOrigin(found.host,ctx.origin);
   if(typeof ctx.csrf!=='string'||ctx.csrf.length!==found.csrf.length||!crypto.timingSafeEqual(Buffer.from(ctx.csrf),Buffer.from(found.csrf)))err('CSRF_DENIED',403);
  }
  if(ctx.admin){if(found.host!==managerHost||found.user.role!=='superadmin')err('ADMIN_REQUIRED',403);}
  if(ctx.area!==undefined){
   if(!AREA_SET.has(ctx.area))err('AREA_DENIED',403);
   const areaHost=areaHosts[ctx.area];if(found.host!==managerHost&&found.host!==areaHost)err('AREA_DENIED',403);
   if(!found.user.permissions[ctx.area]?.read||ctx.edit&&!found.user.permissions[ctx.area]?.edit)err('GRANT_DENIED',403);
   if(ownMasterWriter&&ctx.area==='growth'&&ctx.edit===true&&found.user.role!=='superadmin')err('EDIT_NOT_READY',403);
  }
  if(ctx.brand!==undefined){
   if(!BRANDS.includes(ctx.brand))err('BRAND_INVALID',400);
   if(found.user.role!=='superadmin'&&found.user.brand!==ctx.brand)err('BRAND_DENIED',403);
  }
  return found.user;
 }
 function authorizeBrand(ctx,brand){if(brand===undefined)err('BRAND_REQUIRED',400);return authorize({...ctx,brand});}
 function logout(ctx){const h=requireWriteContext(ctx),found=lookup({...ctx,host:h},false);if(found){authorize({...ctx,host:h});db.prepare('DELETE FROM sessions WHERE token_hash=?').run(found.tokenHash);}return {cookie:cookie('',0)};}
 function adminContext(context){const ctx={...context,admin:true};if(ctx.method!=='POST')err('METHOD_DENIED',405);return authorize(ctx);}
 function createInvite({context,email,areas,brand,permissions:requested,requestedAccess='read',expiresMs=INVITE_MS}){
  adminContext(context);const e=emailAddress(email,domainSet),p=invitePermissions(areas,requested);
  if(!validBrand(areas[0],brand))err('BRAND_INVALID',400);
  if((managedCrm||managedWriter||ownMasterWriter)&&p.growth?.edit)err('EDIT_NOT_READY',403);
  if(!['read','edit'].includes(requestedAccess))err('ACCESS_REQUEST_INVALID',400);
  if(!Number.isSafeInteger(expiresMs)||expiresMs<5*60*1000||expiresMs>72*60*60*1000)err('INVITE_INVALID',400);
  const existing=findUser.get(e);if(existing&&existing.state!=='disabled')err('USER_EXISTS',409);
  if(existing){const old=db.prepare('SELECT * FROM user_brand_grants_v1 WHERE user_id=?').get(existing.id);if(old&&(old.owner!==e||old.area!==areas[0]||old.brand!==brand||!equalHex(old.scope_mac,brandMac([existing.id,e,old.area,old.brand]))))err('BRAND_CHANGE_REQUIRES_NEW_IDENTITY',409);}
  const t=current(),id=existing?.id||crypto.randomUUID(),token=random(),host=areaHosts[areas[0]];
  db.exec('BEGIN IMMEDIATE');try{
   if(existing&&unresolvedAudienceDraft(existing.id))err('AUDIENCE_RECONCILIATION_REQUIRED',409);
   if(existing&&unresolvedCampaignDelivery(existing.id))err('CAMPAIGN_RECONCILIATION_REQUIRED',409);
   if(existing&&p.growth?.edit&&unresolvedCampaignDraft(existing.id))err('DRAFT_RECONCILIATION_REQUIRED',409);
   db.prepare('DELETE FROM invites WHERE expires_at<=? OR used_at IS NOT NULL').run(t);
   if(existing){db.prepare("UPDATE users SET role='manager',state='invited',password_hash=NULL,totp_secret=NULL,totp_last_step=-1,updated_at=? WHERE id=? AND state='disabled'").run(t,id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);db.prepare('DELETE FROM upstream_credentials WHERE user_id=?').run(id);db.prepare('DELETE FROM invites WHERE user_id=?').run(id);}
   else db.prepare('INSERT INTO users(id,email,role,state,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,e,'manager','invited',t,t);
   db.prepare('DELETE FROM upstream_brand_bindings_v1 WHERE user_id=?').run(id);
   db.prepare('DELETE FROM grants WHERE user_id=?').run(id);
   for(const [area,g]of Object.entries(p))db.prepare('INSERT INTO grants(user_id,area,can_read,can_edit) VALUES(?,?,1,?)').run(id,area,g.edit?1:0);
   db.prepare('INSERT INTO user_brand_grants_v1(user_id,owner,area,brand,scope_mac) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO NOTHING').run(id,e,areas[0],brand,brandMac([id,e,areas[0],brand]));
   db.prepare('DELETE FROM access_requests WHERE user_id=?').run(id);
   if(requestedAccess==='edit')db.prepare("INSERT INTO access_requests(user_id,requested_access,requested_at) VALUES(?,'edit',?)").run(id,t);
   db.prepare('INSERT INTO invites(token_hash,user_id,host,expires_at) VALUES(?,?,?,?)').run(sha(token),id,host,t+expiresMs);
   if(managedCrm&&p.growth?.read)managedCall(()=>managedCrm.createLifecycle(id));
   if(managedWriter&&p.growth?.read)writerCall(()=>managedWriter.createLifecycle(id));
   bindCurrentBrandLifecycles(id);recordWriterRequestAuthority(id);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {token,userId:id,host};
 }
 async function acceptInvite({token,password,host,origin}){
  const h=knownHost(host);checkOrigin(h,origin);
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))err('INVITE_DENIED',403);
  const t=current(),hash=sha(token),invite=db.prepare('SELECT i.*,u.state FROM invites i JOIN users u ON u.id=i.user_id WHERE i.token_hash=?').get(hash);
  if(!invite||invite.host!==h||invite.state!=='invited'||invite.used_at!==null||invite.expires_at<=t)err('INVITE_DENIED',403);
  const passwordHash=await hashPassword(password),acceptedAt=current();
  db.exec('BEGIN IMMEDIATE');try{
   const used=db.prepare('UPDATE invites SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?').run(acceptedAt,hash,acceptedAt);
   if(used.changes!==1)err('INVITE_DENIED',403);
   const subject=db.prepare('SELECT * FROM users WHERE id=?').get(invite.user_id);requireBrandScope(subject);
   const activated=db.prepare("UPDATE users SET password_hash=?,state='active',updated_at=? WHERE id=? AND state='invited'").run(passwordHash,acceptedAt,invite.user_id);
   if(activated.changes!==1)err('INVITE_DENIED',403);
   if(managedCrm&&permissions(invite.user_id).growth?.read&&managedCrm.status(invite.user_id))managedCall(()=>managedCrm.activateLifecycle(invite.user_id));
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {ok:true};
 }
 // Profile transfers are durable, Master-authorized intentions. Existing
 // credentials/lifecycles are retired before any new owner, area or brand binds.
 const updateTable=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
 function profileRevision(userId){
  const user=db.prepare('SELECT id,email,role,state,updated_at FROM users WHERE id=?').get(userId);
  if(!user)return null;
  const row=db.prepare('SELECT request_mac,phase,invite_mac FROM user_profile_updates_v1 WHERE user_id=?').get(userId);
  const read=updateTable('crm_manager_current_v1')?db.prepare('SELECT l.lifecycle_id,l.owner,l.version,l.state,l.active_generation,l.active_principal FROM crm_manager_current_v1 c JOIN crm_manager_lifecycles_v1 l USING(lifecycle_id) WHERE c.user_id=?').get(userId):null;
  const writer=updateTable('crm_writer_auth_admission_v1')?db.prepare('SELECT lifecycle_id,version,owner,approved FROM crm_writer_auth_admission_v1 WHERE user_id=?').get(userId):null;
  const binding=updateTable('crm_writer_auth_binding_v1')?db.prepare('SELECT lifecycle_id,version,owner,generation,credential_mac FROM crm_writer_auth_binding_v1 WHERE user_id=?').get(userId):null;
  return brandMac(['profile-revision-v1',user,permissions(userId),db.prepare('SELECT * FROM user_brand_grants_v1 WHERE user_id=?').get(userId)||null,db.prepare('SELECT * FROM user_brand_lifecycles_v1 WHERE user_id=? ORDER BY kind').all(userId),db.prepare('SELECT * FROM access_requests WHERE user_id=?').get(userId)||null,read||null,writer||null,binding||null,row||null]);
 }
 function updateIntent(userId){
  const row=db.prepare('SELECT * FROM user_profile_updates_v1 WHERE user_id=?').get(userId);if(!row)return null;
  let q;try{q=JSON.parse(row.request_json);}catch{err('USER_UPDATE_INTEGRITY',409);}
  if(!q||q.userId!==userId||!equalHex(row.request_mac,brandMac(['profile-update-intent-v1',q])))err('USER_UPDATE_INTEGRITY',409);
  return {row,q};
 }
 function updateRetired(intent,confirmed=true){
  const {q}=intent,user=db.prepare('SELECT * FROM users WHERE id=?').get(q.userId);
  if(!user||user.role!=='manager'||user.state!=='disabled'||user.email!==q.oldEmail)return false;
  try{const scope=requireBrandScope(user);if(scope.brand!==q.oldBrand||Object.keys(permissions(q.userId))[0]!==q.oldArea)return false;}catch{return false;}
  if(q.read){const read=db.prepare('SELECT l.* FROM crm_manager_current_v1 c JOIN crm_manager_lifecycles_v1 l USING(lifecycle_id) WHERE c.user_id=?').get(q.userId);if(!read||read.lifecycle_id!==q.read.lifecycleId||read.version!==q.read.version||read.owner!==q.oldEmail||!(confirmed?read.state==='revoked':['revoking','revoked'].includes(read.state))||confirmed&&!db.prepare("SELECT 1 FROM crm_manager_operations_v1 WHERE lifecycle_id=? AND kind='revoke' AND phase='revoked' AND revoked_proof_mac IS NOT NULL").get(read.lifecycle_id))return false;}
  if(q.writer){const a=db.prepare('SELECT * FROM crm_writer_auth_admission_v1 WHERE user_id=?').get(q.userId);if(!a||a.lifecycle_id!==q.writer.lifecycleId||a.version!==q.writer.version||a.owner!==q.oldEmail||a.approved!==0)return false;const life=db.prepare('SELECT * FROM crm_writer_bridge_life_v1 WHERE lifecycle_id=?').get(a.lifecycle_id);if(life&&(!(confirmed?life.state==='revoked':['revoking','revoked'].includes(life.state))||confirmed&&!db.prepare("SELECT 1 FROM crm_writer_bridge_op_v1 WHERE lifecycle_id=? AND kind='revoke' AND phase='revoked'").get(a.lifecycle_id)))return false;}
  return !db.prepare('SELECT 1 FROM upstream_credentials WHERE user_id=?').get(q.userId)&&(!managedWriter||!managedWriter.bindingForUser(q.userId));
 }
 function profileUpdateMetadata(userId){
  const intent=updateIntent(userId);if(!intent||intent.row.phase==='cancelled')return null;
  const {row,q}=intent;
  let inviteAvailable=false;
  if(row.phase==='completed'){const i=db.prepare('SELECT * FROM invites WHERE user_id=? AND used_at IS NULL AND expires_at>?').get(userId,current());inviteAvailable=!!i&&!!row.invite_ciphertext;}
  return {state:row.phase==='completed'?'completed':updateRetired(intent)?'ready':'revoking',email:q.email,area:q.area,brand:q.brand,access:q.access,inviteAvailable,canCorrect:row.phase==='revoking'&&updateRetired(intent,false)};
 }
 function updateUserProfile({context,userId,expectedRevision,email,area,brand,access}){
  const actor=adminContext(context);
  if(typeof userId!=='string'||typeof expectedRevision!=='string'||!/^[a-f0-9]{64}$/.test(expectedRevision))err('USER_UPDATE_INVALID',400);
  const e=emailAddress(email,domainSet);if(!AREA_SET.has(area)||!validBrand(area,brand)||!['read','edit'].includes(access))err('USER_UPDATE_INVALID',400);
  const old=db.prepare('SELECT * FROM users WHERE id=?').get(userId);if(!old||old.role!=='manager')err('USER_DENIED',404);
  const prior=updateIntent(userId);
  if(prior&&prior.row.phase==='revoking'){
   if(prior.q.actorId===actor.id&&prior.q.originalRevision===expectedRevision&&prior.q.email===e&&prior.q.area===area&&prior.q.brand===brand&&prior.q.access===access)return {ok:true,state:profileUpdateMetadata(userId).state}; // Same intention, no second revoke.
   // A fresh Master-CSRF choice may correct a queued destination. The retired
   // subject, lifecycle versions and revoke operations remain unchanged.
   if(!equalHex(expectedRevision,profileRevision(userId)))err('USER_CHANGED',409);
   if(!updateRetired(prior,false))err('USER_UPDATE_PENDING',409);
   const collision=findUser.get(e);if(collision&&collision.id!==userId)err('USER_EXISTS',409);
   db.exec('BEGIN IMMEDIATE');try{
    if(!equalHex(expectedRevision,profileRevision(userId))||updateIntent(userId)?.row.request_mac!==prior.row.request_mac||!updateRetired(prior,false))err('USER_CHANGED',409);
    const q={...prior.q,actorId:actor.id,actorEmail:actor.email,originalRevision:expectedRevision,email:e,area,brand,access,requestedAt:current()};
    db.prepare("UPDATE user_profile_updates_v1 SET request_json=?,request_mac=?,requested_at=? WHERE user_id=? AND phase='revoking' AND request_mac=?").run(JSON.stringify(q),brandMac(['profile-update-intent-v1',q]),q.requestedAt,userId,prior.row.request_mac);
    db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');throw error;}
   return {ok:true,state:profileUpdateMetadata(userId).state};
  }
  if(!equalHex(expectedRevision,profileRevision(userId)))err('USER_CHANGED',409);
  if(!['active','invited'].includes(old.state))err('USER_DENIED',404);
  const scope=requireBrandScope(old),areas=Object.keys(permissions(userId));if(areas.length!==1)err('GRANTS_INVALID',400);
  if(old.email===e&&areas[0]===area&&scope.brand===brand){const result=setRequestedAccess({context,userId,requestedAccess:access});return {...result,state:'configured'};}
  const collision=findUser.get(e);if(collision&&collision.id!==userId)err('USER_EXISTS',409);
  // Unmanaged native keys cannot be certified retired by this bridge.
  const slots=db.prepare('SELECT slot,key_digest FROM upstream_credentials WHERE user_id=?').all(userId);
  for(const slot of slots){
   if(slot.slot==='crm-panel-read'&&(managedCrm?.credentialReady(userId)===true||managedCrm?.renewalReady(userId)===true))continue;
   if(slot.slot==='growth-campaign'&&(managedWriter?.bindingForUser(userId)||managedWriter?.bindingForRenewal(userId)===true))continue;
   err('USER_UPDATE_CREDENTIAL_REVOCATION_REQUIRED',409);
  }
  if(unresolvedAudienceDraft(userId))err('AUDIENCE_RECONCILIATION_REQUIRED',409);
  if(unresolvedCampaignDraft(userId)||unresolvedCampaignDelivery(userId)||managedWriter?.hasPendingCampaigns(userId))err('CAMPAIGN_RECONCILIATION_REQUIRED',409);
  db.exec('BEGIN IMMEDIATE');try{
   if(!equalHex(expectedRevision,profileRevision(userId)))err('USER_CHANGED',409);
   if(managedCrm?.status(userId))managedCall(()=>managedCrm.stageRevoke(userId));
   if(managedWriter)writerCall(()=>managedWriter.stageRevoke(userId));
   db.prepare("UPDATE users SET state='disabled',password_hash=NULL,updated_at=? WHERE id=?").run(current(),userId);
   db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);db.prepare('DELETE FROM invites WHERE user_id=?').run(userId);
   db.prepare('DELETE FROM access_requests WHERE user_id=?').run(userId);db.prepare('DELETE FROM upstream_credentials WHERE user_id=?').run(userId);
   db.prepare('UPDATE grants SET can_edit=0 WHERE user_id=?').run(userId);
   const read=managedCrm?db.prepare('SELECT l.lifecycle_id,l.version FROM crm_manager_current_v1 c JOIN crm_manager_lifecycles_v1 l USING(lifecycle_id) WHERE c.user_id=?').get(userId):null;
   const writer=managedWriter?db.prepare('SELECT lifecycle_id,version FROM crm_writer_auth_admission_v1 WHERE user_id=?').get(userId):null;
   const q={userId,actorId:actor.id,actorEmail:actor.email,originalRevision:expectedRevision,oldEmail:old.email,oldArea:areas[0],oldBrand:scope.brand,email:e,area,brand,access,read:read?{lifecycleId:read.lifecycle_id,version:read.version}:null,writer:writer?{lifecycleId:writer.lifecycle_id,version:writer.version}:null,requestedAt:current()};
   db.prepare("INSERT INTO user_profile_updates_v1(user_id,request_json,request_mac,phase,requested_at) VALUES(?,?,?,'revoking',?) ON CONFLICT(user_id) DO UPDATE SET request_json=excluded.request_json,request_mac=excluded.request_mac,phase='revoking',invite_ciphertext=NULL,invite_mac=NULL,requested_at=excluded.requested_at,completed_at=NULL").run(userId,JSON.stringify(q),brandMac(['profile-update-intent-v1',q]),q.requestedAt);
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return {ok:true,state:profileUpdateMetadata(userId).state};
 }
 function completeProfileUpdate(userId){
  const intent=updateIntent(userId);if(!intent||intent.row.phase!=='revoking')return false;
  const {q,row}=intent,actor=db.prepare('SELECT * FROM users WHERE id=?').get(q.actorId);
  if(!actor||actor.role!=='superadmin'||actor.state!=='active'||actor.email!==q.actorEmail||!updateRetired(intent))return false;
  const collision=findUser.get(q.email);if(collision&&collision.id!==userId)err('USER_EXISTS',409);
  const token=random(),tokenHash=sha(token),t=current(),host=areaHosts[q.area];
  db.exec('BEGIN IMMEDIATE');try{
   if(updateIntent(userId)?.row.request_mac!==row.request_mac||!updateRetired(intent))err('USER_CHANGED',409);
   db.prepare("UPDATE users SET email=?,state='invited',password_hash=NULL,totp_secret=NULL,totp_last_step=-1,updated_at=? WHERE id=? AND state='disabled'").run(q.email,t,userId);
   db.prepare('DELETE FROM upstream_brand_bindings_v1 WHERE user_id=?').run(userId);
   db.prepare('DELETE FROM grants WHERE user_id=?').run(userId);db.prepare('INSERT INTO grants(user_id,area,can_read,can_edit) VALUES(?,?,1,0)').run(userId,q.area);
   db.prepare('UPDATE user_brand_grants_v1 SET owner=?,area=?,brand=?,scope_mac=? WHERE user_id=?').run(q.email,q.area,q.brand,brandMac([userId,q.email,q.area,q.brand]),userId);
   if(q.access==='edit')db.prepare("INSERT INTO access_requests VALUES(?,'edit',?)").run(userId,t);
   if(q.area==='growth'){
    if(managedCrm)managedCall(()=>managedCrm.createLifecycle(userId));
    if(managedWriter)writerCall(()=>managedWriter.createLifecycle(userId));
   }else{
    if(managedCrm)db.prepare('DELETE FROM crm_manager_current_v1 WHERE user_id=?').run(userId);
    if(managedWriter)db.prepare('DELETE FROM crm_writer_auth_admission_v1 WHERE user_id=?').run(userId);
   }
   db.prepare('DELETE FROM user_brand_lifecycles_v1 WHERE user_id=?').run(userId);bindCurrentBrandLifecycles(userId);recordWriterRequestAuthority(userId);
   db.prepare('INSERT INTO invites(token_hash,user_id,host,expires_at) VALUES(?,?,?,?)').run(tokenHash,userId,host,t+INVITE_MS);
   const cipher=encrypt(token),mac=brandMac(['profile-update-invite-v1',userId,row.request_mac,sha(cipher),tokenHash]);
   db.prepare("UPDATE user_profile_updates_v1 SET phase='completed',invite_ciphertext=?,invite_mac=?,completed_at=? WHERE user_id=? AND request_mac=?").run(cipher,mac,t,userId,row.request_mac);
   db.exec('COMMIT');return true;
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 // Private bounded recovery. Every transfer was previously Master-CSRF authorized
 // and HMAC sealed; no caller can supply an identity, destination or credential.
 function reconcileUserProfileUpdates(maximum=8){
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>8||db.isTransaction)err('USER_UPDATE_INVALID',400);
  let completed=0,pending=0;for(const row of db.prepare("SELECT user_id FROM user_profile_updates_v1 WHERE phase='revoking' ORDER BY requested_at,user_id LIMIT ?").all(maximum))try{if(completeProfileUpdate(row.user_id))completed++;else pending++;}catch{pending++;}
  return {completed,pending};
 }
 function finishUserProfileUpdate({context,userId,expectedRevision}){
  adminContext(context);if(typeof expectedRevision!=='string'||!equalHex(expectedRevision,profileRevision(userId)))err('USER_CHANGED',409);
  const before=updateIntent(userId);if(!before||before.row.phase==='cancelled')err('USER_UPDATE_NOT_FOUND',404);
  if(before.row.phase==='revoking'&&!completeProfileUpdate(userId))err('USER_UPDATE_REVOCATION_PENDING',409);
  const {q,row}=updateIntent(userId),user=db.prepare('SELECT * FROM users WHERE id=?').get(userId);requireBrandScope(user);
  const token=decrypt(row.invite_ciphertext||'');if(!equalHex(row.invite_mac,brandMac(['profile-update-invite-v1',userId,row.request_mac,sha(row.invite_ciphertext),sha(token)])))err('USER_UPDATE_INTEGRITY',409);
  const invite=db.prepare('SELECT * FROM invites WHERE token_hash=? AND user_id=? AND used_at IS NULL AND expires_at>?').get(sha(token),userId,current());
  if(!invite||user.state!=='invited'||user.email!==q.email||invite.host!==areaHosts[q.area])err('INVITE_DENIED',403);
  return {ok:true,state:'invited',userId,host:invite.host,token};
 }
 function users({context}){
  authorize({...context,admin:true,method:'GET'});
  return db.prepare('SELECT u.id,u.email,u.role,u.state,r.requested_access FROM users u LEFT JOIN access_requests r ON r.user_id=u.id ORDER BY u.email').all().map(u=>{
   const p=permissions(u.id),scope=brandScope(u);
   const crmAccess=managedAccess(u),rawWriterState=managedWriter?.publicState(u.id),writerState=scope.brandAccess==='reprovision_required'&&rawWriterState?{...rawWriterState,ready:false,canApprove:false,canRenew:false}:rawWriterState;
   const crmWriter=corporateWriter&&writerState?{...writerState,canRenew:writerState.canRenew===true&&managedCrm.renewalReady(u.id)===true&&Number.isSafeInteger(crmAccess?.expiresAt)&&crmAccess.expiresAt>current()&&crmAccess.renewalPhase===null}:writerState;
   return {id:u.id,email:u.email,role:u.role,areas:AREAS.filter(a=>p[a]?.read),permissions:p,requestedAccess:u.requested_access||'read',status:u.state,...scope,...(u.role==='manager'?{profileRevision:profileRevision(u.id),...(profileUpdateMetadata(u.id)?{profileUpdate:profileUpdateMetadata(u.id)}:{})}:{}),...(crmAccess?{crmAccess}:{}),...(crmWriter?{crmWriter}:{})};
  });
 }
 function renewManagedCrm({context,userId}){
  adminContext(context);
  if(!managedCrm)err('CRM_PROVISIONING_NOT_READY',403);
  if(typeof userId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(userId))err('USER_INVALID',400);
  try{
   const user=db.prepare('SELECT id,role,state FROM users WHERE id=?').get(userId),p=permissions(userId);
   if(!user||user.role!=='manager'||user.state!=='active'||Object.keys(p).length!==1||p.growth?.read!==true||p.growth?.edit!==false&&!corporateWriter)err('USER_DENIED',404);
   requireBrandScope(db.prepare('SELECT * FROM users WHERE id=?').get(userId));
   const access=managedAccess(user);
   if(!access||access.state!=='ready')err('CRM_RENEWAL_NOT_READY',409);
   if(access.expired&&!corporateWriter)err('CRM_ACCESS_EXPIRED',409);
   if(access.renewalPhase!==null)err('CRM_RENEWAL_PENDING',409);
   if(corporateWriter){
    if(managedWriter.hasPendingCampaigns(userId))err('CAMPAIGN_RECONCILIATION_REQUIRED',409);
    if(unresolvedAudienceDraft(userId))err('AUDIENCE_RECONCILIATION_REQUIRED',409);
    const writer=managedWriter.publicState(userId);
    if(writer?.state==='revoking')err('CRM_WRITER_REVOCATION_PENDING',409);
    if(typeof writer?.renewalPhase==='string')err('CRM_WRITER_RENEWAL_PENDING',409);
    if(writer?.state==='ready'||writer?.state==='blocked'&&managedWriter.bindingForRenewal(userId)===true){
     if(!access.canRenew)err('CRM_RENEWAL_NOT_READY',409);
     // First retire WRITER; READ rotation must wait for verified lifecycle
     // revocation. The existing READ slot/login and terminal receipts survive.
     db.exec('BEGIN IMMEDIATE');try{
      if(managedWriter.hasPendingCampaigns(userId))err('CAMPAIGN_RECONCILIATION_REQUIRED',409);
      if(unresolvedAudienceDraft(userId))err('AUDIENCE_RECONCILIATION_REQUIRED',409);
      writerCall(()=>managedWriter.stageRevoke(userId));db.exec('COMMIT');
     }catch(e){db.exec('ROLLBACK');throw e;}
     return {ok:true,state:'writer_revocation_pending'};
    }
    if(p.growth.edit===true||writer&&['provisioning','blocked','renewing'].includes(writer.state))err('CRM_WRITER_REVOCATION_REQUIRED',409);
   }
   if(!access.canRenew)err('CRM_RENEWAL_NOT_READY',409);
   // renew() owns its SQLite transaction and returns only after COMMIT. The
   // HTTP gateway may then kick its private runtime; this method does no I/O.
   if(access.expired&&corporateWriter)managedCrm.renewExpired(userId);else managedCrm.renew(userId);
  }catch(e){
   if(e instanceof AuthError)throw e;
   if(e?.code==='MANAGED_OPERATION_PENDING')err('CRM_RENEWAL_PENDING',409);
   if(['MANAGED_NOT_READY','MANAGED_MANAGER_DENIED'].includes(e?.code))err('CRM_RENEWAL_NOT_READY',409);
   err('MANAGED_STORE_UNAVAILABLE',503);
  }
  return {ok:true};
 }
 function setRequestedAccess({context,userId,requestedAccess}){
  adminContext(context);
  if(!['read','edit'].includes(requestedAccess))err('ACCESS_REQUEST_INVALID',400);
  const user=db.prepare('SELECT id,role,state FROM users WHERE id=?').get(userId);
  if(!user||user.role!=='manager'||!['active','invited'].includes(user.state))err('USER_DENIED',404);
  const p=permissions(userId);
  if(Object.keys(p).length!==1)err('GRANTS_INVALID',400);
  requireBrandScope(db.prepare('SELECT * FROM users WHERE id=?').get(userId));
  const t=current();db.exec('BEGIN IMMEDIATE');try{
   if(unresolvedAudienceDraft(userId))err('AUDIENCE_RECONCILIATION_REQUIRED',409);
   db.prepare('DELETE FROM access_requests WHERE user_id=?').run(userId);
   if(requestedAccess==='edit'){
    if(corporateWriter&&p.growth?.read){
     if(managedWriter.hasPendingCampaigns(userId))err('CAMPAIGN_RECONCILIATION_REQUIRED',409);
     // Existing admissions stay put; only the missing active READ pilot gets
     // a new unapproved WRITER lifecycle. Requesting edit never grants it.
     if(user.state==='active'&&managedWriter.publicState(userId)===null){writerCall(()=>managedWriter.requestLifecycle(userId));bindCurrentBrandLifecycles(userId);}
    }
    db.prepare("INSERT INTO access_requests(user_id,requested_access,requested_at) VALUES(?,'edit',?)").run(userId,t);
   }
   else{
    if(corporateWriter&&managedWriter.hasPendingCampaigns(userId))err('CAMPAIGN_RECONCILIATION_REQUIRED',409);
    if(managedWriter)writerCall(()=>managedWriter.stageRevoke(userId));
    db.prepare('UPDATE grants SET can_edit=0 WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
    for(const [slot,definition]of Object.entries(CREDENTIAL_SLOTS))if(definition.mayWrite)db.prepare('DELETE FROM upstream_credentials WHERE user_id=? AND slot=?').run(userId,slot);
   }
   db.prepare('UPDATE users SET updated_at=? WHERE id=?').run(t,userId);recordWriterRequestAuthority(userId);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {ok:true,requestedAccess};
 }
 function setGrants({context,userId,permissions:requested}){
  const actor=adminContext(context),user=db.prepare('SELECT id,role,state FROM users WHERE id=?').get(userId);
  if(!user||user.state==='disabled'||user.role==='superadmin'&&user.id!==actor.id)err('USER_DENIED',404);
  const p=normalizePermissions(requested);
  if((managedCrm||managedWriter||ownMasterWriter)&&user.role==='manager'&&p.growth?.edit)err('EDIT_NOT_READY',403);
  if(user.role==='superadmin'&&(Object.keys(p).length!==3||AREAS.some(a=>!p[a]?.read)))err('GRANTS_INVALID',400);
  if(user.role==='manager'&&Object.keys(p).length!==1)err('GRANTS_INVALID',400);
  // Invitations are bound to an area host; transfer requires revoke/reinvite.
  if(user.role==='manager'){requireBrandScope(db.prepare('SELECT * FROM users WHERE id=?').get(userId));if(Object.keys(p)[0]!==Object.keys(permissions(userId))[0])err('AREA_CHANGE_REQUIRES_REINVITE',409);}
  if(p.growth?.edit&&!permissions(userId).growth?.edit&&unresolvedCampaignDraft(userId))err('DRAFT_RECONCILIATION_REQUIRED',409);
  if(p.growth?.edit&&!permissions(userId).growth?.edit&&unresolvedCampaignDelivery(userId))err('CAMPAIGN_RECONCILIATION_REQUIRED',409);
  db.exec('BEGIN IMMEDIATE');try{
   if(unresolvedAudienceDraft(userId))err('AUDIENCE_RECONCILIATION_REQUIRED',409);
   if(corporateWriter&&user.role==='manager'&&managedWriter.hasPendingCampaigns(userId))err('CAMPAIGN_RECONCILIATION_REQUIRED',409);
   if(managedWriter&&user.role==='manager')writerCall(()=>managedWriter.stageRevoke(userId));
   db.prepare('DELETE FROM grants WHERE user_id=?').run(userId);
   for(const [area,g]of Object.entries(p))db.prepare('INSERT INTO grants(user_id,area,can_read,can_edit) VALUES(?,?,1,?)').run(userId,area,g.edit?1:0);
   db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
   for(const [slot,definition]of Object.entries(CREDENTIAL_SLOTS))if(!p[definition.area]||definition.mayWrite&&!p[definition.area].edit)db.prepare('DELETE FROM upstream_credentials WHERE user_id=? AND slot=?').run(userId,slot);
   db.prepare('UPDATE users SET updated_at=? WHERE id=?').run(current(),userId);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}return {ok:true};
 }
 function revokeUser({context,userId}){
  adminContext(context);const user=db.prepare('SELECT id,role FROM users WHERE id=?').get(userId);
  if(!user||user.role!=='manager')err('USER_DENIED',404);
  db.exec('BEGIN IMMEDIATE');try{
   if(managedCrm&&managedCrm.status(userId))managedCall(()=>managedCrm.stageRevoke(userId));
   if(managedWriter)writerCall(()=>managedWriter.stageRevoke(userId));
   db.prepare("UPDATE users SET state='disabled',password_hash=NULL,updated_at=? WHERE id=?").run(current(),userId);
   db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
   db.prepare('DELETE FROM upstream_credentials WHERE user_id=?').run(userId);
   db.prepare('DELETE FROM invites WHERE user_id=?').run(userId);
   db.prepare('DELETE FROM access_requests WHERE user_id=?').run(userId);if(corporateWriter)db.prepare('DELETE FROM crm_writer_request_authority_v1 WHERE user_id=?').run(userId);db.prepare("UPDATE user_profile_updates_v1 SET phase='cancelled',invite_ciphertext=NULL,invite_mac=NULL WHERE user_id=?").run(userId);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}return {ok:true,...(managedCrm?.status(userId)?{crmRevocationPending:managedCrm.status(userId).state!=='revoked'}:{})};
 }
 function credentialTarget({context,userId,slot,bearer}){
  adminContext(context);const definition=CREDENTIAL_SLOTS[slot];
  if(!definition||typeof bearer!=='string'||!/^[A-Za-z0-9_.:-]{8,256}$/.test(bearer))err('CREDENTIAL_INVALID',400);
  const user=db.prepare('SELECT id,email,role,state,updated_at FROM users WHERE id=?').get(userId),grant=permissions(userId)[definition.area];
  if(!user||!['active','invited'].includes(user.state)||!grant?.read||definition.mayWrite&&!grant.edit)err('GRANT_DENIED',403);
  requireBrandScope(user);
  if(managedCrm&&user.role==='manager'&&definition.area==='growth'&&managedCrm.status(userId))err('MANAGED_CREDENTIAL_DENIED',403);
  if(slot==='growth-campaign'&&unresolvedCampaignDraft(userId))err('DRAFT_RECONCILIATION_REQUIRED',409);
  if(slot==='growth-campaign'&&unresolvedCampaignDelivery(userId))err('CAMPAIGN_RECONCILIATION_REQUIRED',409);
  return user;
 }
 function crmPanelReadOwner(user,context){
  return user.role==='manager'||user.role==='superadmin'&&user.id===adminContext(context).id;
 }
 function storeUpstreamCredential({context,userId,slot,bearer},{crmAttested=false,expectedOwner,expectedUpdatedAt}={}){
  const user=credentialTarget({context,userId,slot,bearer});
  if(slot==='crm-panel-read'&&(!crmAttested||!crmPanelReadOwner(user,context)||user.state!=='active'||user.email!==expectedOwner||user.updated_at!==expectedUpdatedAt))err('CREDENTIAL_ATTESTATION_REQUIRED',403);
  const digest=crypto.createHmac('sha256',encKey).update('upstream-key:'+bearer).digest('hex');
  db.exec('BEGIN IMMEDIATE');try{
   if(slot==='growth-audience'&&unresolvedAudienceDraft(userId))err('AUDIENCE_RECONCILIATION_REQUIRED',409);
   if(db.prepare('SELECT 1 FROM upstream_credentials WHERE key_digest=? AND user_id<>? LIMIT 1').get(digest,userId))err('CREDENTIAL_REUSED',409);
   const encrypted=encrypt(bearer);
   db.prepare('INSERT INTO upstream_credentials(user_id,slot,encrypted_key,key_digest,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,slot) DO UPDATE SET encrypted_key=excluded.encrypted_key,key_digest=excluded.key_digest,updated_at=excluded.updated_at').run(userId,slot,encrypted,digest,current());
   recordUpstreamBinding(user,slot,{encrypted_key:encrypted,key_digest:digest});
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {ok:true};
 }
 function setUpstreamCredential(args){if(campaignSubmit&&args?.slot==='growth-campaign')err('CREDENTIAL_ATTESTATION_REQUIRED',403);return storeUpstreamCredential(args);}
 // PRIVATE fixture/issuer promotion hook. No HTTP route accepts this payload.
 // The present write gate is restricted to the synthetic identity domain;
 // a reviewed writer issuer is still required before production support.
 async function installCampaignWriter({context,userId,bearer,principalId,expiresAt,fetchImpl=globalThis.fetch}){
  if(!campaignSubmit||managedWriter||ownMasterWriter)err('EDIT_NOT_READY',403);
  const user=credentialTarget({context,userId,slot:'growth-campaign',bearer});
  if(user.role!=='manager'||user.state!=='active'||Object.keys(permissions(userId)).join(',')!=='growth'||!Number.isSafeInteger(expiresAt)||expiresAt<=current()||expiresAt>current()+14*86400000)err('CREDENTIAL_ATTESTATION_REQUIRED',403);
  try{await require('./crm-campaign-writer-attestation.cjs').verifyCampaignWriterCredential({bearer,owner:user.email,principalId},{fetchImpl});}catch{err('CREDENTIAL_ATTESTATION_FAILED',403);}
  const checked=credentialTarget({context,userId,slot:'growth-campaign',bearer});
  if(checked.email!==user.email||checked.updated_at!==user.updated_at||checked.role!=='manager'||checked.state!=='active'||expiresAt<=current())err('CREDENTIAL_ATTESTATION_FAILED',403);
  const digest=crypto.createHmac('sha256',encKey).update('upstream-key:'+bearer).digest('hex');
  db.exec('BEGIN IMMEDIATE');try{
   if(db.prepare('SELECT 1 FROM upstream_credentials WHERE key_digest=? AND user_id<>? LIMIT 1').get(digest,userId))err('CREDENTIAL_REUSED',409);
   db.prepare("INSERT INTO upstream_credentials(user_id,slot,encrypted_key,key_digest,updated_at) VALUES(?,'growth-campaign',?,?,?) ON CONFLICT(user_id,slot) DO UPDATE SET encrypted_key=excluded.encrypted_key,key_digest=excluded.key_digest,updated_at=excluded.updated_at").run(userId,encrypt(bearer),digest,current());
   db.prepare('INSERT INTO campaign_writer_attestation_v1(user_id,owner,principal_id,credential_mac,expires_at,attested_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET owner=excluded.owner,principal_id=excluded.principal_id,credential_mac=excluded.credential_mac,expires_at=excluded.expires_at,attested_at=excluded.attested_at,master_proof_mac=NULL').run(userId,user.email,principalId,digest,expiresAt,current());
   recordUpstreamBinding(user,'growth-campaign',db.prepare("SELECT encrypted_key,key_digest FROM upstream_credentials WHERE user_id=? AND slot='growth-campaign'").get(userId));
   db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}return {ok:true};
 }
 // PRIVATE own-master promotion only; no HTTP route, issuance, role/grant
 // change or manager lifecycle. The backend identity must attest the actual
 // master operator's four exact Growth caps, not a browser capability claim.
 const masterWriterMac=(user,a)=>brandMac(['campaign-master-writer-v1',user.id,user.email,'master','todos',a.principal_id,a.credential_mac,a.expires_at,a.attested_at,['read_content','draft','validate','submit']]);
 function masterCreatePending(userId){
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='crm_campaign_create_v1'").get()&&db.prepare("SELECT 1 FROM crm_campaign_create_v1 WHERE user_id=? AND phase IN ('queued','uncertain','confirmed')").get(userId))err('CAMPAIGN_RECONCILIATION_REQUIRED',409);
 }
 // Shared by the private installation hook and the own-session activation.
 // Caller owns the transaction and final checks; raw principal stays in RAM.
 function persistMasterCampaignWriter(user,{bearer,principalId,expiresAt,attestedAt}){
  const digest=crypto.createHmac('sha256',encKey).update('upstream-key:'+bearer).digest('hex');
  if(db.prepare('SELECT 1 FROM upstream_credentials WHERE key_digest=? AND user_id<>? LIMIT 1').get(digest,user.id))err('CREDENTIAL_REUSED',409);
  const encrypted=encrypt(bearer),a={principal_id:'master-'+crypto.createHmac('sha256',encKey).update('master-campaign-actor:'+principalId).digest('hex'),credential_mac:digest,expires_at:expiresAt,attested_at:attestedAt};
  db.prepare("INSERT INTO upstream_credentials(user_id,slot,encrypted_key,key_digest,updated_at) VALUES(?,'growth-campaign',?,?,?) ON CONFLICT(user_id,slot) DO UPDATE SET encrypted_key=excluded.encrypted_key,key_digest=excluded.key_digest,updated_at=excluded.updated_at").run(user.id,encrypted,digest,attestedAt);
  db.prepare('INSERT INTO campaign_writer_attestation_v1(user_id,owner,principal_id,credential_mac,expires_at,attested_at,master_proof_mac) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET owner=excluded.owner,principal_id=excluded.principal_id,credential_mac=excluded.credential_mac,expires_at=excluded.expires_at,attested_at=excluded.attested_at,master_proof_mac=excluded.master_proof_mac').run(user.id,user.email,a.principal_id,digest,expiresAt,attestedAt,masterWriterMac(user,a));
  recordUpstreamBinding(user,'growth-campaign',{encrypted_key:encrypted,key_digest:digest});
 }
 async function installMasterCampaignWriter({context,userId,bearer,principalId,expiresAt,fetchImpl=globalThis.fetch}){
  if(!campaignSubmit||!masterWriter)err('EDIT_NOT_READY',403);
  const actor=adminContext(context),user=credentialTarget({context,userId,slot:'growth-campaign',bearer});
  if(actor.id!==user.id||user.role!=='superadmin'||user.email!==adminEmail||user.state!=='active'||!Number.isSafeInteger(expiresAt)||expiresAt<=current()||expiresAt>current()+14*86400000)err('CREDENTIAL_ATTESTATION_REQUIRED',403);
  masterCreatePending(userId);
  try{await require('./crm-campaign-writer-attestation.cjs').verifyMasterCampaignWriterCredential({bearer,owner:user.email,principalId},{fetchImpl});}catch{err('CREDENTIAL_ATTESTATION_FAILED',403);}
  const checked=credentialTarget({context,userId,slot:'growth-campaign',bearer});
  if(checked.email!==user.email||checked.updated_at!==user.updated_at||checked.role!=='superadmin'||checked.state!=='active'||expiresAt<=current())err('CREDENTIAL_ATTESTATION_FAILED',403);
  masterCreatePending(userId);
  // Legacy master operator IDs may themselves be an accepted old key. Keep
  // the verified raw principal in RAM only; persist a segregated keyed digest.
  const attestedAt=current();
  db.exec('BEGIN IMMEDIATE');try{
   // Serialize the final session/grant/pending checks with journal reservation
   // even if another gateway process held the SQLite write lock while we waited.
   const locked=credentialTarget({context,userId,slot:'growth-campaign',bearer});
   if(locked.email!==user.email||locked.updated_at!==user.updated_at||locked.role!=='superadmin'||locked.state!=='active'||expiresAt<=current())err('CREDENTIAL_ATTESTATION_FAILED',403);
   masterCreatePending(userId);
   persistMasterCampaignWriter(user,{bearer,principalId,expiresAt,attestedAt});db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}return {ok:true};
 }
 function masterActivationSnapshot(context){
  const actor=adminContext(context),session=lookup(context,false),user=db.prepare('SELECT id,email,role,state,updated_at FROM users WHERE id=?').get(actor.id);
  if(!session||session.user.id!==actor.id||!user||user.role!=='superadmin'||user.email!==adminEmail||user.state!=='active')err('CREDENTIAL_ATTESTATION_REQUIRED',403);
  const grants=db.prepare('SELECT area,can_read,can_edit FROM grants WHERE user_id=? ORDER BY area').all(user.id);
  if(!grants.some(g=>g.area==='growth'&&g.can_read===1))err('GRANT_DENIED',403);
  if(unresolvedCampaignDraft(user.id))err('DRAFT_RECONCILIATION_REQUIRED',409);
  if(unresolvedCampaignDelivery(user.id))err('CAMPAIGN_RECONCILIATION_REQUIRED',409);
  if(unresolvedAudienceDraft(user.id))err('AUDIENCE_RECONCILIATION_REQUIRED',409);
  masterCreatePending(user.id);
  const source=db.prepare("SELECT slot,encrypted_key,key_digest,updated_at FROM upstream_credentials WHERE user_id=? AND slot IN ('growth-campaign','crm-panel-read','growth-read') ORDER BY CASE slot WHEN 'growth-campaign' THEN 0 WHEN 'crm-panel-read' THEN 1 ELSE 2 END LIMIT 1").get(user.id);
  if(!source)err('INDIVIDUAL_CREDENTIAL_MISSING',503);
  const bound=db.prepare('SELECT binding_mac FROM upstream_brand_bindings_v1 WHERE user_id=? AND slot=?').get(user.id,source.slot);
  if(!bound||!equalHex(bound.binding_mac,upstreamBindingMac(user,source.slot,source)))err('CREDENTIAL_UNAVAILABLE',503);
  if(db.prepare('SELECT 1 FROM upstream_credentials WHERE key_digest=? AND user_id<>? LIMIT 1').get(source.key_digest,user.id))err('CREDENTIAL_REUSED',409);
  return {user,tokenHash:session.tokenHash,grants,source,bindingMac:bound.binding_mac};
 }
 // Own Master only: no caller-selected user, key, slot, principal or lifetime.
 // Read access does not become edit until the same fixed GET proves four caps.
 async function activateOwnMasterCampaignWriter({context,fetchImpl=globalThis.fetch}){
  if(!campaignSubmit||!masterWriter)err('EDIT_NOT_READY',403);
  const original=masterActivationSnapshot(context),bearer=decrypt(original.source.encrypted_key);
  if(!equalHex(original.source.key_digest,crypto.createHmac('sha256',encKey).update('upstream-key:'+bearer).digest('hex')))err('CREDENTIAL_UNAVAILABLE',503);
  let proof;
  try{proof=await require('./crm-campaign-writer-attestation.cjs').verifyStoredMasterCampaignWriterCredential({bearer,owner:original.user.email},{fetchImpl});}catch{err('CREDENTIAL_ATTESTATION_FAILED',403);}
  db.exec('BEGIN IMMEDIATE');try{
   // Recheck after the remote GET and after waiting for the SQLite writer lock.
   const locked=masterActivationSnapshot(context);
   if(JSON.stringify(locked)!==JSON.stringify(original))err('CREDENTIAL_ATTESTATION_FAILED',403);
   const attestedAt=current(),expiresAt=attestedAt+14*86400000;
   db.prepare("UPDATE grants SET can_edit=1 WHERE user_id=? AND area='growth' AND can_read=1").run(original.user.id);
   persistMasterCampaignWriter(original.user,{bearer,principalId:proof.principalId,expiresAt,attestedAt});db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {ok:true,ready:true};
 }
 // Native integrator authority is distinct from a user session. This private
 // maintenance hook is never routed over HTTP and never manufactures context.
 function nativeMasterActivationSnapshot(){
  const user=db.prepare("SELECT id,email,role,state,updated_at FROM users WHERE email=? AND role='superadmin' AND state='active'").get(adminEmail);
  if(!user||user.email!=='felipebandeira@oaristocrata.com')err('CREDENTIAL_ATTESTATION_REQUIRED',403);
  const grants=db.prepare('SELECT area,can_read,can_edit FROM grants WHERE user_id=? ORDER BY area').all(user.id);
  if(grants.length!==3||AREAS.some(a=>!grants.some(g=>g.area===a&&g.can_read===1)))err('GRANT_DENIED',403);
  if(unresolvedCampaignDraft(user.id))err('DRAFT_RECONCILIATION_REQUIRED',409);
  if(unresolvedCampaignDelivery(user.id))err('CAMPAIGN_RECONCILIATION_REQUIRED',409);
  if(unresolvedAudienceDraft(user.id))err('AUDIENCE_RECONCILIATION_REQUIRED',409);
  masterCreatePending(user.id);
  const source=db.prepare("SELECT slot,encrypted_key,key_digest,updated_at FROM upstream_credentials WHERE user_id=? AND slot IN ('growth-campaign','crm-panel-read','growth-read') ORDER BY CASE slot WHEN 'growth-campaign' THEN 0 WHEN 'crm-panel-read' THEN 1 ELSE 2 END LIMIT 1").get(user.id);
  if(!source)err('INDIVIDUAL_CREDENTIAL_MISSING',503);
  const bound=db.prepare('SELECT binding_mac FROM upstream_brand_bindings_v1 WHERE user_id=? AND slot=?').get(user.id,source.slot);
  if(!bound||!equalHex(bound.binding_mac,upstreamBindingMac(user,source.slot,source)))err('CREDENTIAL_UNAVAILABLE',503);
  if(db.prepare('SELECT 1 FROM upstream_credentials WHERE key_digest=? AND user_id<>? LIMIT 1').get(source.key_digest,user.id))err('CREDENTIAL_REUSED',409);
  return {user,grants,source,bindingMac:bound.binding_mac};
 }
 async function activateNativeOwnMasterCampaignWriter({operationId,programSha256,expiresAt,authorizationMac,fetchImpl=globalThis.fetch}){
  if(!campaignSubmit||!masterWriter)err('EDIT_NOT_READY',403);
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId||'')||!/^[a-f0-9]{64}$/.test(programSha256||'')||!Number.isSafeInteger(expiresAt)||expiresAt<=current()||expiresAt>current()+600000)err('NATIVE_MASTER_AUTHORIZATION_REQUIRED',403);
  const scope=JSON.stringify({schema:'CRM_NATIVE_OWN_MASTER_SQLITE_WRITER_V1',operationId,owner:adminEmail,action:'install-own-master-campaign-writer',programSha256,expiresAt});
  if(!equalHex(authorizationMac,crypto.createHmac('sha256',encKey).update('native-own-master-sqlite-writer-v1:'+scope).digest('hex')))err('NATIVE_MASTER_AUTHORIZATION_REQUIRED',403);
  const original=nativeMasterActivationSnapshot();
  // Fixed one-shot marker survives errors/restarts and even a different UUID.
  // The native controller also reserves its own durable fence before env delivery.
  db.exec('BEGIN IMMEDIATE');try{
   if(JSON.stringify(nativeMasterActivationSnapshot())!==JSON.stringify(original)||expiresAt<=current())err('CREDENTIAL_ATTESTATION_FAILED',403);
   if(db.prepare("SELECT 1 FROM identity_metadata WHERE key='native_master_campaign_writer_once_v1'").get())err('NATIVE_MASTER_ATTEMPT_CONSUMED',409);
   db.prepare("INSERT INTO identity_metadata(key,encrypted_value) VALUES('native_master_campaign_writer_once_v1',?)").run(encrypt(scope));db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  let bearer=decrypt(original.source.encrypted_key),proof;
  try{
   if(!equalHex(original.source.key_digest,crypto.createHmac('sha256',encKey).update('upstream-key:'+bearer).digest('hex')))err('CREDENTIAL_UNAVAILABLE',503);
   try{proof=await require('./crm-campaign-writer-attestation.cjs').verifyStoredMasterCampaignWriterCredential({bearer,owner:original.user.email},{fetchImpl});}catch{err('CREDENTIAL_ATTESTATION_FAILED',403);}
   db.exec('BEGIN IMMEDIATE');try{
    if(expiresAt<=current()||JSON.stringify(nativeMasterActivationSnapshot())!==JSON.stringify(original))err('CREDENTIAL_ATTESTATION_FAILED',403);
    const attestedAt=current(),credentialExpiresAt=attestedAt+14*86400000;
    db.prepare("UPDATE grants SET can_edit=1 WHERE user_id=? AND area='growth' AND can_read=1").run(original.user.id);
    persistMasterCampaignWriter(original.user,{bearer,principalId:proof.principalId,expiresAt:credentialExpiresAt,attestedAt});db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e;}
   return {ok:true,ready:true,actor:'native-integrator',attemptMustRemainConsumed:true};
  }finally{bearer=undefined;proof=undefined;}
 }
 // Private caller only: no new HTTP route and no automatic dispatch.
 function approveManagedCampaignWriter({context,userId}){
  adminContext(context);if(!managedWriter)err('EDIT_NOT_READY',403);
  if(corporateWriter&&managedCrm.credentialReady(userId)!==true)err('CRM_ACCESS_NOT_READY',409);
  if(typeof userId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(userId))err('USER_INVALID',400);
  if(corporateWriter&&!db.prepare("SELECT 1 FROM access_requests WHERE user_id=? AND requested_access='edit'").get(userId))err('CRM_WRITER_REQUEST_REQUIRED',409);
  db.exec('BEGIN IMMEDIATE');try{requireBrandScope(db.prepare('SELECT * FROM users WHERE id=?').get(userId));writerCall(()=>managedWriter.approve(userId));bindCurrentBrandLifecycles(userId);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  // enqueue owns its own transaction. Its failure leaves only an inactive,
  // durable approval; the same admission can be resumed before any RPC.
  writerCall(()=>managedWriter.journal.enqueue(userId,'issue'));return {ok:true};
 }
 // Manual corporate renewal is an admin operation. The old WRITER actor
 // is never rotated while a campaign receipt in either brand is unresolved.
 function renewManagedCampaignWriter({context,userId}){
  adminContext(context);if(!corporateWriter||!managedWriter)err('EDIT_NOT_READY',403);
  if(typeof userId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(userId))err('USER_INVALID',400);
  requireBrandScope(db.prepare('SELECT * FROM users WHERE id=?').get(userId));
  const writer=managedWriter.publicState(userId);
  if(typeof writer?.renewalPhase==='string')err('CRM_WRITER_RENEWAL_PENDING',409);
  if(managedCrm.renewalReady(userId)!==true||managedCrm.status(userId)?.expiresAt<=current()||managedRenewalPhase(userId)!==null)err('CRM_ACCESS_NOT_READY',409);
  if(managedWriter.hasPendingCampaigns(userId))err('CAMPAIGN_RECONCILIATION_REQUIRED',409);
  if(unresolvedAudienceDraft(userId))err('AUDIENCE_RECONCILIATION_REQUIRED',409);
  if(writer?.canRenew!==true)err('CRM_WRITER_RENEWAL_NOT_READY',409);
  db.exec('BEGIN IMMEDIATE');try{writerCall(()=>managedWriter.stageRenew(userId));db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  return {ok:true,state:'renewing'};
 }
 function writerBinding(user){
  if(user.role==='superadmin'){
   if(!campaignSubmit||!masterWriter||user.email!==adminEmail||user.permissions.growth?.edit!==true)return null;
   const a=db.prepare("SELECT a.*,c.key_digest,c.encrypted_key FROM campaign_writer_attestation_v1 a JOIN upstream_credentials c ON c.user_id=a.user_id AND c.slot='growth-campaign' WHERE a.user_id=?").get(user.id),bound=db.prepare("SELECT binding_mac FROM upstream_brand_bindings_v1 WHERE user_id=? AND slot='growth-campaign'").get(user.id);
   return a&&a.owner===user.email&&a.credential_mac===a.key_digest&&Number.isSafeInteger(a.attested_at)&&a.attested_at<=current()&&Number.isSafeInteger(a.expires_at)&&a.expires_at>current()&&a.expires_at<=a.attested_at+14*86400000&&equalHex(a.master_proof_mac,masterWriterMac(user,a))&&bound&&equalHex(bound.binding_mac,upstreamBindingMac(user,'growth-campaign',a))?a:null;
  }
  if(ownMasterWriter)return null;
  if(managedWriter)return managedWriter.bindingForUser(user.id);
  if(!campaignSubmit||user.role!=='manager'||user.areas.length!==1||user.areas[0]!=='growth'||user.permissions.growth?.edit!==true)return null;
  const a=db.prepare("SELECT a.*,c.key_digest FROM campaign_writer_attestation_v1 a JOIN upstream_credentials c ON c.user_id=a.user_id AND c.slot='growth-campaign' WHERE a.user_id=?").get(user.id);
  return a&&a.owner===user.email&&a.credential_mac===a.key_digest&&a.expires_at>current()?a:null;
 }
 // Only a currently FULL corporate WRITER can expose its old receipt GETs.
 // READ expiry stays closed for data reads and every new campaign mutation.
 function campaignHistoryRead(ctx){
  if(!masterWriter)return false;
  try{const u=authorize({...ctx,method:'GET',area:'growth',edit:false});return !!writerBinding(u);}catch{return false;}
 }
 // PRIVATE read-only projection for current native content admission. The
 // actual Master may inspect a target; no manager session/context is fabricated.
 function campaignContentAdmissionSnapshot(context,{brand,write=false,userId}={}){
  if(!corporateWriter||!campaignSubmit||typeof write!=='boolean')err('EDIT_NOT_READY',403);
  let raw;
  if(userId!==undefined){authorize({...context,admin:true});const master=lookup(context,false);checkOrigin(master.host,context.origin);if(typeof context.csrf!=='string'||context.csrf.length!==master.csrf.length||!crypto.timingSafeEqual(Buffer.from(context.csrf),Buffer.from(master.csrf)))err('CSRF_DENIED',403);raw=db.prepare('SELECT * FROM users WHERE id=?').get(userId);}
  else{const own=authorizeBrand({...context,area:'growth',edit:false},brand);raw=db.prepare('SELECT * FROM users WHERE id=?').get(own.id);}
  if(!raw||raw.role!=='manager'||raw.state!=='active')err('CRM_ACCESS_NOT_READY',403);
  const user=publicUser(raw),scope=requireBrandScope(raw);if(user.areas.join(',')!=='growth'||scope.brand!==brand||scope.brandAccess!=='single'||managedCrm.credentialReady(raw.id)!==true)err('CRM_ACCESS_NOT_READY',403);
  const read=managedCrm.readBinding(raw.id),att=write?writerBinding(user):null;if(write&&!att)err('CREDENTIAL_ATTESTATION_REQUIRED',403);
  // bindingForUser validates the entire original promoted journal but returns
  // the attestation row; native lifecycle metadata lives in its bound table.
  const a=write?db.prepare('SELECT * FROM crm_writer_auth_binding_v1 WHERE user_id=?').get(raw.id):read;if(!a||write&&(a.owner!==att.owner||a.principal_id!==att.principal_id||a.credential_mac!==att.credential_mac||a.expires_at!==att.expires_at))err('CREDENTIAL_ATTESTATION_REQUIRED',403);
  const slot=write?'growth-campaign':'crm-panel-read',stored=db.prepare('SELECT * FROM upstream_credentials WHERE user_id=? AND slot=?').get(raw.id,slot),credentialMac=write?a.credential_mac:stored?.key_digest;
  if(!stored||stored.key_digest!==credentialMac||db.prepare('SELECT 1 FROM upstream_credentials WHERE key_digest=? AND (user_id<>? OR slot<>?)').get(credentialMac,raw.id,slot))err('CREDENTIAL_UNAVAILABLE',503);
  const credential=decrypt(stored.encrypted_key);if(!equalHex(credentialMac,crypto.createHmac('sha256',encKey).update('upstream-key:'+credential).digest('hex')))err('CREDENTIAL_UNAVAILABLE',503);
  const writerBindingProof=write?{issuerId:a.issuer_id,namespaceId:a.namespace_id,userId:raw.id,lifecycleId:a.lifecycle_id,principalId:a.principal_id,generation:a.generation,expiresAt:a.expires_at}:null;
  return Object.freeze({userId:raw.id,owner:raw.email,brand,slot,credential,credentialMac,profileRevision:profileRevision(raw.id),principalId:write?a.principal_id:read.principalId,caps:write?['read_content','draft','validate','submit']:['read_content','list_history','submission'],writerBinding:writerBindingProof,readBinding:read});
 }
 function campaignWriterReady(ctx){try{const user=authorize({...ctx,method:'GET',area:'growth',edit:false});return !!writerBinding(user)&&(!corporateWriter||user.role==='superadmin'||managedCrm.credentialReady(user.id)===true);}catch{return false;}}
 let campaignCreateInitialized=false;
 function hasOpenCampaignCreate(userId,brand){return campaignCreateInitialized&&!!db.prepare("SELECT 1 FROM crm_campaign_create_v1 WHERE user_id=? AND brand=? AND phase IN ('queued','uncertain','confirmed')").get(userId,brand);}
 function campaignWriterAuthorization(ctx,{brand,action}){
  draftBrand(brand);if(!campaignSubmit)err('EDIT_NOT_READY',403);
  const user=authorizeBrand({...ctx,area:'growth',edit:true},brand),a=writerBinding(user);if(!a)err('CREDENTIAL_ATTESTATION_REQUIRED',403);
  // Old WRITER identity remains available for GET receipts/reconciliation.
  // Only new POST mutations depend on a current individual READ binding.
  if(corporateWriter&&user.role==='manager'&&ctx.method==='POST'&&managedCrm.credentialReady(user.id)!==true)err('CRM_ACCESS_NOT_READY',403);
  if(db.prepare("SELECT 1 FROM campaign_draft_operations WHERE user_id=? AND brand=? AND phase IN ('pending','uncertain')").get(user.id,brand))err('DRAFT_RECONCILIATION_REQUIRED',409);
  if(['salvar','validar','agendar','cancelar'].includes(action)&&hasOpenCampaignCreate(user.id,brand))err('CAMPAIGN_CREATE_PENDING',409);
  return Object.freeze({userId:user.id,role:user.role,slot:'growth-campaign',canEdit:true,credentialMac:a.credential_mac,caps:Object.freeze(['read_content','draft','validate','submit'])});
 }
 function campaignDeliveryFor(transport){
  if(!campaignSubmit)err('EDIT_NOT_READY',403);
  return require('./crm-campaign-delivery.cjs').createCampaignDelivery({db,authorize:campaignWriterAuthorization,transport,now,encrypt,decrypt,hasOpenCreate:hasOpenCampaignCreate,
   prepareDefinition:(definition,{catalog,id,now:time})=>require('./campaign-write-contract.js').prepare(definition,{catalog,tracking:require('./campaign-write-tracking.js'),trackingId:id,now:time}).definition});
 }
 function campaignCreateFor(transport){
  if(!campaignSubmit)err('EDIT_NOT_READY',403);
  const C=require('./campaign-write-contract.js'),T=require('./campaign-write-tracking.js');
  const creator=require('./crm-campaign-create.cjs').createCampaignCreator({db,enabled:true,profile:masterWriter?masterWriter.mode:'crm-sandbox',...(masterWriter?{corporateWriter:masterWriter}:{}),allowedEmailDomains:options.allowedEmailDomains,authorize:campaignWriterAuthorization,transport,now,encrypt,decrypt,
   hasOpenDelivery:(userId,brand)=>!!db.prepare("SELECT 1 FROM crm_campaign_delivery_v1 WHERE user_id=? AND brand=? AND phase IN ('queued','uncertain','confirmed')").get(userId,brand),
   preflightDefinition:(definition,{catalog,now:time})=>C.preflight(definition,{catalog,tracking:T,now:time}),
   prepareDefinition:(definition,{catalog,id,now:time})=>{const p=C.prepare(definition,{catalog,tracking:T,trackingId:id,now:time});return {definition:p.definition,tracking:p.tracking};}});
  campaignCreateInitialized=true;return creator;
 }
 async function setSandboxCredential({context,userId,slot,bearer,fetchImpl=globalThis.fetch}){
  if(!['growth-read','growth-audience-read','growth-audience'].includes(slot))err('CREDENTIAL_INVALID',400);
  const user=credentialTarget({context,userId,slot,bearer});
  if(user.role!=='manager'||user.state!=='active')err('GRANT_DENIED',403);
  try{await verifySandboxCredential({slot,expectedOwner:user.email,bearer},{fetchImpl});}
  catch{err('CREDENTIAL_ATTESTATION_FAILED',403);}
  const currentUser=credentialTarget({context,userId,slot,bearer});
  if(currentUser.email!==user.email||currentUser.updated_at!==user.updated_at||currentUser.role!=='manager'||currentUser.state!=='active')err('CREDENTIAL_ATTESTATION_FAILED',403);
  return storeUpstreamCredential({context,userId,slot,bearer});
 }
 async function setCrmPanelReadCredential({context,userId,slot,bearer,fetchImpl=globalThis.fetch}){
  if(slot!=='crm-panel-read')err('CREDENTIAL_INVALID',400);
  const user=credentialTarget({context,userId,slot,bearer});
  if(!crmPanelReadOwner(user,context)||user.state!=='active')err('GRANT_DENIED',403);
  let proof;
  try{proof=await verifyCredential({slot,expectedOwner:user.email,bearer},{fetchImpl});}
  catch{err('CREDENTIAL_ATTESTATION_FAILED',403);}
  if(proof?.ok!==true||proof.slot!==slot||proof.area!=='growth'||proof.identityVerified!==true||proof.capabilityEvidence!=='read-caps-only'||proof.status!=='partial'||proof.readOnlyProven!==false)err('CREDENTIAL_ATTESTATION_FAILED',403);
  return storeUpstreamCredential({context,userId,slot,bearer},{crmAttested:true,expectedOwner:user.email,expectedUpdatedAt:user.updated_at});
 }
 function getUpstreamCredential(ctx){
  const definition=CREDENTIAL_SLOTS[ctx?.slot];if(!definition||ctx.area!==definition.area||!!ctx.edit!==definition.mayWrite)err('CREDENTIAL_DENIED',403);
  const user=authorize(ctx);
  if(user.role==='manager')authorizeBrand(ctx,ctx.brand);
  if(ctx.slot==='crm-panel-read'&&user.role==='manager'&&managedCrm&&managedCrm.credentialReady(user.id)===false)err('CRM_ACCESS_NOT_READY',503);
  const row=db.prepare('SELECT encrypted_key,key_digest FROM upstream_credentials WHERE user_id=? AND slot=?').get(user.id,ctx.slot);
  if(!row)return null;
  if(user.role==='superadmin'&&campaignSubmit&&ctx.slot==='growth-campaign'&&!writerBinding(user))err('CREDENTIAL_UNAVAILABLE',503);
  if(user.role==='manager'){
   if(ctx.slot==='crm-panel-read'&&managedCrm){if(managedCrm.credentialReady(user.id)!==true)err('CRM_ACCESS_NOT_READY',503);}
   else if(ctx.slot==='growth-campaign'&&managedWriter){if(!managedWriter.bindingForUser(user.id))err('CREDENTIAL_UNAVAILABLE',503);}
   else{const bound=db.prepare('SELECT binding_mac FROM upstream_brand_bindings_v1 WHERE user_id=? AND slot=?').get(user.id,ctx.slot);if(!bound||!equalHex(bound.binding_mac,upstreamBindingMac(user,ctx.slot,row)))err('CREDENTIAL_UNAVAILABLE',503);}
  }
  const bearer=decrypt(row.encrypted_key);
  if(!equalHex(row.key_digest,crypto.createHmac('sha256',encKey).update('upstream-key:'+bearer).digest('hex')))err('CREDENTIAL_UNAVAILABLE',503);
  return bearer;
 }
 // PRIVATE: bridges only reviewed GETs. No slot alias or bearer is returned.
 function managedCrmReadAuthorization(ctx){
  if(!managedCrm||ctx?.method!=='GET')err('MANAGED_READ_DENIED',403);
  const user=authorizeBrand({...ctx,area:'growth',edit:false},ctx.brand);
  if(user.role!=='manager'||user.areas.length!==1||user.areas[0]!=='growth'||user.permissions.growth?.read!==true||user.permissions.growth?.edit!==false&&!(corporateWriter&&managedWriter.bindingForUser(user.id)))err('MANAGED_READ_DENIED',403);
  const binding=managedCall(()=>managedCrm.readBinding(user.id));
  const row=db.prepare("SELECT key_digest FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").get(user.id);
  if(!row||binding.owner!==user.email)err('CRM_ACCESS_NOT_READY',503);
  return Object.freeze({...binding,credentialMac:row.key_digest,slot:'crm-panel-read',caps:Object.freeze(['read_content','list_history','submission'])});
 }
 function audienceWriterAuthorization(ctx,{brand}={}){
  if(!corporateWriter&&!ownMasterAudienceWrite)err('EDIT_NOT_READY',403);
  return campaignWriterAuthorization(ctx,{brand,action:'audience'});
 }
 // PRIVATE original-Master read binding. The original audience service itself
 // authenticates this same central key for read_content on every request.
 // This snapshot selects no new actor/slot, issues no grant and admits no POST.
 function ownMasterAudienceReadBinding(ctx,{brand}={}){
  if(!ownMasterWriter||ctx?.method!=='GET')err('MASTER_AUDIENCE_READ_DENIED',403);
  draftBrand(brand);const user=authorizeBrand({...ctx,area:'growth',edit:true},brand),a=writerBinding(user);
  if(user.role!=='superadmin'||user.email!==adminEmail||!a)err('CREDENTIAL_ATTESTATION_REQUIRED',403);
  const credential=getUpstreamCredential({...ctx,area:'growth',edit:true,slot:'growth-campaign',brand});
  if(!credential)err('CREDENTIAL_UNAVAILABLE',503);
  return Object.freeze({userId:user.id,credential,binding:brandMac(['original-master-audience-read-v1',user.id,brand,profileRevision(user.id),a.principal_id,a.credential_mac,a.expires_at,a.attested_at,a.master_proof_mac])});
 }
 // PRIVATE write/receipt binding of the SAME original Master credential.
 // Provenance comes from the authenticated original service, never the caller.
 function ownMasterAudienceWriteBinding(ctx,{brand}={}){
  if(!ownMasterAudienceWrite||!['GET','POST'].includes(ctx?.method))err('MASTER_AUDIENCE_WRITE_DENIED',403);
  const authorized=audienceWriterAuthorization(ctx,{brand});
  const credential=getUpstreamCredential({...ctx,area:'growth',edit:true,slot:'growth-campaign',brand});
  if(!credential)err('CREDENTIAL_UNAVAILABLE',503);
  return Object.freeze({userId:authorized.userId,credential,binding:brandMac(['original-master-audience-write-v1',authorized.userId,brand,authorized.credentialMac,profileRevision(authorized.userId)])});
 }
 function ownMasterAudienceReadReady(ctx){
  if(!ownMasterWriter)return false;
  try{const u=authorize({...ctx,method:'GET',area:'growth',edit:false});return u.role==='superadmin'&&!!writerBinding(u);}catch{return false;}
 }
 function audienceDraftReady(ctx){
  if(ownMasterWriter)return ownMasterAudienceWrite&&campaignWriterReady(ctx);
  if(corporateWriter)return campaignWriterReady(ctx);
  const user=authorize({...ctx,method:'GET',area:'growth',edit:false});
  return user.role==='manager'&&user.permissions.growth?.edit===true&&db.prepare("SELECT COUNT(*) AS n FROM upstream_credentials WHERE user_id=? AND slot IN ('growth-read','growth-audience-read','growth-audience')").get(user.id).n===3;
 }
 const draftBrand=brand=>{if(!['fish','aristo'].includes(brand))err('BRAND_INVALID',400);return brand;};
 const draftKey=key=>{if(typeof key!=='string'||!(/^[A-Za-z0-9_-]{16,100}$/).test(key))err('OPERATION_KEY_INVALID',400);return key;};
 // The audience journal accepts generated UUIDs only: keys are identifiers,
 // never a place for a segment name, customer data or other request content.
 const audienceKey=key=>{if(typeof key!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(key))err('OPERATION_KEY_INVALID',400);return key;};
 const audienceHash=hash=>{if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))err('OPERATION_HASH_INVALID',400);return hash;};
 const audienceMac=hash=>crypto.createHmac('sha256',encKey).update('audience-payload-v2:'+audienceHash(hash)).digest('hex');
 const audienceActorMac=hash=>crypto.createHmac('sha256',encKey).update('audience-actor-v2:'+audienceHash(hash)).digest('hex');
 const audienceDefinitionMac=hash=>crypto.createHmac('sha256',encKey).update('audience-definition-v2:'+audienceHash(hash)).digest('hex');
 const audiencePayloadMatches=(mac,hash)=>typeof mac==='string'&&/^[a-f0-9]{64}$/.test(mac)&&typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash)&&crypto.timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(audienceMac(hash),'hex'));
 const audienceActorMatches=(mac,hash)=>typeof mac==='string'&&/^[a-f0-9]{64}$/.test(mac)&&typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash)&&crypto.timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(audienceActorMac(hash),'hex'));
 const audienceDefinitionMatches=(mac,hash)=>typeof mac==='string'&&/^[a-f0-9]{64}$/.test(mac)&&typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash)&&crypto.timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(audienceDefinitionMac(hash),'hex'));
 const unresolvedCampaignDraft=userId=>!!db.prepare("SELECT 1 FROM campaign_draft_operations WHERE user_id=? AND phase IN ('pending','uncertain') LIMIT 1").get(userId);
 function unresolvedCampaignDelivery(userId,brand){
  if(!campaignSubmit||!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='crm_campaign_delivery_v1'").get())return false;
  return !!db.prepare("SELECT 1 FROM crm_campaign_delivery_v1 WHERE user_id=? AND (? IS NULL OR brand=?) AND phase IN ('queued','uncertain','confirmed') LIMIT 1").get(userId,brand??null,brand??null);
 }
 const unresolvedAudienceDraft=userId=>!!db.prepare("SELECT 1 FROM audience_draft_operations WHERE user_id=? AND phase IN ('pending','uncertain') LIMIT 1").get(userId);
 const audienceActions=new Set(['segmento_criar','segmento_salvar','segmento_arquivar']);
 const audienceRejectCodes=new Set(['SEGMENT_CATALOG_CHANGED','SEGMENT_VERSION_CONFLICT','SEGMENT_ARCHIVED','SEGMENT_NOT_FOUND','SEGMENT_UNAVAILABLE','SEGMENT_LIST_UNAVAILABLE','SEGMENT_SHAPE','SEGMENT_FIELDS','SEGMENT_NAME','SEGMENT_RULE','SEGMENT_LIMIT','SEGMENT_VERSION','SEGMENT_BRAND_MISMATCH','SEGMENT_VERSION_REQUIRED','SEGMENT_LIST_ID']);
 function audienceDraft(context,brand){
  const user=authorizeBrand({...context,area:'growth',edit:true},brand);
  return db.prepare('SELECT operation_key AS operationKey,payload_mac AS payloadMac,actor_mac AS actorMac,definition_mac AS definitionMac,request_id AS requestId,expected_version AS expectedVersion,action,phase,receipt_status AS receiptStatus,receipt_code AS receiptCode,segment_id AS segmentId,segment_version AS segmentVersion,updated_at AS updatedAt FROM audience_draft_operations WHERE user_id=? AND brand=?').get(user.id,draftBrand(brand))||null;
 }
 function reserveAudienceDraft(context,brand,key,action,payloadSha256,actorSha256,{id=null,expectedVersion=null,definitionSha256=null}={}){
  if(context?.method!=='POST')err('METHOD_DENIED',405);
  draftBrand(brand);audienceKey(key);const payloadMac=audienceMac(payloadSha256),actorMac=audienceActorMac(actorSha256);
  if(!audienceActions.has(action))err('OPERATION_INVALID',400);
  const creating=action==='segmento_criar',saving=action==='segmento_salvar';
  if(creating?(id!==null||expectedVersion!==null||definitionSha256===null):
    typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)||
    !Number.isSafeInteger(expectedVersion)||expectedVersion<1||expectedVersion>999999999||
    (saving?definitionSha256===null:definitionSha256!==null))err('OPERATION_METADATA_INVALID',400);
  const definitionMac=definitionSha256===null?null:audienceDefinitionMac(definitionSha256);
  // Serialize permission checking and reservation with admin grant/credential
  // changes, including when a future gateway runs in another process.
  db.exec('BEGIN IMMEDIATE');try{
   const user=authorizeBrand({...context,area:'growth',edit:true},brand);
   // Reserve before any future upstream call. An unresolved operation can
   // never be overwritten or retried under another key.
   const result=db.prepare(`INSERT INTO audience_draft_operations(user_id,brand,operation_key,payload_mac,actor_mac,definition_mac,request_id,expected_version,action,phase,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,'pending',?) ON CONFLICT(user_id,brand) DO UPDATE SET
    operation_key=excluded.operation_key,payload_mac=excluded.payload_mac,actor_mac=excluded.actor_mac,definition_mac=excluded.definition_mac,request_id=excluded.request_id,expected_version=excluded.expected_version,action=excluded.action,phase='pending',
    receipt_status=NULL,receipt_code=NULL,segment_id=NULL,segment_version=NULL,updated_at=excluded.updated_at
    WHERE audience_draft_operations.phase IN ('succeeded','rejected')
    AND audience_draft_operations.operation_key<>excluded.operation_key`).run(user.id,brand,key,payloadMac,actorMac,definitionMac,id,expectedVersion,action,current());
   if(result.changes!==1)err('AUDIENCE_RECONCILIATION_REQUIRED',409);
   db.exec('COMMIT');return user.id;
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 // A future gateway caller must first verify the upstream operation lookup
 // against this user, brand, key and action. An unconfirmed lookup (including
 // a 404) is not a terminal rejection; it leaves this journal uncertain.
 function audienceDraftOutcome(userId,brand,key,action,phase,{receiptStatus=null,receiptCode=null,segmentId=null,segmentVersion=null}={}){
  if(typeof userId!=='string'||!userId||!['uncertain','succeeded','rejected'].includes(phase))err('OPERATION_INVALID',500);
  draftBrand(brand);audienceKey(key);
  if(!audienceActions.has(action))err('OPERATION_INVALID',500);
  const success=phase==='succeeded'&&receiptStatus===(action==='segmento_criar'?201:200)&&receiptCode===null&&typeof segmentId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(segmentId)&&Number.isSafeInteger(segmentVersion)&&segmentVersion>0;
  const rejection=phase==='rejected'&&[404,409,422,503].includes(receiptStatus)&&audienceRejectCodes.has(receiptCode)&&segmentId===null&&segmentVersion===null;
  const uncertain=phase==='uncertain'&&receiptStatus===null&&receiptCode===null&&segmentId===null&&segmentVersion===null;
  if(!success&&!rejection&&!uncertain)err('OPERATION_INVALID',500);
  const result=db.prepare("UPDATE audience_draft_operations SET phase=?,receipt_status=?,receipt_code=?,segment_id=?,segment_version=?,updated_at=? WHERE user_id=? AND brand=? AND operation_key=? AND action=? AND phase IN ('pending','uncertain') AND (?='uncertain' OR payload_mac IS NOT NULL AND actor_mac IS NOT NULL AND (action='segmento_criar' AND definition_mac IS NOT NULL AND request_id IS NULL AND expected_version IS NULL OR action='segmento_salvar' AND definition_mac IS NOT NULL AND request_id IS NOT NULL AND expected_version IS NOT NULL OR action='segmento_arquivar' AND definition_mac IS NULL AND request_id IS NOT NULL AND expected_version IS NOT NULL))")
   .run(phase,receiptStatus,receiptCode,segmentId,segmentVersion,current(),userId,brand,key,action,phase);
  if(result.changes!==1){
   const row=db.prepare('SELECT phase,receipt_status,receipt_code,segment_id,segment_version FROM audience_draft_operations WHERE user_id=? AND brand=? AND operation_key=? AND action=?').get(userId,brand,key,action);
   if(row&&['succeeded','rejected'].includes(row.phase)){
    // A delayed timeout cannot undo a verified receipt. A contradictory
    // terminal receipt is a reconciliation error, not a harmless duplicate.
    if(phase==='uncertain'||row.phase===phase&&row.receipt_status===receiptStatus&&row.receipt_code===receiptCode&&row.segment_id===segmentId&&row.segment_version===segmentVersion)return false;
   }
   err('OPERATION_CHANGED',409);
  }
  return true;
 }
 function campaignDraft(context,brand){
  const user=authorizeBrand({...context,area:'growth'},brand);
  if(!user.permissions.growth?.edit)err('GRANT_DENIED',403);
  return db.prepare('SELECT operation_key AS operationKey,phase,receipt_state AS receiptState,campaign_id AS campaignId,updated_at AS updatedAt FROM campaign_draft_operations WHERE user_id=? AND brand=?').get(user.id,draftBrand(brand))||null;
 }
 function reserveCampaignDraft(context,brand,key){
  const user=authorizeBrand({...context,area:'growth',edit:true},brand);draftBrand(brand);draftKey(key);
  const result=db.prepare(`INSERT INTO campaign_draft_operations(user_id,brand,operation_key,phase,updated_at)
   VALUES(?,?,?,'pending',?) ON CONFLICT(user_id,brand) DO UPDATE SET
   operation_key=excluded.operation_key,phase='pending',receipt_state=NULL,campaign_id=NULL,updated_at=excluded.updated_at
   WHERE campaign_draft_operations.phase IN ('succeeded','rejected')
   AND campaign_draft_operations.operation_key<>excluded.operation_key`).run(user.id,brand,key,current());
  if(result.changes!==1)err('OPERATION_PENDING',409);
  return user.id;
 }
 function campaignDraftOutcome(userId,brand,key,phase,{receiptState=null,campaignId=null}={}){
  if(typeof userId!=='string'||!['uncertain','succeeded','rejected'].includes(phase))err('OPERATION_INVALID',500);
  draftBrand(brand);draftKey(key);
  if(receiptState!==null&&!['pending','outcome_unknown','succeeded','rejected'].includes(receiptState))err('OPERATION_INVALID',500);
  if(campaignId!==null&&(!Number.isSafeInteger(campaignId)||campaignId<1))err('OPERATION_INVALID',500);
  const result=db.prepare("UPDATE campaign_draft_operations SET phase=?,receipt_state=?,campaign_id=?,updated_at=? WHERE user_id=? AND brand=? AND operation_key=? AND phase IN ('pending','uncertain')").run(phase,receiptState,campaignId,current(),userId,brand,key);
  if(result.changes!==1){
   const row=db.prepare('SELECT phase FROM campaign_draft_operations WHERE user_id=? AND brand=? AND operation_key=?').get(userId,brand,key);
   if(row&&['succeeded','rejected'].includes(row.phase))return false;
   err('OPERATION_CHANGED',409);
  }
  return true;
 }
 function close(){db.close();}
 const nativeConsent=context=>{
   if(context?.nativeBearer!==undefined)err('NATIVE_BROWSER_CONSENT_REQUIRED',403);
   const user=adminContext(context),found=lookup(context,false);
   if(!found?.tokenHash)err('NATIVE_BROWSER_CONSENT_REQUIRED',403);
   return {userId:user.id,sessionHash:found.tokenHash};
  };
 const nativeIdentity=userId=>{
   const user=db.prepare('SELECT * FROM users WHERE id=?').get(userId);if(!user)return null;
   return {role:user.role,active:user.state==='active',canEditGrowth:permissions(userId).growth?.edit===true,
    revision:crypto.createHmac('sha256',encKey).update('native-owner-v1:'+JSON.stringify([user.id,user.email,user.role,user.state,user.password_hash])).digest('hex')};
  };
 if(options.crmNativeEnabled===true)nativeConnections=require('./crm-native-delegation.cjs').createDelegationStore({db,managerHost,now:current,mac:value=>crypto.createHmac('sha256',encKey).update('native-delegation-v1:'+value).digest('hex'),consent:nativeConsent,identity:nativeIdentity});
 const nativeDatabaseVault=options.crmNativeEnabled===true&&options.crmNativeDatabaseEnabled===true?require('./native-database-vault.cjs').createDatabaseVault({enabled:true,db,consent:nativeConsent,identity:nativeIdentity,encrypt,decrypt,now:current,mac:value=>crypto.createHmac('sha256',encKey).update('native-database-vault-v1:'+value).digest('hex')}):undefined;
 return Object.freeze({...(nativeDatabaseVault?{nativeDatabaseVault}:{}),...(nativeConnections?{nativeConnections}:{}),beginBootstrap,completeBootstrap,login,session,authorize,authorizeBrand,logout,createInvite,acceptInvite,users,updateUserProfile,finishUserProfileUpdate,reconcileUserProfileUpdates,renewManagedCrm,setGrants,setRequestedAccess,revokeUser,setUpstreamCredential,setSandboxCredential,setCrmPanelReadCredential,getUpstreamCredential,audienceDraftReady,campaignDraft,reserveCampaignDraft,campaignDraftOutcome,audienceDraft,reserveAudienceDraft,audienceDraftOutcome,audiencePayloadMatches,audienceActorMatches,audienceDefinitionMatches,...(campaignSubmit?{installCampaignWriter,installMasterCampaignWriter,campaignWriterReady,campaignHistoryRead,campaignWriterAuthorization,campaignDeliveryFor,campaignCreateFor}:{}),...(campaignSubmit&&masterWriter?{activateOwnMasterCampaignWriter,activateNativeOwnMasterCampaignWriter}:{}),...(ownMasterWriter?{ownMasterAudienceReadBinding,ownMasterAudienceReadReady}:{}),...(ownMasterAudienceWrite?{ownMasterAudienceWriteBinding,audienceWriterAuthorization}:{}),...(campaignSubmit&&corporateWriter?{campaignContentAdmissionSnapshot,audienceWriterAuthorization}:{}),...(managedCrm?{managedCrmJournal:managedCrm,managedCrmReadAuthorization}:{}),...(managedWriter?{fulfillManagedCampaignWriterRequests,approveManagedCampaignWriter,renewManagedCampaignWriter,managedCampaignWriterJournal:managedWriter.journal}:{}),close});
}
module.exports={createAuth,AuthError,AREAS,BRANDS,AREA_BRANDS,CREDENTIAL_SLOTS,COOKIE};
