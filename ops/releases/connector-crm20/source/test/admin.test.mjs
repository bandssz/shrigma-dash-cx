import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto,{randomBytes} from 'node:crypto';
import {initialize,open} from '../src/config.mjs';
import {buildApp} from '../src/server.mjs';
import {fixturePolicy,createFixture,fakeProfile} from '../src/test-fixture.mjs';

test('admin cria identidade individual, recusa reuso e revoga sem expor chave',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-admin-')),owner=randomBytes(32).toString('base64url'),fixture=createFixture(),upstream=await fixture.listen();
  fixture.profiles.set('fixture-1',fakeProfile('aristo',1));fixture.profiles.set('fixture-2',fakeProfile('fish',2));
  const config={data:directory,environment:'test',origin:'http://127.0.0.1',clientId:'synthetic-admin-client',upstream:upstream.origin};
  initialize(config,owner);const{store,secret}=open(config),{app}=buildApp({config,store,secret});const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await upstream.close();store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const request=async(route,body,authorized=true)=>{const response=await fetch(origin+'/owner/'+route,{method:body===undefined?'GET':'POST',headers:{...(authorized?{Authorization:'Bearer '+owner}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
  assert.equal((await request('status',undefined,false)).status,401);
  const mixed=structuredClone(fixturePolicy);mixed.fish.listIds=[11];assert.equal((await request('brand-policy',mixed)).body.error,'CROSS_BRAND_LIST');
  assert.equal((await request('brand-policy',fixturePolicy)).status,200);assert.equal((await request('brand-policy',fixturePolicy)).body.error,'BRAND_POLICY_ALREADY_SET');
  const binding={login:'alice@example.invalid',brand:'aristo',password:'synthetic-password-16-chars',apiUserId:101,username:'fixture-1',token:'synthetic-secret-token-not-real',listIds:[11]};
  const admitted=await request('analysts',binding);assert.equal(admitted.status,200);assert.equal(admitted.body.analyst.apiUserId,101);assert.equal(JSON.stringify(admitted).includes(binding.token),false);assert.equal(JSON.stringify(admitted).includes(binding.password),false);
  const row=store.db.prepare('SELECT * FROM analysts').get();assert.equal(JSON.stringify(row).includes(binding.token),false);assert.equal(JSON.stringify(row).includes(binding.password),false);assert.equal(store.credentials(row.id).token,binding.token);
  assert.equal((await request('analysts',{...binding,login:'other@example.invalid'})).body.error,'API_IDENTITY_ALREADY_BOUND');
  assert.equal((await request('analysts',{...binding,login:'wrong@example.invalid',brand:'fish',listIds:[11]})).body.error,'LIST_BRAND_FORBIDDEN');
  fixture.profiles.get('fixture-1').user_role={id:1,permissions:[]};assert.equal((await request('analysts',{...binding,login:'admin@example.invalid'})).body.error,'API_IDENTITY_ALREADY_BOUND');
  fixture.profiles.set('fixture-1',fakeProfile('aristo',1));
  const beforeRow=store.db.prepare('SELECT * FROM analysts WHERE id=?').get(row.id),replacement={id:row.id,apiUserId:102,username:'fixture-2',token:'synthetic-replacement-secret-16'};
  assert.equal((await request('analyst-credential',replacement,false)).status,401);
  assert.equal((await request('analyst-credential',replacement)).body.error,'API_ROLE_CHANGED');
  assert.equal(store.credentials(row.id).token,binding.token);
  fixture.profiles.set('fixture-3',fakeProfile('aristo',3));
  const changed=await request('analyst-credential',{...replacement,apiUserId:103,username:'fixture-3'});
  assert.equal(changed.status,200);assert.equal(changed.body.analyst.id,row.id);assert.equal(changed.body.analyst.apiUserId,103);
  const afterRow=store.db.prepare('SELECT * FROM analysts WHERE id=?').get(row.id);
  for(const k of ['id','login','active','brand','password_hash'])assert.equal(afterRow[k],beforeRow[k]);
  assert.deepEqual({...JSON.parse(afterRow.config),apiUserId:101},JSON.parse(beforeRow.config));
  assert.equal(store.credentials(row.id).token,replacement.token);assert(!JSON.stringify(changed).includes(replacement.token));
  assert.equal(store.db.prepare('SELECT count(*) n FROM analysts').get().n,1);
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM audit').all()).includes(replacement.token),false);
  assert.equal((await request('revoke',{id:row.id})).body.revoked,true);assert.equal(store.user(row.id).active,false);assert.throws(()=>store.credentials(row.id),e=>e.code==='ANALYST_REVOKED');
  assert.equal(fixture.mutations.length,0);
  const audit=store.db.prepare('SELECT * FROM audit').all();assert.equal(JSON.stringify(audit).includes(binding.token),false);assert.equal(JSON.stringify(audit).includes(binding.password),false);
});

test('produção volta fechada, preserva identidade e recusa inicialização parcial',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-prod-')),owner=randomBytes(32).toString('base64url');const config={data:directory,environment:'production',origin:'https://mcp.example.invalid',clientId:'synthetic-production-client'};
  try{
    initialize(config,owner);let opened=open(config);const id=opened.store.meta('ledger_id');assert.equal(opened.store.businessEnabled,false);opened.store.businessEnabled=true;opened.store.close();
    opened=open(config);assert.equal(opened.store.businessEnabled,false);assert.equal(opened.store.meta('ledger_id'),id);opened.store.close();
    assert.throws(()=>open({...config,environment:'test'}),/ENVIRONMENT_IDENTITY_CHANGED/);
    fs.renameSync(path.join(directory,'ledger.sqlite'),path.join(directory,'saved.sqlite'));assert.throws(()=>initialize(config,owner),/PARTIAL_INITIALIZATION_REFUSED/);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('bootstrap publica somente cifra, que exige a chave privada local do proprietário',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-enroll-')),keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
  const config={data:directory,environment:'production',origin:'https://mcp.example.invalid',clientId:'synthetic-production-client'};
  try{
    initialize(config,null,Buffer.from(keys.publicKey.export({format:'pem',type:'spki'})).toString('base64'));const {store,secret}=open(config);
    const token=crypto.privateDecrypt({key:keys.privateKey,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(secret.ownerEnrollment.ciphertext,'base64')).toString();assert.equal(crypto.createHash('sha256').update(token).digest('hex'),secret.adminSha);assert.equal(JSON.stringify(secret).includes(token),false);assert.equal(store.businessEnabled,false);store.close();
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
