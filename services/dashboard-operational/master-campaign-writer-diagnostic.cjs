'use strict';
// Local own-Master identity diagnostic only. Opens SQLite read-only when called;
// imports perform no file/network I/O. The original encryption KEY is RAM input.
const {DatabaseSync}=require('node:sqlite'),crypto=require('node:crypto'),path=require('node:path');
const {verifyStoredMasterCampaignWriterCredential}=require('./crm-campaign-writer-attestation.cjs');
const MASTER_EMAIL='felipebandeira@oaristocrata.com';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>typeof a==='string'&&/^[a-f0-9]{64}$/.test(a)&&typeof b==='string'&&/^[a-f0-9]{64}$/.test(b)&&crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
async function diagnoseOwnMasterCampaignWriter({dbPath,encryptionKey,fetchImpl=globalThis.fetch}){
 let db;
 try{
  if(typeof dbPath!=='string'||!path.isAbsolute(dbPath)||!Buffer.isBuffer(encryptionKey)||encryptionKey.length!==32)return {state:'not-ready'};
  const mac=value=>crypto.createHmac('sha256',encryptionKey).update(value).digest('hex');
  db=new DatabaseSync(dbPath,{readOnly:true});
  const snapshot=()=>{
   db.exec('BEGIN');try{
    const user=db.prepare("SELECT id,email,role,state,updated_at FROM users WHERE email=? AND role='superadmin' AND state='active'").get(MASTER_EMAIL);
    if(!user)return null;
    const grants=db.prepare('SELECT area,can_read,can_edit FROM grants WHERE user_id=? ORDER BY area').all(user.id);
    if(!grants.some(g=>g.area==='growth'&&g.can_read===1))return null;
    const source=db.prepare("SELECT slot,encrypted_key,key_digest,updated_at FROM upstream_credentials WHERE user_id=? AND slot IN ('growth-campaign','crm-panel-read','growth-read') ORDER BY CASE slot WHEN 'growth-campaign' THEN 0 WHEN 'crm-panel-read' THEN 1 ELSE 2 END LIMIT 1").get(user.id);
    if(!source)return {user,grants,source:null};
    const bound=db.prepare('SELECT binding_mac FROM upstream_brand_bindings_v1 WHERE user_id=? AND slot=?').get(user.id,source.slot);
    if(!bound||!equal(bound.binding_mac,mac('identity-brand-v1:'+JSON.stringify([user.id,user.email,source.slot,'all',null,source.key_digest,sha(source.encrypted_key)])))||db.prepare('SELECT 1 FROM upstream_credentials WHERE key_digest=? AND user_id<>? LIMIT 1').get(source.key_digest,user.id))return null;
    return {user,grants,source,bindingMac:bound.binding_mac};
   }finally{db.exec('COMMIT');}
  };
  const original=snapshot();if(!original)return {state:'not-ready'};if(!original.source)return {state:'no-slot'};
  const [version,iv,tag,data]=original.source.encrypted_key.split('.');if(version!=='v1'||!iv||!tag||!data)return {state:'not-ready'};
  const decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey,Buffer.from(iv,'base64url'));decipher.setAuthTag(Buffer.from(tag,'base64url'));
  const bearer=Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]).toString('utf8');
  if(!equal(original.source.key_digest,mac('upstream-key:'+bearer)))return {state:'not-ready'};
  await verifyStoredMasterCampaignWriterCredential({bearer,owner:original.user.email},{fetchImpl});
  return {state:JSON.stringify(snapshot())===JSON.stringify(original)?'ready':'not-ready'};
 }catch{return {state:'not-ready'};}
 finally{try{db?.close();}catch{}}
}
module.exports={diagnoseOwnMasterCampaignWriter};
