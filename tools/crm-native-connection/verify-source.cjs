'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const BASE='01f9b7cb5ac06a6b170986f6b9a02f278d45dd3b',TREE='3ae8728f1f1f1e462d906164c9ac71f1f3afe268';
const ROOT=path.resolve(__dirname,'../..'),CUSTODY='tools/crm-native-connection/source-custody.json';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),blob=b=>crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
function verify({workspaceOnly=false}={}){
 const c=JSON.parse(fs.readFileSync(path.join(ROOT,CUSTODY),'utf8'));
 assert.equal(c.schema,'shrigma-native-source-custody-v1');assert.equal(c.baseHead,BASE);assert.equal(c.baseTree,TREE);assert.equal(c.baseBlobCount,1943);assert.equal(c.operational,false);
 assert.equal(c.paths.length,46);assert.equal(new Set(c.paths).size,46);assert.equal(c.files.length,45);
 assert.deepEqual([...c.files.map(f=>f.path),CUSTODY].sort(),[...c.paths].sort());
 for(const f of c.files){assert.match(f.path,/^(?:services|tests|tools|ops|\.github)\//);assert(!f.path.split('/').includes('..'));const p=path.join(ROOT,f.path),s=fs.lstatSync(p);assert(s.isFile()&&!s.isSymbolicLink());const b=fs.readFileSync(p);assert.equal(b.length,f.bytes,f.path);assert.equal(sha(b),f.sha256,f.path);}
 const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'services/dashboard-operational/native-installer/manifest.json'),'utf8'));assert.equal(manifest.sourceHead,BASE);assert.deepEqual(manifest.target,{project:'comunicacao',service:'postgres',database:'listmonk'});
 for(const m of manifest.migrations){const b=fs.readFileSync(path.join(ROOT,'services/dashboard-operational/native-installer/migrations',m.file));assert.equal(blob(b),m.gitBlobSha1);assert.equal(sha(b),m.sha256);assert.equal(b.length,m.bytes);assert.equal(c.reviewedSql.find(f=>f.path===m.sourcePath)?.gitBlobSha1,m.gitBlobSha1);}
 if(!workspaceOnly){
  const git=(...args)=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8'}).trim();
  const head=git('rev-parse','HEAD');assert.match(head,/^[a-f0-9]{40}$/);assert.equal(head,process.env.GITHUB_SHA);assert.equal(git('merge-base',BASE,head),BASE);assert.equal(git('rev-parse',BASE+'^{tree}'),TREE);
  const rows=ref=>git('ls-tree','-r',ref).split('\n').map(s=>{const [meta,p]=s.split('\t');const [mode,type,id]=meta.split(' ');return {path:p,mode,type,id};});
  const before=rows(BASE),after=new Map(rows(head).map(f=>[f.path,f]));assert.equal(before.length,1943);assert(before.every(f=>f.type==='blob'));assert.equal(after.size,1987);
  assert.deepEqual(git('diff','--name-only',BASE,head).split('\n').sort(),[...c.paths].sort());assert.equal(git('diff','--name-only','--diff-filter=D',BASE,head),'');assert.equal(git('status','--porcelain'),'');
  const modified=new Set(['services/dashboard-operational/auth.cjs','services/dashboard-operational/server.cjs']);
  for(const f of before)if(!modified.has(f.path))assert.deepEqual(after.get(f.path),f,f.path);
  for(const f of [...c.baseRuntime,...c.reviewedSql])assert.equal(before.find(b=>b.path===f.path)?.id,f.gitBlobSha1,f.path);
 }
 return {schema:c.schema,sourceCompositionVerified:true,baseHead:BASE,baseTree:TREE,baseBlobsPreserved:1941,modifiedRuntimeFiles:2,changedPaths:46,addedPaths:44,sqlSourceHashesVerified:3,operational:false};
}
if(require.main===module)console.log(JSON.stringify(verify({workspaceOnly:process.argv.includes('--workspace-only')})));
module.exports={verify};
