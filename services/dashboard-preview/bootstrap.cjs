'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const MAX_BYTES=16*1024*1024,MAX_FILES=50;
const PUBLIC_ASSETS=[
 'index.html','growth.html','organico.html','influs.html',
 'cx/index.html','crm/index.html','organico/index.html','creators/index.html','gestao/index.html',
 ...['index','growth','organico','influs'].flatMap(p=>['js','css'].map(e=>`assets/panels/${p}.${e}`)),
 'assets/panels/entry.js','assets/panels/crm-entry.js','assets/panels/entry.css',
 'logos/icone-aristocrata.png','logos/icone-fishermans.svg','logos/icone-olivas.jpg',
 'logos/wm-aristocrata.png','logos/wm-fishermans.png','logos/wm-olivas.png','preview.js','preview.css'
].sort();
function selectPackFile(fsImpl=fs){
 // A mounted preview-only volume is authoritative. Missing/corrupt volume
 // content must not silently fall back to a stale bootstrap seed mount.
 if(!fsImpl.existsSync('/preview-data'))return '/app/assets-pack.json';
 const dir=fsImpl.lstatSync('/preview-data');if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('Invalid preview volume.');
 const file='/preview-data/assets-pack.json';if(!fsImpl.existsSync(file))throw Error('Preview volume is missing its pack.');
 const stat=fsImpl.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid preview volume pack.');
 return file;
}
function unpack(packFile,target,{readFile=fs.readFileSync,expectedSha256=process.env.PREVIEW_PACK_SHA256}={}){
 const input=readFile(packFile,'utf8');if(input.length>2*1024*1024)throw Error('Oversize pack.');
 const wrapper=JSON.parse(input);
 if(wrapper.schema!=='shrigma_preview_pack_v2'||Object.keys(wrapper).sort().join(',')!=='gzipBase64,schema,sha256'||!/^[a-f0-9]{64}$/.test(wrapper.sha256)||typeof wrapper.gzipBase64!=='string'||!/^[A-Za-z0-9+/=]+$/.test(wrapper.gzipBase64))throw Error('Invalid pack.');
 if(expectedSha256!==undefined&&(!/^[a-f0-9]{64}$/.test(expectedSha256)||expectedSha256!==wrapper.sha256))throw Error('Unexpected preview pack revision.');
 const raw=zlib.gunzipSync(Buffer.from(wrapper.gzipBase64,'base64'),{maxOutputLength:MAX_BYTES});
 if(crypto.createHash('sha256').update(raw).digest('hex')!==wrapper.sha256)throw Error('Pack checksum mismatch.');
 const files=JSON.parse(raw);if(!Array.isArray(files)||files.length<1||files.length>MAX_FILES)throw Error('Invalid pack count.');
 const seen=new Set();let total=0;
 for(const f of files){
  if(!f||Object.keys(f).sort().join(',')!=='content,encoding,path'||typeof f.path!=='string'||f.path.length>128||!/^\/?(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+\.(?:html|js|css|png|jpg|svg)$/.test(f.path)||f.path.startsWith('/')||f.path.split('/').some(p=>p==='.'||p==='..'||p.startsWith('.'))||seen.has(f.path)||typeof f.content!=='string')throw Error('Invalid pack asset.');
  const text=/\.(?:html|js|css|svg)$/.test(f.path);
  if(f.encoding!==(text?'utf8':'base64')||!text&&!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.content))throw Error('Invalid asset encoding.');
  const buf=Buffer.from(f.content,f.encoding);total+=buf.length;if(total>MAX_BYTES)throw Error('Oversize unpack.');seen.add(f.path);
 }
 if(JSON.stringify([...seen].sort())!==JSON.stringify(PUBLIC_ASSETS))throw Error('Pack assets differ from the closed public allowlist.');
 fs.mkdirSync(target,{recursive:true});
 for(const f of files){const dest=path.resolve(target,f.path);if(!dest.startsWith(path.resolve(target)+path.sep))throw Error('Invalid destination.');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,Buffer.from(f.content,f.encoding),{flag:'wx',mode:0o600});}
 return {files:files.length,bytes:total};
}
if(require.main===module){
 try{
  // Fail closed BEFORE decompressing, binding the socket or creating assets.
  const runtime=require('./server.cjs');runtime.config();
  const dir=fs.mkdtempSync('/tmp/shrigma-preview-');unpack(selectPackFile(),dir);
  process.env.PREVIEW_PUBLIC_DIR=dir;const cfg=runtime.config();
  runtime.createServer(cfg).listen(cfg.port,cfg.host,()=>console.log('Synthetic read-only preview listening; external integrations disabled.'));
 }catch(_){console.error('Preview bootstrap refused: invalid isolation, access or asset pack.');process.exitCode=1;}
}
module.exports={unpack,selectPackFile,PUBLIC_ASSETS};
