'use strict';
// Root CI input mapping only. Reuses the exact public context already in PR242;
// never executes an old harness/materializer or supplies production authority.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const pins=require('./pins.json'),P=require('./prepare.cjs'),root=fs.realpathSync(process.cwd());
const fail=()=>{throw Error('FACTS_NATIVE_INPUT_REFUSED');};
function verified(bytes,pin){if(bytes.length!==pin.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==pin.sha256||crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')!==pin.gitBlobSha1)fail();return bytes;}
function source(relative,pin){const p=path.resolve(root,relative);if(!p.startsWith(root+path.sep))fail();P.physical(p,true);return verified(fs.readFileSync(p),pin);}
function stage(relative,bytes){const p=path.resolve(root,relative);if(!p.startsWith(root+path.sep)||path.normalize(relative)!==relative)fail();fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});P.physical(path.dirname(p));fs.writeFileSync(p,bytes,{flag:'wx',mode:0o600});P.physical(p,true);if(!fs.readFileSync(p).equals(bytes))fail();}
function run(){
 const contextPath='tools/dashboard-crm-mvp-controls-persistence/public-context.json';
 // Its record pins must all agree with the already closed producer pins before any write.
 const contextFile=path.resolve(root,contextPath);P.physical(contextFile,true);const context=JSON.parse(fs.readFileSync(contextFile,'utf8'));if(context.schema!=='crm-mvp-persistence-public-context-corpus-v1')fail();if(!Array.isArray(context.records))fail();
 const wanted=[{...pins.contextManifest,relativePath:'CONTEXT-MANIFEST.json'},...pins.context],entries=[];
 for(const pin of wanted){const matches=context.records.filter(r=>r.path===pin.relativePath);if(matches.length!==1)fail();const r=matches[0];if(r.bytes!==pin.bytes||r.sha256!==pin.sha256||r.gitBlobSha1!==pin.gitBlobSha1||typeof r.data!=='string')fail();entries.push([pin.path,verified(Buffer.from(r.data,'base64'),pin)]);}
 entries.push([pins.factsDelivery.path,source('tools/dashboard-crm-control-facts-pg17/facts-delivery.json',pins.factsDelivery)]);
 for(const pin of pins.facts)entries.push([pin.path,source(pin.repoPath,pin)]);
 entries.push([pins.originalSchema.path,source('services/dashboard-operational/domain/crm-mvp-controls-persistence/schema-v1.sql',pins.originalSchema)]);
 entries.push([pins.custodyReference.path,source('tools/dashboard-crm-mvp-controls-borrowed-pg17/root-ci-fixture.cjs',pins.custodyReference)]);
 for(const [relative,bytes] of entries)stage(relative,bytes);P.verifyInputs(root);
 console.log(JSON.stringify({code:'FACTS_EXISTING_INPUTS_STAGED',facts:8,context:14,oldHarnessExecuted:false,newContextCarrier:false,sourceOnly:true,operational:false}));
}
if(require.main===module){try{run();}catch{console.error('FACTS_NATIVE_INPUT_REFUSED');process.exitCode=1;}}
module.exports=Object.freeze({run});
