/* Order-level attribution. No transport, credentials or browser identity matching. */
const CRMAttribution=(()=>{
 const VERSION='last-non-direct-30d-v2',DAY=864e5;
 const norm=v=>String(v??'').trim().toLowerCase();
 const time=v=>v?Date.parse(v):NaN;
 const own={fish:['fishermans.com.br','c0kfm1-qt.myshopify.com'],aristo:['oaristocrata.com','gwx20u-vw.myshopify.com'],olivas:['olivasdocampo.com.br','6r9bqn-ic.myshopify.com']};
 function host(url){const m=String(url||'').match(/^(?:https?:)?\/\/([^/?#]+)/i);return m?m[1].split('@').pop().split(':')[0].toLowerCase().replace(/\.$/,''):'';}
 function internal(url,brand){const h=host(url);return !!h&&(h==='pix-on-site.appmax.com.br'||(own[brand]||[]).some(d=>h===d||h.endsWith('.'+d)));}
 function channel(u){
  const s=norm(u?.source),m=norm(u?.medium);
  if(['organico','social','dm','dm-automation'].includes(m))return null;
  if(['email','listmonk'].includes(s)||s.includes('listmonk'))return 'email';
  if(['whatsapp','rptn'].includes(s)||s.includes('reportana'))return 'whatsapp';
  return null;
 }
 function visit(v,brand){
  if(!v||!Number.isFinite(time(v.occurredAt)))return null;
  const u=Object.fromEntries(['source','medium','campaign','content','term'].map(k=>[k,norm(v.utmParameters?.[k])]));
  const tagged=Object.values(u).some(Boolean),ref=String(v.referrerUrl||''),source=norm(v.source);
  const nonDirect=tagged||!!(ref&&!internal(ref,brand))||!!(source&&!['direct','unknown','(direct)'].includes(source)&&!internal(source.includes('://')?source:'https://'+source,brand));
  return {at:new Date(v.occurredAt).toISOString(),source:u.source,medium:u.medium,campaign:u.campaign,content:u.content,term:u.term,
   channel:channel(u),non_direct:nonDirect};
 }
 function classify(o){
  const brand=o._marca;if(!['fish','aristo','olivas'].includes(brand))throw Error('ATTRIBUTION_BRAND_INVALID');
  if(!/^gid:\/\/shopify\/Order\/\d+$/.test(o.id||'')||!Number.isFinite(time(o.createdAt))||!Number.isFinite(time(o.updatedAt)))throw Error('ATTRIBUTION_ORDER_INVALID');
  const j=o.customerJourneySummary,created=time(o.createdAt),money=o.netPaymentSet?.shopMoney;
  const financial=o.displayFinancialStatus,amount=money?.amount==null?null:Number(money.amount),currency=money?.currencyCode||null;
  const eligible=o.test===false&&!o.cancelledAt&&['PAID','PARTIALLY_REFUNDED'].includes(financial)&&currency==='BRL'&&Number.isFinite(amount)&&amount>0;
  const ready=j?.ready===true,complete=ready&&j.moments?.pageInfo?.hasNextPage===false;
  const valid=v=>v&&time(v.at)<=created&&time(v.at)>=created-30*DAY;
  const all=[...(j?.moments?.nodes||[]),...(complete?[j?.firstVisit]:[]),j?.lastVisit].map(v=>visit(v,brand)).filter(valid);
  const moments=[...new Map(all.map(v=>[[v.at,v.source,v.medium,v.campaign,v.content,v.term].join('|'),v])).values()].sort((a,b)=>time(a.at)-time(b.at));
  const last=visit(j?.lastVisit,brand),strict=valid(last)?last:null;
  const winner=[...moments].reverse().find(v=>v.non_direct)||null;
  // Recent-first pagination proves a found latest non-direct touch. Without a
  // winner, incomplete history must remain unknown, never "direct" by default.
  const nonDirectKnown=ready&&(!!winner||complete),strictKnown=ready&&!!strict;
  let reason=!eligible?'order_ineligible':!ready?'journey_not_ready':!nonDirectKnown?'journey_incomplete':winner?'attributed_visit':'direct_or_untracked';
  return {brand,order_id:o.id,order_name:String(o.name||''),created_at:o.createdAt,updated_at:o.updatedAt,
   test:o.test===true,cancelled:!!o.cancelledAt,financial_status:financial||'UNKNOWN',currency,net_amount:Number.isFinite(amount)?amount:null,
   eligible,ready,complete,strict_known:strictKnown,non_direct_known:nonDirectKnown,
   last_click:strictKnown?strict:null,last_non_direct:nonDirectKnown?winner:null,
   touches:ready?moments.filter(v=>v.channel):[],customer_order_index:Number(j?.customerOrderIndex)||null,
   reason,model_version:VERSION};
 }
 return {VERSION,norm,channel,visit,classify};
})();
if(typeof module!=='undefined')module.exports=CRMAttribution;
