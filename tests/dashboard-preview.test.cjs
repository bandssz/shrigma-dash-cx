'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const {build,FILES}=require('../services/dashboard-preview/build.cjs');
const {config,createServer}=require('../services/dashboard-preview/server.cjs');
const {pack}=require('../services/dashboard-preview/pack-runtime.cjs');
const {unpack,selectPackFile}=require('../services/dashboard-preview/bootstrap.cjs');
const zlib=require('node:zlib');
const vm=require('node:vm');
// Fixture codec follows the closed wrapper actually emitted; security assertions stay unchanged.
const packRaw=wrapper=>{assert.ok(['shrigma_preview_pack_v2','shrigma_preview_pack_v3'].includes(wrapper.schema));return wrapper.schema==='shrigma_preview_pack_v2'?zlib.gunzipSync(Buffer.from(wrapper.gzipBase64,'base64')):zlib.brotliDecompressSync(Buffer.from(wrapper.brotliBase64,'base64'));};
const reencode=(wrapper,raw)=>({...wrapper,sha256:crypto.createHash('sha256').update(raw).digest('hex'),...(wrapper.schema==='shrigma_preview_pack_v2'?{gzipBase64:zlib.gzipSync(raw).toString('base64')}:{brotliBase64:zlib.brotliCompressSync(raw).toString('base64')})});
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-preview-test-')),dist=path.join(tmp,'dist');
const keys={master:'synthetic-master-12345',cx:'synthetic-cx-12345',growth:'synthetic-growth-12345',organico:'synthetic-organico-12345',influs:'synthetic-influs-12345'};
const hashes=Object.fromEntries(Object.entries(keys).map(([scope,key])=>[crypto.createHash('sha256').update(key).digest('hex'),scope]));
const env={NODE_ENV:'preview',PREVIEW_MODE:'synthetic',PREVIEW_ACCESS_HASHES:JSON.stringify(hashes),PORT:'0',PREVIEW_PUBLIC_DIR:path.join(dist,'public')};
let server,origin;
test.before(async()=>{build(dist);server=createServer(config(env));await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;});
test.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
const req=(p,scope='master',options={})=>fetch(origin+p,{...options,headers:{...(scope?{Authorization:'Bearer '+(keys[scope]||scope)}:{}),...options.headers}});
test('startup refuses missing credentials, integration config and production',()=>{
 for(const bad of [{...env,PREVIEW_ACCESS_HASHES:''},{...env,PREVIEW_MODE:'production'},{...env,NODE_ENV:'production'},{...env,DATABASE_URL:'postgres://invalid'},{...env,SHOPIFY_TOKEN:'invalid'},{...env,PREVIEW_EXPECT_UID:'99999999'},{...env,PREVIEW_ACCESS_HASHES:JSON.stringify({key:'master'})}])assert.throws(()=>config(bad));
});
test('artifact has only allowlisted assets, no original integration endpoints, valid inline hashes',()=>{
 const files=[];const walk=(dir)=>{for(const f of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,f.name);if(f.isDirectory())walk(p);else files.push(path.relative(path.join(dist,'public'),p));}};walk(path.join(dist,'public'));
 assert.deepEqual(files.sort(),[...FILES,'preview.js','preview.css'].sort());
 for(const file of files.filter(f=>/\.(?:html|js|css)$/.test(f))){const text=fs.readFileSync(path.join(dist,'public',file),'utf8');assert.doesNotMatch(text,/https:\/\/(?:n8n|comunicacao-crm-)/,file);if(file.endsWith('.html')){assert.match(text,/TESTE — dados sintéticos — escrita bloqueada/);assert.match(text,/connect-src 'self'/);for(const m of text.matchAll(/<script\s*>([\s\S]*?)<\/script>/g))assert.ok(text.includes("'sha256-"+crypto.createHash('sha256').update(m[1]).digest('base64')+"'"),file);}}
});
test('health and HTML security headers contain no secrets',async()=>{
 const h=await req('/healthz',null);assert.equal(h.status,200);assert.deepEqual(await h.json(),{ok:true,mode:'synthetic-read-only',externalIntegrations:false,writes:false,production:false,runtimeUid:process.getuid(),runtimeGid:process.getgid()});
 const r=await req('/');assert.equal(r.status,200);assert.equal(r.headers.get('Referrer-Policy'),'no-referrer');assert.equal(r.headers.get('Cache-Control'),'no-store');assert.match(r.headers.get('Content-Security-Policy'),/frame-ancestors 'self'/);assert.match(r.headers.get('Content-Security-Policy'),/connect-src 'self'/);
});
test('identities grant only read and reject cross-area access',async()=>{
 for(const [scope,key]of Object.entries(keys)){const area=scope==='master'?'todos':scope;const r=await req('/preview-api/cx?access=1&painel='+area,scope);assert.equal(r.status,200);const i=await r.json();assert.equal(i.schema,'shrigma_access_identity_v1');assert.deepEqual(i.allowedPanels,scope==='master'?['cx','growth','organico','influs']:[scope]);for(const p of Object.values(i.permissions))assert.deepEqual(p.caps,['read']);assert.ok(!JSON.stringify(i).includes(key));}
  assert.equal((await req('/preview-api/cx?access=1&painel=todos','cx')).status,403);assert.equal((await req('/preview-api/crm-read?action=cache_growth','cx')).status,403);
 assert.equal((await req('/preview-api/cx?access=1&painel=todos','master',{headers:{Origin:'https://synthetic-untrusted.invalid'}})).status,403);
 for(const scope of [null,'wrong-access-12345'])assert.equal((await req('/preview-api/cache?painel=cx',scope)).status,401);
});
test('every API fixture is synthetic and mutations including GET are denied',async()=>{
 for(const [route,query]of [['cx','painel=cx'],['cache','painel=organico'],['crm-read','action=cache_growth'],['influ','acao=listar&ini=2026-09-01&fim=2026-09-30'],['tts','acao=listar&ini=2026-09-01&fim=2026-09-30'],['tts-cobranca','acao=ler'],['organico-links','acao=listar'],['escopo','acao=ler&mes=2026-09'],['candidaturas','acao=ler'],['aprovacao','acao=ler']]){const r=await req('/preview-api/'+route+'?'+query);assert.equal(r.status,200,route);const j=await r.json();assert.equal(j.synthetic,true);assert.equal(j.pode_escrever,false);}
 for(const route of ['cx','cache','crm-read','influ','tts','tts-cobranca','organico-links','escopo','candidaturas','aprovacao','ab-blocked','tts-blocked']){
  for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await req('/preview-api/'+route,'master',{method,body:'{}'})).status,403,method+' '+route);
  for(const action of ['salvar','enviar','revisar','aprovar','encerrar','sync','unknown'])for(const field of ['acao','action'])assert.equal((await req('/preview-api/'+route+'?'+field+'='+action)).status,403,route+' '+action);
 }
 assert.equal((await req('/preview-api/influ?acao=listar&action=salvar')).status,403);assert.equal((await req('/preview-api/influ?acao=listar&acao=salvar')).status,403);assert.equal((await req('/preview-api/influ?acao=listar&k=forbidden')).status,403);
});
test('browser guard rewrites only explicit read POSTs to local GET and never puts keys in URL',async()=>{
 const calls=[],browser={fetch:async(url,init)=>{calls.push({url,init});return new Response('{}',{status:200});},open:()=>null};
 const context={window:browser,location:new URL('https://preview.synthetic.invalid/creators/'),document:{addEventListener:()=>{}},navigator:{},URL,Request,Response,Headers,Set,JSON,Promise};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../services/dashboard-preview/preview.js'),'utf8'),context);
 for(const [route,body]of [['escopo',{acao:'ler',mes:'2026-09',k:keys.influs}],['influ',{acao:'listar',ini:'2026-09-01',fim:'2026-09-30'}],['tts',{ini:'2026-09-01',fim:'2026-09-30'}]]){const r=await browser.fetch('/preview-api/'+route,{method:'POST',body:JSON.stringify(body),headers:{Authorization:'Bearer '+keys.influs}});assert.equal(r.status,200);const call=calls.at(-1);assert.equal(call.init.method,'GET');assert.equal(call.init.body,undefined);assert.equal(call.init.headers.get('Authorization'),'Bearer '+keys.influs);assert.ok(call.url.startsWith('https://preview.synthetic.invalid/preview-api/'));assert.ok(!call.url.includes(keys.influs));}
 const count=calls.length;for(const [url,init]of [['https://external.synthetic.invalid/read',{}],['/preview-api/tts-blocked?acao=capacidades',{}],['/preview-api/ab-blocked?action=identity',{}],['/preview-api/escopo',{method:'POST',body:JSON.stringify({acao:'salvar',k:keys.influs})}],['/preview-api/tts',{method:'POST',body:JSON.stringify({acao:'revisar',k:keys.influs})}],['/preview-api/influ',{method:'DELETE'}]])assert.equal((await browser.fetch(url,init)).status,403);assert.equal(calls.length,count);
});
test('traversal, private artifacts and unlisted runtime files cannot be served',async()=>{
 for(const file of ['/server.cjs','/fixtures.cjs','/.git/config','/config.js','/n8n/api_patch_agente.py','/docs/README.md','/artifact-manifest.json'])assert.equal((await req(file)).status,404,file);
 for(const file of ['/%2e%2e%2fserver.cjs','/%252e%252e%252fserver.cjs','/logos/..%2fserver.cjs']){const status=await new Promise((resolve,reject)=>http.get(origin+file,r=>{r.resume();resolve(r.statusCode);}).on('error',reject));assert.equal(status,400,file);}
 const outside=path.join(tmp,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'private.js'),'private');fs.symlinkSync(outside,path.join(dist,'public','untrusted'));assert.equal((await req('/untrusted/private.js')).status,404);fs.unlinkSync(path.join(dist,'public','untrusted'));
});
test('mount pack roundtrips public allowlist and rejects corruption/traversal',()=>{
 const target=path.join(tmp,'mounts'),dest=path.join(tmp,'unpack');const result=pack(dist,target);assert.ok(result.mountsJsonBytes<950000);assert.equal(JSON.parse(fs.readFileSync(path.join(target,'mounts.json'))).length,4);const restored=unpack(path.join(target,'assets-pack.json'),dest);assert.equal(restored.files,FILES.length+2);for(const file of [...FILES,'preview.js','preview.css'])assert.deepEqual(fs.readFileSync(path.join(dest,file)),fs.readFileSync(path.join(dist,'public',file)),file);
 const bad=path.join(tmp,'bad-pack.json'),data=JSON.parse(fs.readFileSync(path.join(target,'assets-pack.json')));data.sha256='0'.repeat(64);fs.writeFileSync(bad,JSON.stringify(data));assert.throws(()=>unpack(bad,path.join(tmp,'bad')));
 const original=JSON.parse(fs.readFileSync(path.join(target,'assets-pack.json'))),listed=JSON.parse(packRaw(original));listed[0].path='credentials.js';const raw=Buffer.from(JSON.stringify(listed));fs.writeFileSync(bad,JSON.stringify(reencode(original,raw)));assert.throws(()=>unpack(bad,path.join(tmp,'bad-allowlist')),/closed public allowlist/);
 const wrongEncoding=JSON.parse(packRaw(original));wrongEncoding.find(f=>f.path.endsWith('.png')).encoding='utf8';const encoded=Buffer.from(JSON.stringify(wrongEncoding));fs.writeFileSync(bad,JSON.stringify(reencode(original,encoded)));assert.throws(()=>unpack(bad,path.join(tmp,'bad-encoding')),/Invalid asset encoding/);
});
test('bootstrap chooses only fixed volume/seed paths, reads the copied volume pack and enforces its revision',()=>{
 assert.equal(selectPackFile({existsSync:()=>false}),'/app/assets-pack.json');
 const volumePath='/preview-data/assets-pack.json',present={existsSync:p=>['/preview-data',volumePath].includes(p),lstatSync:p=>({isDirectory:()=>p==='/preview-data',isFile:()=>p===volumePath,isSymbolicLink:()=>false})};
 assert.equal(selectPackFile(present),volumePath);
 assert.throws(()=>selectPackFile({...present,existsSync:p=>p==='/preview-data'}),/missing its pack/);
 assert.throws(()=>selectPackFile({...present,lstatSync:()=>({isDirectory:()=>true,isFile:()=>true,isSymbolicLink:()=>true})}),/Invalid preview volume/);
 const copied=path.join(tmp,'copied-volume-pack.json');fs.copyFileSync(path.join(tmp,'mounts','assets-pack.json'),copied);const wrapper=JSON.parse(fs.readFileSync(copied));let reads=0;
 const readFile=(file,encoding)=>{assert.equal(file,volumePath);reads++;return fs.readFileSync(copied,encoding);};
 const result=unpack(selectPackFile(present),path.join(tmp,'from-volume'),{readFile,expectedSha256:wrapper.sha256});assert.equal(reads,1);assert.equal(result.files,28);assert.deepEqual(fs.readFileSync(path.join(tmp,'from-volume','preview.js')),fs.readFileSync(path.join(dist,'public','preview.js')));
 assert.throws(()=>unpack(selectPackFile(present),path.join(tmp,'wrong-revision'),{readFile,expectedSha256:'0'.repeat(64)}),/Unexpected preview pack revision/);
});

