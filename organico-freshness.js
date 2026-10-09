/* Orgânico: carimbos de coleta por marca, sem consultar ou modificar a fonte. */
(function(root){
 'use strict';
 const BRANDS=Object.freeze({aristo:'Aristocrata',fish:'Fishermans',olivas:'Olivas'});
 const ALIASES=Object.freeze({aristo:'aristo',aristocrata:'aristo',fish:'fish',fishermans:'fish',olivas:'olivas'});
 const LIMITS=Object.freeze({freshMinutes:90,staleHours:26});
 const brand=value=>{if(typeof value!=='string')return null;const key=value.trim().toLowerCase();return Object.hasOwn(ALIASES,key)?ALIASES[key]:null;};
 function timestamp(value){
  if(typeof value!=='string')return null;
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if(!match)return null;
  const [,year,month,day,hour,minute,second,zoneHour,zoneMinute]=match;
  const calendar=new Date(0);calendar.setUTCFullYear(+year,+month-1,+day);
  if(calendar.getUTCFullYear()!==+year||calendar.getUTCMonth()!==+month-1||calendar.getUTCDate()!==+day||+hour>23||+minute>59||+second>59||zoneHour!==undefined&&(+zoneHour>23||+zoneMinute>59))return null;
  const t=Date.parse(value);return Number.isFinite(t)?t:null;
 }
 const unknown=()=>Object.freeze({state:'unknown',checkedAt:null,ageMinutes:null});
 function collection(rows,marca,field,now){
  if(!Number.isSafeInteger(now)||now<0||!Array.isArray(rows))return unknown();
  let latest=null,invalid=false;
  for(const row of rows){
   if(!row||typeof row!=='object'||brand(row.marca)!==marca)continue;
   const value=row[field];
   if(value===null||value===undefined||value==='')continue;
   const t=timestamp(value);
   if(t===null||t>now){invalid=true;continue;}
   if(latest===null||t>latest)latest=t;
  }
  // An invalid/future stamp in this brand cannot make a collection look fresh.
  if(invalid||latest===null)return unknown();
  const age=Math.round((now-latest)/60000);
  return Object.freeze({state:age>LIMITS.staleHours*60?'stale':age>LIMITS.freshMinutes?'aging':'fresh',checkedAt:new Date(latest).toISOString(),ageMinutes:age});
 }
 function select(payload,selected='todas',now=Date.now()){
  const key=brand(selected),keys=selected==='todas'?Object.keys(BRANDS):key?[key]:[];
  const p=payload&&typeof payload==='object'?payload:{};
  const groups=keys.map(marca=>Object.freeze({marca,label:BRANDS[marca],posts:unknown(),stories:collection(p.cx_story,marca,'ultima_coleta',now),sales:collection(p.organico_attribution?.coverage,marca,'checked_at',now)}));
  return Object.freeze({selected:key||(selected==='todas'?'todas':'unknown'),groups:Object.freeze(groups),unknown:groups.length===0||groups.some(g=>[g.posts,g.stories,g.sales].some(c=>c.state==='unknown')),stale:groups.some(g=>[g.stories,g.sales].some(c=>c.state==='stale'))});
 }
 const age=min=>min<60?min+' min':min<2880?Math.round(min/60)+' h':Math.round(min/1440)+' d';
 const description=(name,c)=>c.state==='unknown'?name+' sem confirmação':name+' '+(c.state==='stale'?'sem atualização ':'')+'há '+age(c.ageMinutes);
 function render(payload,selected,el,now=Date.now()){
  const report=select(payload,selected,now);
  if(!el)return report;
  const items=report.groups.flatMap(g=>[{label:g.label,name:'Stories (Instagram)',c:g.stories},{label:g.label,name:'Vendas (Shopify)',c:g.sales}]);
  const stale=items.filter(x=>x.c.state==='stale').sort((a,b)=>b.c.ageMinutes-a.c.ageMinutes);
  const missing=items.find(x=>x.c.state==='unknown');
  const known=items.filter(x=>x.c.state!=='unknown').sort((a,b)=>b.c.ageMinutes-a.c.ageMinutes);
  const focus=stale[0]||missing||known[0];
  el.textContent=focus?'coleta · '+focus.label+': '+description(focus.name,focus.c)+' · Posts sem confirmação':'coleta sem confirmação';
  el.title=report.groups.map(g=>g.label+':\n'+description('Posts',g.posts)+'\n'+description('Stories (Instagram)',g.stories)+'\n'+description('Vendas (Shopify)',g.sales)).join('\n\n');
  el.classList.toggle('velho',report.unknown||report.stale||items.some(x=>x.c.state==='aging'));
  return report;
 }
 const api=Object.freeze({select,render,LIMITS});
 root.OrganicFreshness=api;
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
