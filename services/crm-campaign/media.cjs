'use strict';
const {createHash}=require('node:crypto');
const {AUTH_SQL}=require('./transport.cjs');

const MAX_FILE_BYTES=2*1024*1024,MAX_PIXELS=4*1024*1024,MAX_RESPONSE_BYTES=2*1024*1024;
const BRANDS=new Set(['fish','aristo']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA=/^[0-9a-f]{64}$/;

const result=(status,body)=>({status,body});
function safeItem(item,origin){
 if(!item||!Number.isSafeInteger(item.id)||item.id<1||typeof item.filename!=='string'||item.filename.length>180)return null;
 let url,thumb=null;
 try{url=new URL(item.url);if(url.origin!==origin||url.username||url.password||url.port||url.search||url.hash||!url.pathname.startsWith('/uploads/'))return null;}
 catch{return null;}
 if(item.thumb_url){try{const u=new URL(typeof item.thumb_url==='string'?item.thumb_url:item.thumb_url.String);if(u.origin===origin&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&u.pathname.startsWith('/uploads/'))thumb=u.href;}catch{}}
 const width=Number(item.meta?.width),height=Number(item.meta?.height);
 if(!Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1||width*height>MAX_PIXELS)return null;
 if(!['image/png','image/jpeg','image/gif'].includes(item.content_type))return null;
 return {id:item.id,filename:item.filename,url:url.href,thumb_url:thumb,content_type:item.content_type,width,height,created_at:typeof item.created_at==='string'?item.created_at:null};
}
function dimensions(bytes){
 if(bytes.length>=45&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.readUInt32BE(8)===13&&bytes.toString('ascii',12,16)==='IHDR'){
  let at=8,ended=false;while(at+12<=bytes.length){const size=bytes.readUInt32BE(at),type=bytes.toString('ascii',at+4,at+8);if(size>MAX_FILE_BYTES||at+12+size>bytes.length)break;at+=12+size;if(type==='IEND'){ended=size===0&&at===bytes.length;break;}}if(ended)return {type:'image/png',ext:'png',width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
 }
 if(bytes.length>=14&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))&&bytes.at(-1)===0x3b)return {type:'image/gif',ext:'gif',width:bytes.readUInt16LE(6),height:bytes.readUInt16LE(8)};
 if(bytes.length>=4&&bytes[0]===0xff&&bytes[1]===0xd8){
  const sof=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);let at=2,image=null;
  while(at+3<bytes.length){while(at<bytes.length&&bytes[at]===0xff)at++;const marker=bytes[at++];if(marker===0xd9||marker===0xda)break;if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;if(at+1>=bytes.length)break;const size=bytes.readUInt16BE(at);if(size<2||at+size>bytes.length)break;if(sof.has(marker)&&size>=7){image={type:'image/jpeg',ext:'jpg',height:bytes.readUInt16BE(at+3),width:bytes.readUInt16BE(at+5)};break;}at+=size;
  }if(image&&bytes.at(-2)===0xff&&bytes.at(-1)===0xd9)return image;
 }
 return null;
}
function validateFile(bytes,declaredType,expectedHash){
 if(!Buffer.isBuffer(bytes)||bytes.length<10||bytes.length>MAX_FILE_BYTES)return {error:'MEDIA_FILE_SIZE'};
 const image=dimensions(bytes);if(!image||declaredType!==image.type||image.width<1||image.height<1||image.width*image.height>MAX_PIXELS)return {error:'MEDIA_FILE_INVALID'};
 const hash=createHash('sha256').update(bytes).digest('hex');if(hash!==expectedHash)return {error:'MEDIA_HASH_MISMATCH'};
 return {...image,hash,bytes};
}
function canonicalFilename(brand,operationId,hash,ext){return `crm-${brand}-${operationId}-${hash}.${ext}`;}
const MEDIA_LIST_SCAN_PAGES=4;
function filenameParts(filename){const match=/^crm-(fish|aristo)-([0-9a-fA-F-]{36})-([0-9a-f]{64})[.](png|jpg|gif)$/.exec(filename||'');return match&&UUID.test(match[2])?{brand:match[1],operation_id:match[2],sha256:match[3],ext:match[4]}:null;}

