'use strict';
// Direct, bounded backend identity check shared by the private operator CLI
// and the HTTP gateway. The gateway must still pin its sole upstream to
// crm-panel-read before accepting the dedicated CRM credential slot.
const {FIXED_DESTINATIONS,SANDBOX_HOST}=require('./proxy.cjs');

const MAX_RESPONSE_BYTES=8192,TIMEOUT_MS=5000;
const SLOTS=Object.freeze({
 'crm-panel-read':'growth',
 'growth-read':'growth',
 'growth-campaign-read':'growth',
 'growth-audience-read':'growth',
 'growth-ab-read':'growth',
 'growth-flows-read':'growth',
 'organico-read':'organico',
 'influs-read':'influs',
 'tts-read':'influs'
});
const REVIEWED_BASE=Object.freeze({
 growth:'https://comunicacao-crm-panel-read.tazdb8.easypanel.host/read',
 organico:'https://n8n-n8n.tazdb8.easypanel.host/webhook/cx-dash-api-306742284c6fac1d',
 influs:'https://n8n-n8n.tazdb8.easypanel.host/webhook/cx-dash-api-306742284c6fac1d'
});
const READ_CAPS=Object.freeze({growth:new Set(['read_content','list_history','submission']),influs:new Set(['read_creators'])});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const refuse=()=>{throw Error('CREDENTIAL_VERIFICATION_REFUSED');};

function directIdentityUrl(area){
 let base,query;
 if(area==='growth'){
  base=FIXED_DESTINATIONS['crm-read'];query='action=identity&painel=growth';
 }else if(area==='organico'||area==='influs'){
  base=FIXED_DESTINATIONS.cx;query=`access=1&painel=${area}`;
 }else refuse();
 if(base!==REVIEWED_BASE[area])refuse();
 const url=new URL(base);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port)refuse();
 if(area==='growth'&&url.hostname!=='comunicacao-crm-panel-read.tazdb8.easypanel.host')refuse();
 if(area!=='growth'&&url.hostname!=='n8n-n8n.tazdb8.easypanel.host')refuse();
 url.search=query;
 return url.toString();
}

function validateInput(input){
 if(!plain(input)||Object.keys(input).sort().join(',')!=='bearer,expectedOwner,slot')refuse();
 if(typeof input.slot!=='string'||!Object.hasOwn(SLOTS,input.slot))refuse();
 const area=SLOTS[input.slot];
 if(typeof input.expectedOwner!=='string'||input.expectedOwner.length<1||Buffer.byteLength(input.expectedOwner,'utf8')>254||input.expectedOwner.trim()!==input.expectedOwner||/[\x00-\x1f\x7f]/.test(input.expectedOwner))refuse();
 if(typeof input.bearer!=='string'||!(/^[a-z0-9-]{8,128}$/).test(input.bearer))refuse();
 return area;
}

async function boundedJson(response){
 if(response.status!==200||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')||''))refuse();
 const length=response.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_RESPONSE_BYTES))refuse();
 const reader=response.body?.getReader();if(!reader)refuse();
 const chunks=[];let bytes=0;
 try{
  while(true){
   const {done,value}=await reader.read();if(done)break;
   bytes+=value.byteLength;if(bytes>MAX_RESPONSE_BYTES)refuse();
   chunks.push(Buffer.from(value));
  }
 }finally{try{await reader.cancel();}catch{}}
 let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{refuse();}
 if(!plain(result))refuse();return result;
}

