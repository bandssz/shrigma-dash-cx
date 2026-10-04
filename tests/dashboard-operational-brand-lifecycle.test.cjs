'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture}=require('./corporate-writer-fixture.cjs');
const read=ctx=>({...ctx,method:'GET',brand:'fish'});
const code=(name,status)=>e=>e.code===name&&e.status===status;

test('requested edit never promotes FULL and explicit promotion preserves the exact READ brand/lifecycle',async t=>{
 const f=await fixture(t),id=await f.manager(),ctx=await f.login();
 const scope=f.db.prepare('SELECT * FROM user_brand_grants_v1 WHERE user_id=?').get(id),reader=f.db.prepare("SELECT * FROM user_brand_lifecycles_v1 WHERE user_id=? AND kind='read'").get(id);
 assert.equal(f.auth.session(ctx).user.brand,'fish');assert.equal(f.auth.campaignWriterReady(ctx),false);
 assert.throws(()=>f.auth.authorize({...ctx,area:'growth',edit:true,brand:'fish'}),code('GRANT_DENIED',403));
 assert.match(f.auth.managedCrmReadAuthorization(read(ctx)).principalId,/^dcrm-/);
 assert.throws(()=>f.auth.managedCrmReadAuthorization({...read(ctx),brand:'aristo'}),code('BRAND_DENIED',403));
 assert.deepEqual(await f.issue(id),{state:'ready'});assert.equal(f.auth.campaignWriterReady(ctx),true);
 assert.equal(f.auth.campaignWriterAuthorization(ctx,{brand:'fish',action:'salvar'}).userId,id);
 assert.throws(()=>f.auth.campaignWriterAuthorization(ctx,{brand:'aristo',action:'salvar'}),code('BRAND_DENIED',403));
 assert.deepEqual(f.db.prepare('SELECT * FROM user_brand_grants_v1 WHERE user_id=?').get(id),scope);
 assert.deepEqual(f.db.prepare("SELECT * FROM user_brand_lifecycles_v1 WHERE user_id=? AND kind='read'").get(id),reader);
 const writer=f.db.prepare("SELECT * FROM user_brand_lifecycles_v1 WHERE user_id=? AND kind='writer'").get(id),admission=f.db.prepare('SELECT * FROM crm_writer_auth_admission_v1 WHERE user_id=?').get(id);assert.equal(writer.lifecycle_id,admission.lifecycle_id);
 const n=f.events.length;for(const action of ['criar','salvar','validar','agendar','cancelar','operacao'])assert.throws(()=>f.auth.campaignWriterAuthorization(ctx,{brand:'aristo',action}),code('BRAND_DENIED',403));assert.equal(f.events.length,n);
});

test('brand bound READ/WRITER rotation keeps receipts, closes sessions on downgrade and cannot swap lifecycle',async t=>{
 const f=await fixture(t),id=await f.manager(),ctx=await f.login();assert.deepEqual(await f.issue(id),{state:'ready'});
 const initial=f.db.prepare('SELECT * FROM user_brand_grants_v1 WHERE user_id=?').get(id),old=f.db.prepare("SELECT * FROM user_brand_lifecycles_v1 WHERE user_id=? AND kind='writer'").get(id);
 f.auth.setRequestedAccess({context:f.context,userId:id,requestedAccess:'read'});assert.equal(f.auth.session(ctx).authenticated,false);
 assert.deepEqual(await f.coordinator.run(f.auth.managedCampaignWriterJournal.pending()[0]),{state:'revoked'});
 f.auth.renewManagedCrm({context:f.context,userId:id});f.promoteRead(id);
 f.auth.setRequestedAccess({context:f.context,userId:id,requestedAccess:'edit'});assert.deepEqual(await f.issue(id),{state:'ready'});
 const current=f.db.prepare("SELECT * FROM user_brand_lifecycles_v1 WHERE user_id=? AND kind='writer'").get(id);assert.notEqual(current.lifecycle_id,old.lifecycle_id);assert.deepEqual(f.db.prepare('SELECT * FROM user_brand_grants_v1 WHERE user_id=?').get(id),initial);
 const login=await f.login();assert.equal(f.auth.session(login).user.brand,'fish');assert.equal(f.auth.campaignWriterReady(login),true);
 f.db.prepare('UPDATE crm_writer_auth_admission_v1 SET lifecycle_id=? WHERE user_id=?').run(crypto.randomUUID(),id);
 assert.equal(f.auth.session(login).authenticated,false);assert.equal(f.auth.campaignWriterReady(login),false);
 assert.equal(f.auth.users({context:f.context}).find(u=>u.id===id).brandAccess,'reprovision_required');
});

test('managed READ ciphertext from another subject cannot authorize either brand',async t=>{
 const f=await fixture(t),a=await f.manager('a@oaristocrata.com');
 const invitation=f.invite('b@oaristocrata.com','growth','aristo');await f.accept(invitation);f.promoteRead(invitation.userId);const ac=await f.login('a@oaristocrata.com');
 const row=f.db.prepare("SELECT encrypted_key,key_digest FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").get(invitation.userId);
 f.db.prepare("UPDATE upstream_credentials SET encrypted_key=?,key_digest=? WHERE user_id=? AND slot='crm-panel-read'").run(row.encrypted_key,row.key_digest,a);
 assert.throws(()=>f.auth.getUpstreamCredential({...read(ac),area:'growth',edit:false,slot:'crm-panel-read'}),code('CRM_ACCESS_NOT_READY',503));
 assert.throws(()=>f.auth.getUpstreamCredential({...read(ac),area:'growth',edit:false,slot:'crm-panel-read',brand:'aristo'}),code('BRAND_DENIED',403));
 assert.equal(f.auth.managedCrmJournal.credentialReady(a),false);assert.equal(f.auth.managedCrmJournal.credentialReady(invitation.userId),true);
});
