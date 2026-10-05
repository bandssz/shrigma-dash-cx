'use strict';
// Dormant CREATE journal. Private adapters only; no startup, URLs or credentials.
// The separate production writer issuer/profile remains outside this proposal.
const crypto = require('node:crypto');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY=/^[A-Za-z0-9_-]{16,100}$/;
const MAC=/^[0-9a-f]{64}$/;
const CAPS=new Set(['read_content','draft','validate','submit']);
const STATES=new Set(['draft','scheduled','running','paused','finished','cancelled']);
const messages=Object.freeze({
 CAMPAIGN_CREATE_CONFIG:[500,'Cadastro de campanha indisponível.'],
 CAMPAIGN_CREATE_INPUT:[400,'Solicitação de cadastro inválida.'],
 CAMPAIGN_CREATE_DENIED:[403,'Este acesso não permite cadastrar campanhas.'],
 CAMPAIGN_CREATE_CONFLICT:[409,'Esta tentativa já está vinculada a outro conteúdo ou acesso.'],
 CAMPAIGN_CREATE_PENDING:[409,'Consulte a tentativa anterior antes de cadastrar outra.'],
 CAMPAIGN_CREATE_UNKNOWN:[404,'Tentativa não encontrada neste acesso.'],
 CAMPAIGN_CREATE_TRANSACTION:[409,'Conclua a transação local antes de consultar a origem.']
});
class CampaignCreateError extends Error{constructor(code){const[status,message]=messages[code];super(message);this.name='CampaignCreateError';this.code=code;this.status=status;}}
const fail=code=>{throw new CampaignCreateError(code);};
const closed=e=>{if(e instanceof CampaignCreateError)throw e;fail('CAMPAIGN_CREATE_CONFIG');};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return d?.enumerable===true&&Object.hasOwn(d,'value');});
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':plain(v)?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const sha=v=>crypto.createHash('sha256').update(canonical(v)).digest('hex');
const positive=v=>Number.isSafeInteger(v)&&v>0;
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isSafeInteger(Date.parse(v));
const dto=(state,campaign=null)=>Object.freeze({state,campaign});
const pending=()=>dto('pending');
const synchronous=(v,code)=>{if(v&&typeof v.then==='function'){Promise.resolve(v).catch(()=>{});fail(code);}return v;};
function selector(q){if(!exact(q,['brand','idempotency_key'])||!['fish','aristo'].includes(q.brand)||typeof q.idempotency_key!=='string'||!KEY.test(q.idempotency_key))fail('CAMPAIGN_CREATE_INPUT');return q;}
function command(q){
 if(!exact(q,['acao','brand','definition','idempotency_key'])||q.acao!=='campanha_criar')fail('CAMPAIGN_CREATE_INPUT');
 selector({brand:q.brand,idempotency_key:q.idempotency_key});
 if(!plain(q.definition)||q.definition.brand!==q.brand||q.definition.send_at!==null||Buffer.byteLength(JSON.stringify(q))>256*1024)fail('CAMPAIGN_CREATE_INPUT');
 return JSON.parse(JSON.stringify(q));
}
const envelope=r=>exact(r,['status','body'])&&Number.isSafeInteger(r.status)&&r.status>=100&&r.status<=599&&plain(r.body)&&Buffer.byteLength(JSON.stringify(r.body))<=4*1024*1024;
function campaign(c,brand,id){
 if(!exact(c,['id','version','status','sent','started_at','send_at','definition'])||c.id!==id||!positive(c.id)||!/^[a-fA-F0-9]{32}$/.test(c.version||'')||!STATES.has(c.status)||!Number.isSafeInteger(c.sent)||c.sent<0||c.started_at!==null&&!date(c.started_at)||c.send_at!==null&&!date(c.send_at)||!plain(c.definition)||c.definition.brand!==brand)return null;
 return Object.freeze({id:c.id,version:c.version,status:c.status,sent:c.sent,startedAt:c.started_at,sendAt:c.send_at});
}
function createCampaignCreator({db,enabled=false,profile,allowedEmailDomains,corporateWriter,authorize,transport,now=Date.now,encrypt,decrypt,preflightDefinition,prepareDefinition,hasOpenDelivery}){
 const sandbox=profile==='crm-sandbox'&&allowedEmailDomains?.length===1&&allowedEmailDomains[0]==='synthetic.invalid';
 const corporate=(profile==='corporate-read-writer-v1'&&require('./crm-manager-runtime.cjs').isCorporateWriterDescriptor(corporateWriter)||profile==='own-master-production-v1'&&require('./crm-manager-runtime.cjs').isOwnMasterWriterDescriptor(corporateWriter))&&Array.isArray(allowedEmailDomains)&&allowedEmailDomains.length===3&&Object.keys(allowedEmailDomains).length===3&&new Set(allowedEmailDomains).size===3&&['oaristocrata.com','shrigma.com.br','fishermans.com.br'].every(d=>allowedEmailDomains.includes(d));
 if(enabled!==true||!Array.isArray(allowedEmailDomains)||!sandbox&&!corporate)fail('CAMPAIGN_CREATE_DENIED');
 if(!db||typeof db.isTransaction!=='boolean'||![authorize,transport,now,encrypt,decrypt,preflightDefinition,prepareDefinition,hasOpenDelivery].every(f=>typeof f==='function'))fail('CAMPAIGN_CREATE_CONFIG');
 const outside=()=>{if(db.isTransaction)fail('CAMPAIGN_CREATE_TRANSACTION');};
 outside();
 try{db.exec(`CREATE TABLE IF NOT EXISTS crm_campaign_create_v1 (
 user_id TEXT NOT NULL,client_key TEXT NOT NULL,remote_key TEXT NOT NULL UNIQUE,
 brand TEXT NOT NULL CHECK(brand IN ('fish','aristo')),payload_sha256 TEXT NOT NULL,credential_mac TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('queued','uncertain','confirmed','succeeded','rejected')),
 input_ciphertext TEXT NOT NULL,normalized_ciphertext TEXT,normalized_sha256 TEXT,catalog_ciphertext TEXT,catalog_sha256 TEXT,prepared_at INTEGER,
 campaign_id INTEGER,created_version TEXT,remote_operation_id TEXT,receipt_sha256 TEXT,receipt_state TEXT,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,client_key),
 CHECK(campaign_id IS NULL OR campaign_id>0),CHECK((campaign_id IS NULL)=(created_version IS NULL)));
 CREATE UNIQUE INDEX IF NOT EXISTS crm_campaign_create_open_v1 ON crm_campaign_create_v1(user_id,brand) WHERE phase IN ('queued','uncertain','confirmed');`);}catch(e){closed(e);}
 const clock=()=>{const t=now();if(!Number.isSafeInteger(t)||t<0)fail('CAMPAIGN_CREATE_CONFIG');return t;};
 const atomic=f=>{outside();db.exec('BEGIN IMMEDIATE');try{const r=f();db.exec('COMMIT');return r;}catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}};
 const identity=(ctx,q)=>{try{
  const a=synchronous(authorize(ctx,Object.freeze({brand:q.brand,action:q.action||'criar'})),'CAMPAIGN_CREATE_DENIED');
  if(profile==='own-master-production-v1'&&a?.role!=='superadmin')fail('CAMPAIGN_CREATE_DENIED');
  if(!exact(a,['userId','role','slot','canEdit','credentialMac','caps'])||!UUID.test(a.userId||'')||!['manager','superadmin'].includes(a.role)||a.slot!=='growth-campaign'||a.canEdit!==true||!MAC.test(a.credentialMac||'')||!Array.isArray(a.caps)||a.caps.length!==4||new Set(a.caps).size!==4||!a.caps.every(c=>CAPS.has(c)))fail('CAMPAIGN_CREATE_DENIED');return a;
 }catch{fail('CAMPAIGN_CREATE_DENIED');}};
 const get=(u,k)=>db.prepare('SELECT * FROM crm_campaign_create_v1 WHERE user_id=? AND client_key=?').get(u,k);
 const same=(ctx,row)=>{const a=identity(ctx,row);if(a.userId!==row.user_id||a.credentialMac!==row.credential_mac)fail('CAMPAIGN_CREATE_DENIED');};
 const cipher=v=>{const c=synchronous(encrypt(JSON.stringify(v)),'CAMPAIGN_CREATE_CONFIG');if(typeof c!=='string'||!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(c))fail('CAMPAIGN_CREATE_CONFIG');return c;};
 const open=c=>{try{return JSON.parse(synchronous(decrypt(c),'CAMPAIGN_CREATE_CONFIG'));}catch{fail('CAMPAIGN_CREATE_CONFIG');}};
 const input=row=>{const q=open(row.input_ciphertext);command(q);if(sha(q)!==row.payload_sha256||q.brand!==row.brand||q.idempotency_key!==row.client_key)fail('CAMPAIGN_CREATE_CONFIG');return q;};
 const snapshot=row=>{const definition=open(row.normalized_ciphertext),catalog=open(row.catalog_ciphertext);if(!plain(definition)||definition.brand!==row.brand||definition.send_at!==null||sha(definition)!==row.normalized_sha256||sha(catalog)!==row.catalog_sha256)fail('CAMPAIGN_CREATE_CONFIG');return{definition,catalog};};
 async function call(ctx,row,method,q){same(ctx,row);outside();let r;try{r=await transport(ctx,Object.freeze({method,command:q}));}catch{outside();same(ctx,row);return null;}outside();same(ctx,row);try{return envelope(r)?r:null;}catch{return null;}}
 function receipt(o,row){
  if(!exact(o,['id','operation_key','brand','action','state','providerId','response','created_at','updated_at'])||!UUID.test(o.id||'')||o.operation_key!==row.remote_key||o.brand!==row.brand||o.action!=='salvar'||!['pending','succeeded','rejected','outcome_unknown'].includes(o.state)||o.providerId!==null&&!positive(o.providerId)||!date(o.created_at)||!date(o.updated_at)||Date.parse(o.created_at)<row.created_at-30000||Date.parse(o.updated_at)<Date.parse(o.created_at)||Date.parse(o.updated_at)>clock()+30000||row.remote_operation_id&&row.remote_operation_id!==o.id||row.campaign_id!==null&&o.providerId!==row.campaign_id)return null;
  if(o.state==='pending')return o.response===null?{state:'pending',id:o.id,hash:null,campaign:null}:null;
  if(!envelope(o.response))return null;
  const b=o.response.body;let c=null;
  if(o.state==='succeeded'){
   if(o.response.status!==201||!positive(o.providerId)||!exact(b,['campaign','tracking','operation_id'])||b.operation_id!==o.id)return null;
   c=campaign(b.campaign,row.brand,o.providerId);if(!c||c.status!=='draft'||c.sent!==0||c.startedAt!==null||c.sendAt!==null||b.campaign.definition.send_at!==null)return null;
   const s=snapshot(row);let prepared;
   try{prepared=synchronous(prepareDefinition(s.definition,{catalog:s.catalog,id:o.providerId,now:row.prepared_at}),'CAMPAIGN_CREATE_CONFIG');}catch{return null;}
   if(!plain(prepared)||!plain(prepared.definition)||!exact(prepared.tracking,['policy','term','list_ids','changed_links'])||sha(prepared.definition)!==sha(b.campaign.definition)||sha(prepared.tracking)!==sha(b.tracking))return null;
  }else if(!exact(b,['error','message','provider_id','operation_id'])||typeof b.error!=='string'||!/^[A-Z][A-Z0-9_]{0,63}$/.test(b.error)||typeof b.message!=='string'||b.message.length>2000||b.operation_id!==o.id||b.provider_id!==o.providerId||o.state==='rejected'&&!(o.response.status>=400&&o.response.status<=599&&b.error!=='OUTCOME_UNKNOWN')||o.state==='outcome_unknown'&&(o.response.status!==502||b.error!=='OUTCOME_UNKNOWN'))return null;
  const h=sha(o);if(row.receipt_sha256&&(row.receipt_sha256!==h||row.receipt_state!==o.state))return null;
  return{state:o.state,id:o.id,hash:h,campaign:c};
 }
 async function reconcileRow(ctx,row){
  same(ctx,row);if(row.phase==='rejected'&&row.remote_operation_id===null)return dto('rejected');
  // STATUS is always a GET, including an intent persisted before a crash.
  // Absence/404 cannot distinguish an unsent POST from a lost remote receipt.
  const r=await call(ctx,row,'GET',Object.freeze({acao:'campanha_operacao',brand:row.brand,idempotency_key:row.remote_key}));
  if(r?.status!==200||!plain(r.body)||!Object.hasOwn(r.body,'operation')||Object.keys(r.body).some(k=>!['operation','recovery'].includes(k)))return pending();
  const p=receipt(r.body.operation,row);if(!p)return pending();
  atomic(()=>{same(ctx,row);const latest=get(row.user_id,row.client_key);
   if(latest.remote_operation_id&&latest.remote_operation_id!==p.id||latest.receipt_sha256&&(latest.receipt_sha256!==p.hash||latest.receipt_state!==p.state)||latest.campaign_id!==null&&p.campaign&&latest.campaign_id!==p.campaign.id)fail('CAMPAIGN_CREATE_CONFLICT');
   db.prepare(`UPDATE crm_campaign_create_v1 SET remote_operation_id=?,receipt_sha256=coalesce(receipt_sha256,?),receipt_state=coalesce(receipt_state,?),campaign_id=coalesce(campaign_id,?),created_version=coalesce(created_version,?),phase=CASE WHEN ?='succeeded' THEN CASE WHEN phase='succeeded' THEN phase ELSE 'confirmed' END WHEN ?='rejected' THEN 'rejected' ELSE phase END,updated_at=? WHERE user_id=? AND client_key=?`)
    .run(p.id,p.hash,p.hash?p.state:null,p.campaign?.id??null,p.campaign?.version??null,p.state,p.state,clock(),row.user_id,row.client_key);
  });
  if(p.state==='rejected')return dto('rejected');if(p.state!=='succeeded')return pending();
  row=get(row.user_id,row.client_key);
  const fresh=await call(ctx,row,'GET',Object.freeze({acao:'campanha_obter',brand:row.brand,id:row.campaign_id}));
  const c=fresh?.status===200&&exact(fresh.body,['campaign'])?campaign(fresh.body.campaign,row.brand,row.campaign_id):null;if(!c)return pending();
  atomic(()=>{same(ctx,row);db.prepare("UPDATE crm_campaign_create_v1 SET phase='succeeded',updated_at=? WHERE user_id=? AND client_key=? AND phase IN ('confirmed','succeeded')").run(clock(),row.user_id,row.client_key);});return dto('succeeded',c);
 }
 async function dispatch(ctx,row){
  if(row.phase!=='queued')return reconcileRow(ctx,row);
  const catalog=await call(ctx,row,'GET',Object.freeze({acao:'campanha_catalogo',brand:row.brand}));if(catalog?.status!==200)return pending();
  const t=clock();let d;
  try{d=synchronous(preflightDefinition(input(row).definition,{catalog:catalog.body,now:t}),'CAMPAIGN_CREATE_CONFIG');if(!plain(d)||d.brand!==row.brand||d.send_at!==null)d=null;}catch{d=null;}
  if(!d){const changed=atomic(()=>{same(ctx,row);return db.prepare("UPDATE crm_campaign_create_v1 SET phase='rejected',updated_at=? WHERE user_id=? AND client_key=? AND phase='queued'").run(t,row.user_id,row.client_key).changes===1;});return changed?dto('rejected'):reconcileRow(ctx,get(row.user_id,row.client_key));}
  const normalizedCipher=cipher(d),catalogCipher=cipher(catalog.body);
  const claimed=atomic(()=>{same(ctx,row);return db.prepare("UPDATE crm_campaign_create_v1 SET phase='uncertain',normalized_ciphertext=?,normalized_sha256=?,catalog_ciphertext=?,catalog_sha256=?,prepared_at=?,updated_at=? WHERE user_id=? AND client_key=? AND phase='queued'").run(normalizedCipher,sha(d),catalogCipher,sha(catalog.body),t,t,row.user_id,row.client_key).changes===1;});
  row=get(row.user_id,row.client_key);if(!claimed)return reconcileRow(ctx,row);
  // Uncertain plus catalogue/input snapshot are committed before the only POST.
  const sent=await call(ctx,row,'POST',Object.freeze({acao:'campanha_salvar',brand:row.brand,definition:d,idempotency_key:row.remote_key}));return sent?reconcileRow(ctx,row):pending();
 }
 const active=new Map();
 function coalesce(ctx,row,run){const k=row.user_id+':'+row.client_key;if(active.has(k))return active.get(k);const p=run(ctx,row).finally(()=>active.delete(k));active.set(k,p);return p;}
 const select=(ctx,q)=>{outside();selector(q);const a=identity(ctx,{brand:q.brand,action:'operacao_criar'}),row=get(a.userId,q.idempotency_key);if(!row||row.brand!==q.brand)fail('CAMPAIGN_CREATE_UNKNOWN');same(ctx,row);return row;};
 async function submit(ctx,q){
  outside();q=command(q);const a=identity(ctx,q),h=sha(q),t=clock(),encrypted=cipher(q);
  const row=atomic(()=>{const prior=get(a.userId,q.idempotency_key);if(prior){if(prior.payload_sha256!==h||prior.credential_mac!==a.credentialMac)fail('CAMPAIGN_CREATE_CONFLICT');return prior;}
   const other=synchronous(hasOpenDelivery(a.userId,q.brand),'CAMPAIGN_CREATE_CONFIG');if(typeof other!=='boolean')fail('CAMPAIGN_CREATE_CONFIG');
   if(other||db.prepare("SELECT 1 FROM crm_campaign_create_v1 WHERE user_id=? AND brand=? AND phase IN ('queued','uncertain','confirmed')").get(a.userId,q.brand))fail('CAMPAIGN_CREATE_PENDING');
   db.prepare("INSERT INTO crm_campaign_create_v1(user_id,client_key,remote_key,brand,payload_sha256,credential_mac,phase,input_ciphertext,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?)").run(a.userId,q.idempotency_key,'bff-'+crypto.randomBytes(32).toString('hex'),q.brand,h,a.credentialMac,encrypted,t,t);return get(a.userId,q.idempotency_key);
  });return coalesce(ctx,row,dispatch);
 }
 return Object.freeze({submit:async(ctx,q)=>{try{return await submit(ctx,q);}catch(e){closed(e);}},reconcile:async(ctx,q)=>{try{return await coalesce(ctx,select(ctx,q),reconcileRow);}catch(e){closed(e);}},describe:(ctx,q)=>{try{select(ctx,q);return Object.freeze({action:'campanha_criar'});}catch(e){closed(e);}}});
}
module.exports={createCampaignCreator,CampaignCreateError};
