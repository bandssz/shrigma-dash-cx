'use strict';
// Publication capability URL stays in an Actions secret. No Easypanel admin API here.
const fs=require('node:fs'),path=require('node:path'),{IMAGE,DIGEST_RE,docker,build}=require('./build-envelope.cjs');
const {retryRead,transportCode}=require('./read-retry.cjs');
const HOSTS=['gerencial.shrigma.com.br','crm.shrigma.com.br','influs.shrigma.com.br','organico.shrigma.com.br'];
const PREVIOUS=IMAGE+'@sha256:19591562f337271d32c6130d3802d03bb49ebd37a2415358d40a0b09431ed7d5';
const INITIAL_MANIFEST='e2144199a584d0623c838ac0db91b10082a8f35f23b110731d8a711c311cc4ad';
let publicationPhase='initial';
const SAFE_CODES=new Set(['REGISTRY_DIGEST_REFUSED','PRODUCTION_HEALTH_REFUSED','PRODUCTION_SCOPE_REFUSED','STALE_PUBLICATION_REFUSED','DEPLOY_CAPABILITY_REFUSED','DEPLOY_TRIGGER_REFUSED','PRODUCTION_REQUEST_REFUSED','PREVIOUS_PUBLICATION_NOT_VERIFIED','INITIAL_INSTALLED_VERSION_CHANGED','REGISTRY_AND_INSTALLED_VERSION_DIFFER','ROLLBACK_TARGET_REFUSED','VERIFIED_ARTIFACT_MISSING','VERIFIED_ARTIFACT_CHANGED','DEPLOY_CAPABILITY_MISSING','ENVELOPE_TARGET_REFUSED','PRODUCTION_CONTRACT_REFUSED','ENVELOPE_VERIFY_REFUSED','EEXIST','ENOENT']);
SAFE_CODES.add('ROLLBACK_REQUEST_REQUIRED');SAFE_CODES.add('QA_GATE_MISSING');
SAFE_CODES.add('MAINTENANCE_INSTALL_WINDOW_UNCONFIRMED');
function publicationFailure(error){return{schema:'shrigma-publication-failure-v1',phase:publicationPhase,code:SAFE_CODES.has(error?.message)?error.message:SAFE_CODES.has(error?.code)?error.code:'PUBLICATION_STEP_FAILED',errorName:['Error','TypeError','SyntaxError','AssertionError','AbortError','TimeoutError'].includes(error?.name)?error.name:null,causeCode:transportCode(error),subprocessExit:Number.isInteger(error?.status)?error.status:null,secretsPrinted:false};}
function awaitChild(command,args,options,{spawnImpl=require('node:child_process').spawn}={}){
 return new Promise((resolve,reject)=>{let child;try{child=spawnImpl(command,args,options);}catch{reject(Error('MAINTENANCE_INSTALL_WINDOW_UNCONFIRMED'));return;}child.once('error',()=>reject(Error('MAINTENANCE_INSTALL_WINDOW_UNCONFIRMED')));child.once('close',(code,signal)=>code===0&&!signal?resolve():reject(Error('MAINTENANCE_INSTALL_WINDOW_UNCONFIRMED')));});
}
function validateRequest(request,{rollbackJob=false}={}){
 if(request?.schema!=='shrigma-production-request-v1'||!['publish','rollback'].includes(request.action))throw Error('PRODUCTION_REQUEST_REFUSED');
 if(rollbackJob&&request.action!=='rollback')throw Error('ROLLBACK_REQUEST_REQUIRED');
 if(request.action==='rollback'){
  if(Object.keys(request).sort().join(',')!=='action,image,schema'||!DIGEST_RE.test(request.image))throw Error('ROLLBACK_TARGET_REFUSED');
 }else if(Object.keys(request).sort().join(',')!=='action,schema')throw Error('PRODUCTION_REQUEST_REFUSED');
 return request;
}
function digest(tag){const info=JSON.parse(docker(['image','inspect',tag]));const matches=info[0].RepoDigests.filter(s=>s.startsWith(IMAGE+'@sha256:'));if(matches.length!==1)throw Error('REGISTRY_DIGEST_REFUSED');return matches[0];}
function inspect(tag){return JSON.parse(docker(['run','--rm','--platform','linux/amd64','--network','none','--read-only','--user','1000:1000','--entrypoint','node',tag,'/app/shrigma-production-launcher.cjs','verify']).trim());}
async function health(host){const r=await fetch('https://'+host+'/healthz',{redirect:'error',signal:AbortSignal.timeout(5000)});if(r.status!==200)throw Error('PRODUCTION_HEALTH_REFUSED');const text=await r.text();if(text.length>16384)throw Error('PRODUCTION_HEALTH_REFUSED');const j=JSON.parse(text);if(j.ok!==true||j.nativeMcp!==true||j.runtimeUid!==1000)throw Error('PRODUCTION_HEALTH_REFUSED');return j;}
async function matches(contract){for(const host of HOSTS){const j=await health(host);if(j.nativeBackendManifestSha256!==contract.manifestSha256||j.journeyPresentationManifestSha256!==contract.presentationManifestSha256)return false;}return true;}
async function currentHead({env=process.env,fetchImpl=fetch,wait,validate}={}){
 const candidate='codex/home-v35-night43-20261024',branch=env.GITHUB_REF==='refs/heads/'+candidate;
 if(env.GITHUB_REPOSITORY!=='bandssz/shrigma-dash-cx'||!env.GITHUB_TOKEN||!(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||''))||env.GITHUB_REF!=='refs/heads/main'&&!branch||branch&&!/^[a-f0-9]{40}$/.test(env.PRODUCTION_EXPECT_MAIN_REVISION||''))throw Error('PRODUCTION_SCOPE_REFUSED');
 const read=async(ref,sha)=>retryRead(async()=>{const r=await fetchImpl('https://api.github.com/repos/bandssz/shrigma-dash-cx/git/ref/heads/'+ref,{headers:{Authorization:'Bearer '+env.GITHUB_TOKEN,Accept:'application/vnd.github+json'},redirect:'error',signal:AbortSignal.timeout(10000)});if(r.status!==200||(await r.json()).object?.sha!==sha)throw Error('STALE_PUBLICATION_REFUSED');},{wait,validate});
 if(branch)await read(candidate,env.GITHUB_SHA);
 await read('main',branch?env.PRODUCTION_EXPECT_MAIN_REVISION:env.GITHUB_SHA);
}
function weekendWindow({env=process.env,now=Date.now()}={}){return env.PRODUCTION_WEEKEND_NO_ANALYSTS==='2026-10-24/25'&&now>=Date.parse('2026-10-24T03:00:00Z')&&now<Date.parse('2026-10-26T11:00:00Z');}
function triggerUrl(){const u=new URL(process.env.SHRIGMA_EASYPANEL_DEPLOY_URL);if(u.protocol!=='https:'||u.hostname!=='comando.shrigma.com.br'||u.username||u.password||u.hash)throw Error('DEPLOY_CAPABILITY_REFUSED');return u;}
async function trigger(){const u=triggerUrl();const r=await fetch(u,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('DEPLOY_TRIGGER_REFUSED');/* Do not log or parse secret endpoint response. */}
async function wait(contract){const end=Date.now()+240000;while(Date.now()<end){try{if(await matches(contract))return true;}catch{}await new Promise(r=>setTimeout(r,5000));}return false;}
function receipt(j){fs.writeFileSync(path.join(process.env.AFFILIATE_CI_DIR,'production-receipt.json'),JSON.stringify(j,null,2)+'\n',{mode:0o600});fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,'```json\n'+JSON.stringify(j,null,2)+'\n```\n');console.log(JSON.stringify(j));}
function isMissing(error){const s=String(error.stderr||'');return !/unauthorized|forbidden|denied|timeout|timed out|connection|TLS|certificate|5\d\d.*server/i.test(s)&&/(?:manifest unknown|manifest.*not found|name unknown)/i.test(s);}
function validateAccessGate(q,revision){if(q?.schema!=='shrigma-ci-access-qa-v1'||q.ok!==true||q.candidateRevision!==revision||q.brands!==2||q.qaAccounts!==6||q.readonlyServerDenials!==4||q.internalTestsAccepted!==0||q.scheduledAndCancelled!==0||q.mockedResponses!==false||q.serial!==true||q.linuxDocker!==true)throw Error('QA_GATE_MISSING');return q;}
async function main(){
 publicationPhase='check-branch';await currentHead();const request=validateRequest(JSON.parse(fs.readFileSync(path.join(__dirname,'production-request.json'))),{rollbackJob:process.env.GITHUB_JOB==='rollback-production'});
 if(request.action==='rollback'){
  publicationPhase='redeploy-known-image';docker(['pull','--platform','linux/amd64',request.image]);
  const candidate=inspect(request.image);triggerUrl();await currentHead();
  docker(['tag',request.image,IMAGE+':producao']);docker(['push',IMAGE+':producao']);await trigger();
  const observed=await wait(candidate);receipt({schema:'shrigma-production-receipt-v1',revision:process.env.GITHUB_SHA,action:'rollback',envelopeImage:request.image,artifactImage:candidate.artifactImage,sourceRevision:candidate.sourceRevision,manifestSha256:candidate.manifestSha256,presentationManifestSha256:candidate.presentationManifestSha256,status:observed?'known-image-health-observed':'rollback-unconfirmed',deployAttempted:true,productionVerified:false,rollbackVerified:false,requiresNativeDeploymentReconciliation:true,checkedAt:new Date().toISOString()});
  if(!observed)process.exitCode=1;return;
 }
 if(request.action==='publish')validateAccessGate(JSON.parse(fs.readFileSync(path.join(process.env.AFFILIATE_CI_DIR,'qa-gate-safe.json'),'utf8')),process.env.GITHUB_SHA);
 let previous,previousImage,initial=false;
 try{publicationPhase='pull-previous';docker(['pull','--platform','linux/amd64',IMAGE+':producao']);publicationPhase='inspect-previous';previousImage=digest(IMAGE+':producao');previous=inspect(previousImage);}
 catch(e){if(!isMissing(e))throw Error('PREVIOUS_PUBLICATION_NOT_VERIFIED');initial=true;const h=await health(HOSTS[0]);if(h.nativeBackendManifestSha256!==INITIAL_MANIFEST)throw Error('INITIAL_INSTALLED_VERSION_CHANGED');const tag=IMAGE+':rollback-'+PREVIOUS.split('@sha256:')[1];previous=build({artifactImage:PREVIOUS,tag,directory:path.join(process.env.AFFILIATE_CI_DIR,'previous-envelope')});docker(['push',tag]);previousImage=digest(tag);}
 publicationPhase='compare-registry-runtime';if(request.action==='publish'&&!await matches(previous))throw Error('REGISTRY_AND_INSTALLED_VERSION_DIFFER');
 let candidate,desired;
 if(request.action==='rollback'){
  if(Object.keys(request).sort().join(',')!=='action,image,schema'||!DIGEST_RE.test(request.image))throw Error('ROLLBACK_TARGET_REFUSED');
  docker(['pull','--platform','linux/amd64',request.image]);candidate=inspect(request.image);desired=request.image;
 }else{
  if(Object.keys(request).sort().join(',')!=='action,schema')throw Error('PRODUCTION_REQUEST_REFUSED');
  publicationPhase='read-verified-artifact';const verified=JSON.parse(fs.readFileSync(path.join(process.env.AFFILIATE_CI_DIR,'native-receipt.json')));
  if(verified.published!==true||verified.sourceRevision!==process.env.GITHUB_SHA||!DIGEST_RE.test(verified.image))throw Error('VERIFIED_ARTIFACT_MISSING');
  const artifactImage=verified.image,envelopeTag=IMAGE+':envelope-'+process.env.GITHUB_SHA;
  publicationPhase='build-envelope';candidate=build({artifactImage,tag:envelopeTag,directory:path.join(process.env.AFFILIATE_CI_DIR,'candidate-envelope')});
  if(candidate.sourceRevision!==process.env.GITHUB_SHA||candidate.manifestSha256!==verified.manifestSha256||candidate.presentationManifestSha256!==verified.presentationManifestSha256)throw Error('VERIFIED_ARTIFACT_CHANGED');
  // Same exact image is tested before its envelope is published/promoted.
  publicationPhase='smoke-preserved-runtime';docker(['run','--rm','--platform','linux/amd64','--network','none','--read-only','--user','1000:1000','--memory','512m','--tmpfs','/tmp:rw,noexec,nosuid,mode=1777','--tmpfs','/dashboard-data:rw,noexec,nosuid,mode=0700,uid=1000,gid=1000','--mount','type=bind,src='+path.resolve('ops/releases/crm-native-connection-20261007/journey-smoke.cjs')+',dst=/tmp/smoke.cjs,readonly','--entrypoint','node',envelopeTag,'/tmp/smoke.cjs']);
  publicationPhase='smoke-individual-runtime';docker(['run','--rm','--platform','linux/amd64','--network','none','--read-only','--user','1000:1000','--memory','512m','--tmpfs','/tmp:rw,noexec,nosuid,mode=1777','--tmpfs','/dashboard-data:rw,noexec,nosuid,mode=0700,uid=1000,gid=1000','--mount','type=bind,src='+path.resolve('tools/production-release/envelope-smoke.cjs')+',dst=/tmp/envelope-smoke.cjs,readonly','--entrypoint','node',envelopeTag,'/tmp/envelope-smoke.cjs']);
  publicationPhase='push-envelope';docker(['push',envelopeTag]);desired=digest(envelopeTag);
 }
 publicationPhase='check-head-before-install';await currentHead();const base={schema:'shrigma-production-receipt-v1',revision:process.env.GITHUB_SHA,action:request.action,artifactImage:candidate.artifactImage,envelopeImage:desired,previousEnvelopeImage:previousImage,previousArtifactImage:previous.artifactImage,manifestSha256:candidate.manifestSha256,presentationManifestSha256:candidate.presentationManifestSha256,sourceRevision:candidate.sourceRevision,checkedAt:new Date().toISOString()};
 // Initial setup publishes the fixed tag but performs no deploy until the owner
 // has applied the prepared Compose once and installed the capability secret.
 if(!process.env.SHRIGMA_EASYPANEL_DEPLOY_URL){if(!initial||request.action!=='publish')throw Error('DEPLOY_CAPABILITY_MISSING');docker(['tag',desired,IMAGE+':producao']);docker(['push',IMAGE+':producao']);receipt({...base,status:'bootstrap-required',productionVerified:false,deployAttempted:false});return;}
 triggerUrl();let triggered=false;
 const weekend=weekendWindow(),windowProof=()=>{if(weekend){if(!weekendWindow())throw Error('MAINTENANCE_INSTALL_WINDOW_UNCONFIRMED');return;}return require('../crm-qa/maintenance-window.cjs').validateReceipt(JSON.parse(fs.readFileSync(path.join(process.env.AFFILIATE_CI_DIR,'maintenance-window.safe.json'),'utf8')),{revision:process.env.GITHUB_SHA});};
 if(request.action==='publish'&&weekend){const proof={schema:'shrigma-weekend-install-window-v1',candidateRevision:process.env.GITHUB_SHA,ok:true,fromUtc:'2026-10-24T03:00:00Z',untilUtc:'2026-10-26T11:00:00Z',checkedAtUtc:new Date().toISOString(),humanDecision:'v38-weekend-no-analysts',noticeRequired:false};windowProof();fs.writeFileSync(path.join(process.env.AFFILIATE_CI_DIR,'weekend-window.safe.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify(proof));}
 if(request.action==='publish'&&!weekend){
  publicationPhase='maintenance-window-awaiting-notice';console.log(JSON.stringify({phase:publicationPhase,candidateRevision:process.env.GITHUB_SHA}));
  await awaitChild(process.execPath,[path.join(__dirname,'../crm-qa/run-ci.cjs')],{env:{...process.env,CRM_QA_GATE:'maintenance-window',CRM_QA_PLAYWRIGHT_ROOT:path.join(process.env.AFFILIATE_CI_DIR,'playwright')},stdio:'inherit'});
  publicationPhase='post-notice-check-head';await currentHead({validate:windowProof});
  publicationPhase='post-notice-validate-window';windowProof();
  const window=JSON.parse(fs.readFileSync(path.join(process.env.AFFILIATE_CI_DIR,'maintenance-window.safe.json'),'utf8'));
  publicationPhase='post-notice-read-programmed-notice';const notice=await retryRead(()=>require('../crm-qa/maintenance-window.cjs').readProgrammedNotice({revision:process.env.GITHUB_SHA,window,token:process.env.GITHUB_TOKEN,repository:process.env.GITHUB_REPOSITORY}),{validate:windowProof});
  publicationPhase='post-notice-record-confirmation';fs.writeFileSync(path.join(process.env.AFFILIATE_CI_DIR,'notice-programmed.safe.json'),JSON.stringify(notice,null,2)+'\n',{mode:0o600,flag:'wx'});
  publicationPhase='post-notice-validate-window';windowProof();
 }
 try{publicationPhase='promote-fixed-tag';if(request.action==='publish')windowProof();docker(['tag',desired,IMAGE+':producao']);docker(['push',IMAGE+':producao']);if(request.action==='publish'){publicationPhase='check-head-before-trigger';await currentHead({validate:windowProof});windowProof();}publicationPhase='trigger-deployment';triggered=true;await trigger();if(!await wait(candidate))throw Error('PRODUCTION_NOT_CONFIRMED');receipt({...base,status:'installed',productionVerified:true,deployAttempted:triggered});}
 catch(e){
  // Recreate only the same existing gateway. No credential/config/admin writes.
  let restored=false;try{docker(['tag',previousImage,IMAGE+':producao']);docker(['push',IMAGE+':producao']);if(triggered)await trigger();restored=await wait(previous);}catch{}
  // Health can still be the old instance while a deployment is in flight.
  // The integrator must read native deployment/container status before closing
  // rollback or allowing the next publication. Do not claim completion here.
  receipt({...base,status:restored?'registry-restored-runtime-observed':'rollback-unconfirmed',productionVerified:false,deployAttempted:triggered,rollbackAttempted:true,rollbackVerified:false,previousHealthObserved:restored,requiresNativeDeploymentReconciliation:true,errorCode:e.message==='PRODUCTION_NOT_CONFIRMED'?'PRODUCTION_NOT_CONFIRMED':'DEPLOY_NOT_CONFIRMED'});process.exitCode=1;
 }
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify(publicationFailure(e)));process.exitCode=1;});
module.exports={isMissing,publicationFailure,validateRequest,validateAccessGate,currentHead,awaitChild,weekendWindow};
