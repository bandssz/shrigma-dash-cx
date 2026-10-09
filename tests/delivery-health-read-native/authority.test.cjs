'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path'),fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');
const {fixture,deferred,canonical,sha,D,inputRoot,baseEvidence,accelerated}=require('./fixture.cjs');
const runtime=process.env.DELIVERY_HEALTH_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational');
const {createDelegationStore,SCOPES}=require(path.join(runtime,'crm-native-delegation.cjs'));
const {createDeliveryHealthController}=require(path.join(runtime,'native-delivery-health-controller.cjs'));
const context={method:'POST',host:'manager.original.invalid',session:'fixture-session',csrf:'fixture-csrf'},ownerId='original-master';
function harness(options={}){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY)');db.prepare('INSERT INTO users VALUES(?)').run(ownerId);
 let owner={role:'superadmin',active:true,revision:'1'.repeat(64),canEditGrowth:false},time=Date.now(),crm={fish:'2'.repeat(64),aristo:'3'.repeat(64)},profileRevision=1;
 const mac=x=>crypto.createHmac('sha256','synthetic-only-secret').update(x).digest('hex');
 const consent=ctx=>{if(ctx?.nativeBearer!==undefined||ctx?.method!=='POST'||ctx?.session!==context.session||ctx?.csrf!==context.csrf)throw Error('ORIGINAL_BROWSER_CSRF_REQUIRED');return {userId:ownerId,sessionHash:sha(ctx.session)};};
 const store=createDelegationStore({db,managerHost:context.host,consent,identity:id=>id===ownerId?owner:null,mac,now:()=>time});
 const issued=store.issue({context,brands:options.brands||['fish','aristo'],scopes:options.scopes||['crm.read']});
 const f=fixture(options.protocol||{});const profile=()=>({schema:'shrigma-private-database-credential-v1',revision:profileRevision,ownerId,username:'fixture_reader',password:'SYNTHETIC_DB_SECRET',resource:{...D.RESOURCE},transport:{mode:'admitted-private-network'}});
 const calls=[];const auth={nativeConnections:store,nativeDatabaseVault:{getPrivateCredential:({ownerId:id})=>{assert.equal(id,ownerId);return profile();},status:ctx=>{consent(ctx);return {linked:true};}},ownMasterPublishedJourneyReadBinding:(ctx,{brand})=>{calls.push({ctx,brand});assert.equal(ctx.method,'GET');if(!crm[brand])throw Error('CRM_READ_DENIED');return {userId:ownerId,binding:crm[brand],credential:'SYNTHETIC_MASTER_SECRET'};}};
 const controller=createDeliveryHealthController({enabled:true,driver:f.args.driver,auth,...(options.coreFactory?{coreFactory:options.coreFactory}:{})});
 const q={context,connectionId:issued.connection.id,brand:'aristo'};
 return {db,store,issued,f,auth,controller,q,mac,calls,profile,changeOwner:delta=>owner={...owner,...delta},changeProfile:()=>profileRevision++,changeCRM:brand=>crm[brand]='9'.repeat(64),denyCRM:brand=>crm[brand]=null,expire:()=>time+=31*86400000,cleanup:async()=>{await controller.close().catch(()=>{});db.close();}};
}
async function admitted(h){return h.controller.authorize({...h.q,consent:true});}
test('legacy binding function byte identical, source preserved and distinct scope',()=>{const original=fs.readFileSync(path.join(inputRoot,'inputs/services/dashboard-operational/crm-native-delegation.cjs'),'utf8'),updated=fs.readFileSync(path.join(runtime,'crm-native-delegation.cjs'),'utf8');assert.equal(updated.match(/ const bind=r=>[^\n]+/)[0],original.match(/ const bind=r=>[^\n]+/)[0]);assert(SCOPES.includes('crm.delivery-health'));for(const scope of ['crm.read','crm.draft','crm.iam','db.inspect','db.install','crm.source-sync','crm.source-diagnostics'])assert(SCOPES.includes(scope));});
test('same SQLite preserves old token & exact legacy MAC, additive consent only',async()=>{const h=harness();try{const before=h.db.prepare('SELECT * FROM crm_native_connections_v1').get();assert.equal(before.binding_mac,h.mac(JSON.stringify([before.id,before.token_hash,before.user_id,before.host,before.label,before.brands_json,before.scopes_json,before.auth_revision,before.source_session_hash,before.created_at,before.expires_at,before.revoked_at])));assert.throws(()=>h.store.authenticate(h.issued.token,{scope:'crm.delivery-health'}));await admitted(h);const after=h.db.prepare('SELECT * FROM crm_native_connections_v1').get();assert.equal(after.token_hash,before.token_hash);assert.equal(after.source_session_hash,before.source_session_hash);assert.deepEqual(JSON.parse(after.scopes_json),['crm.delivery-health','crm.read']);assert.equal(h.store.authenticate(h.issued.token,{scope:'crm.delivery-health',brand:'aristo'}).userId,ownerId);assert.equal(h.db.prepare('SELECT count(*) n FROM crm_native_delivery_health_consent_v1').get().n,1);const b=h.store.deliveryHealthConsent({...h.q});assert.equal(b.ownerId,ownerId);assert.equal(b.queryHash,D.queryHash);assert(!JSON.stringify(b).includes('SECRET'));assert.deepEqual(h.calls.slice(0,2).map(q=>q.brand),['fish','aristo']);assert.equal((await h.controller.inspect(h.q)).operational,false);}finally{await h.cleanup();}});
test('legacy issue read works; diagnostic and health require own consent; legacy write guards unchanged',async()=>{const h=harness();try{for(const scope of ['crm.delivery-health','crm.source-diagnostics','crm.draft','crm.source-sync'])assert.throws(()=>h.store.issue({context,brands:['fish','aristo'],scopes:[scope]}));h.store.permitInspection({context,connectionId:h.q.connectionId});assert(h.store.authenticate(h.issued.token,{scope:'db.inspect'}));assert.throws(()=>h.store.permitSourceSync({context,connectionId:h.q.connectionId}));assert.throws(()=>h.store.deliveryHealthConsent(h.q));}finally{await h.cleanup();}});
for(const changes of [{brands:['fish']},{scopes:['db.inspect']}])test('shared global counters require crm.read and both brands '+JSON.stringify(changes),async()=>{const h=harness(changes);try{assert.throws(()=>h.controller.authorize({...h.q,consent:true}));assert.equal(h.f.clients.length,0);}finally{await h.cleanup();}});
test('native resolves key and rejects caller connection/owner; cannot consent itself',async()=>{const h=harness();try{await admitted(h);const native=h.store.context(h.issued.token,{scope:'crm.delivery-health',brand:'aristo'});assert.equal((await h.controller.inspect({context:native,brand:'aristo'})).brand,'aristo');await assert.rejects(h.controller.inspect({context:native,brand:'aristo',connectionId:h.q.connectionId}));assert.throws(()=>h.controller.authorize({context:native,connectionId:h.q.connectionId,brand:'aristo',consent:true}));assert.throws(()=>h.store.permitDeliveryHealth({context:native,connectionId:h.q.connectionId,binding:h.store.deliveryHealthConsent(h.q)}));}finally{await h.cleanup();}});
test('consent is per brand; exact browser context/CSRF required',async()=>{const h=harness();try{for(const ctx of [{...context,csrf:'wrong'},{...context,method:'GET'}])assert.throws(()=>h.controller.authorize({...h.q,context:ctx,consent:true}));assert.throws(()=>h.controller.authorize({...h.q,consent:false}));await admitted(h);await assert.rejects(h.controller.inspect({...h.q,brand:'fish'}));h.controller.authorize({...h.q,brand:'fish',consent:true});assert.equal((await h.controller.inspect({...h.q,brand:'fish'})).brand,'fish');}finally{await h.cleanup();}});
const mutations={
 revoke:h=>h.store.revoke({context,connectionId:h.q.connectionId}),
 owner:h=>h.changeOwner({active:false}),revision:h=>h.changeOwner({revision:'7'.repeat(64)}),role:h=>h.changeOwner({role:'analyst'}),expiry:h=>h.expire(),
 crmFish:h=>h.changeCRM('fish'),crmAristo:h=>h.changeCRM('aristo'),crmDenied:h=>h.denyCRM('fish'),vault:h=>h.changeProfile(),
 rowMAC:h=>h.db.prepare("UPDATE crm_native_connections_v1 SET binding_mac=?").run('0'.repeat(64)),
 consentMAC:h=>h.db.prepare("UPDATE crm_native_delivery_health_consent_v1 SET binding_mac=?").run('0'.repeat(64)),
 key:h=>{const r=h.db.prepare('SELECT * FROM crm_native_connections_v1').get();r.token_hash=sha('rotated');const seal=h.mac(JSON.stringify([r.id,r.token_hash,r.user_id,r.host,r.label,r.brands_json,r.scopes_json,r.auth_revision,r.source_session_hash,r.created_at,r.expires_at,r.revoked_at]));h.db.prepare('UPDATE crm_native_connections_v1 SET token_hash=?,binding_mac=?').run(r.token_hash,seal);}
};
for(const [name,mutate] of Object.entries(mutations))test('CURRENT '+name+' prevents read after consent',async()=>{const h=harness();try{await admitted(h);mutate(h);await assert.rejects(h.controller.inspect(h.q));assert.equal(h.f.clients.length,0);}finally{await h.cleanup();}});
for(const point of ['connect','read','rollback','end'])for(const [name,mutate] of Object.entries(mutations).filter(([k])=>['revoke','crmFish','vault','key','revision','consentMAC'].includes(k)))test('suppress stale '+name+' during '+point,async()=>{const hold=deferred(),entered=deferred(),protocol=point==='connect'?{connectWait:hold,connectEntered:entered}:point==='read'?{holdRead:hold,entered}:{},h=harness({protocol});try{await admitted(h);if(point==='rollback')h.f.opts.queryHook=async q=>{if(q===D.ROLLBACK){entered.resolve();await hold.promise;}};if(point==='end')h.f.opts.endHook=async()=>{entered.resolve();await hold.promise;};const pending=h.controller.inspect(h.q),refusal=assert.rejects(pending);await entered.promise;mutate(h);hold.resolve();await refusal;assert.equal(h.f.clients[0].ends,1);}finally{await h.cleanup();}});
test('controller OFF without original CURRENT read dependency; no source-sync needed',async()=>{const h=harness();try{const auth={...h.auth,ownMasterPublishedJourneyReadBinding:undefined};const c=createDeliveryHealthController({enabled:true,driver:h.f.args.driver,auth});assert.equal(c.enabled,false);await assert.rejects(c.inspect(h.q));assert.equal(h.controller.enabled,true);assert.equal(h.auth.nativeSourceSync,undefined);}finally{await h.cleanup();}});
test('controller concurrency and close suppress pending result after drain',async()=>{const holdRead=deferred(),entered=deferred(),h=harness({protocol:{holdRead,entered}});try{await admitted(h);const pending=h.controller.inspect(h.q),refusal=assert.rejects(pending);await entered.promise;await assert.rejects(h.controller.inspect(h.q),{code:'DELIVERY_HEALTH_BUSY'});const closing=h.controller.close();holdRead.resolve();await refusal;await closing;await assert.rejects(h.controller.inspect(h.q));}finally{await h.cleanup();}});

