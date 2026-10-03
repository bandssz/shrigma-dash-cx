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
 if(options.crmCampaignSubmitWrite!==undefined&&typeof options.crmCampaignSubmitWrite!=='boolean'||options.crmCampaignSubmitWrite===true&&(options.crmManagedRead!==undefined||options.allowedEmailDomains.length!==1||options.allowedEmailDomains[0]!=='synthetic.invalid'))err('CAMPAIGN_WRITE_CONFIG_INVALID',500);
 const campaignSubmit=options.crmCampaignSubmitWrite===true;
 if(options.crmManagedWriter!==undefined&&(!campaignSubmit||options.crmManagedRead!==undefined||!plain(options.crmManagedWriter)||Object.keys(options.crmManagedWriter).sort().join(',')!=='issuerId,namespaceId'||Object.values(options.crmManagedWriter).some(v=>typeof v!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v))))err('MANAGED_WRITER_CONFIG_INVALID',500);
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
  key TEXT PRIMARY KEY,encrypted_value TEXT NOT NULL);`);
 if(campaignSubmit)db.exec(`CREATE TABLE IF NOT EXISTS campaign_writer_attestation_v1 (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,owner TEXT NOT NULL,principal_id TEXT NOT NULL UNIQUE,
  credential_mac TEXT NOT NULL,expires_at INTEGER NOT NULL,attested_at INTEGER NOT NULL);`);
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
 let managedCrm=null;
 if(options.crmManagedRead!==undefined)try{
  managedCrm=require('./crm-manager-journal.cjs').createManagerJournal({db,...options.crmManagedRead,encrypt,decrypt,digest:value=>crypto.createHmac('sha256',encKey).update('upstream-key:'+value).digest('hex'),now:current});
 }catch{db.close();err('MANAGED_CONFIG_INVALID',500);}
 let managedWriter=null;
 if(options.crmManagedWriter!==undefined)try{
  managedWriter=require('./crm-manager-writer-auth-adapter.cjs').createWriterAuthAdapter({db,enabled:true,profile:'crm-sandbox',...options.crmManagedWriter,allowedEmailDomains:options.allowedEmailDomains,encrypt,decrypt,digest:value=>crypto.createHmac('sha256',encKey).update('upstream-key:'+value).digest('hex'),now:current});
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
  const status=managedCrm?.status(user.id);if(!status)return null;
  const renewalPhase=managedRenewalPhase(user.id),ready=managedCrm.credentialReady(user.id)===true;
  const expired=status.state==='ready'&&Number.isSafeInteger(status.expiresAt)&&status.expiresAt<=current();
  return {...status,ready,renewalPhase,expired,canRenew:user.role==='manager'&&user.state==='active'&&status.state==='ready'&&ready&&!expired&&renewalPhase===null};
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
 function permissions(userId){const out={};for(const g of db.prepare('SELECT area,can_read,can_edit FROM grants WHERE user_id=? AND can_read=1').all(userId))out[g.area]={read:true,edit:g.can_edit===1};return out;}
 function publicUser(user){const p=permissions(user.id);return {id:user.id,email:user.email,role:user.role,areas:AREAS.filter(a=>p[a]?.read),permissions:p};}
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
  const allowed=!!(user&&user.state==='active'&&valid&&(user.role==='superadmin'?h===managerHost:user.role==='manager'&&area&&managerAreas.length===1&&managerAreas[0]===area));
  if(!allowed)err('AUTH_INVALID',401);
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
  const h=knownHost(ctx?.host),token=cookieToken(ctx?.cookieHeader);if(!token)return null;
  const row=db.prepare('SELECT s.*,u.email,u.role,u.state FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.host=?').get(sha(token),h);
  const t=current();if(!row||row.state!=='active'||row.expires_at<=t||row.idle_expires_at<=t)return null;
  const area=Object.entries(areaHosts).find(([,v])=>v===h)?.[0],perms=permissions(row.user_id);
  const managerAreas=AREAS.filter(a=>perms[a]?.read);
  if(h===managerHost&&row.role!=='superadmin'||area&&(row.role!=='manager'||managerAreas.length!==1||managerAreas[0]!==area))return null;
  if(refresh)db.prepare('UPDATE sessions SET idle_expires_at=? WHERE token_hash=?').run(Math.min(row.expires_at,t+IDLE_MS),row.token_hash);
  const user={id:row.user_id,email:row.email,role:row.role,areas:AREAS.filter(a=>perms[a]?.read),permissions:perms};
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
  }
  return found.user;
 }
 function logout(ctx){const h=requireWriteContext(ctx),found=lookup({...ctx,host:h},false);if(found){authorize({...ctx,host:h});db.prepare('DELETE FROM sessions WHERE token_hash=?').run(found.tokenHash);}return {cookie:cookie('',0)};}
 function adminContext(context){const ctx={...context,admin:true};if(ctx.method!=='POST')err('METHOD_DENIED',405);return authorize(ctx);}
 function createInvite({context,email,areas,permissions:requested,requestedAccess='read',expiresMs=INVITE_MS}){
  adminContext(context);const e=emailAddress(email,domainSet),p=invitePermissions(areas,requested);
  if((managedCrm||managedWriter)&&p.growth?.edit)err('EDIT_NOT_READY',403);
  if(!['read','edit'].includes(requestedAccess))err('ACCESS_REQUEST_INVALID',400);
  if(!Number.isSafeInteger(expiresMs)||expiresMs<5*60*1000||expiresMs>72*60*60*1000)err('INVITE_INVALID',400);
  const existing=findUser.get(e);if(existing&&existing.state!=='disabled')err('USER_EXISTS',409);
  const t=current(),id=existing?.id||crypto.randomUUID(),token=random(),host=areaHosts[areas[0]];
  db.exec('BEGIN IMMEDIATE');try{
   if(existing&&unresolvedAudienceDraft(existing.id))err('AUDIENCE_RECONCILIATION_REQUIRED',409);
   if(existing&&unresolvedCampaignDelivery(existing.id))err('CAMPAIGN_RECONCILIATION_REQUIRED',409);
   if(existing&&p.growth?.edit&&unresolvedCampaignDraft(existing.id))err('DRAFT_RECONCILIATION_REQUIRED',409);
   db.prepare('DELETE FROM invites WHERE expires_at<=? OR used_at IS NOT NULL').run(t);
   if(existing){db.prepare("UPDATE users SET role='manager',state='invited',password_hash=NULL,totp_secret=NULL,totp_last_step=-1,updated_at=? WHERE id=? AND state='disabled'").run(t,id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);db.prepare('DELETE FROM upstream_credentials WHERE user_id=?').run(id);db.prepare('DELETE FROM invites WHERE user_id=?').run(id);}
   else db.prepare('INSERT INTO users(id,email,role,state,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,e,'manager','invited',t,t);
   db.prepare('DELETE FROM grants WHERE user_id=?').run(id);
   for(const [area,g]of Object.entries(p))db.prepare('INSERT INTO grants(user_id,area,can_read,can_edit) VALUES(?,?,1,?)').run(id,area,g.edit?1:0);
   db.prepare('DELETE FROM access_requests WHERE user_id=?').run(id);
   if(requestedAccess==='edit')db.prepare("INSERT INTO access_requests(user_id,requested_access,requested_at) VALUES(?,'edit',?)").run(id,t);
   db.prepare('INSERT INTO invites(token_hash,user_id,host,expires_at) VALUES(?,?,?,?)').run(sha(token),id,host,t+expiresMs);
   if(managedCrm&&p.growth?.read)managedCall(()=>managedCrm.createLifecycle(id));
   if(managedWriter&&p.growth?.read)writerCall(()=>managedWriter.createLifecycle(id));
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
   const activated=db.prepare("UPDATE users SET password_hash=?,state='active',updated_at=? WHERE id=? AND state='invited'").run(passwordHash,acceptedAt,invite.user_id);
   if(activated.changes!==1)err('INVITE_DENIED',403);
   if(managedCrm&&permissions(invite.user_id).growth?.read&&managedCrm.status(invite.user_id))managedCall(()=>managedCrm.activateLifecycle(invite.user_id));
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {ok:true};
 }
 function users({context}){
  authorize({...context,admin:true,method:'GET'});
  return db.prepare('SELECT u.id,u.email,u.role,u.state,r.requested_access FROM users u LEFT JOIN access_requests r ON r.user_id=u.id ORDER BY u.email').all().map(u=>{
   const p=permissions(u.id);
   const crmAccess=managedAccess(u);
   return {id:u.id,email:u.email,role:u.role,areas:AREAS.filter(a=>p[a]?.read),permissions:p,requestedAccess:u.requested_access||'read',status:u.state,...(crmAccess?{crmAccess}:{})};
  });
 }
 function renewManagedCrm({context,userId}){
  adminContext(context);
  if(!managedCrm)err('CRM_PROVISIONING_NOT_READY',403);
  if(typeof userId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(userId))err('USER_INVALID',400);
  try{
   const user=db.prepare('SELECT id,role,state FROM users WHERE id=?').get(userId),p=permissions(userId);
   if(!user||user.role!=='manager'||user.state!=='active'||Object.keys(p).length!==1||p.growth?.read!==true||p.growth?.edit!==false)err('USER_DENIED',404);
   const access=managedAccess(user);
   if(!access||access.state!=='ready')err('CRM_RENEWAL_NOT_READY',409);
   if(access.expired)err('CRM_ACCESS_EXPIRED',409);
   if(access.renewalPhase!==null)err('CRM_RENEWAL_PENDING',409);
   if(!access.canRenew)err('CRM_RENEWAL_NOT_READY',409);
   // renew() owns its SQLite transaction and returns only after COMMIT. The
   // HTTP gateway may then kick its private runtime; this method does no I/O.
   managedCrm.renew(userId);
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
  const t=current();db.exec('BEGIN IMMEDIATE');try{
   if(unresolvedAudienceDraft(userId))err('AUDIENCE_RECONCILIATION_REQUIRED',409);
   db.prepare('DELETE FROM access_requests WHERE user_id=?').run(userId);
   if(requestedAccess==='edit')db.prepare("INSERT INTO access_requests(user_id,requested_access,requested_at) VALUES(?,'edit',?)").run(userId,t);
   else{
    if(managedWriter)writerCall(()=>managedWriter.stageRevoke(userId));
    db.prepare('UPDATE grants SET can_edit=0 WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
    for(const [slot,definition]of Object.entries(CREDENTIAL_SLOTS))if(definition.mayWrite)db.prepare('DELETE FROM upstream_credentials WHERE user_id=? AND slot=?').run(userId,slot);
   }
   db.prepare('UPDATE users SET updated_at=? WHERE id=?').run(t,userId);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {ok:true,requestedAccess};
 }
 function setGrants({context,userId,permissions:requested}){
  const actor=adminContext(context),user=db.prepare('SELECT id,role,state FROM users WHERE id=?').get(userId);
  if(!user||user.state==='disabled'||user.role==='superadmin'&&user.id!==actor.id)err('USER_DENIED',404);
  const p=normalizePermissions(requested);
  if((managedCrm||managedWriter)&&user.role==='manager'&&p.growth?.edit)err('EDIT_NOT_READY',403);
  if(user.role==='superadmin'&&(Object.keys(p).length!==3||AREAS.some(a=>!p[a]?.read)))err('GRANTS_INVALID',400);
  if(user.role==='manager'&&Object.keys(p).length!==1)err('GRANTS_INVALID',400);
  // Invitations are bound to an area host; transfer requires revoke/reinvite.
  if(managedCrm&&user.role==='manager'&&Object.keys(p)[0]!==Object.keys(permissions(userId))[0])err('AREA_CHANGE_REQUIRES_REINVITE',409);
  if(p.growth?.edit&&!permissions(userId).growth?.edit&&unresolvedCampaignDraft(userId))err('DRAFT_RECONCILIATION_REQUIRED',409);
  if(p.growth?.edit&&!permissions(userId).growth?.edit&&unresolvedCampaignDelivery(userId))err('CAMPAIGN_RECONCILIATION_REQUIRED',409);
  db.exec('BEGIN IMMEDIATE');try{
   if(unresolvedAudienceDraft(userId))err('AUDIENCE_RECONCILIATION_REQUIRED',409);
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
   db.prepare('DELETE FROM access_requests WHERE user_id=?').run(userId);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}return {ok:true,...(managedCrm?.status(userId)?{crmRevocationPending:managedCrm.status(userId).state!=='revoked'}:{})};
 }
 function credentialTarget({context,userId,slot,bearer}){
  adminContext(context);const definition=CREDENTIAL_SLOTS[slot];
  if(!definition||typeof bearer!=='string'||!/^[A-Za-z0-9_.:-]{8,256}$/.test(bearer))err('CREDENTIAL_INVALID',400);
  const user=db.prepare('SELECT id,email,role,state,updated_at FROM users WHERE id=?').get(userId),grant=permissions(userId)[definition.area];
  if(!user||!['active','invited'].includes(user.state)||!grant?.read||definition.mayWrite&&!grant.edit)err('GRANT_DENIED',403);
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
   db.prepare('INSERT INTO upstream_credentials(user_id,slot,encrypted_key,key_digest,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,slot) DO UPDATE SET encrypted_key=excluded.encrypted_key,key_digest=excluded.key_digest,updated_at=excluded.updated_at').run(userId,slot,encrypt(bearer),digest,current());
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {ok:true};
 }
 function setUpstreamCredential(args){if(campaignSubmit&&args?.slot==='growth-campaign')err('CREDENTIAL_ATTESTATION_REQUIRED',403);return storeUpstreamCredential(args);}
 // PRIVATE fixture/issuer promotion hook. No HTTP route accepts this payload.
 // The present write gate is restricted to the synthetic identity domain;
 // a reviewed writer issuer is still required before production support.
 async function installCampaignWriter({context,userId,bearer,principalId,expiresAt,fetchImpl=globalThis.fetch}){
  if(!campaignSubmit||managedWriter)err('EDIT_NOT_READY',403);
  const user=credentialTarget({context,userId,slot:'growth-campaign',bearer});
  if(user.role!=='manager'||user.state!=='active'||Object.keys(permissions(userId)).join(',')!=='growth'||!Number.isSafeInteger(expiresAt)||expiresAt<=current()||expiresAt>current()+14*86400000)err('CREDENTIAL_ATTESTATION_REQUIRED',403);
  try{await require('./crm-campaign-writer-attestation.cjs').verifyCampaignWriterCredential({bearer,owner:user.email,principalId},{fetchImpl});}catch{err('CREDENTIAL_ATTESTATION_FAILED',403);}
  const checked=credentialTarget({context,userId,slot:'growth-campaign',bearer});
  if(checked.email!==user.email||checked.updated_at!==user.updated_at||checked.role!=='manager'||checked.state!=='active'||expiresAt<=current())err('CREDENTIAL_ATTESTATION_FAILED',403);
  const digest=crypto.createHmac('sha256',encKey).update('upstream-key:'+bearer).digest('hex');
  db.exec('BEGIN IMMEDIATE');try{
   if(db.prepare('SELECT 1 FROM upstream_credentials WHERE key_digest=? AND user_id<>? LIMIT 1').get(digest,userId))err('CREDENTIAL_REUSED',409);
   db.prepare("INSERT INTO upstream_credentials(user_id,slot,encrypted_key,key_digest,updated_at) VALUES(?,'growth-campaign',?,?,?) ON CONFLICT(user_id,slot) DO UPDATE SET encrypted_key=excluded.encrypted_key,key_digest=excluded.key_digest,updated_at=excluded.updated_at").run(userId,encrypt(bearer),digest,current());
   db.prepare('INSERT INTO campaign_writer_attestation_v1 VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET owner=excluded.owner,principal_id=excluded.principal_id,credential_mac=excluded.credential_mac,expires_at=excluded.expires_at,attested_at=excluded.attested_at').run(userId,user.email,principalId,digest,expiresAt,current());
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}return {ok:true};
 }
 // Private caller only: no new HTTP route and no automatic dispatch.
 function approveManagedCampaignWriter({context,userId}){
  adminContext(context);if(!managedWriter)err('EDIT_NOT_READY',403);
  if(typeof userId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(userId))err('USER_INVALID',400);
  db.exec('BEGIN IMMEDIATE');try{writerCall(()=>managedWriter.approve(userId));db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  // enqueue owns its own transaction. Its failure leaves only an inactive,
  // durable approval; the same admission can be resumed before any RPC.
  writerCall(()=>managedWriter.journal.enqueue(userId,'issue'));return {ok:true};
 }
 function writerBinding(user){
  if(managedWriter)return managedWriter.bindingForUser(user.id);
  if(!campaignSubmit||user.role!=='manager'||user.areas.length!==1||user.areas[0]!=='growth'||user.permissions.growth?.edit!==true)return null;
  const a=db.prepare("SELECT a.*,c.key_digest FROM campaign_writer_attestation_v1 a JOIN upstream_credentials c ON c.user_id=a.user_id AND c.slot='growth-campaign' WHERE a.user_id=?").get(user.id);
  return a&&a.owner===user.email&&a.credential_mac===a.key_digest&&a.expires_at>current()?a:null;
 }
 function campaignWriterReady(ctx){try{return !!writerBinding(authorize({...ctx,method:'GET',area:'growth',edit:false}));}catch{return false;}}
 let campaignCreateInitialized=false;
 function hasOpenCampaignCreate(userId,brand){return campaignCreateInitialized&&!!db.prepare("SELECT 1 FROM crm_campaign_create_v1 WHERE user_id=? AND brand=? AND phase IN ('queued','uncertain','confirmed')").get(userId,brand);}
 function campaignWriterAuthorization(ctx,{brand,action}){
  draftBrand(brand);if(!campaignSubmit)err('EDIT_NOT_READY',403);
  const user=authorize({...ctx,area:'growth',edit:true}),a=writerBinding(user);if(!a)err('CREDENTIAL_ATTESTATION_REQUIRED',403);
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
  const creator=require('./crm-campaign-create.cjs').createCampaignCreator({db,enabled:true,profile:'crm-sandbox',allowedEmailDomains:options.allowedEmailDomains,authorize:campaignWriterAuthorization,transport,now,encrypt,decrypt,
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
  if(ctx.slot==='crm-panel-read'&&user.role==='manager'&&managedCrm&&managedCrm.credentialReady(user.id)===false)err('CRM_ACCESS_NOT_READY',503);
  const row=db.prepare('SELECT encrypted_key FROM upstream_credentials WHERE user_id=? AND slot=?').get(user.id,ctx.slot);
  return row?decrypt(row.encrypted_key):null;
 }
 // PRIVATE: bridges only reviewed GETs. No slot alias or bearer is returned.
 function managedCrmReadAuthorization(ctx){
  if(!managedCrm||ctx?.method!=='GET')err('MANAGED_READ_DENIED',403);
  const user=authorize({...ctx,area:'growth',edit:false});
  if(user.role!=='manager'||user.areas.length!==1||user.areas[0]!=='growth'||user.permissions.growth?.read!==true||user.permissions.growth?.edit!==false)err('MANAGED_READ_DENIED',403);
  const binding=managedCall(()=>managedCrm.readBinding(user.id));
  const row=db.prepare("SELECT key_digest FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").get(user.id);
  if(!row||binding.owner!==user.email)err('CRM_ACCESS_NOT_READY',503);
  return Object.freeze({...binding,credentialMac:row.key_digest,slot:'crm-panel-read',caps:Object.freeze(['read_content','list_history','submission'])});
 }
 function audienceDraftReady(ctx){
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
  const user=authorize({...context,area:'growth',edit:true});
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
   const user=authorize({...context,area:'growth',edit:true});
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
  const user=authorize({...context,area:'growth'});
  if(!user.permissions.growth?.edit)err('GRANT_DENIED',403);
  return db.prepare('SELECT operation_key AS operationKey,phase,receipt_state AS receiptState,campaign_id AS campaignId,updated_at AS updatedAt FROM campaign_draft_operations WHERE user_id=? AND brand=?').get(user.id,draftBrand(brand))||null;
 }
 function reserveCampaignDraft(context,brand,key){
  const user=authorize({...context,area:'growth',edit:true});draftBrand(brand);draftKey(key);
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
 return Object.freeze({beginBootstrap,completeBootstrap,login,session,authorize,logout,createInvite,acceptInvite,users,renewManagedCrm,setGrants,setRequestedAccess,revokeUser,setUpstreamCredential,setSandboxCredential,setCrmPanelReadCredential,getUpstreamCredential,audienceDraftReady,campaignDraft,reserveCampaignDraft,campaignDraftOutcome,audienceDraft,reserveAudienceDraft,audienceDraftOutcome,audiencePayloadMatches,audienceActorMatches,audienceDefinitionMatches,...(campaignSubmit?{installCampaignWriter,campaignWriterReady,campaignWriterAuthorization,campaignDeliveryFor,campaignCreateFor}:{}),...(managedCrm?{managedCrmJournal:managedCrm,managedCrmReadAuthorization}:{}),...(managedWriter?{approveManagedCampaignWriter,managedCampaignWriterJournal:managedWriter.journal}:{}),close});
}
module.exports={createAuth,AuthError,AREAS,CREDENTIAL_SLOTS,COOKIE};
