'use strict';
const http=require('node:http'),{gzip}=require('node:zlib'),{promisify}=require('node:util');
const {randomUUID}=require('node:crypto');
const compress=promisify(gzip),ORIGIN='https://bandssz.github.io';
const QUERY='SELECT status_code,body FROM public.shrigma_crm_read_fast_v1($1::text,$2::text,$3::jsonb)';
function acceptsGzip(header=''){return header.split(',').some(x=>{const [name,...params]=x.trim().split(';');return name==='gzip'&&!params.some(p=>/^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(p));});}
function finiteFailure(error,phase){
 if(error?.code==='CRM_READ_DEADLINE')return {code:'QUERY_DEADLINE'};
 if(error?.code==='CRM_READ_SHAPE')return {code:'RESULT_SHAPE_INVALID'};
 if(['ERROR','FATAL','PANIC'].includes(error?.severity)&&/^[A-Z0-9]{5}$/.test(error?.code||''))return {code:'SQL_FAILED',sqlState:error.code};
 return {code:phase==='database'?'DRIVER_FAILED':phase==='response'?'RESPONSE_FAILED':'HANDLER_FAILED'};
}
function createServer({pool,revision,enabled=false,maxPending=16,deadlineMs=9000,logger=row=>process.stderr.write(JSON.stringify(row)+'\n')}){
 let pending=0,closing=false;
 function record(req,phase,value){const row={event:'CRM_READ_FAILURE',requestId:req._readId,phase,...value,elapsedMs:Math.max(0,Date.now()-req._readStarted),pending};req._readFailure=row;try{logger(row);}catch{}}
 async function reply(req,res,status,body){
  if(res.destroyed||res.writableEnded)return;
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','Pragma':'no-cache','Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, OPTIONS','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Accept-Encoding'};
  if(status===503)headers['Retry-After']='5';
  if(req._readId)headers['X-Shrigma-Request-Id']=req._readId;
  if(req._readFailure){headers['X-Shrigma-Error-Code']=req._readFailure.code;if(req._readFailure.sqlState)headers['X-Shrigma-Sqlstate']=req._readFailure.sqlState;}
  let bytes=Buffer.from(body===null?'':JSON.stringify(body));
  if(bytes.length>1024&&acceptsGzip(req.headers['accept-encoding'])){bytes=await compress(bytes,{level:1});headers['Content-Encoding']='gzip';}
  if(res.destroyed||res.writableEnded)return;headers['Content-Length']=bytes.length;res.writeHead(status,headers);res.end(bytes);
 }
 const server=http.createServer({maxHeaderSize:8192,requestTimeout:12000,headersTimeout:10000},async(req,res)=>{
  req._readId=randomUUID();req._readStarted=Date.now();
  try{
   const url=new URL(req.url,'http://localhost');
   if(req.method==='GET'&&url.pathname==='/healthz'&&!url.search)return await reply(req,res,closing?503:200,{service:'crm-panel-read',revision,enabled,stopping:closing});
   if(url.pathname!=='/read')return await reply(req,res,404,{erro:'rota indisponível'});
   if(req.headers.origin&&req.headers.origin!==ORIGIN)return await reply(req,res,403,{erro:'origem não permitida'});
   if(req.method==='OPTIONS')return await reply(req,res,204,null);
   if(req.method!=='GET')return await reply(req,res,405,{erro:'método não permitido'});
   if(!enabled||closing||pending>=maxPending){record(req,'admission',{code:!enabled?'SERVICE_DISABLED':closing?'SERVICE_STOPPING':'ADMISSION_FULL'});return await reply(req,res,503,{erro:'consulta indisponível'});}
   const pairs=[...url.searchParams];
   if(pairs.length!==2||url.searchParams.getAll('action').length!==1||url.searchParams.getAll('painel').length!==1||url.searchParams.get('painel')!=='growth'||!['identity','cache_growth'].includes(url.searchParams.get('action')))return await reply(req,res,400,{erro:'consulta inválida'});
   const auth=req.headers.authorization;
   const authCount=req.rawHeaders.filter((_,i)=>i%2===0).filter(h=>h.toLowerCase()==='authorization').length;
   if(authCount!==1||typeof auth!=='string'||!/^Bearer [a-z0-9-]{8,128}$/.test(auth))return await reply(req,res,401,{erro:'chave de acesso ausente ou incorreta'});
   pending++;let timer,finished;
   const responseDone=new Promise(resolve=>{finished=resolve;});
   // Keep admission occupied until the actual query settles, including a late
   // transport response after the HTTP deadline. PostgreSQL has its own limit.
   const read=Promise.resolve().then(()=>pool.query(QUERY,[auth,req.headers.origin||null,JSON.stringify(Object.fromEntries(pairs))]));
   Promise.allSettled([read,responseDone]).then(()=>{pending--;});
   let phase='database',timedOut=false;
   read.catch(error=>{if(timedOut)record(req,'database-late',finiteFailure(error,'database'));});
   try{
    const result=await Promise.race([read,new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(Object.assign(Error('CRM_READ_DEADLINE'),{code:'CRM_READ_DEADLINE'}));},deadlineMs);})]);
    phase='result';if(result?.rows?.length!==1)throw Object.assign(Error('CRM_READ_SHAPE'),{code:'CRM_READ_SHAPE'});const {status_code,body}=result.rows[0];
    if(![200,400,401,403,503].includes(status_code)||!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(Error('CRM_READ_SHAPE'),{code:'CRM_READ_SHAPE'});
    if(status_code===503)record(req,'result',{code:body.erro==='cache indisponível'?'CACHE_UNAVAILABLE':'SQL_503_UNCLASSIFIED'});
    phase='response';
    await reply(req,res,status_code,body);
   }catch(error){record(req,phase,finiteFailure(error,phase));await reply(req,res,503,{erro:'consulta indisponível'});}
   finally{clearTimeout(timer);finished();}
  }catch(error){record(req,'handler',finiteFailure(error,'handler'));await reply(req,res,503,{erro:'consulta indisponível'}).catch(()=>res.destroy());}
 });
 const stop=()=>{closing=true;server.closeIdleConnections();return new Promise(resolve=>server.close(resolve));};
 return {server,stop,pending:()=>pending};
}
module.exports={createServer,QUERY,ORIGIN,acceptsGzip,finiteFailure};
