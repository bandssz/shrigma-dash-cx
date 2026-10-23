'use strict';
const PATH='/app/crm/restrito/descadastro/',SCRIPT='/app/crm/restrito/descadastro.js',API='/api/consent-job-status';
const fail=(code,status)=>{throw Object.assign(Error(code),{code,status});};
function handle({req,res,url,ctx,auth,host,managerHost,job,nativeContext=false}){
 if(![PATH,SCRIPT,API].includes(url.pathname))return false;
 if(nativeContext||host!==managerHost)fail('ADMIN_REQUIRED',403);
 if(req.method!=='GET')fail('METHOD_DENIED',405);
 auth.authorize({...ctx,method:'GET',admin:true});
 const js=url.pathname===SCRIPT,keys=[...url.searchParams.keys()];
 if(js&&url.search||!js&&(keys.length>1||keys.length===1&&keys[0]!=='brand'||url.pathname===API&&keys.length!==1))fail('CONSENT_STATUS_ARGUMENTS_INVALID',400);
 const brand=js?undefined:url.searchParams.get('brand')??'aristo';if(!js&&!['aristo','fish'].includes(brand))fail('BRAND_INVALID',400);
 if(!js)auth.authorize({...ctx,method:'GET',admin:true,brand});
 res.statusCode=200;res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(url.pathname===API){
  const value=job?job.status(brand):require('./campaign-consent-observation.cjs').createObservation({enabled:false}).status(brand);
  res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));return true;
 }
 const ui=require('./campaign-consent-observation-ui.cjs');
 res.setHeader('Content-Type',js?'text/javascript; charset=utf-8':'text/html; charset=utf-8');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
 res.end(js?ui.JS:require('./product-issues-ui.cjs').decorate(ui.HTML));return true;
}
module.exports={handle,PATH,SCRIPT,API};
