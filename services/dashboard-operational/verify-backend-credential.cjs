'use strict';
/**
 * Private operator CLI. The shared direct identity validator is also used by
 * the portal for the dedicated crm-panel-read slot. This CLI never prints a
 * bearer, backend response, owner label or internal error.
 */
const fs=require('node:fs');
const attestation=require('./backend-credential-attestation.cjs');
const MAX_INPUT_BYTES=1024;
const refuse=()=>{throw Error('CREDENTIAL_VERIFICATION_REFUSED');};

async function readPrivateStdin(stream=process.stdin){
 if(stream.isTTY)refuse();
 const stat=fs.fstatSync(0);
 if(stat.isFile()&&((stat.mode&0o077)!==0||typeof process.getuid==='function'&&stat.uid!==process.getuid()))refuse();
 const chunks=[];let bytes=0;
 for await(const chunk of stream){bytes+=chunk.length;if(bytes>MAX_INPUT_BYTES)refuse();chunks.push(chunk);}
 if(bytes===0)refuse();
 let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{refuse();}
 return input;
}

async function cli(){
 try{
  if(process.argv.length!==2)refuse();
  const result=await attestation.verifyCredential(await readPrivateStdin());
  process.stdout.write(JSON.stringify(result)+'\n');
 }catch{
  process.stderr.write('Backend credential verification refused.\n');
  process.exitCode=1;
 }
}
if(require.main===module)cli();
module.exports={...attestation,MAX_INPUT_BYTES,readPrivateStdin};
