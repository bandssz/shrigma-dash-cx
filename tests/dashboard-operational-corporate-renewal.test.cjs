'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Readable}=require('node:stream'),{EventEmitter}=require('node:events');
const {fixture,pending,hosts}=require('./corporate-writer-fixture.cjs');
const Server=require('../services/dashboard-operational/server.cjs');
const TTL=14*86400000;
const slot=(f,id,name)=>f.db.prepare('SELECT * FROM upstream_credentials WHERE user_id=? AND slot=?').get(id,name);
const user=(f,id)=>f.db.prepare('SELECT * FROM users WHERE id=?').get(id);
const row=(f,id)=>f.auth.users({context:f.context}).find(u=>u.id===id);
const writer=(f,id)=>f.db.prepare('SELECT * FROM crm_writer_auth_binding_v1 WHERE user_id=?').get(id);
const throws=(fn,code)=>assert.throws(fn,e=>e.code===code);
const renew=(f,id)=>f.auth.renewManagedCampaignWriter({context:f.context,userId:id});
const renewRead=(f,id)=>f.auth.renewManagedCrm({context:f.context,userId:id});
async function admin(f){const r=await f.auth.login({email:f.config.bootstrapAdminEmail,password:'Synthetic writer manager password 2026!',host:hosts.manager,origin:'https://'+hosts.manager});Object.assign(f.context,{cookieHeader:r.cookie.split(';')[0],csrf:r.csrf});}
function settings(f){const url='https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-campanhas-api-a40da4ef222efba3f7278e35';return{...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,crmManagedWriter:{...f.config.crmManagedWriter,provisionerToken:'S'.repeat(43)},upstreams:{'crm-read':'https://comunicacao-crm-panel-read.tazdb8.easypanel.host/read',campaigns:url},allowedUpstreamHosts:['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host'],dynamicRouteManifest:{schema:'shrigma_dashboard_dynamic_upstreams_v1',sourceRevision:'4517cc3d3060a75e9d11c360479054cb0bd4d459',routes:{campaigns:url}}};}
function handler(server,ctx,b){return new Promise(resolve=>{const req=Readable.from([Buffer.from(JSON.stringify(b))],{objectMode:false});Object.assign(req,{url:'/auth/users',method:'POST',headers:{host:ctx.host,origin:ctx.origin,cookie:ctx.cookieHeader,'x-csrf-token':ctx.csrf,'content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'}});const res=new EventEmitter();res.setHeader=()=>{};res.end=body=>{res.emit('finish');resolve({status:res.statusCode,body:JSON.parse(String(body))});};server.emit('request',req,res);});}

test('already active corporate READ pilot requests a distinct unapproved WRITER without resetting password/login/READ/master',async t=>{
 const f=await fixture(t),id=await f.manager(),ctx=await f.login(),master=f.masterBaseline();
 // The earlier READ-only pilot has no WRITER admission or WRITER binding.
 f.db.prepare('DELETE FROM crm_writer_auth_admission_v1 WHERE user_id=?').run(id);f.db.prepare('DELETE FROM access_requests WHERE user_id=?').run(id);
 const before=user(f,id),read=slot(f,id,'crm-panel-read'),readBinding=f.auth.managedCrmJournal.readBinding(id),sessions=f.db.prepare('SELECT * FROM sessions WHERE user_id=?').all(id);
 f.auth.setRequestedAccess({context:f.context,userId:id,requestedAccess:'edit'});
 const a=f.db.prepare('SELECT * FROM crm_writer_auth_admission_v1 WHERE user_id=?').get(id);
 assert.ok(a);assert.equal(a.approved,0);assert.notEqual(a.lifecycle_id,readBinding.lifecycleId);assert.notEqual(a.namespace_id,f.config.crmManagedRead.namespaceId);
 assert.equal(row(f,id).crmWriter.canApprove,true);assert.equal(row(f,id).permissions.growth.edit,false);assert.equal(f.auth.campaignWriterReady(ctx),false);
 assert.deepEqual(slot(f,id,'crm-panel-read'),read);assert.equal(user(f,id).password_hash,before.password_hash);assert.equal(user(f,id).state,'active');assert.deepEqual(f.db.prepare('SELECT * FROM sessions WHERE user_id=?').all(id),sessions);assert.deepEqual(f.masterBaseline(),master);assert.deepEqual(f.events,[]);
 f.approval(id);assert.equal(f.auth.campaignWriterReady(ctx),false);assert.deepEqual(await f.coordinator.run(f.operation(id)),{state:'ready'});assert.equal(f.auth.campaignWriterReady(ctx),true);assert.notEqual(writer(f,id).principal_id,readBinding.principalId);
});

