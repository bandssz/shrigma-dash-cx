'use strict';
const fs=require('node:fs'),path=require('node:path'),G=require('./source-gate.cjs');
function materialize({corpus,runnerTemp,output}){try{
 // Complete authentication precedes the first mkdir or file write.
 const records=G.validateCorpus(corpus);G.physical(runnerTemp,false);
 if(typeof output!=='string'||!path.isAbsolute(output)||path.resolve(output)!==output||path.dirname(output)!==runnerTemp||!/^crm-public-context-[a-z0-9-]+$/.test(path.basename(output)))throw Error();
 try{fs.lstatSync(output);throw Error();}catch(e){if(e.code!=='ENOENT')throw Error();}
 fs.mkdirSync(output,{mode:0o700});G.physical(output,false);
 for(const [relative,bytes] of records){let parent=output;for(const part of relative.split('/').slice(0,-1)){parent=path.join(parent,part);try{fs.mkdirSync(parent,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw Error();}G.physical(parent,false);}const target=path.join(output,relative);fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});G.physical(target);if(!fs.readFileSync(target).equals(bytes))throw Error();}
 return Object.freeze({records:17,frozenFiles:14,sourceOnly:true,operational:false});
 }catch{throw Object.assign(new Error('CRM_CONTEXT_MATERIALIZATION_REFUSED'),{code:'CRM_CONTEXT_MATERIALIZATION_REFUSED'});}}
module.exports=Object.freeze({materialize});
if(require.main===module){try{G.physical(path.resolve(__dirname,'public-context.json'));console.log(JSON.stringify({code:'CRM_CONTEXT_MATERIALIZED',...materialize({corpus:fs.readFileSync(path.join(__dirname,'public-context.json')),runnerTemp:process.env.RUNNER_TEMP,output:process.env.CRM_PERSISTENCE_CONTEXT_DIRECTORY})}));}catch{console.error(JSON.stringify({code:'CRM_CONTEXT_MATERIALIZATION_REFUSED',operational:false}));process.exitCode=1;}}
