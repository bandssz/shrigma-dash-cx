'use strict';
// Temporary pure observer. No transport, production IO, activation or retained body.
const {createHash}=require('node:crypto');
const P=require('./maintenance-tx-popup-protocol.cjs');
const {digest}=require('./maintenance-cart-patch.cjs');
const CONTRACT='maintenance_tx_input_probe_v1',TARGET='ecK2wke9fKnO3mfy';
const NORMALIZER_SHA256=createHash('sha256').update(P.source()).digest('hex');
const PATHS=[...P.FIELDS,...P.ITEM_FIELDS.map(k=>'items[].'+k)];
const TYPES=['string','number','boolean','null','object','array'];
const REASONS={MAINTENANCE_TX_BODY:'body',MAINTENANCE_TX_SCOPE:'scope',MAINTENANCE_TX_CONTROL:'control',MAINTENANCE_TX_ITEMS:'items',MAINTENANCE_TX_FIELD:'field',MAINTENANCE_TX_IDENTITY:'identity',MAINTENANCE_TX_HEADER:'header'};
const BRANDS={fish:{derive:'Derivar Rastreio — Fishermans',email:'Verifica se cliente existe1',wa:'→ WhatsApp Fish (WA · Transacional EfSf4rTJb3krbBV2)',pg:'R4 reserva exclusiva Fish'},aristo:{derive:'Derivar Rastreio — Aristocrata',email:'Verifica se cliente existe',wa:'→ WhatsApp Aristo (transacional em sombra)',pg:'R4 reserva exclusiva Aristo'}};
function observeJSON(brand,text){
 const result={contract:CONTRACT,normalizer_sha256:NORMALIZER_SHA256,brand,event_type:'other',verdict:'rejected',reason:'unconfirmed',unknown_fields:false,fields:[]};
 if(!Object.prototype.hasOwnProperty.call(MAP,brand))throw Error('TX_PROBE_BRAND');
 const shape=(b,stage)=>{
  if(!b||typeof b!=='object'||Array.isArray(b))return;
  const emitted=new Set(),add=(path,v)=>{const type=v===null?'null':Array.isArray(v)?'array':typeof v;if(!TYPES.includes(type))return;const key=path+':'+type;if(!emitted.has(key)){emitted.add(key);result.fields.push({stage,path,type});}};
  for(const k of FIELDS)if(Object.prototype.hasOwnProperty.call(b,k))add(k,b[k]);
  if(Array.isArray(b.items)&&b.items.length<=200)for(const item of b.items)if(item&&typeof item==='object'&&!Array.isArray(item))for(const k of ITEM_FIELDS)if(Object.prototype.hasOwnProperty.call(item,k))add('items[].'+k,item[k]);
 };
 try{
  if(typeof text!=='string'||text.length>131072){result.reason='body';return result;}
  let b;try{b=JSON.parse(text);}catch{result.reason='json';return result;}
  if(b&&typeof b==='object'&&!Array.isArray(b)){
   if(typeof b.event_type==='string'&&Object.prototype.hasOwnProperty.call(MAP[brand],b.event_type))result.event_type=b.event_type;
   result.unknown_fields=Object.keys(b).some(k=>!FIELDS.includes(k));shape(b,'input');
  }
  const normalized=normalizeJSON(brand,text);shape(normalized,'normalized');result.verdict='accepted';result.reason='ok';
 }catch(e){result.reason=Object.prototype.hasOwnProperty.call(REASONS,e?.message)?REASONS[e.message]:'unconfirmed';}
 return result;
}
function observe(brand,body){
 // JSON is also the cross-realm boundary used by the normalizer. Error text never escapes.
 try{return observeJSON(brand,JSON.stringify(body));}catch{return observeJSON(brand,undefined);}
}
function recordInput(brand,v){
 const fallback={contract:CONTRACT,normalizer_sha256:NORMALIZER_SHA256,brand,event_type:'other',verdict:'rejected',reason:'unconfirmed',unknown_fields:false,fields:[]};
 // Also guard the SQL boundary: continueRegularOutput may contain a node error or
 // original input. Never serialize that object, arbitrary keys, or error messages.
 try{
  if(!v||Object.keys(v).sort().join(',')!=='brand,contract,event_type,fields,normalizer_sha256,reason,unknown_fields,verdict'||v.contract!==CONTRACT||v.normalizer_sha256!==NORMALIZER_SHA256||v.brand!==brand||!['recebido','confirmado','preparando','em_rota','entregue','cancelado','other'].includes(v.event_type)||!['accepted','rejected'].includes(v.verdict)||!['ok','body','scope','control','items','field','identity','header','json','unconfirmed'].includes(v.reason)||typeof v.unknown_fields!=='boolean'||!Array.isArray(v.fields)||v.fields.length>256)return fallback;
  const fields=[];
  for(const f of v.fields){if(!f||Object.keys(f).sort().join(',')!=='path,stage,type'||!['input','normalized'].includes(f.stage)||!PATHS.includes(f.path)||!TYPES.includes(f.type))return fallback;fields.push({stage:f.stage,path:f.path,type:f.type});}
  return {...fallback,event_type:v.event_type,verdict:v.verdict,reason:v.reason,unknown_fields:v.unknown_fields,fields};
 }catch{return fallback;}
}
// Bind the same free variables used by the embeddable functions; no external
// require, crypto, URL or structuredClone is required by the n8n Code node.
const {MAP,FIELDS,ITEM_FIELDS,normalizeJSON}=P;
function code(brand){return P.source()+`\nconst CONTRACT=${JSON.stringify(CONTRACT)},NORMALIZER_SHA256=${JSON.stringify(NORMALIZER_SHA256)},TYPES=${JSON.stringify(TYPES)},REASONS=${JSON.stringify(REASONS)};\n${observeJSON}\n${observe}\nreturn {json:observe(${JSON.stringify(brand)},$json.body)};`;}
function replacement(brand){return `={{ (()=>{const CONTRACT=${JSON.stringify(CONTRACT)},NORMALIZER_SHA256=${JSON.stringify(NORMALIZER_SHA256)},PATHS=${JSON.stringify(PATHS)},TYPES=${JSON.stringify(TYPES)};${recordInput};return [JSON.stringify(recordInput(${JSON.stringify(brand)},$json))];})() }}`;}
const clone=v=>JSON.parse(JSON.stringify(v));
const edge=node=>({node,type:'main',index:0});
const fail=()=>{throw Error('TX_PROBE_SOURCE_DRIFT');};
const projection=w=>Object.fromEntries(['name','nodes','connections','settings'].map(k=>[k,clone(w[k])]));
function buildObservation(workflow,guard){
 const w=workflow,s=w?.settings;
 if(w?.id!==TARGET||w.active!==true||!guard?.version||w.versionId!==guard.version||w.activeVersionId!==guard.version||guard.workflowHash!==digest(w)||guard.connectionsHash!==digest(w.connections))fail();
 if(s?.executionOrder!=='v1'||s.saveDataSuccessExecution!=='none'||s.saveDataErrorExecution!=='none'||s.saveManualExecutions!==false||s.saveExecutionProgress===true)fail();
 if(w.activeVersion&&(w.activeVersion.versionId!==w.versionId||digest(w.activeVersion.nodes)!==digest(w.nodes)||digest(w.activeVersion.connections)!==digest(w.connections)))fail();
 if(!Array.isArray(w.nodes)||w.nodes.some(n=>n.name.startsWith('TX Input Probe ')||!Array.isArray(n.position)||n.position.length!==2||!n.position.every(Number.isFinite)))fail();
 const patch=clone(w),restore=projection(w),maxY=Math.max(...w.nodes.map(n=>n.position[1]));
 for(const [index,[brand,b]] of Object.entries(BRANDS).entries()){
  const one=(name,type)=>{const all=w.nodes.filter(n=>n.name===name&&n.type==='n8n-nodes-base.'+type);if(all.length!==1)fail();return all[0];};
  one(b.derive,'code');one(b.email,'httpRequest');one(b.wa,'httpRequest');const pg=one(b.pg,'postgres');
  if(!pg.credentials?.postgres||digest(w.connections[b.derive])!==digest({main:[[edge(b.email),edge(b.wa)]]}))fail();
  const name='TX Input Probe '+brand,sqlName=name+' count',y=maxY+500+index*500;
  patch.nodes.push({id:'tx-input-probe-'+brand,name,type:'n8n-nodes-base.code',typeVersion:2,position:[0,y],parameters:{mode:'runOnceForEachItem',jsCode:code(brand)},retryOnFail:false,onError:'continueRegularOutput'});
  patch.nodes.push({id:'tx-input-probe-'+brand+'-sql',name:sqlName,type:'n8n-nodes-base.postgres',typeVersion:pg.typeVersion,position:[260,y],parameters:{operation:'executeQuery',query:'SELECT crm_tx_input_probe.record_v1($1::jsonb) AS observed;',options:{queryBatching:'independently',queryReplacement:replacement(brand)}},credentials:clone(pg.credentials),retryOnFail:false,onError:'continueRegularOutput'});
  patch.connections[b.derive].main[0].push(edge(name));patch.connections[name]={main:[[edge(sqlName)]]};
 }
 // Existing nodes (including immediate webhook ACK) are byte-preserved. v1 runs
 // whole topmost branches first; a failed/stuck original branch can prevent
 // observation. Zero observations is never proof of compatible input.
 return {contract:CONTRACT,normalizer_sha256:NORMALIZER_SHA256,patch,restore,review:{source_version:w.versionId,source_hash:digest(w),candidate_hash:digest(projection(patch)),restore_hash:digest(restore),applied:false,transport_added:false,original_nodes_unchanged:true,observation_may_be_skipped:true}};
}
function restoreObservation(current,guard,prepared){
 if(!prepared||prepared.contract!==CONTRACT||current?.id!==TARGET||current.active!==true||current.versionId!==guard?.version||current.activeVersionId!==guard.version||digest(current)!==guard.workflowHash||digest(current.connections)!==guard.connectionsHash||digest(projection(current))!==prepared.review.candidate_hash||digest(prepared.restore)!==prepared.review.restore_hash)fail();
 return clone(prepared.restore);
}
module.exports={CONTRACT,TARGET,NORMALIZER_SHA256,PATHS,TYPES,observeJSON,observe,recordInput,code,digest,buildObservation,restoreObservation};
