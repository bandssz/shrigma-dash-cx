'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {download,originValid,tokenFromFile}=require('./mac-downloader.cjs');

function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cipher-download-synthetic-')));
 fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const token=crypto.randomBytes(32).toString('base64url');
 const tokenFile=path.join(root,'token');fs.writeFileSync(tokenFile,token+'\n',{mode:0o600});
 const blob=Buffer.from('{"synthetic":"ciphertext-only"}\n');
 const manifest=Buffer.from(JSON.stringify({schema:'shrigma_identity_envelope_public_manifest_v1',blobBytes:blob.length,blobSha256:crypto.createHash('sha256').update(blob).digest('hex')})+'\n');
 const targetDir=path.join(root,'download');
 const origin='https://cipher.synthetic.invalid';
 return {root,token,tokenFile,blob,manifest,manifestSha256:crypto.createHash('sha256').update(manifest).digest('hex'),targetDir,origin};
}
function response(body,{statusCode=200,headers={},chunks=null}={}){
 const res=Readable.from(chunks||[body]);
 res.statusCode=statusCode;
 res.headers={'content-type':'application/json','content-length':String(body.length),...headers};
 return res;
}
function transport(f,changes={}){
 const calls=[];
 const call=async(origin,name,token)=>{
  calls.push([origin,name,token]);
  assert.equal(origin,f.origin);
  assert.equal(token,f.token);
  assert.ok(['public-manifest.json','cipherblob.json'].includes(name));
  const original=name==='public-manifest.json'?f.manifest:f.blob;
  const setting=changes[name]||{};
  return response(setting.body||original,setting);
 };
 return {call,calls};
}
test('downloads exactly the public manifest and encrypted blob with SHA and private modes',async t=>{
 const f=fixture(t),x=transport(f);
 assert.deepEqual(await download({origin:f.origin,tokenFile:f.tokenFile,targetDir:f.targetDir,expectedManifestSha256:f.manifestSha256,transport:x.call}),{downloaded:true});
 assert.deepEqual(x.calls.map(([,name])=>name),['public-manifest.json','cipherblob.json']);
 assert.deepEqual(fs.readFileSync(path.join(f.targetDir,'cipherblob.json')),f.blob);
 assert.equal(fs.statSync(f.targetDir).mode&0o777,0o700);
 assert.equal(fs.statSync(path.join(f.targetDir,'cipherblob.json')).mode&0o777,0o600);
 const withoutIndependentPin=path.join(f.root,'without-independent-pin');
 assert.deepEqual(await download({origin:f.origin,tokenFile:f.tokenFile,targetDir:withoutIndependentPin,transport:x.call}),{downloaded:true});
 assert.deepEqual(fs.readFileSync(path.join(withoutIndependentPin,'cipherblob.json')),f.blob);
});
test('rejects origin tricks, unsafe token and occupied target before transport',async t=>{
 const f=fixture(t),x=transport(f);
 for(const bad of ['http://cipher.synthetic.invalid','https://cipher.synthetic.invalid/other','https://user@cipher.synthetic.invalid','https://cipher.synthetic.invalid:443','https://cipher.synthetic.invalid?x=1'])assert.throws(()=>originValid(bad),/ORIGIN_INVALID/);
 fs.chmodSync(f.tokenFile,0o644);assert.throws(()=>tokenFromFile(f.tokenFile),/FILE_INVALID/);fs.chmodSync(f.tokenFile,0o600);
 const real=fs.readFileSync(f.tokenFile);fs.unlinkSync(f.tokenFile);fs.symlinkSync(path.join(f.root,'fake-token'),f.tokenFile);assert.throws(()=>tokenFromFile(f.tokenFile),/FILE_INVALID/);fs.unlinkSync(f.tokenFile);fs.writeFileSync(f.tokenFile,real,{mode:0o600});
 fs.mkdirSync(f.targetDir,{mode:0o700});
 await assert.rejects(download({origin:f.origin,tokenFile:f.tokenFile,targetDir:f.targetDir,expectedManifestSha256:f.manifestSha256,transport:x.call}),/TARGET_EXISTS/);
 assert.equal(x.calls.length,0);
});
test('rejects altered blob, false length, redirect, over-limit response and manifest replay',async t=>{
 const cases=[
  {name:'tamper',change:f=>({'cipherblob.json':{body:Buffer.from(f.blob.toString().replace('ciphertext','ciphxrtext'))}})},
  {name:'short',change:f=>({'cipherblob.json':{headers:{'content-length':String(f.blob.length-1)}}})},
  {name:'long',change:f=>({'cipherblob.json':{headers:{'content-length':String(f.blob.length+1)}}})},
  {name:'redirect',change:()=>({'public-manifest.json':{statusCode:302,headers:{location:'https://other.synthetic.invalid'}}})},
  {name:'oversized',change:()=>({'public-manifest.json':{headers:{'content-length':'999999999'}}})},
  {name:'replay',change:f=>({'public-manifest.json':{body:Buffer.from(JSON.stringify({schema:'shrigma_identity_envelope_public_manifest_v1',blobBytes:f.blob.length,blobSha256:'0'.repeat(64)})+'\n')}})},
  {name:'extraBytes',change:f=>({'cipherblob.json':{chunks:[f.blob,Buffer.from('extra')]}})}
 ];
 for(const item of cases){
  const f=fixture(t),x=transport(f,item.change(f));
  await assert.rejects(download({origin:f.origin,tokenFile:f.tokenFile,targetDir:f.targetDir,expectedManifestSha256:f.manifestSha256,transport:x.call}),undefined,item.name);
  assert.equal(fs.existsSync(f.targetDir),false,item.name+' leaves no partial output');
 }
});
test('coherent older manifest/blob pair is rejected by out-of-band manifest SHA pin',async t=>{
 const f=fixture(t),oldBlob=Buffer.from('{"synthetic":"older-valid-ciphertext"}\n');
 const oldManifest=Buffer.from(JSON.stringify({schema:'shrigma_identity_envelope_public_manifest_v1',blobBytes:oldBlob.length,blobSha256:crypto.createHash('sha256').update(oldBlob).digest('hex')})+'\n');
 const x=transport(f,{'public-manifest.json':{body:oldManifest},'cipherblob.json':{body:oldBlob}});
 await assert.rejects(download({origin:f.origin,tokenFile:f.tokenFile,targetDir:f.targetDir,expectedManifestSha256:f.manifestSha256,transport:x.call}),/MANIFEST_PIN_MISMATCH/);
 assert.equal(fs.existsSync(f.targetDir),false);
 assert.deepEqual(x.calls.map(([,name])=>name),['public-manifest.json']);
});
