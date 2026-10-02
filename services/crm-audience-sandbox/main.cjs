'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createSandbox,PUBLIC_ORIGIN}=require('./factory.cjs');
const DATA='/sandbox-data';
// An image-layer directory is ephemeral. Require the operator's dedicated
// mounted volume before creating a database or synthetic credential.
function mounted(directory){
 const target=path.resolve(directory);
 return fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').some(line=>line.split(' - ')[0]?.split(' ')[4]===target);
}
async function main(){
 if(!mounted(DATA))throw Error('CRM_SANDBOX_VOLUME_REQUIRED');
 const owner=process.env.SANDBOX_OWNER_EMAIL;
 const revision=process.env.SANDBOX_SOURCE_REVISION;
 const origin=process.env.SANDBOX_PUBLIC_ORIGIN;
 const port=Number(process.env.PORT||8080);
 if(origin!==PUBLIC_ORIGIN||!Number.isSafeInteger(port)||port<1||port>65535)throw Error('CRM_SANDBOX_CONFIG');
 const sandbox=await createSandbox({root:DATA,owner,publicOrigin:origin,revision,credentials:{reader:process.env.SANDBOX_READ_BEARER,writer:process.env.SANDBOX_WRITER_BEARER}});
 await new Promise((resolve,reject)=>sandbox.server.listen(port,'0.0.0.0',error=>error?reject(error):resolve()));
 // No timer, worker, scheduler, external fetch or secret in the startup log.
 process.stdout.write(JSON.stringify({service:'crm-audience-sandbox',ready:true,sourceRevision:revision})+'\n');
 let stopping=false;
 const stop=async()=>{if(stopping)return;stopping=true;await sandbox.close();};
 process.on('SIGTERM',()=>stop().then(()=>process.exit(0),()=>process.exit(1)));
 process.on('SIGINT',()=>stop().then(()=>process.exit(0),()=>process.exit(1)));
}
main().catch(()=>{process.stderr.write('CRM_SANDBOX_START_FAILED\n');process.exitCode=1;});