function validatePermissions(identity,area,slot,expectedOwner){
 const permissions=identity.permissions;
 // Only the reviewed crm-panel-read identity shape can provision the dedicated
 // slot. Other legacy slots retain the CLI's explicitly partial inspection.
 if(slot==='crm-panel-read'){
  if(Object.keys(identity).sort().join(',')!=='allowedPanels,owner,panel,permissions,role,schema'||
   !plain(permissions)||Object.keys(permissions).sort().join(',')!=='growth,influs'||permissions.influs!==null)refuse();
  const grant=permissions.growth;
  if(!plain(grant)||Object.keys(grant).sort().join(',')!=='caps,label,who'||
   grant.label!==expectedOwner||typeof grant.who!=='string'||!/^panel:[A-Za-z0-9_.:-]{1,122}$/.test(grant.who))refuse();
 }
 if(area==='growth'&&!plain(permissions))refuse();
 if(permissions===undefined)return 'unreported';
 if(!plain(permissions)||Object.keys(permissions).some(key=>!['growth','influs'].includes(key)))refuse();
 const other=area==='growth'?'influs':'growth';
 if(permissions[other]!=null)refuse();
 if(area==='organico'){
  if(permissions.influs!=null)refuse();
  return 'unreported';
 }
 const grant=permissions[area];if(grant==null)return 'absent';
 if(!plain(grant)||!Array.isArray(grant.caps)||grant.caps.length>32||new Set(grant.caps).size!==grant.caps.length)refuse();
 if(slot==='crm-panel-read'&&grant.caps.length===0)refuse();
 if(grant.caps.some(cap=>typeof cap!=='string'||!READ_CAPS[area].has(cap)))refuse();
 return 'read-caps-only';
}

async function verifyCredential(input,{fetchImpl=globalThis.fetch}={}){
 const area=validateInput(input);
 if(typeof fetchImpl!=='function')refuse();
 const url=directIdentityUrl(area);
 let response;
 try{
  response=await fetchImpl(url,{method:'GET',redirect:'manual',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(TIMEOUT_MS),headers:{Accept:'application/json',Authorization:'Bearer '+input.bearer}});
 }catch{refuse();}
 const identity=await boundedJson(response);
 if(identity.schema!=='shrigma_access_identity_v1'||identity.role!=='manager'||identity.panel!==area||identity.owner!==input.expectedOwner||identity.preview===true||identity.synthetic===true||!Array.isArray(identity.allowedPanels)||identity.allowedPanels.length!==1||identity.allowedPanels[0]!==area)refuse();
 const grants=validatePermissions(identity,area,input.slot,input.expectedOwner);
 // A single identity response does not certify every legacy backend path.
 return Object.freeze({ok:true,slot:input.slot,area,identityVerified:true,readOnlyProven:false,capabilityEvidence:grants,status:'partial'});
}

async function verifySandboxCredential(input,{fetchImpl=globalThis.fetch}={}){
 if(!plain(input)||Object.keys(input).sort().join(',')!=='bearer,expectedOwner,slot'||!['growth-read','growth-audience-read','growth-audience'].includes(input.slot)||typeof input.expectedOwner!=='string'||!/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@synthetic\.invalid$/.test(input.expectedOwner)||typeof input.bearer!=='string'||!/^[A-Za-z0-9_.:-]{8,256}$/.test(input.bearer)||typeof fetchImpl!=='function')refuse();
 let response;
 try{response=await fetchImpl('https://'+SANDBOX_HOST+'/identity',{method:'GET',redirect:'manual',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(TIMEOUT_MS),headers:{Accept:'application/json',Authorization:'Bearer '+input.bearer}});}catch{refuse();}
 const identity=await boundedJson(response);
 const expectedCaps=input.slot==='growth-audience'?['draft','read_content']:['read_content'];
 if(Object.keys(identity).sort().join(',')!=='allowedPanels,capabilities,owner,panel,role,schema,synthetic'||identity.schema!=='crm-audience-sandbox-identity-v1'||identity.role!=='manager'||identity.panel!=='growth'||identity.owner!==input.expectedOwner||identity.synthetic!==true||!Array.isArray(identity.allowedPanels)||identity.allowedPanels.length!==1||identity.allowedPanels[0]!=='growth'||!Array.isArray(identity.capabilities)||identity.capabilities.length!==expectedCaps.length||identity.capabilities.some((cap,index)=>cap!==expectedCaps[index]))refuse();
 return Object.freeze({ok:true,synthetic:true,ownerVerified:true});
}

module.exports={SLOTS,MAX_RESPONSE_BYTES,TIMEOUT_MS,directIdentityUrl,validateInput,verifyCredential,verifySandboxCredential};
