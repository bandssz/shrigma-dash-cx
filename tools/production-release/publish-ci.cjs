'use strict';
// Publication capability URL stays in an Actions secret. No Easypanel admin API here.
const fs=require('node:fs'),path=require('node:path'),{IMAGE,docker,build}=require('./build-envelope.cjs');
const HOSTS=['gerencial.shrigma.com.br','crm.shrigma.com.br','influs.shrigma.com.br','organico.shrigma.com.br'];
const PREVIOUS=IMAGE+'@sha256:19591562f337271d32c6130d3802d03bb49ebd37a2415358d40a0b09431ed7d5';
const INITIAL_MANIFEST='e2144199a584d0623c838ac0db91b10082a8f35f23b110731d8a711c311cc4ad';
function digest(tag){const info=JSON.parse(docker(['image','inspect',tag]));const matches=info[0].RepoDigests.filter(s=>s.startsWith(IMAGE+'@sha256:'));if(matches.length!==1)throw Error('REGISTRY_DIGEST_REFUSED');return matches[0];}
function inspect(tag){return JSON.parse(docker(['run','--rm','--platform','linux/amd64','--network','none','--read-only','--user','1000:1000','--entrypoint','node',tag,'/app/shrigma-production-launcher.cjs','verify']).trim());}
async function health(host){const r=await fetch('https://'+host+'/healthz',{redirect:'error',signal:AbortSignal.timeout(5000)});if(r.status!==200)throw Error('PRODUCTION_HEALTH_REFUSED');const text=await r.text();if(text.length>16384)throw Error('PRODUCTION_HEALTH_REFUSED');const j=JSON.parse(text);if(j.ok!==true||j.nativeMcp!==true||j.runtimeUid!==1000)throw Error('PRODUCTION_HEALTH_REFUSED');return j;}
async function matches(contract){for(const host of HOSTS){const j=await health(host);if(j.nativeBackendManifestSha256!==contract.manifestSha256||j.journeyPresentationManifestSha256!==contract.presentationManifestSha256)return false;}return true;}
async function currentHead(){
 if(process.env.GITHUB_REPOSITORY!=='bandssz/shrigma-dash-cx'||process.env.GITHUB_REF!=='refs/heads/codex/crm-native-connection-20261007'||!process.env.GITHUB_TOKEN)throw Error('PRODUCTION_SCOPE_REFUSED');
 const r=await fetch('https://api.github.com/repos/bandssz/shrigma-dash-cx/git/ref/heads/codex/crm-native-connection-20261007',{headers:{Authorization:'Bearer '+process.env.GITHUB_TOKEN,Accept:'application/vnd.github+json'},redirect:'error',signal:AbortSignal.timeout(10000)});if(r.status!==200||(await r.json()).object.sha!==process.env.GITHUB_SHA)throw Error('STALE_PUBLICATION_REFUSED');
}
function triggerUrl(){const u=new URL(process.env.SHRIGMA_EASYPANEL_DEPLOY_URL);if(u.protocol!=='https:'||u.hostname!=='comando.shrigma.com.br'||u.username||u.password||u.hash)throw Error('DEPLOY_CAPABILITY_REFUSED');return u;}
async function trigger(){const u=triggerUrl();const r=await fetch(u,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('DEPLOY_TRIGGER_REFUSED');/* Do not log or parse secret endpoint response. */}
async function wait(contract){const end=Date.now()+240000;while(Date.now()<end){try{if(await matches(contract))return true;}catch{}await new Promise(r=>setTimeout(r,5000));}return false;}
function receipt(j){fs.writeFileSync(path.join(process.env.AFFILIATE_CI_DIR,'production-receipt.json'),JSON.stringify(j,null,2)+'\n',{mode:0o600});fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,'```json\n'+JSON.stringify(j,null,2)+'\n```\n');console.log(JSON.stringify(j));}
function isMissing(error){return /(?:manifest unknown|manifest.*not found|name unknown)/i.test(String(error.stderr||''));}
async function main(){
 await currentHead();const request=JSON.parse(fs.readFileSync(path.join(__dirname,'production-request.json')));if(request.schema!=='shrigma-production-request-v1'||!['publish','rollback'].includes(request.action))throw Error('PRODUCTION_REQUEST_REFUSED');
 let previous,previousImage,initial=false;
 try{docker(['pull','--platform','linux/amd64',IMAGE+':producao']);previousImage=digest(IMAGE+':producao');previous=inspect(previousImage);}
 catch(e){if(!isMissing(e))throw Error('PREVIOUS_PUBLICATION_NOT_VERIFIED');initial=true;const h=await health(HOSTS[0]);if(h.nativeBackendManifestSha256!==INITIAL_MANIFEST)throw Error('INITIAL_INSTALLED_VERSION_CHANGED');const tag=IMAGE+':rollback-'+PREVIOUS.split('@sha256:')[1];previous=build({artifactImage:PREVIOUS,tag,directory:path.join(process.env.AFFILIATE_CI_DIR,'previous-envelope')});docker(['push',tag]);previousImage=digest(tag);}
 if(!await matches(previous))throw Error('REGISTRY_AND_INSTALLED_VERSION_DIFFER');
 let candidate,desired;
 if(request.action==='rollback'){
  if(Object.keys(request).sort().join(',')!=='action,image,schema'||!new RegExp('^'+IMAGE+'@sha256:[a-f0-9]{64}$').test(request.image))throw Error('ROLLBACK_TARGET_REFUSED');
  docker(['pull','--platform','linux/amd64',request.image]);candidate=inspect(request.image);desired=request.image;
 }else{
  if(Object.keys(request).sort().join(',')!=='action,schema')throw Error('PRODUCTION_REQUEST_REFUSED');
  const tag=IMAGE+':source-'+process.env.GITHUB_SHA;docker(['pull','--platform','linux/amd64',tag]);const artifactImage=digest(tag),envelopeTag=IMAGE+':envelope-'+process.env.GITHUB_SHA;
  candidate=build({artifactImage,tag:envelopeTag,directory:path.join(process.env.AFFILIATE_CI_DIR,'candidate-envelope')});
  // Same exact image is tested before its envelope is published/promoted.
  docker(['run','--rm','--platform','linux/amd64','--network','none','--read-only','--user','1000:1000','--memory','512m','--tmpfs','/tmp:rw,noexec,nosuid,mode=1777','--tmpfs','/dashboard-data:rw,noexec,nosuid,mode=0700,uid=1000,gid=1000','--mount','type=bind,src='+path.resolve('ops/releases/crm-native-connection-20261007/journey-smoke.cjs')+',dst=/tmp/smoke.cjs,readonly','--entrypoint','node',envelopeTag,'/tmp/smoke.cjs']);
  docker(['push',envelopeTag]);desired=digest(envelopeTag);
 }
 await currentHead();const base={schema:'shrigma-production-receipt-v1',revision:process.env.GITHUB_SHA,action:request.action,artifactImage:candidate.artifactImage,envelopeImage:desired,previousEnvelopeImage:previousImage,previousArtifactImage:previous.artifactImage,manifestSha256:candidate.manifestSha256,presentationManifestSha256:candidate.presentationManifestSha256,sourceRevision:candidate.sourceRevision,checkedAt:new Date().toISOString()};
 // Initial setup publishes the fixed tag but performs no deploy until the owner
 // has applied the prepared Compose once and installed the capability secret.
 if(!process.env.SHRIGMA_EASYPANEL_DEPLOY_URL){if(!initial||request.action!=='publish')throw Error('DEPLOY_CAPABILITY_MISSING');docker(['tag',desired,IMAGE+':producao']);docker(['push',IMAGE+':producao']);receipt({...base,status:'bootstrap-required',productionVerified:false,deployAttempted:false});return;}
 triggerUrl();docker(['tag',desired,IMAGE+':producao']);docker(['push',IMAGE+':producao']);let triggered=false;
 try{triggered=true;await trigger();if(!await wait(candidate))throw Error('PRODUCTION_NOT_CONFIRMED');receipt({...base,status:'installed',productionVerified:true,deployAttempted:triggered});}
 catch(e){
  // Recreate only the same existing gateway. No credential/config/admin writes.
  docker(['tag',previousImage,IMAGE+':producao']);docker(['push',IMAGE+':producao']);let restored=false;try{await trigger();restored=await wait(previous);}catch{}
  receipt({...base,status:restored?'rolled-back':'rollback-unconfirmed',productionVerified:false,deployAttempted:triggered,rollbackAttempted:true,rollbackVerified:restored,errorCode:e.message==='PRODUCTION_NOT_CONFIRMED'?'PRODUCTION_NOT_CONFIRMED':'DEPLOY_NOT_CONFIRMED'});process.exitCode=1;
 }
}
if(require.main===module)main().catch(()=>{console.error('PRODUCTION_PUBLICATION_REFUSED_NO_SECRET_OUTPUT');process.exitCode=1;});
module.exports={isMissing};
