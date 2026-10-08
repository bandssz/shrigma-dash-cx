'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const PARENT='ghcr.io/bandssz/shrigma-dash-crm-presentation-v2@sha256:1adba1fb8a222684b300ed49fbb2f0adf681bd24ab679022eb15c765328f4911';
const BASE_PACK='c80ee2a8f2611b9cb17a5d24b9b1668a7fe4218a2a95e73cb706e5b6682980da';
const ADDITIONS=['crm-native-delegation.cjs','crm-native-mcp.cjs','crm-native-operator.cjs','native-continuity/read-only.cjs','native-continuity/pins.json','native-database-vault.cjs','native-database-operator.cjs','native-database-inventory.cjs','native-pg-driver.cjs','native-foundation-preview.cjs','own-foundation/foundation.cjs','own-foundation/manifest.json','own-foundation/sql.cjs','own-foundation/bootstrap-v1.sql','crm-journey-read.cjs','crm-published-journey-read.cjs','crm-master-template-read.cjs','journey-read/growth-flows.js','crm-master-audience-read.cjs','crm-master-audience-count.cjs','segment-audience-context-review.cjs','segment-audience-review.cjs','native-source-sync.cjs','native-source-operator.cjs','native-source-transport.cjs','crm-presentation.css','native-source-diagnostics.cjs','native-source-diagnostics-controller.cjs','native-source-diagnostics-ui.cjs'];
const REPLACEMENTS=['auth.cjs','server.cjs','proxy.cjs'];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function build(sourceRoot,imageRoot,output,revision){
 if(!/^[a-f0-9]{40}$/.test(revision)||fs.existsSync(output))throw Error('NATIVE_BUILD_REFUSED');
 const read=p=>{const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size<1||s.size>2*1024*1024)throw Error('NATIVE_BUILD_REFUSED');return fs.readFileSync(p);};
 const old=require(path.join(imageRoot,'artifact-policy.cjs')).decodePack(read(path.join(imageRoot,'runtime-pack.json')).toString(),BASE_PACK);
 const base=old.files.filter(f=>f.path.startsWith('runtime/')).map(f=>({name:f.path.slice(8),bytes:Buffer.from(f.content,f.encoding)}));
 if(base.length!==28)throw Error('NATIVE_BUILD_REFUSED');
 const tree=new Map(base.map(f=>[f.name,f.bytes])),baseRuntime=base.map(f=>({path:f.name,sha256:sha(f.bytes),bytes:f.bytes.length})).sort((a,b)=>a.path.localeCompare(b.path));
 for(const name of REPLACEMENTS){const b=read(path.join(sourceRoot,'services/dashboard-operational',name));if(b.equals(tree.get(name)))throw Error('NATIVE_BUILD_REFUSED');tree.set(name,b);}
 for(const name of ADDITIONS){if(tree.has(name))throw Error('NATIVE_BUILD_REFUSED');tree.set(name,read(path.join(sourceRoot,'services/dashboard-operational',name)));}
 fs.mkdirSync(path.join(output,'runtime'),{recursive:true,mode:0o755});
 const files=[];
 for(const [name,b]of [...tree].sort(([a],[b])=>a.localeCompare(b))){fs.mkdirSync(path.dirname(path.join(output,'runtime',name)),{recursive:true,mode:0o755});fs.writeFileSync(path.join(output,'runtime',name),b,{mode:0o444,flag:'wx'});files.push({path:'runtime/'+name,bytes:b.length,sha256:sha(b)});}
 for(const name of ['bootstrap.cjs','start-existing.cjs','health-existing.cjs']){const b=read(path.join(sourceRoot,'ops/releases/crm-native-connection-20261007',name));fs.writeFileSync(path.join(output,name),b,{mode:0o444,flag:'wx'});files.push({path:name,bytes:b.length,sha256:sha(b)});}
 const driver=require(path.join(sourceRoot,'tools/native-pg-dependency/build-driver.cjs')).build(path.join(sourceRoot,'tools/native-pg-dependency'),output+'-pg-driver');
 const presentation=require('./build-journey-presentation.cjs').buildJourneyPresentation(sourceRoot,imageRoot,output+'-presentation');
 const manifest={presentationManifestSha256:presentation.manifestSha256,presentationChangedPaths:presentation.changed.map(f=>f.path),schema:'shrigma-native-backend-release-v2',pgDriverManifestSha256:driver.pgDriverManifestSha256,databaseInspectionEnabled:true,sourceRevision:revision,parentImage:PARENT,basePackSha256:BASE_PACK,baseRuntime,replacements:REPLACEMENTS,additions:ADDITIONS,files:files.sort((a,b)=>a.path.localeCompare(b.path)),identityDatabase:'/dashboard-data/dashboard.sqlite',originalPackPreserved:true,historicalActivationReplayed:false,sqlInstallerEnabled:false,operational:false};
 const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(path.join(output,'manifest.json'),bytes,{mode:0o444,flag:'wx'});fs.chmodSync(path.join(output,'runtime/native-continuity'),0o555);fs.chmodSync(path.join(output,'runtime/own-foundation'),0o555);fs.chmodSync(path.join(output,'runtime/journey-read'),0o555);fs.chmodSync(path.join(output,'runtime'),0o555);fs.chmodSync(output,0o555);
 return {manifestSha256:sha(bytes),presentation,sourceRevision:revision,runtimeFiles:tree.size,originalRuntimePreserved:25,runtimeReplacements:3,runtimeAdditions:ADDITIONS.length,pgDriverManifestSha256:driver.pgDriverManifestSha256,databaseInspectionEnabled:true,sqlInstallerEnabled:false,operational:false};
}
if(require.main===module)console.log(JSON.stringify(build(...process.argv.slice(2))));
module.exports={build,PARENT,BASE_PACK,ADDITIONS,REPLACEMENTS};
