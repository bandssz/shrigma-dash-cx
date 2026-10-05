'use strict';
// Configuration and disposable identity only; no real environment or origin.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createAuth}=require('../services/dashboard-operational/auth.cjs');
const {settingsFromEnv,authOptionsFor,managedRuntimeFor,createServer}=require('../services/dashboard-operational/server.cjs');
const {FIXED_DESTINATIONS}=require('../services/dashboard-operational/proxy.cjs');
const issuerId='11111111-1111-4111-8111-111111111111',namespaceId='22222222-2222-4222-8222-222222222222';
const base=()=>({DASHBOARD_MODE:'operational',DASHBOARD_MANAGER_HOST:'manager.settings.synthetic.invalid',DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.settings.synthetic.invalid',organico:'organico.settings.synthetic.invalid',influs:'influs.settings.synthetic.invalid'}),DASHBOARD_EMAIL_DOMAINS:'["example.test"]',DASHBOARD_UPSTREAMS:JSON.stringify({'crm-read':FIXED_DESTINATIONS['crm-read']}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify([new URL(FIXED_DESTINATIONS['crm-read']).hostname]),DASHBOARD_DB_PATH:':memory:',DASHBOARD_ADMIN_EMAIL:'admin@example.test',DASHBOARD_ENCRYPTION_KEY:crypto.randomBytes(32),DASHBOARD_BOOTSTRAP_SHA256:crypto.randomBytes(32).toString('hex')});
const enabled=()=>({...base(),DASHBOARD_CRM_MANAGED_READ:'enabled',DASHBOARD_CRM_MANAGER_ISSUER_ID:issuerId,DASHBOARD_CRM_MANAGER_NAMESPACE_ID:namespaceId,DASHBOARD_CRM_MANAGER_PROVISIONER_TOKEN:'S'.repeat(43)});

test('default and explicit disabled profile create no journal or runtime, even with unused private fields',()=>{
 for(const flag of [undefined,'disabled']){
  const env={...enabled(),DASHBOARD_CRM_MANAGED_READ:flag},s=settingsFromEnv(env);
  assert.equal(Object.hasOwn(s,'crmManagedRead'),false);assert.equal(Object.hasOwn(authOptionsFor(s),'crmManagedRead'),false);
  assert.equal(managedRuntimeFor(s,new Proxy({}, {get(){throw Error('disabled runtime inspected auth');}})),undefined);
  const auth=createAuth(authOptionsFor(s));try{assert.equal(Object.hasOwn(auth,'managedCrmJournal'),false);}finally{auth.close();}
 }
});
test('enabled profile binds only issuer and namespace into identity and constructs dormant private runtime',async()=>{
 const s=settingsFromEnv(enabled()),options=authOptionsFor(s);
 assert.deepEqual(options.crmManagedRead,{issuerId,namespaceId});assert.equal(Object.hasOwn(options.crmManagedRead,'provisionerToken'),false);
 const auth=createAuth(options);try{
  const runtime=managedRuntimeFor(s,auth);assert.deepEqual(Object.keys(runtime).sort(),['close','kick']);
  await runtime.close();assert.deepEqual(await runtime.kick(),[{status:'fulfilled',value:{ready:0,pending:0,expired:0,revoked:0}}]);
 }finally{auth.close();}
});
test('unknown flag, missing/malformed private binding and write/mixed profiles fail before identity creation',()=>{
 for(const flag of ['',null,'true',true,'ENABLED'])assert.throws(()=>settingsFromEnv({...enabled(),DASHBOARD_CRM_MANAGED_READ:flag}),/DASHBOARD_CRM_MANAGED_READ invalid/);
 for(const key of ['DASHBOARD_CRM_MANAGER_ISSUER_ID','DASHBOARD_CRM_MANAGER_NAMESPACE_ID','DASHBOARD_CRM_MANAGER_PROVISIONER_TOKEN']){
  for(const value of [undefined,'SYNTHETIC-INVALID-PRIVATE-VALUE'])assert.throws(()=>settingsFromEnv({...enabled(),[key]:value}),e=>e.message==='Managed CRM configuration invalid');
 }
 for(const override of [{DASHBOARD_CRM_DRAFT_WRITE:'enabled'},{DASHBOARD_CRM_AUDIENCE_DRAFT:'enabled'},{DASHBOARD_UPSTREAMS:JSON.stringify({'crm-read':FIXED_DESTINATIONS['crm-read'],cx:FIXED_DESTINATIONS.cx}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify([new URL(FIXED_DESTINATIONS['crm-read']).hostname,new URL(FIXED_DESTINATIONS.cx).hostname])},{DASHBOARD_MODE:'synthetic',DASHBOARD_UPSTREAMS:'{}',DASHBOARD_UPSTREAM_HOSTS:'[]'}])assert.throws(()=>settingsFromEnv({...enabled(),...override}),/Managed CRM profile invalid/);
});
test('server refuses a managed runtime without its explicit profile and refuses enabled profile without runtime',()=>{
 const off=settingsFromEnv(base()),auth=createAuth(authOptionsFor(off));try{
  assert.throws(()=>createServer(off,{auth,managedCrmRuntime:{kick(){},close(){}}}),/Managed CRM runtime invalid/);
  assert.throws(()=>createServer(settingsFromEnv(enabled()),{auth}),/Managed CRM runtime invalid/);
 }finally{auth.close();}
});
