// The human-authorized native grant keeps its exact deadline on a code return.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import {Store} from '../src/store.mjs';
import {mountAdmin} from '../src/admin.mjs';
test('return restores the same unexpired grant with its original confirmed SMTP observation',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'connector-grant-return-')),owner=crypto.randomBytes(32).toString('base64url'),store=new Store(path.join(directory,'db'),crypto.randomBytes(32),{initialize:true,environment:'production'});
 store.setMeta('brand_policy','{}');store.audit('administrator',null,'synthetic_bootstrap',null,'succeeded');
 const now=Date.parse('2026-10-22T09:00:00Z'),grant={expiresAt:'2026-10-24T17:55:53.181Z',targets:[{actorId:crypto.randomUUID(),brand:'fish',selfEmail:'internal@shrigma.com.br'}]},service={now:()=>now,internalAccess:null,smtpConfirmed:false,prepareInternalAccess:async(grants,expiry)=>{assert.equal(expiry,grant.expiresAt);assert.equal(grants[0].actor_id,grant.targets[0].actorId);return structuredClone(grant);}};
 const app=express();mountAdmin(app,{store,secret:{adminSha:crypto.createHash('sha256').update(owner).digest('hex')},config:{environment:'production'},service,json:express.json()});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));store.close();fs.rmSync(directory,{recursive:true,force:true});});
 const request=async observed=>{const body={ledger_id:store.meta('ledger_id'),audit_head:store.db.prepare('SELECT sha FROM audit ORDER BY seq DESC LIMIT 1').get().sha,owner_approval:'SOMENTE_TESTE_INTERNO_APROVADO',expires_at:grant.expiresAt,grants:[{actor_id:grant.targets[0].actorId,brand:'fish',self_email:'internal@shrigma.com.br'}],smtp_confirmation:{owner_assertion:'SMTP_NATURAL_OBSERVATION_CONFIRMED',observed_at:observed,evidence_sha256:'a'.repeat(64)}};const r=await fetch('http://127.0.0.1:'+server.address().port+'/owner/internal-test-enable',{method:'POST',headers:{Authorization:'Bearer '+owner,'Content-Type':'application/json'},body:JSON.stringify(body)});return{http:r.status,body:await r.json()};};
 const valid=await request('2026-10-20T15:19:02.333Z');assert.equal(valid.http,200);assert.deepEqual(service.internalAccess,grant);assert.equal(service.smtpConfirmed,true);assert.equal(store.businessEnabled,false);assert.equal(valid.body.expires_at,grant.expiresAt);
 const future=await request('2026-10-22T09:00:00.001Z');assert.equal(future.http,400);assert.equal(future.body.error,'SMTP_EVIDENCE_REFUSED');assert.deepEqual(service.internalAccess,grant);
});
