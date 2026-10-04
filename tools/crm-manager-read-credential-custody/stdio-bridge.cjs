'use strict';
// API-only transport. Custody/fences stay in the existing Node adapter.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const PROCS=Object.freeze({createComposeService:'execute_mutation',inspectComposeService:'execute_query',getDockerContainers:'execute_query',listDomains:'execute_query',updateComposeSourceInline:'execute_destructive',updateComposeEnv:'execute_destructive',createDomain:'execute_mutation',deleteDomain:'execute_destructive',deployComposeService:'execute_destructive',stopComposeService:'execute_destructive',startComposeService:'execute_mutation'});
const REQUEST='read-stdio-request-v1',RESPONSE='read-stdio-response-v1',BODY='read-stdio-public-body-v1',READBACK='read-stdio-public-readback-v1';
const MAX_PUBLIC=524288,MAX_PRIVATE=4096,MAX_INPUT=1048576;
class BridgeUnknown extends Error{constructor(){super('READ_STDIO_OUTCOME_UNKNOWN');this.code='READ_STDIO_OUTCOME_UNKNOWN';}}
const unknown=()=>new BridgeUnknown();
const exact=(v,ks)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===ks.length&&ks.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return !!d&&d.enumerable&&Object.hasOwn(d,'value');});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const SHAPES={createComposeService:['projectName','serviceName','createDotEnv','env','domains','source'],inspectComposeService:['projectName','serviceName'],getDockerContainers:['service'],listDomains:null,updateComposeSourceInline:['projectName','serviceName','content'],updateComposeEnv:['projectName','serviceName','createDotEnv','env'],createDomain:['id','certificateResolver','host','https','path','wildcard','middlewares','destinationType','serviceDestination'],deleteDomain:['id'],deployComposeService:['projectName','serviceName','forceRebuild'],stopComposeService:['projectName','serviceName'],startComposeService:['projectName','serviceName']};
function dataOnly(v,depth=0,limit={n:0}){if(depth>30||++limit.n>4096)throw unknown();if(v===null||['string','boolean'].includes(typeof v)||typeof v==='number'&&Number.isFinite(v))return;if(!v||typeof v!=='object')throw unknown();const array=Array.isArray(v);if(!array&&Object.getPrototypeOf(v)!==Object.prototype)throw unknown();for(const k of Reflect.ownKeys(v)){if(array&&k==='length')continue;const d=Object.getOwnPropertyDescriptor(v,k);if(typeof k!=='string'||!d||!d.enumerable||!Object.hasOwn(d,'value'))throw unknown();dataOnly(d.value,depth+1,limit);}}
function inputShape(procedure,input){
 dataOnly(input);const ks=procedure==='listDomains'?(Reflect.ownKeys(input).length===0?[]:['projectName','serviceName']):SHAPES[procedure];if(!ks||!exact(input,ks))throw unknown();
 const name=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v),text=(v,max=128)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
 for(const k of['projectName','serviceName','service','id'])if(Object.hasOwn(input,k)&&!name(input[k]))throw unknown();
 for(const k of['createDotEnv','forceRebuild','https','wildcard'])if(Object.hasOwn(input,k)&&typeof input[k]!=='boolean')throw unknown();
 if(Object.hasOwn(input,'env')&&typeof input.env!=='string')throw unknown();
 // Opaque source text must come from the trusted, branded public-source materializer.
 if(Object.hasOwn(input,'content')&&typeof input.content!=='string')throw unknown();
 if(procedure==='createComposeService'&&(!exact(input.source,['type','content'])||input.source.type!=='inline'||typeof input.source.content!=='string'||!Array.isArray(input.domains)||input.domains.length!==0))throw unknown();
 if(procedure==='createDomain'){
  const d=input.serviceDestination;if(!exact(d,['projectName','serviceName','composeService','protocol','port','path'])||!Array.isArray(input.middlewares)||input.middlewares.length!==0||!name(d.projectName)||!name(d.serviceName)||!name(d.composeService)||d.protocol!=='http'||!Number.isSafeInteger(d.port)||d.port<1||d.port>65535||d.path!=='/'||input.path!=='/'||input.destinationType!=='service'||!text(input.certificateResolver)||typeof input.host!=='string'||! /^[a-z0-9][a-z0-9.-]{0,252}$/.test(input.host))throw unknown();
 }
 return true;
}