test('historical source purpose methods preserved byte for byte',()=>{const original=fs.readFileSync(path.join(inputRoot,'inputs/services/dashboard-operational/crm-native-delegation.cjs'),'utf8'),updated=fs.readFileSync(path.join(runtime,'crm-native-delegation.cjs'),'utf8');for(const [start,end] of [[' function permitInspection(', ' function permitSourceSync('],[' function permitSourceSync(', ' function diagnosticBinding('],[' function diagnosticBinding(', ' const diagnosticSeal='],[' const diagnosticSeal=', ' function permitSourceDiagnostics('],[' function permitSourceDiagnostics(', ' function sourceDiagnosticsConsent(']])assert.equal(updated.slice(updated.indexOf(start),updated.indexOf(end)),original.slice(original.indexOf(start),original.indexOf(end)));const start=' function sourceDiagnosticsConsent(';assert.equal(updated.slice(updated.indexOf(start),updated.indexOf(' // Own health purpose:')),original.slice(original.indexOf(start),original.indexOf(' return Object.freeze({issue,authenticate,context,list,revoke,')));});
test('consent bound connection/brand/body HMAC cannot be transplanted',async()=>{const h=harness();try{await admitted(h);h.db.prepare("UPDATE crm_native_delivery_health_consent_v1 SET brand='fish'").run();assert.throws(()=>h.store.deliveryHealthConsent({...h.q,brand:'fish'}));await assert.rejects(h.controller.inspect(h.q));}finally{await h.cleanup();}});
test('same token scopes fail shared read even with valid legacy row MAC',async()=>{const h=harness();try{await admitted(h);const r=h.db.prepare('SELECT * FROM crm_native_connections_v1').get();r.scopes_json='["crm.delivery-health"]';const seal=h.mac(JSON.stringify([r.id,r.token_hash,r.user_id,r.host,r.label,r.brands_json,r.scopes_json,r.auth_revision,r.source_session_hash,r.created_at,r.expires_at,r.revoked_at]));h.db.prepare('UPDATE crm_native_connections_v1 SET scopes_json=?,binding_mac=?').run(r.scopes_json,seal);assert.throws(()=>h.store.authenticate(h.issued.token,{scope:'crm.delivery-health',brand:'aristo'}),{code:'NATIVE_HEALTH_SHARED_READ_REQUIRED'});}finally{await h.cleanup();}});


