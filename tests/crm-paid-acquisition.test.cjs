'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
const runtime=process.env.PAID_FACTS_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational');
const M=require(require('node:path').join(runtime,'crm-paid-acquisition.cjs'));
const S=require(require('node:path').join(runtime,'crm-paid-acquisition-service.cjs'));
const stamp='2026-10-21T18:00:00.000Z',shop='c0kfm1-qt.myshopify.com';
function visit(id,occurredAt='2026-10-21T17:00:00Z',patch={}){return {__typename:'CustomerVisit',id:'visit-'+id,occurredAt,source:'direct',sourceType:null,referrerUrl:null,landingPage:'https://synthetic.invalid/',utmParameters:null,...patch};}
function order(nodes=[visit(1)],patch={}){return {id:'gid://shopify/Order/1',createdAt:stamp,updatedAt:stamp,discountCodes:['SYNTHETIC'],customerJourneySummary:{ready:true,customerOrderIndex:1,momentsCount:{count:nodes.length,precision:'EXACT'},moments:{nodes,pageInfo:{hasNextPage:false,endCursor:null}}},...patch};}
const project=(o,complete=true)=>M.acquisition(o,{observedAt:stamp,complete});
test('last non-direct uses the middle visit, preserves all5 exact UTMs and coupon, and counts first purchase',()=>{
 const utm={source:'listmonk',medium:'email',campaign:'lm-281',content:'hero',term:'term raw'},o=order([visit(1,'2026-10-20T17:00:00Z'),visit(2,'2026-10-21T16:00:00Z',{source:'an unknown source',utmParameters:utm}),visit(3,'2026-10-21T17:00:00Z')]);
 const v=project(o);a.equal(v.origin,'email');a.equal(v.selectedVisitId,'visit-2');a.deepEqual(v.utm,utm);a.deepEqual(v.discountCodes,o.discountCodes);a.equal(v.firstPurchase,true);
});
test('direct is explicit evidence; unavailable, unready and empty journeys stay unknown',()=>{
 a.equal(project(order()).origin,'direct');for(const o of [order([]),order([], {customerJourneySummary:null}),order([visit(1)],{customerJourneySummary:{...order().customerJourneySummary,ready:false}})])a.equal(project(o).origin,'unknown');a.equal(project(order(),false).origin,'unknown');
});
test('last unknown visit blocks an earlier known non-direct channel',()=>{
 const v=project(order([visit(1,'2026-10-21T16:00:00Z',{utmParameters:{medium:'email'}}),visit(2,'2026-10-21T17:00:00Z',{source:'an unknown source'})]));a.equal(v.origin,'unknown');a.equal(v.selectedVisitId,'visit-2');
});
test('30-day boundary is inclusive and visits after order creation never win',()=>{
 const nodes=[visit(1,'2026-09-21T17:59:59.999Z',{utmParameters:{medium:'email'}}),visit(2,'2026-09-21T18:00:00.000Z',{utmParameters:{medium:'affiliate'}}),visit(3,'2026-10-21T18:00:00.001Z',{utmParameters:{medium:'email'}})];a.equal(project(order(nodes)).origin,'affiliate');
});
test('paid sources stay other; coupon alone never invents an influencer or affiliate',()=>{
 a.equal(project(order([visit(1,undefined,{source:'Instagram',utmParameters:{medium:'paid_social'}})])).origin,'other');a.equal(project(order()).origin,'direct');
 for(const [patch,expected]of [[{utm:{medium:'organic'}},'organic'],[{utm:{medium:'influencer'}},'influencer'],[{source:'TikTok'},'tiktok'],[{sourceType:'AFFILIATE'},'affiliate']])a.equal(M.classify(patch),expected);
});
test('explicit paid medium cannot receive organic credit even with SEO or POST tactic',()=>{for(const sourceType of ['SEO','POST'])for(const medium of ['cpc','paid','paid-social','paid_social','cpm'])a.equal(M.classify({source:'Google',sourceType,utm:{medium}}),'other');a.equal(M.classify({utm:{medium:' Organic '}}),'organic');});
test('webhook optional metadata never fabricates a complete journey or direct origin',()=>{
 const raw={updated_at:stamp,landing_site:'https://synthetic.invalid/?utm_source=listmonk&utm_medium=email&utm_campaign=lm-281&utm_content=hero&utm_term=words',discount_codes:[{code:'SYNTHETIC'}]},v=M.webhook(raw,stamp);a.equal(v.origin,'unknown');a.equal(v.journey.complete,false);a.equal(v.utm.campaign,'lm-281');a.deepEqual(v.discountCodes,['SYNTHETIC']);a.equal(M.webhook({},stamp).discountCodes,null);a.equal(M.webhook({...raw,discount_codes:[]},stamp).discountCodes.length,0);
});
test('relative Shopify landing paths retain all5UTMs without assuming a domain or direct channel',()=>{const v=M.webhook({landing_site:'/products/x?utm_source=listmonk&utm_medium=email&utm_campaign=lm-281&utm_content=hero&utm_term=words'},stamp);a.deepEqual(v.utm,{source:'listmonk',medium:'email',campaign:'lm-281',content:'hero',term:'words'});a.equal(v.origin,'unknown');});
test('all journey pages are fetched; a middle page can contain the last non-direct visit',async()=>{
 const o=order([visit(1)]);o.customerJourneySummary.momentsCount.count=3;o.customerJourneySummary.moments.pageInfo={hasNextPage:true,endCursor:'one'};let calls=0;
 const full=await M.completeJourney(o,{shop,read:async(q,v)=>{calls++;a.equal(q,M.MOMENTS_QUERY);a.equal(v.after,'one');const next=order([visit(2,'2026-10-21T17:30:00Z',{utmParameters:{medium:'email'}}),visit(3,'2026-10-21T17:50:00Z')]);next.customerJourneySummary.momentsCount.count=3;return {shop:{myshopifyDomain:shop},order:next};}});a.equal(calls,1);a.equal(full.complete,true);a.equal(project(full.order).origin,'email');a.equal(o.customerJourneySummary.moments.nodes.length,1);
});
test('moving, duplicated, truncated or mismatched page scopes never become complete',async()=>{
 for(const patch of [n=>n.updatedAt='2026-10-21T19:00:00Z',n=>n.customerJourneySummary.moments.nodes=[visit(1)],n=>n.customerJourneySummary.momentsCount.count=99]){const o=order([visit(1)]);o.customerJourneySummary.momentsCount.count=2;o.customerJourneySummary.moments.pageInfo={hasNextPage:true,endCursor:'one'};const next=order([visit(2)]);next.customerJourneySummary.momentsCount.count=2;patch(next);const full=await M.completeJourney(o,{shop,read:async()=>({shop:{myshopifyDomain:shop},order:next})});a.equal(full.complete,false);a.equal(project(full.order,full.complete).origin,'unknown');}
 const o=order([visit(1)]);o.customerJourneySummary.moments.pageInfo={hasNextPage:true,endCursor:'one'};a.equal((await M.completeJourney(o,{shop,maxPages:1,read:()=>a.fail('bounded')})).complete,false);
});
function service({revoke=false,race=false,backupFail=false,priorComplete=false,notReady=false,factTime=stamp}={}){
 let active=true,reads=0,writes=0,backed=false,closed=false,coverage=0;const auth=()=>{if(!active)throw Object.assign(Error('GRANT_DENIED'),{code:'GRANT_DENIED'});};
 const reader=S.create({authorize:auth,now:()=>Date.parse(stamp),openBackup:()=>({name:'synthetic-backup',append(rows){a.equal(writes,0);a.equal(rows.length,priorComplete&&notReady?0:1);if(backupFail)throw Error('disk failure');backed=true;},close(){closed=true;}}),database:async(work,write)=>work({query:async(sql,values)=>{if(sql===S.SELECT){reads++;return {rows:reads===1?[{order_id:'gid://shopify/Order/1',created_at:stamp,fact_updated_at:factTime,base_hash:'synthetic-base-hash',prior_acquisition:{webhook:{retained:true},journey:{complete:priorComplete}}}]:[]};}a.equal(sql,S.UPDATE);a.equal(write,true);a.equal(backed,true);const value=JSON.parse(values[2]);a.deepEqual(value.webhook,{retained:true});a.equal(value.factSourceUpdatedAt,factTime);a.equal(value.snapshotMatchesFact,Date.parse(factTime)===Date.parse(stamp));writes++;return {rowCount:race?0:1};}}),graphql:async(_brand,query)=>{a.equal(query,M.ORDERS_QUERY);if(revoke)active=false;const o=order();if(notReady)o.customerJourneySummary.ready=false;return {shop:{myshopifyDomain:shop},nodes:[o]};},store:{setCoverage(){coverage++;}}});
 return {reader,get writes(){return writes;},get closed(){return closed;},get coverage(){return coverage;}};
}
test('metadata-only enrichment backs up before a conditional update and never touches coverage',async()=>{const f=service(),r=await f.reader.enrich({},'fish');a.equal(r.stored,1);a.equal(r.complete,1);a.equal(r.orders,1);a.equal(f.closed,true);a.equal(f.coverage,0);a.doesNotMatch(S.UPDATE,/SET (?:payload|source_updated_at|checked_at)=/);a.match(S.UPDATE,/md5\(\(paid_fact-'acquisition'\)::text\)=\$4/);});
test('a concurrent purchase-fact change is skipped, never overwritten',async()=>{const f=service({race:true}),r=await f.reader.enrich({},'fish');a.equal(r.stored,0);a.equal(r.skipped,1);});
test('revocation during Shopify read prevents database writes',async()=>{const f=service({revoke:true});await a.rejects(f.reader.enrich({},'fish'),{code:'GRANT_DENIED'});a.equal(f.writes,0);a.equal(f.closed,true);});
test('backup failure prevents database writes',async()=>{const f=service({backupFail:true});await a.rejects(f.reader.enrich({},'fish'),/disk failure/);a.equal(f.writes,0);a.equal(f.closed,true);});
test('incomplete collection never erases an earlier complete origin',async()=>{const f=service({priorComplete:true,notReady:true}),r=await f.reader.enrich({},'fish');a.equal(f.writes,0);a.equal(r.skipped,1);a.equal(r.incomplete,1);});
test('new metadata snapshot records divergence while preserving the accepted purchase fact',async()=>{const f=service({factTime:'2026-10-21T17:00:00.000Z'}),r=await f.reader.enrich({},'fish');a.equal(r.stored,1);a.equal(f.writes,1);});
test('metadata queries select no customer or product and accept only bounded original IDs',()=>{for(const query of [M.ORDERS_QUERY,M.MOMENTS_QUERY])a.doesNotMatch(query,/\b(?:customer|lineItems|currentTotalPriceSet|email)\b/);for(const input of [[],['bad'],Array.from({length:11},(_,i)=>'gid://shopify/Order/'+(i+1))])a.throws(()=>S.ids(input),{code:'PAID_ACQUISITION_IDS_INVALID'});});
