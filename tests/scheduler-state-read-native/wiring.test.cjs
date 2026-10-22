'use strict';
const test=require('node:test'),a=require('node:assert/strict'),path=require('node:path');
const runtime=process.env.SCHEDULER_STATE_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational');
const {createNativeMcp}=require(runtime+'/crm-native-mcp.cjs'),{settingsFromEnv,authOptionsFor}=require(runtime+'/server.cjs'),P=require(runtime+'/proxy.cjs');
const host='gerencial.shrigma.com.br';
function env(){return {DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:host,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'}),DASHBOARD_EMAIL_DOMAINS:'["oaristocrata.com","shrigma.com.br","fishermans.com.br"]',DASHBOARD_ADMIN_EMAIL:'felipebandeira@oaristocrata.com',DASHBOARD_BOOTSTRAP_SHA256:'a'.repeat(64),DASHBOARD_ENCRYPTION_KEY:'b'.repeat(64),DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:'own-master-production-v1',DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_READ:'enabled',DASHBOARD_NATIVE_MCP:'enabled',DASHBOARD_CRM_PUBLISHED_JOURNEY_READ:'enabled',DASHBOARD_UPSTREAMS:JSON.stringify({'crm-read':P.FIXED_DESTINATIONS['crm-read'],campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host','comunicacao-crm-audience.tazdb8.easypanel.host']),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify({schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}}),DASHBOARD_DB_PATH:'/tmp/unused-fixture.sqlite',DASHBOARD_PUBLIC_DIR:'/tmp'};}
test('state READ defaults OFF and requires native original production journey profile',()=>{
 const base=env();a.equal(settingsFromEnv(base).crmNativeSchedulerStateEnabled,undefined);
 const on=settingsFromEnv({...base,DASHBOARD_NATIVE_SCHEDULER_STATE:'enabled'});
 a.equal(on.crmNativeSchedulerStateEnabled,true);a.equal(authOptionsFor(on).crmNativeSchedulerStateEnabled,true);
 for(const delta of [{DASHBOARD_NATIVE_SCHEDULER_STATE:'true'},{DASHBOARD_NATIVE_MCP:'disabled'},{DASHBOARD_CRM_PUBLISHED_JOURNEY_READ:'disabled'},{DASHBOARD_MODE:'synthetic'}])a.throws(()=>settingsFromEnv({...base,DASHBOARD_NATIVE_SCHEDULER_STATE:'enabled',...delta}),/invalid/);
});
function fixture({enabled=true,feature=true,receiptStatus=403,revokedAfterRead=false}={}){
 const calls=[];let revoked=false;
 const proof={brands:['fish','aristo'],scopes:['crm.read'],userId:'fixture-owner',host,id:'fixture-connection'};
 const store={authenticate:()=>{if(revoked)throw Object.assign(Error('NATIVE_AUTH_REQUIRED'),{code:'NATIVE_AUTH_REQUIRED',status:403});return proof;},context:token=>({nativeBearer:token,host,method:'GET'})};
 const mcp=createNativeMcp({auth:{nativeConnections:store},managerHost:host,schedulerStateEnabled:enabled,invoke:async q=>{
  calls.push(q);
  if(q.path==='/auth/session')return {status:200,body:{authenticated:true,user:{role:'superadmin'},features:{nativeSchedulerState:feature}}};
  if(q.path==='/healthz')return {status:200,body:{nativeMcp:true}};
  if(q.path==='/api/scheduler-state-receipt'){if(revokedAfterRead)revoked=true;return {status:receiptStatus,body:receiptStatus===200?{schema:'shrigma-scheduler-state-read-v1',readOnly:true,operational:false}:{error:'SCHEDULER_STATE_CONSENT_REQUIRED'}};}
  throw Error('Unexpected path');
 }});
 return {mcp,calls};
}
test('existing native status exposes own-purpose refusal without converting it into SQL authority',async()=>{
 const {mcp,calls}=fixture(),v=await mcp.call('crm_status',{},'synthetic-token');
 a.equal(v.status,200);a.equal(v.body.schedulerStateReceipt.status,403);a.equal(v.body.operational,false);
 a.deepEqual(calls.map(q=>q.path),['/auth/session','/healthz','/api/scheduler-state-receipt']);
 a(calls.every(q=>q.method==='GET'&&q.body===undefined));
});
test('OFF capability and absent CURRENT feature never dispatch state receipt READ',async()=>{
 for(const opts of [{enabled:false},{feature:false}]){const {mcp,calls}=fixture(opts),v=await mcp.call('crm_status',{},'synthetic-token');a.equal(v.body.schedulerStateReceipt,undefined);a.deepEqual(calls.map(q=>q.path),['/auth/session','/healthz']);}
});
test('native revocation during admitted receipt READ discards the complete status result',async()=>{
 const {mcp,calls}=fixture({receiptStatus:200,revokedAfterRead:true});
 await a.rejects(mcp.call('crm_status',{},'synthetic-token'),{code:'NATIVE_AUTH_REQUIRED'});a.equal(calls.filter(q=>q.path==='/api/scheduler-state-receipt').length,1);
});
test('uncertain controller wrapper stays uncertain and never triggers retry or alternate route',async()=>{
 const {mcp,calls}=fixture({receiptStatus:503}),v=await mcp.call('crm_status',{},'synthetic-token');
 a.equal(v.body.schedulerStateReceipt.status,503);a.equal(calls.filter(q=>q.path==='/api/scheduler-state-receipt').length,1);a.equal(v.body.operational,false);
});
