'use strict';
// Fresh, explicitly scoped delta over ef81; no historical custody/activation is repinned.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..'),MANIFEST='tools/crm-native-connection/affiliate-read-source.json';
const BASE='ef81fa41d417a81d84761759c8a8e8b7b8b011c1',TREE='0cb46708c5819b7de70c3a36126aad8052e0a5a1';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function verify({workspaceOnly=false}={}){
 const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,MANIFEST),'utf8'));
 assert.equal(manifest.schema,'shrigma-affiliate-read-source-v1');assert.equal(manifest.baseHead,BASE);assert.equal(manifest.baseTree,TREE);assert.equal(manifest.operational,false);assert.equal(manifest.newServiceOrDatabase,false);assert.equal(manifest.sourceWorkflow,'ZRPkPSaMRw35uZQj');
 assert(Array.isArray(manifest.files)&&manifest.files.length>=20&&manifest.files.length<=44);assert.equal(new Set(manifest.files.map(f=>f.path)).size,manifest.files.length);
 for(const f of manifest.files){assert(typeof f.path==='string'&&!f.path.split('/').some(s=>s==='..'||s.startsWith('.private')));assert(!f.path.startsWith('operacao/')&&!f.path.startsWith('arquivo/'));const file=path.join(ROOT,f.path),st=fs.lstatSync(file);assert(st.isFile()&&!st.isSymbolicLink());const b=fs.readFileSync(file);assert.equal(b.length,f.bytes,f.path);assert.equal(sha(b),f.sha256,f.path);}
 if(!workspaceOnly){
  const git=(...args)=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8'}).trim();
  assert.equal(git('merge-base',BASE,'HEAD'),BASE);assert.equal(git('rev-parse',BASE+'^{tree}'),TREE);assert.equal(git('rev-parse','HEAD'),process.env.GITHUB_SHA);assert.equal(git('status','--porcelain'),'');
  assert.deepEqual(git('diff','--name-only',BASE,'HEAD').split('\n').sort(),[MANIFEST,...manifest.files.map(f=>f.path)].sort());assert.equal(git('diff','--name-only','--diff-filter=D',BASE,'HEAD'),'');
  for(const p of ['services/dashboard-operational/native-continuity/read-only.cjs','services/dashboard-operational/native-continuity/pins.json','services/dashboard-operational/native-installer/manifest.json','tools/crm-native-connection/source-custody.json'])assert.equal(git('rev-parse',BASE+':'+p),git('rev-parse','HEAD:'+p),p);
 }
 return {schema:manifest.schema,deltaVerified:true,files:manifest.files.length,baseHead:BASE,existingService:true,newServiceOrDatabase:false,sqlInstalled:false,operational:false};
}
if(require.main===module)console.log(JSON.stringify(verify({workspaceOnly:process.argv.includes('--workspace-only')})));
module.exports={verify};
