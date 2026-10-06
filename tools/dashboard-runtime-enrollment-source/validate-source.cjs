'use strict';
// A source-only comparison. No unpack, module loading, SQL, environment,
// startup, credential, provider, fence, receipt write or deployment authority.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const CONTRACT_SHA256='10fce0ab0752bf2d7208226859cd777f734a266cdf4281b5ad5d7a0e11ca85c0';
const SCHEMA='crm-enrollment-runtime-source-result-v1';
const CODES=new Set(['INPUT_REFUSED','CONTRACT_REFUSED','BASE_PACK_REFUSED','HISTORICAL_REFERENCE_REFUSED','DELTA_SET_REFUSED','DELTA_BYTES_REFUSED','TARGET_RUNTIME_REFUSED','SOURCE_REFUSED']);
class SourceValidationError extends Error{constructor(code){super(code);this.name='SourceValidationError';this.code=code;}}
const deny=code=>{throw new SourceValidationError(CODES.has(code)?code:'SOURCE_REFUSED');};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return d?.enumerable===true&&Object.hasOwn(d,'value');});
const sameStat=(a,b)=>['dev','ino','size','mode','uid','gid','nlink','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
function physical(file,directory,code){
 if(typeof file!=='string'||!path.isAbsolute(file)||file!==path.resolve(file)||file.split(path.sep).includes('.private'))deny(code);
 const s=fs.lstatSync(file);
 if(fs.realpathSync(file)!==file||s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile()||s.nlink!==1))deny(code);
 return s;
}
function read(file,max,code){
 let fd;
 try{
  const before=physical(file,false,code);if(before.size<1||before.size>max)deny(code);
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  if(!sameStat(before,fs.fstatSync(fd)))deny(code);
  const bytes=fs.readFileSync(fd);
  if(bytes.length!==before.size||!sameStat(before,fs.fstatSync(fd))||!sameStat(before,physical(file,false,code)))deny(code);
  return bytes;
 }catch{deny(code);}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function json(bytes,code){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{deny(code);}}
function contract(){
 const bytes=read(path.join(__dirname,'contract.json'),32768,'CONTRACT_REFUSED');
 if(sha(bytes)!==CONTRACT_SHA256)deny('CONTRACT_REFUSED');
 return json(bytes,'CONTRACT_REFUSED');
}
function originalRuntime(packFile,c){
 const bytes=read(packFile,c.basePack.bytes,'BASE_PACK_REFUSED');
 if(bytes.length!==c.basePack.bytes||sha(bytes)!==c.basePack.transportSha256)deny('BASE_PACK_REFUSED');
 const wrapper=json(bytes,'BASE_PACK_REFUSED');
 if(!exact(wrapper,['schema','sha256','brotliBase64'])||wrapper.schema!==c.basePack.schema||wrapper.sha256!==c.basePack.rawSha256||typeof wrapper.brotliBase64!=='string')deny('BASE_PACK_REFUSED');
 let raw;
 try{const compressed=Buffer.from(wrapper.brotliBase64,'base64'),decoded=zlib.brotliDecompressSync(compressed,{info:true,maxOutputLength:c.limits.maxDecodedPackBytes});if(decoded.engine.bytesWritten!==compressed.length)deny('BASE_PACK_REFUSED');raw=decoded.buffer;}catch{deny('BASE_PACK_REFUSED');}
 if(raw.length!==c.basePack.rawBytes||sha(raw)!==c.basePack.rawSha256)deny('BASE_PACK_REFUSED');
 const files=json(raw,'BASE_PACK_REFUSED'),seen=new Set(),runtime=new Map();let publicCount=0;
 if(!Array.isArray(files)||files.length!==c.basePack.files)deny('BASE_PACK_REFUSED');
 for(const file of files){
  if(!exact(file,['path','encoding','content'])||typeof file.path!=='string'||typeof file.content!=='string'||seen.has(file.path)||!['utf8','base64'].includes(file.encoding))deny('BASE_PACK_REFUSED');
  seen.add(file.path);
  if(file.path.startsWith('public/')){publicCount++;continue;}
  if(!/^runtime\/[a-z0-9-]+\.(?:cjs|js)$/.test(file.path)||file.encoding!=='utf8')deny('BASE_PACK_REFUSED');
  const name=file.path.slice(8),pin=c.runtime.find(f=>f.path===name),data=Buffer.from(file.content,'utf8');
  if(!pin||data.toString('utf8')!==file.content||pin.bytes!==data.length||pin.sha256!==sha(data))deny('BASE_PACK_REFUSED');
  runtime.set(name,data);
 }
 if(publicCount!==c.basePack.publicFiles||runtime.size!==c.basePack.runtimeFiles)deny('BASE_PACK_REFUSED');
 return runtime;
}
function inside(root,relative,code){
 const file=path.resolve(root,relative);if(!file.startsWith(root+path.sep))deny(code);
 for(let dir=path.dirname(file);dir!==root;dir=path.dirname(dir))physical(dir,true,code);
 return file;
}
function references(root,c){
 physical(root,true,'HISTORICAL_REFERENCE_REFUSED');
 for(const pin of c.historicalReferences){const b=read(inside(root,pin.path,'HISTORICAL_REFERENCE_REFUSED'),c.limits.maxHistoricalFileBytes,'HISTORICAL_REFERENCE_REFUSED');if(b.length!==pin.bytes||sha(b)!==pin.sha256)deny('HISTORICAL_REFERENCE_REFUSED');}
 // These are public historical statements, not a live marker/SQLite probe.
 const proof=json(read(inside(root,'deliverables/crm-sprint-final-20261005/integracao/master-native-final-proof-v1.json','HISTORICAL_REFERENCE_REFUSED'),16384,'HISTORICAL_REFERENCE_REFUSED'),'HISTORICAL_REFERENCE_REFUSED');
 const first=proof.nativeObservation?.nativeResult,again=proof.activationReceiptAfterExpiryAndRestart?.nativeResult;
 if(first?.operationId!==c.protectedOperations.master||again?.operationId!==first.operationId||first?.attemptConsumed!==true||again?.attemptConsumed!==true||first?.state!=='confirmed'||again?.state!=='confirmed'||proof.consumedPlanRearmed!==false||canonical(proof.durableFilesBefore?.rows)!==canonical(proof.durableFilesAfter?.rows))deny('HISTORICAL_REFERENCE_REFUSED');
 return c.historicalReferences.length;
}
function directoryFiles(dir,expected,code){
 const before=physical(dir,true,code),names=fs.readdirSync(dir).sort();
 if(canonical(names)!==canonical(expected.slice().sort()))deny(code);
 return before;
}
function stableDirectory(dir,before,expected,code){if(!sameStat(before,physical(dir,true,code))||canonical(fs.readdirSync(dir).sort())!==canonical(expected.slice().sort()))deny(code);}
function verifySource(input){
 try{
  if(!exact(input,['basePackFile','deltaDir','evidenceRoot',...(Object.hasOwn(input||{},'candidateRuntimeDir')?['candidateRuntimeDir']:[])])||Object.values(input).some(v=>typeof v!=='string'))deny('INPUT_REFUSED');
  const c=contract(),original=originalRuntime(input.basePackFile,c),referenceCount=references(input.evidenceRoot,c),changes=c.delta.map(f=>f.path),deltaBefore=directoryFiles(input.deltaDir,changes,'DELTA_SET_REFUSED');
  const proposed=new Map(original);
  for(const pin of c.delta){
   const before=original.get(pin.path),after=read(path.join(input.deltaDir,pin.path),c.limits.maxSourceFileBytes,'DELTA_BYTES_REFUSED');
   if(before.length!==pin.beforeBytes||sha(before)!==pin.beforeSha256||after.length!==pin.afterBytes||sha(after)!==pin.afterSha256)deny('DELTA_BYTES_REFUSED');
   proposed.set(pin.path,after);
  }
  stableDirectory(input.deltaDir,deltaBefore,changes,'DELTA_SET_REFUSED');
  if(input.candidateRuntimeDir!==undefined){
   const names=c.runtime.map(f=>f.path),before=directoryFiles(input.candidateRuntimeDir,names,'TARGET_RUNTIME_REFUSED');
   for(const name of names){const b=read(path.join(input.candidateRuntimeDir,name),c.limits.maxSourceFileBytes,'TARGET_RUNTIME_REFUSED');if(!b.equals(proposed.get(name)))deny('TARGET_RUNTIME_REFUSED');}
   stableDirectory(input.candidateRuntimeDir,before,names,'TARGET_RUNTIME_REFUSED');
  }
  const closure=c.runtime.map(f=>({path:f.path,bytes:proposed.get(f.path).length,sha256:sha(proposed.get(f.path))}));
  return Object.freeze({schema:SCHEMA,state:'source-delta-validated',scope:'source-bytes-only',contractSha256:CONTRACT_SHA256,baseSourceRevision:c.baseSourceRevision,candidateSourceRevision:c.candidateSourceRevision,basePackSha256:c.basePack.rawSha256,runtimeFiles:closure.length,changedFiles:changes,unchangedRuntimeFiles:closure.length-changes.length,runtimeClosureSha256:sha(Buffer.from(canonical(closure))),runtimeClosure:closure,candidateRuntimeDirectoryChecked:input.candidateRuntimeDir!==undefined,historicalPublicReferencesMatched:referenceCount,historicalMasterConsumedStatementMatched:true,nativeConsumedMarkersRead:false,operationReplayAuthority:false,oldMasterAdmissionReusableForNewRuntime:false,nativeAdmission:false,installation:false,managedModeEnable:false,brokersAdmitted:false,humanSessionAuthority:false,identitySqlExecuted:false,targetPackProduced:false,gitAncestryVerifiedByThisTool:false,productionObserved:false,operational:false});
 }catch(e){if(e instanceof SourceValidationError&&CODES.has(e.code))throw e;deny('SOURCE_REFUSED');}
}
function cli(args){
 if(args.length===0)return {schema:SCHEMA,state:'disabled',code:'DEFAULT_OFF',scope:'source-bytes-only',nativeAdmission:false,installation:false,operational:false};
 const names={'--base-pack':'basePackFile','--delta-dir':'deltaDir','--evidence-root':'evidenceRoot','--candidate-runtime-dir':'candidateRuntimeDir'},input={};
 if(args.length%2!==0)deny('INPUT_REFUSED');
 for(let i=0;i<args.length;i+=2){const key=names[args[i]];if(!key||Object.hasOwn(input,key)||typeof args[i+1]!=='string'||args[i+1].startsWith('--'))deny('INPUT_REFUSED');input[key]=args[i+1];}
 return verifySource(input);
}
if(require.main===module){try{process.stdout.write(JSON.stringify(cli(process.argv.slice(2)))+'\n');}catch(e){process.stdout.write(JSON.stringify({schema:SCHEMA,state:'refused',code:CODES.has(e?.code)?e.code:'SOURCE_REFUSED',scope:'source-bytes-only',nativeAdmission:false,installation:false,operational:false})+'\n');process.exitCode=1;}}
module.exports=Object.freeze({verifySource,cli,CONTRACT_SHA256,SourceValidationError});
