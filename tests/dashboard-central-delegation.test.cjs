'use strict';
// Disposable identity database and genuine login/CSRF. No production, source
// issuer, provider or real person participates in these tests.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createAuth,PRODUCT_AREAS}=require('../services/dashboard-operational/auth.cjs');
const {productViewsForAreas}=require('../services/dashboard-operational/public/entry.js');
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-delegation-')),dbPath=path.join(dir,'identity.sqlite'),token='synthetic-bootstrap-only';
 const hosts={growth:'crm.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'};
 const config={dbPath,managerHost:'gerencial.synthetic.invalid',areaHosts:hosts,allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'owner@synthetic.invalid',bootstrapTokenSha256:crypto.createHash('sha256').update(token).digest('hex'),encryptionKey:Buffer.alloc(32,7)};
 let auth=createAuth(config);t.after(()=>{auth.close();fs.rmSync(dir,{recursive:true,force:true});});
 await auth.completeBootstrap({email:config.bootstrapAdminEmail,token,password:'synthetic-owner-passphrase',host:config.managerHost,origin:'https://'+config.managerHost});
 const login=await auth.login({email:config.bootstrapAdminEmail,password:'synthetic-owner-passphrase',host:config.managerHost,origin:'https://'+config.managerHost});
 const master={host:config.managerHost,origin:'https://'+config.managerHost,cookieHeader:login.cookie.split(';')[0],csrf:login.csrf,method:'POST'};
 const user=id=>auth.users({context:master}).find(u=>u.id===id);
 async function invite(front,extra={}){
  const area=PRODUCT_AREAS[front],email=front+'@synthetic.invalid';
  const q=auth.createInvite({context:master,email,areas:[area],brand:'fish',productFront:front,requestedAccess:'edit',...extra});
  await auth.acceptInvite({token:q.token,password:'synthetic-manager-passphrase',host:q.host,origin:'https://'+q.host});
  const login=await auth.login({email,password:'synthetic-manager-passphrase',host:q.host,origin:'https://'+q.host});
  return {...q,context:{host:q.host,origin:'https://'+q.host,cookieHeader:login.cookie.split(';')[0],csrf:login.csrf,method:'GET'},login};
 }
 return {get auth(){return auth;},master,config,dbPath,user,invite,reopen(){auth.close();auth=createAuth(config);}};
}
test('Master delegates four distinct fronts; actual READ and requested WRITE stay separate after login/reload',async t=>{
 const f=await fixture(t);
 assert.equal(f.auth.session(f.master).user.role,'superadmin');
 assert.deepEqual(f.auth.session(f.master).user.productFronts,['growth','organico','influs','afiliados']);
 for(const front of Object.keys(PRODUCT_AREAS)){
  const u=await f.invite(front),area=PRODUCT_AREAS[front];
  assert.deepEqual(f.user(u.userId).productFronts,[front]);
  assert.equal(f.user(u.userId).requestedAccess,'edit');assert.equal(f.user(u.userId).permissions[area].edit,false);
  assert.deepEqual(productViewsForAreas([area],f.auth.session(u.context).user.productFronts).map(v=>v.view),[front]);
  assert.equal(f.auth.authorize({...u.context,area,brand:'fish',productFront:front}).id,u.userId);
  assert.throws(()=>f.auth.authorize({...u.context,area,brand:'aristo',productFront:front}),e=>e.code==='BRAND_DENIED');
  assert.throws(()=>f.auth.authorize({...u.context,area,brand:'fish',productFront:front,edit:true}),e=>e.code==='GRANT_DENIED');
 }
 f.reopen();assert.equal(f.auth.session(f.master).user.role,'superadmin');
 for(const u of f.auth.users({context:f.master}).filter(u=>u.role==='manager'))assert.deepEqual(u.productFronts,[u.productFront]);
});
test('Afiliados and Influs cannot borrow the opposite slot or provision its credential',async t=>{
 const f=await fixture(t),af=await f.invite('afiliados'),inf=await f.invite('influs');
 for(const [u,slot,wrongFront]of [[af,'influs-read','influs'],[inf,'tts-read','afiliados']]){
  assert.throws(()=>f.auth.authorize({...u.context,area:'influs',productFront:wrongFront}),e=>e.code==='PRODUCT_DENIED');
  assert.throws(()=>f.auth.getUpstreamCredential({...u.context,area:'influs',brand:'fish',slot,edit:false}),e=>e.code==='PRODUCT_DENIED');
  assert.throws(()=>f.auth.getUpstreamCredential({...u.context,area:'influs',brand:'fish',slot,productFront:f.user(u.userId).productFront,edit:false}),e=>e.code==='PRODUCT_DENIED');
  assert.throws(()=>f.auth.setUpstreamCredential({context:f.master,userId:u.userId,slot,bearer:'synthetic-source-key'}),e=>e.code==='PRODUCT_DENIED');
 }
});
test('front/area mismatch and unauthenticated delegation create no user or grant',async t=>{
 const f=await fixture(t),before=f.auth.users({context:f.master}).length;
 for(const productFront of ['unknown','afiliados'])assert.throws(()=>f.auth.createInvite({context:f.master,email:'invalid@synthetic.invalid',areas:['growth'],brand:'fish',productFront}),e=>e.code==='PRODUCT_SCOPE_INVALID');
 assert.throws(()=>f.auth.createInvite({context:{...f.master,csrf:'wrong'},email:'invalid@synthetic.invalid',areas:['influs'],brand:'fish',productFront:'afiliados'}),e=>e.code==='CSRF_DENIED');
 assert.equal(f.auth.users({context:f.master}).length,before);
});
test('tampering with the front or MAC cannot expand an existing session',async t=>{
 const f=await fixture(t),af=await f.invite('afiliados'),db=new DatabaseSync(f.dbPath);t.after(()=>db.close());
 db.prepare("UPDATE user_product_grants_v1 SET product_front='influs' WHERE user_id=?").run(af.userId);
 assert.equal(f.auth.session(af.context).authenticated,false);
 assert.throws(()=>f.auth.authorize({...af.context,area:'influs',slot:'influs-read'}),e=>e.code==='SESSION_REQUIRED');
 db.prepare('DELETE FROM user_product_grants_v1 WHERE user_id=?').run(af.userId);
 assert.equal(f.auth.session(af.context).authenticated,false);
 assert.throws(()=>f.auth.authorize({...af.context,area:'influs',slot:'tts-read'}),e=>e.code==='SESSION_REQUIRED');
});
test('front transfer retires the old session and invitation before granting the chosen front',async t=>{
 const f=await fixture(t),af=await f.invite('afiliados'),before=f.user(af.userId);
 const result=f.auth.updateUserProfile({context:f.master,userId:af.userId,expectedRevision:before.profileRevision,email:before.email,area:'influs',brand:'fish',access:'read',productFront:'influs'});
 assert.equal(result.state,'ready');assert.equal(f.auth.session(af.context).authenticated,false);
 assert.deepEqual(f.auth.reconcileUserProfileUpdates(),{completed:1,pending:0});
 const current=f.user(af.userId);assert.equal(current.productFront,'influs');assert.equal(current.status,'invited');assert.equal(current.permissions.influs.edit,false);
 assert.throws(()=>f.auth.updateUserProfile({context:f.master,userId:af.userId,expectedRevision:before.profileRevision,email:before.email,area:'influs',brand:'fish',access:'read',productFront:'afiliados'}),e=>e.code==='USER_CHANGED');
});
test('front transfer with a bound original credential waits for its real revocation',async t=>{
 const f=await fixture(t),inf=await f.invite('influs');
 f.auth.setUpstreamCredential({context:f.master,userId:inf.userId,slot:'influs-read',bearer:'synthetic-original-reader'});
 const before=f.user(inf.userId);
 assert.throws(()=>f.auth.updateUserProfile({context:f.master,userId:inf.userId,expectedRevision:before.profileRevision,email:before.email,area:'influs',brand:'fish',access:'read',productFront:'afiliados'}),e=>e.code==='USER_UPDATE_CREDENTIAL_REVOCATION_REQUIRED');
 assert.equal(f.auth.session(inf.context).authenticated,true);assert.equal(f.user(inf.userId).productFront,'influs');
});
test('legacy delegation is preserved while explicit navigation cannot widen a new delegation',async t=>{
 const f=await fixture(t),u=await f.invite('influs',{productFront:undefined});
 assert.equal(f.user(u.userId).productFront,null);assert.deepEqual(f.user(u.userId).productFronts,['influs','afiliados']);
 assert.deepEqual(productViewsForAreas(['influs'],['afiliados']).map(v=>v.view),['afiliados']);
 for(const invalid of [null,['unknown'],['afiliados','afiliados'],['growth']])assert.deepEqual(productViewsForAreas(['influs'],invalid),[]);
});
test('changing only READ/WRITE retains an explicit front and password without manufacturing WRITE',async t=>{
 const f=await fixture(t);
 for(const front of ['influs','afiliados']){
  const u=await f.invite(front),before=f.user(u.userId),db=new DatabaseSync(f.dbPath);
  const password=db.prepare('SELECT password_hash FROM users WHERE id=?').get(u.userId).password_hash;
  try{
   const r=f.auth.updateUserProfile({context:f.master,userId:u.userId,expectedRevision:before.profileRevision,email:before.email,area:'influs',brand:'fish',productFront:front,access:'edit'});
   assert.equal(r.state,'configured');assert.equal(f.user(u.userId).productFront,front);assert.equal(f.user(u.userId).requestedAccess,'edit');assert.equal(f.user(u.userId).permissions.influs.edit,false);
   assert.equal(db.prepare('SELECT password_hash FROM users WHERE id=?').get(u.userId).password_hash,password);
   assert.equal(f.auth.session(u.context).authenticated,true);assert.equal(db.prepare('SELECT count(*) n FROM user_profile_updates_v1 WHERE user_id=?').get(u.userId).n,0);
  }finally{db.close();}
 }
});
test('a legacy reinvite cannot widen a previously explicit Afiliados delegation',async t=>{
 const f=await fixture(t),u=await f.invite('afiliados');
 f.auth.revokeUser({context:f.master,userId:u.userId});
 const q=f.auth.createInvite({context:f.master,email:'afiliados@synthetic.invalid',areas:['influs'],brand:'fish'});
 assert.equal(q.userId,u.userId);assert.equal(f.user(u.userId).productFront,'afiliados');
 assert.deepEqual(f.user(u.userId).productFronts,['afiliados']);assert.equal(f.user(u.userId).permissions.influs.edit,false);
 await f.auth.acceptInvite({token:q.token,password:'synthetic-renewed-passphrase',host:q.host,origin:'https://'+q.host});
 const login=await f.auth.login({email:'afiliados@synthetic.invalid',password:'synthetic-renewed-passphrase',host:q.host,origin:'https://'+q.host});
 assert.deepEqual(login.user.productFronts,['afiliados']);
});
