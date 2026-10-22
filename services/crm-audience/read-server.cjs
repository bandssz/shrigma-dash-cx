'use strict';
// Listener separado do serviço de públicos: somente GET /audience-read e
// /healthz. Não altera server.cjs (rotas atuais idênticas). Sem CORS: o
// consumidor é o BFF do portal, servidor a servidor.
const http=require('node:http');
const PATH='/audience-read',MAX_QUERY=1024;
function createReadServer({handler=null,revision,enabled=false,maxInFlight=4,operationTimeoutMs=10000}={}){
 if(typeof enabled!=='boolean'||enabled&&typeof handler?.handle!=='function'||typeof revision!=='string'||!/^[a-f0-9]{40}$/.test(revision)||!Number.isInteger(maxInFlight)||maxInFlight<1||maxInFlight>4||!Number.isInteger(operationTimeoutMs)||operationTimeoutMs<1000||operationTimeoutMs>30000)throw Error('CRM_AUDIENCE_READ_SERVER_CONFIG');
 let inFlight=0,closing=false,stopPromise;const idle=new Set();
 const reply=(res,status,body)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Connection':'close'});res.end(JSON.stringify(body));};
 const count=(req,name)=>req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()===name).length;
 const server=http.createServer({maxHeaderSize:8192,requestTimeout:15000,headersTimeout:10000},async(req,res)=>{
  let url;try{url=new URL(req.url,'http://crm-audience-read.invalid');}catch{return reply(res,400,{error:'CRM_AUDIENCE_READ_REQUEST'});}
  if(req.method==='GET'&&url.pathname==='/healthz'&&!url.search)return reply(res,closing?503:200,{service:'crm-audience-read',revision,enabled,stopping:closing});
  if(url.pathname!==PATH)return reply(res,404,{error:'CRM_AUDIENCE_READ_ROUTE'});
  if(!enabled||closing)return reply(res,503,{error:'CRM_AUDIENCE_READ_DISABLED'});
  if(req.method!=='GET')return reply(res,405,{error:'CRM_AUDIENCE_READ_METHOD'});
  if(count(req,'origin')>0)return reply(res,403,{error:'CRM_AUDIENCE_READ_ORIGIN'});
  if(req.headers['content-length']!==undefined||req.headers['transfer-encoding']!==undefined)return reply(res,400,{error:'CRM_AUDIENCE_READ_REQUEST'});
  if(count(req,'authorization')!==1||typeof req.headers.authorization!=='string')return reply(res,401,{error:'SEGMENT_UNAUTHORIZED'});
  if(url.search.length>MAX_QUERY)return reply(res,414,{error:'CRM_AUDIENCE_READ_QUERY'});
  const pairs=[...url.searchParams],seen=new Set();for(const [k]of pairs){if(seen.has(k))return reply(res,400,{error:'CRM_AUDIENCE_READ_QUERY'});seen.add(k);}
  if(inFlight>=maxInFlight)return reply(res,503,{error:'CRM_AUDIENCE_READ_BUSY'});
  inFlight++;const controller=new AbortController();let timer,gone=false;
  const abort=()=>{gone=true;controller.abort();};req.once('aborted',abort);res.once('close',()=>{if(!res.writableEnded)abort();});
  try{
   timer=setTimeout(()=>controller.abort(),operationTimeoutMs);timer.unref?.();
   const r=await handler.handle({authorization:req.headers.authorization,query:Object.fromEntries(pairs)},{signal:controller.signal});
   if(!gone)reply(res,r.status,r.body);
  }catch{if(!gone)reply(res,503,{error:'SEGMENT_READ_UNAVAILABLE'});}
  finally{clearTimeout(timer);req.removeListener('aborted',abort);inFlight--;if(inFlight===0){for(const d of idle)d();idle.clear();}}
 });
 server.maxRequestsPerSocket=1;
 server.on('clientError',(_e,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
 return Object.freeze({server,active:()=>inFlight,stop:()=>{closing=true;if(!stopPromise){const done=inFlight===0?Promise.resolve():new Promise(r=>idle.add(r));const closed=server.listening?new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeIdleConnections();}):Promise.resolve();stopPromise=Promise.all([closed,done]).then(()=>undefined);}return stopPromise;}});
}
module.exports={createReadServer,PATH,MAX_QUERY};
