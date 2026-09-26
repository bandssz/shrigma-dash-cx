/* Backend-only candidate. No HTTP, recipient, sender, credentials or transport.
 * Pool, catalogFor and readSource are trusted server adapters, not request data.
 * There is deliberately no activation, message receipt or intent consumer API. */
'use strict';
const {createHash}=require('node:crypto'),G=require('./journey-graph-contract.js');
const VERSION='journey_graph_store_v1',ENABLED=false,SOURCE_VERSION='journey_source_v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const error=code=>Object.assign(new Error(code),{code});
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
const hash=x=>createHash('sha256').update(canonical(x)).digest('hex');
function safeJSON(value){
 const seen=new Set();let count=0;
 function check(x,depth){
  if(++count>20000||depth>24)throw error('GRAPH_INPUT_SIZE');
  if(x===null||typeof x==='boolean'||typeof x==='number'&&Number.isFinite(x))return;
  if(typeof x==='string'){if(x.length>131072)throw error('GRAPH_INPUT_SIZE');return;}
  if(!x||typeof x!=='object'||seen.has(x)||Object.getOwnPropertySymbols(x).length||!Array.isArray(x)&&![Object.prototype,null].includes(Object.getPrototypeOf(x)))throw error('GRAPH_INPUT_JSON');
  if(Array.isArray(x)&&(Object.keys(x).length!==x.length||Object.keys(x).some((k,i)=>k!==String(i))))throw error('GRAPH_INPUT_JSON');
  seen.add(x);for(const [k,d]of Object.entries(Object.getOwnPropertyDescriptors(x))){if(Array.isArray(x)&&k==='length')continue;if(!d.enumerable||!Object.hasOwn(d,'value')||['__proto__','constructor','prototype'].includes(k))throw error('GRAPH_INPUT_JSON');check(d.value,depth+1);}seen.delete(x);
 }
 check(value,0);const s=canonical(value);if(Buffer.byteLength(s)>524288)throw error('GRAPH_INPUT_SIZE');return JSON.parse(s);
}
function exact(x,keys){if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))throw error('GRAPH_INPUT_SHAPE');}
function time(t){if(typeof t!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t)||!Number.isFinite(Date.parse(t))||new Date(t).toISOString()!==t)throw error('GRAPH_TIME');return Date.parse(t);}
function uuid(v){if(typeof v!=='string'||!UUID.test(v))throw error('GRAPH_IDENTITY');}
function expected(v){if(!Number.isSafeInteger(v)||v<1||v>=2147483647)throw error('GRAPH_VERSION');}
function createGraphRuntime({pool,catalogFor,readSource,clock}={}){
 if(typeof pool?.connect!=='function'||typeof catalogFor!=='function'||typeof readSource!=='function'||clock!==undefined&&typeof clock!=='function')throw error('GRAPH_ADAPTER_REQUIRED');
 const queryOne=async(c,q,a=[])=>{const r=await c.query(q,a);if(!Array.isArray(r?.rows)||r.rows.length!==1)throw error('GRAPH_STORAGE_UNCONFIRMED');return r.rows[0];};
 const getTime=async c=>{const now=clock?await clock(): (await queryOne(c,"SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS now")).now;time(now);return now;};
 const current=async(c,id,brand)=>{const r=await c.query('SELECT * FROM crm_graph_candidate.journey WHERE id=$1::uuid AND brand=$2 FOR UPDATE',[id,brand]);if(r.rows.length!==1)throw error('GRAPH_NOT_FOUND');return r.rows[0];};
 const revision=async(c,id,rev)=>{const r=await queryOne(c,'SELECT * FROM crm_graph_candidate.revision WHERE journey_id=$1::uuid AND revision=$2',[id,rev]);if(hash({definition:r.definition,catalog:r.catalog})!==r.content_hash)throw error('GRAPH_REVISION_CORRUPT');return r;};
 const version=(row,v)=>{if(row.version!==v)throw error('GRAPH_VERSION_CONFLICT');};
 const summary=j=>({journey_id:j.id,brand:j.brand,version:j.version,revision:j.head_revision,published_revision:j.published_revision,paused:j.paused});
 const entrySummary=(e,extra={})=>({entry_id:e.id,journey_id:e.journey_id,brand:e.brand,revision:e.revision,version:e.version,state:e.stopped_reason?'stopped':e.state.status,...extra});
 async function prepare(c,definition,brand){
  const catalog=safeJSON(await catalogFor({brand,query:c.query.bind(c)}));
  const valid=G.validateGraph(definition,{catalog});if(!valid.ok)throw error(valid.errors[0].code);
  if(definition.brand!==brand||definition.nodes.filter(n=>n.type==='trigger')[0].event!=='cart.abandoned'||definition.nodes.some(n=>n.type==='message'&&catalog.messages.find(m=>m.key===n.binding).channel!=='email'))throw error('GRAPH_CANDIDATE_SCOPE');
  return {definition,catalog,content_hash:hash({definition,catalog})};
 }
 async function insertRevision(c,j,prepared,now){await c.query('INSERT INTO crm_graph_candidate.revision(journey_id,brand,revision,definition,catalog,content_hash,created_at) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)',[j.id,j.brand,j.head_revision,JSON.stringify(prepared.definition),JSON.stringify(prepared.catalog),prepared.content_hash,now]);}
 async function source(c,ref,brand,trigger,now){
  const p=safeJSON(await readSource({source_ref:ref,brand,trigger,now,query:c.query.bind(c)}));
  exact(p,['version','source_ref','brand','trigger','event_id','subject_id','source_revision','occurred_at','observed_at','complete','eligible','consent','suppressed','facts']);
  if(p.version!==SOURCE_VERSION||p.source_ref!==ref||p.brand!==brand||p.trigger!==trigger)throw error('GRAPH_SOURCE_IDENTITY');
  uuid(p.subject_id);if(typeof p.event_id!=='string'||!p.event_id||p.event_id.length>256||typeof p.source_revision!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(p.source_revision))throw error('GRAPH_SOURCE_IDENTITY');
  const at=time(now),seen=time(p.observed_at),occurred=time(p.occurred_at);
  if(p.complete!==true||seen>at||at-seen>300000||occurred>seen||![true,false].includes(p.eligible)||![true,false].includes(p.consent)||![true,false].includes(p.suppressed))throw error('GRAPH_SOURCE_UNCONFIRMED');
  if(!p.facts||typeof p.facts!=='object'||Array.isArray(p.facts))throw error('GRAPH_SOURCE_UNCONFIRMED');
  return {proof:p,event_key:hash([brand,trigger,p.event_id]),identity_hash:hash([brand,trigger,p.event_id,p.subject_id,p.source_revision,p.occurred_at]),stop:!p.eligible?'source_ineligible':!p.consent?'consent_withdrawn':p.suppressed?'suppressed':null};
 }
 async function command(action,input,fields,fn){
  const p=safeJSON(input);exact(p,['request_id','actor','brand',...fields]);uuid(p.request_id);
  if(typeof p.actor!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(p.actor)||!['fish','aristo'].includes(p.brand))throw error('GRAPH_IDENTITY');
  if(Object.hasOwn(p,'expected_version'))expected(p.expected_version);
  for(const k of ['journey_id','entry_id','source_ref'])if(Object.hasOwn(p,k))uuid(p[k]);
  const requestHash=hash({action,request:p}),c=await pool.connect();let committing=false,discard=null;
  try{
   await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='3s'");await c.query("SET LOCAL statement_timeout='8s'");
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[p.request_id]);
   const old=await c.query('SELECT * FROM crm_graph_candidate.operation WHERE request_id=$1::uuid',[p.request_id]);
   if(old.rows.length){const o=old.rows[0];if(o.actor!==p.actor||o.brand!==p.brand||o.action!==action||o.request_hash!==requestHash)throw error('GRAPH_REPLAY_MISMATCH');committing=true;await c.query('COMMIT');return o.response;}
   const control=await queryOne(c,'SELECT enabled FROM crm_graph_candidate.control WHERE singleton FOR SHARE');
   const now=await getTime(c),result=await fn(c,p,now,control.enabled);
   const response={contract:VERSION,operation_id:p.request_id,authorizes_send:false,...result};
   await c.query('INSERT INTO crm_graph_candidate.operation(request_id,actor,brand,action,request_hash,response,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[p.request_id,p.actor,p.brand,action,requestHash,JSON.stringify(response),now]);
   committing=true;await c.query('COMMIT');return response;
  }catch(e){try{await c.query('ROLLBACK');}catch(rollbackError){discard=rollbackError;}if(committing||discard)throw Object.assign(error('GRAPH_OUTCOME_UNKNOWN'),{request_id:p.request_id});throw e;}
  // pg PoolClient.release(error) destroys the connection; it must never be reused
  // after an unconfirmed rollback, even when the original failure preceded COMMIT.
  finally{c.release(discard||undefined);}
 }
 return Object.freeze({
  create(input){return command('create',input,['definition'],async(c,p,now)=>{
   const prepared=await prepare(c,p.definition,p.brand),j=await queryOne(c,'INSERT INTO crm_graph_candidate.journey(brand) VALUES($1) RETURNING *',[p.brand]);
   await insertRevision(c,j,prepared,now);return summary(j);
  });},
  save(input){return command('save',input,['journey_id','expected_version','definition'],async(c,p,now)=>{
   const j=await current(c,p.journey_id,p.brand);version(j,p.expected_version);const prepared=await prepare(c,p.definition,p.brand);
   const next=await queryOne(c,'UPDATE crm_graph_candidate.journey SET version=version+1,head_revision=head_revision+1 WHERE id=$1 RETURNING *',[j.id]);await insertRevision(c,next,prepared,now);return summary(next);
  });},
  publish(input){return command('publish',input,['journey_id','expected_version','confirm'],async(c,p)=>{
   if(p.confirm!=='publicar')throw error('GRAPH_CONFIRM_REQUIRED');const j=await current(c,p.journey_id,p.brand);version(j,p.expected_version);
   const r=await revision(c,j.id,j.head_revision),fresh=await prepare(c,r.definition,p.brand);if(fresh.content_hash!==r.content_hash)throw error('GRAPH_CATALOG_CHANGED');
   return summary(await queryOne(c,'UPDATE crm_graph_candidate.journey SET version=version+1,published_revision=head_revision,paused=true WHERE id=$1 RETURNING *',[j.id]));
  });},
  pause(input){return command('pause',input,['journey_id','expected_version','paused','confirm'],async(c,p,now,enabled)=>{
   if(typeof p.paused!=='boolean'||p.confirm!==(p.paused?'pausar':'retomar'))throw error('GRAPH_CONFIRM_REQUIRED');
   const j=await current(c,p.journey_id,p.brand);version(j,p.expected_version);if(!p.paused&&(!enabled||j.published_revision===null))throw error('GRAPH_EXECUTION_DISABLED');
   return summary(await queryOne(c,'UPDATE crm_graph_candidate.journey SET version=version+1,paused=$2 WHERE id=$1 RETURNING *',[j.id,p.paused]));
  });},
  enroll(input){return command('enroll',input,['journey_id','expected_version','source_ref'],async(c,p,now,enabled)=>{
   const j=await current(c,p.journey_id,p.brand);version(j,p.expected_version);
   if(!enabled||j.paused||j.published_revision===null)throw error('GRAPH_EXECUTION_DISABLED');
   const r=await revision(c,j.id,j.published_revision),trigger=r.definition.nodes.find(n=>n.type==='trigger').event,s=await source(c,p.source_ref,p.brand,trigger,now);
   if(s.stop)throw error('GRAPH_SOURCE_INELIGIBLE');
   const old=await c.query('SELECT * FROM crm_graph_candidate.entry WHERE journey_id=$1 AND event_key=$2',[j.id,s.event_key]);
   if(old.rows.length){if(old.rows[0].source_identity_hash!==s.identity_hash)throw error('GRAPH_SOURCE_CHANGED');return entrySummary(old.rows[0],{created:false});}
   const id=(await queryOne(c,'SELECT gen_random_uuid() AS id')).id;
   const identity={entry_id:id,journey_id:j.id,revision:r.revision,event_id:s.event_key,brand:p.brand,trigger};
   const state=G.createState(r.definition,{catalog:r.catalog,identity,started_at:now});
   const e=await queryOne(c,'INSERT INTO crm_graph_candidate.entry(id,journey_id,revision,brand,source_ref,event_key,source_identity_hash,identity,state,next_due_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$10,$10) RETURNING *',[id,j.id,r.revision,p.brand,p.source_ref,s.event_key,s.identity_hash,JSON.stringify(identity),JSON.stringify(state),now]);
   return entrySummary(e,{created:true});
  });},
  step(input){return command('step',input,['entry_id','expected_version'],async(c,p,now,enabled)=>{
   const initial=await c.query('SELECT journey_id FROM crm_graph_candidate.entry WHERE id=$1 AND brand=$2',[p.entry_id,p.brand]);if(initial.rows.length!==1)throw error('GRAPH_NOT_FOUND');
   const j=await current(c,initial.rows[0].journey_id,p.brand),e=await queryOne(c,'SELECT * FROM crm_graph_candidate.entry WHERE id=$1 FOR UPDATE',[p.entry_id]);version(e,p.expected_version);
   if(!enabled||j.paused)return entrySummary(e,{kind:'paused'});
   if(e.stopped_reason)return entrySummary(e,{kind:'stopped',reason:e.stopped_reason});
   const r=await revision(c,j.id,e.revision);
   // Validate the pinned state even when this candidate is awaiting a future transport.
   G.nextTransition(r.definition,e.state,{catalog:r.catalog,identity:e.identity,now,paused:true});
   if(['completed','failed','blocked'].includes(e.state.status))return entrySummary(e,{kind:'terminal'});
   if(['waiting_message','unknown'].includes(e.state.status))return entrySummary(e,{kind:'await_transport'});
   const s=await source(c,e.source_ref,p.brand,e.identity.trigger,now);
   if(s.event_key!==e.event_key||s.identity_hash!==e.source_identity_hash)throw error('GRAPH_SOURCE_CHANGED');
   const t=s.stop?{kind:'stopped',state:e.state,reason:s.stop}:G.nextTransition(r.definition,e.state,{catalog:r.catalog,identity:e.identity,now,facts:s.proof.facts});
   const due=t.kind==='advance'?now:t.kind==='wait'?t.due_at:t.kind==='wait_data'?t.recheck_at:null;
   const updated=await queryOne(c,'UPDATE crm_graph_candidate.entry SET state=$2::jsonb,version=version+1,next_due_at=$3,stopped_reason=$4,updated_at=$5 WHERE id=$1 RETURNING *',[e.id,JSON.stringify(t.state),due,s.stop,now]);
   let intentId=null;
   if(t.kind==='message_intent'){
    if(t.intent.channel!=='email'||t.authorizes_send!==false)throw error('GRAPH_CANDIDATE_SCOPE');
    intentId=(await queryOne(c,'INSERT INTO crm_graph_candidate.intent(entry_id,node_id,attempt_key,brand,channel,binding,release,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[e.id,t.intent.node_id,t.intent.attempt_key,p.brand,t.intent.channel,t.intent.binding,t.intent.release,now])).id;
   }
   await c.query('INSERT INTO crm_graph_candidate.transition(entry_id,entry_version,kind,node_id,state,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[e.id,updated.version,t.kind,t.state.node_id,updated.state.status,t.reason||null,now]);
   return entrySummary(updated,{kind:t.kind,node_id:t.state.node_id,next_due_at:due,intent_id:intentId,...(t.reason?{reason:t.reason}:{})});
  });},
  async due({brand,limit=50}={}){
   if(!['fish','aristo'].includes(brand)||!Number.isInteger(limit)||limit<1||limit>100)throw error('GRAPH_BATCH_LIMIT');
   const c=await pool.connect();try{return (await c.query("SELECT e.id AS entry_id,e.version FROM crm_graph_candidate.entry e JOIN crm_graph_candidate.journey j ON j.id=e.journey_id CROSS JOIN crm_graph_candidate.control ctl WHERE ctl.enabled AND NOT j.paused AND e.brand=$1 AND e.stopped_reason IS NULL AND e.next_due_at<=clock_timestamp() ORDER BY e.next_due_at,e.id LIMIT $2",[brand,limit])).rows;}finally{c.release();}
  }
 });
}
module.exports={VERSION,ENABLED,SOURCE_VERSION,createGraphRuntime};
