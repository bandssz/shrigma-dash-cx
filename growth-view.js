/* CRM view and direct-login permission resolution. Authority comes from identity. */
'use strict';
const GrowthView=(()=>{
 const WAIT_MS=10000,attempts=new Map(),failed=new Set(),boundSelectors=new WeakSet();
 let bound=false,activeKey='',generation=0,role=null,view='manager';
 let directPermission=null,directKey='';
 const doc=()=>typeof document==='undefined'?null:document;
 function key(){
  try{
   const value=typeof GrowthAccess!=='undefined'&&GrowthAccess.ready()?GrowthAccess.current():typeof shrigmaChave==='function'?shrigmaChave('growth'):'';
   return typeof value==='string'&&/^[a-z0-9-]{8,128}$/.test(value)?value:'';
  }catch(_){return '';}
 }
 function permission(value){
  const p=value?.permissions?.growth,allowed=['draft','validate','submit','read_content','list_history','submission'];
  if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).sort().join(',')!=='caps,label,who'
   ||typeof p.who!=='string'||!/^panel:[^\x00-\x20\x7f]{1,200}$/.test(p.who)
   ||typeof p.label!=='string'||!p.label||p.label.length>200||/[\x00-\x1f\x7f]/.test(p.label)
   ||!Array.isArray(p.caps)||p.caps.length>allowed.length||new Set(p.caps).size!==p.caps.length
   ||!p.caps.every(cap=>typeof cap==='string'&&allowed.includes(cap)))return null;
  return {caps:[...p.caps],label:p.label};
 }
 function identity(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.schema!=='shrigma_access_identity_v1'||!Array.isArray(value.allowedPanels))return null;
  const panels=value.allowedPanels;
  if(value.role==='manager'&&value.panel==='growth'&&panels.length===1&&panels[0]==='growth')return {role:'manager',permission:permission(value)};
  if(value.role==='master'&&value.panel==='todos'&&panels.length===4&&new Set(panels).size===4&&['cx','growth','organico','influs'].every(p=>panels.includes(p)))return {role:'master',permission:permission(value)};
  return null;
 }
 function paint(){
  const d=doc();if(!d?.body)return;
  d.body.dataset.crmView=view;
  const controls=d.getElementById('crm-view-controls'),select=d.getElementById('crm-view-select');
  if(controls)controls.hidden=role!=='master';
  if(select){select.disabled=role!=='master';select.value=view;}
 }
 function clearDirect(){
  if(directPermission&&typeof SHRIGMA_OPERATOR_SESSION!=='undefined'&&SHRIGMA_OPERATOR_SESSION.growth===directPermission)delete SHRIGMA_OPERATOR_SESSION.growth;
  directPermission=null;directKey='';
 }
 function reset(nextKey){clearDirect();activeKey=nextKey;generation++;role=null;view='manager';paint();}
 function confirmDirect(k,p){
  // Parent-provided embedded permission is owned by the validated portal handshake.
  if(typeof SHRIGMA_EMBEDDED!=='undefined'&&SHRIGMA_EMBEDDED)return;
  if(typeof SHRIGMA_OPERATOR_SESSION==='undefined'||typeof shrigmaGuardaChave!=='function')return;
  const changed=p?directKey!==k||JSON.stringify(directPermission)!==JSON.stringify(p):!!directPermission;
  clearDirect();
  if(p){shrigmaGuardaChave('growth',k);directPermission=p;directKey=k;SHRIGMA_OPERATOR_SESSION.growth=directPermission;}
  if(changed&&typeof window?.dispatchEvent==='function')window.dispatchEvent(new window.Event('shrigma:operator-ready'));
 }
 async function readIdentity(k){
  let timer;
  try{
   if(typeof CRM_READ_API_URL!=='string'||typeof fetch!=='function')return null;
   const url=new URL(CRM_READ_API_URL);if(url.protocol!=='https:'||url.username||url.password)return null;
   url.searchParams.delete('k');url.searchParams.set('action','identity');url.searchParams.set('painel','growth');
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
 function resolve({retry=false}={}){
  const k=key();if(k!==activeKey)reset(k);
  if(!k){role=null;view='manager';paint();return Promise.resolve(view);}
  const ticket=generation;
  if(retry&&failed.has(k)){failed.delete(k);attempts.delete(k);}
  if(!attempts.has(k))attempts.set(k,readIdentity(k));
  return attempts.get(k).then(confirmed=>{
   const now=key();
   if(ticket!==generation)return view;
   if(now!==k){reset(now);return view;}
   if(!confirmed||!confirmed.permission)failed.add(k);else failed.delete(k);
   role=confirmed?.role||null;if(role!=='master')view='manager';
   confirmDirect(k,confirmed?.permission||null);paint();return view;
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
