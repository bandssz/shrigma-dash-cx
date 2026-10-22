 'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Pins=require('./source-pins.json');
const manifestPath=path.join(__dirname,'source-bundle.json');
function refuse(){throw Error('PORTABLE_TRANSITION_SOURCE_REFUSED');}
function keys(v,want){if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).sort().join()!==[...want].sort().join())refuse();}
function load(repoRoot=path.resolve(__dirname,'../../..')){
 if(typeof repoRoot!=='string'||!path.isAbsolute(repoRoot)||fs.realpathSync(repoRoot)!==repoRoot)refuse();
 const m=JSON.parse(fs.readFileSync(manifestPath,'utf8'));keys(m,['schema','purpose','inputs']);
 if(m.schema!=='shrigma-coherent-transition-portable-source-bundle-v1'||m.purpose!=='source-only-synthetic-transition-fixture'||!Array.isArray(m.inputs)||m.inputs.length!==8)refuse();
 return m.inputs.map((e,i)=>{keys(e,['logicalPath','repoPath','bytes','sha256']);const pin=Pins[i];
  if(e.logicalPath!==pin.path||e.bytes!==pin.bytes||e.sha256!==pin.sha256||typeof e.repoPath!=='string'||path.isAbsolute(e.repoPath)||e.repoPath.includes('\\')||e.repoPath.split('/').some(p=>!p||p==='.'||p==='..')||path.posix.normalize(e.repoPath)!==e.repoPath)refuse();
  const target=path.resolve(repoRoot,e.repoPath);if(!target.startsWith(repoRoot+path.sep)||fs.realpathSync(target)!==target||!fs.lstatSync(target).isFile()||fs.lstatSync(target).isSymbolicLink())refuse();
  const b=fs.readFileSync(target);if(b.length!==e.bytes||crypto.createHash('sha256').update(b).digest('hex')!==e.sha256)refuse();
  return {path:pin.path,bytes:pin.bytes,sha256:pin.sha256,content:b.toString('utf8')};
 });
}
module.exports=Object.freeze({load});
