'use strict';
// Disposable original auth/SQLite/issuer fixtures; no remote identity or sends.
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,CAPS}=require('./corporate-writer-fixture.cjs');
const {corporateWriterDescriptor}=require('../services/dashboard-operational/crm-manager-runtime.cjs');
const {createServer}=require('../services/crm-manager-writer/server.cjs');
const DOMAINS=['oaristocrata.com','shrigma.com.br','fishermans.com.br'];
test('corporate descriptor and broker accept exactly the same closed three-domain set',async t=>{
 const f=await fixture(t),cfg=f.config;
 assert.equal(corporateWriterDescriptor(cfg.crmManagedWriter,cfg.crmManagedRead,DOMAINS).mode,'corporate-read-writer-v1');
 for(const domains of [DOMAINS.slice(0,1),DOMAINS.slice(0,2),[...DOMAINS,'foreign.invalid'],[DOMAINS[0],DOMAINS[1],DOMAINS[1]],['foreign.invalid',...DOMAINS.slice(1)]]){
  assert.throws(()=>corporateWriterDescriptor(cfg.crmManagedWriter,cfg.crmManagedRead,domains));
  assert.throws(()=>createServer({enabled:true,revision:'a'.repeat(40),issuerId:cfg.crmManagedWriter.issuerId,namespaceId:cfg.crmManagedWriter.namespaceId,allowedEmailDomains:domains,provisionerToken:'S'.repeat(43),pool:{connect(){throw Error('must not connect');}}}));
 }
 assert.throws(()=>f.invite('synthetic@foreign.invalid'));assert.equal(f.events.length,0);
});
test('Fishermans and Shrigma managers use the original lifecycle and retain their own signed brand',async t=>{
 const f=await fixture(t),master=f.masterBaseline();
 for(const domain of ['fishermans.com.br','shrigma.com.br']){
  const email='synthetic-'+domain.split('.')[0]+'@'+domain,id=await f.manager(email);
  assert.deepEqual(await f.issue(id),{state:'ready'});
  const q=f.auth.managedCampaignWriterJournal.request(f.operation(id));assert.equal(q.owner,email);assert.equal(q.brand,'fish');assert.deepEqual(q.caps,CAPS);
  const context=await f.login(email);assert.equal(f.auth.campaignWriterReady(context),true);
  f.db.prepare("UPDATE user_brand_grants_v1 SET brand='aristo' WHERE user_id=?").run(id);
  assert.equal(f.auth.campaignWriterReady(context),false);
 }
 assert.deepEqual(f.masterBaseline(),master);
});
test('actual writer SQL issuer permits the corporate set and denies foreign-domain preparation before a ledger write',async t=>{
 const {PGlite}=require('@electric-sql/pglite'),R=require('./crm-manager-provision-postgres.test.cjs'),W=require('../tools/crm-manager-writer-review/writer-provision.test.cjs');
 const f=await W.createWriterFixture(t,{Engine:PGlite,readFixture:R.createFixture,register:true});
 await f.db.query('UPDATE public.crm_manager_writer_issuer_v1 SET allowed_email_domains=$1::text[] WHERE issuer_id=$2',[DOMAINS,W.A.issuerId]);
 const invalid=W.prepare({owner:'synthetic@foreign.invalid'}),before=(await f.db.query('SELECT count(*)::int n FROM crm_manager_writer_operation_v1')).rows[0].n;
 assert.equal((await f.call(invalid)).code,'INPUT_INVALID');assert.equal((await f.db.query('SELECT count(*)::int n FROM crm_manager_writer_operation_v1')).rows[0].n,before);assert.equal(await f.key(invalid),undefined);
 const q=W.prepare({owner:'synthetic@fishermans.com.br',brand:'fish'}),prepared=await f.call(q);assert.equal(prepared.state,'prepared');const committed=await f.call(W.commit(q,prepared));assert.equal(committed.state,'committed');assert.equal(committed.brand,'fish');assert.deepEqual(await f.permissions(q),[{area:'growth',caps:CAPS}]);await f.unchanged();
});