test('corporate approval requires explicit edit request and cannot admit master or another panel',async t=>{
 const f=await fixture(t),id=await f.manager();f.db.prepare('DELETE FROM access_requests WHERE user_id=?').run(id);throws(()=>f.approval(id),'CRM_WRITER_REQUEST_REQUIRED');assert.equal(f.auth.managedCampaignWriterJournal.pending().length,0);
 const org=f.invite('organic@oaristocrata.com','organico');await f.accept(org);
 for(const target of [f.master.user.id,org.userId])assert.throws(()=>f.atomic(()=>f.adapter.requestLifecycle(target)));
 assert.equal(f.db.prepare('SELECT count(*) n FROM crm_writer_auth_admission_v1 WHERE user_id IN(?,?)').get(f.master.user.id,org.userId).n,0);
});

test('WRITER renewal closes editing transactionally, preserves READ/login and rotates only after FULL proof/CAS',async t=>{
 const f=await fixture(t),id=await f.manager(),ctx=await f.login();assert.deepEqual(await f.issue(id),{state:'ready'});const before=writer(f,id),oldRead=slot(f,id,'crm-panel-read'),sessions=f.db.prepare('SELECT * FROM sessions WHERE user_id=?').all(id),oldOp=f.operation(id),oldProof=f.db.prepare('SELECT * FROM crm_writer_bridge_op_v1 WHERE operation_id=?').get(oldOp),master=f.masterBaseline();
 f.advance(60000);assert.deepEqual(renew(f,id),{ok:true,state:'renewing'});const op=f.operation(id);assert.notEqual(op,oldOp);assert.equal(row(f,id).crmWriter.state,'renewing');assert.equal(row(f,id).permissions.growth.edit,false);assert.equal(f.auth.managedCrmJournal.credentialReady(id),true);assert.equal(f.auth.campaignWriterReady(ctx),false);assert.deepEqual(slot(f,id,'crm-panel-read'),oldRead);assert.deepEqual(f.db.prepare('SELECT * FROM sessions WHERE user_id=?').all(id).map(({idle_expires_at,...r})=>r),sessions.map(({idle_expires_at,...r})=>r));
 const eventCount=f.events.length;throws(()=>renew(f,id),'CRM_WRITER_RENEWAL_PENDING');throws(()=>renewRead(f,id),'CRM_WRITER_RENEWAL_PENDING');assert.equal(f.events.length,eventCount);assert.equal(f.operation(id),op);
 assert.deepEqual(await f.coordinator.run(op),{state:'ready'});const after=writer(f,id);assert.equal(after.generation,2);assert.equal(after.lifecycle_id,before.lifecycle_id);assert.notEqual(after.principal_id,before.principal_id);assert.notEqual(after.credential_mac,before.credential_mac);assert.equal(after.expires_at,f.now+TTL);assert.equal(f.auth.campaignWriterReady(ctx),true);assert.deepEqual(slot(f,id,'crm-panel-read'),oldRead);assert.deepEqual(f.db.prepare('SELECT * FROM crm_writer_bridge_op_v1 WHERE operation_id=?').get(oldOp),oldProof);assert.deepEqual(f.masterBaseline(),master);
 assert.deepEqual(f.events.slice(eventCount),['renew_writer','writer_status','commit_writer','FULL_ATTEST']);
 const events=[...f.events];assert.deepEqual(await f.coordinator.run(op),{state:'ready'});assert.deepEqual(f.events,events);
});

