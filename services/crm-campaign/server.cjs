'use strict';
const http=require('node:http'),{gzip}=require('node:zlib'),{promisify}=require('node:util');
const {acceptsGzip}=require('../crm-panel-read/server.cjs');
const {createExecutor,unavailable}=require('./transport.cjs');
const compress=promisify(gzip),ORIGIN='https://bandssz.github.io';
const PATH='/webhook/crm-campanhas-api-a40da4ef222efba3f7278e35';
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
function createServer({pool,native,revision,enabled=false,executor=createExecutor({pool,native}),maxPending=12,readDeadlineMs=16000,writeDeadlineMs=85000,maxBodyBytes=2*1024*1024,maxResponseBytes=8*1024*1024}){
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
   if(req.method==='GET'&&url.pathname==='/healthz'&&!url.search)return await reply(closing?503:200,{service:'crm-campaign',revision,enabled,stopping:closing});
   if(url.pathname!==PATH)throw problem(404,'ROUTE_INVALID','Rota indisponível.');
   if(req.headers.origin&&req.headers.origin!==ORIGIN)throw problem(403,'ORIGIN_DENIED','Origem não permitida.');
   if(req.method==='OPTIONS')return await reply(204,null);
   if(!['GET','POST'].includes(req.method))throw problem(405,'METHOD_INVALID','Método incompatível com a ação.');
   if(!enabled||closing||pending>=maxPending)return await reply(503,unavailable().body);
   pending++;admitted=true;
   timer=setTimeout(()=>{ended=true;reply(req.method==='POST'?502:503,{error:req.method==='POST'?'OUTCOME_UNKNOWN':'READ_UNAVAILABLE',message:'Consulta não concluída. Consulte a mesma operação antes de tentar novamente.'}).catch(()=>res.destroy());},req.method==='POST'?writeDeadlineMs:readDeadlineMs);
   const body=req.method==='POST'?await readBody(req,maxBodyBytes):null;
   const input=parse(req,url,body);
   if(ended)return;
   const result=await executor({...input,interrupted:()=>ended||closing});
   if(!result||!Number.isInteger(result.status)||result.status<200||result.status>599||!result.body||typeof result.body!=='object')throw Error('RESPONSE_INVALID');
   await reply(result.status,result.body);
  }catch(e){await reply(e.status||503,e.body||unavailable().body).catch(()=>res.destroy());}
  finally{clearTimeout(timer);res.off('close',disconnected);if(admitted)pending--;}
 });
 let stopPromise;
 const stop=()=>stopPromise||=(async()=>{closing=true;server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));while(pending)await new Promise(resolve=>setTimeout(resolve,20));})();
 return {server,stop,pending:()=>pending};
}
module.exports={createServer,parse,ORIGIN,PATH,READS,WRITES};
