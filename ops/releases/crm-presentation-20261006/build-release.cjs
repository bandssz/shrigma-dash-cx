'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const release=require('./release.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const BUILD_SHA='4bb955d96644f1a4472a81210a644cbd4a0b15e23d67c614e78062c2d2b99c2c';
function buildRelease({sourceRoot,imageDir,output}){
 for(const value of [sourceRoot,imageDir,output])if(typeof value!=='string'||!path.isAbsolute(value))throw Error('PRESENTATION_BUILD_INPUT_REFUSED');
 if(fs.existsSync(output))throw Error('PRESENTATION_BUILD_TARGET_EXISTS');
 const sourceBuild=path.join(sourceRoot,'services/dashboard-operational/build.cjs');
 if(sha(fs.readFileSync(sourceBuild))!==BUILD_SHA)throw Error('PRESENTATION_BUILD_CONTRACT_CHANGED');
 for(const [name,pin]of Object.entries(release.IMAGE_FILES))if(sha(fs.readFileSync(path.join(imageDir,name)))!==pin)throw Error('PRESENTATION_BASE_IMAGE_CHANGED');
 const policy=require(path.join(imageDir,'artifact-policy.cjs'));
 const original=policy.decodePack(fs.readFileSync(path.join(imageDir,'runtime-pack.json'),'utf8'),release.BASE_PACK);
 const builder=require(sourceBuild),assets=builder.verifyCampaignAssets();
 const entry=assets.find(a=>a.publicName==='entry.js')?.bytes;if(!entry)throw Error('PRESENTATION_ENTRY_NOT_VERIFIED');
 const changed=new Map([
  ['entry.js',entry],
  ...['growth.html','assets/panels/growth.js'].map(name=>[name,Buffer.from(builder.transform(fs.readFileSync(path.join(sourceRoot,name),'utf8'),name))])
 ]);
 const entryVersion=sha(entry).slice(0,12);
 const originals=new Map(original.files.map(f=>[f.path,Buffer.from(f.content,f.encoding)]));
 for(const name of ['creators/index.html','crm/index.html','gestao/index.html','organico/index.html']){
  const previous=originals.get('public/'+name).toString('utf8'),script='<script src="/entry.js"></script>';
  if(previous.split(script).length!==2)throw Error('PRESENTATION_ENTRY_REFERENCE_CHANGED');
  changed.set(name,Buffer.from(previous.replace(script,'<script src="/entry.js?ui='+entryVersion+'"></script>')));
 }
 const manifest={schema:'crm-presentation-release-v1',baseImageDigest:release.BASE_IMAGE,baseSourceRevision:release.BASE_SOURCE,basePackSha256:release.BASE_PACK,files:release.FILES.map(name=>{
  const before=originals.get('public/'+name),after=changed.get(name);if(!before||!after||before.equals(after))throw Error('PRESENTATION_BUILD_DELTA_REFUSED');
  return {path:name,beforeSha256:sha(before),beforeBytes:before.length,afterSha256:sha(after),afterBytes:after.length};
 })};
 fs.mkdirSync(output,{mode:0o755});
 for(const [name,bytes]of changed){const target=path.join(output,'public',name);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o755});fs.writeFileSync(target,bytes,{flag:'wx',mode:0o444});}
 const raw=JSON.stringify(manifest,null,2)+'\n';fs.writeFileSync(path.join(output,'manifest.json'),raw,{flag:'wx',mode:0o444});
 const protect=dir=>{for(const name of fs.readdirSync(dir)){const file=path.join(dir,name);if(fs.lstatSync(file).isDirectory())protect(file);else fs.chmodSync(file,0o444);}fs.chmodSync(dir,0o555);};protect(output);
 return {schema:'crm-presentation-build-receipt-v1',manifestSha256:sha(Buffer.from(raw)),files:manifest.files,baseImageDigest:release.BASE_IMAGE,basePackUnchanged:true,operational:false};
}
if(require.main===module){try{if(process.argv.length!==5)throw Error('PRESENTATION_BUILD_ARGUMENTS_REFUSED');console.log(JSON.stringify(buildRelease({sourceRoot:path.resolve(process.argv[2]),imageDir:path.resolve(process.argv[3]),output:path.resolve(process.argv[4])})));}catch{console.error('PRESENTATION_BUILD_REFUSED');process.exitCode=1;}}
module.exports={buildRelease};
