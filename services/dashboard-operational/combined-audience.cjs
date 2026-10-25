'use strict';
const {createHash}=require('node:crypto');
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain=value=>value&&Object.getPrototypeOf(value)===Object.prototype;
const exact=(value,keys)=>plain(value)&&Object.keys(value).sort().join()===keys.split(',').sort().join();
const integer=value=>Number.isSafeInteger(value)&&value>0&&value<=2147483647;
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function date(value){if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail('COMBINED_INPUT_INVALID');return Date.parse(value);}
function normalize(input,now=Date.now()){
 if(!exact(input,'schema,brand,channel,rule')||input.schema!=='combined-audience-v2'||!['fish','aristo'].includes(input.brand)||input.channel!=='email'||Buffer.byteLength(JSON.stringify(input))>16384)fail('COMBINED_INPUT_INVALID');
 let nodes=0;
 function visit(node,depth=1,allowExclude=true){
  if(++nodes>32||depth>4||!plain(node))fail('COMBINED_LIMIT_EXCEEDED');
  if(['and','or'].includes(node.op)){
   if(!exact(node,'op,rules')||!Array.isArray(node.rules)||node.rules.length<2||node.rules.length>16)fail('COMBINED_INPUT_INVALID');
   const rules=node.rules.map(x=>visit(x,depth+1,allowExclude)).sort((a,b)=>digest(a).localeCompare(digest(b)));
   return {op:node.op,rules};
  }
  if(node.op==='exclude'){
   if(!allowExclude||!exact(node,'op,base,without'))fail('COMBINED_INPUT_INVALID');
   return {op:'exclude',base:visit(node.base,depth+1),without:visit(node.without,depth+1,false)};
  }
  if(node.kind==='list'&&exact(node,'kind,listId')&&integer(node.listId))return {kind:'list',listId:node.listId};
  if(node.kind==='purchase'){
   if(!plain(node.rule)||!['bought_recently','bought_product'].includes(node.rule.kind)||!Number.isSafeInteger(node.rule.days)||node.rule.days<1||node.rule.days>365||!exact(node,'kind,rule'))fail('COMBINED_INPUT_INVALID');
   if(node.rule.kind==='bought_recently'&&exact(node.rule,'kind,days'))return {kind:'purchase',rule:{kind:'bought_recently',days:node.rule.days}};
   if(node.rule.kind==='bought_product'&&exact(node.rule,'kind,days,productId')&&/^gid:\/\/shopify\/Product\/[1-9][0-9]{0,29}$/.test(node.rule.productId||''))return {kind:'purchase',rule:{kind:'bought_product',days:node.rule.days,productId:node.rule.productId}};
   fail('COMBINED_INPUT_INVALID');
  }
  if(node.kind==='behavior'&&exact(node,'kind,event,campaignId,campaignUuid,from,to')&&['open','click'].includes(node.event)&&integer(node.campaignId)&&uuid(node.campaignUuid)){
   const from=date(node.from),to=date(node.to);if(from>=to||to>now||to-from>90*86400000)fail('COMBINED_INPUT_INVALID');
   return {kind:'behavior',event:node.event,campaignId:node.campaignId,campaignUuid:node.campaignUuid.toLowerCase(),from:node.from,to:node.to};
  }
  fail('COMBINED_INPUT_INVALID');
 }
 return {schema:input.schema,brand:input.brand,channel:'email',rule:visit(input.rule)};
}
const subscriberId=value=>typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
function create({authorize,beginSnapshot,readSet,sourceRevision,now=Date.now,maxMembers=500000}){
 if(typeof authorize!=='function'||typeof beginSnapshot!=='function'||typeof readSet!=='function'||!/^[a-f0-9]{40}$/.test(sourceRevision||'')||!Number.isSafeInteger(maxMembers)||maxMembers<1||maxMembers>500000)fail('COMBINED_CONFIGURATION_INVALID',503);
 const authority=(context,brand)=>{const value=authorize(context,brand);if(!value||typeof value.userId!=='string'||!value.userId||typeof value.revision!=='string'||!value.revision)fail('COMBINED_ACCESS_DENIED',403);return JSON.stringify({userId:value.userId,revision:value.revision});};
 async function evaluate(context,definition){
  const normalized=normalize(definition,now()),before=authority(context,normalized.brand),checkedAt=new Date(now()).toISOString(),definitionHash=digest(normalized);
  const guard=()=>{if(authority(context,normalized.brand)!==before)fail('COMBINED_AUTHORITY_CHANGED',403);};
  const result=await beginSnapshot(async snapshot=>{
   if(!snapshot||snapshot.consistent!==true||snapshot.brand!==normalized.brand||typeof snapshot.id!=='string'||!snapshot.id)fail('COMBINED_SNAPSHOT_REQUIRED',503);
   const leaves=[];const read=async leaf=>{
    const leafHash=digest(leaf),prior=leaves.find(x=>x.hash===leafHash);if(prior)return prior.value;
    guard();let source;try{source=await readSet(context,leaf,{brand:normalized.brand,snapshot,leafHash});}catch{guard();fail('COMBINED_SOURCE_UNAVAILABLE',503);}guard();
    if(!source||source.brand!==normalized.brand||source.snapshotId!==snapshot.id||source.leafHash!==leafHash||typeof source.confirmed!=='boolean')fail('COMBINED_SOURCE_SCOPE_INVALID',503);
    if(!source.confirmed){if(source.count!==null||source.ids!==null)fail('COMBINED_SOURCE_INVALID',503);leaves.push({hash:leafHash,value:null});return null;}
    if(source.positiveOnly!==true||source.eligibleOnly!==true||!Number.isSafeInteger(source.count)||source.count<0||source.count>maxMembers||!Array.isArray(source.ids)||source.ids.length!==source.count)fail('COMBINED_SOURCE_INVALID',503);
    let previous=0n;for(const id of source.ids){if(!subscriberId(id)||BigInt(id)<=previous)fail('COMBINED_SOURCE_INVALID',503);previous=BigInt(id);}
    const value=new Set(source.ids);leaves.push({hash:leafHash,value});return value;
   };
   async function visit(node){
    if(!node.op)return read(node);
    if(node.op==='exclude'){const base=await visit(node.base),without=await visit(node.without);if(!base||!without)return null;return new Set([...base].filter(id=>!without.has(id)));}
    const sets=[];for(const rule of node.rules)sets.push(await visit(rule));if(sets.some(x=>x===null))return null;
    const out=new Set(sets[0]);for(const next of sets.slice(1)){if(node.op==='and'){for(const id of out)if(!next.has(id))out.delete(id);}else for(const id of next)out.add(id);if(out.size>maxMembers)fail('COMBINED_LIMIT_EXCEEDED',503);}return out;
   }
   const matched=await visit(normalized.rule);guard();return matched===null?null:[...matched].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
  });guard();
  return {confirmed:result!==null,count:result===null?null:result.length,subscriberIds:result,brand:normalized.brand,definitionHash,sourceRevision,checkedAt,received:null,notOpened:null,notClicked:null};
 }
 return Object.freeze({countSaved:async(context,definition)=>{const {subscriberIds,...receipt}=await evaluate(context,definition);return receipt;},resolveSaved:evaluate,runtimeWired:false});
}
module.exports={normalize,digest,create};
