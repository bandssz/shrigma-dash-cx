'use strict';
// Test-only preflight. No context code is imported by this helper.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const MANIFEST={"path": "CONTEXT-MANIFEST.json", "bytes": 8123, "sha256": "2d05b7bcf711b9244b96441ed9c422d4ea19cf52ffefd0bfcf7097dbccd866a5", "gitBlobSha1": "5b95651b05601438ebc9cb4694d6f02b3e425d66"};
const CONTRACT={"path": "CONTRATO-PERSISTENCIA-v1.json", "bytes": 13054, "sha256": "d82231e3fecaa0fe0ccad51a8e3c54fecdfb38793d1e0fc82864b9d1e9dec9e2", "gitBlobSha1": "22614de8a3c85879c101e4ac73c0c0a5020016c5"};
const FILES={
  "context/evidence/B1-v6-DELIVERY.json": {
    "bytes": 20493,
    "sha256": "100adeee0bf549075986b1d479ee59079f06f520aa2c30b323ee453db5c67f5a",
    "gitBlobSha1": "5fc905ea7650592d49b34743e9a513b82f23d591"
  },
  "context/evidence/PR235-CI-RECIBO.json": {
    "bytes": 1434,
    "sha256": "e42f152b903692e8622f1fec2a5d682cda23ceda8065cd012ef7377874228a59",
    "gitBlobSha1": "99c73a143e45f103d8a30267fa10f36ba60c5a55"
  },
  "context/evidence/PR235-upload-manifest.json": {
    "bytes": 7642,
    "sha256": "cb2469230c41370b7621e92f4f8c430226ddc18d420741ea914ca1f1edb0399c",
    "gitBlobSha1": "ff71fb3b01b84d43fe62bbe839e0386683020b45"
  },
  "context/source/services/dashboard-operational/domain/crm-mvp-controls/INTERFACE.md": {
    "bytes": 13750,
    "sha256": "69268d6cd5aa901be6a4a05a847b1f22c68d95cd551472fb22625be3084e5b27",
    "gitBlobSha1": "c7aa011b967a345e52e086eb7476bfd5c9fe5074"
  },
  "context/source/services/dashboard-operational/domain/crm-mvp-controls/boundary.cjs": {
    "bytes": 8546,
    "sha256": "4906934b44c103dc26c488a3c0dcbe11ac31823560b7d0f40c2903a61ba55c43",
    "gitBlobSha1": "cf15e36254eb202047b4b568e77cc6d7664c391c"
  },
  "context/source/services/dashboard-operational/domain/crm-mvp-controls/decision.cjs": {
    "bytes": 3226,
    "sha256": "c8ef97eb3de34dbbd6a44ea04f4ee0ffcfb4ef415457464752bc2839b9c3f0cf",
    "gitBlobSha1": "daa041570d5df9086174da92c1cd643d882ce955"
  },
  "context/source/tests/crm-mvp-controls/boundary.test.cjs": {
    "bytes": 35706,
    "sha256": "3aa3fd8ee35540babd0a03ba04116fad4fa7e3a4271b7ae39ab929c7166e67e2",
    "gitBlobSha1": "610ebc9ae1d71487ed971ae3f5fa206346e3c3aa"
  },
  "context/source/audience-slice-contract.js": {
    "bytes": 3066,
    "sha256": "f07c41f0cddcc742817056de0840dcb49a398a2e0b5891454b3669fa1be3eee6",
    "gitBlobSha1": "2ba2b8c037045a551a20d36943ee17e0b874bc75"
  },
  "context/source/domain/audience-slices/kernel.cjs": {
    "bytes": 9729,
    "sha256": "0f905084d55a2856027615eb6e4a4d30202ad74a994cf08320feb112503d94b4",
    "gitBlobSha1": "59ce9167604a0f23386b4518fb32a32d6297e267"
  },
  "context/source/services/dashboard-operational/domain/deliverability/policy.cjs": {
    "bytes": 11169,
    "sha256": "f0006cb43770e605e45ddd3c2f14ff53655eb23f0cfefb54b726f75477c4d4cf",
    "gitBlobSha1": "77e6b2e9a095efb9de3154347205eab6ac17039f"
  },
  "context/reference/identity/identity-store-factory.cjs": {
    "bytes": 3770,
    "sha256": "2db0cb45162b8addfc6c297a4c1acbce92cd8f2f5eaaeb8abaf0222c21a41c32",
    "gitBlobSha1": "ddac42fc8a53ceb04554cae62677bd74754135ea"
  },
  "context/reference/identity/identity-pg/database-sync.cjs": {
    "bytes": 4591,
    "sha256": "8a3ab845009c3448ba7b396215c1f11486a7af487259380f2a1884ecc771cbc5",
    "gitBlobSha1": "889d50d80fd93b0aba9811451143dd45ac0642d7"
  },
  "context/reference/identity/identity-pg/worker.cjs": {
    "bytes": 11034,
    "sha256": "6855653b3722e1a99857a6eea322d1b68d2c672d9133b83a12f03525baa704fa",
    "gitBlobSha1": "3d5336af80e49e5b8066f70f2ecbd1959dcd5207"
  },
  "context/reference/identity/identity-pg/admission.cjs": {
    "bytes": 8008,
    "sha256": "d23cd6f0f4ca2493659497903039c1138e66b837f0e07cb935c64c0ac51696e8",
    "gitBlobSha1": "9a45a2f47c97b51f3a05d6ebcaa139c8ebbffbe4"
  }
};
function refused(){return Object.assign(new Error('CRM_CONTEXT_REFUSED'),{code:'CRM_CONTEXT_REFUSED'});}
function physical(target,file){
 const parts=target.split(path.sep);let current=path.parse(target).root;
 for(const part of parts.filter(Boolean)){current=path.join(current,part);const stat=fs.lstatSync(current);if(stat.isSymbolicLink()||(current===target?(file?(!stat.isFile()||stat.nlink!==1):!stat.isDirectory()):!stat.isDirectory()))throw refused();}
 if(fs.realpathSync(target)!==target)throw refused();
}
function readPinned(root,relative,pin){
 if(path.isAbsolute(relative)||relative.split('/').some(p=>!p||p==='.'||p==='..'))throw refused();
 const target=path.join(root,relative);physical(target,true);const bytes=fs.readFileSync(target);
 const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
 const blob=crypto.createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
 if(bytes.length!==pin.bytes||sha256!==pin.sha256||blob!==pin.gitBlobSha1)throw refused();return bytes;
}
function verifyContext(){
 try{
  const root=process.env.CRM_PERSISTENCE_CONTEXT_DIRECTORY;
  if(typeof root!=='string'||!path.isAbsolute(root)||path.resolve(root)!==root||root.split(path.sep).some(p=>p==='.'||p==='..'||p==='.private'))throw refused();
  physical(root,false);
  // Authenticate literal manifest bytes BEFORE parsing; mutable manifest cannot repin input.
  const manifest=JSON.parse(readPinned(root,MANIFEST.path,MANIFEST));
  if(!Array.isArray(manifest.files)||manifest.files.length!==14)throw refused();
  const seen=new Set();for(const entry of manifest.files){const fixed=FILES[entry.path];if(!fixed||seen.has(entry.path)||Object.keys(fixed).some(k=>entry[k]!==fixed[k]))throw refused();seen.add(entry.path);}
  readPinned(root,CONTRACT.path,CONTRACT);
  for(const [relative,pin] of Object.entries(FILES))readPinned(root,relative,pin);
  return Object.freeze({root,source:path.join(root,'context/source'),verifiedFileCount:14,manifestSha256:MANIFEST.sha256,contractSha256:CONTRACT.sha256});
 }catch{throw refused();}
}
module.exports=Object.freeze({verifyContext});
