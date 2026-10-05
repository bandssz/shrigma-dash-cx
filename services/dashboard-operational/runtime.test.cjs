'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),http=require('node:http');
const {spawnSync}=require('node:child_process');
const policy=require('./artifact-policy.cjs'),boot=require('./bootstrap.cjs'),{pack}=require('./pack-runtime.cjs');
const {build}=require('./build.cjs'),{readOnlyStyles}=require('./public/entry.js');
function temp(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-runtime-test-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function source(t){const dir=temp(t),dist=path.join(dir,'dist');fs.mkdirSync(path.join(dist,'public'),{recursive:true});
 for(const file of policy.PUBLIC_FILES){const to=path.join(dist,'public',file);fs.mkdirSync(path.dirname(to),{recursive:true});fs.writeFileSync(to,policy.isText(file)?'<!doctype html>TEST SYNTHETIC '+file:Buffer.from([0,255,1,2,3]));}
 return {dir,dist};}
function mutatePack(input,change){const old=JSON.parse(input),files=policy.decodePack(input,old.sha256).files;change(files);const raw=Buffer.from(JSON.stringify(files)),sha256=policy.sha(raw);return {input:JSON.stringify({schema:policy.SCHEMA,sha256,gzipBase64:zlib.gzipSync(raw).toString('base64')}),sha256};}
test('closed public/runtime package roundtrip preserves all bytes and stays below MCP transport limit',t=>{
 const {dir,dist}=source(t),out=path.join(dir,'pack'),meta=pack(dist,out),input=fs.readFileSync(path.join(out,'runtime-pack.json'),'utf8');
 assert.equal(meta.publicFiles,policy.PUBLIC_FILES.length);assert.equal(meta.runtimeFiles,policy.RUNTIME_FILES.length);assert(meta.seedMountsBytes<950000);
 const result=policy.unpack(path.join(out,'runtime-pack.json'),path.join(dir,'unpacked'),{expectedSha256:meta.packSha256});
 assert.equal(result.files,policy.FILES.length);assert.equal(result.sha256,meta.packSha256);
 for(const file of policy.PUBLIC_FILES)assert.deepEqual(fs.readFileSync(path.join(result.publicDir,file)),fs.readFileSync(path.join(dist,'public',file)));
 for(const file of policy.RUNTIME_FILES)assert.deepEqual(fs.readFileSync(path.join(result.runtimeDir,file)),fs.readFileSync(path.join(__dirname,file)));
 assert.equal(JSON.parse(fs.readFileSync(path.join(out,'mounts.json'))).length,2);
 assert.equal(JSON.parse(fs.readFileSync(path.join(out,'seed-mounts.json'))).length,3);
 assert.throws(()=>pack(dist,out),/DESTINATION/);assert.throws(()=>policy.decodePack(input),/PIN_REQUIRED/);
});
test('source allowlist rejects secrets, SQLite, extra code and symlink assets',t=>{
 const {dir,dist}=source(t),privateFile=path.join(dist,'public','.env');fs.writeFileSync(privateFile,'SYNTHETIC=1');
 assert.throws(()=>pack(dist,path.join(dir,'out')),/ALLOWLIST/);fs.unlinkSync(privateFile);
 const binary=path.join(dist,'public',policy.PUBLIC_FILES.find(f=>f.endsWith('.png')));fs.unlinkSync(binary);fs.symlinkSync(path.join(dist,'public','growth.html'),binary);
 assert.throws(()=>pack(dist,path.join(dir,'out')),/SYMLINK/);
});
test('checksum, revision pin, exact paths, duplicates and encoding are enforced before extraction',t=>{
 const {dir,dist}=source(t),meta=pack(dist,path.join(dir,'pack')),input=fs.readFileSync(path.join(dir,'pack','runtime-pack.json'),'utf8');
 assert.throws(()=>policy.decodePack(input,'0'.repeat(64)),/PACK_INVALID/);
 const checksum=JSON.parse(input);checksum.brotliBase64=zlib.brotliCompressSync(Buffer.from('[]')).toString('base64');
 assert.throws(()=>policy.decodePack(JSON.stringify(checksum),meta.packSha256),/CHECKSUM/);
 for(const edit of [f=>f[0].path='../secret.cjs',f=>f[0].path=f[1].path,f=>f[0].encoding='base64',f=>f.pop(),f=>f[0].content+='\ud800']){
  const changed=mutatePack(input,edit);assert.throws(()=>policy.decodePack(changed.input,changed.sha256));
 }
 const packed=JSON.parse(input);packed.brotliBase64+='\n';assert.throws(()=>policy.decodePack(JSON.stringify(packed),meta.packSha256));
});
test('gzip bombs and oversized envelopes are rejected',()=>{
 const raw=Buffer.alloc(policy.MAX_BYTES+1,65),sha256=policy.sha(raw),input=JSON.stringify({schema:policy.SCHEMA,sha256,gzipBase64:zlib.gzipSync(raw).toString('base64')});
 assert.throws(()=>policy.decodePack(input,sha256));assert.throws(()=>policy.decodePack(' '.repeat(policy.MAX_PACK_BYTES+1),'a'.repeat(64)),/TOO_LARGE/);
});
test('extraction never replaces existing targets and rejects symlink pack files',t=>{
 const {dir,dist}=source(t),meta=pack(dist,path.join(dir,'pack')),file=path.join(dir,'pack','runtime-pack.json'),target=path.join(dir,'existing');
 fs.mkdirSync(target);fs.writeFileSync(path.join(target,'sentinel'),'untouched');
 assert.throws(()=>policy.unpack(file,target,{expectedSha256:meta.packSha256}),/TARGET_EXISTS/);assert.equal(fs.readFileSync(path.join(target,'sentinel'),'utf8'),'untouched');
 const link=path.join(dir,'pack-link');fs.symlinkSync(file,link);assert.throws(()=>policy.unpack(link,path.join(dir,'out'),{expectedSha256:meta.packSha256}),/PACK_FILE/);
});
test('volume pack is authoritative and a missing/unsafe volume never falls back to seed',t=>{
 const dir=temp(t),dataDir=path.join(dir,'volume'),seedFile=path.join(dir,'seed');fs.writeFileSync(seedFile,'seed');
 assert.equal(boot.selectPackFile({dataDir,seedFile}),seedFile);fs.mkdirSync(dataDir,{mode:0o700});
 assert.throws(()=>boot.selectPackFile({dataDir,seedFile}),/PACK_MISSING/);const file=path.join(dataDir,'runtime-pack.json');fs.writeFileSync(file,'volume');
 assert.equal(boot.selectPackFile({dataDir,seedFile}),file);fs.unlinkSync(file);fs.symlinkSync(seedFile,file);assert.throws(()=>boot.selectPackFile({dataDir,seedFile}),/PACK_INVALID/);
});
test('UID/GID, private writable storage and fixed SQLite path fail closed',t=>{
 assert.deepEqual(boot.checkIdentity({uid:1000,gid:1000}),{uid:1000,gid:1000});assert.throws(()=>boot.checkIdentity({uid:0,gid:1000}));assert.throws(()=>boot.checkIdentity({uid:1000,gid:0}));
 const dir=temp(t),dataDir=path.join(dir,'data');fs.mkdirSync(dataDir,{mode:0o700});const uid=process.getuid();
 assert.equal(boot.checkStorage({dataDir,expectedUid:uid}),path.join(dataDir,'dashboard.sqlite'));
 fs.chmodSync(dataDir,0o755);assert.throws(()=>boot.checkStorage({dataDir,expectedUid:uid}),/VOLUME_INVALID/);fs.chmodSync(dataDir,0o700);
 const db=path.join(dataDir,'dashboard.sqlite');fs.writeFileSync(db,'synthetic',{mode:0o644});assert.throws(()=>boot.checkStorage({dataDir,expectedUid:uid}),/DATABASE_INVALID/);fs.chmodSync(db,0o600);
 assert.equal(boot.checkStorage({dataDir,expectedUid:uid}),db);
 const valid={DASHBOARD_MODE:'synthetic',DASHBOARD_PACK_SHA256:'a'.repeat(64)};
 assert.equal(boot.pinnedEnv(valid).DASHBOARD_DB_PATH,boot.DB_FILE);
 for(const patch of [{DASHBOARD_MODE:'production'},{DASHBOARD_DB_PATH:':memory:'},{DASHBOARD_EXPECT_UID:'0'},{DASHBOARD_EXPECT_GID:'0'},{DASHBOARD_PACK_SHA256:''}])assert.throws(()=>boot.pinnedEnv({...valid,...patch}));
});
test('CLI refuses a wrong runtime identity without echoing environment secrets',()=>{
 if(process.getuid()===1000&&process.getgid()===1000)return;
 const secret=crypto.randomBytes(32).toString('hex'),result=spawnSync(process.execPath,[path.join(__dirname,'bootstrap.cjs')],{encoding:'utf8',env:{...process.env,DASHBOARD_ENCRYPTION_KEY:secret}});
 assert.equal(result.status,1);assert(!result.stdout.includes(secret));assert(!result.stderr.includes(secret));assert.match(result.stderr,/startup refused/);
});
test('extracted actual runtime serves health and entry, denies panel/API without session and persists SQLite identity',async t=>{
 const {dir,dist}=source(t),meta=pack(dist,path.join(dir,'pack')),artifact=policy.unpack(path.join(dir,'pack','runtime-pack.json'),path.join(dir,'artifact'),{expectedSha256:meta.packSha256});
 const {createAuth}=require(path.join(artifact.runtimeDir,'auth.cjs')),{settingsFromEnv,createServer}=require(path.join(artifact.runtimeDir,'server.cjs'));
 const dataDir=path.join(dir,'identity');fs.mkdirSync(dataDir,{mode:0o700});const dbPath=boot.checkStorage({dataDir,expectedUid:process.getuid()});
 const s=settingsFromEnv({DASHBOARD_MODE:'synthetic',DASHBOARD_MANAGER_HOST:'manager.synthetic.invalid',DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'}),DASHBOARD_EMAIL_DOMAINS:'["synthetic.invalid"]',DASHBOARD_PUBLIC_DIR:artifact.publicDir,DASHBOARD_DB_PATH:dbPath,DASHBOARD_ADMIN_EMAIL:'admin@synthetic.invalid',DASHBOARD_BOOTSTRAP_SHA256:crypto.randomBytes(32).toString('hex'),DASHBOARD_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex')});
 const options={dbPath,managerHost:s.managerHost,areaHosts:s.areaHosts,allowedEmailDomains:s.allowedEmailDomains,bootstrapAdminEmail:s.bootstrapAdminEmail,bootstrapTokenSha256:s.bootstrapTokenSha256,encryptionKey:s.encryptionKey};
 const auth=createAuth(options),server=createServer(s,{auth});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(()=>{auth.close();r();})));
 const request=pathname=>new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port:server.address().port,path:pathname,headers:{Host:s.managerHost}},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,body}));}).on('error',reject);});
 const health=await request('/healthz');assert.equal(health.status,200);assert.equal(JSON.parse(health.body).mode,'synthetic');
 assert.equal((await request('/')).status,200);assert.equal((await request('/growth.html')).status,401);assert.equal((await request('/api/crm-read?action=identity&painel=growth')).status,401);
 assert.equal(fs.statSync(dbPath).mode&0o777,0o600);
 const {DatabaseSync}=require('node:sqlite'),database=new DatabaseSync(dbPath);const count=database.prepare('SELECT count(*) n FROM users').get().n;database.close();assert.equal(count,1);
 const reopened=createAuth(options);reopened.close();const again=new DatabaseSync(dbPath);assert.equal(again.prepare('SELECT count(*) n FROM users').get().n,count);again.close();
});
test('extracted runtime serves read-only presentation on direct panel URLs',async t=>{
 const dir=temp(t),dist=path.join(dir,'dist');build(dist);
 const meta=pack(dist,path.join(dir,'pack'));
 const artifact=policy.unpack(path.join(dir,'pack','runtime-pack.json'),path.join(dir,'artifact'),{expectedSha256:meta.packSha256});
 const {createServer}=require(path.join(artifact.runtimeDir,'server.cjs'));
 const areaHosts={growth:'crm.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'};
 const {AuthError}=require(path.join(artifact.runtimeDir,'auth.cjs'));
 const auth={authorize:ctx=>{if(ctx.cookieHeader!=='synthetic-session')throw new AuthError('SESSION_REQUIRED',401);return {role:'manager',areas:[ctx.area]};}};
 const server=createServer({mode:'synthetic',managerHost:'manager.synthetic.invalid',areaHosts,upstreams:{},publicDir:artifact.publicDir},{auth});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 for(const [area,host]of Object.entries(areaHosts)){
  const result=await new Promise((resolve,reject)=>{
   const req=http.get({hostname:'127.0.0.1',port:server.address().port,path:'/'+area+'.html',headers:{Host:host,Cookie:'synthetic-session'}},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,html:Buffer.concat(chunks).toString('utf8')}));
   });req.on('error',reject);
  });
  assert.equal(result.status,200,area);
  const style=result.html.match(/<style id="dashboard-operational-readonly">([\s\S]*?)<\/style>/);
  assert.ok(style,area);assert.equal(style[1],readOnlyStyles(area,{embeddedOnly:false}));
  assert.equal(result.headers['content-security-policy'],result.html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1]);
 }
 const get=(host,pathname,cookie)=>new Promise((resolve,reject)=>{
  http.get({hostname:'127.0.0.1',port:server.address().port,path:pathname,headers:{Host:host,...(cookie?{Cookie:cookie}:{})}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
  }).on('error',reject);
 });
 const crmPage=await get(areaHosts.growth,'/growth.html','synthetic-session');
 assert.equal(crmPage.status,200);
 for(const file of ['entry.js','guard.js','campaign-edit.js','campaign-bff-client.js']){
  const asset=await get(areaHosts.growth,'/'+file);assert.equal(asset.status,200,file);
  assert.equal(asset.body,fs.readFileSync(path.join(artifact.publicDir,file),'utf8'),file);
 }
 for(const file of ['campaign-edit.compiled.js','entry.compiled.js','guard.compiled.js','campaign-ui-assets.json'])assert.equal((await get(areaHosts.growth,'/'+file)).status,404,file);
 const diagnosticLink=crmPage.body.match(/href="(\/growth-diagnostico\.html)">Diagnóstico de pedido pago<\/a>/)?.[1];
 assert.equal(diagnosticLink,'/growth-diagnostico.html');
 const navigated=await get(areaHosts.growth,diagnosticLink,'synthetic-session');
 assert.equal(navigated.status,200);assert.match(navigated.body,/href="growth\.html">Voltar ao Growth<\/a>/);
 assert.equal((await get(areaHosts.growth,'/growth.html','synthetic-session')).status,200);
 for(const host of ['manager.synthetic.invalid',areaHosts.growth]){
  assert.equal((await get(host,'/growth-diagnostico.html')).status,401,host);
  const page=await get(host,'/growth-diagnostico.html','synthetic-session');
  assert.equal(page.status,200,host);assert.match(page.body,/Diagnóstico de pedido pago/);
  assert.equal((await get(host,'/growth-diagnostic-ui.js')).status,200,host);
 }
 for(const host of [areaHosts.organico,areaHosts.influs]){
  assert.equal((await get(host,'/growth-diagnostico.html','synthetic-session')).status,404,host);
  assert.equal((await get(host,'/growth-diagnostic-ui.js')).status,404,host);
 }
});
