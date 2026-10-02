'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {Writable}=require('node:stream');
const {createReader,preflight,configFromEnv,FILES}=require('./cipher-reader.cjs');
class Response extends Writable{
 constructor(){super();this.statusCode=200;this.headers={};this.headersSent=false;this.parts=[];}
 setHeader(name,value){this.headers[name.toLowerCase()]=value;}
 _write(chunk,encoding,cb){this.headersSent=true;this.parts.push(Buffer.from(chunk));cb();}
 end(...args){this.headersSent=true;return super.end(...args);}
 body(){return Buffer.concat(this.parts);}
}
function fixture(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cipher-reader-synthetic-')));
 fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const blob=Buffer.from('{"schema":"synthetic-encrypted","chunks":["QUJD"]}\n');
 fs.writeFileSync(path.join(dir,'cipherblob.json'),blob,{mode:0o600});
 fs.writeFileSync(path.join(dir,'public-manifest.json'),JSON.stringify({schema:'shrigma_identity_envelope_public_manifest_v1',blobBytes:blob.length,blobSha256:crypto.createHash('sha256').update(blob).digest('hex')})+'\n',{mode:0o600});
 const token=crypto.randomBytes(32).toString('base64url'),tokenSha256=crypto.createHash('sha256').update(token).digest('hex');
 const host='cipher.synthetic.invalid';
 const req=(over={})=>({method:'GET',url:'/cipherblob.json',headers:{host,'x-forwarded-proto':'https',authorization:'Bearer '+token,...over.headers},...Object.fromEntries(Object.entries(over).filter(([k])=>k!=='headers'))});
 return {dir,blob,token,tokenSha256,host,req};
}
async function run(handler,req){const res=new Response();await handler(req,res);return res;}
test('fixed HTTPS host, bearer and two files stream; query/range/cross-host and expiry denied',async t=>{
 const f=fixture(t),expiresAt=Date.now()+60_000,handler=createReader({dir:f.dir,host:f.host,tokenSha256:f.tokenSha256,expiresAt});
 const ok=await run(handler,f.req());assert.equal(ok.statusCode,200);assert.deepEqual(ok.body(),f.blob);assert.equal(ok.headers['cache-control'],'private, no-store, max-age=0');
 const manifest=await run(handler,f.req({url:'/public-manifest.json'}));assert.equal(manifest.statusCode,200);assert.equal(JSON.parse(manifest.body()).blobBytes,f.blob.length);
 for(const override of [{url:'/cipherblob.json?x=1'},{url:'/%2e%2e/cipherblob.json'},{method:'HEAD'},{headers:{range:'bytes=0-1'}},{headers:{host:'other.synthetic.invalid'}},{headers:{'x-forwarded-proto':'http'}},{headers:{authorization:'Bearer wrong'}},{headers:{'content-length':'1'}}]){
  const denied=await run(handler,f.req(override));assert.equal(denied.statusCode,404);assert.equal(denied.body().length,0);
 }
 const expired=createReader({dir:f.dir,host:f.host,tokenSha256:f.tokenSha256,expiresAt:Date.now()-1});
 assert.equal((await run(expired,f.req())).statusCode,404);
 assert.throws(()=>configFromEnv({BACKUP_READER_DIR:f.dir,BACKUP_READER_HOST:f.host,BACKUP_READER_TOKEN_SHA256:f.tokenSha256,BACKUP_READER_EXPIRES_AT:new Date(Date.now()+31*60_000).toISOString()},Date.now()),/CONFIG_INVALID/);
});
test('preflight refuses plaintext, symlink, relaxed modes and oversized blob',t=>{
 const f=fixture(t);
 preflight(f.dir);
 fs.writeFileSync(path.join(f.dir,'identity.sqlite'),'plaintext',{mode:0o600});
 assert.throws(()=>preflight(f.dir),/CONTENTS_INVALID/);
 fs.unlinkSync(path.join(f.dir,'identity.sqlite'));
 const manifest=path.join(f.dir,'public-manifest.json');
 fs.chmodSync(manifest,0o644);assert.throws(()=>preflight(f.dir),/FILE_INVALID/);fs.chmodSync(manifest,0o600);
 const data=fs.readFileSync(manifest);fs.unlinkSync(manifest);fs.symlinkSync(path.join(f.dir,'cipherblob.json'),manifest);assert.throws(()=>preflight(f.dir),/FILE_INVALID/);fs.unlinkSync(manifest);fs.writeFileSync(manifest,data,{mode:0o600});
 const blob=path.join(f.dir,'cipherblob.json');fs.truncateSync(blob,FILES['/cipherblob.json'].max+1);assert.throws(()=>preflight(f.dir),/FILE_INVALID/);
});
test('reader refuses changed ciphertext after startup',async t=>{
 const f=fixture(t),handler=createReader({dir:f.dir,host:f.host,tokenSha256:f.tokenSha256,expiresAt:Date.now()+60_000});
 const file=path.join(f.dir,'cipherblob.json'),changed=Buffer.from(f.blob);changed[10]=changed[10]===65?66:65;fs.writeFileSync(file,changed);
 fs.utimesSync(file,new Date(0),new Date(0));
 assert.equal((await run(handler,f.req())).statusCode,404);
});
