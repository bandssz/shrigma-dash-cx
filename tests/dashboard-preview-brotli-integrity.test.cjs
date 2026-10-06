'use strict';
// Independent decoder integrity source proof: public synthetic bytes, real bounded zlib
// and exclusive filesystem writes; no HTTP, provider, credentials, business mutation.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const {unpack,PUBLIC_ASSETS}=require('../services/dashboard-preview/bootstrap.cjs');
function fixture(){
 const files=PUBLIC_ASSETS.map(name=>({path:name,encoding:/\.(?:html|js|css|svg)$/.test(name)?'utf8':'base64',content:/\.(?:html|js|css|svg)$/.test(name)?'synthetic-only':Buffer.from([1,2,3]).toString('base64')}));
 const raw=Buffer.from(JSON.stringify(files)),compressed=zlib.brotliCompressSync(raw);
 const sha256=crypto.createHash('sha256').update(raw).digest('hex');
 return {files,compressed,sha256};
}
function input(x,compressed=x.compressed){return JSON.stringify({schema:'shrigma_preview_pack_v3',sha256:x.sha256,brotliBase64:compressed.toString('base64')});}
test('Brotli integrity: clean complete stream restores every public synthetic byte',()=>{
 const x=fixture(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-br-clean-'));
 try{
  const out=path.join(tmp,'assets');let reads=0;
  assert.equal(unpack('/synthetic/pack',out,{readFile:()=>{reads++;return input(x);},expectedSha256:x.sha256}).files,PUBLIC_ASSETS.length);
  assert.equal(reads,1);
  for(const f of x.files)assert.deepEqual(fs.readFileSync(path.join(out,f.path)),Buffer.from(f.content,f.encoding),f.path);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('Brotli integrity: trailing garbage and an extra Brotli member refuse before creating assets',()=>{
 const x=fixture(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-br-trailing-'));
 try{
  for(const [i,suffix]of [Buffer.alloc(31,97),zlib.brotliCompressSync(Buffer.from('synthetic-second-member'))].entries()){
   const out=path.join(tmp,'refused-'+i),compressed=Buffer.concat([x.compressed,suffix]);
   assert.throws(()=>unpack('/synthetic/pack',out,{readFile:()=>input(x,compressed),expectedSha256:x.sha256}),/Invalid pack stream/);
   assert.equal(fs.existsSync(out),false,'No target directory or file may exist after refusal');
  }
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
