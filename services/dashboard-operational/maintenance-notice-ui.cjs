'use strict';
function browser(){
 'use strict';
 if(window.parent!==window||window.ShrigmaMaintenanceNotice)return;window.ShrigmaMaintenanceNotice=true;
 let timer,expires=0,pending=false;
 function hide(){document.getElementById('maintenance-notice')?.remove();clearTimeout(timer);expires=0;}
 function render(data){
  if(!data?.active)return hide();
  const remaining=Date.parse(data.expiresAt)-Date.parse(data.serverTime);if(!(remaining>0))return hide();
  const date=new Date(data.restartAt);if(!Number.isFinite(date.getTime()))return hide();
  let banner=document.getElementById('maintenance-notice');if(!banner){banner=document.createElement('div');banner.id='maintenance-notice';banner.className='alert alert-warning rounded-0 m-0';banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');banner.style.cssText='position:sticky;top:0;z-index:1050;width:100%;box-sizing:border-box;overflow-wrap:anywhere';document.body.prepend(banner);}
  const text='O painel reinicia às '+new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',hour12:false}).format(date)+' por ~1 min; salve o que estiver aberto';
  if(banner.textContent!==text)banner.textContent=text;
  clearTimeout(timer);expires=Date.now()+remaining;timer=setTimeout(hide,remaining);
 }
 async function poll(){
  if(pending)return;pending=true;
  try{
   let session;if(typeof window.ShrigmaReadSession==='function')session=await window.ShrigmaReadSession();else{
    const r=await fetch('/auth/session',{credentials:'same-origin',cache:'no-store'});if(!r.ok){if([401,403].includes(r.status))hide();return;}session=await r.json();
   }if(!session.authenticated)return hide();
   const url=new URL(location.href),front=url.pathname.startsWith('/app/crm/')?'growth':url.pathname.startsWith('/app/organico/')?'organico':url.pathname.startsWith('/app/afiliados/')?'afiliados':url.pathname.startsWith('/app/influs/')?'influs':url.searchParams.get('front')||session.user.productFronts?.[0];
   const selected=document.getElementById('brand')?.value||document.getElementById('issue-brand')?.value||url.searchParams.get('brand')||session.user.brands?.[0],brand=selected==='todas'?session.user.brands?.find(b=>['aristo','fish'].includes(b)):selected;
   if(!['growth','organico','influs','afiliados'].includes(front)||!['aristo','fish'].includes(brand))return hide();
   const response=await fetch('/api/maintenance-notice?'+new URLSearchParams({brand,front}),{credentials:'same-origin',cache:'no-store'});
   if(response.ok)render(await response.json());else if([401,403].includes(response.status))hide();
  }catch{if(expires&&Date.now()>=expires)hide();}finally{pending=false;}
 }
 poll();setInterval(poll,60000);window.addEventListener('pageshow',poll);window.addEventListener('focus',poll);document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});document.addEventListener('change',e=>{if(['brand','issue-brand'].includes(e.target?.id)){hide();poll();}},true);window.addEventListener('popstate',()=>{hide();poll();});
}
const JS='('+browser.toString()+')();';
function decorate(html){const text=Buffer.isBuffer(html)?html.toString('utf8'):html;return text.includes('/app/maintenance-notice.js')?html:text.replace('</head>','<script defer src="/app/maintenance-notice.js"></script></head>');}
module.exports={JS,decorate};
