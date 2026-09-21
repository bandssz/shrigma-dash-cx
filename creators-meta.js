/* Meta reports stay separate from coupon revenue and affiliate commissions. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CreatorsMeta=api;})(typeof window!=='undefined'?window:globalThis,()=>{
 'use strict';
 const normalize=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
 function parseName(name){
  const raw=String(name||''),tokens=[...raw.matchAll(/\[([^\]]*)\]/g)].map(m=>m[1].trim()),format=tokens[1]||'',match=/^(UGC|IA|GR)(?:[-\s]|$)/i.exec(format);
  const category=match?match[1].toUpperCase():'não identificado';
  // The supplied examples put the person after the S- brand block and before an optional AD code.
  // Keep all suffixes/re-edits intact. Parsing proposes a label; it never assigns a person.
  const brandIndex=tokens.findIndex(t=>/^S-(FM|AR)$/i.test(t));
  const candidate=brandIndex>=0?tokens.slice(brandIndex+1).find(t=>t&&!/^AD[-\s]/i.test(t)&&!/^\d{2}\/\d{2}\/\d{2,4}$/.test(t)):null;
  return {raw,tokens,format,category,label:candidate||null,brandHint:brandIndex<0?null:tokens[brandIndex].toUpperCase()==='S-FM'?'fish':'aristo',needsReview:true};
 }
 function parseAd(ad){
  const direct=parseName(ad.ad_name);if(direct.category!=='não identificado')return {...direct,source:'anúncio',standard:true};
  const group=parseName(ad.adset_name);if(group.category!=='não identificado')return {...group,source:'conjunto',standard:true};
  // Existing live sets also carry descriptive UGC labels. Expose as legacy context, never identity.
  const legacy=/\b(UGC|IA|GR)\b\s*(?:[-–—:]\s*)?([^\[\]\n]*?)(?:\s[—–]\s|$)/i.exec(String(ad.adset_name||''));
  if(legacy)return {...group,raw:String(ad.adset_name),category:legacy[1].toUpperCase(),label:legacy[2]?.trim()||null,source:'conjunto (legado)',standard:false,needsReview:true};
  return {...direct,source:'não identificado',standard:false};
 }
 function suggestion(ad,creators){
  const p=parseAd(ad);if(p.category!=='UGC'||!p.label||p.brandHint&&p.brandHint!==ad.marca)return null;
  const label=normalize(p.label),matches=(creators||[]).filter(c=>c.marca===ad.marca&&[c.nome,c.handle,c.influ].some(v=>normalize(v)===label));
  return matches.length===1?matches[0].influ:null;
 }
 function metric(actions,type='offsite_conversion.fb_pixel_purchase'){
  if(!Array.isArray(actions))return null;const found=actions.filter(x=>x.action_type===type);
  if(found.length!==1||found[0]['7d_click']==null||String(found[0]['7d_click']).trim()=='')return null;
  const n=Number(found[0]['7d_click']);return Number.isFinite(n)&&n>=0?n:null;
 }
 function summary(ads,sources,marca='todas'){
  const selected=(ads||[]).filter(a=>marca==='todas'||a.marca===marca),source=(sources||[]).filter(s=>marca==='todas'||s.marca===marca);
  const compatible=selected.every(a=>a.currency==='BRL'&&a.model==='7d_click_conversion'&&a.timezone==='America/Sao_Paulo');
  const sum=k=>selected.length&&compatible&&selected.every(a=>a[k]!==null&&a[k]!==undefined&&Number.isFinite(Number(a[k])))?selected.reduce((n,a)=>n+Number(a[k]),0):null;
  const reported=k=>{const valid=selected.filter(a=>a[k]!=null&&Number.isFinite(Number(a[k])));return compatible&&valid.length?valid.reduce((n,a)=>n+Number(a[k]),0):null;};
  return {ads:selected.length,spend:sum('spend'),purchases:sum('purchases'),purchase_value:sum('purchase_value'),reported_purchases:reported('reported_purchases'),reported_purchase_value:reported('reported_purchase_value'),complete:source.length>0&&source.every(s=>s.covers_period===true),sources:source,compatible};
 }
 function byCreator(ads,creators,roi,marca='todas'){
  const groups=new Map();for(const a of ads||[]){if(!a.influ||marca!=='todas'&&a.marca!==marca)continue;const k=a.marca+'|'+a.influ;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(a);}
  return [...groups.values()].map(list=>{
   const a=list[0],c=(creators||[]).find(c=>c.marca===a.marca&&c.influ===a.influ),coupon=(roi||[]).find(c=>c.marca===a.marca&&c.influ===a.influ),s=summary(list,[]);
   return {marca:a.marca,influ:a.influ,name:c?.nome||a.influ,ads:list.length,spend:s.spend,meta_value:s.purchase_value??s.reported_purchase_value,meta_purchases:s.purchases??s.reported_purchases,partial:s.purchase_value==null||s.purchases==null,coupon_revenue:coupon?.receita_cupom??null};
  }).sort((a,b)=>(b.spend??-1)-(a.spend??-1));
 }
 function commission({products_after_discounts,product_refunds=0,paid,cancelled}){
  if(paid===false||cancelled===true)return 0;
  if(paid!==true||cancelled!==false)return null;
  if(products_after_discounts==null||product_refunds==null||![products_after_discounts,product_refunds].every(v=>Number.isFinite(Number(v))&&Number(v)>=0))return null;
  return Math.round(Math.max(0,Number(products_after_discounts)-Number(product_refunds))*7)/100;
 }
 function paymentDeadline(month){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return null;let [y,m]=month.split('-').map(Number);if(m===12){y++;m=1;}else m++;return `${y}-${String(m).padStart(2,'0')}-05`;}
 return {parseName,parseAd,suggestion,metric,summary,byCreator,commission,paymentDeadline};
});
