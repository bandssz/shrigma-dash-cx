'use strict';
// Decision metrics use one brand, one period and one deduplicated attribution grain.
const CrmHome=(()=>{
 const day=v=>typeof v==='string'?v.slice(0,10):'',number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
 function dates(start,end){if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||start>end)return[];for(const d of [start,end]){const t=Date.parse(d+'T12:00:00Z');if(!Number.isFinite(t)||new Date(t).toISOString().slice(0,10)!==d)return[];}const days=[];for(let d=start;d<=end&&days.length<=366;d=new Date(Date.parse(d+'T12:00:00Z')+86400000).toISOString().slice(0,10))days.push(d);return days.length<=366?days:[];}
 function summarize(data,brand,start,end){
  const days=dates(start,end),a=data?.crm_attribution,covered=new Set((a?.coverage||[]).filter(r=>r.brand===brand&&typeof r.checked_at==='string'&&Number.isFinite(Date.parse(r.checked_at))).map(r=>day(r.day))),complete=a?.schema_version===2&&days.length>0&&days.every(d=>covered.has(d));
  const relevant=(a?.daily||[]).filter(r=>r.marca===brand&&days.includes(day(r.dia))&&r.model==='last_click'&&r.grain==='channel'&&r.dimension?.[0]==='email'),keys=relevant.map(r=>day(r.dia)),valid=complete&&new Set(keys).size===keys.length&&relevant.every(r=>number(r.receita)!==null&&number(r.pedidos)!==null);
  const sum=(rows,key)=>rows.length&&rows.every(r=>number(r[key])!==null)?rows.reduce((v,r)=>v+r[key],0):null;
  // No attribution row can mean zero only when every requested day is covered.
  const revenue=valid?relevant.reduce((v,r)=>v+r.receita,0):null,orders=valid?relevant.reduce((v,r)=>v+r.pedidos,0):null;
  const daily=(data?.crm_diario||[]).filter(r=>r.marca===brand&&r.canal==='email'&&days.includes(day(r.dia))),dailyDays=daily.map(r=>day(r.dia)),engagementComplete=days.length>0&&daily.length===days.length&&new Set(dailyDays).size===days.length;
  const metric=key=>engagementComplete?sum(daily,key):null,sent=metric('enviados'),delivered=metric('entregues'),opened=metric('abriram'),clicked=metric('clicaram');
  return{revenue,orders,sent,delivered,opened,clicked,openRate:delivered>0&&opened!==null?opened/delivered:null,clickRate:delivered>0&&clicked!==null?clicked/delivered:null,unsubscribed:metric('descadastros'),bounces:metric('hard'),complaints:metric('complaints'),coverage:{covered:days.filter(d=>covered.has(d)).length,expected:days.length,complete},engagementComplete,next:(data?.crm_campanha||[]).filter(r=>r.marca===brand&&r.status==='scheduled'&&Number.isFinite(Date.parse(r.agendado_em))).sort((a,b)=>Date.parse(a.agendado_em)-Date.parse(b.agendado_em)).slice(0,5),sourceTime:data?._cache_gerado_em||data?.gerado_em||null};
 }
 return Object.freeze({summarize,dates});
})();
if(typeof module==='object'&&module.exports)module.exports=CrmHome;else window.ShrigmaCrmHome=CrmHome;
