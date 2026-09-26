/* Presentation only. Server capabilities, credentials and operation journals stay unchanged. */
'use strict';
const GrowthView=(()=>{
 const WAIT_MS=10000,attempts=new Map(),boundSelectors=new WeakSet();
 let bound=false,activeKey='',generation=0,role=null,view='manager';
 const doc=()=>typeof document==='undefined'?null:document;
 function key(){
  try{
   const value=typeof GrowthAccess!=='undefined'&&GrowthAccess.ready()?GrowthAccess.current():typeof shrigmaChave==='function'?shrigmaChave('growth'):'';
   return typeof value==='string'&&/^[a-z0-9-]{8,128}$/.test(value)?value:'';
  }catch(_){return '';}
 }
 function identity(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.schema!=='shrigma_access_identity_v1'||!Array.isArray(value.allowedPanels))return null;
  const panels=value.allowedPanels;
  if(value.role==='manager'&&value.panel==='growth'&&panels.length===1&&panels[0]==='growth')return 'manager';
  if(value.role==='master'&&value.panel==='todos'&&panels.length===4&&new Set(panels).size===4&&['cx','growth','organico','influs'].every(p=>panels.includes(p)))return 'master';
  return null;
 }
 function paint(){
  const d=doc();if(!d?.body)return;
  d.body.dataset.crmView=view;
  const controls=d.getElementById('crm-view-controls'),select=d.getElementById('crm-view-select');
  if(controls)controls.hidden=role!=='master';
  if(select){select.disabled=role!=='master';select.value=view;}
 }
 function reset(nextKey){activeKey=nextKey;generation++;role=null;view='manager';paint();}
 async function readIdentity(k){
  let timer;
  try{
   if(typeof CX_API_URL!=='string'||typeof fetch!=='function')return null;
   const url=new URL(CX_API_URL);if(url.protocol!=='https:'||url.username||url.password)return null;
   url.searchParams.delete('k');url.searchParams.set('access','1');url.searchParams.set('painel','growth');
   const controller=new AbortController();
   const expired=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(null);},WAIT_MS);});
   return await Promise.race([expired,(async()=>{
    const response=await fetch(url.href,{headers:{Authorization:'Bearer '+k},cache:'no-store',redirect:'error',credentials:'omit',signal:controller.signal});
    if(!response.ok||response.status!==200)return null;
    return identity(await response.json());
   })()]);
  }catch(_){return null;}
  finally{if(timer!==undefined)clearTimeout(timer);}
 }
 function resolve(){
  const k=key();if(k!==activeKey)reset(k);
  if(!k){role=null;view='manager';paint();return Promise.resolve(view);}
  const ticket=generation;
  if(!attempts.has(k))attempts.set(k,readIdentity(k));
  return attempts.get(k).then(confirmed=>{
   const now=key();
   if(ticket!==generation)return view;
   if(now!==k){reset(now);return view;}
   role=confirmed;if(role!=='master')view='manager';paint();return view;
  });
 }
 function init(){
  const select=doc()?.getElementById('crm-view-select');
  if(select&&!boundSelectors.has(select)){
   boundSelectors.add(select);
   select.addEventListener('change',()=>{
    const now=key();
    if(now!==activeKey){reset(now);return;}
    view=role==='master'&&select.value==='owner'?'owner':'manager';paint();
   });
  }
  if(!bound&&typeof window!=='undefined'&&typeof window.addEventListener==='function'){
   bound=true;window.addEventListener('shrigma:access-ready',resolve);
  }
  paint();return resolve();
 }
 return {init,resolve,current:()=>view};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GrowthView;
