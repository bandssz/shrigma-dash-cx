'use strict';
const http=require('node:http');
const N=require('./bootstrap.cjs'),P=require('/app/presentation-release/release.cjs');
async function healthExisting({manifestSha256,imageDigest}={}){
 const manifest=N.verifyRelease(manifestSha256);
  const native=N.verifyReady({manifestSha256}),presentation=P.verifyReady();
  if(native.runtimeFiles!==manifest.baseRuntime.length+manifest.additions.length||native.sourceRevision!==manifest.sourceRevision||presentation.runtimeFilesUnchanged!==28||presentation.manifestSha256!==manifest.presentationManifestSha256)throw Error('NATIVE_HEALTH_REFUSED');
  const host=process.env.DASHBOARD_MANAGER_HOST;
  if(typeof host!=='string'||!/^[a-z0-9.-]{1,253}$/.test(host))throw Error('NATIVE_HEALTH_REFUSED');
  const body=await new Promise((resolve,reject)=>{
   const r=http.request({host:'127.0.0.1',port:8080,path:'/healthz',agent:false,headers:{Host:host,Accept:'application/json'}},res=>{
    let size=0;const chunks=[];res.on('data',b=>{size+=b.length;if(size>16384)r.destroy(Error('NATIVE_HEALTH_REFUSED'));else chunks.push(b);});res.on('error',reject);
    res.on('end',()=>{try{if(res.statusCode!==200)throw Error();resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch{reject(Error('NATIVE_HEALTH_REFUSED'));}});
   });r.on('error',reject);r.setTimeout(1500,()=>r.destroy(Error('NATIVE_HEALTH_REFUSED')));r.end();
  });
  if(body.nativeMcp!==true||body.nativeBackendManifestSha256!==manifestSha256)throw Error('NATIVE_HEALTH_REFUSED');
  return {schema:'shrigma-native-existing-health-v1',ok:true,sqliteOpened:false,grantAdmission:false,historicalInvocations:0,historicalReceiptWrites:0,operational:false};
}
if(require.main===module)healthExisting({manifestSha256:process.argv[2],imageDigest:process.argv[3]}).then(r=>console.log(JSON.stringify(r)),()=>{console.error('NATIVE_EXISTING_HEALTH_REFUSED');process.exitCode=1;});
module.exports={healthExisting};
