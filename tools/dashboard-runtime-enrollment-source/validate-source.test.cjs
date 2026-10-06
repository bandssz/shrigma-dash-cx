'use strict';
// Only public source bytes and disposable source fixtures. No Auth execution,
// SQLite, PostgreSQL, provider, production marker, environment key or network.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),zlib=require('node:zlib');
const V=require('./validate-source.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const WORKSPACE=fs.realpathSync(process.env.ENROLLMENT_EVIDENCE_ROOT||path.resolve(__dirname,'../../..'));
const PACK=process.env.ENROLLMENT_PUBLIC_BASE_PACK||'/private/tmp/master-v2-public-image-SI92wK/image/runtime-pack.json';
const DELTA=process.env.ENROLLMENT_PUBLIC_DELTA_DIR||path.join(WORKSPACE,'deliverables/sprint-20261006/acessos/candidate/services/dashboard-operational');
const C=JSON.parse(fs.readFileSync(path.join(__dirname,'contract.json'),'utf8'));
function pins(){return [PACK,...C.historicalReferences.map(f=>path.join(WORKSPACE,f.path)),...C.delta.map(f=>path.join(DELTA,f.path))].map(p=>({p,bytes:fs.statSync(p).size,sha256:sha(fs.readFileSync(p))}));}
function fixture(t,{references=false,runtime=false}={}){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'crm-enrollment-source-test-'))),deltaDir=path.join(dir,'delta');fs.mkdirSync(deltaDir);
 for(const f of C.delta)fs.copyFileSync(path.join(DELTA,f.path),path.join(deltaDir,f.path));
 const input={basePackFile:PACK,deltaDir,evidenceRoot:WORKSPACE};
 if(references){input.evidenceRoot=path.join(dir,'evidence');fs.mkdirSync(input.evidenceRoot);for(const f of C.historicalReferences){const p=path.join(input.evidenceRoot,f.path);fs.mkdirSync(path.dirname(p),{recursive:true});fs.copyFileSync(path.join(WORKSPACE,f.path),p);}}
 if(runtime){const wrapper=JSON.parse(fs.readFileSync(PACK,'utf8')),all=JSON.parse(zlib.brotliDecompressSync(Buffer.from(wrapper.brotliBase64,'base64')));input.candidateRuntimeDir=path.join(dir,'runtime');fs.mkdirSync(input.candidateRuntimeDir);for(const f of all.filter(f=>f.path.startsWith('runtime/'))){const name=f.path.slice(8),bytes=C.delta.some(x=>x.path===name)?fs.readFileSync(path.join(deltaDir,name)):Buffer.from(f.content,f.encoding);fs.writeFileSync(path.join(input.candidateRuntimeDir,name),bytes);}}
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,input};
}
function refuses(fn,code){assert.throws(fn,e=>e instanceof V.SourceValidationError&&e.code===code&&e.message===code&&Object.hasOwn(e,'cause')===false&&Object.hasOwn(e,'path')===false);}
test('default OFF performs no file IO and never grants installation or native authority',()=>{
 const read=fs.readFileSync,open=fs.openSync;fs.readFileSync=()=>{throw Error('UNEXPECTED_SOURCE_IO');};fs.openSync=()=>{throw Error('UNEXPECTED_SOURCE_IO');};
 try{const r=V.cli([]);assert.equal(r.state,'disabled');assert.equal(r.code,'DEFAULT_OFF');assert.equal(r.nativeAdmission,false);assert.equal(r.installation,false);assert.equal(r.operational,false);}finally{fs.readFileSync=read;fs.openSync=open;}
});
test('known public pack and exact PR234 delta validate all 28 assembled runtime files without changing any origin',t=>{
 const before=pins(),a=fixture(t,{runtime:true}),write=fs.writeFileSync,unlink=fs.unlinkSync;fs.writeFileSync=()=>{throw Error('SOURCE_VALIDATOR_WROTE');};fs.unlinkSync=()=>{throw Error('SOURCE_VALIDATOR_DELETED');};let r;
 try{r=V.verifySource(a.input);}finally{fs.writeFileSync=write;fs.unlinkSync=unlink;}
 assert.equal(r.state,'source-delta-validated');assert.equal(r.runtimeFiles,28);assert.equal(r.unchangedRuntimeFiles,26);assert.deepEqual(r.changedFiles,['auth.cjs','crm-manager-journal.cjs']);assert.equal(r.candidateRuntimeDirectoryChecked,true);assert.equal(r.historicalPublicReferencesMatched,14);assert.equal(r.historicalMasterConsumedStatementMatched,true);
 for(const key of ['nativeConsumedMarkersRead','operationReplayAuthority','oldMasterAdmissionReusableForNewRuntime','nativeAdmission','installation','managedModeEnable','brokersAdmitted','humanSessionAuthority','identitySqlExecuted','targetPackProduced','productionObserved','operational'])assert.equal(r[key],false,key);
 assert.deepEqual(pins(),before);assert.deepEqual(V.verifySource(a.input),r);
});
test('wrong base transport refuses before it can be presented as the c3f runtime',t=>{
 const a=fixture(t),b=fs.readFileSync(PACK),p=path.join(a.dir,'wrong-pack.json');b[20]^=1;fs.writeFileSync(p,b);refuses(()=>V.verifySource({...a.input,basePackFile:p}),'BASE_PACK_REFUSED');
});
test('original baseline auth is not the admitted enrollment delta',t=>{
 const a=fixture(t),wrapper=JSON.parse(fs.readFileSync(PACK,'utf8')),files=JSON.parse(zlib.brotliDecompressSync(Buffer.from(wrapper.brotliBase64,'base64'))),f=files.find(f=>f.path==='runtime/auth.cjs');fs.writeFileSync(path.join(a.input.deltaDir,'auth.cjs'),f.content);refuses(()=>V.verifySource(a.input),'DELTA_BYTES_REFUSED');
});
test('auth or journal byte adulteration is refused even if both declared paths remain',t=>{
 for(const name of ['auth.cjs','crm-manager-journal.cjs']){const a=fixture(t),p=path.join(a.input.deltaDir,name);fs.appendFileSync(p,'\n// unreviewed\n');refuses(()=>V.verifySource(a.input),'DELTA_BYTES_REFUSED');}
});
test('extra delta source or hidden environment file is refused without reading it',t=>{
 for(const name of ['server.cjs','.env']){const a=fixture(t);fs.writeFileSync(path.join(a.input.deltaDir,name),'unadmitted');refuses(()=>V.verifySource(a.input),'DELTA_SET_REFUSED');}
});
test('missing delta or a replacement directory is refused',t=>{
 const a=fixture(t),p=path.join(a.input.deltaDir,'crm-manager-journal.cjs');fs.unlinkSync(p);refuses(()=>V.verifySource(a.input),'DELTA_SET_REFUSED');fs.mkdirSync(p);refuses(()=>V.verifySource(a.input),'DELTA_BYTES_REFUSED');
});
test('delta symlink or hardlink alias is refused',t=>{
 for(const kind of ['symlink','hardlink']){const a=fixture(t),p=path.join(a.input.deltaDir,'auth.cjs');fs.unlinkSync(p);if(kind==='symlink')fs.symlinkSync(path.join(DELTA,'auth.cjs'),p);else fs.linkSync(path.join(a.input.deltaDir,'crm-manager-journal.cjs'),p);refuses(()=>V.verifySource(a.input),'DELTA_BYTES_REFUSED');}
});
test('unreviewed server or WRITER adapter changes in an assembled target are refused',t=>{
 for(const name of ['server.cjs','crm-manager-writer-auth-adapter.cjs']){const a=fixture(t,{runtime:true});fs.appendFileSync(path.join(a.input.candidateRuntimeDir,name),'\n// unreviewed\n');refuses(()=>V.verifySource(a.input),'TARGET_RUNTIME_REFUSED');}
});
test('target runtime extras, omissions or nested directories cannot alter the exact 28-file closure',t=>{
 for(const kind of ['extra','missing','directory']){const a=fixture(t,{runtime:true}),d=a.input.candidateRuntimeDir;if(kind==='extra')fs.writeFileSync(path.join(d,'unreviewed.cjs'),'extra');else if(kind==='missing')fs.unlinkSync(path.join(d,'proxy.cjs'));else fs.mkdirSync(path.join(d,'unexpected'));refuses(()=>V.verifySource(a.input),'TARGET_RUNTIME_REFUSED');}
});
test('historical controller changes do not become an enrollment admission',t=>{
 const a=fixture(t,{references:true}),f=C.historicalReferences.find(f=>f.path.endsWith('/controller.cjs'));fs.appendFileSync(path.join(a.input.evidenceRoot,f.path),'\n// force managed mode\n');refuses(()=>V.verifySource(a.input),'HISTORICAL_REFERENCE_REFUSED');
});
test('edited consumed historical receipt is refused and never read as a live native fence',t=>{
 const a=fixture(t,{references:true}),p=path.join(a.input.evidenceRoot,'deliverables/crm-sprint-final-20261005/integracao/master-native-final-proof-v1.json'),r=JSON.parse(fs.readFileSync(p,'utf8'));r.nativeObservation.nativeResult.attemptConsumed=false;fs.writeFileSync(p,JSON.stringify(r));refuses(()=>V.verifySource(a.input),'HISTORICAL_REFERENCE_REFUSED');
});
test('wrong evidence base or absent historical file is a closed refusal',t=>{
 const a=fixture(t,{references:true});refuses(()=>V.verifySource({...a.input,evidenceRoot:a.dir}),'SOURCE_REFUSED');fs.unlinkSync(path.join(a.input.evidenceRoot,C.historicalReferences[0].path));refuses(()=>V.verifySource(a.input),'HISTORICAL_REFERENCE_REFUSED');
});
test('caller enable flags, accessors and unknown fields cannot confer additional scope',t=>{
 const a=fixture(t);refuses(()=>V.verifySource({...a.input,enabled:true}),'INPUT_REFUSED');const fake={...a.input};Object.defineProperty(fake,'basePackFile',{get(){throw Error('CALLER_GETTER_RAN');},enumerable:true});refuses(()=>V.verifySource(fake),'INPUT_REFUSED');refuses(()=>V.cli(['--enable','true']),'INPUT_REFUSED');refuses(()=>V.cli(['--base-pack',PACK,'--base-pack',PACK]),'INPUT_REFUSED');
});
test('filesystem or parser failures never expose raw path, driver, cause or private detail',t=>{
 const a=fixture(t);refuses(()=>V.verifySource({...a.input,basePackFile:path.join(a.dir,'absent')}),'BASE_PACK_REFUSED');refuses(()=>V.verifySource({...a.input,basePackFile:'/not-read/.private/runtime-pack.json'}),'BASE_PACK_REFUSED');
});
