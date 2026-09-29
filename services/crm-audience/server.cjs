'use strict';
const http=require('node:http');
const ORIGIN='https://bandssz.github.io',MAX_BODY=32768;
const ROUTES=new Set(['/segments','/campaign-audience']);
function createServer({segments,binding,revision,enabled=false,bindingEnabled=false,regularEnabled=false,maxInFlight=4,operationTimeoutMs=12000}={}){
 if(typeof bindingEnabled!=='boolean'||typeof regularEnabled!=='boolean')throw Error('CRM_AUDIENCE_SERVER_CONFIG');
 if(typeof segments?.handle!=='function'||typeof binding?.handle!=='function'||typeof revision!=='string'||!/^[a-f0-9]{40}$/.test(revision)||typeof enabled!=='boolean'||!Number.isInteger(maxInFlight)||maxInFlight<1||maxInFlight>4||!Number.isInteger(operationTimeoutMs)||operationTimeoutMs<1000||operationTimeoutMs>30000)throw Error('CRM_AUDIENCE_SERVER_CONFIG');
 let inFlight=0,closing=false,stopPromise;const idleWaiters=new Set();
 const cors=(req,headers={})=>req.headers.origin===ORIGIN?{'Access-Control-Allow-Origin':ORIGIN,'Vary':'Origin',...headers}:headers;
 const reply=(req,res,status,body,headers={})=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,cors(req,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Connection':'close',...headers}));res.end(body===null?'':JSON.stringify(body));};
 const duplicate=(req,name)=>req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()===name).length;
 const server=http.createServer({maxHeaderSize:8192,requestTimeout:15000,headersTimeout:10000},async(req,res)=>{
  let url;try{url=new URL(req.url,'http://crm-audience.invalid');}catch{return reply(req,res,400,{error:'CRM_AUDIENCE_REQUEST'});}
  if(req.method==='GET'&&url.pathname==='/healthz'&&!url.search)return reply(req,res,closing?503:200,{service:'crm-audience',revision,enabled,stopping:closing});
  if(!ROUTES.has(url.pathname))return reply(req,res,404,{error:'CRM_AUDIENCE_ROUTE'});
  if(req.headers.origin!==undefined&&req.headers.origin!==ORIGIN||duplicate(req,'origin')>1)return reply(req,res,403,{error:'CRM_AUDIENCE_ORIGIN'});
  if(req.method==='OPTIONS'){
   if(url.search||req.headers.origin!==ORIGIN||req.headers['access-control-request-method']&&!['GET','POST'].includes(req.headers['access-control-request-method']))return reply(req,res,403,{error:'CRM_AUDIENCE_ORIGIN'});
   return reply(req,res,204,null,{'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600'});
  }
  if(!enabled||closing)return reply(req,res,503,{error:'CRM_AUDIENCE_DISABLED'});
  if(!['GET','POST'].includes(req.method))return reply(req,res,405,{error:'CRM_AUDIENCE_METHOD'});
  if(duplicate(req,'authorization')!==1||typeof req.headers.authorization!=='string')return reply(req,res,401,{error:'CRM_AUDIENCE_UNAUTHORIZED'});
  const pairs=[...url.searchParams],seen=new Set();for(const [key]of pairs){if(seen.has(key))return reply(req,res,400,{error:'CRM_AUDIENCE_QUERY'});seen.add(key);}
  if(req.method==='POST'&&pairs.length)return reply(req,res,400,{error:'CRM_AUDIENCE_QUERY'});
  if(req.headers['content-encoding']!==undefined||duplicate(req,'content-length')>1||req.headers['content-length']!==undefined&&req.headers['transfer-encoding']!==undefined)return reply(req,res,400,{error:'CRM_AUDIENCE_REQUEST'});
  if(req.method==='GET'&&(req.headers['content-length']!==undefined||req.headers['transfer-encoding']!==undefined))return reply(req,res,400,{error:'CRM_AUDIENCE_REQUEST'});
  if(req.method==='POST'&&req.headers['content-type']!=='application/json')return reply(req,res,415,{error:'CRM_AUDIENCE_JSON_REQUIRED'});
  const length=req.headers['content-length'];if(length!==undefined&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>MAX_BODY))return reply(req,res,413,{error:'CRM_AUDIENCE_BODY_LIMIT'});
  if(inFlight>=maxInFlight)return reply(req,res,503,{error:'CRM_AUDIENCE_BUSY'});
  inFlight++;const controller=new AbortController();let timer,disconnected=false;
  const abort=()=>{disconnected=true;controller.abort();};req.once('aborted',abort);res.once('close',()=>{if(!res.writableEnded)abort();});
  try{
   let body;
   if(req.method==='POST'){
    let bytes=0;const chunks=[];for await(const part of req){bytes+=part.length;if(bytes>MAX_BODY){controller.abort();return reply(req,res,413,{error:'CRM_AUDIENCE_BODY_LIMIT'});}chunks.push(part);}
    try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{return reply(req,res,400,{error:'CRM_AUDIENCE_JSON'});}
    if(!body||typeof body!=='object'||Array.isArray(body))return reply(req,res,400,{error:'CRM_AUDIENCE_INPUT'});
    if(url.pathname==='/campaign-audience'&&['campanha_publico_preparar_envio','campanha_publico_agendar'].includes(body.acao)&&(!regularEnabled||!bindingEnabled))return reply(req,res,503,{error:'REGULAR_ADMISSION_UNAVAILABLE'});
    if(url.pathname==='/campaign-audience'&&body.acao==='campanha_publico_vincular'&&!bindingEnabled)return reply(req,res,503,{error:'SEGMENT_BINDING_UNAVAILABLE'});
   }
   timer=setTimeout(()=>controller.abort(),operationTimeoutMs);timer.unref?.();
   const request={headers:{Authorization:req.headers.authorization,...(req.headers.origin?{Origin:req.headers.origin}:{})},...(req.method==='GET'?{query:Object.fromEntries(pairs)}:{body})};
   const api=url.pathname==='/segments'?segments:binding,result=await api.handle({method:req.method,request},{signal:controller.signal});
   if(!disconnected)reply(req,res,result.status,result.body,result.headers||{});
  }catch{if(!disconnected)reply(req,res,503,{error:'CRM_AUDIENCE_UNCONFIRMED'});}
  finally{clearTimeout(timer);req.removeListener('aborted',abort);inFlight--;if(inFlight===0){for(const done of idleWaiters)done();idleWaiters.clear();}}
 });
 server.maxRequestsPerSocket=1;
 server.on('clientError',(_error,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
 return Object.freeze({server,active:()=>inFlight,stop:()=>{
  closing=true;if(!stopPromise){const idle=inFlight===0?Promise.resolve():new Promise(resolve=>idleWaiters.add(resolve));const closed=server.listening?new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeIdleConnections();}):Promise.resolve();stopPromise=Promise.all([closed,idle]).then(()=>undefined);}return stopPromise;
 }});
}
module.exports={createServer,MAX_BODY,ORIGIN};
