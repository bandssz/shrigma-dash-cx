'use strict';
const fail=(code,status=403)=>{throw Object.assign(Error(code),{code,status});};
const exact=(x,keys)=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
const PATH='/auth/native-whatsapp-settings',CATALOG='/api/whatsapp-templates';
async function handle({req,res,url,ctx,auth,managerHost,crmHost}={}){
 if(![PATH,CATALOG].includes(url.pathname))return false;
 res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
 const send=value=>{res.statusCode=200;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));return true;};
 if(url.pathname===CATALOG){
  if(ctx.nativeBearer!==undefined||![managerHost,crmHost].includes(ctx.host))fail('WA_RESTRICTED_SESSION_REQUIRED');
  if(req.method!=='GET')fail('WA_READ_ONLY',405);const keys=[...url.searchParams.keys()];if(![1,2].includes(keys.length)||new Set(keys).size!==keys.length||!keys.includes('brand')||keys.some(k=>!['brand','after'].includes(k)))fail('WA_READ_INPUT_REFUSED',400);
  const brand=url.searchParams.get('brand'),after=url.searchParams.has('after')?url.searchParams.get('after'):undefined,connection=auth.whatsAppConnectionStore().resolve({context:ctx,brand});
  return send(await connection.listTemplates({after}));
 }
 if(ctx.host!==managerHost||ctx.nativeBearer!==undefined||url.search)fail('WA_OWNER_BROWSER_SESSION_REQUIRED');auth.authorize({...ctx,admin:true});
 const store=auth.whatsAppConnectionStore();if(req.method!=='POST')fail('WA_OWNER_METHOD_REFUSED',405);
 if(req.headers['content-encoding']||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))fail('WA_OWNER_CONTENT_TYPE_REFUSED',415);
 let size=0,parts=[];for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>16384)fail('WA_OWNER_INPUT_TOO_LARGE',413);parts.push(Buffer.from(chunk));}auth.authorize({...ctx,admin:true});let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{fail('WA_OWNER_INPUT_REFUSED',400);}
 try{
  if(body?.action==='status'&&exact(body,['action']))return send(store.status(ctx));
  if(body?.action==='bind-original-read'&&exact(body,['action','brand','token','original','expectedRevision']))return send(store.bind({context:ctx,brand:body.brand,token:body.token,original:body.original,expectedRevision:body.expectedRevision}));
  if(body?.action==='readmit-revoked-original-read'&&exact(body,['action','brand','token','original','expectedRevision','connectionRef']))return send(store.bind({context:ctx,brand:body.brand,token:body.token,original:body.original,expectedRevision:body.expectedRevision,connectionRef:body.connectionRef}));
  if(body?.action==='revoke'&&exact(body,['action','brand','connectionRef','expectedRevision']))return send(store.revoke({context:ctx,brand:body.brand,connectionRef:body.connectionRef,expectedRevision:body.expectedRevision}));
  fail('WA_OWNER_ACTION_REFUSED',400);
 }finally{if(body&&typeof body==='object')body.token='';parts=[];}
}
module.exports=Object.freeze({handle,PATH,CATALOG});
