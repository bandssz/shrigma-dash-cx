'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{PGlite}=require('@electric-sql/pglite');
const C=require('../n8n/growth/segment-audience-cohort.cjs'),Count=require('../n8n/growth/segment-audience-listmonk.cjs'),F=require('./segment-audience-cohort-fixture.cjs');
async function setup(t){const db=new PGlite();t.after(()=>db.close());return F.setup(db);}
test('both brands: bounded private cohort matches aggregate count and native consent for nested AND/OR with duplicates',async t=>{
 const f=await setup(t);for(const brand of ['fish','aristo']){const [a,b]=brand==='fish'?[101,102]:[201,202];
  for(const [rule,expected]of [[{op:'and',rules:[F.leaf(b),F.leaf(a),F.leaf(a)]},brand==='fish'?[1]:[7]],[{op:'or',rules:[F.leaf(a),F.leaf(b)]},brand==='fish'?[1,2,3]:[7,8]],[{op:'and',rules:[F.leaf(b),{op:'or',rules:[F.leaf(a),F.leaf(b)]}]},brand==='fish'?[1,3]:[7]]]){
   const args=F.args(brand,rule),result=await f.resolve(args),count=await Count.countAudience({...args,query:f.query});assert.deepEqual(result.member_ids,expected);assert.equal(result.eligible_count,count.eligible_count);assert.equal(result.source_confirmed,true);assert.equal(result.unknown_reason,null);assert.ok(Object.isFrozen(result.member_ids));assert.deepEqual(Object.keys(result).sort(),['checked_at','eligible_count','member_ids','source_confirmed','unknown_reason']);}
 }
 assert.equal(C.ENABLED,false);
});
test('current global status, base opt-out, leaf confirmation and absent membership determine only captured eligible rows',async t=>{
 const f=await setup(t),args=F.args('fish',F.leaf(102));assert.deepEqual((await f.resolve(args)).member_ids,[1,3]);
 await f.db.exec("UPDATE lists SET optin='single' WHERE id=102");assert.deepEqual((await f.resolve(args)).member_ids,[1,2,3]);
 await f.db.exec("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=17; UPDATE subscribers SET status='blocklisted' WHERE id=2; DELETE FROM subscriber_lists WHERE subscriber_id=3 AND list_id=102");const empty=await f.resolve(args);assert.equal(empty.source_confirmed,true);assert.deepEqual(empty.member_ids,[]);assert.equal(empty.eligible_count,0);
 await f.db.exec("UPDATE subscribers SET status='enabled' WHERE id=2; UPDATE subscriber_lists SET status='unconfirmed' WHERE list_id=17; UPDATE lists SET optin='double' WHERE id=17");assert.deepEqual((await f.resolve(args)).member_ids,[]);
});
test('native list status/ownership and stale or duplicate catalog produce unknown with null IDs/count, never an empty confirmed set',async t=>{
 const f=await setup(t);for(const sql of ["UPDATE lists SET tags=ARRAY['aristo'] WHERE id=101","UPDATE lists SET tags=ARRAY['fish'],status='archived' WHERE id=101","UPDATE lists SET status='active',optin='invalid' WHERE id=101"]){await f.db.exec(sql);const r=await f.resolve(F.args());assert.equal(r.source_confirmed,false);assert.equal(r.unknown_reason,'list_source_unavailable');assert.equal(r.member_ids,null);assert.equal(r.eligible_count,null);}
 for(const change of [c=>c.current=false,c=>c.lists.push({...c.lists[0]}),c=>c.lists[1].available=false]){const p=F.args();change(p.catalog);const r=await f.resolve(p);assert.equal(r.source_confirmed,false);assert.equal(r.member_ids,null);}
});
test('any external leaf invalidates the whole cohort even in OR; enumeration or available flags cannot manufacture negatives',async t=>{
 const f=await setup(t);for(const condition of [{op:'condition',field:'purchase.count',operator:'eq',value:0},{op:'condition',field:'signup.origin',operator:'is',value:'popup'},{op:'condition',field:'email.opened',operator:'not_within_last_days',value:30}]){
  const p=F.args('fish',{op:'or',rules:[F.leaf(101),condition]});p.catalog.fields=[{key:condition.field,available:true}];const plan=C.compileCohort(p);assert.doesNotMatch(plan.text,/public\.(subscribers|subscriber_lists|lists)\b/);const r=await f.resolve(p);assert.deepEqual({...r,checked_at:null},{source_confirmed:false,unknown_reason:'external_source_unavailable',member_ids:null,eligible_count:null,checked_at:null});}
});
test('the 100001st base relation rejects before filters and before subscriber/membership row locks; exactly100000 stays admissible',async t=>{
 const f=await setup(t);await f.db.exec(`TRUNCATE subscriber_lists,subscribers;
 INSERT INTO subscribers SELECT n,CASE WHEN n=1 THEN 'enabled' ELSE 'blocklisted' END FROM generate_series(1,100001)n;
 INSERT INTO subscriber_lists SELECT n,17,CASE WHEN n=1 THEN 'confirmed' ELSE 'unsubscribed' END FROM generate_series(1,100001)n;
 INSERT INTO subscriber_lists VALUES(1,101,'confirmed');`);
 await assert.rejects(f.resolve(F.args()),{code:'AUDIENCE_COHORT_LIMIT'});
 const def=(await f.db.query("SELECT pg_get_functiondef('crm_audience_v2.ab_audience_cohort_source(text,integer[],integer,jsonb)'::regprocedure) definition")).rows[0].definition;
 assert.match(def,/base_candidates AS MATERIALIZED[\s\S]*LIMIT 100001/);assert.ok(def.indexOf('base_count<=100000')<def.indexOf('FOR SHARE OF s'));
 assert.ok(def.indexOf('base_count<=100000')<def.indexOf('FOR SHARE OF sl'));
 await f.db.query('DELETE FROM subscriber_lists WHERE list_id=17 AND subscriber_id=100001');const exact=await f.resolve(F.args());assert.deepEqual(exact.member_ids,[1]);assert.equal(exact.eligible_count,1);
});
test('SQL refuses missing/excessive server statement and lock bounds or non-RC transaction before returning IDs',async t=>{
 const f=await setup(t);for(const [setting,value]of [['statement_timeout','0'],['statement_timeout','30001ms'],['lock_timeout','0'],['lock_timeout','501ms']]){await f.db.exec('SET '+setting+"='"+value+"'");await assert.rejects(f.resolve(F.args()),{code:'AUDIENCE_COHORT_BOUNDARY'});await f.db.exec("SET statement_timeout='20s'; SET lock_timeout='500ms'");}
 await f.db.transaction(async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await assert.rejects(C.resolveCohort({...F.args(),query:tx.query.bind(tx)}),{code:'AUDIENCE_COHORT_BOUNDARY'});});
});
test('compiler uses one bounded materialized universe and only locked native values; no user expression appears in SQL',()=>{
 const p=F.args('fish',{op:'or',rules:[F.leaf(102),F.leaf(101)]});p.definition.name="Robert'); DROP TABLE subscribers;--";const plan=C.compileCohort(p);assert.doesNotMatch(plan.text,/Robert|DROP TABLE|public\./);assert.match(plan.text,/crm_audience_v2\.ab_audience_cohort_source/);assert.deepEqual(plan.values,['fish',[17,101,102],17,{op:'or',rules:[F.leaf(101),F.leaf(102)]}]);assert.doesNotMatch(plan.text,/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bSET\b/);
 for(const invalid of [{...p,baseListId:'17'},{...p,catalog:F.catalog('aristo')},{...p,definition:{...p.definition,rule:{op:'in_list',list_id:'1 OR true'}}}])assert.throws(()=>C.compileCohort(invalid));
});
test('definer rejects malformed or null direct rule parameters without returning nullable authority',async t=>{
 const f=await setup(t);for(const [brand,ids,base,rule] of [['fish',[17,101],17,{foo:1,bar:2}],[null,[17],17,F.leaf(17)],['fish',null,17,F.leaf(17)]]){const r=(await f.db.query('SELECT * FROM crm_audience_v2.ab_audience_cohort_source($1::text,$2::integer[],$3::integer,$4::jsonb)',[brand,ids,base,rule])).rows[0];assert.equal(r.source_confirmed,false);assert.equal(r.unknown_reason,'list_source_unavailable');assert.equal(r.member_ids,null);assert.equal(r.eligible_count,null);}
});
test('private SQL results must be sorted unique bounded integer IDs with matching count and fresh timestamp; errors are sanitized',async()=>{
 const ok={source_confirmed:true,unknown_reason:null,member_ids:[1,2],eligible_count:'2',checked_at:new Date().toISOString()};
 for(const patch of [{member_ids:[2,1]},{member_ids:[1,1]},{member_ids:['1',2]},{member_ids:[1,2147483648]},{eligible_count:3},{eligible_count:'02'},{eligible_count:NaN},{unknown_reason:'external_source_unavailable'},{source_confirmed:false},{checked_at:'2001-01-01'},{email:'private@example.test'}]){let n=0;await assert.rejects(C.resolveCohort({...F.args(),query:async()=>{n++;return {rows:[{...ok,...patch}]};}}),{code:'AUDIENCE_COHORT_UNCONFIRMED'});assert.equal(n,1);}
 await assert.rejects(C.resolveCohort({...F.args(),query:async()=>{throw Error('private member credential');}}),e=>e.code==='AUDIENCE_COHORT_UNCONFIRMED'&&!e.message.includes('private'));
});
test('abort/deadline only signal cancellation, never retry, and cannot turn late rows into confirmed cohort',async()=>{
 for(const external of [false,true]){const controller=new AbortController();let calls=0,seen,finish;const running=C.resolveCohort({...F.args(),signal:controller.signal,timeoutMs:20,query:(_q,_v,{signal})=>{calls++;seen=signal;return new Promise(resolve=>finish=resolve);}});if(external)setTimeout(()=>controller.abort(),5);await assert.rejects(running,{code:external?'AUDIENCE_COHORT_ABORTED':'AUDIENCE_COHORT_TIMEOUT'});assert.equal(calls,1);assert.equal(seen.aborted,true);finish({rows:[{source_confirmed:true,unknown_reason:null,member_ids:[1],eligible_count:1,checked_at:new Date().toISOString()}]});await new Promise(r=>setImmediate(r));assert.equal(calls,1);}
 const signal=AbortSignal.abort();await assert.rejects(C.resolveCohort({...F.args(),signal,query:()=>{throw Error('must not query');}}),{code:'AUDIENCE_COHORT_ABORTED'});
});
