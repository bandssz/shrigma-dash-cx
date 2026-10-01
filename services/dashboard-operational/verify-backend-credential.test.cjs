'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const V=require('./verify-backend-credential.cjs');

const KEY='private-read-key-0123456789';
const OWNER='Gestora de teste';
const source=(slot='growth-read')=>({slot,expectedOwner:OWNER,bearer:KEY});
const identity=(area,permissions)=>({schema:'shrigma_access_identity_v1',role:'manager',panel:area,allowedPanels:[area],owner:OWNER,...(permissions===undefined?{}:{permissions})});
const response=(body,options={})=>new Response(typeof body==='string'?body:JSON.stringify(body),{status:options.status||200,headers:{'Content-Type':options.contentType||'application/json; charset=utf-8',...options.headers}});

test('direct identity uses only the reviewed HTTPS backend URLs and Bearer header',async()=>{
 for(const [slot,area,host,path,query] of [
  ['growth-read','growth','comunicacao-crm-panel-read.tazdb8.easypanel.host','/read','action=identity&painel=growth'],
  ['organico-read','organico','n8n-n8n.tazdb8.easypanel.host','/webhook/cx-dash-api-306742284c6fac1d','access=1&painel=organico'],
  ['influs-read','influs','n8n-n8n.tazdb8.easypanel.host','/webhook/cx-dash-api-306742284c6fac1d','access=1&painel=influs']
 ]){
  let called=0;
  const result=await V.verifyCredential(source(slot),{fetchImpl:async(url,options)=>{
   called++;
   const target=new URL(url);
   assert.equal(target.protocol,'https:');assert.equal(target.hostname,host);assert.equal(target.pathname,path);assert.equal(target.search.slice(1),query);
   assert.ok(!url.includes(KEY)&&!url.includes(OWNER));
   assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');
   assert.equal(options.headers.Authorization,'Bearer '+KEY);assert.equal(options.headers.Accept,'application/json');
   assert.ok(!Object.hasOwn(options.headers,'Origin'));assert.ok(options.signal);
   return response(identity(area,area==='growth'?{growth:{caps:['read_content']},influs:null}:undefined));
  }});
  assert.equal(called,1);assert.deepEqual(result,{ok:true,slot,area,identityVerified:true,readOnlyProven:false,capabilityEvidence:area==='growth'?'read-caps-only':'unreported',status:'partial'});
  assert.ok(!JSON.stringify(result).includes(KEY)&&!JSON.stringify(result).includes(OWNER));
 }
});

test('read-only slots can use identity check but it remains explicitly partial',async()=>{
 for(const [slot,area] of Object.entries(V.SLOTS)){
  const permissions=area==='growth'?{growth:null,influs:null}:area==='influs'?{growth:null,influs:{caps:['read_creators']}}:undefined;
  const got=await V.verifyCredential(source(slot),{fetchImpl:async()=>response(identity(area,permissions))});
  assert.equal(got.readOnlyProven,false);assert.equal(got.status,'partial');
 }
});

test('wrong owner, CX/master, cross-area, preview and broader panel lists are refused',async()=>{
 const valid=identity('growth',{growth:{caps:['read_content']},influs:null});
 for(const changed of [
  {...valid,owner:'Outra pessoa'},
  {...valid,role:'master',panel:'todos',allowedPanels:['cx','growth','organico','influs']},
  {...valid,panel:'cx',allowedPanels:['cx']},
  {...valid,allowedPanels:['growth','cx']},
  {...valid,allowedPanels:['organico']},
  {...valid,preview:true},
  {...valid,synthetic:true},
  {...valid,schema:'unknown'},
  {...valid,role:'operator'}
 ])await assert.rejects(V.verifyCredential(source(),{fetchImpl:async()=>response(changed)}),/CREDENTIAL_VERIFICATION_REFUSED/);
});

test('write, unknown or cross-area capabilities are refused',async()=>{
 for(const permission of [
  {growth:{caps:['read_content','draft']},influs:null},
  {growth:{caps:['submit']},influs:null},
  {growth:{caps:['new_capability']},influs:null},
  {growth:{caps:['read_content','read_content']},influs:null},
  {growth:{caps:'read_content'},influs:null},
  {growth:{caps:['read_content']},influs:{caps:['read_creators']}}
 ])await assert.rejects(V.verifyCredential(source(),{fetchImpl:async()=>response(identity('growth',permission))}),/CREDENTIAL_VERIFICATION_REFUSED/);
 for(const permission of [
  {growth:null,influs:{caps:['creators_edit']}},
  {growth:{caps:['read_content']},influs:null},
  {growth:null,influs:{caps:['read_creators','future_write']}}
 ])await assert.rejects(V.verifyCredential(source('influs-read'),{fetchImpl:async()=>response(identity('influs',permission))}),/CREDENTIAL_VERIFICATION_REFUSED/);
});

test('unsupported writer and ambiguous links slots fail before any HTTP call',async()=>{
 let called=0;
 for(const slot of ['growth-templates-read','growth-campaign','influs-write','organico-links','cx','unknown'])await assert.rejects(V.verifyCredential(source(slot),{fetchImpl:async()=>{called++;return response({});}}),/CREDENTIAL_VERIFICATION_REFUSED/);
 assert.equal(called,0);
});

test('invalid input and remote protocol/content/size failures fail closed',async()=>{
 let called=0;
 for(const input of [{...source(),bearer:'key with spaces'},{...source(),expectedOwner:' Other '},{...source(),expectedOwner:'x\n'}, {...source(),url:'https://example.test'},null])await assert.rejects(V.verifyCredential(input,{fetchImpl:async()=>{called++;return response({});}}),/CREDENTIAL_VERIFICATION_REFUSED/);
 assert.equal(called,0);
 for(const r of [
  response({}, {status:302}),response({}, {status:401}),response('{}',{contentType:'text/html'}),
  response('not-json'),response('{}',{headers:{'Content-Length':'999999'}}),
  response({schema:'shrigma_access_identity_v1'},{headers:{'Content-Length':'nope'}}),
  response('a'.repeat(V.MAX_RESPONSE_BYTES+1))
 ])await assert.rejects(V.verifyCredential(source(),{fetchImpl:async()=>r}),/CREDENTIAL_VERIFICATION_REFUSED/);
 await assert.rejects(V.verifyCredential(source(),{fetchImpl:async()=>{throw Error(KEY+' '+OWNER);}}),/CREDENTIAL_VERIFICATION_REFUSED/);
});

test('CLI rejects malformed private input without echoing owner or key',()=>{
 const input=JSON.stringify({...source(),bearer:'invalid key'});
 const result=spawnSync(process.execPath,[path.join(__dirname,'verify-backend-credential.cjs')],{input,encoding:'utf8'});
 assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr,'Backend credential verification refused.\n');
 assert.ok(!result.stderr.includes(KEY)&&!result.stderr.includes(OWNER));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-verify-input-'));
 try{
  const file=path.join(root,'input.json');fs.writeFileSync(file,input,{mode:0o644});
  const fd=fs.openSync(file,'r');try{
   const leaked=spawnSync(process.execPath,[path.join(__dirname,'verify-backend-credential.cjs')],{stdio:[fd,'pipe','pipe'],encoding:'utf8'});
   assert.equal(leaked.status,1);assert.equal(leaked.stdout,'');assert.equal(leaked.stderr,'Backend credential verification refused.\n');
  }finally{fs.closeSync(fd);}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
