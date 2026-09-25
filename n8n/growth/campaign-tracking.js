/* Prepare tracking for an unsent Listmonk email; pure transformation, no network. */
'use strict';
const CampaignTracking=(()=>{
 const urlPattern=/https?:\/\/[^\s<>"']+/g;
 const config={aristo:{host:'oaristocrata.com'},fish:{host:'fishermans.com.br'},olivas:{host:'olivasdocampo.com.br'}};
 const id=v=>Number.isSafeInteger(Number(v))&&Number(v)>0;
 function inspect(c,{brand,campaign,now=Date.now()}={},assignIdentity=true){
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
    const redirect=u.searchParams.get('redirect');if(!redirect)throw Error('Coupon has no explicit destination');
    target=new URL(redirect,u.origin);
    if(target.origin!==u.origin||!/^\/(products|pages|collections)\//.test(target.pathname))throw Error('Coupon destination is outside the store');
    coupon=true;
   }
   if(/^\/(products|pages|collections)\//.test(target.pathname))commercialLinks++;
   for(const [k,v] of [['utm_source','listmonk'],['utm_medium','campanha'],['utm_campaign',campaign]]){
    const old=target.searchParams.get(k);if(old&&old!==v)throw Error('Conflicting existing '+k);
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
 return {prepare:(c,o)=>inspect(c,o,true),check:(c,o)=>inspect(c,o,false)};
})();
if(typeof module!=='undefined')module.exports=CampaignTracking;
