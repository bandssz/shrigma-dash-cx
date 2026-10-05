'use strict';
// Private writer identity proof, dormant until explicitly invoked by the BFF.
// Importing it performs no HTTP request, environment read or runtime registration.
// It does not issue a key, grant an area, or attest future media permissions.
const IDENTITY_URL='https://comunicacao-crm-panel-read.tazdb8.easypanel.host/read?action=identity&painel=growth';
const {performance}=require('node:perf_hooks');
const MAX_RESPONSE_BYTES=8192,TIMEOUT_MS=5000;
const CAPS=Object.freeze(['read_content','draft','validate','submit']);
const typed=Object.getPrototypeOf(Uint8Array.prototype),byteLength=Object.getOwnPropertyDescriptor(typed,'byteLength').get,byteOffset=Object.getOwnPropertyDescriptor(typed,'byteOffset').get,buffer=Object.getOwnPropertyDescriptor(typed,'buffer').get;
class CampaignWriterAttestationError extends Error{
 constructor(){super('CAMPAIGN_WRITER_ATTESTATION_REFUSED');this.name='CampaignWriterAttestationError';this.code='CAMPAIGN_WRITER_ATTESTATION_REFUSED';}
}
const refuse=()=>{throw new CampaignWriterAttestationError();};
const observe=value=>{try{Promise.resolve(value).catch(()=>{});}catch{}};
function synchronous(value){
 if(value!==null&&(typeof value==='object'||typeof value==='function')){
  let then;try{then=value.then;}catch{observe(value);refuse();}
  // Observe even an invalid then getter that returned a rejected promise.
  if(then!==undefined&&then!==null)observe(then);
  if(typeof then==='function'){observe(value);refuse();}
 }
 return value;
}
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
function snapshot(value,keys){
 if(!plain(value)||Reflect.ownKeys(value).length!==keys.length)refuse();
 const result={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))refuse();result[key]=d.value;}return result;
}
function arrayEquals(value,expected){
 return Array.isArray(value)&&Reflect.ownKeys(value).length===expected.length+1&&value.length===expected.length&&expected.every((item,index)=>value[index]===item);
}
function ownerValid(owner){
 if(typeof owner!=='string'||owner.length>254||owner!==owner.toLowerCase()||!/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@([a-z0-9-]+\.)+[a-z]{2,63}$/.test(owner))return false;
 const [local,domain]=owner.split('@');return local.length<=64&&/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain);
}
function verifyIdentity(value,expected,master){
 const identity=snapshot(value,['schema','role','panel','owner','allowedPanels','permissions']);
 if(identity.schema!=='shrigma_access_identity_v1'||identity.role!==(master?'master':'manager')||identity.panel!==(master?'todos':'growth')||identity.owner!==expected.owner||!arrayEquals(identity.allowedPanels,master?['cx','growth','organico','influs']:['growth']))refuse();
 const permissions=snapshot(identity.permissions,['growth','influs']);
 if(permissions.influs!==null){
  if(!master)refuse();
  // The actual master identity may also expose Influs operator grants. They
  // must bind the same principal/owner; none authorizes a Growth mutation.
  const other=snapshot(permissions.influs,['who','label','caps']);
  if(other.who!=='panel:'+expected.principalId||other.label!==expected.owner||!Array.isArray(other.caps)||other.caps.length>64||Reflect.ownKeys(other.caps).length!==other.caps.length+1||new Set(other.caps).size!==other.caps.length||other.caps.some(c=>typeof c!=='string'||!/^[a-z_]{1,40}$/.test(c)))refuse();
 }
 const grant=snapshot(permissions.growth,['who','label','caps']);
 if(grant.who!=='panel:'+expected.principalId||grant.label!==expected.owner||!arrayEquals(grant.caps,CAPS))refuse();
 return Object.freeze({owner:expected.owner,principalId:expected.principalId,caps:Object.freeze([...CAPS])});
}