test('availability only recognizes same current purpose and brand; no PG read or new consent',async()=>{const h=harness();try{assert.deepEqual(h.controller.status(context).connections[0].authorizedBrands,[]);assert.equal(h.db.prepare('SELECT count(*) n FROM crm_native_delivery_health_consent_v1').get().n,0);await admitted(h);const before=h.db.prepare('SELECT count(*) n FROM crm_native_delivery_health_consent_v1').get().n;assert.deepEqual(h.controller.status(context).connections[0].authorizedBrands,['aristo']);assert.equal(h.db.prepare('SELECT count(*) n FROM crm_native_delivery_health_consent_v1').get().n,before);assert.equal(h.f.clients.length,0);h.controller.authorize({...h.q,brand:'fish',consent:true});assert.deepEqual(h.controller.status(context).connections[0].authorizedBrands,['fish','aristo']);assert.equal(h.f.clients.length,0);}finally{await h.cleanup();}});
for(const [name,mutate] of Object.entries(mutations))test('availability cannot reuse changed '+name+' consent',async()=>{const h=harness();try{await admitted(h);mutate(h);let result;try{result=h.controller.status(context);}catch{}assert(!result||result.connections.every(c=>c.authorizedBrands.length===0));assert.equal(h.f.clients.length,0);}finally{await h.cleanup();}});
test('legacy db inspection is not health availability consent',async()=>{const h=harness();try{h.store.permitInspection({context,connectionId:h.q.connectionId});assert.deepEqual(h.controller.status(context).connections[0].authorizedBrands,[]);assert.equal(h.f.clients.length,0);}finally{await h.cleanup();}});

