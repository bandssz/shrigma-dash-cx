'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {FILES}=require('./build.cjs');
function pack(dist,output){
 const source=path.resolve(dist),destination=path.resolve(output);
 if(fs.existsSync(destination)&&fs.readdirSync(destination).length)throw Error('Pack destination must be empty.');fs.mkdirSync(destination,{recursive:true});
 const expected=[...FILES,'preview.js','preview.css'].sort(),listed=[];
 function list(dir,prefix=''){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=prefix+item.name;if(item.isSymbolicLink())throw Error('Symlink forbidden.');if(item.isDirectory())list(path.join(dir,item.name),file+'/');else if(item.isFile())listed.push(file);else throw Error('Unexpected asset.');}}
 list(path.join(source,'public'));if(JSON.stringify(listed.sort())!==JSON.stringify(expected))throw Error('Pack requires exactly the public allowlist.');
 const files=expected.map(file=>{
  const buf=fs.readFileSync(path.join(source,'public',file)),text=/\.(?:html|js|css|svg)$/.test(file),content=buf.toString(text?'utf8':'base64');
  if(text&&!Buffer.from(content,'utf8').equals(buf))throw Error('Public text asset is not valid UTF8.');
  return {path:file,encoding:text?'utf8':'base64',content};
 });
 const raw=Buffer.from(JSON.stringify(files));if(raw.length>16*1024*1024)throw Error('Pack exceeds limit.');
 const sha256=crypto.createHash('sha256').update(raw).digest('hex');
 const runtimeFiles=['server.cjs','fixtures.cjs','bootstrap.cjs'];
 const runtimeMounts=runtimeFiles.map(file=>({type:'file',mountPath:'/app/'+file,content:fs.readFileSync(path.join(__dirname,file),'utf8')}));
 const serializeMounts=wrapper=>JSON.stringify([...runtimeMounts,{type:'file',mountPath:'/app/assets-pack.json',content:JSON.stringify(wrapper)}]);
 let wrapper={schema:'shrigma_preview_pack_v2',sha256,gzipBase64:zlib.gzipSync(raw,{level:9}).toString('base64')};
 let mountsJSON=serializeMounts(wrapper);
 if(Buffer.byteLength(mountsJSON)>950000){
  wrapper={schema:'shrigma_preview_pack_v3',sha256,brotliBase64:zlib.brotliCompressSync(raw,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:11}}).toString('base64')};
  mountsJSON=serializeMounts(wrapper);
 }
 const mountsJsonBytes=Buffer.byteLength(mountsJSON);
 if(mountsJsonBytes>950000)throw Error('Mounts payload exceeds the 950 KB transport safety budget.');
 // Validate the complete transport budget before materializing any runtime/pack file.
 fs.writeFileSync(path.join(destination,'assets-pack.json'),JSON.stringify(wrapper));
 for(const file of runtimeFiles)fs.copyFileSync(path.join(__dirname,file),path.join(destination,file));
 fs.writeFileSync(path.join(destination,'mounts.json'),mountsJSON);
 const mounts=JSON.parse(mountsJSON);
 return {directory:destination,publicFiles:files.length,mounts:mounts.length,textBytes:mounts.reduce((a,m)=>a+Buffer.byteLength(m.content),0),mountsJsonBytes,packSha256:wrapper.sha256};
}
if(require.main===module){if(!process.argv[2]||!process.argv[3])throw Error('Usage: node pack-runtime.cjs dist empty-output');console.log(JSON.stringify(pack(process.argv[2],process.argv[3])));}
module.exports={pack};
