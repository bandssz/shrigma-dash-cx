/* Independent operator entry. Identity and allowed areas always come from the API. */
(function(){
 'use strict';
 // Espera longa e visivel enquanto a fila do servidor esta saturada. Mitigacao de interface: nao acelera o servidor.
 const ACCESS_WAIT_MS=180000;
 const AREAS={cx:{label:'CX/CS',page:'index.html'},growth:{label:'CRM',page:'growth.html'},organico:{label:'Orgânico',page:'organico.html'},influs:{label:'Influs & Afiliados',page:'influs.html'}};
 const requested=document.body.dataset.accessPanel,root=new URL('../',location.href),form=document.getElementById('entry-form'),field=document.getElementById('entry-key'),file=document.getElementById('entry-file'),message=document.getElementById('entry-message'),controls=document.getElementById('entry-fields'),cancel=document.getElementById('entry-cancel'),login=document.getElementById('entry-login'),shell=document.getElementById('entry-shell'),nav=document.getElementById('entry-nav'),host=document.getElementById('entry-frame');
 let key='',identity=null,frame=null,selected='',busy=false,epoch=0,expiry=null;
 const validKey=k=>typeof k==='string'&&/^[a-z0-9-]{8,128}$/.test(k);
 const validIdentity=i=>i?.schema==='shrigma_access_identity_v1'&&['master','manager'].includes(i.role)&&Array.isArray(i.allowedPanels)&&i.allowedPanels.length>0&&i.allowedPanels.every(p=>Object.hasOwn(AREAS,p))&&new Set(i.allowedPanels).size===i.allowedPanels.length&&(i.role==='master'?i.panel==='todos'&&i.allowedPanels.length===4:i.allowedPanels.length===1&&i.allowedPanels[0]===i.panel);
 function clearLegacy(){
  // Remove only credentials, never reservations, campaign journals, drafts or preferences.
  for(const slot of ['shrigma_k_cx','shrigma_k_growth','shrigma_k_organico','shrigma_k_influs','shrigma_k_mestre','shrigma_tpl_key','shrigma_ab_key','shrigma_influ_key','shrigma_tts_wkey'])try{localStorage.removeItem(slot);}catch(_){}
 }
 function logout(text='Acesso encerrado neste navegador.'){
  epoch++;key='';identity=null;selected='';clearTimeout(expiry);expiry=null;frame?.remove();frame=null;nav.replaceChildren();nav.hidden=true;shell.hidden=true;login.hidden=false;field.value='';file.value='';controls.disabled=false;cancel.hidden=true;busy=false;message.textContent=text;clearLegacy();field.focus();
 }
 function openPanel(panel){
  if(!identity||!key||!identity.allowedPanels.includes(panel))return;
  selected=panel;frame?.remove();frame=document.createElement('iframe');frame.title=AREAS[panel].label;frame.referrerPolicy='no-referrer';
  const url=new URL(AREAS[panel].page,root);url.searchParams.set('embed','1');frame.src=url.href;host.replaceChildren(frame);
  for(const b of nav.querySelectorAll('button'))b.setAttribute('aria-current',b.dataset.panel===panel?'page':'false');
  document.getElementById('entry-area').textContent=AREAS[panel].label;
 }
 function enter(i,k){
  clearLegacy();identity=i;key=k;field.value='';file.value='';login.hidden=true;shell.hidden=false;message.textContent='';
  document.getElementById('entry-owner').textContent=i.role==='master'?'Acesso mestre · Felipe':i.owner||'Gestor da área';
  nav.replaceChildren();nav.hidden=i.role!=='master';
  if(i.role==='master')for(const panel of i.allowedPanels){const b=document.createElement('button');b.type='button';b.dataset.panel=panel;b.textContent=AREAS[panel].label;b.onclick=()=>openPanel(panel);nav.append(b);}
  openPanel(Object.hasOwn(AREAS,requested)?requested:i.allowedPanels[0]);
  expiry=setTimeout(()=>logout('Sessão encerrada após 8 horas. Entre novamente.'),8*60*60*1000);
 }
 window.addEventListener('message',e=>{
  if(!frame||!identity||!key||e.source!==frame.contentWindow||e.origin!==location.origin||e.data?.type!=='shrigma:ready'||e.data.panel!==selected)return;
  const target=new URL(AREAS[selected].page,root);
  try{if(frame.contentWindow.location.pathname!==target.pathname)return;}catch(_){return;}
  frame.contentWindow.postMessage({type:'shrigma:read-access',panel:selected,key,permission:identity.permissions?.[selected]||null},location.origin);
 });
 async function readIdentity(url,k,controller){
  // O prazo cobre a resposta e o corpo JSON, mesmo quando o transporte ignora cancelamento.
  let deadline;
  const timeout=new Promise((_,reject)=>{deadline=setTimeout(()=>{controller.abort();reject(Error('ACCESS_TIMEOUT'));},ACCESS_WAIT_MS);});
  try{
   return await Promise.race([(async()=>{
    const r=await fetch(url,{headers:{Authorization:'Bearer '+k},cache:'no-store',redirect:'error',credentials:'omit',signal:controller.signal});
    if(r.status===401||r.status===403)throw Error('ACCESS_DENIED');
    if(!r.ok)throw Error('UNAVAILABLE');return await r.json();
   })(),timeout]);
  }finally{clearTimeout(deadline);}
 }
 document.getElementById('entry-logout').onclick=()=>logout();
 form.onsubmit=async e=>{
  e.preventDefault();if(busy)return;const k=field.value.trim(),ticket=++epoch;
  if(!validKey(k)){message.textContent='Informe uma chave de acesso válida.';field.focus();return;}
  busy=true;controls.disabled=true;field.value='';
  const controller=new AbortController(),limit=Math.round(ACCESS_WAIT_MS/1000);
  let desistiu=false,segundos=0;
  const texto=()=>{if(ticket!==epoch)return;message.textContent=segundos<8?'Conferindo seu acesso… '+segundos+'s':'O servidor está respondendo devagar. Conferindo seu acesso… '+segundos+'s de até '+limit+'s.';};
  texto();
  const relogio=setInterval(()=>{segundos++;texto();},1000);
  cancel.hidden=false;cancel.onclick=()=>{desistiu=true;controller.abort();};
  try{
   const url=new URL(CX_API_URL);url.searchParams.set('access','1');url.searchParams.set('painel',requested);
   const i=await readIdentity(url.href,k,controller);
   if(ticket!==epoch)return;
   if(!validIdentity(i)||(requested==='todos'?i.role!=='master':!i.allowedPanels.includes(requested)))throw Error('ACCESS_DENIED');
   enter(i,k);
  }catch(err){if(ticket===epoch)message.textContent=desistiu?'Espera cancelada. Nada foi aberto; você pode tentar de novo quando quiser.':err?.message==='ACCESS_DENIED'?'Esta chave não tem acesso a esta entrada. Confira o link e a credencial da sua área.':err?.message==='ACCESS_TIMEOUT'?'O servidor não confirmou o acesso em '+limit+'s. A demora é do servidor, não da sua chave. Tente novamente em alguns minutos.':'Não foi possível confirmar o acesso agora. Tente novamente.';}
  finally{clearInterval(relogio);cancel.hidden=true;cancel.onclick=null;if(ticket===epoch){busy=false;controls.disabled=false;if(!login.hidden)field.focus();}}
 };
 file.onchange=async()=>{
  const f=file.files?.[0],ticket=++epoch;if(!f||busy)return;busy=true;controls.disabled=true;field.value='';
  try{
   if(f.size>8192)throw Error();const data=JSON.parse(await f.text());
   if(ticket!==epoch)return;
   if(data?.schema!=='shrigma_area_access_v2'||!validKey(data.key)||!['cx','growth','organico','influs','todos'].includes(data.panel)||(data.panel!==requested&&data.panel!=='todos'))throw Error();
   field.value=data.key;message.textContent='Arquivo carregado. Clique em Entrar para confirmar seu acesso.';
  }catch(_){if(ticket===epoch)message.textContent='Arquivo inválido ou de outra área.';}
  finally{if(ticket===epoch){file.value='';controls.disabled=false;busy=false;field.focus();}}
 };
 window.addEventListener('pagehide',()=>{key='';identity=null;frame?.remove();});
})();