test('pending campaign actors in every journal and either brand prohibit request/READ/WRITER renewal without touching rows or RPC',async t=>{
 const f=await fixture(t),id=await f.manager();await f.issue(id);
 for(const [table,phase,brand] of [['campaign_draft_operations','uncertain','fish'],['crm_campaign_delivery_v1','confirmed','aristo'],['crm_campaign_create_v1','queued','fish']]){
  pending(f,id,table,phase,brand);const before=f.db.prepare('SELECT * FROM '+table).all(),actor=writer(f,id),events=[...f.events];
  for(const action of [()=>renew(f,id),()=>renewRead(f,id),()=>f.auth.setRequestedAccess({context:f.context,userId:id,requestedAccess:'edit'})])throws(action,'CAMPAIGN_RECONCILIATION_REQUIRED');
  assert.equal(row(f,id).crmAccess.canRenew,false);assert.equal(row(f,id).crmWriter.canRenew,false);assert.deepEqual(f.db.prepare('SELECT * FROM '+table).all(),before);assert.deepEqual(writer(f,id),actor);assert.deepEqual(f.events,events);f.db.prepare('DELETE FROM '+table+' WHERE user_id=?').run(id);
 }
});

test('READ renewal stages WRITER revocation then creates separate READ generation and requires explicit new FULL WRITER approval',async t=>{
 const f=await fixture(t),id=await f.manager(),ctx=await f.login();await f.issue(id);const oldW=writer(f,id),oldR=f.auth.managedCrmJournal.readBinding(id),password=user(f,id).password_hash,master=f.masterBaseline();f.advance(60000);
 assert.deepEqual(renewRead(f,id),{ok:true,state:'writer_revocation_pending'});assert.equal(row(f,id).crmAccess.writerRevocationPending,true);assert.equal(f.auth.managedCrmJournal.credentialReady(id),true);assert.equal(f.auth.campaignWriterReady(ctx),false);assert.equal(f.auth.managedCrmJournal.pendingOperations(8).length,0);throws(()=>renewRead(f,id),'CRM_WRITER_REVOCATION_PENDING');
 const revoke=f.auth.managedCampaignWriterJournal.pending()[0];assert.deepEqual(await f.coordinator.run(revoke),{state:'revoked'});assert.deepEqual(renewRead(f,id),{ok:true});const newR=f.promoteRead(id);assert.equal(newR.generation,2);assert.notEqual(newR.principalId,oldR.principalId);assert.equal(f.auth.campaignWriterReady(ctx),false);assert.equal(user(f,id).password_hash,password);
 assert.deepEqual(await f.issue(id),{state:'ready'});const newW=writer(f,id);assert.notEqual(newW.lifecycle_id,oldW.lifecycle_id);assert.notEqual(newW.principal_id,oldW.principal_id);assert.notEqual(newW.principal_id,newR.principalId);assert.equal(newW.generation,1);assert.equal(f.auth.campaignWriterReady(ctx),true);assert.deepEqual(f.masterBaseline(),master);
});

test('expired READ+WRITER can recover through original private metadata without reinvite or artificial READ readiness',async t=>{
 const f=await fixture(t),id=await f.manager();await f.issue(id);const before=user(f,id),read=slot(f,id,'crm-panel-read'),oldR=f.auth.managedCrmJournal.status(id),oldW=writer(f,id);f.advance(TTL+1);await admin(f);
 assert.equal(f.auth.managedCrmJournal.credentialReady(id),false);assert.equal(f.auth.managedCrmJournal.renewalReady(id),true);assert.equal(row(f,id).crmAccess.canRenew,true);assert.equal(row(f,id).crmWriter.canRenew,false);assert.equal(row(f,id).crmAccess.expired,true);
 throws(()=>renew(f,id),'CRM_ACCESS_NOT_READY');assert.deepEqual(renewRead(f,id),{ok:true,state:'writer_revocation_pending'});assert.equal(f.auth.managedCrmJournal.credentialReady(id),false);assert.deepEqual(slot(f,id,'crm-panel-read'),read);
 const rev=f.auth.managedCampaignWriterJournal.pending()[0];assert.deepEqual(await f.coordinator.run(rev),{state:'revoked'});assert.deepEqual(renewRead(f,id),{ok:true});assert.equal(f.auth.managedCrmJournal.credentialReady(id),false);const newR=f.promoteRead(id);assert.equal(newR.generation,oldR.generation+1);assert.equal(f.auth.managedCrmJournal.credentialReady(id),true);assert.equal(row(f,id).permissions.growth.edit,false);
 assert.deepEqual(await f.issue(id),{state:'ready'});assert.notEqual(writer(f,id).lifecycle_id,oldW.lifecycle_id);assert.equal(user(f,id).password_hash,before.password_hash);assert.equal(user(f,id).state,'active');assert.equal(f.db.prepare('SELECT count(*) n FROM invites WHERE user_id=?').get(id).n,1);
});

