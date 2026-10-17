'use strict';
// New code delta over a verified baseline. Historical activation, SQL,
// continuity pins and source-custody records are not repinned or replayed.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..'),FILE='tools/crm-native-connection/manager-access-source.json';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function verify({workspaceOnly=false}={}){
 const m=JSON.parse(fs.readFileSync(path.join(ROOT,FILE),'utf8'));
 assert.equal(m.schema,'shrigma-manager-access-source-v1');assert.equal(m.baseline,'55ed5bdc42d924a79da577b4b7c7b7b052dfc4c7');assert.equal(m.baselineTree,'10c7f006e9b9a25f40463aa84891180ffff0f43b');assert.equal(m.productionAdmitted,false);assert.equal(m.sqlInstallationEnabled,false);
 assert.equal(m.files.length,20);assert.equal(new Set(m.files.map(f=>f.path)).size,20);
 for(const f of [...m.files,...m.preserved]){assert(typeof f.path==='string'&&!f.path.split('/').includes('..')&&!path.isAbsolute(f.path));assert(!f.path.startsWith('.private/')&&!f.path.startsWith('n8n/'));const file=path.join(ROOT,f.path),s=fs.lstatSync(file);assert(s.isFile()&&!s.isSymbolicLink());const b=fs.readFileSync(file);assert.equal(b.length,f.bytes,f.path);assert.equal(sha(b),f.sha256,f.path);}
 if(!workspaceOnly){
  const git=(...args)=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8'}).trim();const head=git('rev-parse','HEAD');assert.equal(head,process.env.GITHUB_SHA);assert.equal(git('merge-base',m.baseline,head),m.baseline);assert.equal(git('rev-parse',m.baseline+'^{tree}'),m.baselineTree);
  assert.deepEqual(git('diff','--name-only',m.baseline,head).split('\n').sort(),[...m.files.map(f=>f.path),FILE].sort());assert.equal(git('diff','--name-only','--diff-filter=D',m.baseline,head),'');assert.equal(git('status','--porcelain'),'');
 }
 return {schema:m.schema,filesVerified:m.files.length,preservedFiles:m.preserved.length,baseline:m.baseline,newDatabases:0,productionAdmitted:false,sqlInstallationEnabled:false,operational:false};
}
if(require.main===module)console.log(JSON.stringify(verify({workspaceOnly:process.argv.includes('--workspace-only')})));
module.exports={verify};
