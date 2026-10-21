'use strict';
// Acquisition metadata only. Purchase/customer/product facts are never rebuilt here.
const VISIT='__typename ... on CustomerVisit { id occurredAt source sourceType landingPage referrerUrl utmParameters { source medium campaign content term } }';
const JOURNEY='ready customerOrderIndex momentsCount { count precision } moments(first:25,after:$after) { nodes { '+VISIT+' } pageInfo { hasNextPage endCursor } }';
const ORDERS_QUERY='query PaidAcquisitionOrders($ids:[ID!]!,$after:String){ shop { myshopifyDomain } nodes(ids:$ids) { ... on Order { id createdAt updatedAt discountCodes customerJourneySummary { '+JOURNEY+' } } } }';
const MOMENTS_QUERY='query PaidAcquisitionMoments($id:ID!,$after:String){ shop { myshopifyDomain } order(id:$id) { id createdAt updatedAt discountCodes customerJourneySummary { '+JOURNEY+' } } }';
const UTMS=['source','medium','campaign','content','term'],POLICY='last-non-direct-30-days-v1';
const clean=v=>typeof v==='string'&&v.trim()?v:null,lower=v=>(clean(v)||'').trim().toLowerCase();
function classify(v){
 const source=lower(v.utm?.source||v.source),medium=lower(v.utm?.medium),tactic=v.sourceType;
 if(['affiliate','affiliates','afiliado','afiliados'].includes(medium)||tactic==='AFFILIATE')return 'affiliate';
 if(['influ','influencer','influencers','influenciador','influenciadores'].includes(medium))return 'influencer';
 if(['email','e-mail','newsletter'].includes(medium)||['email','e-mail','listmonk','newsletter'].includes(source)||tactic==='NEWSLETTER')return 'email';
 if(/^(?:tiktok|tik-tok|tik_tok)(?:[ ._-].*)?$/.test(source)||/^https?:\/\/(?:[^/]+\.)?tiktok\.com(?:\/|$)/i.test(v.referrerUrl||''))return 'tiktok';
 if(['cpc','ppc','paid','paid_social','paid-social','paidsocial','cpm','display','retargeting'].includes(medium))return 'other';
 if(medium==='organic'||tactic==='SEO'||tactic==='POST'&&!['cpc','ppc','paid','paid_social','paidsocial'].includes(medium))return 'organic';
 if(['direct','(direct)','direct traffic'].includes(source)&&!Object.values(v.utm||{}).some(Boolean)&&!clean(v.referrerUrl))return 'direct';
 if(source&&!['unknown','an unknown source'].includes(source)||medium||tactic)return 'other';
 return 'unknown';
}
function visit(row){
 if(row?.__typename!=='CustomerVisit'||typeof row.id!=='string'||!Number.isFinite(Date.parse(row.occurredAt)))return null;
 const out={id:row.id,occurredAt:new Date(row.occurredAt).toISOString(),source:clean(row.source),sourceType:clean(row.sourceType),landingPage:clean(row.landingPage),referrerUrl:clean(row.referrerUrl),utm:Object.fromEntries(UTMS.map(k=>[k,clean(row.utmParameters?.[k])]))};
 return {...out,origin:classify(out)};
}
function webhook(order,observedAt){
 const landingPage=clean(order.landing_site),referrerUrl=clean(order.referring_site),source=clean(order.source_name);let params;
 try{if(landingPage)params=new URL(landingPage,'https://store.invalid').searchParams;}catch{}
 const codes=Array.isArray(order.discount_codes)&&order.discount_codes.every(c=>typeof c?.code==='string')?order.discount_codes.map(c=>c.code):null;
 const evidence={source,landingPage,referrerUrl,utm:Object.fromEntries(UTMS.map(k=>[k,params?.get('utm_'+k)||null])),discountCodes:codes,observedAt};
 return {schema:'crm-shopify-acquisition-v1',policy:POLICY,source:'shopify-orders-paid-webhook',observedAt,sourceUpdatedAt:order.updated_at,discountCodes:codes,utm:evidence.utm,origin:'unknown',selectedVisitId:null,selectedVisitAt:null,firstPurchase:null,journey:{ready:false,complete:false,reason:'not_collected',moments:[]},webhook:evidence};
}
function acquisition(order,{observedAt,complete,reason=null}){
 if(!order||!Array.isArray(order.discountCodes)||order.discountCodes.some(v=>typeof v!=='string')||!Number.isFinite(Date.parse(order.createdAt))||!Number.isFinite(Date.parse(order.updatedAt))||!Number.isFinite(Date.parse(observedAt)))throw Object.assign(Error('PAID_ACQUISITION_INCOMPLETE'),{code:'PAID_ACQUISITION_INCOMPLETE',status:409});
 const summary=order.customerJourneySummary,raw=summary?.moments?.nodes||[],visits=raw.map(visit).filter(Boolean),valid=complete===true&&summary?.ready===true&&visits.length===raw.length;
 const until=Date.parse(order.createdAt),from=until-30*86400000,eligible=visits.filter(v=>Date.parse(v.occurredAt)>=from&&Date.parse(v.occurredAt)<=until).sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt)||a.id.localeCompare(b.id));
 const nonDirect=eligible.filter(v=>v.origin!=='direct'),selected=valid?(nonDirect[0]||eligible[0]||null):null;
 return {schema:'crm-shopify-acquisition-v1',policy:POLICY,source:'shopify-admin-graphql-2026-10',observedAt:new Date(observedAt).toISOString(),sourceUpdatedAt:new Date(order.updatedAt).toISOString(),discountCodes:[...order.discountCodes],utm:selected?.utm||Object.fromEntries(UTMS.map(k=>[k,null])),origin:selected?.origin||'unknown',selectedVisitId:selected?.id||null,selectedVisitAt:selected?.occurredAt||null,firstPurchase:valid&&Number.isInteger(summary.customerOrderIndex)?summary.customerOrderIndex===1:null,journey:{ready:summary?.ready===true,complete:valid,reason:valid?null:reason||(!summary?'unavailable':!summary.ready?'not_ready':'incomplete'),moments:visits}};
}
async function completeJourney(order,{read,shop,maxPages=40}){
 let current=structuredClone(order),j=current?.customerJourneySummary;if(!j||j.ready!==true)return {order:current,complete:false,reason:j?'not_ready':'unavailable'};
 if(!Array.isArray(j.moments?.nodes)||typeof j.moments?.pageInfo?.hasNextPage!=='boolean')return {order:current,complete:false,reason:'incomplete'};
 const expected=j.momentsCount?.precision==='EXACT'?j.momentsCount.count:null,seen=new Set(),cursors=new Set();let pages=1;
 const inspect=nodes=>nodes.every(n=>n.__typename==='CustomerVisit'&&typeof n.id==='string'&&!seen.has(n.id)&&(seen.add(n.id),true));
 if(!inspect(j.moments.nodes))return {order:current,complete:false,reason:'duplicate_or_unsupported_moment'};
 while(j.moments.pageInfo.hasNextPage){
  const after=j.moments.pageInfo.endCursor;if(!after||cursors.has(after)||pages++>=maxPages)return {order:current,complete:false,reason:'pagination_incomplete'};cursors.add(after);
  const data=await read(MOMENTS_QUERY,{id:order.id,after}),next=data?.order,nj=next?.customerJourneySummary;
  if(data?.shop?.myshopifyDomain!==shop||next?.id!==order.id||next.updatedAt!==order.updatedAt||next.createdAt!==order.createdAt||JSON.stringify(next.discountCodes)!==JSON.stringify(order.discountCodes)||nj?.ready!==true||nj.customerOrderIndex!==j.customerOrderIndex||expected!==null&&(nj.momentsCount?.precision!=='EXACT'||nj.momentsCount.count!==expected)||!Array.isArray(nj.moments?.nodes)||typeof nj.moments?.pageInfo?.hasNextPage!=='boolean'||!inspect(nj.moments.nodes))return {order:current,complete:false,reason:'journey_changed'};
  j.moments.nodes.push(...nj.moments.nodes);j.moments.pageInfo=nj.moments.pageInfo;
 }
 if(expected!==null&&expected!==j.moments.nodes.length)return {order:current,complete:false,reason:'count_mismatch'};
 return {order:current,complete:true,reason:null};
}
module.exports={ORDERS_QUERY,MOMENTS_QUERY,UTMS,POLICY,acquisition,completeJourney,classify,webhook};
