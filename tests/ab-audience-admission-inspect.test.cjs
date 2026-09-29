'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{PGlite}=require('@electric-sql/pglite');
const F=require('./ab-audience-admission-fixture.cjs'),R=require('../n8n/growth/ab-audience-review.cjs'),I=require('../n8n/growth/ab-audience-admission-inspect.cjs'),S=require('../n8n/growth/segment-audience-store.cjs'),M=require('../n8n/growth/ab-audience-material-read.cjs');
const init=async t=>{const db=new PGlite();t.after(()=>db.close());return F.setup(db);};
for(const brand of ['fish','aristo'])test(brand+': inspect composes latest review, live consent and private material without writing or authorizing execution',async t=>{
 const x=await init(t),p=await x.prepared(brand),before=await x.snapshot();x.trace.length=0;const r=await x.inspectAdmission(p);assert.equal(r.status,200,JSON.stringify(r));
 const i=r.body.inspection;assert.equal(i.audience.arms.reduce((n,a)=>n+a.allocated,0),brand==='fish'?4:5);assert.deepEqual(i.audience.arms,p.review.arms);assert.equal(i.review_id,p.review.review_id);assert.equal(i.expires_at,p.review.expires_at);assert.equal(i.materials.length,2);assert.match(i.inspection_hash,/^[a-f0-9]{64}$/);
 assert.equal(r.body.external_dependencies_complete,false);assert.equal(r.body.authorizes_send,false);assert.equal(r.body.authorizes_selection,false);assert.equal(r.body.execution_blocked,true);assert.deepEqual(i.blockers,['external_material_unconfirmed','execution_path_not_installed']);
 assert.doesNotMatch(JSON.stringify(r),/subscriber_id|member_ids|from_email|body_source|synthetic-manager-key|<html|"snapshot"/);assert.equal(x.trace.some(q=>/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM)\b/i.test(q.text)),false);assert.deepEqual(await x.snapshot(),before);
 await assert.rejects(x.legacySchedule(p.protocol.arms[0].campaign_id));assert.equal((await x.db.query('SELECT enabled FROM crm_ab_runtime_v2')).rows[0].enabled,false);
});
test('later review supersedes the pinned one; unavailable latest never falls back to older confirmed counts',async t=>{
 const x=await init(t),p=await x.prepared(),next=await x.review(p);assert.equal((await x.inspectAdmission(p)).body.error,'AB_ADMISSION_REVIEW_CHANGED');
 const current={...p,review:next._body.review};assert.equal((await x.inspectAdmission(current)).status,200);
 await x.db.query("UPDATE crm_audience_v2.config SET enabled=false WHERE brand='fish'");const unavailable=await x.review(p);assert.equal(unavailable._body.review.status,'unavailable');
 assert.equal((await x.inspectAdmission(current)).body.error,'AB_ADMISSION_REVIEW_CHANGED');assert.equal((await x.inspectAdmission({...p,review:unavailable._body.review})).body.error,'AB_ADMISSION_REVIEW_UNAVAILABLE');
});
test('fresh opt-out requires a new review; outside insertion never expands the original allocation',async t=>{
 const x=await init(t),p=await x.prepared(),before=await x.members(p.protocol.test_id);await x.db.query("INSERT INTO subscriber_lists VALUES(9,101,'confirmed')");
 assert.equal((await x.inspectAdmission(p)).status,200);assert.deepEqual(await x.members(p.protocol.test_id),before);
 await x.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=17");assert.equal((await x.inspectAdmission(p)).body.error,'AB_ADMISSION_AUDIENCE_CHANGED');
 const newer=await x.review(p);const r=await x.inspectAdmission({...p,review:newer._body.review});assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.inspection.audience.arms.reduce((n,a)=>n+a.allocated,0),4);assert.equal(r.body.inspection.audience.arms.reduce((n,a)=>n+a.eligible,0),3);
});
test('edited audience head preserves the fixed revision; archive makes inspection unavailable',async t=>{
 const x=await init(t),p=await x.prepared(),a=p.audience;
 const changed=await x.audienceCall({acao:'segmento_salvar',brand:'fish',id:a.id,expected_version:a.version,expected_catalog_hash:x.catalogHashes.fish,definition:{...a.definition,name:'Changed head',rule:{op:'in_list',list_id:17}},idempotency_key:'admission-new-head'});assert.equal(changed.status,200,JSON.stringify(changed));
 const r=await x.inspectAdmission(p);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.inspection.audience.audience_revision,a.version);
 const archived=await x.audienceCall({acao:'segmento_arquivar',brand:'fish',id:a.id,expected_version:changed.body.segment.version,idempotency_key:'admission-archive'});assert.equal(archived.status,200);assert.equal((await x.inspectAdmission(p)).body.error,'AB_ADMISSION_AUDIENCE_CHANGED');
});
test('permissions, review ownership, scope, version, missing experiment and secret-bearing failures remain closed',async t=>{
 const x=await init(t),p=await x.prepared();for(const key of ['synthetic-reader-key','synthetic-writer-key','synthetic-cx-key'])assert.ok([401,403].includes((await x.inspectAdmission(p,key)).status));
 assert.equal((await x.inspectAdmission(p,'synthetic-other-key')).body.error,'AB_ADMISSION_REVIEW_CHANGED');
 const request=x.admissionRequest(p);for(const [change,code]of [[{expected_version:2},'AB_ADMISSION_VERSION'],[{expected_scope_hash:'f'.repeat(64)},'AB_ADMISSION_SCOPE'],[{brand:'aristo'},'AB_ADMISSION_NOT_FOUND']])assert.equal((await x.admissionCall({...request,...change})).body.error,code);
 x.control.beforeQuery=async q=>{if(q===R.SQL.latest)throw Error('synthetic secret must stay private');};assert.deepEqual((await x.inspectAdmission(p)).body,{error:'AB_ADMISSION_UNCONFIRMED'});x.control.beforeQuery=null;
});
test('source off and latest review below minimum cannot yield an inspection',async t=>{
 const x=await init(t),p=await x.prepared();await x.db.query("UPDATE crm_audience_v2.config SET enabled=false WHERE brand='fish'");assert.equal((await x.inspectAdmission(p)).body.error,'AB_ADMISSION_SOURCE_UNAVAILABLE');
 await x.db.query("UPDATE crm_audience_v2.config SET enabled=true WHERE brand='fish'");await x.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=17");const noRecipients=await x.review(p);assert.equal(noRecipients._body.review.minimum_reached,false);assert.equal((await x.inspectAdmission({...p,review:noRecipients._body.review})).body.error,'AB_ADMISSION_MINIMUM');
});
test('template drift and native timestamp drift never use material hashes to waive original campaign pins',async t=>{
 for(const mode of ['template','timestamp']){const x=await init(t),p=await x.prepared();await x.db.query(mode==='template'?"UPDATE templates SET body='changed' WHERE id=1":"UPDATE campaigns SET updated_at=clock_timestamp()+interval '1 second' WHERE id=100");assert.equal((await x.inspectAdmission(p)).body.error,'AB_ADMISSION_CAMPAIGN_CHANGED');}
});
test('expiry during read and permission revocation after dependency locks discard inspection',async t=>{
 for(const mode of ['expiry','permission']){
  const x=await init(t);if(mode==='expiry')await x.db.query("UPDATE crm_audience_v2.config SET checked_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()+interval '2 seconds' WHERE brand='fish'");const p=await x.prepared();let seen=false;
  x.control.afterQuery=async(q,v,tx)=>{if(!seen&&q.includes('crm_audience_v2.ab_audience_allocated_source(')){seen=true;if(mode==='expiry')await new Promise(r=>setTimeout(r,2100));else await tx.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"draft\",\"read_content\"]' WHERE principal_id='manager'");}};
  const r=await x.inspectAdmission(p);assert.equal(seen,true);assert.equal(r.status,mode==='permission'?403:503,JSON.stringify(r));assert.equal(Object.hasOwn(r.body,'inspection'),false);x.control.afterQuery=null;
 }
});
test('read deadlines, aborts and lost read ACK return 503 without a fictitious write operation',async t=>{
 const x=await init(t),p=await x.prepared(),before=await x.snapshot(),c=new AbortController();c.abort();assert.equal((await x.inspectAdmission(p,undefined,{signal:c.signal})).status,503);
 x.control.afterCommit=()=>{throw Error('lost read ACK');};const r=await x.inspectAdmission(p);assert.deepEqual(r.body,{error:'AB_ADMISSION_UNCONFIRMED'});assert.equal(r.status,503);x.control.afterCommit=null;assert.deepEqual(await x.snapshot(),before);
 const service=I.createAdmissionInspection({transaction:()=>new Promise(()=>{}),timeoutMs:15});const expired=await service.execute({key:'synthetic-manager-key',request:x.admissionRequest(p)});assert.equal(expired._http,503);assert.deepEqual(expired._body,{error:'AB_ADMISSION_UNCONFIRMED'});
});
test('different native microseconds, missing schedule and less than fifteen minutes are not a common schedule',async t=>{
 for(const mode of ['microseconds','missing','too-soon']){
  const x=await init(t),base=new Date(Date.now()+(mode==='too-soon'?600000:3600000)).toISOString().slice(0,19);
  await x.db.transaction(async tx=>{for(const id of [100,101]){await tx.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(id)]);await tx.query('UPDATE campaigns SET send_at=$1::timestamptz WHERE id=$2',[mode==='missing'?null:base+(mode==='microseconds'?(id===100?'.123001Z':'.123002Z'):'.000000Z'),id]);}});
  const p=await x.prepared(),r=await x.inspectAdmission(p);assert.equal(r.body.error,'AB_ADMISSION_SCHEDULE',JSON.stringify({mode,r}));
 }
});
test('the last database trip rechecks real-time review expiry, permission and key expiry',async t=>{
 for(const mode of ['expiry','permission','key']){
  const x=await init(t);if(mode==='expiry')await x.db.query("UPDATE crm_audience_v2.config SET checked_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()+interval '2 seconds' WHERE brand='fish'");const p=await x.prepared();let seen=false;
  x.control.beforeQuery=async(q,v,tx)=>{if(q===I.SQL.finish&&!seen){seen=true;if(mode==='expiry')await new Promise(r=>setTimeout(r,2100));else if(mode==='permission')await tx.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"draft\",\"read_content\"]' WHERE principal_id='manager'");else await tx.query("UPDATE crm_dash_chave SET expira_em=clock_timestamp()-interval '1 second' WHERE chave='manager'");}};
  const r=await x.inspectAdmission(p);assert.equal(seen,true);assert.equal(r.status,{expiry:409,permission:403,key:401}[mode],JSON.stringify({mode,r}));assert.equal(Object.hasOwn(r.body,'inspection'),false);x.control.beforeQuery=null;
 }
});
test('equivalent catalog refresh preserves review expiry; semantic source change is refused even if allocated counts stay the same',async t=>{
 const x=await init(t),p=await x.prepared();await x.db.query("UPDATE crm_audience_v2.config SET revision=revision+1,checked_at=clock_timestamp(),expires_at=clock_timestamp()+interval '5 minutes' WHERE brand='fish'");
 const r=await x.inspectAdmission(p);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.inspection.expires_at,p.review.expires_at);assert.deepEqual(r.body.inspection.audience.arms,p.review.arms);assert.equal(r.body.inspection.audience.snapshot_only,true);assert.ok(r.body.inspection.audience.checked_at<=r.body.inspection.checked_at);
 await x.db.query("UPDATE lists SET optin='single' WHERE id=101");assert.equal((await x.inspectAdmission(p)).body.error,'AB_ADMISSION_AUDIENCE_CHANGED');
});
test('legacy MD5 pins prepared in a non-UTC session are refused without rehashing or waiving their identity',async t=>{
 const x=await init(t);await x.db.query("SET TimeZone='America/Sao_Paulo'");const p=await x.prepared(),before=await x.snapshot();const r=await x.inspectAdmission(p);assert.equal(r.body.error,'AB_ADMISSION_CAMPAIGN_CHANGED');assert.deepEqual(await x.snapshot(),before);
});
