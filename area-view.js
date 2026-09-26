/* Visualização por papel em Influs & Afiliados e Orgânico, no mesmo contrato do CRM (growth-view.js).
   Só apresentação: a identidade vem do servidor (?access=1) e nenhum acesso, chave ou gravação muda.
   Gestor da área: sempre "manager". Acesso mestre (Felipe): escolhe entre ver como o gestor e
   "Dono · diagnóstico", que mostra saúde técnica das fontes e conferências. */
'use strict';
const AreaView=(()=>{
 const WAIT_MS=10000;
 function identityRole(value,panel){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.schema!=='shrigma_access_identity_v1'||!Array.isArray(value.allowedPanels))return null;
  const panels=value.allowedPanels;
  if(value.role==='manager'&&value.panel===panel&&panels.length===1&&panels[0]===panel)return 'manager';
  if(value.role==='master'&&value.panel==='todos'&&panels.length===4&&new Set(panels).size===4&&['cx','growth','organico','influs'].every(p=>panels.includes(p)))return 'master';
  return null;
 }
 function bind({document:doc,panel,key,apiUrl,fetchImpl,onChange}){
  const attempts=new Map();let activeKey='',generation=0,role=null,view='manager';
  const validKey=v=>typeof v==='string'&&/^[a-z0-9-]{8,128}$/.test(v)?v:'';
  const readKey=()=>{try{return validKey(key());}catch(_){return '';}};
  function paint(){
   if(!doc?.body)return;
   const before=doc.body.dataset.areaView;
   doc.body.dataset.areaView=view;
   const controls=doc.getElementById('area-view-controls'),select=doc.getElementById('area-view-select');
   if(controls)controls.hidden=role!=='master';
   if(select){select.disabled=role!=='master';try{select.value=view;}catch(_){for(const o of select.querySelectorAll('option'))o.toggleAttribute('selected',o.value===view);}}
   if(before&&before!==view&&typeof onChange==='function')onChange(view);
  }
  function reset(next){activeKey=next;generation++;role=null;view='manager';paint();}
  async function readIdentity(k){
   let timer;
   try{
    const url=new URL(typeof apiUrl==='function'?apiUrl():apiUrl);if(url.protocol!=='https:'||url.username||url.password)return null;
    url.searchParams.delete('k');url.searchParams.set('access','1');url.searchParams.set('painel',panel);
    const controller=new AbortController();
    const expired=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(null);},WAIT_MS);});
    return await Promise.race([expired,(async()=>{
     const r=await (fetchImpl||fetch)(url.href,{headers:{Authorization:'Bearer '+k},cache:'no-store',redirect:'error',credentials:'omit',signal:controller.signal});
     if(!r.ok||r.status!==200)return null;
     return identityRole(await r.json(),panel);
    })()]);
   }catch(_){return null;}
   finally{if(timer!==undefined)clearTimeout(timer);}
  }
  function resolve(){
   const k=readKey();if(k!==activeKey)reset(k);
   if(!k){role=null;view='manager';paint();return Promise.resolve(view);}
   const ticket=generation;
   if(!attempts.has(k))attempts.set(k,readIdentity(k));
   return attempts.get(k).then(confirmed=>{
    const now=readKey();
    if(ticket!==generation)return view;
    if(now!==k){reset(now);return view;}
    role=confirmed;if(role!=='master')view='manager';paint();return view;
   });
  }
  const select=doc?.getElementById('area-view-select');
  if(select)select.addEventListener('change',()=>{
   const now=readKey();if(now!==activeKey){reset(now);return;}
   view=role==='master'&&select.value==='owner'?'owner':'manager';paint();
  });
  paint();
  return {resolve,current:()=>view,role:()=>role};
 }
 return {bind,identityRole};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=AreaView;
