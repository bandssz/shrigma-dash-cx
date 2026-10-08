'use strict';
// Isolated SQLite source-contract checks; no production identity or service.
const test=require('node:test'),a=require('node:assert/strict'),crypto=require('node:crypto');
const runtime=process.env.SOURCE_SYNC_TEST_RUNTIME||require('node:path').resolve(__dirname,'../../services/dashboard-operational');
const {DatabaseSync}=require('node:sqlite');
const {createDelegationStore}=require(runtime+'/crm-native-delegation.cjs');
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY);');db.prepare('INSERT INTO users VALUES(?)').run('isolated-master');db.prepare('INSERT INTO users VALUES(?)').run('isolated-other');
 let at=1800000000000,revision='a'.repeat(64),edit=true,active=true;const key=crypto.randomBytes(32);
 const mac=v=>crypto.createHmac('sha256',key).update(v).digest('hex');
 const identity=id=>({role:'superadmin',active,canEditGrowth:edit,revision});
 const consent=c=>{if(c?.nativeBearer||c?.csrf!=='isolated-csrf')throw Object.assign(Error('ORIGINAL_BROWSER_REQUIRED'),{code:'ORIGINAL_BROWSER_REQUIRED'});return {userId:c.owner||'isolated-master',sessionHash:'b'.repeat(64)};};
 const store=createDelegationStore({db,managerHost:'isolated.invalid',consent,identity,mac,now:()=>at});
 const context={csrf:'isolated-csrf'},issue=overrides=>store.issue({context,brands:['fish'],scopes:['crm.read'],...overrides});
 return {db,store,context,issue,set edit(v){edit=v;},set active(v){active=v;},set revision(v){revision=v;},set time(v){at=v;}};
}
const denies=(fn,code)=>a.throws(fn,e=>e.code===code);
test('source consent upgrades only the selected real-owner connection, keeps token and brands, and persists one audited transition',t=>{
 const f=fixture(t),one=f.issue({scopes:['crm.read','crm.draft']}),other=f.issue();
 denies(()=>f.store.authenticate(one.token,{scope:'crm.source-sync',brand:'fish'}),'NATIVE_SCOPE_DENIED');
 const before=f.db.prepare('SELECT * FROM crm_native_connections_v1 WHERE id=?').get(one.connection.id);
 const granted=f.store.permitSourceSync({context:f.context,connectionId:one.connection.id});a.equal(granted.sourceSyncAuthorized,true);
 a.deepEqual(granted.connection.brands,['fish']);a.deepEqual(granted.connection.scopes,['crm.draft','crm.read','crm.source-sync']);
 const after=f.db.prepare('SELECT * FROM crm_native_connections_v1 WHERE id=?').get(one.connection.id);
 for(const k of ['id','token_hash','user_id','host','brands_json','auth_revision','source_session_hash','created_at','expires_at','revoked_at'])a.equal(after[k],before[k]);
 a.equal(f.store.authenticate(one.token,{scope:'crm.source-sync',brand:'fish'}).id,one.connection.id);
 denies(()=>f.store.authenticate(one.token,{scope:'crm.source-sync',brand:'aristo'}),'BRAND_DENIED');
 denies(()=>f.store.authenticate(other.token,{scope:'crm.source-sync'}),'NATIVE_SCOPE_DENIED');
 f.store.permitSourceSync({context:f.context,connectionId:one.connection.id});a.equal(f.db.prepare('SELECT COUNT(*) AS n FROM crm_native_source_sync_consent_v1').get().n,1);
 a.equal(JSON.stringify(f.store.list(f.context)).includes(one.token),false);
});
test('delegated self-consent and a browser lacking CRM edit cannot grant the source operation',t=>{
 const f=fixture(t),c=f.issue();
 denies(()=>f.store.permitSourceSync({context:{...f.context,nativeBearer:c.token},connectionId:c.connection.id}),'ORIGINAL_BROWSER_REQUIRED');
 denies(()=>f.store.permitSourceSync({context:{csrf:'wrong'},connectionId:c.connection.id}),'ORIGINAL_BROWSER_REQUIRED');
 f.edit=false;denies(()=>f.store.permitSourceSync({context:f.context,connectionId:c.connection.id}),'NATIVE_OWNER_REQUIRED');
 denies(()=>f.issue({scopes:['crm.source-sync']}),'GRANT_DENIED');
 a.equal(f.db.prepare('SELECT COUNT(*) AS n FROM crm_native_source_sync_consent_v1').get().n,0);
});
test('another owner, revoked or expired connection, and changed original identity refuse new source consent without an audit transition',t=>{
 const f=fixture(t),c=f.issue();
 denies(()=>f.store.permitSourceSync({context:{...f.context,owner:'isolated-other'},connectionId:c.connection.id}),'NATIVE_CONNECTION_NOT_FOUND');
 f.revision='c'.repeat(64);denies(()=>f.store.permitSourceSync({context:f.context,connectionId:c.connection.id}),'NATIVE_CONNECTION_NOT_FOUND');f.revision='a'.repeat(64);
 f.store.revoke({context:f.context,connectionId:c.connection.id});denies(()=>f.store.permitSourceSync({context:f.context,connectionId:c.connection.id}),'NATIVE_CONNECTION_NOT_FOUND');
 const expired=f.issue({expiresDays:1});f.time=1800000000000+86400001;denies(()=>f.store.permitSourceSync({context:f.context,connectionId:expired.connection.id}),'NATIVE_CONNECTION_NOT_FOUND');
 a.equal(f.db.prepare('SELECT COUNT(*) AS n FROM crm_native_source_sync_consent_v1').get().n,0);
});
test('tampered connection scopes cannot become source authority; authentic consent still obeys later revocation',t=>{
 const f=fixture(t),bad=f.issue();f.db.prepare('UPDATE crm_native_connections_v1 SET scopes_json=? WHERE id=?').run('["crm.read","crm.source-sync"]',bad.connection.id);
 denies(()=>f.store.authenticate(bad.token,{scope:'crm.source-sync'}),'NATIVE_AUTH_REQUIRED');
 denies(()=>f.store.permitSourceSync({context:f.context,connectionId:bad.connection.id}),'NATIVE_CONNECTION_NOT_FOUND');
 const valid=f.issue();f.store.permitSourceSync({context:f.context,connectionId:valid.connection.id});f.store.revoke({context:f.context,connectionId:valid.connection.id});
 denies(()=>f.store.authenticate(valid.token,{scope:'crm.source-sync',brand:'fish'}),'NATIVE_AUTH_REQUIRED');
});
