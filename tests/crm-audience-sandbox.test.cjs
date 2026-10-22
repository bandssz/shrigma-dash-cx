'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {PGlite}=require(require.resolve('@electric-sql/pglite',{paths:[path.join(__dirname,'../services/crm-audience-sandbox')]}));
const {createSandbox,PUBLIC_ORIGIN,SOURCE_FILES,safeSource}=require('../services/crm-audience-sandbox/factory.cjs');

const owner='operator@synthetic.invalid',revision='a'.repeat(40);
const credentials=()=>({reader:crypto.randomBytes(32).toString('hex'),writer:crypto.randomBytes(32).toString('hex')});
const request=async(base,pathname,key,options={})=>{
 const response=await fetch(base+pathname,{redirect:'manual',headers:{...(key?{Authorization:'Bearer '+key}:{}),...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})},...(options.body?{method:'POST',body:JSON.stringify(options.body)}:{})});
 return {status:response.status,body:await response.json()};
};
async function serve(s){await new Promise(resolve=>s.server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+s.server.address().port;}

test('isolated real audience HTTP uses distinct synthetic principals and persists only draft receipts',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'crm-audience-sandbox-test-'));
 const keys=credentials(),options={root,owner,publicOrigin:PUBLIC_ORIGIN,revision,credentials:keys};
 let sandbox;
 try{
  sandbox=await createSandbox(options);
  let base=await serve(sandbox);
  const health=await request(base,'/healthz');
  assert.equal(health.status,200);
  assert.deepEqual(health.body,{service:'crm-audience-sandbox',synthetic:true,sourceRevision:revision,ready:true});
  assert.equal((await request(base,'/identity')).status,401);
  assert.equal((await request(base,'/identity','synthetic-manager-key')).status,401);
  assert.equal((await request(base,'/identity',keys.reader,{headers:{Origin:PUBLIC_ORIGIN}})).status,403);
  const writerIdentity=await request(base,'/identity',keys.writer),readerIdentity=await request(base,'/identity',keys.reader);
  assert.deepEqual(writerIdentity.body,{schema:'crm-audience-sandbox-identity-v1',role:'manager',panel:'growth',owner,allowedPanels:['growth'],capabilities:['draft','read_content'],synthetic:true});
  assert.deepEqual(readerIdentity.body,{schema:'crm-audience-sandbox-identity-v1',role:'manager',panel:'growth',owner,allowedPanels:['growth'],capabilities:['read_content'],synthetic:true});
  assert.equal((await request(base,'/dashboard',keys.writer)).status,403);
  const dashboard=await request(base,'/dashboard?painel=growth',keys.reader);
  assert.equal(dashboard.status,200);
  assert.equal(dashboard.body.synthetic,true);
  assert.equal(dashboard.body.capabilities.endpoints.segments,PUBLIC_ORIGIN+'/segments');
  assert.equal(dashboard.body.capabilities.segments.contract_version,'crm-audience-v2');
  assert.deepEqual(dashboard.body.capabilities.segments.brands,['fish','aristo']);
  assert.equal((await request(base,'/campaigns',keys.reader)).status,404);
  assert.equal((await request(base,'/campaign-audience',keys.reader)).status,404);
  assert.equal((await request(base,'/segments?acao=segmentos_listar&brand=fish&limit=50&offset=0','synthetic-manager-key')).status,401);
  const list=await request(base,'/segments?acao=segmentos_listar&brand=fish&limit=50&offset=0',keys.reader);
  assert.equal(list.status,200);
  assert.equal(list.body.catalog.current,true);
  assert.ok(list.body.catalog.fields.every(field=>field.available===false));
  assert.deepEqual(list.body.catalog.products,[]);
  const operationKey=crypto.randomUUID();
  const create={acao:'segmento_criar',brand:'fish',idempotency_key:operationKey,expected_catalog_hash:list.body.catalog.catalog_hash,definition:{schema_version:'crm-audience-v2',brand:'fish',name:'Synthetic list audience',rule:{op:'in_list',list_id:17}}};
  assert.equal((await request(base,'/segments',keys.reader,{body:create})).status,403);
  const saved=await request(base,'/segments',keys.writer,{body:create});
  assert.equal(saved.status,201);
  assert.equal(saved.body.segment.version,1);
  assert.equal(saved.body.segment.brand,'fish');
  assert.equal(saved.body.transport_supported,false);
  const receipt=await request(base,'/segments?acao=segmento_operacao_v2&brand=fish&idempotency_key='+operationKey,keys.writer);
  assert.equal(receipt.status,200);
  assert.equal(receipt.body.operation.action,'segmento_criar');
  assert.equal(receipt.body.operation.receipt.body.segment.id,saved.body.segment.id);
  assert.equal((await request(base,'/segments?acao=segmento_operacao_v2&brand=fish&idempotency_key='+operationKey,keys.reader)).status,404);
  assert.equal((await request(base,'/segments?acao=segmentos_listar&brand=aristo&limit=50&offset=0',keys.reader)).body.segments.length,0);
  const before=fs.readFileSync(path.join(root,'manifest.json'),'utf8');
  assert.ok(!before.includes(keys.writer)&&!before.includes(keys.reader));
  assert.deepEqual(fs.readdirSync(root).sort(),['manifest.json','pgdata']);
  await sandbox.close();sandbox=null;

  // Expiry is repaired only by a real /segments request, with no background
  // refresher and without replacing the saved audience or receipt.
  const expired=new PGlite(path.join(root,'pgdata'));
  await expired.query("UPDATE crm_audience_v2.config SET checked_at=pg_catalog.clock_timestamp()-interval '10 minutes',expires_at=pg_catalog.clock_timestamp()-interval '6 minutes' WHERE brand='fish'");
  await expired.close();

  sandbox=await createSandbox(options);base=await serve(sandbox);
  const persisted=await request(base,'/segments?acao=segmento_operacao_v2&brand=fish&idempotency_key='+operationKey,keys.writer);
  assert.deepEqual(persisted.body,receipt.body);
  const replay=await request(base,'/segments',keys.writer,{body:create});
  assert.equal(replay.status,201);
  assert.equal(replay.body.segment.id,saved.body.segment.id);
  const afterList=await request(base,'/segments?acao=segmentos_listar&brand=fish&limit=50&offset=0',keys.reader);
  assert.equal(afterList.body.catalog.current,true);
  assert.equal(afterList.body.segments.length,1);
  await sandbox.close();sandbox=null;

  await assert.rejects(createSandbox({...options,revision:'b'.repeat(40)}),/CRM_SANDBOX_STATE_INVALID/);
  await assert.rejects(createSandbox({...options,credentials:credentials()}),/CRM_SANDBOX_STATE_INVALID/);
  await assert.rejects(createSandbox({...options,owner:'changed@synthetic.invalid'}),/CRM_SANDBOX_STATE_INVALID/);
  const manifestPath=path.join(root,'manifest.json'),originalManifest=fs.readFileSync(manifestPath,'utf8');
  const changedManifest=JSON.parse(originalManifest);
  changedManifest.sourcePins[SOURCE_FILES[0]]='0'.repeat(64);
  fs.writeFileSync(manifestPath,JSON.stringify(changedManifest));
  await assert.rejects(createSandbox(options),/CRM_SANDBOX_STATE_INVALID/);
  fs.writeFileSync(manifestPath,originalManifest);
  const drift=new PGlite(path.join(root,'pgdata'));
  await drift.query("UPDATE crm_audience_v2.config SET catalog='{}'::jsonb WHERE brand='fish'");
  await drift.close();
  await assert.rejects(createSandbox(options),/CRM_SANDBOX_STATE_INVALID/);
  const repair=new PGlite(path.join(root,'pgdata'));
  await repair.query("UPDATE crm_audience_v2.config SET catalog=$1::jsonb WHERE brand='fish'",[JSON.stringify(safeSource())]);
  await repair.close();
  sandbox=await createSandbox(options);
  await sandbox.close();sandbox=null;
 }finally{if(sandbox)await sandbox.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('a partial or occupied volume never gets reseeded, and identities must be synthetic',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'crm-audience-sandbox-state-'));
 try{
  const options={root,owner,publicOrigin:PUBLIC_ORIGIN,revision,credentials:credentials()};
  await assert.rejects(createSandbox({...options,owner:'real@company.com'}),/CRM_SANDBOX_CONFIG/);
  await assert.rejects(createSandbox({...options,credentials:{reader:'static',writer:'static'}}),/CRM_SANDBOX_CONFIG/);
  fs.writeFileSync(path.join(root,'unrelated.txt'),'occupied');
  await assert.rejects(createSandbox(options),/CRM_SANDBOX_STATE_INVALID/);
  assert.deepEqual(fs.readdirSync(root),['unrelated.txt']);
  fs.rmSync(path.join(root,'unrelated.txt'));
  fs.mkdirSync(path.join(root,'pgdata'));
  await assert.rejects(createSandbox(options),/CRM_SANDBOX_STATE_INVALID/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('the closed Docker build includes every source pin and runs as uid 1000',()=>{
 const docker=fs.readFileSync(path.join(__dirname,'../services/crm-audience-sandbox/Dockerfile'),'utf8');
 const ignore=fs.readFileSync(path.join(__dirname,'../services/crm-audience-sandbox/Dockerfile.dockerignore'),'utf8');
 assert.match(docker,/FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}/);
 assert.match(docker,/USER node/);
 assert.match(docker,/max-old-space-size=384/);
 for(const source of SOURCE_FILES){
  assert.ok(fs.existsSync(path.join(__dirname,'..',source)),source);
  assert.ok(docker.includes(source)||docker.includes(path.posix.dirname(source)+'\/\*'),source+' absent from Dockerfile');
  assert.ok(ignore.includes('!'+source)||ignore.includes('!'+path.posix.dirname(source)+'/*.cjs'),source+' absent from closed build context');
 }
});