// Native status receipts only refresh confirmed success under the same CURRENT binding.
const nativeReceipt=h=>({context:h.store.context(h.issued.token,{scope:'crm.delivery-health',brand:'aristo'}),brand:'aristo'});
test('native receipt does not use browser or legacy db purpose as health permission',async()=>{const h=harness();try{await assert.rejects(h.controller.nativeReadReceipt(h.q));h.store.permitInspection({context,connectionId:h.q.connectionId});const native=h.store.context(h.issued.token);await assert.rejects(h.controller.nativeReadReceipt({context:native,brand:'aristo'}));assert.equal(h.f.clients.length,0);}finally{await h.cleanup();}});
test('native receipt reads once then relays only same CURRENT selected brand',async()=>{const h=harness();try{await admitted(h);const q=nativeReceipt(h),a=await h.controller.nativeReadReceipt(q),b=await h.controller.nativeReadReceipt(q);assert.equal(a.status,200);assert.equal(a.body.brand,'aristo');assert.equal(a.body.brandMetrics.finalizacao_pendente,0);assert.strictEqual(a,b);assert.equal(h.f.calls.filter(x=>x===D.READ_SQL).length,1);assert.equal(h.f.clients[0].ends,1);await assert.rejects(h.controller.nativeReadReceipt({...q,brand:'fish'}));assert.equal(h.f.clients.length,1);}finally{await h.cleanup();}});
test('native receipt expiry renews confirmed200 with fresh data under existing consent',async()=>{await withHealthReceiptClock(async(h,clock)=>{
 const q=nativeReceipt(h),connection=h.db.prepare('SELECT * FROM crm_native_connections_v1').get(),consents=h.db.prepare('SELECT * FROM crm_native_delivery_health_consent_v1').all();
 const first=await h.controller.nativeReadReceipt(q);assert.equal(first.status,200);assert.equal(first.body.brandMetrics.finalizacao_pendente,0);
 clock.advance(healthReceiptTTL-1);assert.strictEqual(await h.controller.nativeReadReceipt(q),first);assert.equal(healthReadCount(h),1);
 clock.advance(2);h.f.opts.evidence=healthMetrics(9);const fresh=await h.controller.nativeReadReceipt(q);assert.equal(fresh.status,200);assert.equal(fresh.body.brandMetrics.finalizacao_pendente,9);assert.notEqual(fresh.body.checkedAt,first.body.checkedAt);assert.notStrictEqual(fresh,first);
 assert.strictEqual(await h.controller.nativeReadReceipt(q),fresh);assert.equal(healthReadCount(h),2);assert(h.f.clients.every(c=>c.ends===1));
 assert.deepEqual(h.db.prepare('SELECT * FROM crm_native_connections_v1').get(),connection);assert.deepEqual(h.db.prepare('SELECT * FROM crm_native_delivery_health_consent_v1').all(),consents);
});});
for(const [name,mutate] of Object.entries(mutations))test('cached native receipt is suppressed after CURRENT '+name,async()=>{const h=harness();try{await admitted(h);const q=nativeReceipt(h);await h.controller.nativeReadReceipt(q);mutate(h);await assert.rejects(h.controller.nativeReadReceipt(q));assert.equal(h.f.clients.length,1);}finally{await h.cleanup();}});
test('reconsent after private binding change does not replay a consumed native receipt',async()=>{const h=harness();try{await admitted(h);const q=nativeReceipt(h);await h.controller.nativeReadReceipt(q);h.changeProfile();await admitted(h);await assert.rejects(h.controller.nativeReadReceipt(q),{code:'DELIVERY_HEALTH_BINDING_CHANGED'});assert.equal(h.f.clients.length,1);}finally{await h.cleanup();}});
test('native receipt retains typed refusal and does not retry invalid payload',async()=>{const h=harness({protocol:{evidence:{checked_at:'INVALID_PRIVATE_CONTENT'}}});try{await admitted(h);const q=nativeReceipt(h),a=await h.controller.nativeReadReceipt(q),b=await h.controller.nativeReadReceipt(q);assert.equal(a.status,503);assert.equal(a.body.error,'HEALTH_PROTOCOL_REFUSED');assert.deepEqual(a.body.diagnostic,{schema:'shrigma-email-health-protocol-refusal-v1',field:'checked_at',reason:'timestamp',actualType:'string'});assert.strictEqual(a,b);assert(!JSON.stringify(a).includes('INVALID_PRIVATE_CONTENT'));assert.equal(h.f.clients.length,1);}finally{await h.cleanup();}});
test('native concurrent status calls share pending receipt and never double SQL',async()=>{const holdRead=deferred(),entered=deferred(),h=harness({protocol:{holdRead,entered}});try{await admitted(h);const q=nativeReceipt(h),p=h.controller.nativeReadReceipt(q);await entered.promise;const r=await h.controller.nativeReadReceipt(q);assert.equal(r.status,409);assert.equal(r.body.error,'DELIVERY_HEALTH_BUSY');holdRead.resolve();assert.equal((await p).status,200);assert.equal(h.f.clients.length,1);}finally{holdRead.resolve();await h.cleanup();}});
test('native receipt never discloses protocol fault when end is unconfirmed',async()=>{const h=harness({protocol:{evidence:{checked_at:'INVALID_PRIVATE_CONTENT'},noEndEvent:true}});try{await admitted(h);const r=await h.controller.nativeReadReceipt(nativeReceipt(h));assert.equal(r.body.error,'HEALTH_CLOSE_UNCONFIRMED');assert(!r.body.diagnostic);assert(!JSON.stringify(r).includes('INVALID_PRIVATE_CONTENT'));}finally{await h.cleanup();}});

