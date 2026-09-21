const test=require('node:test'),assert=require('node:assert/strict'),M=require('../creators-meta.js');
test('supplied naming examples preserve labels and distinguish category from identity',()=>{
 for(const [name,label,brand] of [['[SUA💧][UGC-NT][N2][U][S-FM][MATHEUS UGC]27/08/26','MATHEUS UGC','fish'],['[VAI🔥][UGC-NT][N4][W003][S-AR][REEDIT 010.2 (NADIA E EDU 2)][AD-011.6]24/08/26','REEDIT 010.2 (NADIA E EDU 2)','aristo'],['[NAT🌿][UGC-NT][N3][W001][S-FM][NADIA E EDU R01][AD-024.2]17/08/26','NADIA E EDU R01','fish']]){const p=M.parseName(name);assert.equal(p.category,'UGC');assert.equal(p.label,label);assert.equal(p.brandHint,brand);assert(p.needsReview);assert.equal(p.raw,name);}
 assert.equal(M.parseName('[X][IA-NT][S-FM][X]').category,'IA');assert.equal(M.parseName('[X][GR-NT][S-AR][FERNANDO]').category,'GR');assert.equal(M.parseName('UGC sem padrão').category,'não identificado');assert.equal(M.parseName('[X][UGC-NT]').label,null);
});
test('matching is a suggestion only, exact and same brand, never fuzzy on reedits',()=>{
 const ad={marca:'fish',ad_name:'[X][UGC-NT][S-FM][Nádia e Edu]'},people=[{marca:'fish',influ:'nadia',nome:'Nadia e Edu'}];assert.equal(M.suggestion(ad,people),'nadia');assert.equal(M.suggestion(ad,[{...people[0],marca:'aristo'}]),null);assert.equal(M.suggestion(ad,[...people,...people]),null);assert.equal(M.suggestion({...ad,ad_name:'[X][UGC-NT][S-FM][Nadia e Edu R01]'},people),null);
});
test('overlapping Meta purchase action types are never added; missing is unknown',()=>{
 assert.equal(M.metric([{action_type:'purchase',value:'30'},{action_type:'offsite_conversion.fb_pixel_purchase',value:'30','7d_click':'20'},{action_type:'omni_purchase',value:'30'}]),20);assert.equal(M.metric([]),null);assert.equal(M.metric([{action_type:'offsite_conversion.fb_pixel_purchase',value:'2','7d_click':'0'}]),0);assert.equal(M.metric([{action_type:'offsite_conversion.fb_pixel_purchase',value:'4'},{action_type:'offsite_conversion.fb_pixel_purchase',value:'4'}]),null);
});
test('sources and incompatible grains cannot produce complete or additive financial totals',()=>{
 const a={marca:'fish',currency:'BRL',timezone:'America/Sao_Paulo',model:'7d_click_conversion',spend:10,purchases:null,purchase_value:null};const s=M.summary([a],[{marca:'fish',covers_period:false}]);assert.equal(s.spend,10);assert.equal(s.purchase_value,null);assert.equal(s.complete,false);assert.equal(M.summary([],[{covers_period:true}]).spend,null);assert.equal(M.summary([{...a,currency:'USD'}],[]).spend,null);
});
test('confirmed ad mappings compare a dedicated coupon field without adding attribution lenses',()=>{
 const ad={marca:'fish',influ:'x',currency:'BRL',timezone:'America/Sao_Paulo',model:'7d_click_conversion',spend:10,purchases:2,purchase_value:50};const x=M.byCreator([ad],[],[{marca:'fish',influ:'x',receita:100,receita_cupom:0}])[0];assert.equal(x.coupon_revenue,0);assert.equal(x.meta_value,50);assert.equal(M.byCreator([ad],[],[{marca:'fish',influ:'x',receita:100}])[0].coupon_revenue,null);assert.equal(M.byCreator([{...ad,influ:null}],[],[]).length,0);
});
test('partner commission uses paid product base, deducts refund once and never commission on cancellation',()=>{
 assert.equal(M.commission({products_after_discounts:100,product_refunds:20,paid:true,cancelled:false}),5.6);assert.equal(M.commission({products_after_discounts:100,paid:true,cancelled:true}),0);assert.equal(M.commission({products_after_discounts:100,paid:false}),0);assert.equal(M.commission({products_after_discounts:null,paid:true}),null);assert.equal(M.paymentDeadline('2026-12'),'2027-01-05');assert.equal(M.paymentDeadline('2026-09'),'2026-10-05');
});

test('live set labels are exposed with their origin, never presented as an ad naming match',()=>{
 const p=M.parseAd({ad_name:'AD-029.4 H1',adset_name:'UGC - Daniel Paris'});assert.equal(p.category,'UGC');assert.equal(p.label,'Daniel Paris');assert.equal(p.source,'conjunto (legado)');assert.equal(p.standard,false);assert(p.needsReview);
 const x=M.parseAd({ad_name:'[X][GR-NT][S-AR][Fernando]',adset_name:'UGC - Another'});assert.equal(x.category,'GR');assert.equal(x.source,'anúncio');
});

test('a general Meta value cannot masquerade as the explicit 7 day click window',()=>{assert.equal(M.metric([{action_type:'offsite_conversion.fb_pixel_purchase',value:'12'}]),null);assert.equal(M.metric([{action_type:'offsite_conversion.fb_pixel_purchase',value:'12','7d_click':'7'}]),7);});
