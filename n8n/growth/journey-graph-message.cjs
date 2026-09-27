/* Trusted backend: current source and immutable clone are checked on the same
 * connection as the original cart reservation. Preview stays read-only; only a
 * confirmed claim transaction may return a private transport grant. No HTTP. */
'use strict';
const {createHash}=require('node:crypto');
const G=require('./journey-graph-contract.js'),R=require('./journey-graph-release.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail=code=>Object.assign(Error(code),{code});
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
const hash=x=>createHash('sha256').update(canonical(x)).digest('hex');
const same=(a,b)=>canonical(a)===canonical(b);
const iso=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
const nativeKeys='brand,cache_ack_at,cache_target,clone_template_id,contract,material_sha256,native_id,native_sha256,release_id,state';
function createMessageOperations({pool,readSource,resolveNative,cacheTarget}={}){
 if(typeof pool?.connect!=='function'||typeof readSource!=='function'||typeof resolveNative!=='function'||typeof cacheTarget!=='string'||!cacheTarget.trim()||cacheTarget.length>128)throw fail('GRAPH_MESSAGE_ADAPTER');
 async function run({brand,intent_id,...extra}={},expectedVersion){
  const claiming=expectedVersion!==undefined;
  if(!['fish','aristo'].includes(brand)||!UUID.test(intent_id||'')||Object.keys(extra).length||claiming&&(!Number.isSafeInteger(expectedVersion)||expectedVersion<1||expectedVersion>=2147483647))throw fail('GRAPH_MESSAGE_INPUT');
  const c=await pool.connect();let discard,committing=false;
  const one=async(sql,params=[])=>{const r=await c.query(sql,params);if(r?.rows?.length!==1)throw fail('GRAPH_MESSAGE_NOT_FOUND');return r.rows[0];};
  const now=async()=>{const r=await one(`SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);if(!iso(r.now))throw fail('GRAPH_MESSAGE_CLOCK');return r.now;};
  try{
   await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='3s'");await c.query("SET LOCAL statement_timeout='8s'");
   if(claiming)await c.query('SELECT crm_graph_candidate.cart_maintenance_guard_v1()');
   const ctl=await one('SELECT enabled FROM crm_graph_candidate.control WHERE singleton FOR SHARE');if(ctl.enabled!==true)throw fail('GRAPH_MESSAGE_DISABLED');
   if(claiming){const cart=await one('SELECT enabled,cache_target FROM crm_graph_candidate.cart_control_v1 WHERE brand=$1 FOR SHARE',[brand]);if(cart.enabled!==true||cart.cache_target!==cacheTarget)throw fail('GRAPH_MESSAGE_DISABLED');}
   const i=await one('SELECT i.*,e.journey_id FROM crm_graph_candidate.intent i JOIN crm_graph_candidate.entry e ON e.id=i.entry_id AND e.brand=i.brand WHERE i.id=$1::uuid AND i.brand=$2',[intent_id,brand]);
   // Same order as runtime: control, journey, entry, then current native state.
   const j=await one('SELECT * FROM crm_graph_candidate.journey WHERE id=$1 AND brand=$2 FOR UPDATE',[i.journey_id,brand]);
   const e=await one('SELECT * FROM crm_graph_candidate.entry WHERE id=$1 AND brand=$2 FOR UPDATE',[i.entry_id,brand]);
   if(claiming&&e.version!==expectedVersion)throw fail('GRAPH_MESSAGE_VERSION_CONFLICT');
   if(j.paused||e.stopped_reason||e.state.status!=='waiting_message'||e.state.node_id!==i.node_id||e.state.attempt_key!==i.attempt_key||i.channel!=='email'||i.authorizes_send!==false)throw fail('GRAPH_MESSAGE_NOT_PENDING');
   const r=await one('SELECT * FROM crm_graph_candidate.revision WHERE journey_id=$1 AND revision=$2 AND brand=$3',[j.id,e.revision,brand]);
   if(hash({definition:r.definition,catalog:r.catalog})!==r.content_hash)throw fail('GRAPH_REVISION_CORRUPT');
   // The existing cart claim locks dedupe before subscriber. Acquire that same
   // identity first so this preflight cannot invert its lock order.
   if(claiming)await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('r4-claim:'||se.brand||':carrinho:carrinho-30min:'||jsonb_build_array('email',to_char(se.ref AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),se.subscriber_id,false)::text,0)) FROM crm_graph_candidate.source_event_v1 se WHERE se.id=$1 AND se.brand=$2`,[e.source_ref,brand]);
   // Claim leaves subscriber locking to the original advisory→dispatch→subscriber
   // order. Its RPC must recheck this identity after acquiring those locks.
   const identity=await one('SELECT s.id,s.uuid,s.email,se.ref FROM crm_graph_candidate.source_event_v1 se JOIN public.subscribers s ON s.id=se.subscriber_id AND s.uuid=se.subject_id WHERE se.id=$1 AND se.brand=$2'+(claiming?'':' FOR SHARE OF s'),[e.source_ref,brand]);
   const started=await now();G.nextTransition(r.definition,e.state,{catalog:r.catalog,identity:e.identity,now:started,paused:true});
   const node=r.definition.nodes.find(n=>n.id===i.node_id),binding=r.catalog.messages.find(m=>m.key===i.binding);
   if(node?.type!=='message'||node.binding!==i.binding||binding?.release!==i.release||!binding.material||binding.brand!==brand||e.identity.entry_id!==e.id||e.identity.journey_id!==j.id||e.identity.revision!==e.revision)throw fail('GRAPH_MESSAGE_BINDING');
   const release=await R.createReleaseProvider({query:c.query.bind(c)}).read(brand,binding.material.release_id);
   if(!same(R.catalogMessage(release),binding))throw fail('GRAPH_MESSAGE_BINDING');
   const source=await readSource({source_ref:e.source_ref,brand,trigger:e.identity.trigger,now:started,query:c.query.bind(c)});
   if(source?.source_ref!==e.source_ref||source.brand!==brand||source.trigger!==e.identity.trigger||!iso(source.occurred_at)||!iso(source.observed_at)||source.observed_at!==started||hash([brand,source.trigger,source.event_id])!==e.event_key||hash([brand,source.trigger,source.event_id,source.subject_id,source.source_revision,source.occurred_at])!==e.source_identity_hash)throw fail('GRAPH_MESSAGE_SOURCE_CHANGED');
   const native=await resolveNative({brand,release_id:release.id,material_sha256:release.material_sha256,query:c.query.bind(c)});
   if(!native||Object.keys(native).sort().join(',')!==nativeKeys||native.contract!=='journey_graph_native_v1'||native.brand!==brand||native.release_id!==release.id||native.material_sha256!==release.material_sha256||native.cache_target!==cacheTarget||native.state!=='ready'||!UUID.test(native.native_id)||!/^[a-f0-9]{64}$/.test(native.native_sha256)||!Number.isSafeInteger(native.clone_template_id)||native.clone_template_id<=0||typeof native.cache_ack_at!=='string'||!Number.isFinite(Date.parse(native.cache_ack_at)))throw fail('GRAPH_MESSAGE_NATIVE_UNCONFIRMED');
   if(identity.uuid!==source.subject_id||new Date(identity.ref).toISOString()!==source.occurred_at||!Number.isSafeInteger(identity.id)||identity.id<=0||typeof identity.email!=='string'||identity.email.length>254||!(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).test(identity.email)||/[\r\n]/.test(identity.email))throw fail('GRAPH_MESSAGE_RECIPIENT_CHANGED');
   const current=(await one('SELECT crm_graph_candidate.source_read_v1($1,$2) AS result',[brand,e.source_ref])).result;
   if(current?.subject_id!==source.subject_id||current.source_revision!==source.event_id||current.eligible!==true||current.consent!==true||current.suppressed!==false||current.purchase_positive===true)throw fail('GRAPH_MESSAGE_SOURCE_CHANGED');
   const checked=await now();if(Date.parse(native.cache_ack_at)>Date.parse(checked)||Date.parse(checked)-Date.parse(started)>5000)throw fail('GRAPH_MESSAGE_EXPIRED');
   const readiness=G.messageReadiness(i.binding,{catalog:r.catalog,trigger:e.identity.trigger,facts:source.facts,now:checked});if(!readiness.ready)throw fail('GRAPH_MESSAGE_DATA_UNCONFIRMED');
   const material=R.materialize(release.material,source,{now:checked});
   const result={contract:'journey_graph_message_preflight_v1',intent_id,brand,entry_id:e.id,entry_version:e.version,source_ref:e.source_ref,release_id:release.id,material_sha256:release.material_sha256,native_id:native.native_id,checked_at:checked,expires_at:new Date(Date.parse(started)+5000).toISOString(),authorizes_send:false,transport:false,
    // Private in-memory values only. Never copy this object to an operator receipt/log.
    recipient:{subscriber_id:identity.id,subject_id:identity.uuid,email:identity.email},ref:source.occurred_at,source_checkout_url:source.facts['cart.checkout_url'].value,
    message:{template_id:native.clone_template_id,subscriber_email:identity.email,from_email:material.from_email,headers:[{'Reply-To':material.reply_to}],data:material.context.Tx.Data}};
   if(claiming){
    const {createCartBridge}=require('./journey-graph-cart.cjs');
    const grant=await createCartBridge({query:c.query.bind(c),cacheTarget}).claim({brand,intent_id,expected_entry_version:expectedVersion,preflight:result});
    committing=true;await c.query('COMMIT');return grant;
   }
   // Preview releases locks without creating a durable send receipt.
   await c.query('ROLLBACK');return result;
  }catch(e){try{await c.query('ROLLBACK');}catch(rollbackError){discard=rollbackError;}if(claiming&&(committing||discard))throw Object.assign(fail('GRAPH_MESSAGE_OUTCOME_UNKNOWN'),{intent_id});throw e?.code?.startsWith('GRAPH_')?e:fail('GRAPH_MESSAGE_UNCONFIRMED');}
  finally{c.release(discard||undefined);}
 }
 return Object.freeze({prepare:request=>run(request),claim({brand,intent_id,expected_entry_version,...extra}={}){
  if(Object.keys(extra).length||expected_entry_version===undefined)throw fail('GRAPH_MESSAGE_INPUT');
  return run({brand,intent_id},expected_entry_version);
 }});
}
function createMessagePreflight(options){const api=createMessageOperations(options);return Object.freeze({prepare:api.prepare});}
function createMessageClaim(options){const api=createMessageOperations(options);return Object.freeze({claim:api.claim});}
module.exports={ENABLED:false,createMessagePreflight,createMessageClaim};
