'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createCampaignCreator}=require('../services/dashboard-operational/crm-campaign-create.cjs');
const {createService}=require('../n8n/growth/campaign-service.js');
const C=require('../n8n/growth/campaign-contract.js'),T=require('../n8n/growth/campaign-tracking.js');
const CAPS=['read_content','draft','validate','submit'];
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const md5=v=>crypto.createHash('md5').update(String(v)).digest('hex');
const definition=(brand='fish')=>({schema_version:C.VERSION,brand,channel:'email',initiative:{key:'private-create-fixture',name:'Private CREATE fixture'},utm_campaign:brand+'-create-fixture',name:'Synthetic new draft',subject:'Synthetic create',from_email:'contato@'+C.BRANDS[brand],reply_to:'contato@'+C.BRANDS[brand],list_ids:[brand==='fish'?125:126],template_id:1,html:'<a href="https://'+C.STORES[brand]+'/products/fixture">Synthetic HTML canary</a>{{ UnsubscribeURL }}',text:'https://'+C.STORES[brand]+'/products/fixture {{ UnsubscribeURL }}',tags:[],send_at:null});
function createOrigin(now){
 const operations=new Map(),rows=new Map(),effects={create:0,save:0,validate:0,schedule:0,cancel:0},validations=new Map();let next=1001,sequence=0,failUpdate=false;
 const catalog=brand=>({brand,current:true,lists:[{id:brand==='fish'?125:126,brand,available:true}],templates:[{id:1,type:'campaign',available:true}],initiatives:[]});
 const store={
  async claim(p){const k=p.actor+':'+p.key;if(operations.has(k))return{...operations.get(k),acquired:false};const o={...p,id:crypto.randomUUID(),lease:crypto.randomUUID(),state:'pending',providerId:null,response:null,created_at:new Date(now()).toISOString(),updated_at:new Date(now()).toISOString()};operations.set(k,o);return{...o,acquired:true};},
  async getOperation(actor,key){const o=operations.get(actor+':'+key);return o?structuredClone({id:o.id,operation_key:o.key,brand:o.brand,action:o.action,state:o.state,providerId:o.providerId,response:o.response,created_at:o.created_at,updated_at:o.updated_at}):null;},
  async finish(id,lease,result){const o=[...operations.values()].find(x=>x.id===id);assert.equal(o.lease,lease);assert.equal(o.state,'pending');Object.assign(o,structuredClone(result),{updated_at:new Date(now()).toISOString()});},
  async setProviderId(id,lease,providerId){const o=[...operations.values()].find(x=>x.id===id);assert.equal(o.lease,lease);o.providerId=providerId;},
  async invalidateValidation(id){validations.delete(id);},async getValidation(id){return structuredClone(validations.get(id)||null);}
 };
 const provider={
  async catalog(brand){return catalog(brand);},async list(brand){return [...rows.values()].filter(x=>x.definition.brand===brand).map(x=>structuredClone(x));},async get(id){return structuredClone(rows.get(id)||null);},
  async createDraft(d){effects.create++;const id=next++;const r={id,version:md5(++sequence),status:'draft',sent:0,started_at:null,send_at:null,definition:structuredClone(d)};rows.set(id,r);return structuredClone(r);},
  async updateDraft(id,p,{expectedVersion}){assert.ok(rows.has(id));assert.equal(expectedVersion,rows.get(id).version);assert.equal(rows.get(id).sent,0);if(failUpdate)throw Error('PRIVATE_SOURCE_FAILURE');effects.save++;const r={...rows.get(id),version:md5(++sequence),definition:structuredClone(p.definition),send_at:p.definition.send_at};rows.set(id,r);return structuredClone(r);},
  async recovery(){return null;},
  async reviewAudience(id,{expectedVersion}){const row=rows.get(id);assert.equal(expectedVersion,row.version);effects.validate++;const audience={policy:'listmonk-6.1-regular-v1',brand:row.definition.brand,list_ids:[...row.definition.list_ids],eligible_count:2,unique_members_count:3,excluded_blocklisted_count:1,excluded_subscription_count:0,native_disabled_count:0,review_id:crypto.randomUUID(),campaign_id:id,campaign_version:row.version,frozen:false,checked_at:new Date(now()).toISOString(),expires_at:new Date(now()+300000).toISOString()};const v={policy:C.VERSION,version:row.version,ok:true,validated_at:new Date(now()).toISOString(),audience};validations.set(id,v);return{campaign:structuredClone(row),validation:structuredClone(v)};},
  async schedule(id,{expectedVersion,audienceReviewId}){const row=rows.get(id),v=validations.get(id);assert.equal(expectedVersion,row.version);assert.equal(audienceReviewId,v.audience.review_id);C.audienceReview(v.audience,row,{now:now()});effects.schedule++;const r={...row,version:md5(++sequence),status:'scheduled'};rows.set(id,r);return{...structuredClone(r),audience:{...structuredClone(v.audience),rechecked_at:new Date(now()).toISOString()}};},
  async cancel(id,{expectedVersion}){const r=rows.get(id);assert.equal(expectedVersion,r.version);effects.cancel++;rows.set(id,{...r,version:md5(++sequence),status:'cancelled'});return structuredClone(rows.get(id));}
 };
 return{service:createService({store,provider,now}),rows,operations,effects,catalog,definition:definition(),failUpdate:v=>{failUpdate=v;}};
}
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crm-create-private-'));const filename=path.join(dir,'identity.sqlite'),key=crypto.randomBytes(32);let clock=Date.now(),db=new DatabaseSync(filename),creator,behavior=null;
 const ctx={userId:crypto.randomUUID(),mac:'a'.repeat(64),caps:[...CAPS],active:true};const calls=[],origin=createOrigin(()=>clock);
 const encrypt=v=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),out=Buffer.concat([c.update(v,'utf8'),c.final()]);return['v1',iv.toString('base64url'),out.toString('base64url'),c.getAuthTag().toString('base64url')].join('.');};
 const decrypt=v=>{const[,iv,data,tag]=v.split('.'),d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));d.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([d.update(Buffer.from(data,'base64url')),d.final()]).toString('utf8');};
 const authorize=c=>{if(!c.active)throw Error('PRIVATE_AUTH_CANARY');return{userId:c.userId,credentialMac:c.mac,role:'manager',slot:'growth-campaign',canEdit:true,caps:c.caps};};
 const options=()=>({db,enabled:true,profile:'crm-sandbox',allowedEmailDomains:['synthetic.invalid'],authorize,now:()=>clock,encrypt,decrypt,hasOpenDelivery:()=>false,
  preflightDefinition:(d,{catalog,now})=>C.preflight(d,{catalog,tracking:T,now}),prepareDefinition:(d,{catalog,id,now})=>{const p=C.prepare(d,{catalog,tracking:T,trackingId:id,now});return{definition:p.definition,tracking:p.tracking};},
  transport:async(c,{method,command})=>{assert.equal(db.isTransaction,false);const q=structuredClone(command);calls.push({method,q,actor:c.userId});const row=db.prepare('SELECT * FROM crm_campaign_create_v1 WHERE remote_key=?').get(q.idempotency_key??null);
   if(method==='POST'){assert.ok(row);assert.equal(row.phase,'uncertain');assert.equal(row.campaign_id,null);assert.equal(row.created_version,null);assert.notEqual(row.client_key,row.remote_key);assert.ok(row.catalog_sha256);assert.ok(row.normalized_sha256);assert.equal(Object.hasOwn(q,'id'),false);assert.equal(Object.hasOwn(q,'expected_version'),false);assert.equal(q.definition.send_at,null);}
   const dispatch=()=>origin.service.handle({actor:'panel:'+c.userId,caps:c.caps},q);return behavior?behavior({c,method,q,dispatch}):dispatch();}
 });
 const build=overrides=>createCampaignCreator({...options(),...overrides});creator=build();
 t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 return{ctx,calls,origin,filename,build,options,command:(key='create_attempt_key_0001',brand='fish')=>({acao:'campanha_criar',brand,definition:definition(brand),idempotency_key:key}),selector:key=>({brand:'fish',idempotency_key:key||'create_attempt_key_0001'}),get creator(){return creator;},get db(){return db;},behavior:fn=>{behavior=fn;},advance:ms=>{clock+=ms;},row:()=>db.prepare('SELECT * FROM crm_campaign_create_v1').get(),restart:()=>{db.close();db=new DatabaseSync(filename);creator=build();},canonical};
}
module.exports={fixture,createOrigin,definition,C,T,CAPS,canonical};
