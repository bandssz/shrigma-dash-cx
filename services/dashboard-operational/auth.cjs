'use strict';
/**
 * Dashboard identity store. Only the HTTP gateway may import this module.
 *
 * createAuth({dbPath, managerHost, areaHosts, allowedEmailDomains,
 *   bootstrapAdminEmail, bootstrapTokenSha256, encryptionKey, now?}) returns:
 *   beginBootstrap/completeBootstrap, login, session, authorize, logout,
 *   createInvite, acceptInvite, users, setGrants, revokeUser,
 *   setUpstreamCredential, getUpstreamCredential, close.
 *
 * `context` is {cookieHeader, host, method, origin, csrf}. An admin mutation
 * requires a valid superadmin session plus POST, exact Origin and CSRF. The
 * gateway must never serialize getUpstreamCredential() or invite tokens into
 * logs. Invite tokens are delivered once, via a URL fragment or another secure
 * channel. No bearer key or password is stored in clear text in this database.
 * Recovery of a lost superadmin TOTP requires a verified offline maintenance
 * procedure against the private database backup; no public reset route exists.
 */
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');
const crypto=require('node:crypto');
const {promisify}=require('node:util');
const scrypt=promisify(crypto.scrypt);

const AREAS=Object.freeze(['growth','organico','influs']);
const AREA_SET=new Set(AREAS);
// The HTTP gateway, never browser input, selects one of these fixed slots.
// A slot can contain an individual upstream bearer for the named user only.
const CREDENTIAL_SLOTS=Object.freeze({
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
 'organico-links':{area:'organico',mayWrite:false},
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
const base32Alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

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
function encodeBase32(bytes){
 let bits=0,acc=0,out='';for(const byte of bytes){acc=(acc<<8)|byte;bits+=8;while(bits>=5){bits-=5;out+=base32Alphabet[(acc>>>bits)&31];}}if(bits)out+=base32Alphabet[(acc<<(5-bits))&31];return out;
}
function decodeBase32(value){
 if(typeof value!=='string'||!/^[A-Z2-7]{16,64}$/.test(value))err('TOTP_INVALID',400);
 let bits=0,acc=0,bytes=[];for(const ch of value){acc=(acc<<5)|base32Alphabet.indexOf(ch);bits+=5;if(bits>=8){bits-=8;bytes.push((acc>>>bits)&255);}}return Buffer.from(bytes);
}
function totpAt(secret,timeMs){
 const counter=Math.floor(timeMs/30000),b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(counter));
 const digest=crypto.createHmac('sha1',decodeBase32(secret)).update(b).digest();const o=digest[19]&15;
 return String((digest.readUInt32BE(o)&0x7fffffff)%1000000).padStart(6,'0');
}
function totpStep(secret,code,timeMs,lastStep=-1){
 if(typeof code!=='string'||!/^[0-9]{6}$/.test(code))return -1;
 const step=Math.floor(timeMs/30000);
 for(const offset of [0,-1,1]){const candidate=step+offset;if(candidate>lastStep&&candidate>=0&&crypto.timingSafeEqual(Buffer.from(totpAt(secret,candidate*30000)),Buffer.from(code)))return candidate;}
 return -1;
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
 CREATE TABLE IF NOT EXISTS upstream_credentials (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,slot TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,key_digest TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,slot));
 CREATE INDEX IF NOT EXISTS upstream_key_digest ON upstream_credentials(key_digest);
 CREATE TABLE IF NOT EXISTS login_limits (
  bucket TEXT PRIMARY KEY,attempts INTEGER NOT NULL,first_at INTEGER NOT NULL,locked_until INTEGER NOT NULL);`);
 const findUser=db.prepare('SELECT * FROM users WHERE email=?');
 db.exec('BEGIN IMMEDIATE');
 try{
  const admins=db.prepare("SELECT * FROM users WHERE role='superadmin'").all();
  if(admins.length>1||admins.length===1&&admins[0].email!==adminEmail)err('ADMIN_CONFIG_DRIFT',500);
  if(!admins.length){
   if(findUser.get(adminEmail))err('ADMIN_CONFIG_DRIFT',500);
   const id=crypto.randomUUID(),t=current(),totp=encodeBase32(crypto.randomBytes(20));
   db.prepare('INSERT INTO users(id,email,role,state,totp_secret,bootstrap_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,adminEmail,'superadmin','bootstrap',encrypt(totp),options.bootstrapTokenSha256,t,t);
   for(const a of AREAS)db.prepare('INSERT INTO grants(user_id,area,can_read,can_edit) VALUES(?,?,1,0)').run(id,a);
  }else{
   const admin=admins[0],grants=db.prepare('SELECT area,can_read FROM grants WHERE user_id=?').all(admin.id);
   if(!['bootstrap','active'].includes(admin.state)||grants.length!==3||AREAS.some(a=>!grants.some(g=>g.area===a&&g.can_read===1))||admin.state==='bootstrap'&&admin.bootstrap_hash!==options.bootstrapTokenSha256)err('ADMIN_CONFIG_DRIFT',500);
   decrypt(admin.totp_secret);
  }
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');db.close();throw e;}
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
  const secret=decrypt(user.totp_secret);
  return {totpSecret:secret,otpauthUrl:`otpauth://totp/${encodeURIComponent('Shrigma:'+user.email)}?secret=${secret}&issuer=Shrigma&algorithm=SHA1&digits=6&period=30`};
 }
 async function completeBootstrap({email,token,password,totp,host,origin}){
  const h=knownHost(host);if(h!==managerHost)err('HOST_DENIED',403);checkOrigin(h,origin);
  const user=findUser.get(emailAddress(email,domainSet));
  if(!user||user.email!==adminEmail||user.state!=='bootstrap'||!equalHex(sha(String(token||'')),user.bootstrap_hash))err('BOOTSTRAP_DENIED',403);
  const step=totpStep(decrypt(user.totp_secret),totp,current());if(step<0)err('TOTP_INVALID',401);
  const hash=await hashPassword(password),t=current();
  // The first regular login may immediately reuse the enrollment code once.
  const result=db.prepare("UPDATE users SET state='active',password_hash=?,bootstrap_hash=NULL,totp_last_step=?,updated_at=? WHERE id=? AND state='bootstrap' AND bootstrap_hash=?").run(hash,step-1,t,user.id,user.bootstrap_hash);
  if(result.changes!==1)err('BOOTSTRAP_DENIED',403);return {ok:true};
 }
 function bucket(key,t){const row=db.prepare('SELECT * FROM login_limits WHERE bucket=?').get(key);if(!row||t-row.first_at>=RATE_MS){db.prepare('INSERT INTO login_limits(bucket,attempts,first_at,locked_until) VALUES(?,0,?,0) ON CONFLICT(bucket) DO UPDATE SET attempts=0,first_at=excluded.first_at,locked_until=0').run(key,t);return {attempts:0,locked_until:0};}return row;}
 function recordAttempt(keys,t){for(const [key,limit]of keys){const row=bucket(key,t),attempts=row.attempts+1;db.prepare('UPDATE login_limits SET attempts=?,locked_until=? WHERE bucket=?').run(attempts,attempts>=limit?t+RATE_MS:row.locked_until,key);}}
 function cleanSuccess(keys){for(const [key]of keys)db.prepare('DELETE FROM login_limits WHERE bucket=?').run(key);}
 async function login({email,password,totp,host,origin,ip='unknown'}){
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
  let allowed=!!(user&&user.state==='active'&&valid&&(user.role==='superadmin'?h===managerHost:user.role==='manager'&&area&&managerAreas.length===1&&managerAreas[0]===area));
  let step=-1;
  if(allowed&&user.role==='superadmin'){
   step=totpStep(decrypt(user.totp_secret),totp,t,user.totp_last_step);
   allowed=step>=0;
  }
  if(!allowed)err('AUTH_INVALID',401);
  if(step>=0&&db.prepare('UPDATE users SET totp_last_step=? WHERE id=? AND totp_last_step<?').run(step,user.id,step).changes!==1)err('AUTH_INVALID',401);
  cleanSuccess(keys);
  const token=random(),uiKey='ui-'+crypto.randomBytes(16).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at<=? OR idle_expires_at<=?').run(t,t);
  db.prepare('INSERT INTO sessions(token_hash,user_id,host,ui_key,created_at,expires_at,idle_expires_at) VALUES(?,?,?,?,?,?,?)').run(sha(token),user.id,h,uiKey,t,t+SESSION_MS,t+IDLE_MS);
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
  return {user,csrf,uiKey:row.ui_key,tokenHash:row.token_hash,host:h};
 }
 function session(ctx){const found=lookup(ctx);return found?{authenticated:true,user:found.user,csrf:found.csrf,uiKey:found.uiKey}:{authenticated:false};}
 function authorize(ctx={}){
  const found=lookup(ctx);if(!found)err('SESSION_REQUIRED',401);
  const method=ctx.method||'GET';if(!['GET','HEAD','POST'].includes(method))err('METHOD_DENIED',405);
  if(method==='POST'){
   requireWriteContext(ctx);
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
 function createInvite({context,email,areas,permissions:requested,expiresMs=INVITE_MS}){
  adminContext(context);const e=emailAddress(email,domainSet),p=invitePermissions(areas,requested);
  if(!Number.isSafeInteger(expiresMs)||expiresMs<5*60*1000||expiresMs>72*60*60*1000)err('INVITE_INVALID',400);
  const existing=findUser.get(e);if(existing&&existing.state!=='disabled')err('USER_EXISTS',409);
  const t=current(),id=existing?.id||crypto.randomUUID(),token=random(),host=areaHosts[areas[0]];
  db.exec('BEGIN IMMEDIATE');try{
   db.prepare('DELETE FROM invites WHERE expires_at<=? OR used_at IS NOT NULL').run(t);
   if(existing){db.prepare("UPDATE users SET role='manager',state='invited',password_hash=NULL,totp_secret=NULL,totp_last_step=-1,updated_at=? WHERE id=? AND state='disabled'").run(t,id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);db.prepare('DELETE FROM upstream_credentials WHERE user_id=?').run(id);db.prepare('DELETE FROM invites WHERE user_id=?').run(id);}
   else db.prepare('INSERT INTO users(id,email,role,state,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,e,'manager','invited',t,t);
   db.prepare('DELETE FROM grants WHERE user_id=?').run(id);
   for(const [area,g]of Object.entries(p))db.prepare('INSERT INTO grants(user_id,area,can_read,can_edit) VALUES(?,?,1,?)').run(id,area,g.edit?1:0);
   db.prepare('INSERT INTO invites(token_hash,user_id,host,expires_at) VALUES(?,?,?,?)').run(sha(token),id,host,t+expiresMs);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {token,userId:id,host};
 }
 async function acceptInvite({token,password,host,origin}){
  const h=knownHost(host);checkOrigin(h,origin);
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))err('INVITE_DENIED',403);
  const t=current(),hash=sha(token),invite=db.prepare('SELECT i.*,u.state FROM invites i JOIN users u ON u.id=i.user_id WHERE i.token_hash=?').get(hash);
  if(!invite||invite.host!==h||invite.state!=='invited'||invite.used_at!==null||invite.expires_at<=t)err('INVITE_DENIED',403);
  const passwordHash=await hashPassword(password);
  db.exec('BEGIN IMMEDIATE');try{
   const used=db.prepare('UPDATE invites SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?').run(t,hash,t);
   if(used.changes!==1)err('INVITE_DENIED',403);
   const activated=db.prepare("UPDATE users SET password_hash=?,state='active',updated_at=? WHERE id=? AND state='invited'").run(passwordHash,t,invite.user_id);
   if(activated.changes!==1)err('INVITE_DENIED',403);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {ok:true};
 }
 function users({context}){
  authorize({...context,admin:true,method:'GET'});
  return db.prepare('SELECT id,email,role,state FROM users ORDER BY email').all().map(u=>({id:u.id,email:u.email,role:u.role,areas:AREAS.filter(a=>permissions(u.id)[a]?.read),status:u.state}));
 }
 function setGrants({context,userId,permissions:requested}){
  const actor=adminContext(context),user=db.prepare('SELECT id,role,state FROM users WHERE id=?').get(userId);
  if(!user||user.state==='disabled'||user.role==='superadmin'&&user.id!==actor.id)err('USER_DENIED',404);
  const p=normalizePermissions(requested);
  if(user.role==='superadmin'&&(Object.keys(p).length!==3||AREAS.some(a=>!p[a]?.read)))err('GRANTS_INVALID',400);
  if(user.role==='manager'&&Object.keys(p).length!==1)err('GRANTS_INVALID',400);
  db.exec('BEGIN IMMEDIATE');try{
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
   db.prepare("UPDATE users SET state='disabled',password_hash=NULL,updated_at=? WHERE id=?").run(current(),userId);
   db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
   db.prepare('DELETE FROM upstream_credentials WHERE user_id=?').run(userId);
   db.prepare('DELETE FROM invites WHERE user_id=?').run(userId);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}return {ok:true};
 }
 function setUpstreamCredential({context,userId,slot,bearer}){
  adminContext(context);const definition=CREDENTIAL_SLOTS[slot];
  if(!definition||typeof bearer!=='string'||!/^[A-Za-z0-9_.:-]{8,256}$/.test(bearer))err('CREDENTIAL_INVALID',400);
  const user=db.prepare('SELECT state FROM users WHERE id=?').get(userId),grant=permissions(userId)[definition.area];
  if(!user||!['active','invited'].includes(user.state)||!grant?.read||definition.mayWrite&&!grant.edit)err('GRANT_DENIED',403);
  const digest=crypto.createHmac('sha256',encKey).update('upstream-key:'+bearer).digest('hex');
  db.exec('BEGIN IMMEDIATE');try{
   if(db.prepare('SELECT 1 FROM upstream_credentials WHERE key_digest=? AND user_id<>? LIMIT 1').get(digest,userId))err('CREDENTIAL_REUSED',409);
   db.prepare('INSERT INTO upstream_credentials(user_id,slot,encrypted_key,key_digest,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,slot) DO UPDATE SET encrypted_key=excluded.encrypted_key,key_digest=excluded.key_digest,updated_at=excluded.updated_at').run(userId,slot,encrypt(bearer),digest,current());
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {ok:true};
 }
 function getUpstreamCredential(ctx){
  const definition=CREDENTIAL_SLOTS[ctx?.slot];if(!definition||ctx.area!==definition.area||!!ctx.edit!==definition.mayWrite)err('CREDENTIAL_DENIED',403);
  const user=authorize(ctx),row=db.prepare('SELECT encrypted_key FROM upstream_credentials WHERE user_id=? AND slot=?').get(user.id,ctx.slot);
  return row?decrypt(row.encrypted_key):null;
 }
 function close(){db.close();}
 return Object.freeze({beginBootstrap,completeBootstrap,login,session,authorize,logout,createInvite,acceptInvite,users,setGrants,revokeUser,setUpstreamCredential,getUpstreamCredential,close});
}
module.exports={createAuth,AuthError,AREAS,CREDENTIAL_SLOTS,COOKIE,totpAt};
