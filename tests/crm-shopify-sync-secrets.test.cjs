'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {config,privateSecrets,SECRET_KEYS}=require('../services/crm-shopify-sync/config.cjs');
const values=Object.fromEntries(SECRET_KEYS.map(k=>[k,k.includes('SECRET')?'synthetic-secret-unused-12345':k==='CRM_SHOPIFY_SYNC_KEY'?'synthetic-unused-private-key-123456':k==='PGPASSWORD'?'synthetic-pg-unused':'synthetic-client-id']));
function file(t,value=values){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shopify-secrets-proof-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const p=path.join(dir,'private.json');fs.writeFileSync(p,JSON.stringify(value),{mode:0o600});return p;}
test('private file supplies only secrets; gates and limits remain in the public configuration',t=>{
 const p=file(t),env={CRM_SHOPIFY_SYNC_SECRETS_FILE:p,CRM_SHOPIFY_SYNC_ENABLED:'false',CRM_SHOPIFY_SYNC_REVISION:'a'.repeat(40),CRM_SHOPIFY_PRODUCER_REVISION:'fixture-v2',PGHOST:'postgres.invalid',PGDATABASE:'listmonk',PGUSER:'crm_shopify_sync'};
 for(const b of ['FISH','ARISTO']){env[`CRM_SHOPIFY_${b}_SHOP`]=b.toLowerCase()+'-fixture.myshopify.com';env[`CRM_SHOPIFY_${b}_WORKFLOW_ID`]='fixture-'+b.toLowerCase();}
 const c=config(env);assert.equal(c.enabled,false);assert.equal(c.key,values.CRM_SHOPIFY_SYNC_KEY);assert.equal(c.pg.password,values.PGPASSWORD);assert.equal(Object.hasOwn(env,'PGPASSWORD'),false);
});
test('public permissions, symlinks and environment duplicates cannot supply credentials',t=>{
 const p=file(t);fs.chmodSync(p,0o644);assert.throws(()=>privateSecrets({CRM_SHOPIFY_SYNC_SECRETS_FILE:p}),/CRM_SHOPIFY_SYNC_SECRETS/);fs.chmodSync(p,0o600);
 const symlink=p+'.link';fs.symlinkSync(p,symlink);assert.throws(()=>privateSecrets({CRM_SHOPIFY_SYNC_SECRETS_FILE:symlink}),/CRM_SHOPIFY_SYNC_SECRETS/);
 assert.throws(()=>privateSecrets({CRM_SHOPIFY_SYNC_SECRETS_FILE:p,PGPASSWORD:'duplicate'}),/CRM_SHOPIFY_SYNC_SECRETS/);
});
test('secret files cannot alter activation, add unexpected fields or grow without limit',t=>{
 for(const value of [{...values,CRM_SHOPIFY_SYNC_ENABLED:'true'},Object.fromEntries(Object.entries(values).filter(([k])=>k!=='PGPASSWORD')),{...values,PGPASSWORD:'x'.repeat(5000)}])assert.throws(()=>privateSecrets({CRM_SHOPIFY_SYNC_SECRETS_FILE:file(t,value)}),/CRM_SHOPIFY_SYNC_SECRETS/);
});
