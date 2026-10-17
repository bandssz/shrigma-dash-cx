'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const canonical=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
function build(source,output){
 const lockBytes=fs.readFileSync(path.join(source,'package-lock.json')),lock=JSON.parse(lockBytes),spec=JSON.parse(fs.readFileSync(path.join(source,'package.json')));
 if(fs.existsSync(output)||lock.lockfileVersion!==3||spec.dependencies?.pg!=='8.23.1'||lock.packages?.['node_modules/pg']?.version!=='8.23.1'||Object.keys(spec.dependencies).length!==1||spec.scripts)throw Error('PG_DEPENDENCY_BUILD_REFUSED');
 const packages=Object.entries(lock.packages).filter(([p])=>p!==''),files=[];
 for(const [name,p]of packages)if(!/^node_modules\/(?:@[a-z0-9_-]+\/)?[a-z0-9_-]+(?:\/node_modules\/(?:@[a-z0-9_-]+\/)?[a-z0-9_-]+)*$/.test(name)||typeof p.version!=='string'||!p.resolved?.startsWith('https://registry.npmjs.org/')||!/^sha512-[A-Za-z0-9+/]+=*$/.test(p.integrity||'')||p.hasInstallScript)throw Error('PG_DEPENDENCY_BUILD_REFUSED');
 fs.mkdirSync(output,{mode:0o755});
 const copy=(file,relative)=>{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>2*1024*1024)throw Error('PG_DEPENDENCY_BUILD_REFUSED');const b=fs.readFileSync(file);fs.mkdirSync(path.dirname(path.join(output,relative)),{recursive:true,mode:0o755});fs.writeFileSync(path.join(output,relative),b,{mode:0o444,flag:'wx'});files.push({path:relative,bytes:b.length,sha256:sha(b)});};
 for(const [name,p]of packages){const packageDir=path.join(source,name),info=JSON.parse(fs.readFileSync(path.join(packageDir,'package.json')));if(info.version!==p.version)throw Error('PG_DEPENDENCY_BUILD_REFUSED');function scan(dir,prefix){for(const n of fs.readdirSync(dir).sort()){const f=path.join(dir,n),s=fs.lstatSync(f);if(s.isSymbolicLink())throw Error('PG_DEPENDENCY_BUILD_REFUSED');if(s.isDirectory()){if(n==='node_modules')continue;scan(f,prefix+'/'+n);}else copy(f,prefix+'/'+n);}}scan(packageDir,name);}
 for(const n of ['package.json','package-lock.json'])copy(path.join(source,n),n);
 files.sort((a,b)=>a.path.localeCompare(b.path));
 const packageSha256=sha(canonical(files.filter(f=>f.path.startsWith('node_modules/pg/'))));
 const manifest={schema:'shrigma-native-pg-dependency-v1',package:'pg',version:'8.23.1',packageSha256,lockSha256:sha(lockBytes),files,packages:packages.map(([p,m])=>({path:p,version:m.version,integrity:m.integrity})).sort((a,b)=>a.path.localeCompare(b.path)),lifecycleScriptsExecuted:false,operational:false};
 const b=Buffer.from(JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(path.join(output,'manifest.json'),b,{mode:0o444,flag:'wx'});
 function seal(dir){for(const n of fs.readdirSync(dir)){const f=path.join(dir,n);if(fs.lstatSync(f).isDirectory())seal(f);}fs.chmodSync(dir,0o555);}seal(output);
 return {pgDriverManifestSha256:sha(b),packageSha256,version:manifest.version,files:files.length,packages:packages.length};
}
module.exports={build};
if(require.main===module)console.log(JSON.stringify(build(...process.argv.slice(2))));
