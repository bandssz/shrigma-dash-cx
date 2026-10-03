"use strict";
// Only synthetic SQLite identity + in-memory upstream responses. No sockets,
// real credentials, PostgreSQL, services or production capability changes.
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./helpers/crm-managed-read-auth-fixture.cjs');
const B=require('../services/dashboard-operational/crm-manager-read-bridge.cjs');
const Media=require('../services/dashboard-operational/crm-media-read-validator.cjs');
async function ready(t){const f=await fixture();t.after(()=>f.close());const i=f.invite('manager@synthetic.invalid');await f.accept(i);const login=await f.login('manager@synthetic.invalid'),ctx=f.reader(login),op=f.queued(login.user.id),client=f.client(),prepared=await f.prepare(client,op);await f.commit(client,op,prepared.prepared);return {f,ctx};}
const body=(brand,items)=>({contract:'crm-media-v1',brand,items,total:items.length,page:1,per_page:24,next_page:null});
const item=(name,id=1,thumb=null)=>({id,filename:name,url:'https://email.shrigma.com.br/uploads/'+name,thumb_url:thumb,content_type:'image/png',width:10,height:10,created_at:'2026-10-03T00:00:00Z'});
const canonical=brand=>'crm-'+brand+'-11111111-1111-4111-8111-111111111111-'+'a'.repeat(64)+'.png';
const encode=key=>[...key].map(c=>'%'+c.charCodeAt(0).toString(16)).join('');
function read(f,ctx,brand,value){const upstreams=Object.fromEntries(Object.entries(B.DESTINATIONS).map(([k,v])=>[k,new URL(v)]));return B.createManagedReadBridge({auth:f.auth,upstreams,enabled:true},{fetchImpl:async(url,init)=>{assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,'Bearer '+f.auth.getUpstreamCredential(ctx));return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});}}).read({context:ctx,route:'campaigns_media',method:'GET',query:new URLSearchParams({brand}),origin:'https://'+ctx.host});}
for(const brand of ['fish','aristo']){
 test(brand+': normal canonical and neutral legacy media remain readable without private fields',async t=>{
  const {f,ctx}=await ready(t),name=canonical(brand),value=body(brand,[item(name,1,'https://email.shrigma.com.br/uploads/thumb_'+name),item('legacy.png',2)]),result=await read(f,ctx,brand,value);
  assert.equal(result.status,200);assert.deepEqual(result.body.items.map(i=>[i.id,i.legacy]),[[1,false],[2,true]]);assert.equal(JSON.stringify(result.body).toLowerCase().includes(f.auth.getUpstreamCredential(ctx)),false);
 });
 test(brand+': uppercase individual READ key in legacy filename rejects the whole page',async t=>{
  const {f,ctx}=await ready(t),key=f.auth.getUpstreamCredential(ctx);assert.notEqual(key,key.toUpperCase());
  const value=body(brand,[item(canonical(brand)),item(key.toUpperCase()+'.png',2)]);
  assert.throws(()=>Media.validateMediaLibraryResponse(value,{brand,page:1,per_page:24,secrets:[key]}),{code:'MEDIA_READ_SECRET_ECHO'});
  await assert.rejects(read(f,ctx,brand,value),{status:502,code:'MANAGED_READ_RESPONSE_DENIED'});
 });
 test(brand+': once-decoded admitted canonical thumbnail path cannot echo the individual READ key',async t=>{
  const {f,ctx}=await ready(t),key=f.auth.getUpstreamCredential(ctx),thumb='https://email.shrigma.com.br/uploads/thumb_crm-'+brand+'-'+encode(key)+'.png';
  const value=body(brand,[item(canonical(brand),1,thumb)]);
  assert.throws(()=>Media.validateMediaLibraryResponse(value,{brand,page:1,per_page:24,secrets:[key]}),{code:'MEDIA_READ_SECRET_ECHO'});
  await assert.rejects(read(f,ctx,brand,value),{status:502,code:'MANAGED_READ_RESPONSE_DENIED'});
 });
 test(brand+': decoded echo is refused before foreign legacy exclusion, preserving page atomicity',async t=>{
  const {f,ctx}=await ready(t),key=f.auth.getUpstreamCredential(ctx),other=brand==='fish'?'aristo':'fish',thumb='https://email.shrigma.com.br/uploads/thumb_crm-'+other+'-'+encode(key.toUpperCase())+'.png';
  const value=body(brand,[item(canonical(brand)),item('crm-'+other+'-legacy.png',2,thumb)]);
  assert.throws(()=>Media.validateMediaLibraryResponse(value,{brand,page:1,per_page:24,secrets:[key]}),{code:'MEDIA_READ_SECRET_ECHO'});
  await assert.rejects(read(f,ctx,brand,value),{status:502,code:'MANAGED_READ_RESPONSE_DENIED'});
 });
}