// input is EXACT {bearer,owner,principalId}; owner is the already normalized
// corporate email from the identity store. Its domain policy belongs to that
// store/issuer. This proof cannot add a domain, grant, area or backend slot.
async function verifyCredential(input,options,master){
 let controller,timer,response,reader,cancelled=false;
 const cancel=()=>{
  if(cancelled)return;
  try{
   const target=reader||response?.body;if(!target||typeof target.cancel!=='function')return;
   cancelled=true;observe(target.cancel());
  }catch{cancelled=true;}
 };
 try{
  const expected=snapshot(input,['bearer','owner','principalId']);
  if(typeof expected.bearer!=='string'||!(master?/^[a-z0-9-]{8,128}$/:/^[a-f0-9]{64}$/).test(expected.bearer)||!ownerValid(expected.owner)||typeof expected.principalId!=='string'||!(master?/^[a-z0-9-]{8,128}$/:/^dcrmw-[a-f0-9]{32}$/).test(expected.principalId))refuse();
  const supplied=snapshot(options,Object.hasOwn(options,'fetchImpl')?['fetchImpl']:[]),fetchImpl=Object.hasOwn(supplied,'fetchImpl')?supplied.fetchImpl:globalThis.fetch;
  if(typeof fetchImpl!=='function')refuse();
  const pinned=new URL(IDENTITY_URL);if(pinned.protocol!=='https:'||pinned.username||pinned.password||pinned.port||pinned.hash||pinned.href!==IDENTITY_URL)refuse();
  controller=new AbortController();
  const started=performance.now(),expired=()=>controller.signal.aborted||performance.now()-started>=TIMEOUT_MS;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();cancel();reject(new CampaignWriterAttestationError());},TIMEOUT_MS);});
  const work=(async()=>{
   response=await fetchImpl(IDENTITY_URL,{method:'GET',redirect:'manual',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:controller.signal,
    headers:Object.freeze({Accept:'application/json','Accept-Encoding':'identity',Authorization:'Bearer '+expected.bearer})});
   if(expired()){cancel();refuse();}
   if(!response||response.status!==200||response.ok!==true||response.redirected!==false||response.url!==IDENTITY_URL||!['basic','cors','default'].includes(response.type)||!response.headers||typeof response.headers.get!=='function')refuse();
   const type=synchronous(response.headers.get('content-type')),length=synchronous(response.headers.get('content-length')),encoding=synchronous(response.headers.get('content-encoding'));
   if(typeof type!=='string'||type.length>128||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(type)||encoding!==null&&(typeof encoding!=='string'||!/^identity$/i.test(encoding))||length!==null&&(typeof length!=='string'||!/^\d{1,5}$/.test(length)||Number(length)>MAX_RESPONSE_BYTES))refuse();
   if(!response.body||typeof response.body.getReader!=='function')refuse();reader=synchronous(response.body.getReader());
   if(!reader||typeof reader.read!=='function'||typeof reader.cancel!=='function')refuse();
   const chunks=[];let bytes=0,reads=0;
   while(true){
    // An injected/nonprogressing stream cannot starve the deadline through an
    // infinite chain of immediately resolved, zero-byte reads.
    if(++reads>MAX_RESPONSE_BYTES+1||expired())refuse();
    const part=await reader.read();if(expired())refuse();
    if(!part||typeof part.done!=='boolean')refuse();if(part.done){if(part.value!==undefined)refuse();break;}
    if(!(part.value instanceof Uint8Array))refuse();
    const count=byteLength.call(part.value);bytes+=count;if(bytes>MAX_RESPONSE_BYTES)refuse();
    // Read intrinsic bounds and copy a fresh native view. Overridden byteLength
    // or valueOf on an injected chunk cannot bypass the bound or change data.
    chunks.push(Buffer.from(new Uint8Array(buffer.call(part.value),byteOffset.call(part.value),count)));
   }
   if(length!==null&&Number(length)!==bytes)refuse();
   const body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
   const identity=JSON.parse(body),proof=verifyIdentity(identity,expected,master);if(expired())refuse();return proof;
  })();
  const proof=await Promise.race([work,deadline]);if(expired())refuse();return proof;
 }catch{try{controller?.abort();}catch{}throw new CampaignWriterAttestationError();}
 finally{clearTimeout(timer);cancel();try{observe(reader?.releaseLock?.());}catch{}}
}
// Separate entry points preserve the manager-only issuer contract. Neither
// endpoint issues a key or derives write caps from the word "master".
const verifyCampaignWriterCredential=(input,options={})=>verifyCredential(input,options,false);
const verifyMasterCampaignWriterCredential=(input,options={})=>verifyCredential(input,options,true);
module.exports={verifyCampaignWriterCredential,verifyMasterCampaignWriterCredential,CampaignWriterAttestationError,IDENTITY_URL,MAX_RESPONSE_BYTES,TIMEOUT_MS};
