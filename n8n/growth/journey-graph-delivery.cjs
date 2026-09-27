/* Private server orchestration. Dependencies fix the existing Listmonk instance,
 * credentials and original finish; no operator-supplied URL, content or recipient.
 * An uncertain operation is inspected, never transported again. */
'use strict';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail=code=>Object.assign(Error(code),{code});
const states=new Set(['in_flight','accepted','rejected','outcome_unknown']);
function request(p){
 if(!p||Object.keys(p).sort().join(',')!=='brand,expected_entry_version,intent_id'||!['fish','aristo'].includes(p.brand)||!UUID.test(p.intent_id||'')||!Number.isSafeInteger(p.expected_entry_version)||p.expected_entry_version<1||p.expected_entry_version>=2147483647)throw fail('GRAPH_DELIVERY_INPUT');
 return {...p};
}
function classify(response){
 const code=Number(response?.statusCode||0);let body=response?.body;
 if(typeof body==='string'){try{body=JSON.parse(body);}catch{body=null;}}
 return code>=200&&code<300&&body?.data===true?'accepted':[400,401,403,404,422].includes(code)?'rejected':'outcome_unknown';
}
function createDelivery({claim,inspect,finish,applyReceipt,sendTx,clock=Date.now,timeoutMs=40000}={}){
 if([claim,inspect,finish,applyReceipt,sendTx,clock].some(f=>typeof f!=='function')||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>40000)throw fail('GRAPH_DELIVERY_ADAPTER');
 async function transport(payload){
  const controller=new AbortController();let timer;
  try{return await Promise.race([
   Promise.resolve().then(()=>sendTx(payload,{signal:controller.signal,timeoutMs,maxResponseBytes:65536,retry:false,redirect:'error'})),
   new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('GRAPH_DELIVERY_TIMEOUT'));},timeoutMs);})
  ]);}finally{clearTimeout(timer);}
 }
 async function reconcile(input){
  const p=request(input),r=await inspect({brand:p.brand,intent_id:p.intent_id});
  if(r===null)return {brand:p.brand,intent_id:p.intent_id,state:'unconfirmed',dispatch_id:null,receipt_applied:false};
  if(r?.contract!=='journey_graph_cart_dispatch_v1'||r.brand!==p.brand||r.intent_id!==p.intent_id||!UUID.test(r.dispatch_id||'')||!states.has(r.transport_state))throw fail('GRAPH_DELIVERY_READBACK');
  let applied=false;
  try{
   const receipt=await applyReceipt({brand:p.brand,intent_id:p.intent_id,entry_id:r.entry_id,expected_version:p.expected_entry_version},{dispatch_id:r.dispatch_id,transport_state:r.transport_state});
   applied=receipt?.contract==='journey_graph_store_v1'&&receipt.brand===p.brand&&receipt.entry_id===r.entry_id&&receipt.authorizes_send===false&&receipt.intent_id===p.intent_id&&receipt.dispatch_id===r.dispatch_id&&receipt.transport_state===r.transport_state;
  }catch{} // Durable dispatch remains authoritative; never repeat transport.
  return {brand:p.brand,intent_id:p.intent_id,state:r.transport_state,dispatch_id:r.dispatch_id,receipt_applied:applied};
 }
 return Object.freeze({reconcile,async deliver(input){
  const p=request(input),grant=await claim(p);
  const {validateClaim}=require('./journey-graph-cart.cjs');validateClaim(grant,{brand:p.brand,intent_id:p.intent_id});
  if(!grant.should_send)return grant.dispatch_id?reconcile(p):{brand:p.brand,intent_id:p.intent_id,state:'blocked',reason:grant.reason,dispatch_id:null,receipt_applied:false,transport_started:false};
  const at=clock(),expiry=Date.parse(grant.context.graph_expires_at);
  if(!Number.isFinite(at)||!Number.isFinite(expiry)||at>=expiry){
   // The original reservation stays closed. There was no HTTP result to invent.
   return {brand:p.brand,intent_id:p.intent_id,state:'reserved_expired',dispatch_id:grant.dispatch_id,receipt_applied:false,transport_started:false};
  }
  let outcome='outcome_unknown';
  try{const response=await transport(grant.payload);if(Buffer.byteLength(JSON.stringify(response)??'')<=65536)outcome=classify(response);}catch{}
  try{await finish({dispatch_id:grant.dispatch_id,claim_token:grant.claim_token,outcome,context:grant.context});}catch{}
  try{return {...await reconcile(p),transport_started:true};}
  catch{return {brand:p.brand,intent_id:p.intent_id,state:'unconfirmed',dispatch_id:grant.dispatch_id,receipt_applied:false,transport_started:true};}
 }});
}
module.exports={ENABLED:false,classify,createDelivery};