test('native batch reuses both authorized brand receipts with no second SQL',async()=>{const h=harness();try{await admitted(h);h.controller.authorize({...h.q,brand:'fish',consent:true});const context=h.store.context(h.issued.token);const first=await h.controller.nativeStatusReceipts({context}),second=await h.controller.nativeStatusReceipts({context});assert.deepEqual(first,second);assert.deepEqual(first.sources.map(x=>x.brand),['fish','aristo']);assert(first.sources.every(x=>x.status===200&&x.body.operational===false));assert.equal(h.f.calls.filter(x=>x===D.READ_SQL).length,2);}finally{await h.cleanup();}});
test('private epoch changed during second brand suppresses entire native batch',async()=>{const h=harness();try{await admitted(h);h.controller.authorize({...h.q,brand:'fish',consent:true});let reads=0;h.f.opts.queryHook=q=>{if(q===D.READ_SQL&&++reads===2)h.changeProfile();};await assert.rejects(h.controller.nativeStatusReceipts({context:h.store.context(h.issued.token)}));assert.equal(h.f.calls.filter(x=>x===D.READ_SQL).length,2);}finally{await h.cleanup();}});
test('batch can return absence of second brand consent without querying it',async()=>{const h=harness();try{await admitted(h);const r=await h.controller.nativeStatusReceipts({context:h.store.context(h.issued.token)});assert.equal(r.sources.find(x=>x.brand==='fish').body.error,'DELIVERY_HEALTH_NOT_ADMITTED');assert.equal(r.sources.find(x=>x.brand==='aristo').status,200);assert.equal(h.f.calls.filter(x=>x===D.READ_SQL).length,1);}finally{await h.cleanup();}});