test('expired WRITER with separately current READ renews under same WRITER life with fresh FULL, no inherited READ identity',async t=>{
 const f=await fixture(t),id=await f.manager();await f.issue(id);const oldW=writer(f,id);f.advance(86400000);
 // Valid independently renewed READ generation from an earlier isolated READ
 // operator. Structural fixture changes do not grant the tested HTTP action.
 f.atomic(()=>f.adapter.quiesce(id));f.auth.managedCrmJournal.renew(id);f.promoteRead(id);f.db.prepare('UPDATE grants SET can_edit=1 WHERE user_id=?').run(id);
 f.advance(TTL-86400000+1);await admin(f);const read=slot(f,id,'crm-panel-read');assert.equal(f.adapter.bindingForUser(id),null);assert.equal(f.auth.managedCrmJournal.credentialReady(id),false);assert.equal(row(f,id).crmWriter.canRenew,true);
 assert.deepEqual(renew(f,id),{ok:true,state:'renewing'});assert.equal(f.auth.managedCrmJournal.credentialReady(id),true);assert.deepEqual(await f.coordinator.run(f.operation(id)),{state:'ready'});const w=writer(f,id);assert.equal(w.generation,2);assert.equal(w.lifecycle_id,oldW.lifecycle_id);assert.notEqual(w.principal_id,oldW.principal_id);assert.deepEqual(slot(f,id,'crm-panel-read'),read);
});

test('WRITER renewal enqueue failure rolls back quiescence and preserves original ready actor and login',async t=>{
 const f=await fixture(t),id=await f.manager(),ctx=await f.login();await f.issue(id);const before=writer(f,id),events=[...f.events],sessions=f.db.prepare('SELECT * FROM sessions WHERE user_id=?').all(id);
 f.db.exec("CREATE TRIGGER fixture_deny_writer_renew BEFORE INSERT ON crm_writer_bridge_op_v1 WHEN NEW.kind='renew' BEGIN SELECT RAISE(ABORT,'synthetic fixture refusal'); END");throws(()=>renew(f,id),'MANAGED_WRITER_STORE_UNAVAILABLE');assert.equal(row(f,id).permissions.growth.edit,true);assert.equal(f.auth.campaignWriterReady(ctx),true);assert.deepEqual(writer(f,id),before);assert.deepEqual(f.events,events);assert.deepEqual(f.db.prepare('SELECT * FROM sessions WHERE user_id=?').all(id),sessions);assert.equal(f.db.prepare("SELECT count(*) n FROM crm_writer_bridge_op_v1 WHERE kind='renew'").get().n,0);
});

test('expired READ metadata drift cannot restore access or prepare any new credential',async t=>{
 const f=await fixture(t),id=await f.manager();await f.issue(id);f.advance(TTL+1);await admin(f);const before=writer(f,id),events=[...f.events];f.db.prepare("UPDATE upstream_credentials SET key_digest=? WHERE user_id=? AND slot='crm-panel-read'").run('a'.repeat(64),id);
 assert.equal(f.auth.managedCrmJournal.renewalReady(id),false);assert.equal(row(f,id).crmAccess.canRenew,false);throws(()=>renewRead(f,id),'CRM_RENEWAL_NOT_READY');assert.deepEqual(writer(f,id),before);assert.deepEqual(f.events,events);
});

