'use strict';
// Independent fixture-only HTTP/transfer tests: no listener, DNS, or network.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {Writable,Readable}=require('node:stream');
const {createReader,configFromEnv}=require('./cipher-reader.cjs');
const {download}=require('./mac-downloader.cjs');
class Response extends Writable{
 constructor(){super();this.statusCode=200;this.headers={};this.headersSent=false;this.parts=[];}
 setHeader(k,v){this.headers[k.toLowerCase()]=v;}
 _write(b,e,cb){this.headersSent=true;this.parts.push(Buffer.from(b));cb();}
 end(...args){this.headersSent=true;return super.end(...args);}
}
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'offsite-transfer-review-')));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const cipher=path.join(root,'cipher');fs.mkdirSync(cipher,{mode:0o700});
 const blob=Buffer.from('{"synthetic":"ciphertext"}\n'),token=crypto.randomBytes(32).toString('base64url');
 const manifest=Buffer.from(JSON.stringify({schema:'shrigma_identity_envelope_public_manifest_v1',blobBytes:blob.length,blobSha256:crypto.createHash('sha256').update(blob).digest('hex')})+'\n');
 fs.writeFileSync(path.join(cipher,'cipherblob.json'),blob,{mode:0o600});fs.writeFileSync(path.join(cipher,'public-manifest.json'),manifest,{mode:0o600});
 const tokenFile=path.join(root,'token');fs.writeFileSync(tokenFile,token,{mode:0o600});
 const tokenSha256=crypto.createHash('sha256').update(token).digest('hex'),manifestSha256=crypto.createHash('sha256').update(manifest).digest('hex'),host='offsite.synthetic.invalid';
 const request=(extra={})=>({method:'GET',url:'/cipherblob.json',headers:{host,'x-forwarded-proto':'https',authorization:'Bearer '+token},...extra});
 return {root,cipher,blob,manifest,token,tokenFile,tokenSha256,manifestSha256,host,request};
}
function reply(body,override={}){const r=Readable.from([body]);r.statusCode=200;r.headers={'content-type':'application/json','content-length':String(body.length),...override};return r;}
test('reader rejects duplicate authorization/header ambiguity and never enables CORS',async t=>{
 const f=fixture(t),handle=createReader({dir:f.cipher,host:f.host,tokenSha256:f.tokenSha256,expiresAt:Date.now()+120000});
 const res=new Response();await handle(f.request({rawHeaders:['Host',f.host,'Authorization','Bearer '+f.token,'Authorization','Bearer invalid','X-Forwarded-Proto','https']}),res);
 assert.equal(res.statusCode,404);assert.equal(res.headers['access-control-allow-origin'],undefined);assert.equal(Buffer.concat(res.parts).length,0);
});
test('reader rejects transfer/request-body headers without emitting ciphertext',async t=>{
 const f=fixture(t),handle=createReader({dir:f.cipher,host:f.host,tokenSha256:f.tokenSha256,expiresAt:Date.now()+120000});
 for(const added of [{'transfer-encoding':'chunked'},{'if-range':'anything'},{'content-length':'0'}]){
  const req=f.request();req.headers={...req.headers,...added};const res=new Response();await handle(req,res);assert.equal(res.statusCode,404);assert.equal(Buffer.concat(res.parts).length,0);
 }
});
test('reader runtime config bounds expiry and does not accept localhost hostname tricks',t=>{
 const f=fixture(t),now=Date.now();
 const valid={BACKUP_READER_DIR:f.cipher,BACKUP_READER_HOST:f.host,BACKUP_READER_TOKEN_SHA256:f.tokenSha256,BACKUP_READER_EXPIRES_AT:new Date(now+120000).toISOString()};
 assert.equal(configFromEnv(valid,now).host,f.host);
 for(const over of [{BACKUP_READER_EXPIRES_AT:new Date(now+60000).toISOString()},{BACKUP_READER_EXPIRES_AT:new Date(now+1800001).toISOString()},{BACKUP_READER_HOST:'Bad.synthetic.invalid'},{BACKUP_READER_HOST:'bad..synthetic.invalid'},{PORT:'-1'}])assert.throws(()=>configFromEnv({...valid,...over},now));
});
test('invalid transfer response is closed and does not retain incomplete files',async t=>{
 const f=fixture(t);let invalid;
 const transport=async()=>{invalid=reply(f.manifest,{'content-encoding':'gzip'});return invalid;};
 const target=path.join(f.root,'download');
 await assert.rejects(download({origin:'https://'+f.host,tokenFile:f.tokenFile,targetDir:target,expectedManifestSha256:f.manifestSha256,transport}));
 assert.equal(fs.existsSync(target),false);assert.equal(invalid.destroyed,true,'invalid response must release its stream/socket');
});
test('optional manifest pin permits download; producer and replay checks belong to nonce/context',async t=>{
 const f=fixture(t),target=path.join(f.root,'without-pin'),calls=[];
 const transport=async(origin,name)=>{calls.push(name);return reply(name==='public-manifest.json'?f.manifest:f.blob);};
 assert.deepEqual(await download({origin:'https://'+f.host,tokenFile:f.tokenFile,targetDir:target,transport}),{downloaded:true});
 assert.deepEqual(calls,['public-manifest.json','cipherblob.json']);assert.equal(fs.existsSync(target),true);
});
