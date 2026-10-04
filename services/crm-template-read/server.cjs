'use strict';
// Listener somente leitura: GET /template-read e GET /healthz. Sem CORS: o
// consumidor é a ponte do portal, servidor a servidor. Sem corpo, sem Origin,
// um único Authorization, query canônica de até 512 bytes, no máximo quatro
// leituras simultâneas, sem fila e sem retry.
const http=require('node:http');
const PATH='/template-read',MAX_QUERY=512;
function createReadServer({handler=null,revision,enabled=false,maxInFlight=4,operationTimeoutMs=10000}={}){
 if(typeof enabled!=='boolean'||enabled&&typeof handler?.handle!=='function'||typeof revision!=='string'||!/^[a-f0-9]{40}$/.test(revision)||!Number.isInteger(maxInFlight)||maxInFlight<1||maxInFlight>4||!Number.isInteger(operationTimeoutMs)||operationTimeoutMs<1000||operationTimeoutMs>30000)throw Error('CRM_TEMPLATE_READ_SERVER_CONFIG');
 let inFlight=0,closing=false,stopPromise;const idle=new Set();
 const head=(res,status,length)=>res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':String(length),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Connection':'close'});
 const send=(res,status,text)=>{if(res.destroyed||res.writableEnded)return;const b=Buffer.from(text,'utf8');head(res,status,b.length);res.end(b);};
 const reply=(res,status,body)=>send(res,status,JSON.stringify(body));
 const count=(req,name)=>req.rawHeaders.filter((h,i)=>i%2===0&&h.toLowerCase()===name).length;
 const server=http.createServer({maxHeaderSize:8192,requestTimeout:15000,headersTimeout:10000},async(req,res)=>{
  let url;try{url=new URL(req.url,'http://crm-template-read.invalid');}catch{return reply(res,400,{error:'TEMPLATE_READ_REQUEST'});}
  if(req.method==='GET'&&url.pathname==='/healthz'&&!url.search)return reply(res,closing?503:200,{service:'crm-template-read',contract:'crm-template-read-v1',revision,enabled,stopping:closing});
  if(url.pathname!==PATH)return reply(res,404,{error:'TEMPLATE_READ_ROUTE'});
  // Desligado: 503 antes de olhar método, credencial ou query.
  if(!enabled||closing)return reply(res,503,{error:'TEMPLATE_READ_DISABLED'});
  if(req.method!=='GET')return reply(res,405,{error:'TEMPLATE_READ_METHOD'});
  if(count(req,'origin')>0)return reply(res,403,{error:'TEMPLATE_READ_ORIGIN'});
  if(req.headers['content-length']!==undefined||req.headers['transfer-encoding']!==undefined)return reply(res,400,{error:'TEMPLATE_READ_REQUEST'});
  if(count(req,'authorization')!==1||typeof req.headers.authorization!=='string')return reply(res,401,{error:'TEMPLATE_READ_UNAUTHORIZED'});
  if(url.search.length>MAX_QUERY+1)return reply(res,414,{error:'TEMPLATE_READ_REQUEST'});
  if(inFlight>=maxInFlight)return reply(res,503,{error:'TEMPLATE_READ_BUSY'});
  inFlight++;const controller=new AbortController();let timer,gone=false;
  const abort=()=>{gone=true;controller.abort();};req.once('aborted',abort);res.once('close',()=>{if(!res.writableEnded)abort();});
  try{
   timer=setTimeout(()=>controller.abort(),operationTimeoutMs);timer.unref?.();
   const r=await handler.handle({authorization:req.headers.authorization,pairs:[...url.searchParams]},{signal:controller.signal});
   if(!gone){if(typeof r.text==='string')send(res,r.status,r.text);else reply(res,r.status,r.body);}
   // A resposta já saiu; a vaga só volta quando a transação terminou de fato.
   if(r&&typeof r.settled?.then==='function')await r.settled;
  }catch{if(!gone)reply(res,503,{error:'TEMPLATE_READ_UNAVAILABLE'});}
  finally{clearTimeout(timer);req.removeListener('aborted',abort);inFlight--;if(inFlight===0){for(const d of idle)d();idle.clear();}}
 });
 server.maxRequestsPerSocket=1;
 server.on('clientError',(_e,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
 return Object.freeze({server,active:()=>inFlight,stop:()=>{closing=true;if(!stopPromise){const done=inFlight===0?Promise.resolve():new Promise(r=>idle.add(r));const closed=server.listening?new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeIdleConnections();}):Promise.resolve();stopPromise=Promise.all([closed,done]).then(()=>undefined);}return stopPromise;}});
}
module.exports={createReadServer,PATH,MAX_QUERY};
