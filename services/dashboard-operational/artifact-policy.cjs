'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const SCHEMA='shrigma_dashboard_operational_pack_v1';
const MAX_BYTES=16*1024*1024,MAX_PACK_BYTES=950000;
const PUBLIC_FILES=Object.freeze([
 'growth.html','organico.html','influs.html',
 'growth-diagnostico.html','growth-control.js','growth-delivery.js','growth-diagnostic.js','growth-diagnostic-ui.js',
 ...['growth','organico','influs'].flatMap(p=>['js','css'].map(e=>`assets/panels/${p}.${e}`)),
 'logos/icone-aristocrata.png','logos/icone-fishermans.svg','logos/icone-olivas.jpg',
 'logos/wm-aristocrata.png','logos/wm-fishermans.png','logos/wm-olivas.png',
 'crm/index.html','organico/index.html','creators/index.html','gestao/index.html',
 'entry.js','entry.css','guard.js','media-read.js'
].sort());
const RUNTIME_FILES=Object.freeze(['server.cjs','auth.cjs','crm-manager-journal.cjs','proxy.cjs','backend-credential-attestation.cjs','fixtures.cjs','segment-audience-contract.js'].sort());
const FILES=Object.freeze([...PUBLIC_FILES.map(f=>'public/'+f),...RUNTIME_FILES.map(f=>'runtime/'+f)].sort());
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const exact=(object,keys)=>object&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).sort().join(',')===keys.slice().sort().join(',');
const canonicalBase64=value=>typeof value==='string'&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)&&Buffer.from(value,'base64').toString('base64')===value;
function isText(file){return /\.(?:html|js|css|svg|cjs)$/.test(file);}
function validateFiles(files){
 if(!Array.isArray(files)||files.length!==FILES.length)throw Error('ARTIFACT_FILES_INVALID');
 const seen=new Set();let bytes=0,publicBytes=0,runtimeBytes=0;
 for(const f of files){
  if(!exact(f,['path','encoding','content'])||typeof f.path!=='string'||!FILES.includes(f.path)||seen.has(f.path)||typeof f.content!=='string')throw Error('ARTIFACT_FILE_INVALID');
  const text=isText(f.path);
  if(f.encoding!==(text?'utf8':'base64')||!text&&!canonicalBase64(f.content))throw Error('ARTIFACT_ENCODING_INVALID');
  const buffer=Buffer.from(f.content,f.encoding);
  if(text&&buffer.toString('utf8')!==f.content)throw Error('ARTIFACT_UTF8_INVALID');
  bytes+=buffer.length;f.path.startsWith('public/')?publicBytes+=buffer.length:runtimeBytes+=buffer.length;
  if(bytes>MAX_BYTES)throw Error('ARTIFACT_BYTES_INVALID');seen.add(f.path);
 }
 if(JSON.stringify([...seen].sort())!==JSON.stringify(FILES))throw Error('ARTIFACT_ALLOWLIST_INVALID');
 return {files:files.length,publicFiles:PUBLIC_FILES.length,runtimeFiles:RUNTIME_FILES.length,bytes,publicBytes,runtimeBytes};
}
function decodePack(input,expectedSha256){
 if(typeof expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSha256))throw Error('ARTIFACT_PIN_REQUIRED');
 if(typeof input!=='string'||Buffer.byteLength(input)>MAX_PACK_BYTES)throw Error('ARTIFACT_PACK_TOO_LARGE');
 let wrapper;try{wrapper=JSON.parse(input);}catch{throw Error('ARTIFACT_PACK_INVALID');}
 if(!exact(wrapper,['schema','sha256','gzipBase64'])||wrapper.schema!==SCHEMA||wrapper.sha256!==expectedSha256||!canonicalBase64(wrapper.gzipBase64))throw Error('ARTIFACT_PACK_INVALID');
 const raw=zlib.gunzipSync(Buffer.from(wrapper.gzipBase64,'base64'),{maxOutputLength:MAX_BYTES});
 if(sha(raw)!==expectedSha256)throw Error('ARTIFACT_CHECKSUM_INVALID');
 const files=JSON.parse(raw),stats=validateFiles(files);
 return {files,stats,sha256:expectedSha256};
}
function unpack(packFile,target,{expectedSha256,fsImpl=fs}={}){
 const stat=fsImpl.lstatSync(packFile);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_PACK_BYTES)throw Error('ARTIFACT_PACK_FILE_INVALID');
 const parsed=decodePack(fsImpl.readFileSync(packFile,'utf8'),expectedSha256);
 const root=path.resolve(target);
 if(fsImpl.existsSync(root))throw Error('ARTIFACT_TARGET_EXISTS');
 const parent=fsImpl.lstatSync(path.dirname(root));
 if(!parent.isDirectory()||parent.isSymbolicLink()||fsImpl.realpathSync(path.dirname(root))!==path.dirname(root))throw Error('ARTIFACT_TARGET_PARENT_INVALID');
 fsImpl.mkdirSync(root,{mode:0o700});
 try{
  for(const f of parsed.files){
   const file=path.resolve(root,f.path);if(!file.startsWith(root+path.sep))throw Error('ARTIFACT_PATH_INVALID');
   fsImpl.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
   fsImpl.writeFileSync(file,Buffer.from(f.content,f.encoding),{flag:'wx',mode:0o600});
  }
 }catch(error){fsImpl.rmSync(root,{recursive:true,force:true});throw error;}
 return {...parsed.stats,sha256:parsed.sha256,root,publicDir:path.join(root,'public'),runtimeDir:path.join(root,'runtime')};
}
module.exports={SCHEMA,MAX_BYTES,MAX_PACK_BYTES,PUBLIC_FILES,RUNTIME_FILES,FILES,sha,isText,validateFiles,decodePack,unpack};
