'use strict';
// Pure adapter for a future same-origin UI guard. Not yet copied to public or
// loaded by Growth. Private callbacks supply session, fetch and scoped storage;
// this file never reads credentials, localStorage, globals or network itself.
const KEY=/^[A-Za-z0-9_-]{16,100}$/;
const VERSION=/^[a-f0-9]{32}$/i;
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isSafeInteger(Date.parse(v));
const ACTIONS=Object.freeze({create:'campanha_criar',save:'campanha_salvar',validate:'campanha_validar',schedule:'campanha_agendar',cancel:'campanha_cancelar'});
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':plain(v)?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const clone=v=>JSON.parse(JSON.stringify(v));
const closed=(code)=>{const e=new Error(code==='CAMPAIGN_BFF_PENDING'?'Consulte a tentativa anterior antes de criar outra.':code==='CAMPAIGN_BFF_UNCERTAIN'?'Resultado incerto. Consulte a mesma tentativa.':'Ação de campanha indisponível.');e.name='CampaignBffClientError';e.code=code;throw e;};
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
function createCampaignBffClient({request,readJournal,writeJournal,getSession}){
 if(![request,readJournal,writeJournal,getSession].every(f=>typeof f==='function'))closed('CAMPAIGN_BFF_CONFIG');
 const active=new Map();
 const sync=fn=>{try{const v=fn();if(v&&typeof v.then==='function'){Promise.resolve(v).catch(()=>{});closed('CAMPAIGN_BFF_STORAGE');}return v;}catch{closed('CAMPAIGN_BFF_STORAGE');}};
 function session(method='POST'){
  const s=sync(getSession);
  const u=s?.user,master=u?.role==='superadmin'&&u.brandAccess==='all'&&u.brand===null&&Array.isArray(u.brands)&&u.brands.length===2&&new Set(u.brands).size===2&&['fish','aristo'].every(b=>u.brands.includes(b))&&Array.isArray(u.areas)&&u.areas.length===3&&new Set(u.areas).size===3&&['growth','organico','influs'].every(a=>u.areas.includes(a));
  const manager=u?.role==='manager'&&u.areas?.length===1&&u.areas[0]==='growth';
  if(s?.authenticated!==true||s.features?.campaignSubmitWrite!==true&&!(method==='GET'&&s.features?.campaignHistoryRead===true)||!master&&!manager||u.permissions?.growth?.read!==true||u.permissions.growth.edit!==true||typeof s.csrf!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(s.csrf)||typeof s.uiKey!=='string'||!/^ui-[a-f0-9]{32}$/.test(s.uiKey))closed('CAMPAIGN_BFF_DENIED');
  return Object.freeze({uiKey:s.uiKey,csrf:s.csrf,...(master?{master:true}:{})});
 }
 const scope=(s,brand)=>Object.freeze({uiKey:s.uiKey,brand});
 const same=(s,method)=>{const current=session(method);if(current.uiKey!==s.uiKey||s.master===true&&current.master!==true)closed('CAMPAIGN_BFF_DENIED');};
 function journal(s,brand){
  if(!['fish','aristo'].includes(brand))closed('CAMPAIGN_BFF_INPUT');
  const row=sync(()=>readJournal(scope(s,brand)));if(row===null||row===undefined)return null;
  if(!exact(row,['schema','brand','action','attemptKey','command','phase',...(row.action==='campanha_criar'&&Object.hasOwn(row,'createdId')?['createdId']:[])])||row.schema!=='crm-campaign-bff-client-v1'||row.brand!==brand||!Object.values(ACTIONS).includes(row.action)||!KEY.test(row.attemptKey||'')||!plain(row.command)||row.command.acao!==row.action||row.command.brand!==brand||row.command.idempotency_key!==row.attemptKey||!['pending','uncertain','succeeded','rejected'].includes(row.phase))closed('CAMPAIGN_BFF_STORAGE');
  if(Object.hasOwn(row,'createdId')&&(!Number.isSafeInteger(row.createdId)||row.createdId<1))closed('CAMPAIGN_BFF_STORAGE');
  try{const {acao,...fields}=row.command;command(acao,fields);}catch{closed('CAMPAIGN_BFF_STORAGE');}
  return freeze(clone(row));
 }
 const persist=(s,row,phase)=>{
  const value=freeze({...clone(row),phase}),ack=sync(()=>writeJournal(scope(s,row.brand),value));
  // Browser storage normally returns void. Require exact read-back rather than
  // trusting an acknowledgment, so false/no-op/partial writes cannot precede POST.
  if(ack===false||canonical(journal(s,row.brand))!==canonical(value))closed('CAMPAIGN_BFF_STORAGE');
  return value;
 };
 function command(action,fields){
  const create=action==='campanha_criar',save=action==='campanha_salvar',schedule=action==='campanha_agendar',validate=action==='campanha_validar';
  const keys=create?['brand','definition','idempotency_key']:['brand','id','expected_version','idempotency_key',...(save?['definition']:validate?[]:['confirm']),...(schedule?['audience_review_id']:[])];
  if(!exact(fields,keys)||!['fish','aristo'].includes(fields.brand)||!create&&(!Number.isSafeInteger(fields.id)||fields.id<1||typeof fields.expected_version!=='string'||!VERSION.test(fields.expected_version))||typeof fields.idempotency_key!=='string'||!KEY.test(fields.idempotency_key)||!create&&!save&&!validate&&fields.confirm!==action.replace('campanha_','')||schedule&&!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(fields.audience_review_id||'')||(save||create)&&(!plain(fields.definition)||fields.definition.brand!==fields.brand)||create&&fields.definition.send_at!==null)closed('CAMPAIGN_BFF_INPUT');
  const q={acao:action,...clone(fields)};if(new TextEncoder().encode(JSON.stringify(q)).byteLength>256*1024)closed('CAMPAIGN_BFF_INPUT');return freeze(q);
 }
 function dto(value,row){
  const body=value?.body;
  if(!exact(value,['status','body'])||!exact(body,['schema','action','attemptKey','state','campaign','validation'])||body.schema!=='crm-campaign-bff-operation-v1'||body.action!==row.action||body.attemptKey!==row.attemptKey||!['pending','succeeded','rejected'].includes(body.state)||value.status!==({pending:202,succeeded:200,rejected:409}[body.state]))return null;
  const c=body.campaign;
  if(body.state==='succeeded'){
   if(!exact(c,['id','version','status','sent','startedAt','sendAt'])||(row.action==='campanha_criar'?(!Number.isSafeInteger(c.id)||c.id<1||Object.hasOwn(row,'createdId')&&c.id!==row.createdId):c.id!==row.command.id)||typeof c.version!=='string'||!VERSION.test(c.version)||!['draft','scheduled','running','paused','finished','cancelled'].includes(c.status)||!Number.isSafeInteger(c.sent)||c.sent<0||c.startedAt!==null&&!date(c.startedAt)||c.sendAt!==null&&!date(c.sendAt))return null;
   if(body.validation!==null){const v=body.validation,a=v?.audience,counts=['eligible_count','unique_members_count','excluded_blocklisted_count','excluded_subscription_count','native_disabled_count'];
    if(row.action!=='campanha_validar'||!exact(v,['policy','version','ok','validatedAt','audience'])||v.policy!=='crm-campaign-v1'||v.version!==row.command.expected_version||v.version!==c.version||v.ok!==true||c.status!=='draft'||c.sent!==0||c.startedAt!==null||!exact(a,['policy','brand','list_ids',...counts,'review_id','campaign_id','campaign_version','frozen','checked_at','expires_at'])||a.policy!=='listmonk-6.1-regular-v1'||a.brand!==row.brand||a.campaign_id!==c.id||a.campaign_version!==c.version||a.frozen!==false||!Array.isArray(a.list_ids)||a.list_ids.length<1||a.list_ids.length>30||!a.list_ids.every(n=>Number.isSafeInteger(n)&&n>0)||new Set(a.list_ids).size!==a.list_ids.length||counts.some(k=>!Number.isSafeInteger(a[k])||a[k]<0)||a.unique_members_count!==a.eligible_count+a.excluded_blocklisted_count+a.excluded_subscription_count||a.native_disabled_count>a.eligible_count||v.validatedAt!==a.checked_at||!date(a.checked_at)||!date(a.expires_at)||Date.parse(a.expires_at)-Date.parse(a.checked_at)!==300000||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(a.review_id||''))return null;
   }
  }else if(c!==null||body.validation!==null)return null;
  return freeze(clone(body));
 }
 async function perform(s,row,method){
  const create=row.action==='campanha_criar',endpoint=create?'/auth/campaign-create':'/auth/campaign-delivery';
  const path=method==='POST'?(create?endpoint:'/api/campaigns'):endpoint+'?brand='+encodeURIComponent(row.brand)+'&idempotency_key='+encodeURIComponent(row.attemptKey);
  const priorTerminal=method==='GET'&&['succeeded','rejected'].includes(row.phase);
  const failurePhase=priorTerminal?row.phase:'uncertain';
  let value;
  try{same(s,method);value=await request(Object.freeze({method,path,headers:Object.freeze({Accept:'application/json','X-CSRF-Token':s.csrf,...(method==='POST'?{'Content-Type':'application/json'}:{})}),...(method==='POST'?{body:row.command}:{})}));same(s,method);}catch{persist(s,row,failurePhase);closed('CAMPAIGN_BFF_UNCERTAIN');}
  const verified=dto(value,row);if(!verified||priorTerminal&&verified.state!==row.phase){persist(s,row,failurePhase);closed('CAMPAIGN_BFF_UNCERTAIN');}
  persist(s,verified.state==='succeeded'&&create?{...row,createdId:verified.campaign.id}:row,verified.state==='pending'?'uncertain':verified.state);return verified;
 }
 const coalesce=(s,row,method)=>{const id=s.uiKey+':'+row.brand;if(active.has(id))return active.get(id);const p=perform(s,row,method).finally(()=>active.delete(id));active.set(id,p);return p;};
 async function mutate(action,fields){
  const s=session(),q=command(action,fields),old=journal(s,q.brand);
  if(old&&['pending','uncertain'].includes(old.phase)){
   if(canonical(old.command)!==canonical(q))closed('CAMPAIGN_BFF_PENDING');return coalesce(s,old,'GET');
  }
  if(old&&old.attemptKey===q.idempotency_key){if(canonical(old.command)!==canonical(q))closed('CAMPAIGN_BFF_PENDING');return coalesce(s,old,'GET');}
  // A corporate session advertises CREATE separately. Existing attempts keep
  // their GET-only reconciliation path when new creation is disabled.
  if(action==='campanha_criar'&&sync(getSession)?.features?.campaignCreate===false)closed('CAMPAIGN_BFF_DENIED');
  const row=persist(s,{schema:'crm-campaign-bff-client-v1',brand:q.brand,action,attemptKey:q.idempotency_key,command:q},'pending');
  return coalesce(s,row,'POST');
 }
 async function consult(brand){const s=session('GET'),row=journal(s,brand);if(!row)closed('CAMPAIGN_BFF_UNKNOWN');return coalesce(s,row,'GET');}
 const guard=fn=>async(...args)=>{try{return await fn(...args);}catch(e){if(e?.name==='CampaignBffClientError')throw e;closed('CAMPAIGN_BFF_UNCERTAIN');}};
 return Object.freeze({...Object.fromEntries(Object.entries(ACTIONS).map(([name,action])=>[name,guard(fields=>mutate(action,fields))])),consult:guard(consult)});
}
if(typeof module!=='undefined'&&module.exports)module.exports={createCampaignBffClient};
else globalThis.ShrigmaCampaignBffClient=Object.freeze({createCampaignBffClient});
