'use strict';
const net=require('node:net'),fs=require('node:fs'),path=require('node:path');
const {socketPath,RESOURCE}=require('./native-worker-vault.cjs');
const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,SCRAM=/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/;
const exact=(x,keys)=>!!x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).sort().join()===keys.slice().sort().join();
function fail(code){throw Error(code);}
function request(dbPath,q,after){
 return new Promise((resolve,reject)=>{
  const file=socketPath(dbPath),s=fs.lstatSync(file),dir=path.dirname(file),d=fs.lstatSync(dir);
  if(!s.isSocket()||s.uid!==1000||(s.mode&0o777)!==0o600||!d.isDirectory()||d.isSymbolicLink()||d.uid!==1000||(d.mode&0o777)!==0o700||fs.realpathSync(dir)!==dir)fail('WV_PRIVATE_ENDPOINT');
  const socket=net.createConnection(file);let buffer='',stage=0,done=false;
  const stop=(error,result)=>{if(done)return;done=true;socket.destroy();error?reject(error):resolve(result);};
  socket.setTimeout(10000,()=>stop(Error('WV_CLIENT_TIMEOUT')));
  socket.on('error',()=>stop(Error('WV_CLIENT_UNAVAILABLE')));
  socket.on('connect',()=>socket.write(JSON.stringify(q)+'\n'));
  socket.on('data',chunk=>{
   buffer+=chunk.toString('utf8');if(Buffer.byteLength(buffer)>16384){stop(Error('WV_CLIENT_RESPONSE'));return;}
   const end=buffer.indexOf('\n');if(end<0)return;
   try{
    const v=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
    if(buffer||!v||typeof v.ok!=='boolean')fail('WV_CLIENT_RESPONSE');
    if(!v.ok)fail(/^WV_[A-Z0-9_]+$/.test(v.code||'')?v.code:'WV_CLIENT_REFUSED');
    if(after&&stage++===0)socket.write(JSON.stringify(after(v.result))+'\n');
    else stop(null,v.result);
   }catch(e){stop(Error(/^WV_[A-Z0-9_]+$/.test(e.message||'')?e.message:'WV_CLIENT_RESPONSE'));}
  });
  socket.on('close',()=>{if(!done)stop(Error('WV_CLIENT_ACK_UNCERTAIN'));});
 });
}
async function privateOperation(dbPath,input){
 if(!exact(input,['action','expectedManifest','expectedBundleRevision','operationId'])||!['generate','verifiers','probe','revoke'].includes(input.action)||!HASH.test(input.expectedManifest||'')||!Number.isSafeInteger(input.expectedBundleRevision)||input.expectedBundleRevision<0||!UUID.test(input.operationId||''))fail('WV_CLIENT_INPUT');
 const result=await request(dbPath,{action:'challenge',operation:input.action,operationId:input.operationId,expectedManifest:input.expectedManifest,expectedBundleRevision:input.expectedBundleRevision},c=>{
  if(!exact(c,['nonce','operationId','manifest','bundleRevision','expiresInMs'])||!HASH.test(c.nonce||'')||c.manifest!==input.expectedManifest||c.operationId!==input.operationId||c.bundleRevision!==input.expectedBundleRevision||c.expiresInMs!==30000)fail('WV_CLIENT_BINDING');
  return{action:input.action,nonce:c.nonce};
 });
 const expected=input.expectedBundleRevision+(['generate','revoke'].includes(input.action)?1:0);
 if(!result||result.operationId!==input.operationId||result.bundleRevision!==expected)fail('WV_CLIENT_BINDING');
 if(input.action==='verifiers'){
  if(!exact(result,['private','manifest','operationId','bundleRevision','verifiers'])||result.private!==true||result.manifest!==input.expectedManifest||!exact(result.verifiers,['crm_api','crm_worker'])||!SCRAM.test(result.verifiers.crm_api||'')||!SCRAM.test(result.verifiers.crm_worker||''))fail('WV_CLIENT_BINDING');
 }else if(input.action==='probe'){
  if(result.schema!=='crm-worker-vault-pg-proof-v1'||result.manifest!==input.expectedManifest||!Array.isArray(result.results)||result.results.length!==2||result.workerEnabled!==false||result.jobsEnabled!==false)fail('WV_CLIENT_BINDING');
 }else{
  if(result.schema!=='crm-worker-vault-receipt-v1'||result.purpose!=='crm-worker-queue-v1'||!exact(result.resource,Object.keys(RESOURCE))||Object.keys(RESOURCE).some(k=>result.resource[k]!==RESOURCE[k])||result.passwordsExported!==false||result.workerEnabled!==false||result.jobsEnabled!==false||!exact(result.slots,['producer','executor'])||Object.values(result.slots).some(s=>s.linked!==(input.action==='generate')))fail('WV_CLIENT_BINDING');
 }
 return result;
}
// An inherited anonymous pipe or socketpair is mandatory. This validates the
// transport shape, not the parent: only the authorized host orchestrator may
// consume FD3. stdout/stderr always remain metadata-only.
function privateDescriptors(){
 const fds=[0,1,2,3].map(n=>fs.fstatSync(n));
 if(process.stdin.isTTY||process.stdout.isTTY||!fds.every(s=>s.isFIFO()||s.isSocket())||fds.slice(0,3).some(s=>s.dev===fds[3].dev&&s.ino===fds[3].ino))fail('WV_PRIVATE_PIPE_REQUIRED');
}
async function main(){
 const mode=process.argv[2],dbPath=require('/app/bootstrap.cjs').DB_FILE;
 if(process.env.DASHBOARD_DB_PATH&&process.env.DASHBOARD_DB_PATH!==dbPath)fail('WV_RESOURCE_MISMATCH');
 if(!dbPath||!['--status','--receipt','--private-pipe'].includes(mode))fail('WV_CLIENT_MODE');
 if(mode==='--status'){process.stdout.write(JSON.stringify(await request(dbPath,{action:'status'}))+'\n');return;}
 if(mode==='--receipt'){process.stdout.write(JSON.stringify(await request(dbPath,{action:'receipt',operationId:process.argv[3]}))+'\n');return;}
 try{privateDescriptors();}catch{fail('WV_PRIVATE_PIPE_REQUIRED');}
 let body='';for await(const c of process.stdin){body+=c;if(Buffer.byteLength(body)>4096)fail('WV_CLIENT_INPUT');}
 let input;try{input=JSON.parse(body);}catch{fail('WV_CLIENT_INPUT');}body='';
 const result=await privateOperation(dbPath,input);
 if(input.action==='verifiers'){
  const privateBytes=Buffer.from(JSON.stringify(result)+'\n');try{let offset=0;while(offset<privateBytes.length){const count=fs.writeSync(3,privateBytes,offset,privateBytes.length-offset);if(count<=0)fail('WV_PRIVATE_DELIVERY_UNCERTAIN');offset+=count;}}finally{privateBytes.fill(0);}
  process.stdout.write(JSON.stringify({schema:'crm-worker-vault-cli-v1',ok:true,action:input.action,operationId:input.operationId,manifest:input.expectedManifest,bundleRevision:result.bundleRevision,privateDelivered:true})+'\n');
 }else process.stdout.write(JSON.stringify(result)+'\n');
}
if(require.main===module)main().catch(e=>{const code=/^WV_[A-Z0-9_]+$/.test(e.message||'')?e.message:'WV_CLIENT_REFUSED';process.stderr.write(JSON.stringify({ok:false,code})+'\n');process.exitCode=1;});
module.exports=Object.freeze({request,privateOperation,privateDescriptors});