// Directly affected codec controls: built-in only, real decompression/filesystem, synthetic data.
test('Brotli v3 and legacy gzip v2 restore exactly the same public bytes and raw revision',()=>{
 const packed=JSON.parse(fs.readFileSync(path.join(tmp,'mounts','assets-pack.json'),'utf8')),raw=packRaw(packed);
 for(const [schema,field,compressed] of [['shrigma_preview_pack_v2','gzipBase64',zlib.gzipSync(raw)],['shrigma_preview_pack_v3','brotliBase64',zlib.brotliCompressSync(raw)]]){
  const file=path.join(tmp,schema+'.json'),out=path.join(tmp,schema);fs.writeFileSync(file,JSON.stringify({schema,sha256:packed.sha256,[field]:compressed.toString('base64')}));
  assert.equal(unpack(file,out,{expectedSha256:packed.sha256}).files,FILES.length+2);
  for(const name of [...FILES,'preview.js','preview.css'])assert.deepEqual(fs.readFileSync(path.join(out,name)),fs.readFileSync(path.join(dist,'public',name)),name);
 }
});
test('Brotli v3 refuses mixed/foreign wrapper fields, corruption and excessive decoded bytes before writing',()=>{
 const packed=JSON.parse(fs.readFileSync(path.join(tmp,'mounts','assets-pack.json'),'utf8')),raw=packRaw(packed),compressed=zlib.brotliCompressSync(raw);
 const base={schema:'shrigma_preview_pack_v3',sha256:packed.sha256,brotliBase64:compressed.toString('base64')};
 const tooLarge=Buffer.alloc(16*1024*1024+1,97);
 const bad=[{...base,gzipBase64:zlib.gzipSync(raw).toString('base64')},{...base,schema:'shrigma_preview_pack_v2'},{...base,brotliBase64:compressed.subarray(0,8).toString('base64')},{...base,sha256:'0'.repeat(64)},{...base,sha256:crypto.createHash('sha256').update(tooLarge).digest('hex'),brotliBase64:zlib.brotliCompressSync(tooLarge).toString('base64')}];
 for(let i=0;i<bad.length;i++){const file=path.join(tmp,'br-bad-'+i+'.json'),out=path.join(tmp,'br-bad-'+i);fs.writeFileSync(file,JSON.stringify(bad[i]));assert.throws(()=>unpack(file,out),i===4?{code:'ERR_BUFFER_TOO_LARGE'}:undefined);assert.equal(fs.existsSync(out),false);}
});
test('Brotli v3 refuses traversal and removed/extra public assets without relaxing the allowlist',()=>{
 const packed=JSON.parse(fs.readFileSync(path.join(tmp,'mounts','assets-pack.json'),'utf8')),original=JSON.parse(packRaw(packed));
 const changed=[original.map((f,i)=>i===0?{...f,path:'../index.html'}:f),original.slice(1),[...original,{path:'extra.js',encoding:'utf8',content:'synthetic-only'}]];
 for(let i=0;i<changed.length;i++){const raw=Buffer.from(JSON.stringify(changed[i])),file=path.join(tmp,'br-path-'+i+'.json'),out=path.join(tmp,'br-path-'+i);fs.writeFileSync(file,JSON.stringify({schema:'shrigma_preview_pack_v3',sha256:crypto.createHash('sha256').update(raw).digest('hex'),brotliBase64:zlib.brotliCompressSync(raw).toString('base64')}));assert.throws(()=>unpack(file,out));assert.equal(fs.existsSync(out),false);}
});
test('Brotli fallback still refuses a transport above 950000 bytes without partial runtime output',()=>{
 const huge=path.join(tmp,'huge'),out=path.join(tmp,'huge-pack');fs.mkdirSync(huge);fs.cpSync(path.join(dist,'public'),path.join(huge,'public'),{recursive:true});
 // Deterministic high-entropy synthetic bytes; no record/provider/real image.
 const bytes=Buffer.alloc(2*1024*1024);for(let i=0;i<bytes.length;i+=32)crypto.createHash('sha256').update('synthetic-pack-budget:'+i).digest().copy(bytes,i);
 fs.writeFileSync(path.join(huge,'public','logos/icone-aristocrata.png'),bytes);assert.throws(()=>pack(huge,out),/950 KB transport safety budget/);assert.deepEqual(fs.readdirSync(out),[]);
});
