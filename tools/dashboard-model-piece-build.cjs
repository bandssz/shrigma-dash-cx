'use strict';
// One validator in the browser and server; no runtime compiler/dependency.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../services/dashboard-operational');
function build({check=false}={}){
 const esbuild=require('./campaign-runtime-build/node_modules/esbuild');
 if(esbuild.version!=='0.28.2')throw Error('MODEL_PIECE_COMPILER_VERSION');
 const out=esbuild.buildSync({entryPoints:[path.join(root,'public/crm-preview/model-piece-input.js')],bundle:true,platform:'node',format:'cjs',target:'node22',minify:true,charset:'utf8',legalComments:'none',write:false}).outputFiles[0].contents;
 const file=path.join(root,'model-piece-input.cjs');
 if(check){if(!fs.readFileSync(file).equals(Buffer.from(out)))throw Error('MODEL_PIECE_BUILD_CHANGED');}
 else fs.writeFileSync(file,out);
 return {check,bytes:out.length};
}
if(require.main===module){try{console.log(JSON.stringify(build({check:process.argv.includes('--check')})));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={build};