async function boundedJSON(response,maxBytes=MAX_RESPONSE_BYTES){
 if(!response||!Number.isInteger(response.status)||response.status<200||response.status>599||!response.body)throw Error('MEDIA_NATIVE_RESPONSE');
 if(Number(response.headers?.get?.('content-length'))>maxBytes)throw Error('MEDIA_NATIVE_RESPONSE');
 const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw Error('MEDIA_NATIVE_RESPONSE');chunks.push(chunk);}
 let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('MEDIA_NATIVE_RESPONSE');}
 return {status:response.status,body};
}
function mediaTransport({origin,username,token,fetchFn=fetch,timeoutMs=20000,maxResponseBytes=MAX_RESPONSE_BYTES}){
 const base=new URL(origin);if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash||!username||!token)throw Error('NATIVE_CONFIGURATION');
 const authorization='Basic '+Buffer.from(username+':'+token).toString('base64');
 async function request(path,init={}){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);try{return await boundedJSON(await fetchFn(base.origin+path,{...init,headers:{Authorization:authorization,...init.headers},redirect:'manual',signal:controller.signal}),maxResponseBytes);}finally{clearTimeout(timer);controller.abort();}}
 return {
  origin:base.origin,
  list:({page=1,perPage=24,query=''})=>request('/api/media?'+new URLSearchParams({page:String(page),per_page:String(perPage),query})),
  upload:async({filename,type,bytes})=>{const form=new FormData();form.append('file',new Blob([bytes],{type}),filename);return request('/api/media',{method:'POST',body:form});},
 };
}
function nativePage(response,native){
 if(response.status!==200||!response.body||typeof response.body!=='object'||!response.body.data||!Array.isArray(response.body.data.results))throw Error('MEDIA_NATIVE_LIST');
 const data=response.body.data;if(!Number.isSafeInteger(data.total)||data.total<0||data.total>1000000||!Number.isSafeInteger(data.page)||data.page<1||data.page>10000||!Number.isSafeInteger(data.per_page)||data.per_page<1||data.per_page>50||data.results.length>data.per_page)return null;
 const items=data.results.map(item=>safeItem(item,native.origin)).filter(Boolean);
 return {items,total:data.total,page:data.page,per_page:data.per_page,next_page:data.page*data.per_page<data.total?data.page+1:null};
}
async function authorize(pool,key,capability){
 const rows=(await pool.query(AUTH_SQL,[key]))?.rows;if(rows?.length!==1)throw Error('MEDIA_AUTH_RESPONSE');const auth=rows[0].auth;
 if(!auth||typeof auth.actor!=='string'||!auth.actor.trim()||!Array.isArray(auth.caps)||auth.caps.some(cap=>typeof cap!=='string'))return result(401,{error:'UNAUTHORIZED',message:'Autenticação necessária.',posted:false});
 if(!auth.caps.includes(capability))return result(403,{error:'CAPABILITY_MISSING',message:'Esta chave não tem permissão para esta ação.',posted:false});
 return auth;
}
function createMediaExecutor({pool,native}){
 const busy=new Set();
 async function lookup({brand,filename,hash,ext}){
  const query=hash||filename,response=await native.list({page:1,perPage:50,query}),page=nativePage(response,native);if(!page)throw Error('MEDIA_NATIVE_LIST');
  const item=page.items.find(entry=>entry.filename===filename)||(hash?page.items.find(entry=>{const part=filenameParts(entry.filename);return part&&part.brand===brand&&part.sha256===hash&&part.ext===ext;}):null);
  return {item,page};
 }
 return async function execute({key,method,input,interrupted=()=>false}){
  if(!BRANDS.has(input?.brand))return result(422,{error:'BRAND_UNAVAILABLE',message:'Marca fora desta etapa.',posted:false});
  const auth=await authorize(pool,key,method==='GET'?'read_content':'edit_content');if(auth.status)return auth;
  if(method==='GET'){
   if(input.filename!==undefined){const parts=filenameParts(input.filename);if(!parts||parts.brand!==input.brand||parts.operation_id!==input.operation_id||parts.sha256!==input.sha256)return result(422,{error:'MEDIA_RECOVERY_INVALID',message:'A tentativa de upload não confere.',posted:false});const {item}=await lookup({brand:input.brand,filename:input.filename});return result(200,{contract:'crm-media-v1',brand:input.brand,state:item?'found':'missing',media:item||null,operation_id:input.operation_id,filename:input.filename,sha256:input.sha256});}
   // The shared Listmonk library keeps files generated for the other brand; never list them here. Unattributed legacy files stay visible.
   // A native page holding only the other brand's files is skipped (bounded) so the first answer is not an empty library.
   // page/next_page follow the last native page read; total stays the native library total.
   const visible=entry=>{const part=filenameParts(entry.filename);return !part||part.brand===input.brand;};
   let number=input.page,page=null;
   for(let scanned=0;scanned<MEDIA_LIST_SCAN_PAGES;scanned++){
    if(interrupted())return result(503,{error:'MEDIA_INTERRUPTED',message:'A consulta da biblioteca foi interrompida.',posted:false});
    const response=await native.list({page:number,perPage:input.per_page,query:''});page=nativePage(response,native);if(!page)throw Error('MEDIA_NATIVE_LIST');
    page.items=page.items.filter(visible);if(page.items.length||page.next_page===null)break;number=page.next_page;
   }
   return result(200,{contract:'crm-media-v1',brand:input.brand,...page});
  }
  if(busy.has(input.brand))return result(409,{error:'MEDIA_BUSY',message:'Outro upload desta marca está em andamento.',posted:false});
  busy.add(input.brand);
  try{
   const file=validateFile(input.bytes,input.content_type,input.sha256);if(file.error)return result(file.error==='MEDIA_FILE_SIZE'?413:422,{error:file.error,message:'Arquivo de imagem inválido.',posted:false});
   const filename=canonicalFilename(input.brand,input.operation_id,file.hash,file.ext);
   const existing=await lookup({brand:input.brand,filename,hash:file.hash,ext:file.ext});
   if(existing.item)return result(200,{contract:'crm-media-v1',brand:input.brand,state:'existing',operation_id:input.operation_id,filename:existing.item.filename,sha256:file.hash,media:existing.item});
   if(interrupted())return result(503,{error:'MEDIA_INTERRUPTED',message:'A tentativa terminou antes do envio. Nenhum arquivo foi enviado.',posted:false});
   const reauthenticated=await authorize(pool,key,'edit_content');if(reauthenticated.status)return reauthenticated;if(reauthenticated.actor!==auth.actor)return result(409,{error:'MEDIA_ACTOR_CHANGED',message:'O acesso mudou durante a conferência. Nenhum arquivo foi enviado.',posted:false});if(interrupted())return result(503,{error:'MEDIA_INTERRUPTED',message:'A tentativa terminou antes do envio. Nenhum arquivo foi enviado.',posted:false});
   let response;try{response=await native.upload({filename,type:file.type,bytes:file.bytes});}catch{return result(502,{error:'MEDIA_OUTCOME_UNKNOWN',message:'O resultado do upload não foi confirmado. Confira esta mesma tentativa antes de tentar novamente.',operation_id:input.operation_id,filename,sha256:file.hash});}
   if(![200,201].includes(response.status))return result(502,{error:'MEDIA_OUTCOME_UNKNOWN',message:'O resultado do upload não foi confirmado. Confira esta mesma tentativa antes de tentar novamente.',operation_id:input.operation_id,filename,sha256:file.hash});
   const item=safeItem(response.body?.data,native.origin);if(!item||item.filename!==filename)return result(502,{error:'MEDIA_OUTCOME_UNKNOWN',message:'O resultado do upload não foi confirmado. Confira esta mesma tentativa antes de tentar novamente.',operation_id:input.operation_id,filename,sha256:file.hash});
   return result(201,{contract:'crm-media-v1',brand:input.brand,state:'created',operation_id:input.operation_id,filename,sha256:file.hash,media:item});
  }finally{busy.delete(input.brand);}
 };
}

module.exports={MAX_FILE_BYTES,MAX_PIXELS,UUID,SHA,dimensions,validateFile,canonicalFilename,filenameParts,safeItem,mediaTransport,createMediaExecutor};
