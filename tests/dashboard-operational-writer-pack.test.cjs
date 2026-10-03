'use strict';
// Public runtime packaging only. Disposable SQLite, synthetic identities and
// no transport, environment activation, remote database or server deployment.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const DIR=path.resolve(__dirname,'../services/dashboard-operational');
const P=require(DIR+'/artifact-policy.cjs'),{pack}=require(DIR+'/pack-runtime.cjs');
const WRITER=['crm-manager-writer-auth-adapter.cjs','crm-manager-writer-client.cjs','crm-manager-writer-coordinator.cjs','crm-manager-writer-journal.cjs','crm-manager-writer-policy.cjs'];
function temporary(t){const d=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'writer-public-pack-')));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
function entries(writer){return [...P.PUBLIC_FILES.map(f=>({path:'public/'+f,encoding:P.isText(f)?'utf8':'base64',content:P.isText(f)?'synthetic public fixture':'c3ludGhldGlj'})),...(writer?P.PRE_PARITY_RUNTIME_FILES:P.LEGACY_RUNTIME_FILES).map(f=>({path:'runtime/'+f,encoding:'utf8',content:fs.readFileSync(DIR+'/'+f,'utf8')}))].sort((a,b)=>a.path.localeCompare(b.path));}
function wrapper(files,schema=P.SCHEMA_V2){const raw=Buffer.from(JSON.stringify(files)),gzip=schema===P.SCHEMA,key=gzip?'gzipBase64':'brotliBase64';const body={schema,sha256:P.sha(raw),[key]:(gzip?zlib.gzipSync(raw):zlib.brotliCompressSync(raw)).toString('base64')};return{body,text:JSON.stringify(body)};}
function config(extra={}){return{dbPath:':memory:',managerHost:'gerencial.synthetic.invalid',areaHosts:{growth:'crm.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'master@synthetic.invalid',bootstrapTokenSha256:crypto.createHash('sha256').update('synthetic-only-bootstrap').digest('hex'),encryptionKey:Buffer.alloc(32,3),...extra};}
function writerConfig(){return config({crmCampaignSubmitWrite:true,crmManagedWriter:{issuerId:crypto.randomUUID(),namespaceId:crypto.randomUUID()}});}

test('allowlist preserves the old complete set and prior complete writer family alongside the new read bridges',()=>{
 assert.equal(P.PUBLIC_FILES.length,30);assert.equal(P.LEGACY_FILES.length,48);assert.equal(P.PRE_PARITY_FILES.length,53);assert.equal(P.FILES.length,56);assert.deepEqual([...P.WRITER_RUNTIME_FILES],WRITER);
 assert.equal(P.MAX_PACK_BYTES,950000);assert.equal(P.MAX_BYTES,16*1024*1024);
 assert.equal(P.validateFiles(entries(false)).runtimeFiles,18);assert.equal(P.validateFiles(entries(true)).runtimeFiles,23);
 const partial=entries(true).filter(f=>f.path!=='runtime/crm-manager-writer-policy.cjs');assert.throws(()=>P.validateFiles(partial),/ARTIFACT_FILES_INVALID/);
 const duplicate=entries(true);duplicate[0]=duplicate[1];assert.throws(()=>P.validateFiles(duplicate),/ARTIFACT_FILE_INVALID/);
});
test('the new policy still decodes complete legacy gzip and Brotli packs with their original pins',()=>{
 for(const schema of [P.SCHEMA,P.SCHEMA_V2]){const w=wrapper(entries(false),schema),decoded=P.decodePack(w.text,w.body.sha256);assert.equal(decoded.stats.files,48);assert.equal(decoded.stats.runtimeFiles,18);assert.deepEqual(decoded.files,entries(false));}
});
test('a complete public writer pack decodes losslessly without adding tools paths',()=>{
 const input=entries(true),w=wrapper(input),decoded=P.decodePack(w.text,w.body.sha256);assert.deepEqual(decoded.files,input);assert.equal(decoded.stats.files,53);
 for(const file of WRITER){const f=decoded.files.find(v=>v.path==='runtime/'+file);assert.ok(f);assert.doesNotMatch(f.content,/require\(['"][^'"]*tools\//);}
 assert.doesNotMatch(decoded.files.find(f=>f.path==='runtime/auth.cjs').content,/require\(['"][^'"]*tools\//);
});
test('the real pack builder and extracted runtime load the writer adapter without a tools tree',t=>{
 const dir=temporary(t),dist=path.join(dir,'dist');
 for(const f of entries(false).filter(f=>f.path.startsWith('public/'))){const target=path.join(dist,f.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,Buffer.from(f.content,f.encoding));}
 const built=pack(dist,path.join(dir,'pack'));assert.equal(built.files,56);assert.equal(built.runtimeFiles,26);assert.ok(built.packBytes<=950000);assert.ok(built.seedMountsBytes<=960000);
 const extracted=P.unpack(path.join(dir,'pack/runtime-pack.json'),path.join(dir,'artifact'),{expectedSha256:built.packSha256});assert.equal(fs.existsSync(path.join(dir,'artifact/tools')),false);
 const {createAuth}=require(extracted.runtimeDir+'/auth.cjs'),auth=createAuth(writerConfig());
 try{assert.equal(typeof auth.approveManagedCampaignWriter,'function');assert.deepEqual(auth.managedCampaignWriterJournal.pending(),[]);assert.equal(auth.managedCrmJournal,undefined);}finally{auth.close();}
});
test('a writer file hidden under tools, an incomplete set or an extra file is rejected even with a recomputed pin',()=>{
 for(const mutate of [a=>{a.find(f=>f.path==='runtime/crm-manager-writer-policy.cjs').path='tools/crm-manager-writer-policy.cjs';},a=>a.pop(),a=>a.push({path:'runtime/unreviewed.cjs',encoding:'utf8',content:'module.exports={};'})]){const files=entries(true);mutate(files);const w=wrapper(files);assert.throws(()=>P.decodePack(w.text,w.body.sha256),/ARTIFACT_(FILES|FILE)_INVALID/);}
});
test('shipping the adapter leaves default APIs inactive and preserves READ and corporate writer barriers',()=>{
 const {createAuth}=require(DIR+'/auth.cjs'),plain=createAuth(config());try{assert.equal(plain.approveManagedCampaignWriter,undefined);assert.equal(plain.managedCampaignWriterJournal,undefined);}finally{plain.close();}
 const read={issuerId:crypto.randomUUID(),namespaceId:crypto.randomUUID()},reader=createAuth(config({crmManagedRead:read}));try{assert.ok(reader.managedCrmJournal);assert.equal(reader.approveManagedCampaignWriter,undefined);}finally{reader.close();}
 assert.throws(()=>createAuth({...writerConfig(),crmManagedRead:read}),e=>e.code==='CAMPAIGN_WRITE_CONFIG_INVALID');
 assert.throws(()=>createAuth({...writerConfig(),allowedEmailDomains:['oaristocrata.com'],bootstrapAdminEmail:'master@oaristocrata.com'}),e=>e.code==='CAMPAIGN_WRITE_CONFIG_INVALID');
});
test('the HTTP startup factory rejects an unreviewed descriptor and strips private material from the corporate descriptor',async t=>{
 const {authOptionsFor}=require(DIR+'/server.cjs');assert.throws(()=>authOptionsFor(writerConfig()),e=>e.code==='MANAGED_CRM_RUNTIME_REFUSED');
 const options=authOptionsFor(config({crmCampaignSubmitWrite:true}));assert.equal(options.crmManagedWriter,undefined);assert.equal(options.crmCampaignSubmitWrite,true);
 const {createAuth}=require(DIR+'/auth.cjs'),auth=createAuth(options);try{assert.equal(auth.approveManagedCampaignWriter,undefined);assert.equal(auth.managedCampaignWriterJournal,undefined);}finally{auth.close();}
 const f=await require('./corporate-writer-fixture.cjs').fixture(t),reviewed=authOptionsFor({...f.config,crmManagedWriter:{...f.config.crmManagedWriter,provisionerToken:'W'.repeat(43)}});
 assert.equal(require(DIR+'/crm-manager-runtime.cjs').isCorporateWriterDescriptor(reviewed.crmManagedWriter),true);
 assert.deepEqual(Object.keys(reviewed.crmManagedWriter).sort(),['issuerId','mode','namespaceId']);
 assert.equal(reviewed.crmManagedWriter.provisionerToken,undefined);
 assert.notEqual(reviewed.crmManagedWriter.issuerId,reviewed.crmManagedRead.issuerId);
});
