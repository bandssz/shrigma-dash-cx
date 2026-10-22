import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID, randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';
import {canonical, sha, deny, diff, newRevision, PROTECTED_IDS, contentFingerprint} from './policy.mjs';

export class Store {
  constructor(file, key, {initialize = false, environment = 'test'} = {}) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw Error('MASTER_KEY_REQUIRED');
    if (!initialize && !fs.existsSync(file)) throw Error('LEDGER_MISSING_WRITES_CLOSED');
    if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile())) throw Error('LEDGER_FILE_REFUSED');
    fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
    this.db = new DatabaseSync(file); this.key = key; this.file = file;
    fs.chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=1000;PRAGMA foreign_keys=ON;');
    if (initialize) this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analysts (id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE, active INTEGER NOT NULL, brand TEXT NOT NULL, config TEXT NOT NULL, password_hash TEXT NOT NULL, credential TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS analyst_api_identity ON analysts(json_extract(config,'$.apiUserId'));
      CREATE TABLE IF NOT EXISTS campaigns (id INTEGER PRIMARY KEY, uuid TEXT UNIQUE NOT NULL, brand TEXT NOT NULL, creator TEXT NOT NULL, revision TEXT NOT NULL, snapshot TEXT NOT NULL, fingerprint TEXT NOT NULL, template_sha TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, actor TEXT NOT NULL, brand TEXT NOT NULL, action TEXT NOT NULL, campaign_id INTEGER, request_hash TEXT NOT NULL, request_json TEXT NOT NULL, state TEXT NOT NULL, before_json TEXT, after_json TEXT, diff_json TEXT, code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ack_json TEXT);
      CREATE TABLE IF NOT EXISTS locks (resource TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id));
      CREATE TABLE IF NOT EXISTS test_claims (campaign_id INTEGER NOT NULL, revision TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, PRIMARY KEY(campaign_id,revision));
      CREATE TABLE IF NOT EXISTS phases (id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL, phase TEXT NOT NULL, method TEXT NOT NULL, route TEXT NOT NULL, body_sha TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, brand TEXT, action TEXT NOT NULL, campaign_id INTEGER, result TEXT NOT NULL, detail TEXT NOT NULL, previous_sha TEXT, sha TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS oauth (model TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER, consumed_at INTEGER, grant_id TEXT, uid TEXT, account_id TEXT, user_code TEXT, PRIMARY KEY(model,id));
      CREATE INDEX IF NOT EXISTS oauth_grant ON oauth(grant_id);
      CREATE INDEX IF NOT EXISTS oauth_account ON oauth(account_id);
      CREATE INDEX IF NOT EXISTS oauth_uid ON oauth(model,uid);
      CREATE TABLE IF NOT EXISTS csrf (id TEXT PRIMARY KEY, token_sha TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, until INTEGER NOT NULL);
    `);
    if (initialize && !this.meta('environment')) {
      this.setMeta('environment', environment); this.setMeta('ledger_id', randomUUID()); this.setMeta('connector_id', randomUUID());
    }
    if (this.meta('environment') !== environment || !this.meta('ledger_id')) throw Error('LEDGER_ENVIRONMENT_MISMATCH');
    this.businessEnabled = environment === 'test';
  }
  recoverInterrupted() { this.db.prepare("UPDATE operations SET state='uncertain',code='PROCESS_RESTARTED',updated_at=? WHERE state='started'").run(new Date().toISOString()); }
  close() { this.db.close(); }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try {const out=fn(); this.db.exec('COMMIT'); return out;} catch(e) {this.db.exec('ROLLBACK'); throw e;} }
  meta(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  setMeta(key, value) { this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value)); }
  audit(actor, brand, action, campaignId, result, detail={}) {
    if(!this.db.isTransaction)return this.tx(()=>this.audit(actor,brand,action,campaignId,result,detail));
    const at=new Date().toISOString(), previous=this.db.prepare('SELECT sha FROM audit ORDER BY seq DESC LIMIT 1').get()?.sha ?? null;
    const record={at,actor,brand,action,campaignId,result,detail,previous};
    this.db.prepare('INSERT INTO audit(at,actor,brand,action,campaign_id,result,detail,previous_sha,sha) VALUES(?,?,?,?,?,?,?,?,?)').run(at,actor,brand,action,campaignId,result,canonical(detail),previous,sha(record));
  }
  seal(value, id) { const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',this.key,iv); cipher.setAAD(Buffer.from(id)); const bytes=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]); return JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),value:bytes.toString('base64')}); }
  open(value, id) { const b=JSON.parse(value), d=createDecipheriv('aes-256-gcm',this.key,Buffer.from(b.iv,'base64')); d.setAAD(Buffer.from(id));d.setAuthTag(Buffer.from(b.tag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(b.value,'base64')),d.final()]).toString()); }
  user(id) {const row=this.db.prepare('SELECT * FROM analysts WHERE id=?').get(id);return row ? {...JSON.parse(row.config),id:row.id,login:row.login,brand:row.brand,active:row.active===1} : null;}
  loginUser(login) {const row=this.db.prepare('SELECT id,password_hash FROM analysts WHERE login=?').get(login);return row ? {user:this.user(row.id),hash:row.password_hash} : null;}
  credentials(id) {const row=this.db.prepare('SELECT credential FROM analysts WHERE id=? AND active=1').get(id);if(!row)deny('ANALYST_REVOKED','Acesso individual desativado.');return this.open(row.credential,id);}
  addUser({id=randomUUID(),login,brand,passwordHash,credential,...config}) {
    if(this.db.prepare('SELECT id FROM analysts WHERE login=?').get(login)) deny('ANALYST_ALREADY_EXISTS','Identidade já cadastrada; não substituir credenciais por tentativa.');
    if(this.db.prepare("SELECT id FROM analysts WHERE json_extract(config,'$.apiUserId')=?").get(config.apiUserId)) deny('API_IDENTITY_ALREADY_BOUND','Esse usuário API já pertence a outra identidade.');
    this.tx(()=>{this.db.prepare('INSERT INTO analysts VALUES(?,?,?,?,?,?,?)').run(id,login,1,brand,canonical(config),passwordHash,this.seal(credential,id));this.audit('administrator',brand,'analyst_create',null,'succeeded',{analystId:id,apiUserId:config.apiUserId});});return this.user(id);
  }
  revoke(id) {this.tx(()=>{const user=this.user(id);if(!user)deny('ANALYST_NOT_FOUND','Analista não encontrado.');this.db.prepare('UPDATE analysts SET active=0 WHERE id=?').run(id);this.db.prepare('DELETE FROM oauth WHERE account_id=? OR grant_id IN(SELECT id FROM oauth WHERE model=\'Grant\' AND account_id=?)').run(id,id);this.audit('administrator',user.brand,'analyst_revoke',null,'succeeded',{analystId:id});});}
  owned(id, brand) {if(PROTECTED_IDS.includes(id))deny('CAMPAIGN_PROTECTED','Campanha protegida; nenhuma ação permitida.');const c=this.db.prepare('SELECT * FROM campaigns WHERE id=? AND brand=?').get(id,brand);if(!c)deny('PREEXISTING_CAMPAIGN_IMMUTABLE','Somente campanhas novas criadas por este conector podem ser operadas.');return {...c,snapshot:JSON.parse(c.snapshot)};}
  operation(id, actor, brand=null) {const o=this.db.prepare('SELECT * FROM operations WHERE id=?').get(id);if(!o)return null;const u=this.user(actor);if(!u?.active || o.actor!==actor || o.brand!==u.brand || (brand!==null&&o.brand!==brand))deny('OPERATION_FORBIDDEN','Operação fora do seu acesso.');return {...o,before:o.before_json?JSON.parse(o.before_json):null,after:o.after_json?JSON.parse(o.after_json):null,diff:o.diff_json?JSON.parse(o.diff_json):[]};}
  claim({id,actor,brand,action,campaignId=null,request,prepared=null,before=null,revision=null,test=false,expectedLocalSnapshot=null}) {
    return this.tx(()=>{
      const existing=this.db.prepare('SELECT * FROM operations WHERE id=?').get(id);
      if(existing) {if(existing.actor!==actor||existing.request_hash!==sha(request)||existing.action!==action)deny('OPERATION_ID_CONFLICT','ID operacional já usado para outra ação.');return {existing:true};}
      if(!this.user(actor)?.active)deny('ANALYST_REVOKED','Acesso individual desativado.');
      if(campaignId!==null){const c=this.owned(campaignId,brand);if(c.revision!==revision||c.fingerprint!==contentFingerprint(before)||canonical(c.snapshot)!==expectedLocalSnapshot)deny('REVISION_CHANGED','A campanha mudou durante a preparação. Releia antes de agir.');}
      const resource=campaignId===null?'create:'+brand+':'+actor:'campaign:'+campaignId;
      if(this.db.prepare('SELECT operation_id FROM locks WHERE resource=?').get(resource))deny('OPERATION_UNCERTAIN_OR_BUSY','Há uma operação em andamento ou incerta. Consulte seu ID; não repita.');
      if(test&&this.db.prepare('SELECT operation_id FROM test_claims WHERE campaign_id=? AND revision=?').get(campaignId,revision))deny('REVISION_ALREADY_TESTED','Esta revisão já consumiu seu único teste.');
      const at=new Date().toISOString();
      this.db.prepare('INSERT INTO operations(id,actor,brand,action,campaign_id,request_hash,request_json,state,before_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,actor,brand,action,campaignId,sha(request),canonical({input:request,prepared}),'started',before===null?null:canonical(before),at,at);
      this.db.prepare('INSERT INTO locks VALUES(?,?)').run(resource,id);
      if(test)this.db.prepare('INSERT INTO test_claims VALUES(?,?,?)').run(campaignId,revision,id);
      this.audit(actor,brand,action,campaignId,'started',{operationId:id,before,revision});return {existing:false};
    });
  }
  phase(id, phase, method, route, body) {this.tx(()=>{const op=this.db.prepare('SELECT state,actor FROM operations WHERE id=?').get(id);if(op?.state!=='started'||!this.user(op.actor)?.active)deny('OPERATION_NOT_ACTIVE','Operação encerrada ou identidade revogada.');this.db.prepare('INSERT INTO phases(operation_id,phase,method,route,body_sha,at) VALUES(?,?,?,?,?,?)').run(id,phase,method,route,sha(body),new Date().toISOString());});}
  acknowledge(id,campaign){this.db.prepare("UPDATE operations SET ack_json=? WHERE id=? AND state='started' AND ack_json IS NULL").run(canonical({id:campaign.id,uuid:campaign.uuid}),id);}
  complete(id, after, {campaign=null, user=null,templateSha=null}={}) {
    return this.tx(()=>{
      const op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(id);if(!op||op.state!=='started')throw Error('OPERATION_STATE_MISMATCH');
      let revision=null;
      if(campaign) {
        if(PROTECTED_IDS.includes(campaign.id))throw Error('UPSTREAM_RETURNED_PROTECTED_ID');
        const old=this.db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaign.id);
        revision=old&&old.fingerprint===contentFingerprint(after)?old.revision:newRevision();
        if(old&&old.uuid!==campaign.uuid)throw Error('CAMPAIGN_UUID_CHANGED');
        if(!old&&op.action!=='listmonk_draft_create')throw Error('CAMPAIGN_NOT_CREATED_HERE');
        this.db.prepare('INSERT INTO campaigns VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,snapshot=excluded.snapshot,fingerprint=excluded.fingerprint,template_sha=excluded.template_sha').run(campaign.id,campaign.uuid,op.brand,user.id,revision,canonical(after),contentFingerprint(after),templateSha??old?.template_sha);
      }
      const before=op.before_json?JSON.parse(op.before_json):null, changes=diff(before||{},after||{});
      this.db.prepare("UPDATE operations SET state='succeeded',campaign_id=coalesce(campaign_id,?),after_json=?,diff_json=?,updated_at=? WHERE id=?").run(campaign?.id??null,canonical(after),canonical(changes),new Date().toISOString(),id);
      this.db.prepare('DELETE FROM locks WHERE operation_id=?').run(id);
      this.audit(op.actor,op.brand,op.action,op.campaign_id??campaign?.id??null,'succeeded',{operationId:id,before,after,diff:changes,revision});
      return {operation_id:id,state:'succeeded',campaign_id:campaign?.id??op.campaign_id,revision,before,after,diff:changes};
    });
  }
  uncertain(id, code='UPSTREAM_OUTCOME_UNKNOWN') {this.tx(()=>{const op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(id);if(!op)return;this.db.prepare("UPDATE operations SET state='uncertain',code=?,updated_at=? WHERE id=?").run(code,new Date().toISOString(),id);this.audit(op.actor,op.brand,op.action,op.campaign_id,'uncertain',{operationId:id,code,automaticRetry:false});});}
  refusal(user,brand,action,campaignId,error) {this.tx(()=>this.audit(user?.id??'unauthenticated',brand??null,action,campaignId??null,'refused',{code:error.code??'INPUT_REFUSED'}));}
}
