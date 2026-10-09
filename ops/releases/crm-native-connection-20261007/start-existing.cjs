'use strict';
const N=require('./bootstrap.cjs'),P=require('/app/presentation-release/release.cjs');
function createExistingVerifier({manifestSha256,imageDigest,purpose}={}){
 if(!['verify-existing-continuity-only','verify-preserved-files-only'].includes(purpose))throw Error('NATIVE_EXISTING_ADMISSION_REFUSED');
 const m=N.verifyRelease(manifestSha256);if(!/^[a-f0-9]{64}$/.test(imageDigest||''))throw Error('NATIVE_EXISTING_ADMISSION_REFUSED');
 const C=require(N.ROOT+'/runtime/native-continuity/read-only.cjs');
 const moduleFile=m.files.find(f=>f.path==='runtime/native-continuity/read-only.cjs'),pinsFile=m.files.find(f=>f.path==='runtime/native-continuity/pins.json');
 if(!moduleFile||!pinsFile||C.moduleSha256!==moduleFile.sha256||C.pinsSha256!==pinsFile.sha256)throw Error('NATIVE_EXISTING_ADMISSION_REFUSED');
 const keyValue=process.env.DASHBOARD_ENCRYPTION_KEY;if(!/^[a-f0-9]{64}$/.test(keyValue||''))throw Error('NATIVE_EXISTING_ADMISSION_REFUSED');
 const key=Buffer.from(keyValue,'hex');
 try{
  // This callback admits THIS immutable, explicitly selected fresh source. It
  // creates no identity/grant. The separate verifier proves the existing grant.
  const v=C.createReadOnlyContinuity({enabled:true,encryptionKey:key,admitNewSource:async input=>{
   if(input.purpose!==purpose||input.moduleSha256!==moduleFile.sha256||input.pinsSha256!==pinsFile.sha256||Object.keys(input.service).sort().join(',')!=='project,service'||input.service.project!=='dashboard-image-20260930'||input.service.service!=='portal-read-8fd9c71c9126')throw Error('NATIVE_EXISTING_ADMISSION_REFUSED');
   return {...input,admitted:true,newReleaseRevision:m.sourceRevision,newReleaseImageDigest:imageDigest};
  }});
  return {v,manifest:m,close:()=>key.fill(0)};
 }catch(e){key.fill(0);throw e;}
}
async function startExisting({manifestSha256,imageDigest}={}){
 const verifier=createExistingVerifier({manifestSha256,imageDigest,purpose:'verify-existing-continuity-only'});
 try{
  const v=verifier.v,proof=await v.verifyExistingContinuity();
  const requested={...process.env},preserved=v.environmentForExistingGrant(requested,proof);
  const runtime=require(N.ROOT+'/runtime/server.cjs');
  const projected=runtime.environmentForOriginalMasterCampaignCreate(requested,preserved);
  const audience=runtime.environmentForOriginalMasterAudienceRead(projected);
  const journeys=runtime.environmentForOriginalMasterPublishedJourneyRead(requested,audience);
  const templates=runtime.environmentForOriginalMasterTemplateRead(requested,journeys);
  const next=runtime.environmentForOriginalMasterIndividualCoexistence(requested,templates);
  // Only the original fixed route/profile projection is applied; no old
  // controller, observer, native activation hook, fence or receipt is invoked.
  const keys=['DASHBOARD_UPSTREAMS','DASHBOARD_UPSTREAM_HOSTS','DASHBOARD_DYNAMIC_ROUTE_MANIFEST','DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE','DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE','DASHBOARD_CRM_CORPORATE_CREATE','DASHBOARD_CRM_DRAFT_WRITE','DASHBOARD_CRM_AUDIENCE_DRAFT','DASHBOARD_CRM_MANAGED_READ','DASHBOARD_CRM_MANAGED_READ_UI','DASHBOARD_CRM_MANAGED_AUDIENCE_READ','DASHBOARD_CRM_MANAGED_TEMPLATE_READ','DASHBOARD_CRM_MANAGED_WRITER'];
  if(next.DASHBOARD_CRM_MASTER_AUDIENCE_READ!==undefined)keys.push('DASHBOARD_CRM_MASTER_AUDIENCE_READ');
  if(next.DASHBOARD_CRM_MASTER_AUDIENCE_WRITE!==undefined)keys.push('DASHBOARD_CRM_MASTER_AUDIENCE_WRITE');
  if(next.DASHBOARD_CRM_MASTER_AUDIENCE_COUNT!==undefined)keys.push('DASHBOARD_CRM_MASTER_AUDIENCE_COUNT','DASHBOARD_CRM_MASTER_AUDIENCE_CONTEXT_REVIEW');
  if(next.DASHBOARD_CRM_PUBLISHED_JOURNEY_READ!==undefined)keys.push('DASHBOARD_CRM_PUBLISHED_JOURNEY_READ');
  if(next.DASHBOARD_CRM_MASTER_TEMPLATE_READ!==undefined)keys.push('DASHBOARD_CRM_MASTER_TEMPLATE_READ');
  if(next.DASHBOARD_CRM_INDIVIDUAL_COEXISTENCE==='enabled')keys.push('DASHBOARD_CRM_INDIVIDUAL_COEXISTENCE','DASHBOARD_CRM_MANAGER_ISSUER_ID','DASHBOARD_CRM_MANAGER_NAMESPACE_ID','DASHBOARD_CRM_MANAGER_PROVISIONER_TOKEN','DASHBOARD_CRM_WRITER_DESCRIPTOR','DASHBOARD_CRM_WRITER_PROVISIONER_TOKEN');
  for(const name of keys)process.env[name]=next[name];
  const started=P.startWithPresentation(()=>N.start({manifestSha256}));
  return {...started,continuity:{existingGrantVerified:true,writes:0,oldInvocations:0,operational:false}};
 }finally{verifier.close();}
}
if(require.main===module)startExisting({manifestSha256:process.argv[2],imageDigest:process.argv[3]}).then(()=>console.log(JSON.stringify({schema:'shrigma-native-existing-start-v1',existingContinuityVerified:true,historicalInvocations:0,historicalReceiptWrites:0,operational:false})),e=>{console.error(JSON.stringify({schema:'shrigma-native-existing-start-v1',ok:false,code:/^CONTINUITY_[A-Z_]+$/.test(e.code||'')?e.code:'NATIVE_EXISTING_START_REFUSED',operational:false}));process.exitCode=1;});
module.exports={startExisting,createExistingVerifier};
