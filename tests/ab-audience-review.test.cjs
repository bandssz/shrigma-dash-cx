'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{PGlite}=require('@electric-sql/pglite');
const F=require('./ab-audience-review-fixture.cjs'),R=require('../n8n/growth/ab-audience-review.cjs'),H=require('../n8n/growth/segment-audience-review.cjs');
const init=async t=>{const db=new PGlite();t.after(()=>db.close());return F.setup(db);};
const total=(r,key)=>r.arms.reduce((n,a)=>n+a[key],0);
for(const brand of ['fish','aristo'])test(brand+': real HTTP/store review only checks original members and keeps the original denominator',async t=>{
 const x=await init(t),p=await x.prepared(brand),first=await x.review(p);assert.equal(first.status,201,JSON.stringify(first));const original=first.body.review;
 assert.equal(original.status,'confirmed');assert.equal(original.snapshot_only,true);assert.equal(total(original,'allocated'),brand==='fish'?4:5);assert.equal(total(original,'excluded'),0);
 const members=await x.members(p.protocol.test_id),base=brand==='fish'?17:16,leaf=brand==='fish'?101:201;
 await x.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=$1",[base]);
 await x.db.query("INSERT INTO subscriber_lists VALUES(9,$1,'confirmed')",[leaf]);
 const second=await x.review(p);assert.equal(second.status,201,JSON.stringify(second));const now=second.body.review;
 assert.equal(total(now,'allocated'),total(original,'allocated'));assert.equal(total(now,'eligible'),total(original,'eligible')-1);assert.equal(total(now,'excluded'),1);assert.notEqual(now.eligible_fingerprint,original.eligible_fingerprint);
 assert.deepEqual(await x.members(p.protocol.test_id),members);assert.deepEqual((await x.latest(p)).body.review,now);assert.equal(first.body.authorizes_send,false);
 assert.doesNotMatch(JSON.stringify(second),/subscriber_id|member_ids|synthetic-manager-key/);
 assert.deepEqual((await x.db.query('SELECT DISTINCT status,sent,started_at FROM campaigns WHERE id=ANY($1::int[])',[p.protocol.arms.map(a=>a.campaign_id)])).rows,[{status:'draft',sent:0,started_at:null}]);
});
test('revoked and missing subscribers remain exclusions and never reduce the denominator or require replacement',async t=>{
 const x=await init(t),p=await x.prepared();
 await x.db.query("UPDATE crm_ab_member_v2 SET revoked_at=clock_timestamp(),revoked_reason='consent_removed' WHERE test_id=$1 AND subscriber_id=1",[p.protocol.test_id]);
 await x.db.query('DELETE FROM subscribers WHERE id=2');
 await x.db.query("UPDATE subscribers SET status='blocklisted' WHERE id=3");
 const r=await x.review(p);assert.equal(r.status,201,JSON.stringify(r));const v=r.body.review;
 assert.equal(v.status,'confirmed');assert.equal(total(v,'allocated'),4);assert.equal(total(v,'eligible'),1);assert.equal(total(v,'excluded'),3);assert.equal(total(v,'revoked'),1);assert.equal(total(v,'missing'),1);assert.equal(v.minimum_reached,false);
 assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_ab_member_v2 WHERE test_id=$1',[p.protocol.test_id])).rows[0].n,4);
});
test('unavailable source persists a new unavailable head with null counts instead of showing old eligible counts',async t=>{
 for(const change of ['off','malformed','expired','list']){
  const x=await init(t),p=await x.prepared(),first=await x.review(p);assert.equal(first.body.review.status,'confirmed');
  if(change==='off')await x.db.query("UPDATE crm_audience_v2.config SET enabled=false WHERE brand='fish'");
  if(change==='malformed')await x.db.query("UPDATE crm_audience_v2.config SET catalog='{}' WHERE brand='fish'");
  if(change==='expired')await x.db.query("UPDATE crm_audience_v2.config SET expires_at=clock_timestamp()-interval '1 second' WHERE brand='fish'");
  if(change==='list')await x.db.query("UPDATE lists SET status='archived' WHERE id=101");
  const r=await x.review(p);assert.equal(r.status,201,change+':'+JSON.stringify(r));const v=r.body.review;
  assert.equal(v.status,'unavailable');assert.notEqual(v.review_id,first.body.review.review_id);assert.equal(total(v,'allocated'),4);
  assert.equal(v.minimum_reached,null);assert.equal(v.eligible_fingerprint,null);for(const arm of v.arms)for(const key of ['eligible','excluded','revoked','missing'])assert.equal(arm[key],null,key);
  assert.deepEqual((await x.latest(p)).body.review,v);assert.equal(r.body.authorizes_send,false);
 }
});
test('editing the audience head does not reinterpret the fixed revision; archiving it makes a new unavailable review',async t=>{
 const x=await init(t),p=await x.prepared(),before=await x.review(p),a=p.audience;
 const changed=await x.audienceCall({acao:'segmento_salvar',brand:'fish',id:a.id,expected_version:a.version,expected_catalog_hash:x.catalogHashes.fish,definition:{...a.definition,name:'Broader current audience',rule:{op:'in_list',list_id:17}},idempotency_key:'new-audience-head'});assert.equal(changed.status,200,JSON.stringify(changed));
 const after=await x.review(p);assert.equal(after.status,201,JSON.stringify(after));assert.equal(after.body.review.status,'confirmed');assert.deepEqual(after.body.review.arms,before.body.review.arms);
 assert.equal(after.body.review.eligible_fingerprint,before.body.review.eligible_fingerprint);
 const archived=await x.audienceCall({acao:'segmento_arquivar',brand:'fish',id:a.id,expected_version:changed.body.segment.version,idempotency_key:'archive-audience-head'});assert.equal(archived.status,200,JSON.stringify(archived));
 const r=await x.review(p);assert.equal(r.status,201);assert.equal(r.body.review.status,'unavailable');assert.equal(r.body.review.reason,'audience_archived');
});
test('lost ACK consults the original immutable review, while a later review can supersede it without changing the receipt',async t=>{
 const x=await init(t),p=await x.prepared(),op=F.uuid(30001),request=x.reviewRequest(p,op);
 x.control.afterCommit=()=>{throw Error('synthetic lost ACK');};const lost=await x.reviewCall(request);assert.equal(lost.status,202);assert.equal(lost.body.automatic_retry,false);x.control.afterCommit=null;
 const receipt=await x.reviewOperation('fish',op);assert.equal(receipt.status,201,JSON.stringify(receipt));const first=receipt.body.review;
 await x.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=17");
 const next=await x.review(p);assert.notEqual(next.body.review.review_id,first.review_id);assert.equal(total(next.body.review,'eligible'),total(first,'eligible')-1);
 assert.deepEqual(await x.reviewOperation('fish',op),receipt);assert.deepEqual(await x.reviewCall(request),receipt);
 assert.deepEqual((await x.latest(p)).body.review,next.body.review);assert.equal((await x.reviewOperation('fish',op,'synthetic-other-key')).status,404);
 assert.equal((await x.reviewCall({...request,expected_scope_hash:'f'.repeat(64)})).status,409);
});
test('wrong permission, brand, experiment version and scope cannot create or substitute a review',async t=>{
 const x=await init(t),p=await x.prepared(),request=x.reviewRequest(p);
 for(const key of ['synthetic-reader-key','synthetic-writer-key','synthetic-cx-key'])assert.ok([401,403].includes((await x.reviewCall(request,key)).status));
 assert.ok([404,409].includes((await x.reviewCall({...request,brand:'aristo',operation_id:F.uuid(31001)})).status));
 assert.equal((await x.reviewCall({...request,expected_version:2,operation_id:F.uuid(31002)})).status,409);
 assert.equal((await x.reviewCall({...request,expected_scope_hash:'a'.repeat(64),operation_id:F.uuid(31003)})).status,409);
 assert.equal((await x.latest(p)).body.review,null);
});
test('SQL persistence failure and revoked permission before commit leave no partial review or receipt',async t=>{
 for(const mode of ['failure','revoke']){
  const x=await init(t),p=await x.prepared();let seen=false;
  x.control.afterQuery=async(q,v,tx)=>{if(!seen&&/^INSERT INTO crm_audience_v2\.ab_review\b/.test(q)){seen=true;if(mode==='failure')throw Error('synthetic receipt failure');await tx.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"draft\",\"read_content\"]' WHERE principal_id='manager'");}};
  const r=await x.review(p);assert.equal(seen,true);assert.equal(r.status,mode==='failure'?202:403,JSON.stringify(r));x.control.afterQuery=null;
  assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_audience_v2.ab_review')).rows[0].n,0);assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_audience_v2.ab_review_request')).rows[0].n,0);
 }
});
test('confirmed source with no eligible recipients reports real zeros, while all original allocations remain',async t=>{
 const x=await init(t),p=await x.prepared();await x.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=17");
 const r=await x.review(p);assert.equal(r.status,201);assert.equal(r.body.review.status,'confirmed');assert.equal(r.body.review.minimum_reached,false);
 assert.equal(total(r.body.review,'allocated'),4);assert.equal(total(r.body.review,'eligible'),0);assert.equal(total(r.body.review,'excluded'),4);
});
