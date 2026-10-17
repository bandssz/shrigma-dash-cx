'use strict';
const http=require('node:http'),{gzip}=require('node:zlib'),{promisify}=require('node:util');
const compress=promisify(gzip),ORIGIN='https://bandssz.github.io';
const {compactHomeSource}=require('./home-projection.cjs');
const SOURCE_SHA256=require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(__filename)).digest('hex');
const QUERY='SELECT status_code,body FROM public.shrigma_crm_read_fast_v1($1::text,$2::text,$3::jsonb)';
const QUERY_HOME='SELECT status_code,body FROM public.shrigma_crm_home_read_20261016_v1($1::text,$2::text,$3::jsonb)';
function acceptsGzip(header=''){return header.split(',').some(x=>{const [name,...params]=x.trim().split(';');return name==='gzip'&&!params.some(p=>/^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(p));});}
function createServer({pool,revision,enabled=false,maxPending=16,deadlineMs=9000}){
 let pending=0,closing=false;
 async function reply(req,res,status,body,timing){
  if(res.destroyed||res.writableEnded)return;
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','Pragma':'no-cache','Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, OPTIONS','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Accept-Encoding'};
  if(status===503)headers['Retry-After']='5';
  const serialStart=performance.now();let bytes=Buffer.from(body===null?'':JSON.stringify(body));const rawBytes=bytes.length,serializeMs=performance.now()-serialStart;let gzipMs=0;
  if(bytes.length>1024&&acceptsGzip(req.headers['accept-encoding'])){const gzipStart=performance.now();bytes=await compress(bytes,{level:1});gzipMs=performance.now()-gzipStart;headers['Content-Encoding']='gzip';}
  if(timing){headers['X-Shrigma-Home-Projection']='validated-brand-v1';headers['Server-Timing']=[...Object.entries({...timing,serialize:serializeMs,gzip:gzipMs}).map(([k,v])=>k+';dur='+Math.max(0,v).toFixed(2)),'sourceBytes;desc="'+rawBytes+'"'].join(', ');}
  if(res.destroyed||res.writableEnded)return;headers['Content-Length']=bytes.length;res.writeHead(status,headers);res.end(bytes);
 }
 const server=http.createServer({maxHeaderSize:8192,requestTimeout:12000,headersTimeout:10000},async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');
   if(req.method==='GET'&&url.pathname==='/healthz'&&!url.search)return await reply(req,res,closing?503:200,{service:'crm-panel-read',revision,enabled,stopping:closing,sourceSha256:SOURCE_SHA256,homeReader:true});
   if(url.pathname!=='/read')return await reply(req,res,404,{erro:'rota indisponível'});
   if(req.headers.origin&&req.headers.origin!==ORIGIN)return await reply(req,res,403,{erro:'origem não permitida'});
   if(req.method==='OPTIONS')return await reply(req,res,204,null);
   if(req.method!=='GET')return await reply(req,res,405,{erro:'método não permitido'});
   if(!enabled||closing||pending>=maxPending)return await reply(req,res,503,{erro:'consulta indisponível'});
   const pairs=[...url.searchParams];
   if(pairs.length!==2||url.searchParams.getAll('action').length!==1||url.searchParams.getAll('painel').length!==1||url.searchParams.get('painel')!=='growth'||!['identity','cache_growth'].includes(url.searchParams.get('action')))return await reply(req,res,400,{erro:'consulta inválida'});
   const auth=req.headers.authorization;
   const authCount=req.rawHeaders.filter((_,i)=>i%2===0).filter(h=>h.toLowerCase()==='authorization').length;
   if(authCount!==1||typeof auth!=='string'||!/^Bearer [a-z0-9-]{8,128}$/.test(auth))return await reply(req,res,401,{erro:'chave de acesso ausente ou incorreta'});
   const home=req.headers['x-shrigma-crm-view']==='home'&&url.searchParams.get('action')==='cache_growth',brand=req.headers['x-shrigma-crm-home-brand'];
   if(brand!==undefined&&(!home||!['fish','aristo'].includes(brand)||req.rawHeaders.filter((_,i)=>i%2===0).filter(h=>h.toLowerCase()==='x-shrigma-crm-home-brand').length!==1))return await reply(req,res,400,{erro:'consulta inválida'});
   pending++;let timer,finished;
   const responseDone=new Promise(resolve=>{finished=resolve;});
   // Keep admission occupied until the actual query settles, including a late
   // transport response after the HTTP deadline. PostgreSQL has its own limit.
   const queryStart=performance.now();let dbQueryMs;const read=Promise.resolve().then(()=>pool.query(home?QUERY_HOME:QUERY,[auth,req.headers.origin||null,JSON.stringify(Object.fromEntries(pairs))])).then(result=>{dbQueryMs=performance.now()-queryStart;return result;});
   Promise.allSettled([read,responseDone]).then(()=>{pending--;});
   try{
    const result=await Promise.race([read,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CRM_READ_DEADLINE')),deadlineMs);})]);
    if(result?.rows?.length!==1)throw Error('CRM_READ_SHAPE');const {status_code,body}=result.rows[0];
    if(![200,400,401,403,503].includes(status_code)||!body||typeof body!=='object'||Array.isArray(body))throw Error('CRM_READ_SHAPE');
    let output=body,timing;if(status_code===200&&brand!==undefined){const start=performance.now();output=compactHomeSource(body,brand);timing={dbQuery:dbQueryMs,projection:performance.now()-start};}await reply(req,res,status_code,output,timing);
   }catch{await reply(req,res,503,{erro:'consulta indisponível'});}
   finally{clearTimeout(timer);finished();}
  }catch{await reply(req,res,503,{erro:'consulta indisponível'}).catch(()=>res.destroy());}
 });
 const stop=()=>{closing=true;server.closeIdleConnections();return new Promise(resolve=>server.close(resolve));};
 return {server,stop,pending:()=>pending};
}
module.exports={createServer,QUERY,QUERY_HOME,ORIGIN,acceptsGzip};
