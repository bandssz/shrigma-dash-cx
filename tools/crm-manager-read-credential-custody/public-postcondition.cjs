'use strict';
// Public inline observer only. No env, filesystem, socket or runtime on import.
const crypto=require('node:crypto');
const R=require('./remote-operator.cjs');
const C=require('../crm-manager-read-activation-review/compose/build-compose.cjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),copy=x=>JSON.parse(JSON.stringify(x));
function fail(){throw Error('READ_PUBLIC_POSTCONDITION_REFUSED');}
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function exact(v,keys){if(!v||Object.getPrototypeOf(v)!==Object.prototype)fail();const own=Reflect.ownKeys(v);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))fail();for(const k of own){const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail();}}
function observerRuntime(EXPECTED,PINS){
 const fs=require('node:fs'),crypto=require('node:crypto'),http=require('node:http'),reject=()=>{throw 0;};
 function verify(){
  if(process.getuid()!==1000||process.getgid()!==1000||!process.versions.node.startsWith('22.'))reject();
  for(const n of Object.keys(process.env))if(n.startsWith('PG')||n.startsWith('READ_'))reject();
  const status=new Map(fs.readFileSync('/proc/self/status','utf8').split('\n').filter(x=>x.includes(':')).map(x=>{const i=x.indexOf(':');return[x.slice(0,i),x.slice(i+1).trim()];}));
  if(status.get('NoNewPrivs')!=='1'||['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].some(k=>status.get(k)!=='0000000000000000'))reject();
  const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').map(x=>x.split(' ')),mount=p=>mounts.filter(x=>x[4]===p),opts=p=>{const m=mount(p);if(m.length!==1)reject();return m[0][5].split(',');};
  if(!opts('/').includes('ro')||!opts('/review').includes('ro')||!opts('/runtime-proof').includes('rw'))reject();
  const directories=[['/review',0,0,0o555],['/runtime-proof',1000,1000,0o700]];
  const stats=directories.map(([p,uid,gid,mode])=>{const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||s.gid!==gid||(s.mode&0o7777)!==mode||fs.realpathSync(p)!==p)reject();return s;});
  if(stats[0].dev===stats[1].dev&&stats[0].ino===stats[1].ino)reject();
  if(JSON.stringify(fs.readdirSync('/review').sort())!==JSON.stringify(Object.keys(PINS).sort()))reject();
  for(const[name,pin]of Object.entries(PINS)){
   const p='/review/'+name,s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||s.nlink!==1||(s.mode&0o7777)!==0o444||s.size<1||s.size>20000||crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==pin)reject();
  }
  for(const p of ['/review/public-write-refused','/public-root-write-refused']){
   let denied=false,fd;try{fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);}catch(e){denied=e?.code==='EROFS'||e?.code==='EACCES';}finally{if(fd!==undefined)fs.closeSync(fd);}if(!denied)reject();
  }
  const names=fs.readdirSync('/runtime-proof').sort();
  if(EXPECTED.mode==='execute'){if(names.length)reject();}
  else{
   if(JSON.stringify(names)!==JSON.stringify([EXPECTED.intent.operationId]))reject();
   const dir='/runtime-proof/'+EXPECTED.intent.operationId,ds=fs.lstatSync(dir);if(!ds.isDirectory()||ds.isSymbolicLink()||ds.uid!==1000||ds.gid!==1000||(ds.mode&0o7777)!==0o700||fs.realpathSync(dir)!==dir)reject();
   const entries=fs.readdirSync(dir).sort();if(entries.length<1||entries.length>12)reject();
   for(const name of entries){const f=fs.lstatSync(dir+'/'+name);if(!f.isFile()||f.isSymbolicLink()||f.uid!==1000||f.gid!==1000||(f.mode&0o7777)!==0o600||f.nlink!==1||f.size<2||f.size>4096)reject();}
   const J=require('/review/journal.cjs'),held=J.createJournal('/runtime-proof').readDurable(EXPECTED.intent.operationId);if(JSON.stringify(held.intent)!==JSON.stringify(EXPECTED.intent))reject();
  }
  return {schema:'crm-manager-read-public-postcondition-v1',mode:EXPECTED.mode,planSha256:EXPECTED.planSha256,sourcePinsSha256:EXPECTED.sourcePinsSha256,nineSourcesPinned:true,sourceReadOnly:true,sourceRootOwned:true,sourceModesVerified:true,ledgerPhase:EXPECTED.mode==='execute'?'empty':'original_intent_held',ledgerEmpty:EXPECTED.mode==='execute',originalIntentHeld:EXPECTED.mode==='reconcile',ledgerPrivateOwned:true,uid1000:true,noNewPrivileges:true,capabilitiesEmpty:true,rootReadOnly:true,privateEnvironmentAbsent:true,postgresConnected:false,runtimeExecuted:false};
 }
 try{
  verify();
  const server=http.createServer((req,res)=>{
   if(req.method!=='GET'){res.writeHead(405,{'Cache-Control':'no-store','Content-Length':'0'});res.end();return;}
   if(req.url!=='/status'||req.headers.host!==EXPECTED.host){res.writeHead(404,{'Cache-Control':'no-store','Content-Length':'0'});res.end();return;}
   try{const body=JSON.stringify(verify());res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Content-Length':String(Buffer.byteLength(body))});res.end(body);}catch{res.writeHead(503,{'Cache-Control':'no-store','Content-Length':'0'});res.end();}
  });
  server.maxHeadersCount=8;server.headersTimeout=5000;server.requestTimeout=5000;server.maxRequestsPerSocket=1;
  server.on('error',()=>{process.stderr.write('READ_PUBLIC_POSTCONDITION_REFUSED\n');process.exitCode=1;});server.listen(8099,'0.0.0.0');
 }catch{process.stderr.write('READ_PUBLIC_POSTCONDITION_REFUSED\n');process.exitCode=1;}
}
function buildPublicPostcondition(input){
 exact(input,['remotePlan']);const p=R.assertRemotePlan(input.remotePlan),d=p.descriptor;if(!['execute','reconcile'].includes(p.mode)||d.image!==C.IMAGE||JSON.stringify(d.sourcePins)!==JSON.stringify(C.PINS))fail();
 const expected={host:d.domain.host,mode:p.mode,intent:p.intent,planSha256:p.planSha256,sourcePinsSha256:sha(JSON.stringify(C.PINS))};
 const inline="'use strict';("+observerRuntime.toString()+')('+JSON.stringify(expected)+','+JSON.stringify(C.PINS)+');';if(inline.includes('$')||Buffer.byteLength(inline)>16000)fail();
 const gateway=copy(d.compose.services.gateway);delete gateway.depends_on;delete gateway.env_file;gateway.entrypoint=['timeout','-s','KILL','600'];gateway.command=['node','--max-old-space-size=96','-e',inline];gateway.healthcheck={disable:true};
 return freeze({schema:'crm-manager-read-public-probe-plan-v1',remotePlan:p,postconditionExpected:Object.freeze(expected),command:Object.freeze([...gateway.command]),inline,compose:{services:{gateway},volumes:{source:{external:true,name:d.compose.volumes.source.name},ledger:{external:true,name:d.compose.volumes.ledger.name}},networks:copy(d.compose.networks)}});
}
function acceptPostcondition(raw,remotePlan){
 const p=R.assertRemotePlan(remotePlan);if(typeof raw!=='string'||Buffer.byteLength(raw)>4096)fail();let v;try{v=JSON.parse(raw);}catch{fail();}
 const body={schema:'crm-manager-read-public-postcondition-v1',mode:p.mode,planSha256:p.planSha256,sourcePinsSha256:sha(JSON.stringify(C.PINS)),nineSourcesPinned:true,sourceReadOnly:true,sourceRootOwned:true,sourceModesVerified:true,ledgerPhase:p.mode==='execute'?'empty':'original_intent_held',ledgerEmpty:p.mode==='execute',originalIntentHeld:p.mode==='reconcile',ledgerPrivateOwned:true,uid1000:true,noNewPrivileges:true,capabilitiesEmpty:true,rootReadOnly:true,privateEnvironmentAbsent:true,postgresConnected:false,runtimeExecuted:false};
 exact(v,Object.keys(body));for(const k of Object.keys(body))if(v[k]!==body[k])fail();return Object.freeze(v);
}
module.exports=Object.freeze({buildPublicPostcondition,acceptPostcondition});
