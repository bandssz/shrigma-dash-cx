import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {randomUUID,randomBytes} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {CampaignService} from '../src/campaigns.mjs';
import {Listmonk,UpstreamError} from '../src/listmonk.mjs';
import {mountAdmin} from '../src/admin.mjs';
import {canonical,sha} from '../src/policy.mjs';
import {fixturePolicy,createFixture,fakeProfile} from '../src/test-fixture.mjs';

async function setup(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-internal-access-')),key=randomBytes(32),file=path.join(dir,'ledger.sqlite'),owner=randomBytes(32).toString('base64url');
  const fixture=createFixture(),upstream=await fixture.listen();let store=new Store(file,key,{initialize:true,environment:'production'}),now=Date.parse('2026-10-16T01:00:00Z'),afterRead=null,blockedSubscriber=false;
  store.setMeta('brand_policy',canonical(fixturePolicy));
  const add=(brand,index)=>{const username='fixture-'+index;fixture.profiles.set(username,fakeProfile(brand,index));return store.addUser({login:index===1?'qa@shrigma.com.br':index===2?'qa@fishermans.com.br':'another@shrigma.com.br',brand,passwordHash:'fictitious',credential:{username,token:'synthetic-api-token-only'},apiUserId:100+index,...fixturePolicy[brand]});};
  const alice=add('aristo',1),bob=add('fish',2),carol=add('aristo',3);
  const clientFor=user=>{const c=new Listmonk({origin:upstream.origin,environment:'test',credentials:()=>store.credentials(user.id),timeoutMs:500}),get=c.get.bind(c);c.get=async route=>{if(blockedSubscriber&&route==='/api/subscribers/31')throw new UpstreamError('LISTMONK_HTTP_403',403);const value=await get(route);afterRead?.(route);return value;};return c;};
  let service=new CampaignService({store,clientFor,environment:'production',now:()=>now});
  const app=express();mountAdmin(app,{store,service,secret:{adminSha:sha(owner)},config:{environment:'production'},json:express.json()});const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const request=async(route,body,authorized=true)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+'/owner/'+route,{method:body===undefined?'GET':'POST',headers:{...(authorized?{Authorization:'Bearer '+owner}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
  const grantBody=(overrides={})=>({ledger_id:store.meta('ledger_id'),audit_head:store.db.prepare('SELECT sha FROM audit ORDER BY seq DESC LIMIT 1').get().sha,owner_approval:'SOMENTE_TESTE_INTERNO_APROVADO',expires_at:new Date(now+3600000).toISOString(),grants:[{actor_id:alice.id,brand:'aristo',self_email:'qa@shrigma.com.br'}],...overrides});
  const grant=(overrides={})=>request('internal-test-enable',grantBody(overrides));
  const draft={name:'Campanha fictícia interna',subject:'Assunto fictício',from_email:'email@oaristocrata.com',reply_to:'contato@oaristocrata.com',lists:[11],template_id:21,body:'<p>Teste fictício</p>',altbody:''};
  const create=()=>service.call('listmonk_draft_create',{brand:'aristo',operation_id:randomUUID(),draft},alice.id),call=(name,c,extra={},actor=alice)=>service.call(name,{brand:actor.brand,operation_id:randomUUID(),campaign_id:c.campaign_id,revision:c.revision,...extra},actor.id);
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await upstream.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return{get store(){return store;},get service(){return service;},fixture,alice,bob,carol,draft,request,grantBody,grant,create,call,setNow:v=>{now=v;},get now(){return now;},setAfterRead:f=>{afterRead=f;},setBlocked:v=>{blockedSubscriber=v;},newService:()=>new CampaignService({store,clientFor,environment:'production',now:()=>now}),restart(){store.close();store=new Store(file,key,{environment:'production'});store.recoverInterrupted();service=new CampaignService({store,clientFor,environment:'production',now:()=>now});}};
}

test('owner interno exige autenticação, ledger atual, pessoa/marca e prazo sem abrir comercial',async t=>{
  const x=await setup(t);assert.equal((await x.request('internal-test-enable',x.grantBody(),false)).status,401);assert.equal(x.service.internalAccess,null);
  assert.equal((await x.grant({audit_head:'a'.repeat(64)})).body.error,'LEDGER_REVIEW_REQUIRED');
  assert.equal((await x.grant({grants:[{actor_id:x.alice.id,brand:'fish',self_email:'qa@shrigma.com.br'}]})).body.error,'BRAND_FORBIDDEN');
  assert.equal((await x.grant({grants:[{actor_id:x.alice.id,brand:'aristo',self_email:'external@example.invalid'}]})).body.error,'INTERNAL_ACCESS_REFUSED');
  assert.equal((await x.grant({expires_at:new Date(x.now+604800001).toISOString()})).body.error,'INTERNAL_ACCESS_REFUSED');
  assert.equal((await x.grant({smtp_confirmation:{owner_assertion:'SMTP_NATURAL_OBSERVATION_CONFIRMED',observed_at:new Date(x.now+1).toISOString(),evidence_sha256:'b'.repeat(64)}})).body.error,'SMTP_EVIDENCE_REFUSED');
  const result=await x.grant();assert.equal(result.status,200);assert.equal(result.body.business_enabled,false);assert.equal(result.body.smtp_confirmed,false);assert.equal(x.store.businessEnabled,false);assert.equal(x.service.smtpConfirmed,false);
  assert.equal((await x.request('status')).body.internal_access.targets[0].brand,'aristo');assert.equal(x.fixture.mutations.length,0);
});

test('grant permite leitura e rascunho da pessoa; três ações comerciais param antes de GET/claim',async t=>{
  const x=await setup(t);await x.grant();assert.equal((await x.service.call('listmonk_lists_get',{brand:'aristo'},x.alice.id)).lists.length,1);assert.equal((await x.service.call('listmonk_templates_get',{brand:'aristo'},x.alice.id)).templates.length,1);
  const c=await x.create();assert.equal(c.state,'succeeded');const u=await x.call('listmonk_draft_update',c,{patch:{from_email:x.draft.from_email,reply_to:x.draft.reply_to,subject:'Outra revisão interna'}});assert.equal(u.state,'succeeded');
  for(const name of ['listmonk_campaign_schedule','listmonk_campaign_to_draft','listmonk_campaign_pause']){const n=x.fixture.reads.length,m=x.fixture.mutations.length,claims=x.store.db.prepare('SELECT count(*) n FROM operations').get().n,r=await x.call(name,u,name==='listmonk_campaign_schedule'?{send_at:new Date(x.now+3600000).toISOString()}:{});assert.equal(r.code,'COMMERCIAL_USE_NOT_ENABLED');assert.equal(x.fixture.reads.length,n);assert.equal(x.fixture.mutations.length,m);assert.equal(x.store.db.prepare('SELECT count(*) n FROM operations').get().n,claims);}
  assert.equal((await x.service.call('listmonk_lists_get',{brand:'fish'},x.bob.id)).code,'FIRST_REAL_USE_APPROVAL_REQUIRED');assert.equal((await x.service.call('listmonk_lists_get',{brand:'aristo'},x.carol.id)).code,'FIRST_REAL_USE_APPROVAL_REQUIRED');
  assert.equal((await x.call('listmonk_campaign_test',u,{recipient:'unsub@oaristocrata.com'})).code,'INTERNAL_TEST_RECIPIENT_FORBIDDEN');assert.equal(x.store.businessEnabled,false);
});

test('SMTP depende de atestação natural e GET403 de assinante nunca vira POST de teste',async t=>{
  const x=await setup(t);await x.grant();const c=await x.create(),n=x.fixture.mutations.length;
  assert.equal((await x.call('listmonk_campaign_test',c,{recipient:'qa@shrigma.com.br'})).code,'SMTP_NOT_CONFIRMED');assert.equal(x.fixture.mutations.length,n);
  const proof={owner_assertion:'SMTP_NATURAL_OBSERVATION_CONFIRMED',observed_at:new Date(x.now-1000).toISOString(),evidence_sha256:'c'.repeat(64)};assert.equal((await x.grant({smtp_confirmation:proof})).status,200);assert.equal(x.service.smtpConfirmed,true);assert.equal(x.store.businessEnabled,false);
  x.setBlocked(true);const before=x.store.db.prepare('SELECT count(*) n FROM test_claims').get().n;await assert.rejects(()=>x.call('listmonk_campaign_test',c,{recipient:'qa@shrigma.com.br'}),/CONNECTOR_READ_OR_LEDGER_UNCONFIRMED/);assert.equal(x.fixture.mutations.length,n);assert.equal(x.store.db.prepare('SELECT count(*) n FROM test_claims').get().n,before);
  x.setBlocked(false);const sent=await x.call('listmonk_campaign_test',c,{recipient:'qa@shrigma.com.br'});assert.equal(sent.state,'succeeded');assert.equal(sent.smtp_delivery_proven,false);assert.equal((await x.call('listmonk_campaign_test',c,{recipient:'qa@shrigma.com.br'})).code,'REVISION_ALREADY_TESTED');assert.equal(x.fixture.mutations.filter(m=>m.route.endsWith('/test')).length,1);
  assert.equal((await x.grant()).body.smtp_confirmed,false);assert.equal(x.service.smtpConfirmed,false);assert.equal(x.store.businessEnabled,false);
});

test('marca vem do vínculo individual, não do domínio do inbox; inativo e não confirmado continuam fechados',async t=>{
  const x=await setup(t);x.fixture.subscribers.get(31).email='aristo-self@fishermans.com.br';x.store.db.prepare('UPDATE analysts SET login=? WHERE id=?').run('aristo-self@fishermans.com.br',x.alice.id);const originalRegistry=canonical(x.store.user(x.alice.id).testRecipients);
  assert.equal((await x.grant({grants:[{actor_id:x.alice.id,brand:'aristo',self_email:'qa@shrigma.com.br',self_subscriber_id:31}]})).body.error,'INTERNAL_ACCESS_REFUSED');
  assert.equal((await x.grant({grants:[{actor_id:x.alice.id,brand:'aristo',self_email:'aristo-self@fishermans.com.br',self_subscriber_id:31}],smtp_confirmation:{owner_assertion:'SMTP_NATURAL_OBSERVATION_CONFIRMED',observed_at:new Date(x.now).toISOString(),evidence_sha256:'d'.repeat(64)}})).status,200);assert.equal(canonical(x.store.user(x.alice.id).testRecipients),originalRegistry);const c=await x.create();assert.equal(c.state,'succeeded');
  const sub=x.fixture.subscribers.get(31);sub.status='blocklisted';assert.equal((await x.call('listmonk_campaign_test',c,{recipient:sub.email})).code,'TEST_SUBSCRIBER_INACTIVE');sub.status='enabled';sub.lists[0].subscription_status='unsubscribed';assert.equal((await x.call('listmonk_campaign_test',c,{recipient:sub.email})).code,'TEST_SUBSCRIPTION_INACTIVE');assert.equal(x.fixture.mutations.filter(m=>m.route.endsWith('/test')).length,0);sub.lists[0].subscription_status='confirmed';assert.equal((await x.call('listmonk_campaign_test',c,{recipient:sub.email})).state,'succeeded');assert.equal(canonical(x.store.user(x.alice.id).testRecipients),originalRegistry);
});

test('admissão do grant recusa GET403 e mudança do ledger sem guardar destino nem confirmação',async t=>{
  const x=await setup(t);x.setBlocked(true);const proof={owner_assertion:'SMTP_NATURAL_OBSERVATION_CONFIRMED',observed_at:new Date(x.now).toISOString(),evidence_sha256:'1'.repeat(64)};assert.equal((await x.grant({grants:[{actor_id:x.alice.id,brand:'aristo',self_email:'qa@shrigma.com.br',self_subscriber_id:31}],smtp_confirmation:proof})).body.error,'SELF_SUBSCRIBER_NOT_PERMITTED');assert.equal(x.service.internalAccess,null);assert.equal(x.service.smtpConfirmed,false);assert.equal(x.store.businessEnabled,false);
  x.setBlocked(false);x.setAfterRead(route=>{if(route==='/api/subscribers/31')x.store.audit('fixture',null,'concurrent-read',null,'read');});assert.equal((await x.grant({smtp_confirmation:proof})).body.error,'LEDGER_REVIEW_REQUIRED');assert.equal(x.service.internalAccess,null);assert.equal(x.service.smtpConfirmed,false);assert.equal(x.fixture.mutations.length,0);
});

test('expiração durante leitura fecha antes do claim; reinício perde grant e confirmação',async t=>{
  const x=await setup(t);await x.grant({expires_at:new Date(x.now+1000).toISOString()});x.setAfterRead(route=>{if(route==='/api/lists/11')x.setNow(x.now+2000);});assert.equal((await x.create()).code,'FIRST_REAL_USE_APPROVAL_REQUIRED');assert.equal(x.fixture.mutations.length,0);assert.equal(x.store.db.prepare('SELECT count(*) n FROM operations').get().n,0);
  x.setAfterRead(null);await x.grant({smtp_confirmation:{owner_assertion:'SMTP_NATURAL_OBSERVATION_CONFIRMED',observed_at:new Date(x.now).toISOString(),evidence_sha256:'e'.repeat(64)}});assert.equal(x.service.smtpConfirmed,true);const next=x.newService();assert.equal(next.internalAccess,null);assert.equal(next.smtpConfirmed,false);assert.equal(x.store.businessEnabled,false);
});

test('incerto continua sem repetição; operation_get funciona depois de expirar e reiniciar',async t=>{
  const x=await setup(t);await x.grant({expires_at:new Date(x.now+1000).toISOString(),smtp_confirmation:{owner_assertion:'SMTP_NATURAL_OBSERVATION_CONFIRMED',observed_at:new Date(x.now).toISOString(),evidence_sha256:'f'.repeat(64)}});const c=await x.create();x.fixture.state.failNext='POST';const id=randomUUID(),input={brand:'aristo',operation_id:id,campaign_id:c.campaign_id,revision:c.revision,recipient:'qa@shrigma.com.br'};
  const result=await x.service.call('listmonk_campaign_test',input,x.alice.id);assert.equal(result.state,'uncertain');const n=x.fixture.mutations.length;x.setNow(x.now+2000);x.restart();const observed=await x.service.call('listmonk_operation_get',{operation_id:id},x.alice.id);assert.equal(observed.state,'uncertain');assert.equal(x.fixture.mutations.length,n);assert.equal((await x.service.call('listmonk_campaign_test',input,x.alice.id)).code,'FIRST_REAL_USE_APPROVAL_REQUIRED');assert.equal(x.store.db.prepare('SELECT count(*) n FROM test_claims').get().n,1);
});
