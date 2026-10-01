/* Private Node worker. Source admission is bounded to the explicit active CART epoch. */
'use strict';
const {createHash}=require('node:crypto');
const {createGraphRuntime}=require('./journey-graph-runtime.cjs');
const {createCartBridge}=require('./journey-graph-cart.cjs');
const {createMessageClaim}=require('./journey-graph-message.cjs');
const {createDelivery}=require('./journey-graph-delivery.cjs');
const {createShopifySource}=require('./journey-graph-shopify.cjs');
const {createSourceAdapter}=require('./journey-graph-source.cjs');
const {validateReceipt}=require('./journey-graph-native.cjs');
const VERSION='journey_graph_worker_v1',ACTOR='worker:graph-cart-v1',POLICY='cart_customer_order_observation_v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail=code=>Object.assign(Error(code),{code});
function operationId(parts){const h=createHash('sha256').update(JSON.stringify([VERSION,...parts])).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);}
const safeCode=e=>/^GRAPH_[A-Z0-9_]{1,90}$/.test(e?.code||'')?e.code:'GRAPH_WORKER_UNCONFIRMED';
function createWorker({pool,enabled=false,actor=ACTOR,authorizeWorker,cacheTarget,shops,shopifyRequest,collectorWorkflowIds,sendTx,readSource,clock=Date.now}={}){
 if(typeof pool?.connect!=='function'||typeof pool?.query!=='function'||typeof enabled!=='boolean'||actor!==ACTOR||typeof authorizeWorker!=='function'||typeof sendTx!=='function'||typeof clock!=='function'||typeof cacheTarget!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(cacheTarget)||readSource!==undefined&&typeof readSource!=='function'||!['fish','aristo'].every(b=>/^[A-Za-z0-9_-]{8,64}$/.test(collectorWorkflowIds?.[b]||'')))throw fail('GRAPH_WORKER_CONFIG');
 const query=pool.query.bind(pool),busy=new Set();
 // The optional readSource dependency is for trusted composition/testing. No job
 // accepts facts or swaps this callback. Production composes the Shopify adapter.
 const source=readSource?{...createSourceAdapter({query,collectorWorkflowIds}),readSource}:createShopifySource({query,request:shopifyRequest,shops,collectorWorkflowIds,observationPolicy:POLICY});
 async function authorize(brand,action,q=query){if(!['fish','aristo'].includes(brand))throw fail('GRAPH_WORKER_INPUT');let allowed;try{allowed=await authorizeWorker({query:q,actor,brand,action});}catch{throw fail('GRAPH_WORKER_UNAUTHORIZED');}if(allowed!==true)throw fail('GRAPH_WORKER_UNAUTHORIZED');}
 const bridge=q=>createCartBridge({query:q,cacheTarget});
 async function beforeCommand({query:q,actor:a,brand,action}){
  if(a!==actor)throw fail('GRAPH_WORKER_UNAUTHORIZED');await authorize(brand,action,q);
  if(action!=='apply_dispatch'){if(!enabled)throw fail('GRAPH_WORKER_DISABLED');await q('SELECT crm_graph_candidate.cart_maintenance_guard_v1()');}
 }
 const runtime=createGraphRuntime({pool,catalogFor:async()=>{throw fail('GRAPH_WORKER_LIFECYCLE_UNAVAILABLE');},readSource:source.readSource,beforeCommand,readDispatch:({query:q,brand,intent_id})=>bridge(q).dispatch(brand,intent_id)});
 const claim=createMessageClaim({pool,readSource:source.readSource,cacheTarget,resolveNative:async({query:q,brand,release_id,material_sha256})=>{
  const r=await q('SELECT crm_graph_candidate.native_resolve_v1($1,$2,$3,$4) result',[brand,release_id,material_sha256,cacheTarget]);if(r.rows?.length!==1)throw fail('GRAPH_WORKER_NATIVE_UNCONFIRMED');return validateReceipt(r.rows[0].result,{brand,release_id,material_sha256,cache_target:cacheTarget,state:'ready'});
 }});
 async function applyReceipt(p,d){
  await authorize(p.brand,'apply_dispatch');
  const request_id=operationId([actor,p.brand,'apply_dispatch',p.intent_id,d.dispatch_id,d.transport_state]);
  async function previous(){
   const r=await query('SELECT actor,brand,action,response FROM crm_graph_candidate.operation WHERE request_id=$1',[request_id]);if(!r.rows.length)return null;const o=r.rows[0],v=o.response;
   if(o.actor!==actor||o.brand!==p.brand||o.action!=='apply_dispatch'||v?.contract!=='journey_graph_store_v1'||v.operation_id!==request_id||v.brand!==p.brand||v.entry_id!==p.entry_id||v.intent_id!==p.intent_id||v.dispatch_id!==d.dispatch_id||v.transport_state!==d.transport_state||v.authorizes_send!==false)throw fail('GRAPH_WORKER_RECEIPT_MISMATCH');return v;
  }
  const old=await previous();if(old)return old;
  const e=await query('SELECT e.version FROM crm_graph_candidate.entry e JOIN crm_graph_candidate.intent i ON i.entry_id=e.id AND i.brand=e.brand WHERE i.id=$1 AND e.id=$2 AND e.brand=$3',[p.intent_id,p.entry_id,p.brand]);if(e.rows.length!==1)throw fail('GRAPH_WORKER_NOT_FOUND');
  const request={request_id,actor,brand:p.brand,entry_id:p.entry_id,expected_version:e.rows[0].version,intent_id:p.intent_id};
  try{return await runtime.applyDispatch(request);}catch(error){
   // A competing call may have committed this exact semantic receipt between our
   // read and CAS. Read only; never construct a second operation or resend.
   if(!['GRAPH_OUTCOME_UNKNOWN','GRAPH_VERSION_CONFLICT','GRAPH_REPLAY_MISMATCH'].includes(error?.code))throw error;
   const saved=await previous();if(saved)return saved;throw error;
  }
 }
 const delivery=createDelivery({claim:async p=>{if(!enabled)throw fail('GRAPH_WORKER_DISABLED');await authorize(p.brand,'claim');return claim.claim(p);},inspect:({brand,intent_id})=>bridge(query).dispatch(brand,intent_id),
  finish:async({dispatch_id,claim_token,outcome,context})=>{const r=await query('SELECT * FROM public.shrigma_email_finish_cart($1,$2,$3,$4)',[dispatch_id,claim_token,outcome,context]);if(r.rows?.length!==1)throw fail('GRAPH_WORKER_FINISH_UNCONFIRMED');return r.rows[0];},
  applyReceipt,sendTx,clock});
 function identity(p){if(!p||Object.keys(p).sort().join(',')!=='brand,intent_id'||!['fish','aristo'].includes(p.brand)||!UUID.test(p.intent_id||''))throw fail('GRAPH_WORKER_INPUT');return p;}
 async function reconcile(p){identity(p);await authorize(p.brand,'reconcile');const e=await query('SELECT e.version FROM crm_graph_candidate.entry e JOIN crm_graph_candidate.intent i ON i.entry_id=e.id AND i.brand=e.brand WHERE i.id=$1 AND i.brand=$2',[p.intent_id,p.brand]);if(e.rows.length!==1)throw fail('GRAPH_WORKER_NOT_FOUND');return delivery.reconcile({...p,expected_entry_version:e.rows[0].version});}
 async function gate(brand){const r=await query("SELECT ctl.enabled AND cc.enabled AND cc.cache_target=$2 AND m.enabled AND m.mode='open' open FROM crm_graph_candidate.control ctl CROSS JOIN crm_graph_candidate.cart_control_v1 cc CROSS JOIN crm_maintenance_candidate.control m WHERE ctl.singleton AND m.singleton AND cc.brand=$1",[brand,cacheTarget]);return r.rows?.length===1&&r.rows[0].open===true;}
 const api={
  async inspect(){
   const brands={};for(const brand of ['fish','aristo']){await authorize(brand,'inspect');const r=await query(`SELECT
    (SELECT count(*)::int FROM crm_graph_candidate.cart_owner_v1 WHERE brand=$1) owned_entries,
    (SELECT count(*)::int FROM crm_graph_candidate.intent i JOIN crm_graph_candidate.entry e ON e.id=i.entry_id WHERE i.brand=$1 AND e.state->>'status' IN ('waiting_message','unknown')) pending_intents,
    (SELECT count(*)::int FROM crm_graph_candidate.cart_delivery_v1 l JOIN public.shrigma_email_dispatch d ON d.dispatch_id=l.dispatch_id WHERE l.brand=$1 AND NOT EXISTS(SELECT 1 FROM crm_graph_candidate.dispatch_receipt_v1 r WHERE r.intent_id=l.intent_id AND r.transport_state=d.transport_state)) unapplied_receipts`,[brand]);if(r.rows?.length!==1)throw fail('GRAPH_WORKER_STORAGE_UNCONFIRMED');brands[brand]={storage_available:true,execution_open:enabled&&await gate(brand),...r.rows[0]};}
   return {contract:VERSION,enabled,admissions:enabled,publish:false,panel_activation:false,brands};
  },
  async captureHandoff(handoff){
   await authorize(handoff?.brand,'capture');try{
    const captured=await source.captureHandoff(handoff);
    // The collector route is the sole source ingress.  When execution remains
    // OFF it only persists the immutable source receipt.  Once an explicit
    // activation has opened the brand epoch, admit each exact persisted source
    // through the narrow SECURITY DEFINER boundary; no request supplies a
    // journey, version or cache target.
    if(enabled&&await gate(handoff.brand)){
     const active=await query(`SELECT e.journey_id,j.version,e.cache_target FROM crm_graph_candidate.cart_epoch_v1 e JOIN crm_graph_candidate.journey j ON j.id=e.journey_id AND j.brand=e.brand WHERE e.brand=$1 AND e.ends_at IS NULL AND NOT j.paused`,[handoff.brand]);
     if(active.rows?.length!==1)throw fail('GRAPH_WORKER_ADMISSION_UNAVAILABLE');
     const a=active.rows[0];for(const sourceRef of captured.source_refs){const admitted=await query('SELECT crm_graph_candidate.cart_admit_source_v1($1,$2,$3,$4,$5) result',[handoff.brand,sourceRef,a.journey_id,a.version,a.cache_target]);if(admitted.rows?.length!==1||admitted.rows[0].result?.contract!=='journey_graph_cart_admission_v1'||admitted.rows[0].result.authorizes_send!==false)throw fail('GRAPH_WORKER_ADMISSION_UNCONFIRMED');}
    }
    return captured;
   }catch(e){throw fail(safeCode(e));}
  },
  async reconcile(p){try{return await reconcile(p);}catch(e){throw fail(safeCode(e));}},
  async tick({brand,limit=5,...extra}={}){
   if(Object.keys(extra).length||!['fish','aristo'].includes(brand)||!Number.isSafeInteger(limit)||limit<1||limit>5)throw fail('GRAPH_WORKER_INPUT');
   const result={contract:VERSION,brand,enabled,state:'idle',processed:0,advanced:0,intents:0,reconciled:0,transport_started:0,blocked:0,errors:[]};
   await authorize(brand,'tick');if(!enabled)return {...result,state:'disabled'};if(busy.has(brand))return {...result,state:'busy'};busy.add(brand);
   const started=clock(),room=()=>result.processed<limit&&clock()-started<50000;
   const report=e=>{result.errors.push({code:safeCode(e)});result.blocked++;};
   try{
    // Recover existing native reservations first, even if maintenance/pauses now
    // forbid new work. No payload or claim token can be recovered through this path.
    const pending=await query(`SELECT l.intent_id FROM crm_graph_candidate.cart_delivery_v1 l JOIN public.shrigma_email_dispatch d ON d.dispatch_id=l.dispatch_id WHERE l.brand=$1 AND NOT EXISTS(SELECT 1 FROM crm_graph_candidate.dispatch_receipt_v1 r WHERE r.intent_id=l.intent_id AND r.transport_state=d.transport_state) ORDER BY l.created_at,l.intent_id LIMIT $2`,[brand,limit]);
    for(const row of pending.rows){if(!room())break;result.processed++;try{const r=await reconcile({brand,intent_id:row.intent_id});if(r.receipt_applied)result.reconciled++;else result.blocked++;}catch(e){report(e);}}
    if(!room()||!await gate(brand))return {...result,state:result.processed?'processed':'blocked'};
    const due=await query(`SELECT e.id,e.version FROM crm_graph_candidate.entry e JOIN crm_graph_candidate.journey j ON j.id=e.journey_id JOIN crm_graph_candidate.cart_owner_v1 o ON o.entry_id=e.id AND o.brand=e.brand WHERE e.brand=$1 AND NOT j.paused AND e.stopped_reason IS NULL AND e.next_due_at<=clock_timestamp() AND o.expires_at>clock_timestamp() ORDER BY e.next_due_at,e.id LIMIT $2`,[brand,limit-result.processed]);
    for(const e of due.rows){if(!room())break;result.processed++;try{const r=await runtime.step({request_id:operationId([actor,brand,'step',e.id,e.version]),actor,brand,entry_id:e.id,expected_version:e.version});if(r.kind==='message_intent')result.intents++;else if(r.kind==='advance')result.advanced++;}catch(error){report(error);}}
    if(!room()||!await gate(brand))return {...result,state:result.processed?'processed':'blocked'};
    const intents=await query(`SELECT i.id,e.version FROM crm_graph_candidate.intent i JOIN crm_graph_candidate.entry e ON e.id=i.entry_id AND e.brand=i.brand JOIN crm_graph_candidate.journey j ON j.id=e.journey_id JOIN crm_graph_candidate.cart_owner_v1 o ON o.entry_id=e.id AND o.brand=e.brand WHERE i.brand=$1 AND NOT j.paused AND e.stopped_reason IS NULL AND e.state->>'status'='waiting_message' AND e.state->>'node_id'=i.node_id AND o.expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM crm_graph_candidate.cart_delivery_v1 l WHERE l.intent_id=i.id) ORDER BY i.created_at,i.id LIMIT $2`,[brand,limit-result.processed]);
    for(const i of intents.rows){if(!room())break;result.processed++;try{
     // Read once more immediately before claim: another process may have reserved
     // since selection. The SQL claim still fences the remaining race atomically.
     const existing=await bridge(query).dispatch(brand,i.id),r=existing?await reconcile({brand,intent_id:i.id}):await delivery.deliver({brand,intent_id:i.id,expected_entry_version:i.version});
     if(r.transport_started)result.transport_started++;if(r.receipt_applied)result.reconciled++;if(['blocked','unconfirmed','reserved_expired'].includes(r.state))result.blocked++;
    }catch(error){report(error);}}
    return {...result,state:result.processed?'processed':'idle'};
   }catch(e){report(e);return {...result,state:'blocked'};}finally{busy.delete(brand);}
  }
 };
 api.sourceOperation=async p=>{await authorize(p?.brand,'capture');try{return await source.readHandoff(p);}catch(e){throw fail(safeCode(e));}};
 api.tickRequest=async p=>{
  if(!p||Object.keys(p).sort().join(',')!=='brand,limit,request_id'||!UUID.test(p.request_id||''))throw fail('GRAPH_WORKER_INPUT');
  await authorize(p.brand,'tick');const first=(await query('SELECT crm_graph_candidate.worker_request_begin_v1($1,$2,$3::jsonb) result',[p.brand,p.request_id,JSON.stringify(p)])).rows?.[0]?.result;
  if(first?.contract!=='journey_graph_worker_request_v1'||first.brand!==p.brand||first.request_id!==p.request_id||first.authorizes_send!==false)throw fail('GRAPH_WORKER_REQUEST_UNCONFIRMED');
  if(first.state==='completed')return first;if(first.fresh!==true)throw fail('GRAPH_WORKER_REQUEST_UNCONFIRMED');
  const response=await api.tick({brand:p.brand,limit:p.limit}),done=(await query('SELECT crm_graph_candidate.worker_request_finish_v1($1,$2,$3::jsonb) result',[p.brand,p.request_id,JSON.stringify(response)])).rows?.[0]?.result;
  if(done?.contract!=='journey_graph_worker_request_v1'||done.state!=='completed'||done.brand!==p.brand||done.request_id!==p.request_id||done.authorizes_send!==false)throw fail('GRAPH_WORKER_REQUEST_UNCONFIRMED');return done;
 };
 api.tickOperation=async p=>{if(!p||Object.keys(p).sort().join(',')!=='brand,request_id'||!['fish','aristo'].includes(p.brand)||!UUID.test(p.request_id||''))throw fail('GRAPH_WORKER_INPUT');await authorize(p.brand,'tick');const v=(await query('SELECT crm_graph_candidate.worker_request_read_v1($1,$2) result',[p.brand,p.request_id])).rows?.[0]?.result;if(v?.contract!=='journey_graph_worker_request_v1'||v.brand!==p.brand||v.request_id!==p.request_id||!['missing','in_flight','completed'].includes(v.state)||v.authorizes_send!==false)throw fail('GRAPH_WORKER_REQUEST_UNCONFIRMED');return v;};
 return Object.freeze(api);
}
module.exports={VERSION,ENABLED:false,ACTOR,operationId,createWorker};
