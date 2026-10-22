'use strict';
const N=require('./bootstrap.cjs'),P=require('/app/presentation-release/release.cjs');
async function startExisting({manifestSha256,imageDigest}={}){
 N.verifyRelease(manifestSha256);
 const requested={...process.env},routes=require(N.ROOT+'/runtime/proxy.cjs');
 const read=routes.FIXED_DESTINATIONS['crm-read'],campaigns=routes.REVIEWED_DYNAMIC.routes.campaigns;
 const hosts=JSON.parse(requested.DASHBOARD_UPSTREAM_HOSTS||'[]');
 const preserved={...requested,DASHBOARD_UPSTREAMS:JSON.stringify({'crm-read':read,campaigns}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify([...new Set([...hosts,new URL(read).hostname,new URL(campaigns).hostname])]),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify({schema:routes.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:routes.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns}}),DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:'own-master-production-v1',DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',...Object.fromEntries(['DASHBOARD_CRM_CORPORATE_CREATE','DASHBOARD_CRM_DRAFT_WRITE','DASHBOARD_CRM_AUDIENCE_DRAFT','DASHBOARD_CRM_MANAGED_READ','DASHBOARD_CRM_MANAGED_READ_UI','DASHBOARD_CRM_MANAGED_AUDIENCE_READ','DASHBOARD_CRM_MANAGED_TEMPLATE_READ','DASHBOARD_CRM_MANAGED_WRITER'].map(k=>[k,'disabled']))};
  const runtime=require(N.ROOT+'/runtime/server.cjs');
  const projected=runtime.environmentForOriginalMasterCampaignCreate(requested,preserved);
  const audience=runtime.environmentForOriginalMasterAudienceRead(projected);
  const journeys=runtime.environmentForOriginalMasterPublishedJourneyRead(requested,audience);
  const templates=runtime.environmentForOriginalMasterTemplateRead(requested,journeys);
  const composition=runtime.environmentForOriginalMasterIndividualCoexistence(requested,templates);
  const individual=runtime.environmentForOriginalMasterIndividualRead(requested,composition);
  const simple=runtime.environmentForSimpleDashboardRead(requested,individual);
  const next=runtime.environmentForOriginalMasterAffiliateRead(requested,simple);
  // Only the original fixed route/profile projection is applied; no old
  // controller, observer, native activation hook, fence or receipt is invoked.
  const keys=['DASHBOARD_AFFILIATE_READ','DASHBOARD_INDIVIDUAL_READ','DASHBOARD_UPSTREAMS','DASHBOARD_UPSTREAM_HOSTS','DASHBOARD_DYNAMIC_ROUTE_MANIFEST','DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE','DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE','DASHBOARD_CRM_CORPORATE_CREATE','DASHBOARD_CRM_DRAFT_WRITE','DASHBOARD_CRM_AUDIENCE_DRAFT','DASHBOARD_CRM_MANAGED_READ','DASHBOARD_CRM_MANAGED_READ_UI','DASHBOARD_CRM_MANAGED_AUDIENCE_READ','DASHBOARD_CRM_MANAGED_TEMPLATE_READ','DASHBOARD_CRM_MANAGED_WRITER'];
  if(next.DASHBOARD_CRM_MASTER_AUDIENCE_READ!==undefined)keys.push('DASHBOARD_CRM_MASTER_AUDIENCE_READ');
  if(next.DASHBOARD_CRM_MASTER_AUDIENCE_WRITE!==undefined)keys.push('DASHBOARD_CRM_MASTER_AUDIENCE_WRITE');
  if(next.DASHBOARD_CRM_MASTER_AUDIENCE_COUNT!==undefined)keys.push('DASHBOARD_CRM_MASTER_AUDIENCE_COUNT','DASHBOARD_CRM_MASTER_AUDIENCE_CONTEXT_REVIEW');
  if(next.DASHBOARD_CRM_PUBLISHED_JOURNEY_READ!==undefined)keys.push('DASHBOARD_CRM_PUBLISHED_JOURNEY_READ');
  if(next.DASHBOARD_CRM_MASTER_TEMPLATE_READ!==undefined)keys.push('DASHBOARD_CRM_MASTER_TEMPLATE_READ');
  if(next.DASHBOARD_CRM_INDIVIDUAL_COEXISTENCE==='enabled')keys.push('DASHBOARD_CRM_INDIVIDUAL_COEXISTENCE','DASHBOARD_CRM_MANAGER_ISSUER_ID','DASHBOARD_CRM_MANAGER_NAMESPACE_ID','DASHBOARD_CRM_MANAGER_PROVISIONER_TOKEN','DASHBOARD_CRM_WRITER_DESCRIPTOR','DASHBOARD_CRM_WRITER_PROVISIONER_TOKEN');
  for(const name of keys)process.env[name]=next[name];
  const started=P.startWithPresentation(()=>N.start({manifestSha256}));
  return started;
}
if(require.main===module)startExisting({manifestSha256:process.argv[2],imageDigest:process.argv[3]}).then(()=>console.log(JSON.stringify({schema:'shrigma-native-existing-start-v1',historicalInvocations:0,historicalReceiptWrites:0,operational:false})),e=>{console.error(JSON.stringify({schema:'shrigma-native-existing-start-v1',ok:false,code:'NATIVE_EXISTING_START_REFUSED',operational:false}));process.exitCode=1;});
module.exports={startExisting};
