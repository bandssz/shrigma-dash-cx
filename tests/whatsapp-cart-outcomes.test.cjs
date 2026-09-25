'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const C=require('../n8n/growth/whatsapp-cart-outcomes.cjs');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const SALT='4bd4e574-9810-436b-a815-f9376d86c26a';
const bag=amount=>({shopMoney:{amount,currencyCode:'BRL'}});
const order=(id=1,overrides={})=>({id:'gid://shopify/Order/'+id,createdAt:'2026-09-24T10:00:00Z',updatedAt:'2026-09-24T10:10:00Z',test:false,cancelledAt:null,displayFinancialStatus:'PAID',phone:'+55 (11) 90000-0001',shippingAddress:{phone:'11900000001',countryCodeV2:'BR'},billingAddress:null,netPaymentSet:bag('100.00'),totalReceivedSet:bag('100.00'),totalRefundedSet:bag('0.00'),transactions:[{kind:'SALE',status:'SUCCESS',processedAt:'2026-09-24T10:05:00Z',amountSet:bag('100.00')}],...overrides});
function begin(overrides={}){return C.begin({brand:'aristo',mode:'reconcile',since:'2026-09-24T00:00:00Z',until:'2026-09-25T00:00:00Z',salt:SALT,run_id:crypto.randomUUID(),now:'2026-09-25T01:00:00Z',...overrides});}
const count=n=>({data:{ordersCount:{count:n,precision:'EXACT'}}});
const page=(rows,next=false,cursor=null)=>({data:{orders:{nodes:rows,pageInfo:{hasNextPage:next,endCursor:cursor}}}});
function batch(rows,options={}){let s=begin(options);s=C.accept(s,count(rows.length));s=C.accept(s,page(rows));s=C.accept(s,count(rows.length),{now:options.completed_at||'2026-09-25T01:10:00Z'});return C.result(s);}
async function db(){const d=new PGlite();await d.exec(fs.readFileSync(path.join(__dirname,'../n8n/growth/whatsapp-cart-outcomes.sql'),'utf8'));return d;}
const ingest=async(d,b)=>(await d.query('SELECT growth_wa_cart_outcomes_ingest_v1($1::jsonb) AS r',[JSON.stringify(b)])).rows[0].r;
test('normalization matches holdout identity, retains no contact/name/UTM, and does not invent a phone',()=>{
 const row=C.normalize(order(),{brand:'aristo',salt:SALT});
 assert.equal(row.unit_key,crypto.createHash('md5').update(SALT+'|aristo|5511900000001').digest('hex'));
 assert.equal(row.identity_state,'matched');assert.equal(row.financial_state,'known');assert.equal(row.net_cents,'10000');
 assert.equal(/90000|phone|email|shipping|billing|utm|name/i.test(JSON.stringify(row)),false);
 assert.equal(C.normalize(order(1,{phone:null,shippingAddress:null}),{brand:'aristo',salt:SALT}).identity_state,'missing');
 assert.equal(C.normalize(order(1,{phone:'+5511900000002'}),{brand:'aristo',salt:SALT}).identity_state,'conflict');
 assert.equal(C.normalizePhone('11900000001','US'),null);assert.equal(C.normalizePhone('+1 11900000001','US'),null);
});
test('native Crypto stages exactly match local normalization and delete transient identity strings',()=>{
 for(const o of [order(),order(2,{phone:null,shippingAddress:null}),order(3,{phone:'+5511900000002'})]){
  const expected=C.normalize(o,{brand:'aristo',salt:SALT}),a=C.prepareIdentity(o,{brand:'aristo',salt:SALT});
  const b=C.prepareRevision(a,crypto.createHash('md5').update(a._identity_input).digest('hex'));
  assert.equal('_identity_input' in b,false);assert.doesNotMatch(JSON.stringify(b),/551190000000/);
  const done=C.finishRevision(b,crypto.createHash('sha256').update(b._revision_input).digest('hex'));
  assert.deepEqual(done,expected);assert.equal('_revision_input' in done,false);
 }
});
test('cash and payment evidence preserve refunds, partial states and split-payment completion',()=>{
 const refunded=C.normalize(order(1,{updatedAt:'2026-09-26T00:00:00Z',displayFinancialStatus:'PARTIALLY_REFUNDED',netPaymentSet:bag('60'),totalRefundedSet:bag('40')}),{brand:'aristo',salt:SALT});
 assert.equal(refunded.financial_state,'known');assert.equal(refunded.net_cents,'6000');
 const split=order(1,{transactions:[{kind:'SALE',status:'SUCCESS',processedAt:'2026-09-24T10:03:00Z',amountSet:bag('50')},{kind:'CAPTURE',status:'SUCCESS',processedAt:'2026-09-24T10:07:00Z',amountSet:bag('50')}]});
 assert.equal(C.normalize(split,{brand:'aristo',salt:SALT}).paid_at,'2026-09-24T10:07:00.000Z');
 assert.equal(C.normalize(order(1,{transactions:[]}),{brand:'aristo',salt:SALT}).financial_state,'unknown_payment');
 assert.notEqual(C.normalize(order(1,{netPaymentSet:bag('99')}),{brand:'aristo',salt:SALT}).financial_state,'known');
 assert.equal(C.money(bag('0.10')).cents,'10');assert.equal(C.money(bag('1.001')),null);
});
test('all-order query has no UTM/payment filter, verifies both exact counts and every cursor',()=>{
 let s=begin();assert.match(C.request(s).variables.query,/created_at/);assert.doesNotMatch(C.request(s).variables.query,/utm|financial_status|status:/);
 s=C.accept(s,count(2));assert.equal(C.request(s).variables.sortKey,'CREATED_AT');
 s=C.accept(s,page([order(1)],true,'cursor1'));assert.equal(C.request(s).variables.after,'cursor1');
 assert.throws(()=>C.accept(s,page([order(2)],true,'cursor1')),/CURSOR_NOT_ADVANCING/);
 s=C.accept(s,page([order(2)]));s=C.accept(s,count(2),{now:'2026-09-25T01:10:00Z'});assert.equal(C.result(s).complete,true);
 let changed=C.accept(begin(),count(2));changed=C.accept(changed,page([order(1)]));changed=C.accept(changed,count(1),{now:'2026-09-25T01:10:00Z'});assert.equal(C.result(changed).complete,false);
 assert.throws(()=>C.accept(begin(),{data:{ordersCount:{count:10000,precision:'AT_LEAST'}}}),/COUNT_NOT_EXACT/);
 assert.throws(()=>C.accept(begin(),{data:{},errors:[{message:'private message must never be logged'}]}),/^Error: OUTCOME_SHOPIFY_RESPONSE$/);
 assert.throws(()=>C.accept(C.accept(begin(),count(1)),page([order(1,{createdAt:'2026-09-23T00:00:00Z'})])),/OUTSIDE_WINDOW/);
 assert.equal(C.request(C.accept(begin({mode:'updated'}),count(1))).variables.sortKey,'UPDATED_AT');
});
test('ingest is idempotent; source revisions move forward, refunds reduce net, and incomplete scans cannot overwrite',async()=>{
 const d=await db();try{
  const b=batch([order()]);assert.equal((await ingest(d,b)).written,1);assert.equal((await ingest(d,b)).replay,true);
  const ref=batch([order(1,{updatedAt:'2026-09-26T00:00:00Z',netPaymentSet:bag('60'),totalRefundedSet:bag('40'),displayFinancialStatus:'PARTIALLY_REFUNDED'})],{now:'2026-09-26T01:00:00Z',completed_at:'2026-09-26T01:10:00Z'});await ingest(d,ref);
  assert.equal((await d.query('SELECT net_cents FROM growth_wa_cart_outcome_order')).rows[0].net_cents,'6000');
  const old=batch([order()],{now:'2026-09-26T02:00:00Z',completed_at:'2026-09-26T02:10:00Z'});assert.equal((await ingest(d,old)).written,0);
  const incomplete={...batch([order(1,{updatedAt:'2026-09-27T00:00:00Z'})],{now:'2026-09-27T01:00:00Z',completed_at:'2026-09-27T01:10:00Z'}),complete:false,reason:'count_changed_or_missing_rows',count_before:2};
  assert.equal((await ingest(d,incomplete)).ok,false);assert.equal((await d.query('SELECT net_cents FROM growth_wa_cart_outcome_order')).rows[0].net_cents,'6000');
  await assert.rejects(ingest(d,{...b,count_before:2}),/RUN_ID_CONFLICT/);
  await assert.rejects(ingest(d,batch([order(1,{updatedAt:'2026-09-26T00:00:00Z',netPaymentSet:bag('50'),totalRefundedSet:bag('50')})])),/SOURCE_REVISION_CONFLICT/);
  await assert.rejects(ingest(d,{...batch([order(2)]),rows:[{...C.normalize(order(2),{brand:'aristo',salt:SALT}),phone:'must-not-be-stored'}]}),/INVALID_NORMALIZED_ROW/);
 }finally{await d.close();}
});
test('disabled source plans no jobs; watermark overlap and recent reconciliation do not enable enrollment',async()=>{
 const d=await db();try{
  assert.deepEqual((await d.query("SELECT growth_wa_cart_outcomes_jobs_v1('updated','2026-09-25T01:00:00Z') AS r")).rows[0].r,[]);
  await d.exec("UPDATE growth_wa_cart_outcome_config SET enabled=true WHERE brand='aristo'");
  let jobs=(await d.query("SELECT growth_wa_cart_outcomes_jobs_v1('updated','2026-09-25T01:00:00Z') AS r")).rows[0].r;assert.equal(jobs.length,1);assert.equal(jobs[0].mode,'updated');
  const b=batch([order()],{mode:'updated'});await ingest(d,b);
  jobs=(await d.query("SELECT growth_wa_cart_outcomes_jobs_v1('updated','2026-09-25T02:00:00Z') AS r")).rows[0].r;assert.equal(Date.parse(jobs[0].since),Date.parse('2026-09-24T23:50:00Z'));
  assert.equal((await d.query("SELECT to_regclass('public.growth_wa_cart_holdout_run') AS r")).rows[0].r,null);
 }finally{await d.close();}
});
test('mature results require fresh post-window reconciliation; missing phones are unknown, never zero',async()=>{
 const d=await db();try{
  const b=batch([order()]);await ingest(d,b);const row=b.rows[0];
  const cohort=[{brand:'aristo',unit_key:row.unit_key,arm:'holdout',first_eligible_at:'2026-09-24T00:00:00Z'}];
  const report=async(asof='2026-09-25T02:00:00Z',c=cohort)=>(await d.query('SELECT growth_wa_cart_outcomes_report_v1($1::jsonb,24,$2::timestamptz,$3::uuid) AS r',[JSON.stringify(c),asof,SALT])).rows[0].r.groups[0];
  let r=await report();assert.equal(r.allocated,1);assert.equal(r.measured,1);assert.equal(r.confirmed_net_cents,10000);
  r=await report('2026-09-24T20:00:00Z');assert.equal(r.mature,0);assert.equal(r.measured,0);
  r=await report('2026-09-27T02:00:00Z');assert.equal(r.measured,0);assert.equal(r.unknown,1);
  await ingest(d,batch([order(1),order(2,{phone:null,shippingAddress:null})]));r=await report();assert.equal(r.measured,0);assert.equal(r.unknown,1);assert.equal(r.complete_net_cents,null);assert.equal(r.confirmed_paid_orders,1);
  await assert.rejects(report('2026-09-25T02:00:00Z',[...cohort,{...cohort[0],arm:'treatment'}]),/INVALID_COHORT/);
  await assert.rejects(report('2026-09-25T02:00:00Z',Array.from({length:1001},()=>cohort[0])),/COHORT_LIMIT_1000/);
  const dup=await report('2026-09-25T02:00:00Z',[...cohort,{...cohort[0],first_eligible_at:'2026-09-24T01:00:00Z'}]);assert.equal(dup.allocated,1,'a second cart does not duplicate a person/order');
 }finally{await d.close();}
});
test('a missing order in a complete reconciliation becomes unknown until it reappears',async()=>{
 const d=await db();try{
  const b=batch([order()]);await ingest(d,b);
  await ingest(d,batch([],{now:'2026-09-25T02:00:00Z',completed_at:'2026-09-25T02:10:00Z'}));
  assert.equal((await d.query('SELECT source_missing FROM growth_wa_cart_outcome_order')).rows[0].source_missing,true);
  const cohort=[{brand:'aristo',unit_key:b.rows[0].unit_key,arm:'holdout',first_eligible_at:'2026-09-24T00:00:00Z'}];
  const report=async()=>(await d.query("SELECT growth_wa_cart_outcomes_report_v1($1::jsonb,24,'2026-09-25T04:00:00Z',$2::uuid) AS r",[JSON.stringify(cohort),SALT])).rows[0].r.groups[0];
  assert.equal((await report()).unknown,1);assert.equal((await report()).complete_net_cents,null);
  await ingest(d,batch([order()],{now:'2026-09-25T03:00:00Z',completed_at:'2026-09-25T03:10:00Z'}));
  assert.equal((await report()).measured,1);assert.equal((await report()).complete_buyers,1);
 }finally{await d.close();}
});
test('an extra capture after the outcome window cannot turn a confirmed purchase into measured zero',async()=>{
 const d=await db();try{
  const b=batch([order()]);await ingest(d,b);
  const revision=order(1,{updatedAt:'2026-09-25T01:00:00Z',netPaymentSet:bag('120'),totalReceivedSet:bag('120'),transactions:[...order().transactions,{kind:'CAPTURE',status:'SUCCESS',processedAt:'2026-09-25T00:30:00Z',amountSet:bag('20')}]});
  await ingest(d,batch([revision],{now:'2026-09-25T02:00:00Z',completed_at:'2026-09-25T02:10:00Z'}));
  const cohort=[{brand:'aristo',unit_key:b.rows[0].unit_key,arm:'holdout',first_eligible_at:'2026-09-24T00:00:00Z'}];
  const r=(await d.query("SELECT growth_wa_cart_outcomes_report_v1($1::jsonb,24,'2026-09-25T03:00:00Z',$2::uuid) AS r",[JSON.stringify(cohort),SALT])).rows[0].r.groups[0];
  assert.equal(r.unknown,1);assert.equal(r.measured,0);assert.equal(r.complete_net_cents,null);
 }finally{await d.close();}
});
test('small reconciliation windows advance fairly; range coverage requires no gaps',async()=>{
 const d=await db();try{
  await d.exec('UPDATE growth_wa_cart_outcome_config SET enabled=true');
  let jobs=(await d.query("SELECT growth_wa_cart_outcomes_jobs_v1('reconcile','2026-09-25T01:00:00Z') AS r")).rows[0].r;
  assert.equal(jobs.length,4);assert.deepEqual(jobs.map(x=>x.brand),['aristo','fish','aristo','fish']);
  for(const j of jobs)await ingest(d,batch([],{...j,now:'2026-09-25T01:00:00Z',completed_at:'2026-09-25T01:10:00Z'}));
  const next=(await d.query("SELECT growth_wa_cart_outcomes_jobs_v1('reconcile','2026-09-25T01:15:00Z') AS r")).rows[0].r;
  assert.ok(next.every(j=>Date.parse(j.since)>=Date.parse('2026-09-24T04:00:00Z')));
  const sample=C.normalize(order(),{brand:'aristo',salt:SALT}),cohort=[{brand:'aristo',unit_key:sample.unit_key,arm:'holdout',first_eligible_at:'2026-09-24T00:00:00Z'}];
  for(let hour=4;hour<24;hour+=2){if(hour===12)continue;const since=`2026-09-24T${String(hour).padStart(2,'0')}:00:00Z`,until=hour===22?'2026-09-25T00:00:00Z':`2026-09-24T${String(hour+2).padStart(2,'0')}:00:00Z`;await ingest(d,batch(hour===10?[order()]:[],{since,until}));}
  const report=async()=>(await d.query("SELECT growth_wa_cart_outcomes_report_v1($1::jsonb,24,'2026-09-25T02:00:00Z',$2::uuid) AS r",[JSON.stringify(cohort),SALT])).rows[0].r.groups[0];
  assert.equal((await report()).unknown,1);
  await ingest(d,batch([],{since:'2026-09-24T12:00:00Z',until:'2026-09-24T14:00:00Z'}));
  assert.equal((await report()).measured,1);assert.equal((await report()).confirmed_buyers,1);
 }finally{await d.close();}
});
test('a maximum 500-order job has a bounded state; larger windows fail closed',()=>{
 let s=C.accept(begin(),count(500)),peak=0,totalStateBytes=0;
 for(let pageIndex=0;pageIndex<5;pageIndex++){
  const rows=Array.from({length:100},(_,i)=>order(pageIndex*100+i+1));
  s=C.accept(s,page(rows,pageIndex<4,pageIndex<4?'cursor'+pageIndex:null));
  const bytes=Buffer.byteLength(JSON.stringify(s));peak=Math.max(peak,bytes);totalStateBytes+=bytes;
 }
 s=C.accept(s,count(500),{now:'2026-09-25T01:10:00Z'});
 assert.ok(peak<512000);assert.ok(totalStateBytes<1500000);assert.equal(C.result(s).rows.length,500);
 assert.throws(()=>C.accept(begin(),count(501)),/WINDOW_TOO_LARGE/);
});
