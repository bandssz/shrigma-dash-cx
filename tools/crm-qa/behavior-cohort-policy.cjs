'use strict';
// Preparation only. No runtime route or source is wired to this policy.
// Readers must prove a historical recipient identity and individual event time.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const time=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const names=['received','opened','clicked','notOpened','notClicked'];
const unknown=code=>Object.freeze({schema:'crm-behavior-cohort-v1',state:'unknown',code,eligible:false,counts:Object.freeze(Object.fromEntries(names.map(k=>[k,null])))});
function measure({campaign,asOf,coverage,receipts,events}={}){
 if(!campaign||!['aristo','fish'].includes(campaign.brand)||!Number.isSafeInteger(campaign.id)||campaign.id<1||!UUID.test(campaign.uuid||''))return unknown('CAMPAIGN_IDENTITY_UNCONFIRMED');
 if(!time(asOf))return unknown('SNAPSHOT_TIME_UNCONFIRMED');const cutoff=Date.parse(asOf);
 if(!coverage||coverage.receiptPagesComplete!==true||coverage.receiptIdentityComplete!==true||coverage.unresolvedReceipts!==0||coverage.nativeEventsComplete!==true||coverage.nativeEventProjection!=='individual-timestamps'||coverage.nativeEventsAsOf!==asOf)return unknown('SOURCE_COVERAGE_UNCONFIRMED');
 if(!Array.isArray(receipts)||!Array.isArray(events))return unknown('SOURCE_ROWS_UNCONFIRMED');
 const received=new Map(),recipients=new Map(),opened=new Set(),clicked=new Set();
 const own=r=>r.brand===campaign.brand&&r.campaignId===campaign.id&&typeof r.campaignUuid==='string'&&r.campaignUuid.toLowerCase()===campaign.uuid.toLowerCase();
 for(const r of receipts){
  if(!r||!own(r)||r.kind!=='Delivery'||r.identityVerified!==true||r.headersTruncated!==false||!UUID.test(r.subscriberUuid||'')||!HASH.test(r.recipientKey||'')||!time(r.at))return unknown('RECEIPT_IDENTITY_UNCONFIRMED');
  if(Date.parse(r.at)>cutoff)continue;
  const id=r.subscriberUuid.toLowerCase();if(received.has(id)&&received.get(id)!==r.recipientKey||recipients.has(r.recipientKey)&&recipients.get(r.recipientKey)!==id)return unknown('RECIPIENT_AMBIGUOUS');
  received.set(id,r.recipientKey);recipients.set(r.recipientKey,id);
 }
 for(const e of events){
  if(!e||!own(e)||!['open','click'].includes(e.kind)||!UUID.test(e.subscriberUuid||'')||!time(e.at))return unknown('NATIVE_EVENT_UNCONFIRMED');
  const id=e.subscriberUuid.toLowerCase();if(Date.parse(e.at)>cutoff||!received.has(id))continue;
  (e.kind==='open'?opened:clicked).add(id);
 }
 return Object.freeze({schema:'crm-behavior-cohort-v1',state:'confirmed',eligible:true,snapshotAt:asOf,counts:Object.freeze({received:received.size,opened:opened.size,clicked:clicked.size,notOpened:received.size-opened.size,notClicked:received.size-clicked.size})});
}
module.exports={measure};
