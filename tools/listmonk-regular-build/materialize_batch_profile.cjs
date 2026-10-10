 'use strict';
// Copy only the exact verified profile graph; no SQL execution, build or transport.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Profile=require('./native_batch_profile.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),HASH=/^[a-f0-9]{64}$/;
function refuse(){throw Error('BATCH_PROFILE_MATERIALIZATION_REFUSED');}
function bounded(f){const s=fs.lstatSync(f);if(!s.isFile()||s.isSymbolicLink()||s.size>1048576)refuse();return fs.readFileSync(f);}
function materialize({profile,profileSha256,out,buildManifest=null}){
 profile=path.resolve(profile);const verified=Profile.load(profile,profileSha256);const m=JSON.parse(bounded(profile)),root=path.dirname(profile);
 if(m.compositionRoot!=='.'||!HASH.test(profileSha256))refuse();
 const files=[m.compositionDelivery,...Object.values(m.sources),...m.additionalSqlSources.map(d=>d.file),...(m.isolatedProofAuthorization?[m.version===4?m.isolatedProofAuthorization.readReceipt:m.isolatedProofAuthorization]:[])];
 if(m.version===3&&m.isolatedProofAuthorization){const authorization=JSON.parse(bounded(path.join(root,m.isolatedProofAuthorization.path)));for(const row of authorization.recipientPreviews)files.push(row.parameters);}
 const plan=new Map();for(const pin of files){const data=bounded(path.join(root,pin.path));if(data.length!==pin.bytes||sha(data)!==pin.sha256)refuse();if(plan.has(pin.path)&&!plan.get(pin.path).equals(data))refuse();plan.set(pin.path,data);}
 if(buildManifest!==null){
  buildManifest=path.resolve(buildManifest);const manifest=JSON.parse(bounded(buildManifest)),receipt=manifest.batch_profile&&manifest.batch_profile.build_receipt;
  const binary=path.join(path.dirname(buildManifest),'candidate/listmonk'),stat=fs.lstatSync(binary);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>67108864)refuse();
  const binarySha256=sha(fs.readFileSync(binary));
  if(manifest.schema!=='listmonk-regular-package-v1'||manifest.status!=='CANDIDATE_OFF_NOT_DEPLOYED'||manifest.production_changed!==false||manifest.listmonk_executed!==false||manifest.runtime_activation!==false||manifest.binary_sha256!==binarySha256||manifest.query_sha256!==verified.querySha256||manifest.source_lock_sha256!==m.sources.builderLock.sha256||!receipt||receipt.binarySha256!==binarySha256||receipt.querySha256!==verified.querySha256||receipt.kernelSha256!==verified.kernelSha256||receipt.composerSha256!==m.sources.composer.sha256||receipt.workerTransactionSha256!==verified.workerTransactionSha256)refuse();
  m.buildReceipt=receipt;
 }
 out=path.resolve(out);if(fs.existsSync(out)||fs.realpathSync(path.dirname(out))!==path.dirname(out))refuse();
 fs.mkdirSync(out,{mode:0o700});
 for(const [name,data]of plan){const f=path.join(out,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,data,{flag:'wx'});}
 const target=path.join(out,'PROFILE.json'),data=Buffer.from(JSON.stringify(m,null,2)+'\n');fs.writeFileSync(target,data,{flag:'wx'});
 const digest=sha(data);Profile.load(target,digest);return {profile:target,profileSha256:digest,querySha256:verified.querySha256,kernelSha256:verified.kernelSha256,buildReceiptAttached:m.buildReceipt!==null,isolatedProofPrerequisitesClosed:m.isolatedProofAuthorization!==null&&m.buildReceipt!==null,fullRecipientAccepted:false,operational:false};
}
if(require.main===module){try{const args=process.argv.slice(2),opts={};for(let i=0;i<args.length;i+=2){if(!['--profile','--sha256','--out','--build-manifest'].includes(args[i])||!args[i+1]||opts[args[i]])refuse();opts[args[i]]=args[i+1];}if(!opts['--profile']||!opts['--sha256']||!opts['--out'])refuse();process.stdout.write(JSON.stringify(materialize({profile:opts['--profile'],profileSha256:opts['--sha256'],out:opts['--out'],buildManifest:opts['--build-manifest']||null}))+'\n');}catch{process.stderr.write('BATCH_PROFILE_MATERIALIZATION_REFUSED\n');process.exitCode=1;}}
module.exports={materialize};
