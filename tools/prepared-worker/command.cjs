'use strict';
// Prepared commands share the attested native runtime; this worker executes no jobs.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const ROOT='/app/prepared-worker',H=/^[a-f0-9]{64}$/,PORT=8081,sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const refuse=()=>{throw Error('PREPARED_PROCESS_REFUSED');};
function read(name){if(!['command.cjs','queue.sql','manifest.json'].includes(name))refuse();const p=path.join(ROOT,name),s=fs.lstatSync(p);if(fs.realpathSync(p)!==p||!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==0||s.gid!==0||(s.mode&0o777)!==0o444||s.size<1||s.size>128*1024)refuse();const b=fs.readFileSync(p),after=fs.lstatSync(p);if(b.length!==s.size||['dev','ino','size','mtimeMs','ctimeMs'].some(k=>s[k]!==after[k]))refuse();return b;}
function verify(){
 const d=fs.lstatSync(ROOT);if(fs.realpathSync(ROOT)!==ROOT||!d.isDirectory()||d.isSymbolicLink()||d.uid!==0||d.gid!==0||(d.mode&0o777)!==0o555||fs.readdirSync(ROOT).sort().join(',')!=='command.cjs,manifest.json,queue.sql')refuse();
 const bytes=read('manifest.json'),m=JSON.parse(bytes);if(Object.keys(m).sort().join(',')!=='files,nativeManifestSha256,pgDriverManifestSha256,queue,schema,sourceRevision,worker'||m.schema!=='shrigma-prepared-processes-v1'||!/^[a-f0-9]{40}$/.test(m.sourceRevision||'')||!H.test(m.nativeManifestSha256||'')||!H.test(m.pgDriverManifestSha256||'')||JSON.stringify(m.worker)!=='{"state":"prepared","executionEnabled":false,"handlers":0,"databaseConnected":false,"queueSchemaApplied":false}'||JSON.stringify(m.queue)!=='{"schema":"shrigma_worker","table":"tasks","attemptsTable":"attempts","databaseBinding":null,"automaticInstallation":false}'||!Array.isArray(m.files)||m.files.length!==2||m.files.map(f=>f.path).join(',')!=='command.cjs,queue.sql')refuse();
 for(const f of m.files){if(Object.keys(f).sort().join(',')!=='bytes,path,sha256'||!H.test(f.sha256||'')||!Number.isSafeInteger(f.bytes))refuse();const b=read(f.path);if(b.length!==f.bytes||sha(b)!==f.sha256)refuse();}
 const native=require('/app/native-backend/bootstrap.cjs').verifyRelease(m.nativeManifestSha256);if(native.sourceRevision!==m.sourceRevision||native.pgDriverManifestSha256!==m.pgDriverManifestSha256)refuse();
 return{manifest:m,manifestSha256:sha(bytes),native};
}
function role(expected){const actual=process.env.SHRIGMA_PROCESS_ROLE||'api';if(!['api','worker'].includes(actual)||expected&&actual!==expected)refuse();return actual;}
function disabled(){if(process.env.SHRIGMA_WORKER_EXECUTION!==undefined&&process.env.SHRIGMA_WORKER_EXECUTION!=='disabled')refuse();}
function status(verified){return{schema:'shrigma-prepared-worker-health-v1',ok:true,role:'worker',state:'prepared',sourceRevision:verified.manifest.sourceRevision,manifestSha256:verified.manifestSha256,nativeManifestSha256:verified.manifest.nativeManifestSha256,pgDriverManifestSha256:verified.manifest.pgDriverManifestSha256,executionEnabled:false,handlers:0,databaseConnected:false,queueSchemaApplied:false};}
async function startApi(){role('api');const v=verify();return require('/app/native-backend/start-existing.cjs').startExisting({manifestSha256:v.manifest.nativeManifestSha256});}
async function healthApi(){role('api');const v=verify();return require('/app/native-backend/health-existing.cjs').healthExisting({manifestSha256:v.manifest.nativeManifestSha256});}
async function startWorker(){
 role('worker');disabled();const v=verify(),body=JSON.stringify(status(v));
 const server=http.createServer((req,res)=>{if(req.method!=='GET'||req.url!=='/healthz'){res.writeHead(404,{'Content-Type':'application/json','Connection':'close'});res.end('{"ok":false}');return;}res.writeHead(200,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store','Connection':'close'});res.end(body);});
 server.requestTimeout=2000;server.headersTimeout=2000;server.maxHeadersCount=20;await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(PORT,'127.0.0.1',resolve);});
 const stop=()=>server.close(()=>{process.exitCode=0;});process.once('SIGTERM',stop);process.once('SIGINT',stop);server.once('close',()=>{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);});return{server,status:status(v)};
}
async function healthWorker(){
 role('worker');disabled();const v=verify(),body=await new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port:PORT,path:'/healthz',agent:false,headers:{Accept:'application/json',Connection:'close'}},res=>{let size=0;const chunks=[];res.on('data',b=>{size+=b.length;if(size>4096)req.destroy(Error('PREPARED_HEALTH_REFUSED'));else chunks.push(b);});res.on('error',reject);res.on('end',()=>{try{if(res.statusCode!==200)refuse();resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch{reject(Error('PREPARED_HEALTH_REFUSED'));}});});req.setTimeout(1500,()=>req.destroy(Error('PREPARED_HEALTH_REFUSED')));req.on('error',reject);});
 if(JSON.stringify(body)!==JSON.stringify(status(v)))refuse();return body;
}
async function command(value){if(value==='verify'){const v=verify();return{ok:true,schema:v.manifest.schema,sourceRevision:v.manifest.sourceRevision,manifestSha256:v.manifestSha256,nativeManifestSha256:v.manifest.nativeManifestSha256,pgDriverManifestSha256:v.manifest.pgDriverManifestSha256,executionEnabled:false,handlers:0,databaseConnected:false,queueSchemaApplied:false};}if(value==='start')value=role();if(value==='health')value='health-'+role();if(value==='api'){await startApi();return{ok:true,role:'api',state:'started'};}if(value==='worker')return(await startWorker()).status;if(value==='health-api')return healthApi();if(value==='health-worker')return healthWorker();refuse();}
if(require.main===module)command(process.argv[2]).then(value=>{if(value&&typeof value==='object'&&!value.server)console.log(JSON.stringify(value));},()=>{console.error(JSON.stringify({ok:false,code:'PREPARED_PROCESS_REFUSED'}));process.exitCode=1;});
module.exports=Object.freeze({verify,role,startApi,healthApi,startWorker,healthWorker,command,ROOT,PORT});