// Focal expiry refresh regression: all data/credentials/SQL clients are synthetic.
const healthReceiptTTL=10*60*1000;
const healthReadCount=h=>h.f.calls.filter(q=>q===D.READ_SQL).length;
const healthMetrics=n=>({brands:baseEvidence().brands.map(row=>({...row,finalizacao_pendente:n}))});
async function withHealthReceiptClock(run,options={}){
 const original=Date.now;let time=Date.parse('2026-10-09T12:23:00Z'),h;Date.now=()=>time;
 try{h=harness(options);await admitted(h);return await run(h,{advance:delta=>time+=delta,now:()=>time});}
 finally{Date.now=original;if(h)await h.cleanup();}
}
const bothHealthBrands=h=>h.controller.authorize({...h.q,brand:'fish',consent:true});
const nativeHealthBatch=h=>({context:h.store.context(h.issued.token)});

test('health receipt refresh TTL begins after confirmed close',async()=>{await withHealthReceiptClock(async(h,clock)=>{
 h.f.opts.endHook=async()=>clock.advance(11*60*1000);const q=nativeReceipt(h),first=await h.controller.nativeReadReceipt(q);assert.equal(first.status,200);assert.equal(h.f.clients[0].ends,1);h.f.opts.endHook=null;
 clock.advance(healthReceiptTTL-1);assert.strictEqual(await h.controller.nativeReadReceipt(q),first);assert.equal(healthReadCount(h),1);
 clock.advance(2);assert.equal((await h.controller.nativeReadReceipt(q)).status,200);assert.equal(healthReadCount(h),2);
});});

test('health receipt refresh pending single flight survives TTL and returns no cached stale data',async()=>{const hold=deferred(),entered=deferred();await withHealthReceiptClock(async(h,clock)=>{
 const q=nativeReceipt(h);await h.controller.nativeReadReceipt(q);clock.advance(healthReceiptTTL+1);h.f.opts.holdRead=hold;h.f.opts.entered=entered;
 const fresh=h.controller.nativeReadReceipt(q);fresh.catch(()=>{});await entered.promise;clock.advance(healthReceiptTTL+1);
 try{const peers=await Promise.all([h.controller.nativeReadReceipt(q),h.controller.nativeReadReceipt(q)]);assert(peers.every(r=>r.status===409&&r.body.error==='DELIVERY_HEALTH_BUSY'));assert.equal(healthReadCount(h),2);assert.equal(h.f.clients.length,2);}
 finally{hold.resolve();}
 const result=await fresh;assert.equal(result.status,200);assert.strictEqual(await h.controller.nativeReadReceipt(q),result);assert.equal(healthReadCount(h),2);assert(h.f.clients.every(c=>c.ends===1));
});});

