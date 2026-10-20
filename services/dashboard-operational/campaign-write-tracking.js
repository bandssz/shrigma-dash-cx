/* Prepare tracking for an unsent Listmonk email; pure transformation, no network. */
'use strict';
const CampaignTracking=(()=>{
 const urlPattern=/https?:\/\/[^\s<>"']+/g;
 const config={aristo:{host:'oaristocrata.com'},fish:{host:'fishermans.com.br'},olivas:{host:'olivasdocampo.com.br'}};
 const id=v=>Number.isSafeInteger(Number(v))&&Number(v)>0;
 const expected=campaign=>[['utm_source','listmonk'],['utm_medium','campanha'],['utm_campaign',campaign]];
 const issue=(code,message)=>Object.assign(Error(message),{code});
 function link(raw,brand){
  const shorthand=raw.endsWith('@TrackLink'),literal=shorthand?raw.slice(0,-10):raw,entity=literal.includes('&amp;');let u;try{u=new URL(literal.replace(/&amp;/g,'&'));}catch{return null;}
  const host=config[brand]?.host;if(!host||![host,'www.'+host].includes(u.hostname)||u.username||u.password||u.port||!/^\/(products|pages|collections|discount)(\/|$)/.test(u.pathname))return null;
  const coupon=u.pathname.startsWith('/discount/'),redirect=coupon?u.searchParams.get('redirect'):null;let target=u,invalid=false;
  if(coupon&&redirect)try{target=new URL(redirect,u.origin);invalid=target.origin!==u.origin||!!target.username||!!target.password||!!target.port||!/^\/(products|pages|collections)\//.test(target.pathname);}catch{invalid=true;}
  return{u,target,coupon,redirect,invalid,shorthand,entity};
 }
 const serialize=(p,u)=>{let out=u.href+(p.shorthand?'@TrackLink':'');return p.entity?out.replace(/&/g,'&amp;'):out;};
 function review(c,{brand,campaign}={}){
  if(!config[brand]||typeof campaign!=='string')throw Error('Brand and campaign are required');const issues=[];
  for(const[field,value]of [['body',c.body],['altbody',c.altbody]])String(value||'').replace(urlPattern,raw=>{const p=link(raw,brand);if(!p)return raw;if(p.coupon&&!p.redirect)issues.push({field,url:raw,code:'COUPON_DESTINATION_REQUIRED'});else if(p.invalid)issues.push({field,url:raw,code:'COUPON_DESTINATION_INVALID'});
   for(const[k,v]of expected(campaign)){const targets=p.coupon&&p.redirect&&!p.invalid?[p.target,p.u]:[p.u];if(targets.some(u=>u.searchParams.getAll(k).some(old=>old&&old!==v)))issues.push({field,url:raw,code:'UTM_CONFLICT',parameter:k});}return raw;});
  return{issues};
 }
 function adjust(c,{brand,campaign}={}){
  if(!config[brand]||!/^[a-z0-9_-]+$/.test(campaign||''))throw Error('Brand and campaign are required');let changes=0;
  const rewrite=value=>String(value||'').replace(urlPattern,raw=>{const p=link(raw,brand);if(!p)return raw;if(p.invalid)throw issue('COUPON_DESTINATION_INVALID','Coupon destination is outside the store');
   const target=p.coupon&&p.redirect?p.target:p.u;for(const[k,v]of expected(campaign))target.searchParams.set(k,v);
   if(p.coupon&&p.redirect){p.u.searchParams.set('redirect',target.pathname+target.search+target.hash);for(const[k,v]of expected(campaign))if(p.u.searchParams.has(k))p.u.searchParams.set(k,v);}
   const out=serialize(p,p.u);if(out!==raw)changes++;return out;});return{body:rewrite(c.body),altbody:c.altbody==null?c.altbody:rewrite(c.altbody),changes};
 }
 function setCouponDestination(c,{brand,url,destination}={}){
  const selected=link(url,brand);if(!selected?.coupon)throw issue('COUPON_DESTINATION_INVALID','Choose a store coupon link');let target;try{target=new URL(destination,selected.u.origin);}catch{throw issue('COUPON_DESTINATION_INVALID','Choose a store destination');}
  if(target.origin!==selected.u.origin||target.username||target.password||target.port||!/^\/(products|pages|collections)\//.test(target.pathname))throw issue('COUPON_DESTINATION_INVALID','Coupon destination is outside the store');let changes=0;
  const rewrite=value=>String(value||'').replace(urlPattern,raw=>{const p=link(raw,brand);if(!p?.coupon||p.u.href!==selected.u.href)return raw;p.u.searchParams.set('redirect',target.pathname+target.search+target.hash);const out=serialize(p,p.u);if(out!==raw)changes++;return out;});return{body:rewrite(c.body),altbody:c.altbody==null?c.altbody:rewrite(c.altbody),changes};
 }
 function inspect(c,{brand,campaign,now=Date.now()}={},assignIdentity=true,{allowConflictingUtms=false,allowMissingCoupon=false,legacyReceipt=false,editorialAdmitted=false}={}){
  if(!config[brand]||!campaign||!/^[a-z0-9_-]+$/.test(campaign))throw Error('Brand and campaign are required');
  if((assignIdentity&&!id(c.id))||!['draft','scheduled'].includes(c.status)||Number(c.sent)!==0||c.started_at)throw Error('Only unsent draft/scheduled campaigns can be prepared');
  if(c.status==='scheduled'&&!(Date.parse(c.send_at)>now+15*60e3))throw Error('Campaign is too close to sending');
  if(c.content_type!=='html'||c.body_source)throw Error('Only HTML campaigns without visual source are supported');
  const lists=[...new Set((c.lists||[]).map(l=>Number(l.id??l)))].sort((a,b)=>a-b);
  if(!lists.length||!lists.every(id))throw Error('Verified list IDs are required');
  const token=assignIdentity?`lm-${c.id}-l${lists.join('-')}`:null,changes=[];let commercialLinks=0;
  function transform(raw,field){
   const shorthand=raw.endsWith('@TrackLink'),literal=shorthand?raw.slice(0,-10):raw;
   const entity=literal.includes('&amp;'),decoded=literal.replace(/&amp;/g,'&');let u;
   try{u=new URL(decoded);}catch{return raw;}
   const host=config[brand].host;
   if(![host,'www.'+host].includes(u.hostname)||u.username||u.password||u.port)return raw;
   if(!/^\/(products|pages|collections|discount)(\/|$)/.test(u.pathname))return raw;
   const original=new URL(u.href);let target=u,coupon=false;
   if(u.pathname.startsWith('/discount/')){
    const redirect=u.searchParams.get('redirect');if(!redirect){if(allowMissingCoupon){commercialLinks++;return raw;}throw issue('COUPON_DESTINATION_REQUIRED','Coupon has no explicit destination');}
    try{target=new URL(redirect,u.origin);}catch(e){if(editorialAdmitted)return raw;throw e;}
    if(editorialAdmitted&&(target.origin!==u.origin||target.username||target.password||target.port||!/^\/(products|pages|collections)\//.test(target.pathname)))return raw;
    if(target.origin!==u.origin||!legacyReceipt&&(target.username||target.password||target.port)||!/^\/(products|pages|collections)\//.test(target.pathname))throw issue('COUPON_DESTINATION_INVALID','Coupon destination is outside the store');
    coupon=true;
   }
   if(/^\/(products|pages|collections)\//.test(target.pathname))commercialLinks++;
   for(const [k,v] of [['utm_source','listmonk'],['utm_medium','campanha'],['utm_campaign',campaign]]){
    if(allowConflictingUtms&&target.searchParams.getAll(k).some(old=>old&&old!==v))continue;const old=target.searchParams.get(k);if(old&&old!==v)throw Error('Conflicting existing '+k);
    target.searchParams.set(k,v);
   }
   const content=target.searchParams.get('utm_content')||(coupon?'cupom-auto':field==='altbody'?'alt-link':'link');
   target.searchParams.set('utm_content',content);
   let previous=target.searchParams.get('utm_term')||'';
   // A cloned campaign keeps its experiment label, never another dispatch identity.
   const managedSuffix=/(?:^|--)lm-[1-9]\d*-l[1-9]\d*(?:-[1-9]\d*)*$/;
   while(managedSuffix.test(previous))previous=previous.replace(managedSuffix,'');
   if(assignIdentity)target.searchParams.set('utm_term',previous?previous+'--'+token:token);
   if(coupon)u.searchParams.set('redirect',target.pathname+target.search+target.hash);
   let result=u.href+(shorthand?'@TrackLink':'');if(entity)result=result.replace(/&/g,'&amp;');
   if(result!==raw)changes.push({field,before:raw,after:result,content,term:target.searchParams.get('utm_term'),coupon});
   // Routing, variant and coupon code remain exactly the same after stripping tracking.
   const clean=x=>{const q=new URL(x);for(const k of [...q.searchParams.keys()])if(k.startsWith('utm_'))q.searchParams.delete(k);return q;};
   if(coupon){const before=new URL(original.searchParams.get('redirect'),original.origin);if(clean(before).href!==clean(target).href)throw Error('Coupon routing changed');}
   else if(clean(original).href!==clean(u).href)throw Error('Product routing changed');
   return result;
  }
  const body=String(c.body||'').replace(urlPattern,raw=>transform(raw,'body'));
  const altbody=c.altbody==null?c.altbody:String(c.altbody).replace(urlPattern,raw=>transform(raw,'altbody'));
  if(!body)throw Error('Empty HTML body');
  return assignIdentity?{id:c.id,token,lists,body,altbody,changes}:{commercial_links:commercialLinks};
 }
 const draft={allowConflictingUtms:true,allowMissingCoupon:true},schedule={allowConflictingUtms:true,allowMissingCoupon:false};
 // Admission uses checkDraft before any save. Receipt recomposition must retain
 // the old deterministic serialization, including already committed snapshots.
 return {prepareAdmitted:(c,o)=>inspect(c,o,true,{...draft,editorialAdmitted:true}),prepareLegacyReceipt:(c,o)=>inspect(c,o,true,{legacyReceipt:true}),prepare:(c,o)=>inspect(c,o,true),check:(c,o)=>inspect(c,o,false),prepareDraft:(c,o)=>inspect(c,o,true,{...draft,legacyReceipt:true}),checkDraft:(c,o)=>inspect(c,o,false,draft),prepareSchedule:(c,o)=>inspect(c,o,true,schedule),checkSchedule:(c,o)=>inspect(c,o,false,schedule),review,adjust,setCouponDestination};
})();
if(typeof module!=='undefined')module.exports=CampaignTracking;
