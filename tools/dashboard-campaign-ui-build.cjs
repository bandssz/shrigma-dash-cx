'use strict';
// Generate versioned portal assets at development/CI time only. The container
// verifies these bytes and copies them without loading a minifier or npm.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ESBUILD_VERSION='0.28.2';
const ASSETS=Object.freeze([
 Object.freeze({source:'crm-campaign-bff-client.cjs',compiled:'public/campaign-bff-client.js',publicName:'campaign-bff-client.js'}),
 Object.freeze({source:'public/campaign-edit.js',compiled:'public/campaign-edit.compiled.js',publicName:'campaign-edit.js'}),
 Object.freeze({source:'public/entry.js',compiled:'public/entry.compiled.js',publicName:'entry.js'}),
 Object.freeze({source:'public/guard.js',compiled:'public/guard.compiled.js',publicName:'guard.js'})
]);
const defaultRoot=path.resolve(__dirname,'../services/dashboard-operational');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function read(file){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid campaign UI input');return fs.readFileSync(file);}
function buildCampaignUi({root=defaultRoot,check=false}={}){
 const esbuild=require('./campaign-runtime-build/node_modules/esbuild');
 if(esbuild.version!==ESBUILD_VERSION)throw Error('Campaign UI compiler version mismatch');
 const generated=ASSETS.map(asset=>{const input=read(path.join(root,asset.source));const code=esbuild.transformSync('(function(){\n'+input.toString('utf8')+'\n})();\n',{loader:'js',target:'es2022',minify:true,legalComments:'none',charset:'utf8'}).code;return {...asset,sourceSha256:sha(input),compiledSha256:sha(code),code};});
 const manifest={schema:'shrigma_campaign_ui_assets_v1',esbuildVersion:ESBUILD_VERSION,assets:generated.map(({code,...asset})=>asset)};
 const files=generated.map(a=>({file:path.join(root,a.compiled),bytes:Buffer.from(a.code)}));
 files.push({file:path.join(root,'campaign-ui-assets.json'),bytes:Buffer.from(JSON.stringify(manifest,null,2)+'\n')});
 if(check){for(const {file,bytes}of files)if(!read(file).equals(bytes))throw Error('Campaign UI assets need regeneration');}
 else{for(const {file,bytes}of files){if(fs.existsSync(file))read(file);fs.writeFileSync(file,bytes);}}
 return Object.freeze({check,assets:ASSETS.length,esbuildVersion:ESBUILD_VERSION});
}
if(require.main===module){try{if(process.argv.slice(2).some(a=>a!=='--check'))throw Error();console.log(JSON.stringify(buildCampaignUi({check:process.argv.includes('--check')})));}catch{console.error('Campaign UI asset build refused');process.exitCode=1;}}
module.exports={buildCampaignUi};