test('manual WRITER renewal HTTP is exact admin+Origin+CSRF and only kicks after durable COMMIT',async t=>{
 const f=await fixture(t),id=await f.manager();await f.issue(id);let kicks=0;const server=Server.createServer(settings(f),{auth:f.auth,managedCrmRuntime:{kick:()=>{assert.equal(f.db.isTransaction,false);assert.equal(f.db.prepare("SELECT count(*) n FROM crm_writer_bridge_op_v1 WHERE kind='renew' AND phase='queued'").get().n,1);assert.equal(row(f,id).permissions.growth.edit,false);kicks++;return Promise.resolve();},close:()=>Promise.resolve()},fetchImpl:()=>{throw Error('NO_UPSTREAM');}});t.after(()=>server.removeAllListeners());
 for(const ctx of [await f.login(),{...f.context,csrf:'forged'},{...f.context,origin:'https://other.invalid'}])assert.equal((await handler(server,ctx,{action:'crm_writer_renew',userId:id})).status,403);
 assert.equal((await handler(server,f.context,{action:'crm_writer_renew',userId:id,unexpected:true})).status,400);assert.equal(kicks,0);const r=await handler(server,f.context,{action:'crm_writer_renew',userId:id});assert.equal(r.status,202);assert.deepEqual(r.body,{ok:true,state:'renewing'});await new Promise(resolve=>setImmediate(resolve));assert.equal(kicks,1);assert.doesNotMatch(JSON.stringify(r),/bearer|principal|credential|namespace|lifecycle|operationId/);
 const again=await handler(server,f.context,{action:'crm_writer_renew',userId:id});assert.equal(again.status,409);assert.equal(again.body.error,'CRM_WRITER_RENEWAL_PENDING');assert.equal(kicks,1);
});

test('lost WRITER renewal COMMIT ACK reconciles the original operation without a second prepare/commit or new actor',async t=>{
 const f=await fixture(t),id=await f.manager();await f.issue(id);const old=writer(f,id);renew(f,id);const op=f.operation(id),before=f.events.length;
 const coordinator=require('../services/dashboard-operational/crm-manager-writer-coordinator.cjs').createWriterCoordinator({journal:f.auth.managedCampaignWriterJournal,client:{...f.client,commit:async q=>{await f.client.commit(q);throw Error('synthetic ACK lost after remote COMMIT');}},attest:()=>{throw Error('UNREACHABLE_BEFORE_COMMIT_ACK');},now:()=>f.now});
 assert.deepEqual(await coordinator.run(op),{state:'pending'});assert.equal(f.auth.managedCampaignWriterJournal.state(op).phase,'commit_uncertain');assert.equal(row(f,id).permissions.growth.edit,false);assert.equal(f.auth.managedCrmJournal.credentialReady(id),true);assert.deepEqual(writer(f,id),old);
 assert.deepEqual(await f.coordinator.run(op),{state:'ready'});assert.equal(f.operation(id),op);assert.equal(writer(f,id).generation,2);assert.equal(f.events.slice(before).filter(e=>e==='renew_writer').length,1);assert.equal(f.events.slice(before).filter(e=>e==='commit_writer').length,1);assert.equal(f.events.slice(before).filter(e=>e==='FULL_ATTEST').length,1);
});

test('forced disable during queued renewal stages both revokes and preserves actors/reservations without launching renewal POST',async t=>{
 const f=await fixture(t),id=await f.manager();await f.issue(id);const old=writer(f,id);renew(f,id);const op=f.operation(id);pending(f,id,'crm_campaign_delivery_v1','uncertain','aristo');const reservation=f.db.prepare('SELECT * FROM crm_campaign_delivery_v1').all(),before=f.events.length,password=user(f,id).password_hash;
 f.auth.revokeUser({context:f.context,userId:id});assert.equal(user(f,id).state,'disabled');assert.equal(user(f,id).password_hash,null);assert.equal(f.auth.managedCrmJournal.credentialReady(id),false);assert.deepEqual(f.db.prepare('SELECT * FROM crm_campaign_delivery_v1').all(),reservation);
 const retired=f.db.prepare('SELECT * FROM crm_writer_retired_binding_v1 WHERE user_id=?').get(id);assert.equal(retired.principal_id,old.principal_id);assert.equal(retired.credential_mac,old.credential_mac);assert.match(retired.encrypted_key,/^v1\./);assert.equal(writer(f,id),undefined);assert.equal(f.auth.managedCrmJournal.pendingOperations(8).length,1);
 assert.deepEqual(await f.coordinator.run(op),{state:'revoked'});assert.equal(f.events.slice(before).filter(e=>e==='renew_writer'||e==='commit_writer').length,0);assert.equal(f.events.slice(before).filter(e=>e==='revoke_writer').length,1);assert.deepEqual(f.db.prepare('SELECT * FROM crm_campaign_delivery_v1').all(),reservation);throws(()=>renew(f,id),'CRM_ACCESS_NOT_READY');
});

