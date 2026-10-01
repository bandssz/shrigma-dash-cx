'use strict';
const http=require('node:http'),{gzip}=require('node:zlib'),{promisify}=require('node:util');
const {acceptsGzip}=require('../crm-panel-read/server.cjs');
const {createExecutor,unavailable}=require('./transport.cjs');
const {MAX_FILE_BYTES,UUID,SHA}=require('./media.cjs');
const compress=promisify(gzip),ORIGIN='https://bandssz.github.io';
const PATH='/webhook/crm-campanhas-api-a40da4ef222efba3f7278e35';
const MEDIA_PATH=PATH+'/media';
const READS=new Set(['campanha_catalogo','campanha_listar','campanha_obter','campanha_operacao']);
const WRITES=new Set(['campanha_salvar','campanha_validar','campanha_agendar','campanha_cancelar','campanha_recuperar']);
const FIELDS=new Set(['k','acao','brand','id','definition','expected_version','idempotency_key','confirm','audience_review_id','source_operation_id']);
const problem=(status,error,message)=>Object.assign(Error(message),{status,body:{error,message}});
function parse(req,url,body){
 const pairs=[...url.searchParams];
 if(req.method==='GET'&&pairs.some(([k],i)=>pairs.findIndex(([other])=>k===other)!==i))throw problem(422,'REQUEST_INVALID','Parâmetro repetido.');
 if(req.method==='POST'&&pairs.length)throw problem(422,'REQUEST_INVALID','Solicitação inválida.');
 const source=req.method==='GET'?Object.fromEntries(pairs):body;
 if(!source||typeof source!=='object'||Array.isArray(source)||Object.keys(source).some(k=>!FIELDS.has(k)))throw problem(422,'REQUEST_FIELD_INVALID','Campo não permitido.');
 if(!READS.has(source.acao)&&!WRITES.has(source.acao))throw problem(400,'ACTION_INVALID','Ação desconhecida.');
 if(!(req.method==='GET'?READS:WRITES).has(source.acao))throw problem(405,'METHOD_INVALID','Método incompatível com a ação.');
 const authCount=req.rawHeaders.filter((_,i)=>i%2===0).filter(h=>h.toLowerCase()==='authorization').length;
 if(authCount>1)throw problem(401,'UNAUTHORIZED','Autenticação necessária.');
 // Preserve the published client contract: GET header wins, legacy GET k only
 // if there is no header, POST uses body.k. Never place the key in the runtime.
 const header=req.headers.authorization;
 const key=req.method==='GET'&&header!==undefined?(typeof header==='string'&&header.startsWith('Bearer ')?header.slice(7):''):source.k;
 if(typeof key!=='string'||!/^[A-Za-z0-9_.:-]{1,256}$/.test(key))throw problem(401,'UNAUTHORIZED','Autenticação necessária.');
 const command=Object.fromEntries(Object.entries(source).filter(([k])=>k!=='k'));
 if(req.method==='GET'&&command.id!==undefined){if(!/^[1-9][0-9]*$/.test(command.id)||!Number.isSafeInteger(Number(command.id)))throw problem(422,'ID_INVALID','Campanha inválida.');command.id=Number(command.id);}
 return {key,command};
}
async function readBody(req,maxBytes){
 if(req.headers['content-encoding']||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))throw problem(415,'CONTENT_TYPE_INVALID','Use JSON.');
 if(Number(req.headers['content-length'])>maxBytes)throw problem(413,'REQUEST_TOO_LARGE','Conteúdo muito grande.');
 let size=0;const chunks=[];
 for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw problem(413,'REQUEST_TOO_LARGE','Conteúdo muito grande.');chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw problem(422,'REQUEST_INVALID','Solicitação inválida.');}
}
function bearer(req){const count=req.rawHeaders.filter((_,i)=>i%2===0).filter(h=>h.toLowerCase()==='authorization').length;if(count!==1)return null;const header=req.headers.authorization;return typeof header==='string'&&header.startsWith('Bearer ')&&/^[A-Za-z0-9_.:-]{1,256}$/.test(header.slice(7))?header.slice(7):null;}
function mediaGet(req,url){
 const key=bearer(req);if(!key)throw problem(401,'UNAUTHORIZED','Autenticação necessária.');const pairs=[...url.searchParams];if(pairs.some(([k],i)=>pairs.findIndex(([other])=>k===other)!==i))throw problem(422,'REQUEST_INVALID','Parâmetro repetido.');
 const source=Object.fromEntries(pairs),allowed=new Set(['brand','page','per_page','operation_id','filename','sha256']);if(Object.keys(source).some(k=>!allowed.has(k))||!['fish','aristo'].includes(source.brand))throw problem(422,'REQUEST_INVALID','Solicitação inválida.');
 const recovery=['operation_id','filename','sha256'].some(k=>source[k]!==undefined);
 if(recovery){if(Object.keys(source).sort().join(',')!=='brand,filename,operation_id,sha256'||!UUID.test(source.operation_id)||!SHA.test(source.sha256)||typeof source.filename!=='string'||source.filename.length>180)throw problem(422,'REQUEST_INVALID','Solicitação inválida.');return {key,input:{brand:source.brand,operation_id:source.operation_id,filename:source.filename,sha256:source.sha256}};}
 if(Object.keys(source).some(k=>!['brand','page','per_page'].includes(k))||source.page!==undefined&&!/^[1-9][0-9]{0,4}$/.test(source.page)||source.per_page!==undefined&&!/^[1-9][0-9]?$/.test(source.per_page))throw problem(422,'REQUEST_INVALID','Solicitação inválida.');const page=source.page===undefined?1:Number(source.page),perPage=source.per_page===undefined?24:Number(source.per_page);if(!Number.isSafeInteger(page)||page<1||page>10000||!Number.isSafeInteger(perPage)||perPage<1||perPage>50)throw problem(422,'REQUEST_INVALID','Solicitação inválida.');return {key,input:{brand:source.brand,page,per_page:perPage}};
}
async function readMultipart(req,maxBytes=MAX_FILE_BYTES+65536){
 const type=req.headers['content-type']||'';if(req.headers['content-encoding']||!/^multipart\/form-data;\s*boundary=[!#$%&'*+.^_`|~0-9A-Za-z-]{1,70}$/.test(type))throw problem(415,'CONTENT_TYPE_INVALID','Use multipart/form-data.');
 if(Number(req.headers['content-length'])>maxBytes)throw problem(413,'REQUEST_TOO_LARGE','Conteúdo muito grande.');let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw problem(413,'REQUEST_TOO_LARGE','Conteúdo muito grande.');chunks.push(chunk);}
 let form;try{form=await new Response(Buffer.concat(chunks),{headers:{'Content-Type':type}}).formData();}catch{throw problem(422,'REQUEST_INVALID','Solicitação inválida.');}
 const allowed=new Set(['brand','operation_id','sha256','file']);if([...form.keys()].some(k=>!allowed.has(k))||[...allowed].some(k=>form.getAll(k).length!==1))throw problem(422,'REQUEST_INVALID','Solicitação inválida.');
 const brand=form.get('brand'),operationId=form.get('operation_id'),hash=form.get('sha256'),file=form.get('file');if(!['fish','aristo'].includes(brand)||!UUID.test(operationId)||!SHA.test(hash)||!file||typeof file.arrayBuffer!=='function'||typeof file.type!=='string'||file.size>MAX_FILE_BYTES)throw problem(422,'REQUEST_INVALID','Solicitação inválida.');
 return {brand,operation_id:operationId,sha256:hash,content_type:file.type,bytes:Buffer.from(await file.arrayBuffer())};
}
function createServer({pool,native,revision,enabled=false,mediaEnabled=false,executor=createExecutor({pool,native}),mediaExecutor=null,maxPending=12,readDeadlineMs=16000,writeDeadlineMs=85000,maxBodyBytes=2*1024*1024,maxResponseBytes=8*1024*1024}){
 let pending=0,closing=false;
 const server=http.createServer({maxHeaderSize:8192,requestTimeout:15000,headersTimeout:10000},async(req,res)=>{
  let admitted=false,timer,ended=false,responding=false;
  const disconnected=()=>{if(!res.writableEnded)ended=true;};res.on('close',disconnected);
  async function reply(status,body){
   if(res.destroyed||res.writableEnded||responding)return;responding=true;
   const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','Pragma':'no-cache','Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Accept-Encoding','X-CRM-Campaign-Revision':revision};
   if(status===503)headers['Retry-After']='5';
   let bytes=Buffer.from(body===null?'':JSON.stringify(body));
   if(bytes.length>maxResponseBytes){status=503;bytes=Buffer.from(JSON.stringify(unavailable().body));}
   if(bytes.length>1024&&acceptsGzip(req.headers['accept-encoding'])){bytes=await compress(bytes,{level:1});headers['Content-Encoding']='gzip';}
   if(res.destroyed||res.writableEnded)return;headers['Content-Length']=bytes.length;res.writeHead(status,headers);res.end(bytes);
  }
  try{
   if(req.url.length>4096)throw problem(414,'REQUEST_INVALID','Solicitação inválida.');
   const url=new URL(req.url,'http://localhost');
   if(req.method==='GET'&&url.pathname==='/healthz'&&!url.search)return await reply(closing?503:200,{service:'crm-campaign',revision,enabled,media_enabled:mediaEnabled,stopping:closing});
   const mediaRoute=url.pathname===MEDIA_PATH;if(url.pathname!==PATH&&!mediaRoute)throw problem(404,'ROUTE_INVALID','Rota indisponível.');
   if(req.headers.origin&&req.headers.origin!==ORIGIN)throw problem(403,'ORIGIN_DENIED','Origem não permitida.');
   if(req.method==='OPTIONS')return await reply(204,null);
   if(!['GET','POST'].includes(req.method))throw problem(405,'METHOD_INVALID','Método incompatível com a ação.');
   if(!enabled||closing||pending>=maxPending)return await reply(503,unavailable().body);
   if(mediaRoute&&(!mediaEnabled||typeof mediaExecutor!=='function'))return await reply(503,{error:'MEDIA_DISABLED',message:'A biblioteca de imagens ainda não está disponível.',posted:false});
   pending++;admitted=true;
   timer=setTimeout(()=>{ended=true;reply(req.method==='POST'?502:503,{error:mediaRoute&&req.method==='POST'?'MEDIA_OUTCOME_UNKNOWN':req.method==='POST'?'OUTCOME_UNKNOWN':'READ_UNAVAILABLE',message:'Consulta não concluída. Consulte a mesma operação antes de tentar novamente.'}).catch(()=>res.destroy());},req.method==='POST'?writeDeadlineMs:readDeadlineMs);
   let input;
   if(mediaRoute){if(req.method==='GET')input=mediaGet(req,url);else{const key=bearer(req);if(!key)throw problem(401,'UNAUTHORIZED','Autenticação necessária.');input={key,input:await readMultipart(req)};}}
   else{const body=req.method==='POST'?await readBody(req,maxBodyBytes):null;input=parse(req,url,body);}
   if(ended)return;
   const result=mediaRoute?await mediaExecutor({...input,method:req.method,interrupted:()=>ended||closing}):await executor({...input,interrupted:()=>ended||closing});
   if(!result||!Number.isInteger(result.status)||result.status<200||result.status>599||!result.body||typeof result.body!=='object')throw Error('RESPONSE_INVALID');
   await reply(result.status,result.body);
  }catch(e){await reply(e.status||503,e.body||unavailable().body).catch(()=>res.destroy());}
  finally{clearTimeout(timer);res.off('close',disconnected);if(admitted)pending--;}
 });
 let stopPromise;
 const stop=()=>stopPromise||=(async()=>{closing=true;server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));while(pending)await new Promise(resolve=>setTimeout(resolve,20));})();
 return {server,stop,pending:()=>pending};
}
module.exports={createServer,parse,mediaGet,readMultipart,bearer,ORIGIN,PATH,MEDIA_PATH,READS,WRITES};
