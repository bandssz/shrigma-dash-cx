'use strict';
// Only projected dashboard reads call this writer. No payload cache/coalescing;
// session DTOs, credentials, mutations and error responses keep sendJson.
function encoding(header){
 const values=new Map();
 for(const entry of String(header||'').toLowerCase().split(',')){
  const [name,...params]=entry.trim().split(';').map(x=>x.trim());if(!name)continue;let q=1;
  for(const p of params){const m=/^q=(.*)$/.exec(p);if(m)q=Math.min(q,/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(m[1])?Number(m[1]):0);}
  values.set(name,Math.min(values.get(name)??1,q));
 }
 return {identity:(values.get('identity')??values.get('*')??1)>0,gzip:(values.get('gzip')??values.get('*')??0)>0};
}
function fail(status,code){throw Object.assign(Error(code),{status,code});}
function createJsonEnd({gzip=require('node:zlib').gzip,maxActive=2,maxJobs=32,maxInputBytes=8*1024*1024}={}){
 const queue=[];let active=0,jobs=0,inputBytes=0;
 function drain(){while(active<maxActive&&queue.length){const t=queue.shift();active++;let settled=false;
  const done=(err,data)=>{if(settled)return;settled=true;active--;jobs--;inputBytes-=t.raw.length;
   if(err||!Buffer.isBuffer(data))t.reject(err||Error('JSON_GZIP_INVALID'));else t.resolve(data);drain();};
  try{gzip(t.raw,{level:1},done);}catch(e){done(e);}
 }}
 function compress(raw){if(jobs>=maxJobs||inputBytes+raw.length>maxInputBytes)return null;
  jobs++;inputBytes+=raw.length;return new Promise((resolve,reject)=>{queue.push({raw,resolve,reject});drain();});
 }
 return async function end(req,res,body,recheck){
  if(typeof recheck!=='function')fail(503,'ANALYTICS_ACCESS_FENCE_REQUIRED');
  let raw=Buffer.from(JSON.stringify(body),'utf8'),compressed=false;const accept=encoding(req.headers['accept-encoding']);
  if(!accept.identity&&!accept.gzip)fail(406,'ANALYTICS_ENCODING_UNAVAILABLE');
  if(accept.gzip&&(raw.length>=1024||!accept.identity)){
   const pending=compress(raw);let result;
   if(pending)try{result=await pending;}catch{if(!accept.identity)fail(503,'ANALYTICS_ENCODING_UNAVAILABLE');}
   if(result&&(result.length<raw.length||!accept.identity)){raw=result;compressed=true;}
   else if(!accept.identity)fail(503,'ANALYTICS_ENCODING_BUSY');
  }
  // Authorization may change while zlib is running or queued. Nothing has
  // been written yet; dispatch returns its usual 403 if this fence fails.
  recheck();if(res.destroyed||res.writableEnded)return;
  res.statusCode=200;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  const vary=String(res.getHeader('Vary')||'').split(',').map(x=>x.trim()).filter(Boolean);if(!vary.some(x=>x.toLowerCase()==='accept-encoding'))vary.push('Accept-Encoding');res.setHeader('Vary',vary.join(', '));
  if(compressed)res.setHeader('Content-Encoding','gzip');res.setHeader('Content-Length',raw.length);res.end(raw);
 };
}
module.exports={createJsonEnd};
