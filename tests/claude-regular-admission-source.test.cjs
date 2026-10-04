'use strict';
// Público salvo (gate OFF): fonte indisponível bloqueia a conferência e não vira zero.
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const F=require('./segment-regular-admission-fixture.cjs'),R=require('../n8n/growth/segment-regular-admission.cjs'),Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
test('fonte indisponível responde 503 sem gravar revisão; zero confirmado responde 409; nenhum agendamento',async t=>{
 const db=new PGlite();t.after(()=>db.close());const f=await F.setup(db);await f.approve();
 const unknown=R.createRegularAdmission({transaction:f.transaction,refreshCatalog:({query,brand})=>query('SELECT crm_audience_v2.refresh_native_catalog($1)',[brand]),
  countProvider:async(...args)=>({...await Counter.countAudience(...args),source_confirmed:false,eligible_count:null,unknown_reason:'list_source_unavailable'})});
 const reviews=async()=>(await db.query('SELECT count(*)::int n FROM crm_audience_v2.regular_admission_review')).rows[0].n;
 for(const brand of ['fish','aristo']){
  const p=await f.prepareRequest(brand),r=await unknown.execute({request:p,key:'synthetic-manager-key'});
  assert.equal(r._http,503,JSON.stringify(r));assert.deepEqual(r._body,{error:'REGULAR_ADMISSION_SOURCE_UNAVAILABLE'});
 }
 assert.equal(await reviews(),0);
 const ok=await f.call(await f.prepareRequest('fish'));assert.equal(ok.status,200,JSON.stringify(ok));assert.ok(ok.body.review.eligible_count>0);
 await db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=17");
 const zero=await f.call(await f.prepareRequest('fish'));assert.equal(zero.status,409);assert.deepEqual(zero.body,{error:'REGULAR_ADMISSION_EMPTY'});
 assert.equal((await f.current(100)).status,'draft');assert.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.regular_delivery_campaign')).rows[0].n,0);
});
