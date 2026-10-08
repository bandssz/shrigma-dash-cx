'use strict';
// Disposable dispatcher/configuration fixtures; never production identities, grants or network.
const test=require('node:test'),a=require('node:assert/strict'),path=require('node:path');
const runtime=process.env.DELIVERY_HEALTH_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational');
const {createNativeMcp}=require(runtime+'/crm-native-mcp.cjs');
const {settingsFromEnv}=require(runtime+'/server.cjs'),P=require(runtime+'/proxy.cjs');
const host='gerencial.shrigma.com.br';
function fixture({enabled=true,scopes=['crm.delivery-health','crm.read'],invoke=async()=>({status:200,body:{schema:'shrigma-original-email-health-read-v1',brand:'fish',operational:false,authorizesSend:false,authorizesRecovery:false}})}={}){
 let live=true;const calls=[];
 const authenticate=(_token,{scope,brand}={})=>{
  if(!live)throw Object.assign(Error('NATIVE_AUTH_REQUIRED'),{code:'NATIVE_AUTH_REQUIRED',status:401});
  if(scope&&!scopes.includes(scope))throw Object.assign(Error('NATIVE_SCOPE_DENIED'),{code:'NATIVE_SCOPE_DENIED',status:403});
  if(brand&&!['fish','aristo'].includes(brand))throw Error('unexpected fixture brand');
  return {id:'isolated-current-connection',userId:'isolated-owner',brands:['fish','aristo'],scopes,host};
 };
 const auth={nativeConnections:{authenticate,context:token=>({nativeBearer:token,host,origin:'https://'+host,csrf:'isolated-fixture-csrf'})}};
 const mcp=createNativeMcp({auth,managerHost:host,deliveryHealthEnabled:enabled,invoke:async input=>{calls.push(input);return invoke(input,()=>{live=false;});}});
 return {mcp,calls};
}
test('health tool absent by default and legacy purposes do not dispatch new READ',async()=>{
 const off=fixture({enabled:false});await a.rejects(off.mcp.call('crm_email_health',{brand:'fish'},'isolated-token'),e=>e.code==='NATIVE_TOOL_NOT_FOUND');a.equal(off.calls.length,0);
 const old=fixture({scopes:['crm.read','crm.draft','crm.source-sync','crm.source-diagnostics','db.inspect','db.install']});
 await a.rejects(old.mcp.call('crm_email_health',{brand:'fish'},'isolated-token'),e=>e.code==='NATIVE_SCOPE_DENIED');a.equal(old.calls.length,0);
});
test('explicit health READ stays on same gateway GET for exactly the selected brand',async()=>{
 const f=fixture();const r=await f.mcp.call('crm_email_health',{brand:'fish'},'isolated-token');
 a.equal(r.body.operational,false);a.equal(r.body.authorizesSend,false);a.equal(r.body.authorizesRecovery,false);
 a.equal(f.calls.length,1);a.equal(f.calls[0].method,'GET');a.equal(f.calls[0].path,'/api/delivery-health?brand=fish');a.equal(f.calls[0].body,undefined);
 await f.mcp.call('crm_email_health',{brand:'aristo'},'isolated-token');a.equal(f.calls[1].path,'/api/delivery-health?brand=aristo');
});
test('health caller cannot inject SQL, owner, destination, connection or extra fields',async()=>{
 const f=fixture();
 for(const extra of ['sql','ownerId','actor','issuer','url','connectionId','requestId','credential'])await a.rejects(f.mcp.call('crm_email_health',{brand:'fish',[extra]:'injected'},'isolated-token'),e=>e.code==='NATIVE_ARGUMENTS_INVALID');
 for(const args of [{},{brand:'todas'},{brand:'fish',recover:true}])await a.rejects(f.mcp.call('crm_email_health',args,'isolated-token'),e=>e.code==='NATIVE_ARGUMENTS_INVALID');
 a.equal(f.calls.length,0);
});
test('CURRENT native revocation while reading suppresses response and does not retry',async()=>{
 const f=fixture({invoke:async(_input,revoke)=>{revoke();return {status:200,body:{pending:0}};}});
 await a.rejects(f.mcp.call('crm_email_health',{brand:'fish'},'isolated-token'),e=>e.code==='NATIVE_AUTH_REQUIRED');a.equal(f.calls.length,1);
});
test('uncertain health READ response never starts a second dispatcher attempt',async()=>{
 const f=fixture({invoke:async()=>{throw Object.assign(Error('NATIVE_OPERATION_UNCERTAIN'),{code:'NATIVE_OPERATION_UNCERTAIN'});}});
 await a.rejects(f.mcp.call('crm_email_health',{brand:'fish'},'isolated-token'),e=>e.code==='NATIVE_OPERATION_UNCERTAIN');a.equal(f.calls.length,1);
});
function env(){
 return {DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:host,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'}),DASHBOARD_EMAIL_DOMAINS:'["oaristocrata.com","shrigma.com.br","fishermans.com.br"]',DASHBOARD_ADMIN_EMAIL:'felipebandeira@oaristocrata.com',DASHBOARD_BOOTSTRAP_SHA256:'a'.repeat(64),DASHBOARD_ENCRYPTION_KEY:'b'.repeat(64),DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:'own-master-production-v1',DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_READ:'enabled',DASHBOARD_NATIVE_MCP:'enabled',DASHBOARD_CRM_PUBLISHED_JOURNEY_READ:'enabled',DASHBOARD_UPSTREAMS:JSON.stringify({'crm-read':P.FIXED_DESTINATIONS['crm-read'],campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host','comunicacao-crm-audience.tazdb8.easypanel.host']),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify({schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}}),DASHBOARD_DB_PATH:'/tmp/unused-fixture-identity.sqlite',DASHBOARD_PUBLIC_DIR:'/tmp'};
}
test('new health configuration defaults OFF and needs original production Master READ profile',()=>{
 const base=env();a.equal(settingsFromEnv(base).crmNativeDeliveryHealthEnabled,undefined);
 a.equal(settingsFromEnv({...base,DASHBOARD_NATIVE_DELIVERY_HEALTH:'enabled'}).crmNativeDeliveryHealthEnabled,true);
 for(const delta of [{DASHBOARD_NATIVE_DELIVERY_HEALTH:'true'},{DASHBOARD_NATIVE_MCP:'disabled'},{DASHBOARD_CRM_PUBLISHED_JOURNEY_READ:'disabled'},{DASHBOARD_MODE:'synthetic'}])a.throws(()=>settingsFromEnv({...base,DASHBOARD_NATIVE_DELIVERY_HEALTH:'enabled',...delta}),/invalid/);
});
