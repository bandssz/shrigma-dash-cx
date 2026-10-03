'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),zlib=require('node:zlib');
const {spawnSync}=require('node:child_process');
const policy=require('./artifact-policy.cjs'),{pack,IMAGE}=require('./pack-runtime.cjs'),{build,CONTENT}=require('./build.cjs');
const image=require('./canary-image.cjs'),canary=require('./canary-start.cjs');
const REVISION='06f4144cb0a03faf3ad90eeb1233f68f7a94aca6';
test('Docker build stage copies every runtime module in the package allowlist',()=>{
 const dockerfile=fs.readFileSync(path.join(__dirname,'Dockerfile'),'utf8');
 const copies=dockerfile.split('\n').filter(line=>line.startsWith('COPY ')).join(' ');
 for(const file of policy.RUNTIME_FILES)assert.match(copies,new RegExp('services/dashboard-operational/'+file.replaceAll('.','\\.')+'(?:\\s|$)'),file);
});
function temp(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-docker-test-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function prepared(t){
 const dir=temp(t),dist=path.join(dir,'dist');fs.mkdirSync(path.join(dist,'public'),{recursive:true});
 for(const file of policy.PUBLIC_FILES){const output=path.join(dist,'public',file);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,policy.isText(file)?'SYNTHETIC TEST '+file:Buffer.from([0,1,2,255]));}
 const packDir=path.join(dir,'pack');pack(dist,packDir);const imageDir=path.join(dir,'image'),pin=image.prepareImage(packDir,REVISION,imageDir);
 return {dir,packDir,imageDir,pin};
}
function volume(dir,name='volume'){const dataDir=path.join(dir,name);fs.mkdirSync(dataDir,{mode:0o700});return dataDir;}
function seedOptions(dataDir,imageDir){return {dataDir,imageDir,expectedUid:process.getuid(),expectedGid:process.getgid()};}
test('image contains only six boot/package files and immutable source/payload pins',t=>{
 const {dir,packDir,imageDir,pin}=prepared(t);
 assert.deepEqual(fs.readdirSync(imageDir).sort(),image.IMAGE_FILES);assert.equal(pin.baseImage,IMAGE);assert.equal(pin.sourceRevision,REVISION);
 assert.equal(image.verifyImagePack(imageDir).pin.packSha256,pin.packSha256);
 assert.deepEqual(fs.readFileSync(path.join(imageDir,'runtime-pack.json')),fs.readFileSync(path.join(packDir,'runtime-pack.json')));
 assert.throws(()=>image.prepareImage(packDir,'latest',path.join(dir,'bad-revision')),/REVISION/);
 assert.throws(()=>image.prepareImage(packDir,REVISION,imageDir),/DESTINATION/);
});
test('fresh empty volume seeds once; restart preserves artifact and existing identity bytes',t=>{
 const {dir,imageDir,pin}=prepared(t),dataDir=volume(dir),options=seedOptions(dataDir,imageDir);
 assert.equal(canary.seedVolume(options).seeded,true);assert.deepEqual(fs.readdirSync(dataDir),['runtime-pack.json']);
 const packFile=path.join(dataDir,'runtime-pack.json'),before=fs.readFileSync(packFile),inode=fs.statSync(packFile).ino;
 const db=path.join(dataDir,'dashboard.sqlite');fs.writeFileSync(db,'SYNTHETIC IDENTITY SENTINEL',{mode:0o600});
 fs.chmodSync(dataDir,0o755);assert.equal(canary.seedVolume(options).seeded,false);
 assert.equal(fs.statSync(dataDir).mode&0o777,0o700);assert.equal(fs.statSync(packFile).ino,inode);assert.deepEqual(fs.readFileSync(packFile),before);
 assert.equal(fs.readFileSync(db,'utf8'),'SYNTHETIC IDENTITY SENTINEL');assert.equal(policy.decodePack(before.toString(),pin.packSha256).stats.files,policy.FILES.length);
});
test('nonempty volumes including hidden or partial seed files never get seeded',t=>{
 const {dir,imageDir}=prepared(t);
 for(const name of ['dashboard.sqlite','.partial','backup']){
  const dataDir=volume(dir,'volume-'+name.replaceAll('.','x')),sentinel=path.join(dataDir,name);fs.writeFileSync(sentinel,'PRESERVE',{mode:0o600});
  assert.throws(()=>canary.seedVolume(seedOptions(dataDir,imageDir)),/NOT_EMPTY/);assert.equal(fs.readFileSync(sentinel,'utf8'),'PRESERVE');assert(!fs.existsSync(path.join(dataDir,'runtime-pack.json')));
 }
});
test('wrong image pin, corrupt pack or foreign owner cannot seed or change a volume',t=>{
 const {dir,imageDir,pin}=prepared(t),dataDir=volume(dir),options=seedOptions(dataDir,imageDir),pinFile=path.join(imageDir,'image-pin.json');
 fs.chmodSync(dataDir,0o755);fs.writeFileSync(pinFile,JSON.stringify({...pin,packSha256:'0'.repeat(64)}));
 assert.throws(()=>canary.seedVolume(options));assert.deepEqual(fs.readdirSync(dataDir),[]);assert.equal(fs.statSync(dataDir).mode&0o777,0o755);
 fs.writeFileSync(pinFile,JSON.stringify(pin));assert.throws(()=>canary.seedVolume({...options,expectedUid:process.getuid()+1}),/VOLUME_INVALID/);assert.deepEqual(fs.readdirSync(dataDir),[]);
 fs.writeFileSync(path.join(imageDir,'runtime-pack.json'),'{}');assert.throws(()=>canary.seedVolume(options));assert.deepEqual(fs.readdirSync(dataDir),[]);
});
test('an existing corrupt or different-revision volume pack is never overwritten',t=>{
 const {dir,imageDir}=prepared(t),dataDir=volume(dir),file=path.join(dataDir,'runtime-pack.json'),options=seedOptions(dataDir,imageDir);
 fs.writeFileSync(file,'CORRUPT PRESERVE',{mode:0o600});assert.throws(()=>canary.seedVolume(options));assert.equal(fs.readFileSync(file,'utf8'),'CORRUPT PRESERVE');
 const wrapper=JSON.parse(fs.readFileSync(path.join(imageDir,'runtime-pack.json'),'utf8'));
 const files=policy.decodePack(JSON.stringify(wrapper),wrapper.sha256).files;files[0].content+=' CHANGED REVISION';const raw=Buffer.from(JSON.stringify(files));
 const changed=JSON.stringify({schema:policy.SCHEMA,sha256:policy.sha(raw),gzipBase64:zlib.gzipSync(raw).toString('base64')});fs.writeFileSync(file,changed);
 assert.throws(()=>canary.seedVolume(options));assert.equal(fs.readFileSync(file,'utf8'),changed);
});
test('symlink and hardlink image/volume artifacts fail closed',t=>{
 const {dir,imageDir}=prepared(t),dataDir=volume(dir),options=seedOptions(dataDir,imageDir),file=path.join(dataDir,'runtime-pack.json'),imageFile=path.join(imageDir,'runtime-pack.json');
 fs.symlinkSync(imageFile,file);assert.throws(()=>canary.seedVolume(options));assert(fs.lstatSync(file).isSymbolicLink());fs.unlinkSync(file);
 fs.copyFileSync(imageFile,file);fs.chmodSync(file,0o600);fs.linkSync(file,path.join(dir,'hardlink'));assert.throws(()=>canary.seedVolume(options));
 const linkDir=path.join(dir,'volume-link');fs.symlinkSync(dataDir,linkDir);assert.throws(()=>canary.seedVolume(seedOptions(linkDir,imageDir)),/VOLUME_INVALID/);
});
test('Docker context is an exact source allowlist; final stage imports only immutable package files',()=>{
 const docker=fs.readFileSync(path.join(__dirname,'Dockerfile'),'utf8'),ignore=fs.readFileSync(path.join(__dirname,'Dockerfile.dockerignore'),'utf8');
 const expected=[...CONTENT,...['build.cjs','pack-runtime.cjs','artifact-policy.cjs','bootstrap.cjs','server.cjs','auth.cjs','crm-manager-journal.cjs','crm-manager-provisioning.cjs','crm-manager-coordinator.cjs','crm-manager-dispatcher.cjs','crm-manager-runtime.cjs','crm-manager-attestation.cjs','crm-manager-read-bridge.cjs','crm-campaign-create.cjs','crm-campaign-delivery.cjs','crm-campaign-writer-attestation.cjs','campaign-write-contract.js','campaign-write-tracking.js','crm-campaign-bff-client.cjs','campaign-ui-assets.json','proxy.cjs','backend-credential-attestation.cjs','fixtures.cjs','segment-audience-contract.js','canary-start.cjs','canary-image.cjs'].map(f=>'services/dashboard-operational/'+f),...['entry.html','entry.js','entry.css','guard.js','media-read.js','campaign-edit.js','campaign-edit.compiled.js','campaign-bff-client.js','entry.compiled.js','guard.compiled.js'].map(f=>'services/dashboard-operational/public/'+f)].sort();
 const rules=ignore.split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));assert.equal(rules[0],'**');
 const files=rules.slice(1).filter(l=>!l.endsWith('/')).map(l=>{assert(l.startsWith('!'));assert(!/[?*]/.test(l));return l.slice(1);}).sort();assert.deepEqual(files,expected);
 const stages=docker.split(/^FROM /m).slice(1);assert.equal(stages.length,2);for(const stage of stages)assert(stage.startsWith(IMAGE+' AS '));
 const sourceCopies=[...stages[0].matchAll(/^COPY (.+)$/gm)].flatMap(m=>m[1].split(' ').slice(0,-1)).sort();assert.deepEqual(sourceCopies,expected);
 const runtimeCopies=[...stages[1].matchAll(/^COPY --from=package --chmod=0444 (.+) \.\/$/gm)].flatMap(m=>m[1].split(' ')).sort();assert.deepEqual(runtimeCopies,image.IMAGE_FILES.map(f=>'/image/'+f));
 assert.deepEqual([...docker.matchAll(/^ARG (\S+)$/gm)].map(m=>m[1]),['GIT_SHA','GIT_SHA']);assert.match(stages[1],/^USER 1000:1000$/m);assert.match(stages[1],/"--max-old-space-size=128"/);
 assert.match(stages[1],/org\.opencontainers\.image\.source="https:\/\/github\.com\/bandssz\/shrigma-dash-cx"/);
 assert(!/npm |yarn |pnpm |apk |COPY \.|--mount=type=secret/.test(docker));assert(!expected.some(f=>/\.env|\.git|n8n|\.sql|backup-identity|\.test\./.test(f)));
});
test('real frontend build and closed pack are deterministic from the same sources',t=>{
 const dir=temp(t),pins=[],packages=[];
 for(const n of [1,2]){const dist=path.join(dir,'dist-'+n),out=path.join(dir,'pack-'+n);build(dist);const metadata=pack(dist,out);pins.push(metadata.packSha256);packages.push(fs.readFileSync(path.join(out,'runtime-pack.json')));}
 assert.equal(pins[0],pins[1]);assert.deepEqual(packages[0],packages[1]);assert.equal(policy.decodePack(packages[0].toString(),pins[0]).stats.files,policy.FILES.length);
});
test('startup rejects root or a wrong UID before artifact access and never prints environment secrets',()=>{
 if(process.getuid()===1000&&process.getgid()===1000)return;
 const marker='SYNTHETIC-PRIVATE-MARKER',result=spawnSync(process.execPath,[path.join(__dirname,'canary-start.cjs')],{encoding:'utf8',env:{...process.env,DASHBOARD_ENCRYPTION_KEY:marker,DASHBOARD_MODE:'synthetic'}});
 assert.equal(result.status,1);assert.match(result.stderr,/startup refused/);assert(!result.stdout.includes(marker));assert(!result.stderr.includes(marker));
});
