'use strict';
// Two reviewed public replacements over the exact existing presentation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const FILES=['assets/panels/growth.js','growth.html'];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const refuse=()=>{throw Error('JOURNEY_PRESENTATION_BUILD_REFUSED');};
function read(p){const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size<1||s.size>2*1024*1024)refuse();return fs.readFileSync(p);}
function buildJourneyPresentation(sourceRoot,imageRoot,output){
 if(fs.existsSync(output))refuse();
 const releaseDir=path.join(imageRoot,'presentation-release'),previousRaw=read(path.join(releaseDir,'manifest.json')),previous=JSON.parse(previousRaw);
 const release=require(path.join(releaseDir,'release.cjs'));
 if(previous.schema!=='crm-presentation-release-v2'||previous.baseImageDigest!==release.BASE_IMAGE||previous.baseSourceRevision!==release.BASE_SOURCE||previous.basePackSha256!==release.BASE_PACK||JSON.stringify(previous.files.map(f=>f.path))!==JSON.stringify(release.FILES))refuse();
 // Verify every inherited payload before changing the two explicit paths.
 for(const f of previous.files){const b=read(path.join(releaseDir,'public',f.path));if(sha(b)!==f.afterSha256||b.length!==f.afterBytes)refuse();}
 const transform=require(path.join(sourceRoot,'services/dashboard-operational/build.cjs')).transform;
 const next=JSON.parse(JSON.stringify(previous)),changed=[];
 for(const file of FILES){const source=read(path.join(sourceRoot,file)).toString('utf8'),after=Buffer.from(transform(source,file));
  if(file==='growth.html'&&(!after.includes('configuredReadOnly:true')||after.includes('observedOnly:true')||!after.includes('conexões originais')))refuse();
  if(file.endsWith('.js')&&(!after.includes('configuredReadOnly')||/\bGMedia\b/.test(after)))refuse();
  const f=next.files.find(f=>f.path===file),before=previous.files.find(f=>f.path===file);if(!f||sha(after)===before.afterSha256||after.length<1||after.length>2*1024*1024)refuse();
  f.afterSha256=sha(after);f.afterBytes=after.length;changed.push({path:file,beforeSha256:before.afterSha256,afterSha256:f.afterSha256,bytes:after.length});
  const dest=path.join(output,'public',file);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o755});fs.writeFileSync(dest,after,{flag:'wx',mode:0o444});
 }
 const raw=Buffer.from(JSON.stringify(next,null,2)+'\n');fs.writeFileSync(path.join(output,'manifest.json'),raw,{flag:'wx',mode:0o444});
 const protect=dir=>{for(const n of fs.readdirSync(dir)){const p=path.join(dir,n);if(fs.lstatSync(p).isDirectory())protect(p);else fs.chmodSync(p,0o444);}fs.chmodSync(dir,0o555);};protect(output);
 return {schema:'shrigma-journey-presentation-composition-v1',manifestSha256:sha(raw),previousManifestSha256:sha(previousRaw),changed,publicPathsAdded:0,identityChanged:false,operational:false};
}
module.exports={buildJourneyPresentation,FILES};