test('owner/generation/cipher/MAC drift in retained expired bindings refuses renewal and any regrant',async t=>{
 const f=await fixture(t),id=await f.manager();await f.issue(id);f.advance(TTL+1);await admin(f);const w=writer(f,id),l=f.db.prepare('SELECT * FROM crm_manager_lifecycles_v1 WHERE user_id=?').get(id),read=slot(f,id,'crm-panel-read'),write=slot(f,id,'growth-campaign'),events=[...f.events];
 const cases=[
  ['crm_manager_lifecycles_v1','owner','owner-drift@oaristocrata.com',l.owner,'user_id'],
  ['crm_manager_lifecycles_v1','active_generation',l.active_generation+1,l.active_generation,'user_id'],
  ['upstream_credentials','encrypted_key','v1.a.b.c',read.encrypted_key,'crm-panel-read'],
  ['upstream_credentials','key_digest','a'.repeat(64),read.key_digest,'crm-panel-read'],
  ['crm_writer_auth_binding_v1','owner','owner-drift@oaristocrata.com',w.owner,'user_id'],
  ['crm_writer_auth_binding_v1','generation',w.generation+1,w.generation,'user_id'],
  ['crm_writer_auth_binding_v1','credential_mac','a'.repeat(64),w.credential_mac,'user_id'],
  ['upstream_credentials','encrypted_key','v1.a.b.c',write.encrypted_key,'growth-campaign'],
  ['upstream_credentials','key_digest','a'.repeat(64),write.key_digest,'growth-campaign']
 ];
 for(const [table,column,changed,original,key] of cases){const query=`UPDATE ${table} SET ${column}=? WHERE user_id=?`+(table==='upstream_credentials'?' AND slot=?':'');const args=v=>table==='upstream_credentials'?[v,id,key]:[v,id];f.db.prepare(query).run(...args(changed));
  assert.equal(f.auth.managedCrmJournal.renewalReady(id),false,table+'.'+column);assert.equal(row(f,id).crmAccess.canRenew,false);assert.throws(()=>renewRead(f,id));assert.equal(f.auth.managedCrmJournal.credentialReady(id),false);assert.equal(row(f,id).permissions.growth.edit,true);assert.deepEqual(f.events,events);assert.equal(f.auth.managedCrmJournal.pendingOperations(8).length,0);assert.equal(f.auth.managedCampaignWriterJournal.pending().length,0);f.db.prepare(query).run(...args(original));
 }
 assert.equal(f.auth.managedCrmJournal.renewalReady(id),true);assert.equal(row(f,id).crmAccess.canRenew,true);assert.equal(row(f,id).crmAccess.ready,false);assert.equal(row(f,id).crmWriter.ready,false);
});

test('READ expiry during renewed WRITER FULL compensates exact lifecycle once and keeps editing closed',async t=>{
 const f=await fixture(t),id=await f.manager();await f.issue(id);f.advance(TTL-1);await admin(f);renew(f,id);const op=f.operation(id),q=f.auth.managedCampaignWriterJournal.request(op),read=slot(f,id,'crm-panel-read');f.duringAttest=()=>f.advance(2);
 assert.deepEqual(await f.coordinator.run(op),{state:'revoked'});assert.equal(row(f,id).permissions.growth.edit,false);assert.equal(f.auth.managedCrmJournal.credentialReady(id),false);assert.equal(writer(f,id),undefined);assert.deepEqual(slot(f,id,'crm-panel-read'),read);
 const rev=JSON.parse(f.db.prepare("SELECT request_json FROM crm_writer_bridge_op_v1 WHERE kind='revoke'").get().request_json);for(const field of ['namespaceId','issuerId','userId','lifecycleId','owner'])assert.equal(rev[field],q[field]);assert.equal(f.events.filter(e=>e==='revoke_writer').length,1);const events=[...f.events];assert.deepEqual(await f.coordinator.run(op),{state:'revoked'});assert.deepEqual(f.events,events);
});