function privateInput(input){if(!input||Object.getPrototypeOf(input)!==Object.prototype)throw unknown();const stack=[input];let count=0;while(stack.length){const v=stack.pop();if(++count>4096)throw unknown();for(const [k,x] of Object.entries(v)){if(/^(?:env)$|password|token|secret|scram|privatekey/i.test(k)&&x!==''&&x!==null&&x!==undefined)return true;if(x&&typeof x==='object')stack.push(x);}}return false;}
function directory(dir){if(typeof dir!=='string'||!path.isAbsolute(dir)||path.resolve(dir)!==dir)throw unknown();const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o7777)!==0o700||fs.realpathSync(dir)!==dir)throw unknown();return s;}
function syncDir(dir){const before=directory(dir),fd=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_DIRECTORY);try{const s=fs.fstatSync(fd);if(s.dev!==before.dev||s.ino!==before.ino)throw unknown();fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function publicFile(dir,seq,executor,args){
 directory(dir);const b=Buffer.from(JSON.stringify({schema:BODY,seq,executor,args})+'\n');if(b.length>MAX_PUBLIC)throw unknown();
 const file=path.join(dir,'request-'+seq+'.json'),fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
 try{let n=0;while(n<b.length){const written=fs.writeSync(fd,b,n,b.length-n);if(written<1)throw unknown();n+=written;}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDir(dir);
 const descriptor={path:file,bytes:b.length,sha256:hash(b)};const recovered=readPublicFile(descriptor);if(recovered.seq!==seq||recovered.executor!==executor||JSON.stringify(recovered.args)!==JSON.stringify(args))throw unknown();return descriptor;
}
function readPublicFile(d){
 if(!exact(d,['path','bytes','sha256'])||typeof d.path!=='string'||!path.isAbsolute(d.path)||path.resolve(d.path)!==d.path||!/^request-[1-9][0-9]{0,5}\.json$/.test(path.basename(d.path))||!Number.isSafeInteger(d.bytes)||d.bytes<1||d.bytes>MAX_PUBLIC||!/^[a-f0-9]{64}$/.test(d.sha256))throw unknown();
 directory(path.dirname(d.path));const before=fs.lstatSync(d.path);function same(s){if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o7777)!==0o600||s.size!==d.bytes||s.dev!==before.dev||s.ino!==before.ino||s.mtimeMs!==before.mtimeMs||s.ctimeMs!==before.ctimeMs)throw unknown();}
 same(before);const fd=fs.openSync(d.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let b;
 try{same(fs.fstatSync(fd));b=fs.readFileSync(fd);same(fs.fstatSync(fd));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(b.length!==d.bytes||hash(b)!==d.sha256)throw unknown();
 let v;try{v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}catch{throw unknown();}
 if(!exact(v,['schema','seq','executor','args'])||v.schema!==BODY||!Number.isSafeInteger(v.seq)||!exact(v.args,['procedure','input'])||PROCS[v.args.procedure]!==v.executor||privateInput(v.args.input))throw unknown();
 inputShape(v.args.procedure,v.args.input);
 return {schema:READBACK,seq:v.seq,executor:v.executor,args:v.args,bytes:d.bytes,sha256:d.sha256};
}
function createStdioBridge({enabled=false,directory:dir,materialize,input,output,timeoutMs=30000}={}){
 if(typeof enabled!=='boolean')throw unknown();
 if(!enabled)return Object.freeze({enabled:false,execute:async()=>{throw unknown();},abort:()=>({state:'unknown'}),close:()=>{}});
 input=input||process.stdin;output=output||process.stdout;
 directory(dir);if(typeof materialize!=='function'||typeof input?.on!=='function'||typeof output?.write!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>60000)throw unknown();
 let seq=0,pending=null,closed=false,chunks=[],bytes=0;
 function detach(){input.removeListener('data',onData);input.removeListener('end',onEnd);input.removeListener('error',onEnd);}
 function terminal(){if(closed)return;closed=true;detach();chunks=[];bytes=0;if(pending){clearTimeout(pending.timer);const reject=pending.reject;pending=null;reject(unknown());}}
 function onEnd(){terminal();}
 function line(b){let q;try{q=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}catch{return terminal();}
  if(!pending||!exact(q,q?.ok===true?['schema','seq','ok','result']:['schema','seq','ok'])||q.schema!==RESPONSE||q.seq!==pending.seq||typeof q.ok!=='boolean')return terminal();
  const p=pending;pending=null;clearTimeout(p.timer);if(q.ok)p.resolve(q.result);else{p.reject(unknown());terminal();}
 }
 function onData(value){if(closed)return;const b=Buffer.isBuffer(value)?value:Buffer.from(value);let start=0;
  for(let i=0;i<b.length;i++)if(b[i]===10){const part=b.subarray(start,i);bytes+=part.length;if(bytes>MAX_INPUT)return terminal();chunks.push(part);let packet=Buffer.concat(chunks,bytes);if(packet.at(-1)===13)packet=packet.subarray(0,-1);chunks=[];bytes=0;line(packet);if(closed)return;start=i+1;}
  if(start<b.length){const part=b.subarray(start);bytes+=part.length;if(bytes>MAX_INPUT)return terminal();chunks.push(part);}
 }
 input.on('data',onData);input.once('end',onEnd);input.once('error',onEnd);
 function send(record){
  if(closed||pending||seq>=999999)return Promise.reject(unknown());seq++;
  let packet;try{packet=record(seq);if(Buffer.byteLength(packet)>MAX_PRIVATE)throw unknown();}catch{terminal();return Promise.reject(unknown());}
  return new Promise((resolve,reject)=>{const timer=setTimeout(terminal,timeoutMs);pending={seq,resolve,reject,timer};try{output.write(packet+'\n',e=>{if(e)terminal();});}catch{terminal();}});
 }
 async function execute(frame){return send(n=>{
  const args=materialize(frame);if(!exact(args,['procedure','input'])||PROCS[args.procedure]!==frame?.executor)throw unknown();
  inputShape(args.procedure,args.input);const privateRequest=privateInput(args.input);
   return JSON.stringify({schema:REQUEST,seq:n,kind:'mcp',visibility:privateRequest?'private':'public',executor:frame.executor,...(privateRequest?{args}:{file:publicFile(dir,n,frame.executor,args)})});
 });}
 // Only the closed MCP frame protocol is admitted. No opaque helper channel.
 return Object.freeze({enabled:true,execute,abort:()=>{terminal();return{state:'unknown'};},close:terminal});
}
module.exports=Object.freeze({createStdioBridge,readPublicFile,PROCS,REQUEST,RESPONSE,READBACK,MAX_PUBLIC,MAX_PRIVATE,MAX_INPUT,BridgeUnknown,privateInput,inputShape});
if(require.main===module){process.stderr.write('READ_STDIO_API_ONLY\n');process.exitCode=1;}
