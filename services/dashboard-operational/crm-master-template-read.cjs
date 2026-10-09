'use strict';
// Original registered tx email list only. PRIVATE authorization stays in the reader.
const {createHash}=require('node:crypto');
const VERSION='crm-template-read-v1',DESTINATION='https://n8n.shrigma.com.br/webhook/crm-template-api-242c0db6ddb8';
const MAX_BYTES=8*1024*1024,MAX_TEMPLATES=1000,MAX_BODY_HTML=400000,MAX_SUBJECT=1000,MAX_LIMIT=20,DEADLINE_MS=18000,MAX_CONCURRENT=4;
const fail=(code,status=502)=>{throw Object.assign(Error(code),{code,status});};
const plain=v=>!!v&&Object.getPrototypeOf(v)===Object.prototype;
const safe=(s,max,empty=false,multiline=false)=>typeof s==='string'&&(empty||s.length>0)&&s.length<=max&&!(multiline?/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/:/[\x00-\x1f\x7f]/).test(s);
const date=s=>{if(typeof s!=='string'||s.length>64||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(s)||!Number.isFinite(Date.parse(s)))return false;const y=Number(s.slice(0,4)),m=Number(s.slice(5,7)),d=Number(s.slice(8,10));return m>=1&&m<=12&&d>=1&&d<=new Date(Date.UTC(y,m,0)).getUTCDate();};
function decision(method,query){
 if(method!=='GET')fail('MASTER_TEMPLATE_METHOD_DENIED',405);
 if(!(query instanceof URLSearchParams))fail('MASTER_TEMPLATE_QUERY_DENIED',400);
 const keys=[...query.keys()],allowed=['acao','marca','canal','offset','limit'];
 if(query.toString().length>512||new Set(keys).size!==keys.length||keys.some(k=>!allowed.includes(k))||query.get('acao')!=='listar'||query.get('canal')!=='email'||!['fish','aristo'].includes(query.get('marca')))fail('MASTER_TEMPLATE_QUERY_DENIED',400);
 const offset=query.get('offset')??'0',limit=query.get('limit')??'20';
 if(!/^(0|[1-9][0-9]{0,5})$/.test(offset)||Number(offset)>100000||!/^[1-9][0-9]?$/.test(limit)||Number(limit)>MAX_LIMIT)fail('MASTER_TEMPLATE_QUERY_DENIED',400);
 return Object.freeze({brand:query.get('marca'),offset:Number(offset),limit:Number(limit)});
}
function noSecret(body,secrets){
 const active=secrets.filter(s=>typeof s==='string'&&s.length>0),stack=[body],seen=new Set();
 while(stack.length){const v=stack.pop();if(typeof v==='string'){if(active.some(s=>v.includes(s)))fail('MASTER_TEMPLATE_RESPONSE_INVALID');}else if(v&&typeof v==='object'){if(seen.has(v))fail('MASTER_TEMPLATE_RESPONSE_INVALID');seen.add(v);for(const [k,x] of Object.entries(v)){if(active.some(s=>k.includes(s)))fail('MASTER_TEMPLATE_RESPONSE_INVALID');stack.push(x);}}}
}
function project(body,brand,{offset=0,limit=MAX_LIMIT,secrets=[]}={}){
 if(!['fish','aristo'].includes(brand)||!Number.isSafeInteger(offset)||offset<0||offset>100000||!Number.isSafeInteger(limit)||limit<1||limit>MAX_LIMIT||!plain(body)||!Array.isArray(body.templates)||body.templates.length>MAX_TEMPLATES||!date(body.consultado_em))fail('MASTER_TEMPLATE_RESPONSE_INVALID');
 let raw;try{raw=JSON.stringify(body);}catch{fail('MASTER_TEMPLATE_RESPONSE_INVALID');}if(Buffer.byteLength(raw)>MAX_BYTES)fail('MASTER_TEMPLATE_RESPONSE_LIMIT');noSecret(body,secrets);
 const ids=new Set(),templates=[];
 for(let i=0;i<body.templates.length;i++){
  const t=body.templates[i];
  if(!Object.hasOwn(body.templates,i)||!plain(t)||t.brand!==brand||t.channel!=='email'||typeof t.id!=='string'||!/^[1-9][0-9]{0,9}$/.test(t.id)||ids.has(t.id)||t.key!==brand+':email:'+t.id||t.status!=='APPROVED'||!safe(t.name,160)||!(t.draft_id===null||safe(t.draft_id,64)&&/^[A-Za-z0-9_-]+$/.test(t.draft_id))||!(t.updated_at===null||date(t.updated_at))||!plain(t.components)||!safe(t.components.subject,MAX_BYTES,true)||!safe(t.components.body_html,MAX_BYTES,true,true))fail('MASTER_TEMPLATE_RESPONSE_INVALID');
  ids.add(t.id);const content={subject:t.components.subject,body_html:t.components.body_html};
  const content_available=content.subject.length<=MAX_SUBJECT&&content.body_html.length<=MAX_BODY_HTML;
  templates.push({key:'email.template.'+t.id,brand,channel:'email',id:t.id,name:t.name,type:'tx',draft_id:t.draft_id,components:content_available?{...content,altbody:null}:null,content_available,content_hash:createHash('sha256').update(JSON.stringify(content),'utf8').digest('hex'),updated_at:t.updated_at});
 }
 templates.sort((a,b)=>Number(a.id)-Number(b.id));const total=templates.length;
 return {contract:VERSION,brand,channel:'email',templates:templates.slice(offset,offset+limit),offset,limit,total,next_offset:offset+limit<total?offset+limit:null,coverage:'registered_email_only',consultado_em:body.consultado_em,schedule_proof:false};
}
async function boundedBody(response,signal,secrets){
 if(!response.body?.getReader)fail('MASTER_TEMPLATE_RESPONSE_INVALID');
 const reader=response.body.getReader(),chunks=[];let bytes=0;
 const cancel=()=>{try{Promise.resolve(reader.cancel()).catch(()=>{});}catch{}};signal.addEventListener('abort',cancel,{once:true});
 try{
  if(signal.aborted)fail('MASTER_TEMPLATE_DEADLINE',504);
  for(;;){const r=await reader.read();if(signal.aborted)fail('MASTER_TEMPLATE_DEADLINE',504);if(r.done)break;bytes+=r.value.byteLength;if(bytes>MAX_BYTES){cancel();fail('MASTER_TEMPLATE_RESPONSE_LIMIT');}chunks.push(Buffer.from(r.value));}
  const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));if(secrets.some(s=>raw.includes(s)))fail('MASTER_TEMPLATE_RESPONSE_INVALID');const body=JSON.parse(raw);noSecret(body,secrets);return body;
 }catch(e){if(/^MASTER_TEMPLATE_[A-Z_]+$/.test(e.code||''))fail(e.code,[400,403,405,429,502,503,504].includes(e.status)?e.status:502);cancel();fail('MASTER_TEMPLATE_RESPONSE_INVALID');}
 finally{signal.removeEventListener('abort',cancel);reader.releaseLock();}
}
function createReader({authorize,fetchImpl=globalThis.fetch,deadlineMs=DEADLINE_MS}={}){
 if(typeof authorize!=='function'||typeof fetchImpl!=='function'||!Number.isInteger(deadlineMs)||deadlineMs<1||deadlineMs>DEADLINE_MS)fail('MASTER_TEMPLATE_CONFIG_INVALID',503);
 let pending=0;
 const current=(ctx,brand)=>{
  let a;try{a=authorize(ctx,{brand});}catch{fail('MASTER_TEMPLATE_AUTH_INVALID',403);}
  if(a&&typeof a.then==='function'){Promise.resolve(a).catch(()=>{});fail('MASTER_TEMPLATE_AUTH_INVALID',403);}
  if(!plain(a)||!safe(a.userId,256)||!safe(a.binding,256)||typeof a.credential!=='string'||!/^[A-Za-z0-9._:-]{16,4096}$/.test(a.credential))fail('MASTER_TEMPLATE_AUTH_INVALID',403);
  // CURRENT authorize owns lifecycle expiry. Also reject any supplied expiry evidence.
  for(const k of ['expiresAt','expires_at'])if(Object.hasOwn(a,k)){const expires=typeof a[k]==='number'?a[k]:Date.parse(a[k]);if(!Number.isFinite(expires)||expires<=Date.now())fail('MASTER_TEMPLATE_AUTH_INVALID',403);}
  return {userId:a.userId,binding:a.binding,credential:a.credential};
 };
 return Object.freeze({async read(ctx,query){
  const d=decision(ctx?.method,query),before=current(ctx,d.brand);if(pending>=MAX_CONCURRENT)fail('MASTER_TEMPLATE_BUSY',429);pending++;
  const controller=new AbortController(),expires=Date.now()+deadlineMs;let timer,response;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(Error('MASTER_TEMPLATE_DEADLINE'),{code:'MASTER_TEMPLATE_DEADLINE',status:504}));},deadlineMs);});
  try{
   const target=DESTINATION+'?'+new URLSearchParams({acao:'listar',marca:d.brand,canal:'email'});
   response=await Promise.race([Promise.resolve().then(()=>fetchImpl(target,{method:'GET',redirect:'error',cache:'no-store',signal:controller.signal,headers:{Accept:'application/json',Authorization:'Bearer '+before.credential}})),deadline]);
   if(response.status!==200)fail(response.status===401||response.status===403?'MASTER_TEMPLATE_ORIGINAL_READ_DENIED':'MASTER_TEMPLATE_UPSTREAM_UNAVAILABLE');
   if(response.url&&response.url!==target||response.redirected)fail('MASTER_TEMPLATE_REDIRECT_DENIED');
   const body=await Promise.race([boundedBody(response,controller.signal,[before.credential]),deadline]),dto=project(body,d.brand,{...d,secrets:[before.credential]});
   const after=current(ctx,d.brand);if(after.userId!==before.userId||after.binding!==before.binding||after.credential!==before.credential)fail('MASTER_TEMPLATE_BINDING_CHANGED',403);
   if(Date.now()>=expires){controller.abort();fail('MASTER_TEMPLATE_DEADLINE',504);}
   return {status:200,body:dto};
  }catch(e){if(/^MASTER_TEMPLATE_[A-Z_]+$/.test(e.code||''))fail(e.code,[400,403,405,429,502,503,504].includes(e.status)?e.status:502);fail('MASTER_TEMPLATE_UPSTREAM_UNAVAILABLE');}
  finally{clearTimeout(timer);controller.abort();if(response?.body&&!response.body.locked){try{Promise.resolve(response.body.cancel()).catch(()=>{});}catch{}}pending--;}
 }});
}
function capabilities(body,origin,ready){
 if(!plain(body)||ready!==true)return body;
 let u;try{u=new URL(origin);}catch{return body;}if(u.protocol!=='https:'||u.origin!==origin||u.username||u.password)return body;
 const cap=plain(body.capabilities)?body.capabilities:{},templates=plain(cap.templates)?cap.templates:{},end=plain(cap.endpoints)?cap.endpoints:{};
 return {...body,capabilities:{...cap,templates:{...templates,read_content:true,read_contract:VERSION,draft:false,validate:false,submit:false,submit_email:false,list_history:false,read_submission:false,write:false,history:false,submission:false},endpoints:{...end,templates:origin+'/api/templates'}}};
}
function nativeCatalog(result,brand){
 if(result?.status!==200||result.body?.contract!==VERSION||result.body.brand!==brand)return {status:result?.status===200?502:result?.status||502,body:{contract:VERSION,brand,source:'unavailable',templates:null,total:null,readOnly:true,authorizesEdit:false,authorizesSend:false,operational:false}};
 const templates=result.body.templates,metadata=Object.fromEntries(['contract','brand','channel','offset','limit','total','next_offset','coverage','consultado_em','schedule_proof'].map(k=>[k,result.body[k]]));
 if(!Array.isArray(templates)||templates.length>MAX_LIMIT)fail('MASTER_TEMPLATE_RESPONSE_INVALID');
 const rows=templates.map(t=>Object.fromEntries(['key','brand','channel','id','name','type','draft_id','content_available','content_hash','updated_at'].map(k=>[k,t[k]])));
 return {status:200,body:{...metadata,templates:rows,source:'original-registered-email-templates',readOnly:true,authorizesEdit:false,authorizesSend:false,operational:false}};
}
module.exports={VERSION,DESTINATION,MAX_BYTES,MAX_TEMPLATES,MAX_BODY_HTML,MAX_SUBJECT,MAX_LIMIT,DEADLINE_MS,MAX_CONCURRENT,decision,project,createReader,capabilities,nativeCatalog};
