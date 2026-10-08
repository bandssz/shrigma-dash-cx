'use strict';
// Fixed original published READ. No n8n administration, actor grant, draft or write.
const VERSION='crm-published-journey-read-v1',SCOPE='master-brand-scoped';
const DESTINATION='https://n8n.shrigma.com.br/webhook/crm-template-api-242c0db6ddb8';
const WORKFLOW_ID='y6qJRcWcSfEZzwgZ',WORKFLOW_VERSION='362b1a93-54a3-44be-8933-dffe57b58aa6';
const MAX_BYTES=1024*1024,DEADLINE_MS=18000;
const fail=(code,status=502)=>{throw Object.assign(Error(code),{code,status});};
const plain=x=>x&&Object.getPrototypeOf(x)===Object.prototype;
const text=(x,max=500)=>typeof x==='string'&&x.length>0&&x.length<=max&&!/[\x00-\x1f\x7f]/.test(x);
const list=(x,max)=>Array.isArray(x)&&x.length<=max&&Array.from({length:x.length},(_,i)=>Object.hasOwn(x,i)).every(Boolean);
function decision(method,query){
 if(method!=='GET')fail('PUBLISHED_JOURNEY_METHOD_DENIED',405);
 if(!(query instanceof URLSearchParams)||[...query.keys()].sort().join(',')!=='acao,marca'||query.get('acao')!=='fluxos_listar'||!['fish','aristo'].includes(query.get('marca')))fail('PUBLISHED_JOURNEY_QUERY_DENIED',400);
 return {brand:query.get('marca')};
}
function select(x,fields){return Object.fromEntries(fields.filter(k=>Object.hasOwn(x,k)).map(k=>[k,x[k]]));}
function project(body,brand,secrets=[]){
 if(!['fish','aristo'].includes(brand)||!plain(body)||!list(body.flows,200)||typeof body.checked_at!=='string'||body.checked_at.length>64||!Number.isFinite(Date.parse(body.checked_at)))fail('PUBLISHED_JOURNEY_RESPONSE_INVALID');
 const seen=new Set(),flows=[];
 for(const f of body.flows){
  if(!plain(f)||f.brand!==brand||!text(f.key,160)||!f.key.startsWith(brand+':')||seen.has(f.key)||!text(f.name)||!text(f.trigger)||!Number.isSafeInteger(f.version)||f.version<1||typeof f.enabled!=='boolean'||typeof f.runtime_ready!=='boolean'||!Object.hasOwn(f,'published')||!Object.hasOwn(f,'published_version')||![null,'order','nps'].includes(f.journey_kind)||!list(f.available_steps,64))fail('PUBLISHED_JOURNEY_RESPONSE_INVALID');
  seen.add(f.key);const slots=new Map(),available_steps=[];
  for(const s of f.available_steps){
   if(!plain(s)||!text(s.key,160)||slots.has(s.key)||!text(s.name)||!['email','whatsapp'].includes(s.channel))fail('PUBLISHED_JOURNEY_BINDING_INVALID');
   for(const k of ['variant','entry_key','entry_label','wait_caption','flow'])if(Object.hasOwn(s,k)&&s[k]!==''&&!text(s[k],500))fail('PUBLISHED_JOURNEY_BINDING_INVALID');
   if(s.variant!==undefined&&s.variant!==''&&!['a','b'].includes(s.variant))fail('PUBLISHED_JOURNEY_BINDING_INVALID');
   if(s.source_template_id!==undefined&&s.source_template_id!==null&&!(text(s.source_template_id,160)||Number.isSafeInteger(s.source_template_id)&&s.source_template_id>0))fail('PUBLISHED_JOURNEY_BINDING_INVALID');
   const p=select(s,['key','name','channel','variant','entry_key','entry_label','wait_caption','flow','source_template_id']);slots.set(s.key,p);available_steps.push(p);
  }
  let published=null;
  if(f.published!==null||f.published_version!==null){
   if(!plain(f.published)||!Number.isSafeInteger(f.published_version)||f.published_version<1||f.published_version>f.version||!list(f.published.steps,64)||!f.published.steps.length)fail('PUBLISHED_JOURNEY_DEFINITION_INVALID');
   const stepSeen=new Set(),steps=f.published.steps.map(s=>{
    const slot=plain(s)?slots.get(s.key):null;
    if(!slot||stepSeen.has(s.key)||slot.channel!==s.channel||typeof s.enabled!=='boolean'||!Number.isFinite(s.wait_min)||s.wait_min<0||s.wait_min>525600||s.template_name!==undefined&&!text(s.template_name)||f.journey_kind==='order'&&(!text(slot.entry_key,160)||!text(slot.entry_label))||f.journey_kind==='nps'&&!['nps-d0','nps-d3'].includes(s.piece))fail('PUBLISHED_JOURNEY_DEFINITION_INVALID');
    stepSeen.add(s.key);return select(s,['key','channel','enabled','wait_min','template_name','piece']);
   });
   published={steps};
   if(Object.hasOwn(f.published,'layout')){
    const l=f.published.layout;if(!plain(l)||!plain(l.nodes)||Object.keys(l.nodes).length>300)fail('PUBLISHED_JOURNEY_LAYOUT_INVALID');
    const nodes=Object.create(null);for(const [id,p]of Object.entries(l.nodes)){if(!text(id,320)||['__proto__','constructor','prototype'].includes(id)||!plain(p)||![p.x,p.y].every(n=>Number.isFinite(n)&&Math.abs(n)<=10000))fail('PUBLISHED_JOURNEY_LAYOUT_INVALID');nodes[id]={x:p.x,y:p.y};}published.layout={nodes};
   }
  }
  flows.push({...select(f,['key','brand','name','trigger','version','published_version','enabled','runtime_ready','journey_kind']),available_steps,published});
 }
 const dto={flows,checked_at:body.checked_at},serialized=JSON.stringify(dto);
 if(Buffer.byteLength(serialized)>MAX_BYTES||secrets.some(s=>typeof s==='string'&&s.length>0&&serialized.includes(s)))fail('PUBLISHED_JOURNEY_RESPONSE_INVALID');
 return dto;
}
async function boundedBody(response){
 if(!response.body?.getReader)fail('PUBLISHED_JOURNEY_RESPONSE_INVALID');
 const reader=response.body.getReader(),chunks=[];let bytes=0;
 try{for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;if(bytes>MAX_BYTES){void reader.cancel().catch(()=>{});fail('PUBLISHED_JOURNEY_RESPONSE_LIMIT');}chunks.push(Buffer.from(r.value));}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
 catch(e){if(/^PUBLISHED_JOURNEY_[A-Z_]+$/.test(e.code||''))throw e;fail('PUBLISHED_JOURNEY_RESPONSE_INVALID');}
 finally{reader.releaseLock();}
}
function createReader({authorize,fetchImpl=fetch,deadlineMs=DEADLINE_MS}={}){
 if(typeof authorize!=='function'||typeof fetchImpl!=='function'||!Number.isInteger(deadlineMs)||deadlineMs<1||deadlineMs>DEADLINE_MS)fail('PUBLISHED_JOURNEY_CONFIG_INVALID',503);
 let pending=0;
 return Object.freeze({async read(ctx,query){
  const {brand}=decision(ctx.method,query),before=authorize(ctx,{brand});
  if(!before||typeof before.userId!=='string'||!text(before.binding,256)||typeof before.credential!=='string'||!/^[A-Za-z0-9._:-]{16,4096}$/.test(before.credential))fail('PUBLISHED_JOURNEY_AUTH_INVALID',403);
  if(pending>=4)fail('PUBLISHED_JOURNEY_BUSY',429);pending++;
  const controller=new AbortController();let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(Error('PUBLISHED_JOURNEY_DEADLINE'),{code:'PUBLISHED_JOURNEY_DEADLINE',status:504}));},deadlineMs);});
  try{
   const target=DESTINATION+'?'+new URLSearchParams({acao:'fluxos_listar',marca:brand});
   const response=await Promise.race([fetchImpl(target,{method:'GET',redirect:'error',cache:'no-store',signal:controller.signal,headers:{Accept:'application/json',Authorization:'Bearer '+before.credential}}),deadline]);
   if(response.status!==200)fail(response.status===401||response.status===403?'PUBLISHED_JOURNEY_ORIGINAL_READ_DENIED':'PUBLISHED_JOURNEY_UPSTREAM_UNAVAILABLE');
   if(response.url&&response.url!==target)fail('PUBLISHED_JOURNEY_REDIRECT_DENIED');
   const dto=project(await Promise.race([boundedBody(response),deadline]),brand,[before.credential]);
   const after=authorize(ctx,{brand});if(after?.userId!==before.userId||after?.binding!==before.binding||after?.credential!==before.credential)fail('PUBLISHED_JOURNEY_BINDING_CHANGED',403);
   return {status:200,body:dto};
  }catch(e){if(/^PUBLISHED_JOURNEY_[A-Z_]+$/.test(e.code||'')||e.status===401||e.status===403)throw e;fail('PUBLISHED_JOURNEY_UPSTREAM_UNAVAILABLE');}
  finally{clearTimeout(timer);controller.abort();pending--;}
 }});
}
function capabilities(body,origin,ready){
 if(!plain(body))return body;
 const cap=plain(body.capabilities)?body.capabilities:{},work=plain(cap.workflows)?cap.workflows:{},end=plain(cap.endpoints)?cap.endpoints:{};
 return {...body,capabilities:{...cap,workflows:{...work,published_read:ready===true,...(ready===true?{published_read_contract:VERSION,published_read_scope:SCOPE}:{published_read_contract:null,published_read_scope:null})},endpoints:{...end,...(ready===true?{templates:origin+'/api/templates'}:{})}}};
}
function nativeCatalog(result,brand){
 if(result.status!==200)return {status:result.status,body:{contract:VERSION,brand,source:'unavailable',configuredCount:null,code:result.body?.error||'PUBLISHED_JOURNEY_READ_UNAVAILABLE',readOnly:true,authorizesEdit:false,authorizesSend:false,operational:false}};
 const body=project(result.body,brand);
 return {status:200,body:{...body,contract:VERSION,brand,source:'original-published-definitions',workflowId:WORKFLOW_ID,workflowVersion:WORKFLOW_VERSION,configuredCount:body.flows.length,publishedCount:body.flows.filter(f=>f.published!==null).length,readOnly:true,authorizesEdit:false,authorizesSend:false,operational:false}};
}
module.exports={VERSION,SCOPE,DESTINATION,WORKFLOW_ID,WORKFLOW_VERSION,MAX_BYTES,decision,project,createReader,capabilities,nativeCatalog};
