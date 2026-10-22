'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),path=require('node:path'),M=require(path.join(process.env.PAID_FACTS_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'),'crm-paid-results.cjs'));
const now=()=>Date.parse('2026-10-22T15:00:00Z');
const row=(at,total='10.00',currency='BRL')=>({brand:'fish',created_at:at,total,currency,financial_status:'paid',is_test:false,policy:M.POLICY,origin:'email',complete:true,selected_visit_at:at,term:'lm-281-l263',campaign:'real-shape-synthetic-only',first_purchase:false,observed_at:at});
function fixture(rows,{coverage=null,queryHook=()=>{},authorize=()=>{},authorizeComparison=()=>{}}={}){
 const calls=[];let transactions=0;
 const reader=M.create({now,authorize,authorizeComparison,coverage:()=>coverage,database:async fn=>{transactions++;return fn({query:async(sql,values)=>{calls.push({sql,values});queryHook(calls);if(sql===M.LATEST)return {rows:[{latest:rows.map(x=>x.created_at).sort().at(-1)||null}]};if(sql===M.SELECT)return {rows:rows.filter(x=>x.brand===values[0]&&x.created_at>=values[1]&&x.created_at<values[2])};return {rows:[]};}});}});
 return {reader,calls,get transactions(){return transactions;}};
}
test('comparison uses two adjacent Brasilia windows, one snapshot and one currency',async()=>{
 const f=fixture([row('2026-10-22T03:00:00.000Z','10.00'),row('2026-10-22T02:59:59.999Z','5.00'),row('2026-10-23T03:00:00.000Z','99.00')]);
 const v=await f.reader.compare({},'fish',{preset:'today'});a.equal(v.totals.revenueCents,'1000');a.equal(v.comparison.totals.revenueCents,'500');a.equal(v.period.from,'2026-10-22T03:00:00.000Z');a.equal(v.comparison.period.until,v.period.from);a.equal(f.transactions,1);a.match(f.calls[0].sql,/REPEATABLE READ/);a.equal(f.calls.filter(x=>x.sql===M.SELECT).length,2);a.equal(v.comparison.currency,'BRL');
});
test('existing calendar handles week and clamped February while custom ranges remain validated',()=>{
 const p=M.comparisonCalendar({preset:'month'},Date.parse('2026-03-31T15:00:00Z'));a.equal(p.previous.fim,'2026-02-28');a.equal(p.previous.clamped,true);
 const week=M.comparisonCalendar({preset:'week'},Date.parse('2026-10-19T15:00:00Z'));a.equal(week.ini,'2026-10-19');a.equal(week.previous.ini,'2026-10-12');a.equal(week.previous.fim,'2026-10-12');
 for(const input of [{preset:'invalid'},{preset:'custom',ini:'2026-02-30',fim:'2026-03-02'},{preset:'custom',ini:'2026-10-22',fim:'2026-10-21'}])a.throws(()=>M.comparisonCalendar(input,now()),{code:'PAID_RESULTS_PERIOD_INVALID'});
});
test('fallback covers full civil days and previous never receives independent fallback',async()=>{
 const f=fixture([row('2026-10-14T16:00:00.000Z')]),v=await f.reader.compare({},'fish',{preset:'last7'});a.equal(v.period.fallback,true);a.equal(v.period.until,'2026-10-15T03:00:00.000Z');a.equal(v.period.from,'2026-10-08T03:00:00.000Z');a.equal(v.comparison.period.until,v.period.from);a.equal(v.comparison.available,false);a.equal(v.comparison.totals.revenueCents,null);a.equal(f.calls.filter(x=>x.sql===M.LATEST).length,1);
});
test('partial known subtotals can compare without inventing a missing calendar day',async()=>{
 const f=fixture([row('2026-10-20T03:00:00.000Z','5.00'),row('2026-10-13T03:00:00.000Z','2.50')]),v=await f.reader.compare({},'fish',{preset:'last7'});a.equal(v.totals.revenueCents,'500');a.equal(v.comparison.totals.revenueCents,'250');a.equal(v.comparison.available,true);a.equal(v.comparison.partial,true);a(v.comparison.series.some(x=>x.revenueCents===null));
});
test('previous currency never replaces the current currency',async()=>{
 const f=fixture([row('2026-10-22T04:00:00.000Z','10.00','BRL'),row('2026-10-21T04:00:00.000Z','20.00','USD')]),v=await f.reader.compare({},'fish',{preset:'today'});a.equal(v.currency,'BRL');a.equal(v.comparison.currency,'BRL');a.equal(v.comparison.totals.revenueCents,null);a.equal(v.comparison.available,false);
});
test('an empty fully covered current window stays zero without falling back',async()=>{
 const f=fixture([row('2026-10-21T04:00:00.000Z')],{coverage:{from:'2026-10-01T03:00:00.000Z',until:'2026-10-23T03:00:00.000Z'}}),v=await f.reader.compare({},'fish',{preset:'today'});a.equal(v.period.fallback,false);a.equal(v.totals.revenueCents,'0');a.equal(v.available,true);a.equal(v.comparison.totals.revenueCents,'1000');a.equal(f.calls.filter(x=>x.sql===M.LATEST).length,0);
});
test('confirmed empty previous period is zero; unconfirmed absence and invalid amounts stay unknown',async()=>{
 const rows=[row('2026-10-22T04:00:00.000Z')],coverage={from:'2026-10-01T03:00:00.000Z',until:'2026-10-23T03:00:00.000Z'},confirmed=await fixture(rows,{coverage}).reader.compare({},'fish',{preset:'today'}),unknown=await fixture(rows).reader.compare({},'fish',{preset:'today'});
 a.equal(confirmed.comparison.totals.revenueCents,'0');a.equal(confirmed.comparison.available,true);a.equal(unknown.comparison.totals.revenueCents,null);a.equal(unknown.comparison.available,false);
 const invalid=await fixture([...rows,row('2026-10-21T04:00:00.000Z','invalid')],{coverage}).reader.compare({},'fish',{preset:'today'});a.equal(invalid.comparison.totals.revenueCents,null);
});
test('previous read errors or revocation deny the entire response; restricted authorization runs before SQL',async()=>{
 const rows=[row('2026-10-22T04:00:00.000Z')];let active=true;
 const broken=fixture(rows,{queryHook:c=>{if(c.filter(x=>x.sql===M.SELECT).length===2)throw Error('SOURCE_FAILED');}});await a.rejects(broken.reader.compare({},'fish',{preset:'today'}),/SOURCE_FAILED/);
 const revoked=fixture(rows,{authorize(){if(!active)throw Error('DENIED');},queryHook:c=>{if(c.filter(x=>x.sql===M.SELECT).length===2)active=false;}});await a.rejects(revoked.reader.compare({},'fish',{preset:'today'}),/DENIED/);
 const ordinary=fixture(rows,{authorizeComparison(){throw Error('QA_REQUIRED');}});await a.rejects(ordinary.reader.compare({},'fish'),/QA_REQUIRED/);a.equal(ordinary.calls.length,0);
});
test('legacy Results keeps its original single-read shape and campaign filters apply to both windows',async()=>{
 const f=fixture([row('2026-10-22T04:00:00.000Z')]),v=await f.reader.results({},'fish');a.equal(Object.hasOwn(v,'comparison'),false);a.equal(f.calls.length,1);
 const v2=await fixture([row('2026-10-22T04:00:00.000Z'),row('2026-10-21T04:00:00.000Z')]).reader.compare({},'fish',{preset:'today',campaigns:'282'});a.equal(v2.totals.revenueCents,null);a.equal(v2.comparison.totals.revenueCents,null);a.equal(v2.campaigns[0].campaignId,282);a.equal(v2.comparison.campaigns[0].campaignId,282);
});

test('existing saved analysis URLs retain their Brasilia window, brand and campaign filter',()=>{
 const ui=require((process.env.PAID_FACTS_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational'))+'/crm-paid-comparison-ui.cjs');
 const p=ui.normalizeSearch('?brand=fish&from=2026-10-15T03%3A00%3A00.000Z&until=2026-10-22T03%3A00%3A00.000Z&campaigns=336');
 a.equal(p.get('ini'),'2026-10-15');a.equal(p.get('fim'),'2026-10-21');a.equal(p.get('preset'),'custom');a.equal(p.get('brand'),'fish');a.equal(p.get('campaigns'),'336');a.equal(p.has('from'),false);
 a.equal(ui.normalizeSearch('?ini=2026-10-01&fim=2026-10-02&from=bad&until=bad').get('ini'),'2026-10-01');
 a.equal(ui.normalizeSearch('?from=bad&until=bad').has('ini'),false);
});
