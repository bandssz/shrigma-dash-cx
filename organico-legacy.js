/* Presentation of the existing historical projection only.
 * No attribution, deduplication of orders, piece matching or UTM convention here.
 */
const OLegacy = (() => {
  'use strict';
  const BRANDS = {aristo:'Aristocrata',fish:'Fishermans',olivas:'Olivas'};
  const ALIASES = {aristo:'aristo',aristocrata:'aristo',fish:'fish',fishermans:'fish',olivas:'olivas'};
  const brand = value => { const raw=String(value??'').trim(),key=raw.toLowerCase(); return Object.hasOwn(ALIASES,key) ? ALIASES[key] : raw || null; };
  const text = value => value === null || value === undefined || value === '' ? null : String(value);
  function number(value) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) return null;
    const n=Number(value); return Number.isFinite(n) ? n : null;
  }
  const count = value => { const n=number(value); return n!==null && Number.isSafeInteger(n) && n>=0 ? n : null; };
  const add = (total,value) => total===null || value===null || !Number.isFinite(total+value) ? null : total+value;
  const addCount = (total,value) => { const sum=add(total,value); return sum!==null && Number.isSafeInteger(sum) ? sum : null; };
  function aggregate(input) {
    if (!Array.isArray(input)) return {available:false,rows:[],total:{ped:null,rec:null,ass:null}};
    const groups=new Map();
    for (const row of input) {
      const r=row && typeof row==='object' ? row : {};
      // Preserve the historical display normalization. These are not piece identities.
      let sup=text(r.superficie_utm),prod=text(r.produto_utm)?.toLowerCase()??null;
      if (prod==='link_in_bio') { sup='bio'; prod=null; }
      if (String(r.utm_medium||'').startsWith('dm')) { sup='dm (automação)'; prod=String(r.utm_content||'replient').toLowerCase(); }
      const camp=r.utm_campaign && r.utm_campaign!=='(sem)' && r.utm_campaign!=='venda' ? String(r.utm_campaign) : null;
      const marca=brand(r.marca),rede=text(r.rede),key=JSON.stringify([marca,rede,sup,prod,camp]);
      const group=groups.get(key)||{marca,rede,sup,prod,camp,ped:0,rec:0,ass:0,ident:new Map(),unidentified:0,sourceRows:0};
      group.ped=addCount(group.ped,count(r.pedidos_ultimo));
      group.rec=add(group.rec,number(r.receita_ultimo));
      group.ass=addCount(group.ass,count(r.pedidos_assistido));
      const post=text(r.post_id),story=text(r.story_id);
      if (post || story) group.ident.set(JSON.stringify([post,story]),text(r.apelido)||post||story);
      else group.unidentified++;
      group.sourceRows++;
      groups.set(key,group);
    }
    const rows=[...groups.values()].map(r=>({...r,ident:[...r.ident.values()]}));
    // Unknown money never becomes zero just to sort the table.
    rows.sort((a,b)=>(a.sup==='bio')-(b.sup==='bio') || (a.rec===null)-(b.rec===null)
      || (a.rec!==null && b.rec!==null ? b.rec-a.rec : 0) || String(a.marca||'').localeCompare(String(b.marca||'')));
    const total=rows.length ? rows.reduce((t,r)=>({ped:addCount(t.ped,r.ped),rec:add(t.rec,r.rec),ass:addCount(t.ass,r.ass)}),{ped:0,rec:0,ass:0}) : {ped:null,rec:null,ass:null};
    return {available:true,rows,total};
  }
  return {BRANDS,brand,number,count,aggregate};
})();
if (typeof module!=='undefined') module.exports=OLegacy;
