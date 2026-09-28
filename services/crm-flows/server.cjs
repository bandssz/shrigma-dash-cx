'use strict';
const http=require('node:http'),{timingSafeEqual}=require('node:crypto');
const MAX_BODY=196608;
const ROUTES={'/internal/source':'captureHandoff','/internal/tick':'tick','/internal/reconcile':'reconcile','/internal/inspect':'inspect'};
const safeCode=e=>/^GRAPH_[A-Z0-9_]{1,80}$/.test(e?.code||'')?e.code:'GRAPH_SERVICE_UNCONFIRMED';
function createServer({worker,token,revision,enabled=false,maxInFlight=2}={}){
 if(!worker||['captureHandoff','tick','reconcile','inspect'].some(k=>typeof worker[k]!=='function')||typeof token!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(token)||typeof revision!=='string'||!/^[a-f0-9]{40}$/.test(revision)||typeof enabled!=='boolean'||!Number.isInteger(maxInFlight)||maxInFlight<1||maxInFlight>4)throw Error('GRAPH_SERVICE_CONFIG');
 let inFlight=0,closing=false,stopPromise;const idleWaiters=new Set(),expected=Buffer.from('Bearer '+token);
 const reply=(res,status,body)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Connection':'close'});res.end(JSON.stringify(body));};
 const server=http.createServer({maxHeaderSize:8192,requestTimeout:15000,headersTimeout:10000},async(req,res)=>{
  if(req.method==='GET'&&req.url==='/healthz')return reply(res,closing?503:200,{service:'crm-flows',revision,execution_enabled:enabled,stopping:closing});
  // Exact paths, one bearer and no query-string, cookie or browser-origin authentication.
  const authCount=req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()==='authorization').length;
  const actual=Buffer.from(typeof req.headers.authorization==='string'?req.headers.authorization:'');
  if(authCount!==1||actual.length!==expected.length||!timingSafeEqual(actual,expected))return reply(res,401,{error:'GRAPH_SERVICE_UNAUTHORIZED'});
  if(req.headers.origin!==undefined)return reply(res,403,{error:'GRAPH_SERVICE_INTERNAL_ONLY'});
  const action=ROUTES[req.url];if(req.method!=='POST'||!action)return reply(res,404,{error:'GRAPH_SERVICE_ROUTE'});
  if(req.headers['content-type']!=='application/json'||req.headers['content-encoding']!==undefined)return reply(res,415,{error:'GRAPH_SERVICE_JSON_REQUIRED'});
  if(closing||inFlight>=maxInFlight)return reply(res,503,{error:'GRAPH_SERVICE_BUSY'});
  const length=req.headers['content-length'];if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>MAX_BODY))return reply(res,413,{error:'GRAPH_SERVICE_BODY_LIMIT'});
  inFlight++;let bytes=0;const chunks=[];
  try{
   for await(const part of req){bytes+=part.length;if(bytes>MAX_BODY){reply(res,413,{error:'GRAPH_SERVICE_BODY_LIMIT'});req.destroy();return;}chunks.push(part);}
   let input;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{return reply(res,400,{error:'GRAPH_SERVICE_JSON'});}
   if(!input||typeof input!=='object'||Array.isArray(input))return reply(res,400,{error:'GRAPH_SERVICE_INPUT'});
   // Inspect is authenticated even while OFF and accepts no caller data. Its
   // existing worker implementation reads only aggregate storage/control state.
   if(action==='inspect'&&Object.keys(input).length!==0)return reply(res,400,{error:'GRAPH_SERVICE_INPUT'});
   // No retries, redirected calls or caller-selected operation names. The worker
   // supplies the strict per-operation schema and durable reconciliation contract.
   const result=await worker[action](input);reply(res,200,result);
  }catch(e){reply(res,503,{error:safeCode(e),...(action==='inspect'?{}:{reconcile_only:true})});}
  finally{inFlight--;if(inFlight===0){for(const done of idleWaiters)done();idleWaiters.clear();}}
 });
 server.on('clientError',(_e,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
 return Object.freeze({server,stop:()=>{
  closing=true;if(!stopPromise){
   const idle=inFlight===0?Promise.resolve():new Promise(resolve=>idleWaiters.add(resolve));
   const closed=new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeIdleConnections();});
   // A disconnected caller does not cancel its durable operation. Wait for the
   // handler as well as the socket before allowing the database pool to close.
   stopPromise=Promise.all([closed,idle]).then(()=>undefined);
  }return stopPromise;
 },active:()=>inFlight});
}
module.exports={createServer,MAX_BODY};
