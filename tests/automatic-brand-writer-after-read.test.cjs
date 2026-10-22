'use strict';
// Real original auth/SQLite/crypto/journal; transport and identity are fixtures.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const {fixture,pending}=require('./corporate-writer-fixture.cjs');
test('Master chosen edit queues only after current READ proof and reaches original writer readiness without a second approval',async t=>{
 const f=await fixture(t),master=f.masterBaseline(),invite=f.invite('synthetic@fishermans.com.br');await f.accept(invite);
 assert.deepEqual(f.auth.fulfillManagedCampaignWriterRequests(),{queued:0});assert.equal(f.events.length,0);assert.equal(f.db.prepare('SELECT approved FROM crm_writer_auth_admission_v1 WHERE user_id=?').get(invite.userId).approved,0);
 f.promoteRead(invite.userId);assert.deepEqual(f.auth.fulfillManagedCampaignWriterRequests(),{queued:1});const op=f.operation(invite.userId),q=f.auth.managedCampaignWriterJournal.request(op);assert.equal(q.owner,'synthetic@fishermans.com.br');assert.equal(q.brand,'fish');
 assert.equal(f.db.prepare("SELECT can_edit FROM grants WHERE user_id=? AND area='growth'").get(invite.userId).can_edit,0);assert.deepEqual(f.auth.fulfillManagedCampaignWriterRequests(),{queued:0});
 assert.deepEqual(await f.coordinator.run(op),{state:'ready'});assert.equal(f.auth.campaignWriterReady(await f.login('synthetic@fishermans.com.br')),true);assert.deepEqual(f.masterBaseline(),master);assert.equal(f.events.filter(e=>e==='prepare_writer').length,1);assert.equal(f.events.filter(e=>e==='commit_writer').length,1);
});
test('read selection and unsigned historical edit requests cannot authorize a new writer',async t=>{
 const f=await fixture(t),i=f.auth.createInvite({context:f.context,email:'synthetic-read@shrigma.com.br',areas:['growth'],brand:'aristo',requestedAccess:'read'});await f.accept(i);f.promoteRead(i.userId);
 assert.deepEqual(f.auth.fulfillManagedCampaignWriterRequests(),{queued:0});f.db.prepare("INSERT INTO access_requests VALUES(?,'edit',?)").run(i.userId,f.now);assert.deepEqual(f.auth.fulfillManagedCampaignWriterRequests(),{queued:0});assert.equal(f.events.length,0);
 f.auth.setRequestedAccess({context:f.context,userId:i.userId,requestedAccess:'edit'});assert.deepEqual(f.auth.fulfillManagedCampaignWriterRequests(),{queued:1});assert.equal(f.auth.managedCampaignWriterJournal.request(f.operation(i.userId)).brand,'aristo');
});
test('signed request, owner/brand/current READ and unresolved journal remain authoritative',async t=>{
 for(const mutate of [f=>f.db.prepare('UPDATE crm_writer_request_authority_v1 SET authority_mac=?').run('0'.repeat(64)),f=>f.db.prepare('UPDATE access_requests SET requested_at=requested_at+1').run(),f=>f.db.prepare("UPDATE user_brand_grants_v1 SET brand='aristo'").run(),f=>f.db.prepare("UPDATE users SET state='disabled' WHERE role='manager'").run(),f=>f.db.prepare("UPDATE crm_manager_lifecycles_v1 SET state='revoked'").run(),(f,id)=>pending(f,id,'crm_campaign_delivery_v1','uncertain','fish')]){
  const f=await fixture(t),id=await f.manager();mutate(f,id);assert.deepEqual(f.auth.fulfillManagedCampaignWriterRequests(),{queued:0});assert.equal(f.events.length,0);assert.equal(f.db.prepare('SELECT count(*) n FROM crm_writer_bridge_op_v1').get().n,0);assert.equal(f.db.prepare("SELECT can_edit FROM grants WHERE user_id=? AND area='growth'").get(id).can_edit,0);
 }
});
test('crash between READ promotion and enqueue recovers from persistent intent after restart without new READ generation',async t=>{
 const f=await fixture(t),id=await f.manager(),before=f.db.prepare('SELECT * FROM crm_manager_lifecycles_v1 WHERE user_id=?').get(id);f.restart();assert.deepEqual(f.auth.fulfillManagedCampaignWriterRequests(),{queued:1});assert.deepEqual(f.db.prepare('SELECT * FROM crm_manager_lifecycles_v1 WHERE user_id=?').get(id),before);assert.deepEqual(f.auth.fulfillManagedCampaignWriterRequests(),{queued:0});assert.equal(f.db.prepare('SELECT count(*) n FROM crm_writer_bridge_op_v1').get().n,1);
});
test('failed enqueue preserves the inactive approved admission and recovers exactly once',async t=>{
 const f=await fixture(t),id=await f.manager();f.db.exec("CREATE TRIGGER synthetic_queue_failure BEFORE INSERT ON crm_writer_bridge_op_v1 BEGIN SELECT RAISE(ABORT,'synthetic-queue-failure'); END;");assert.deepEqual(f.auth.fulfillManagedCampaignWriterRequests(),{queued:0});const a=f.db.prepare('SELECT * FROM crm_writer_auth_admission_v1 WHERE user_id=?').get(id);assert.equal(a.approved,1);assert.equal(f.db.prepare('SELECT count(*) n FROM crm_writer_bridge_life_v1').get().n,0);assert.equal(f.events.length,0);
 f.db.exec('DROP TRIGGER synthetic_queue_failure');assert.deepEqual(f.auth.fulfillManagedCampaignWriterRequests(),{queued:1});assert.deepEqual(f.db.prepare('SELECT * FROM crm_writer_auth_admission_v1 WHERE user_id=?').get(id),a);assert.deepEqual(f.auth.fulfillManagedCampaignWriterRequests(),{queued:0});
});
test('private runtime orders READ then local fulfillment then WRITER and keeps revoke processing after a READ refusal',async()=>{
 const file=path.join(__dirname,'../services/dashboard-operational/server.cjs'),real=createRequire(file),events=[];let readRefused=false;
 const module={exports:{}},r=requireName=>requireName==='./crm-manager-runtime.cjs'?{createManagerRuntime:()=>({kick:async()=>{events.push('read');if(readRefused)throw Error('synthetic-refusal');return{ready:1};},close:async()=>{}}),createWriterManagerRuntime:()=>({kick:async()=>{events.push('writer');return{ready:1};},close:async()=>{}})}:real(requireName);
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{require:r,module,exports:module.exports,__dirname:path.dirname(file),Buffer,URL,URLSearchParams,process,console,setTimeout,clearTimeout},{filename:file});
 const runtime=module.exports.managedRuntimeFor({crmManagedRead:{},crmManagedWriter:{}},{fulfillManagedCampaignWriterRequests(){events.push('fulfill');}});await runtime.kick();assert.deepEqual(events,['read','fulfill','writer']);events.length=0;readRefused=true;await runtime.kick();assert.deepEqual(events,['read','writer']);
});
