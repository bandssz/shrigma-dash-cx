'use strict';
// SYNTHETIC TEST FIXTURE ONLY: no native observation, credentials, env or admission.
// These IDs/timestamps/CI assertions are made up to exercise a closed wire shape.
// The project-createdAt literal is required by the reviewed provider contract;
// using it here is not evidence that a project or service was queried.
function buildSyntheticFixture(runtimeDirectory){
 const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),R=require(path.join(runtimeDirectory,'remote-operator.cjs')),C=require(path.join(runtimeDirectory,'../crm-manager-read-activation-review/compose/build-compose.cjs'));
 const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),sources=Object.fromEntries(Object.keys(C.PINS).map(name=>[name,fs.readFileSync(path.join(runtimeDirectory,'../crm-manager-read-activation-review/runtime',name),'utf8')]));
 const stage={suffix:'111222333444',sources,intent:{schema:'crm-manager-read-runtime-intent-v1',operationId:'11111111-1111-4111-8111-111111111111',credentialIntentId:'22222222-2222-4222-8222-222222222222',action:'stage',fromPhase:'empty'},domainId:'33333333-3333-4333-8333-333333333333',isolatedProject:true},plan=R.buildStagePlan(stage);
 const file={schema:'crm-manager-read-driver-plan-file-v1',stage,reconcile:null,planSha256:plan.planSha256},planFileBytes=Buffer.from(JSON.stringify(file)+'\n'),planFileSha256=hash(planFileBytes),d=plan.descriptor;
 const evidence={
  schema:'crm-manager-read-prelaunch-evidence-v1',
  observed:{
   schema:'crm-manager-read-plan-admission-observation-v1',
   collectionStartedUtc:'2026-10-04 01:53:00 UTC',collectionFinishedUtc:'2026-10-04 01:53:02 UTC',
   planFileSha256,planSha256:plan.planSha256,projectName:d.projectName,
   expectedCreatedAt:'2026-10-04T01:52:49.260Z',serviceName:d.serviceName,host:d.domain.host,domainId:d.domain.id,
   projectMatches:true,createdAtMatches:true,servicesCount:0,targetAbsentAtSampling:true,
   domainInventoryValidated:true,domainsCount:0,hostAbsentAtSampling:true,domainIdAbsentAtSampling:true,
   capacity:{procedure:'getLegacyMonitorSystemStats',minimumFreeMemMb:2200,minimumCpuHeadroom:1,minimumFreeDiskGb:4.3,memoryPassed:true,cpuPassed:true,diskPassed:true,unitsConservativelyBounded:true,snapshotOnly:true,reservationClaimed:false},
   receiptIssued:false,stageAuthorized:false,stageReady:false,mutationCallsByThisAgent:0,postgresCalls:0,rawConfigOrMetricsPublished:false
  },
  pins:{
   schema:'crm-manager-read-public-plan-binding-proof-v1',planFileSha256,planSha256:plan.planSha256,
   planMatches:true,projectName:d.projectName,serviceName:d.serviceName,host:d.domain.host,domainId:d.domain.id,
   sourceEntries:Object.entries(C.PINS).map(([name,sha256])=>({name,sha256,matches:true})),image:C.IMAGE,
   rSourceSha256:hash(fs.readFileSync(path.join(runtimeDirectory,'remote-operator.cjs'))),
   cSourceSha256:hash(fs.readFileSync(path.join(runtimeDirectory,'../crm-manager-read-activation-review/compose/build-compose.cjs'))),
   imageAdmissionGuardSha256:'d4936fc711ef8b1d3155ad415f4e38fc9d216dc7195f71d380870eda37a61fcd',
   freshVolumeNamespaceVerified:true,sourceInputsArePublic:true,postgresConnected:false
  },
  // Deliberately fictional values required by the closed test envelope.
  ciEvidence:{candidateSource:'1111111111111111111111111111111111111111',validationJobs:12,publishersSkipped:3,successReportedByRoot:true,independentlyFetchedByThisAgent:false,imageAdmissionUsesPinned5caAndNoUnknownVolumes:true},
  receipt:{schema:'crm-manager-read-remote-admission-v2',planSha256:plan.planSha256,capacityVerified:true,targetAbsent:true,domainAbsent:true,imagePinned:true,nineSourcesPinned:true,newVolumesAbsent:false,existingSourceVerified:false,existingLedgerVerified:false,priorQuiescent:false,volumeExistence:'unobserved',freshVolumeNamespaceVerified:true},
  ttlMilliseconds:10000,receiptValidFromUtc:'2026-10-04T01:53:00.000Z',receiptExpiresAtUtc:'2026-10-04T01:53:10.000Z',
  authorizeStage:false,externalScopesBound:false,stageReady:false,expiredReceiptsMustBeRefused:true,
  automaticRefreshOrRetry:false,realVolumeInventoryObserved:false,actualStageCalls:0
 };
 return {classification:'SYNTHETIC_TEST_ONLY_NOT_NATIVE_EVIDENCE',plan,planFileBytes,evidence,now:Date.parse(evidence.receiptValidFromUtc)+2000};
}
module.exports=Object.freeze({buildSyntheticFixture});