for(const [name,options,code] of [
 ['protocol',{evidence:{checked_at:'PRIVATE_SYNTHETIC_INVALID'}},'HEALTH_PROTOCOL_REFUSED'],
 ['query',{queryThrow:D.READ_SQL},'HEALTH_QUERY_FAILED'],
 ['ACK',{result:(sql,r)=>sql===D.READ_SQL?{...r,command:'UPDATE'}:r},'HEALTH_ACK_UNKNOWN'],
 ['ACK timeout',{missingAck:D.READ_SQL},'HEALTH_TIMEOUT'],
 ['close unconfirmed',{noEndEvent:true},'HEALTH_CLOSE_UNCONFIRMED'],
 ['close failed',{endThrow:true},'HEALTH_CLOSE_FAILED'],
 ['close timeout',{endHang:true},'HEALTH_TIMEOUT']
])test('health receipt refresh never retries consumed '+name+' after TTL',async()=>{
 const fast=accelerated();await withHealthReceiptClock(async(h,clock)=>{
  const q=nativeReceipt(h),failed=await h.controller.nativeReadReceipt(q);assert.equal(failed.status,503);assert.equal(failed.body.error,code);assert(!JSON.stringify(failed).includes('PRIVATE_SYNTHETIC_INVALID'));assert.strictEqual(await h.controller.nativeReadReceipt(q),failed);
  const count=healthReadCount(h),clients=h.f.clients.length;clock.advance(healthReceiptTTL+1);const expired=await h.controller.nativeReadReceipt(q);assert.equal(expired.status,503);assert.equal(expired.body.error,'HEALTH_READ_RECEIPT_EXPIRED');assert.equal(healthReadCount(h),count);assert.equal(h.f.clients.length,clients);assert(h.f.clients.every(c=>c.ends===1));
 },{protocol:{...options,D:fast.D},coreFactory:fast.D.createDeliveryHealthRead});
});

test('health receipt refresh failed renewal stays consumed across another TTL',async()=>{await withHealthReceiptClock(async(h,clock)=>{
 const q=nativeReceipt(h);assert.equal((await h.controller.nativeReadReceipt(q)).status,200);clock.advance(healthReceiptTTL+1);h.f.opts.queryThrow=D.READ_SQL;
 const refused=await h.controller.nativeReadReceipt(q);assert.equal(refused.status,503);assert.equal(refused.body.error,'HEALTH_QUERY_FAILED');assert.equal(healthReadCount(h),2);h.f.opts.queryThrow=null;
 assert.strictEqual(await h.controller.nativeReadReceipt(q),refused);clock.advance(healthReceiptTTL+1);assert.equal((await h.controller.nativeReadReceipt(q)).body.error,'HEALTH_READ_RECEIPT_EXPIRED');assert.equal(healthReadCount(h),2);assert.equal(h.f.clients.length,2);
});});

for(const name of ['vault','key','owner','revoke'])test('health receipt refresh expired success cannot bypass CURRENT '+name,async()=>{await withHealthReceiptClock(async(h,clock)=>{
 const q=nativeReceipt(h);await h.controller.nativeReadReceipt(q);clock.advance(healthReceiptTTL+1);mutations[name](h);await assert.rejects(h.controller.nativeReadReceipt(q));assert.equal(healthReadCount(h),1);assert.equal(h.f.clients.length,1);
});});

test('health receipt refresh reconsent cannot reconstruct a consumed changed binding',async()=>{await withHealthReceiptClock(async(h,clock)=>{
 const q=nativeReceipt(h);await h.controller.nativeReadReceipt(q);clock.advance(healthReceiptTTL+1);h.changeProfile();await admitted(h);
 await assert.rejects(h.controller.nativeReadReceipt(q),{code:'DELIVERY_HEALTH_BINDING_CHANGED'});assert.equal(healthReadCount(h),1);assert.equal(h.f.clients.length,1);
});});

test('health receipt refresh revocation during end suppresses fresh payload',async()=>{await withHealthReceiptClock(async(h,clock)=>{
 const q=nativeReceipt(h);await h.controller.nativeReadReceipt(q);clock.advance(healthReceiptTTL+1);h.f.opts.endHook=async()=>mutations.revoke(h);
 await assert.rejects(h.controller.nativeReadReceipt(q));assert.equal(healthReadCount(h),2);assert(h.f.clients.every(c=>c.ends===1));clock.advance(healthReceiptTTL+1);await assert.rejects(h.controller.nativeReadReceipt(q));assert.equal(healthReadCount(h),2);
});});

