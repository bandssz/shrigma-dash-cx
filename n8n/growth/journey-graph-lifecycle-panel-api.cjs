/* Existing CRM service boundary: preparation and paused publication only. */
'use strict';
const C=require('./journey-graph-lifecycle-contract.cjs');
const {createLifecyclePreparer}=require('./journey-graph-lifecycle-prepare.cjs');
const {createLifecyclePublisher}=require('./journey-graph-lifecycle-publication.cjs');
const {createLifecycleActivation}=require('./journey-graph-lifecycle-activation.cjs');
const VERSION='journey_graph_lifecycle_panel_v1',ORIGIN='https://bandssz.github.io';
const FLAGS=Object.freeze({authorizes_publish:false,authorizes_activate:false,authorizes_enrollment:false,authorizes_send:false});
const fail=code=>Object.assign(Error(code),{code});
function createLifecyclePanelAPI({pool,checkoutSha,enabled=false,activationEnabled=false,preparerFactory=createLifecyclePreparer,publisherFactory=createLifecyclePublisher,activationFactory=createLifecycleActivation}={}){
 if(typeof pool?.connect!=='function'||typeof enabled!=='boolean'||typeof activationEnabled!=='boolean'||!/^[a-f0-9]{40}$/.test(checkoutSha||''))throw fail('GRAPH_LIFECYCLE_ADAPTER');
 const reply=(status,body)=>({status,headers:{'Cache-Control':'no-store'},body:{contract:VERSION,...body,...FLAGS}});
 function scopedPool(signal){return {async connect(){
  if(signal?.aborted)throw fail('GRAPH_LIFECYCLE_TIMEOUT');
  const client=await pool.connect();
  try{const identity=await client.query('SELECT current_user AS role');if(identity.rows?.length!==1||identity.rows[0].role!=='crm_audience_api')throw fail('GRAPH_LIFECYCLE_ACCESS');}
  catch(e){client.release(e);throw e;}
  return {async query(sql,values){
   // Cleanup must remain possible after a disconnected HTTP request. A timeout
   // never proves rollback: the module retains its COMMIT/readback semantics.
   if(signal?.aborted&&sql!=='ROLLBACK')throw fail('GRAPH_LIFECYCLE_TIMEOUT');
   const result=await client.query(sql,values);
   if(sql==='COMMIT'&&result.command!=='COMMIT')throw fail('GRAPH_LIFECYCLE_READ_UNCONFIRMED');
   if(signal?.aborted&&sql!=='COMMIT'&&sql!=='ROLLBACK')throw fail('GRAPH_LIFECYCLE_TIMEOUT');
   return result;
  },release:error=>client.release(error)};
 }};}
 return Object.freeze({async handle({method,request}={}, {signal}={}){
  let p;
  try{
   if(signal!==undefined&&!(signal instanceof AbortSignal))throw fail('GRAPH_LIFECYCLE_INPUT');
   const headers=request?.headers||{},auth=Object.entries(headers).filter(([k])=>k.toLowerCase()==='authorization'),origins=Object.entries(headers).filter(([k])=>k.toLowerCase()==='origin');
   if(auth.length!==1||!/^Bearer [a-z0-9-]{8,128}$/.test(auth[0][1]||''))return reply(401,{error:'GRAPH_LIFECYCLE_ACCESS'});
   if(origins.length>1||origins.length===1&&origins[0][1]!==ORIGIN)return reply(403,{error:'GRAPH_LIFECYCLE_ACCESS'});
   if(!['GET','POST'].includes(method)||method==='GET'&&request.body!==undefined||method==='POST'&&request.query!==undefined)throw fail('GRAPH_LIFECYCLE_INPUT');
   p=C.validateRequest(method==='GET'?request.query:request.body);
   if(!['review','prepare','publish','operation','status','activation_review','activation_operation','activate'].includes(p.action)||(['operation','status','activation_operation'].includes(p.action)?method!=='GET':method!=='POST'))throw fail('GRAPH_LIFECYCLE_INPUT');
   // Reconciliation remains readable if publication is withdrawn later.
   if(!enabled&&!['operation','status','activation_operation'].includes(p.action))return reply(503,{error:'GRAPH_LIFECYCLE_UNAVAILABLE'});
   if(['activation_review','activate'].includes(p.action)&&!activationEnabled)return reply(503,{error:'GRAPH_ACTIVATION_UNAVAILABLE'});
   const options={pool:scopedPool(signal),checkoutSha,runtimeAccess:true},preparer=preparerFactory(options),publisher=publisherFactory(options),activation=activationFactory({pool:scopedPool(signal),enabled:activationEnabled}),access={authorization:auth[0][1]};
   if(p.action==='activation_review')return reply(200,await activation.review(p,access));
   if(p.action==='activate'){
    const r=await activation.activate(p,access);return reply(200,r);
   }
   if(p.action==='activation_operation'){
    const r=await activation.operation(p,access);return reply(r.state==='unconfirmed'?202:200,r);
   }
   if(p.action==='status'){const active=activationEnabled?await activation.status(p,access):null,result=active||await publisher.status(p,access);return reply(200,{...result,server:Object.fromEntries(['journey_id','brand','version','revision','published_revision','paused'].map(k=>[k,result.server[k]]))});}
   if(p.action==='review')return reply(200,await preparer.review(p,access));
   let r;
   if(p.action==='operation'){
    const publication=await publisher.operation(p,access);
    if(publication.state!=='unconfirmed')r=publication;
    else{r=await preparer.operation(p,access);if(r.actor!==publication.actor)throw fail('GRAPH_LIFECYCLE_ACCESS');}
   }else r=await (p.action==='prepare'?preparer.prepare(p,access):publisher.publish(p,access));
   if(r.state==='unconfirmed')return reply(202,{state:'unconfirmed',actor:r.actor,request_id:p.request_id,automatic_retry:false});
   if(!['prepared','published_paused'].includes(r.state)||!r.actor||!r.request_payload||!r.receipt)throw fail('GRAPH_LIFECYCLE_CORRUPT');
   return reply(200,{state:'succeeded',actor:r.actor,request_id:p.request_id,request_payload:r.request_payload,receipt:r.receipt});
  }catch(e){
   const code=/^GRAPH_(LIFECYCLE|PREPARE|PUBLICATION|ACTIVATION|RELEASE|CATALOG)_[A-Z_]+$/.test(e?.code||'')?e.code:'GRAPH_LIFECYCLE_READ_UNCONFIRMED';
   if(code.endsWith('_OUTCOME_UNKNOWN'))return reply(202,{state:'unconfirmed',request_id:p?.request_id,automatic_retry:false,error:code});
   const status=code.endsWith('_ACCESS')?403:code.endsWith('_INPUT')?400:code.endsWith('_NOT_FOUND')?404:/_(VERSION|DRIFT|EXPIRED|CONSUMED|MISMATCH|CONTROL|SOURCE_CHANGED|CATALOG_CHANGED|ALREADY_PUBLISHED)$/.test(code)?409:503;
   return reply(status,{error:code});
  }
 }});
}
module.exports={VERSION,ORIGIN,createLifecyclePanelAPI};
