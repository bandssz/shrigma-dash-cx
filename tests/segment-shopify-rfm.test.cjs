'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../n8n/growth/segment-shopify-rfm.cjs'),A=require('../n8n/growth/segment-audience-contract.js');
const Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
const hash='a'.repeat(64),stamp='2026-10-01T12:00:00.000Z';
function provenance(brand='fish') {return {brand,shop_id:'gid://shopify/Shop/'+(brand==='fish'?1:2),operation_id:'11111111-1111-4111-8111-111111111111',customer_bulk:{gid:'gid://shopify/BulkOperation/11',query_sha256:hash,payload_sha256:'b'.repeat(64),status:'COMPLETED',object_count:3},paid_orders_bulk:{gid:'gid://shopify/BulkOperation/12',query_sha256:'c'.repeat(64),payload_sha256:'d'.repeat(64),status:'COMPLETED',object_count:4},workflow_id:'nightly-rfm-'+brand,producer_revision:'1234567',algorithm_sha256:'e'.repeat(64),access_scopes:['read_customers','read_orders','read_all_orders'],history_complete:true,started_at:'2026-10-01T11:00:00.000Z',observed_at:stamp,expires_at:'2026-10-02T12:00:00.000Z'};}
test('published upper-bound algorithm keeps ties and category precedence per brand',()=>{
 const rows=[
  {customer_gid:'gid://shopify/Customer/1',paid_orders:1,amount_spent:10,last_paid_order_at:'2026-09-30T12:00:00.000Z'},
  {customer_gid:'gid://shopify/Customer/2',paid_orders:4,amount_spent:100,last_paid_order_at:'2026-09-30T12:00:00.000Z'},
  {customer_gid:'gid://shopify/Customer/3',paid_orders:2,amount_spent:20,last_paid_order_at:'2026-01-01T12:00:00.000Z'}];
 const out=R.classify(rows,{brand:'fish',now:stamp});assert.deepEqual(out.map(x=>x.rfm_tag),['um_x_lapsando','ex_campeao_at_risk','ex_campeao_at_risk']);assert.equal(out[0].R,out[1].R);assert.equal(R.tag({R:5,M:1,orders:4}),'campeao');assert.equal(R.tag({R:3,M:5,orders:2}),'leal');assert.equal(R.tag({R:2,M:2,orders:2}),'needs_attention');assert.ok(out.every(x=>x.brand==='fish'));
});
test('provenance requires two different completed Bulks, exact hashes, read_all_orders and bounded freshness',()=>{
 const p=provenance(),before=JSON.stringify(p),pin=R.sourceHash(p);assert.match(pin,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(p),before);
 for(const mutate of [x=>x.operation_id='not-an-operation',x=>x.access_scopes.splice(2,1),x=>x.history_complete=false,x=>x.paid_orders_bulk.gid=x.customer_bulk.gid,x=>x.paid_orders_bulk.status='RUNNING',x=>x.expires_at='2026-10-03T12:00:00.000Z']){const bad=structuredClone(p);mutate(bad);assert.throws(()=>R.validateProvenance(bad));}
});
test('catalog readiness binds field and snapshot to the exact provenance hash; unavailable is unknown',()=>{
 const p=provenance(),pin=R.sourceHash(p),definition={schema_version:A.VERSION,brand:'fish',name:'Campeões',rule:{op:'condition',field:R.FIELD,operator:'is',value:'campeao'}},catalog={brand:'fish',current:true,fields:[{key:R.FIELD,available:true,source_hash:pin}],lists:[],products:[],origins:[],recorded_origins:[],rfm_snapshot:{brand:'fish',current:true,history_complete:true,source_hash:pin,provenance:p}};
 assert.equal(R.sourceReady('fish',catalog),true);assert.equal(A.checkCatalog(definition,catalog).ok,true);
 for(const patch of [{current:false},{history_complete:false},{source_hash:'f'.repeat(64)}]){const bad=structuredClone(catalog);Object.assign(bad.rfm_snapshot,patch);assert.equal(A.checkCatalog(definition,bad).ok,false);}
 assert.throws(()=>A.normalize({...definition,rule:{...definition.rule,value:'inventado'}}),/AUDIENCE_RFM/);
});
test('count compiler dispatches only a confirmed single RFM leaf to the set-based aggregate',()=>{
 const p=provenance(),pin=R.sourceHash(p),definition={schema_version:A.VERSION,brand:'fish',name:'Campeões',rule:{op:'condition',field:R.FIELD,operator:'is',value:'campeao'}},catalog={brand:'fish',current:true,fields:[{key:R.FIELD,available:true,source_hash:pin}],lists:[{id:17,brand:'fish',available:true}],products:[],origins:[],recorded_origins:[],rfm_snapshot:{brand:'fish',current:true,history_complete:true,source_hash:pin,operation_id:p.operation_id,started_at:p.started_at,observed_at:p.observed_at,expires_at:p.expires_at,customers:1,resolved:1}};
 const plan=Counter.compileCount({definition,baseListId:17,catalog});assert.match(plan.text,/rfm_count_for_rule/);assert.doesNotMatch(plan.text,/rfm_match\(/);assert.equal(plan.unknown_reason,null);assert.deepEqual(plan.values,[JSON.stringify(definition.rule),'fish',17,pin]);
 const mixed={...definition,rule:{op:'and',rules:[{op:'in_list',list_id:17},definition.rule]}};
 const legacy=Counter.compileCount({definition:mixed,baseListId:17,catalog});assert.match(legacy.text,/rfm_match\(/);assert.doesNotMatch(legacy.text,/rfm_count_for_rule/);
 const stale=structuredClone(catalog);stale.rfm_snapshot.current=false;const blocked=Counter.compileCount({definition,baseListId:17,catalog:stale});assert.equal(blocked.unknown_reason,'external_source_unavailable');
});
test('missing, duplicate and future customer evidence is rejected instead of classified as zero',()=>{
 const base={customer_gid:'gid://shopify/Customer/1',paid_orders:1,amount_spent:10,last_paid_order_at:'2026-09-30T12:00:00.000Z'};
 assert.throws(()=>R.classify([{...base,last_paid_order_at:'2026-10-02T12:00:00.000Z'}],{brand:'fish',now:stamp}));
 assert.throws(()=>R.classify([base,base],{brand:'fish',now:stamp}));
 assert.throws(()=>R.classify([{...base,amount_spent:undefined}],{brand:'fish',now:stamp}));
});
test('SQL candidate keeps selection on the matcher and gives pure-leaf count a set-based aggregate',()=>{
 const sql=require('node:fs').readFileSync(require('node:path').join(__dirname,'../n8n/growth/segment-shopify-rfm.sql'),'utf8');
 const countBody=sql.match(/CREATE FUNCTION crm_audience_v2\.rfm_count_for_rule[\s\S]*?\$fn\$;/)?.[0]||'';
 assert.match(sql,/CREATE FUNCTION crm_audience_v2\.rfm_match/);assert.match(sql,/rfm_selection_match[\s\S]*SELECT crm_audience_v2\.rfm_match/);assert.match(countBody,/current_source AS MATERIALIZED/);assert.match(countBody,/count\(\*\)=1 FROM public\.lists/);assert.match(countBody,/source_ok AND rule_ok AND base_ok/);assert.match(countBody,/LEFT JOIN crm_audience_v2\.rfm_fact/);assert.equal(countBody.match(/rfm_source_current\(/g)?.length,1);assert.doesNotMatch(countBody,/rfm_match\(/);
 assert.match(sql,/SELECT \(SELECT coalesce\(f\.rfm_tag=\(rule->>'value'\),false\)/,'complete zero-order evidence is false while absent facts stay NULL');
 assert.match(sql,/ingestion_enabled boolean NOT NULL DEFAULT false/);assert.match(sql,/enabled boolean NOT NULL DEFAULT false/);assert.doesNotMatch(sql,/INSERT INTO crm_audience_v2\.rfm_source/);
});