test('health receipt refresh batch renews each brand once and caches fresh projection',async()=>{await withHealthReceiptClock(async(h,clock)=>{
 bothHealthBrands(h);const q=nativeHealthBatch(h),first=await h.controller.nativeStatusReceipts(q),consents=h.db.prepare('SELECT * FROM crm_native_delivery_health_consent_v1').all();assert(first.sources.every(r=>r.status===200));assert.equal(healthReadCount(h),2);
 clock.advance(healthReceiptTTL+1);h.f.opts.evidence=healthMetrics(17);const fresh=await h.controller.nativeStatusReceipts(q);assert.deepEqual(fresh.sources.map(r=>r.brand),['fish','aristo']);assert(fresh.sources.every(r=>r.status===200&&r.body.brandMetrics.finalizacao_pendente===17));assert.equal(fresh.automaticRetry,false);assert.equal(healthReadCount(h),4);assert.deepEqual(await h.controller.nativeStatusReceipts(q),fresh);assert.equal(healthReadCount(h),4);assert(h.f.clients.every(c=>c.ends===1));assert.deepEqual(h.db.prepare('SELECT * FROM crm_native_delivery_health_consent_v1').all(),consents);
});});

test('health receipt refresh batch single flight rejects concurrent batch without extra reads',async()=>{const hold=deferred(),entered=deferred();await withHealthReceiptClock(async(h,clock)=>{
 bothHealthBrands(h);const q=nativeHealthBatch(h);await h.controller.nativeStatusReceipts(q);clock.advance(healthReceiptTTL+1);h.f.opts.holdRead=hold;h.f.opts.entered=entered;
 const refresh=h.controller.nativeStatusReceipts(q);refresh.catch(()=>{});await entered.promise;try{await assert.rejects(h.controller.nativeStatusReceipts(q),{code:'DELIVERY_HEALTH_BUSY'});assert.equal(healthReadCount(h),3);}finally{hold.resolve();}
 const result=await refresh;assert(result.sources.every(r=>r.status===200));assert.equal(healthReadCount(h),4);
});});

test('health receipt refresh epoch change during second brand suppresses entire renewed batch',async()=>{await withHealthReceiptClock(async(h,clock)=>{
 bothHealthBrands(h);const q=nativeHealthBatch(h);await h.controller.nativeStatusReceipts(q);clock.advance(healthReceiptTTL+1);let reads=2;h.f.opts.queryHook=sql=>{if(sql===D.READ_SQL&&++reads===4)h.changeProfile();};
 await assert.rejects(h.controller.nativeStatusReceipts(q));assert.equal(healthReadCount(h),4);assert(h.f.clients.every(c=>c.ends===1));clock.advance(healthReceiptTTL+1);await assert.rejects(h.controller.nativeStatusReceipts(q));assert.equal(healthReadCount(h),4);
});});

test('health receipt refresh batch never retries refused brand while renewing confirmed brand',async()=>{await withHealthReceiptClock(async(h,clock)=>{
 bothHealthBrands(h);const q=nativeHealthBatch(h);let reads=0;h.f.opts.queryHook=sql=>{if(sql===D.READ_SQL)h.f.opts.evidence=++reads===1?{checked_at:'PRIVATE_SYNTHETIC_INVALID'}:healthMetrics(1);};
 const first=await h.controller.nativeStatusReceipts(q);assert.equal(first.sources[0].body.error,'HEALTH_PROTOCOL_REFUSED');assert.equal(first.sources[1].status,200);assert.equal(healthReadCount(h),2);
 clock.advance(healthReceiptTTL+1);h.f.opts.queryHook=null;h.f.opts.evidence=healthMetrics(23);const fresh=await h.controller.nativeStatusReceipts(q);assert.equal(fresh.sources[0].body.error,'HEALTH_READ_RECEIPT_EXPIRED');assert.equal(fresh.sources[1].status,200);assert.equal(fresh.sources[1].body.brandMetrics.finalizacao_pendente,23);assert.equal(healthReadCount(h),3);assert.equal(h.f.clients.length,3);assert(!JSON.stringify(fresh).includes('PRIVATE_SYNTHETIC_INVALID'));
});});