test('admin UI presents corporate expired recovery and WRITER renewal using only the closed server capabilities',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),source=fs.readFileSync(path.resolve(__dirname,'../services/dashboard-operational/public/entry.js'),'utf8');
 const node=()=>({children:[],textContent:'',append(...a){this.children.push(...a);},setAttribute(){},addEventListener(){}}),text=n=>[n.textContent,...n.children.map(text)].join(' | '),context={document:{createElement:node},AREAS:{growth:{label:'CRM'}},saveAccessRequest(){},revoke(){}};
 const start=source.indexOf(' function crmAccessLabel('),end=source.indexOf(' async function saveAccessRequest(');require('node:vm').runInNewContext(source.slice(start,end)+'\nglobalThis.row=userRow;',context);
 const u={id:'synthetic-id',email:'manager@oaristocrata.com',role:'manager',status:'active',areas:['growth'],permissions:{growth:{read:true,edit:true}},requestedAccess:'edit',crmAccess:{state:'ready',ready:false,canRenew:true,expired:true,renewalPhase:null,writerRevocationPending:false},crmWriter:{state:'blocked',canApprove:false,canRenew:false}};
 assert.match(text(context.row(u)),/Renovar acesso CRM/);assert.doesNotMatch(text(context.row(u)),/Aprovar edição|Renovar edição/);
 const expiredWriter={...u,crmAccess:{...u.crmAccess,expired:false},crmWriter:{...u.crmWriter,canRenew:true}};assert.match(text(context.row(expiredWriter)),/Renovar edição de campanhas/);
 for(const v of [{...u,crmAccess:{...u.crmAccess,canRenew:false},crmWriter:{state:'renewing',canRenew:false}},{...u,crmAccess:{...u.crmAccess,canRenew:false,writerRevocationPending:true},crmWriter:{state:'revoking',canRenew:false}}])assert.doesNotMatch(text(context.row(v)),/Renovar acesso|Renovar edição/);
});

test('WRITER renewal UI sends one closed request and reports pending validation rather than success/readiness',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),source=fs.readFileSync(path.resolve(__dirname,'../services/dashboard-operational/public/entry.js'),'utf8');const start=source.indexOf(' async function renewCampaignWriter('),end=source.indexOf(' async function renewCrm(',start);assert.ok(start>=0&&end>start);
 for(const result of [{response:{ok:true,status:202},data:{ok:true,state:'renewing'}},{response:{ok:false,status:409},data:{error:'CRM_WRITER_RENEWAL_PENDING'}},{response:{ok:false,status:409},data:{error:'CAMPAIGN_RECONCILIATION_REQUIRED',private:'private-canary'}}]){
  let calls=0;const c={busy:false,session:{user:{role:'superadmin'}},requested:'todos',adminMessage:{textContent:''},loadUsers:async()=>{},post:async(url,q)=>{calls++;assert.equal(url,'/auth/users');assert.equal(JSON.stringify(q),JSON.stringify({action:'crm_writer_renew',userId:'synthetic-id'}));return result;}};vm.runInNewContext(source.slice(start,end)+'\nglobalThis.renew=renewCampaignWriter;',c);const button={disabled:false};await c.renew({id:'synthetic-id',crmWriter:{canRenew:true}},button);assert.equal(calls,1);assert.equal(button.disabled,false);assert.doesNotMatch(c.adminMessage.textContent,/private-canary|CRM pronto|renovado|concluíd/i);assert.match(c.adminMessage.textContent,result.response.ok||result.data.error==='CRM_WRITER_RENEWAL_PENDING'?/edição aguarda nova validação/:/Não foi possível renovar/);
 }
});
