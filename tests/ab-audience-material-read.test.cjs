'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{PGlite}=require('@electric-sql/pglite');
const F=require('./ab-audience-material-read-fixture.cjs'),R=require('../n8n/growth/ab-audience-material-read.cjs');
const init=async t=>{const db=new PGlite();t.after(()=>db.close());return F.setup(db);};
for(const brand of ['fish','aristo'])test(brand+': database material snapshots preserve campaign/dependency material and never authorize execution',async t=>{
 const x=await init(t),before=(await x.db.query('SELECT to_jsonb(c) row FROM campaigns c ORDER BY id')).rows,v=await x.read(brand);
 assert.equal(v.materials.length,2);assert.equal(v.external_dependencies_complete,false);assert.equal(v.authorizes_send,false);assert.equal(v.execution_blocked,true);
 for(const m of v.materials){assert.equal(m.brand,brand);assert.equal(m.snapshot.campaign.id,m.campaign_id);assert.equal(m.snapshot.template.id,m.snapshot.campaign.template_id);assert.match(m.material_hash,/^[a-f0-9]{64}$/);assert.equal(m.snapshot.campaign.status,undefined);assert.equal(m.snapshot.campaign.sent,undefined);}
 assert.deepEqual((await x.db.query('SELECT to_jsonb(c) row FROM campaigns c ORDER BY id')).rows,before);assert.deepEqual((await x.read(brand)).materials,v.materials);
});
test('changed template material changes the material hash of both campaigns without changing their native rows',async t=>{
 const x=await init(t),before=await x.read(),oldVersion=await x.current(100);
 await x.db.query("UPDATE templates SET body='<section>{{ template \"content\" . }}</section>' WHERE id=1");
 const after=await x.read();for(let i=0;i<2;i++)assert.notEqual(after.materials[i].material_hash,before.materials[i].material_hash);assert.notEqual((await x.current(100)).version,oldVersion.version);
});
test('missing, deferred, unvalidated or disabled foreign-key enforcement refuses the reader before capturing material',async t=>{
 for(const mode of ['missing','deferred','unvalidated','disabled','replica']){
  const x=await init(t);
  if(mode==='missing')await x.db.query('ALTER TABLE campaign_lists DROP CONSTRAINT material_cl_campaign_fk');
  if(mode==='deferred')await x.db.query('ALTER TABLE campaign_lists ALTER CONSTRAINT material_cl_campaign_fk DEFERRABLE INITIALLY IMMEDIATE');
  if(mode==='unvalidated'){await x.db.query('ALTER TABLE campaign_lists DROP CONSTRAINT material_cl_campaign_fk');await x.db.query('ALTER TABLE campaign_lists ADD CONSTRAINT material_cl_campaign_fk FOREIGN KEY(campaign_id) REFERENCES campaigns(id) NOT VALID');}
  if(mode==='disabled')await x.db.query('ALTER TABLE campaign_lists DISABLE TRIGGER ALL');
  if(mode==='replica')await x.db.query("SET session_replication_role='replica'");
  x.trace.length=0;await assert.rejects(x.read(),e=>e.code===(mode==='replica'?'AB_MATERIAL_READ_BOUNDARY':'AB_MATERIAL_READ_FOREIGN_KEYS'),mode);assert.equal(x.trace.some(r=>r.text===R.SQL.snapshots),false);
 }
});
test('unbounded session or multiple transactions cannot claim one locked snapshot',async t=>{
 const x=await init(t);await x.db.query("SET statement_timeout='0'");await assert.rejects(x.read(),e=>e.code==='AB_MATERIAL_READ_BOUNDARY');await x.db.query("SET statement_timeout='20s'");await x.db.query("SET lock_timeout='500ms'");
 await x.db.query("SET TimeZone='UTC'");await x.db.query("SET DateStyle='ISO, YMD'");
 await assert.rejects(R.readCampaignMaterials({query:(q,v)=>x.db.query(q,v),brand:'fish',campaignIds:[100,101]}),e=>e.code==='AB_MATERIAL_READ_BOUNDARY');
});
test('query failures, drift, abort and invalid campaign input remain explicit failures with no partial material',async t=>{
 const x=await init(t);let captures=0;x.control.afterQuery=async(q,v,tx)=>{if(q===R.SQL.snapshots&&++captures===1)await tx.query("UPDATE templates SET body='changed during capture' WHERE id=1");};
 await assert.rejects(x.read(),e=>e.code==='AB_MATERIAL_READ_DRIFT');x.control.afterQuery=null;
 assert.notEqual((await x.db.query('SELECT body FROM templates WHERE id=1')).rows[0].body,'changed during capture','caller rollback preserves the old template');
 for(const ids of [[100,200],[100,100],[100,999],['100'],[100,101,200]])await assert.rejects(x.read('fish',ids));
 const c=new AbortController();c.abort();await assert.rejects(x.read('fish',[100],{signal:c.signal}),e=>e.code==='AB_MATERIAL_READ_ABORTED');
 x.control.beforeQuery=async q=>{if(q===R.SQL.snapshots)throw Error('synthetic connection secret');};await assert.rejects(x.read(),e=>e.code==='AB_MATERIAL_READ_UNCONFIRMED'&&!e.message.includes('secret'));x.control.beforeQuery=null;
});
test('large valid HTML survives the database read, while raw JSONB numeric precision cannot collapse silently',async t=>{
 const x=await init(t),html='<p>'+('Conteúdo sintético. '.repeat(4000))+'</p>';
 await x.db.transaction(async tx=>{await tx.query("SELECT set_config('shrigma.campaign_writer','100',true)");await tx.query('UPDATE campaigns SET body=$1 WHERE id=100',[html]);});
 assert.equal((await x.read()).materials[0].snapshot.campaign.body,html);
 for(const number of ['1.00000000000000001','9007199254740991.1','0.00000000000000001','9007199254740992']){
  await x.db.query('UPDATE media SET meta=$1::jsonb WHERE id=1',['{"precision":'+number+'}']);await assert.rejects(x.read(),e=>e.code==='AB_MATERIAL_READ_UNCONFIRMED',number);
 }
});
test('timestamps require UTC before native version capture and cannot be read under another session timezone',async t=>{
 const x=await init(t),before=await x.read();await x.db.query("SET TimeZone='America/Sao_Paulo'");await x.db.query("SET lock_timeout='500ms'");
 await x.db.query("SET DateStyle='ISO, YMD'");
 await assert.rejects(x.transaction(tx=>R.readCampaignMaterials({query:tx.query,brand:'fish',campaignIds:[100]})),e=>e.code==='AB_MATERIAL_READ_BOUNDARY');
 await x.db.query("SET TimeZone='UTC'");await x.db.query("SET DateStyle='SQL, DMY'");
 await assert.rejects(x.transaction(tx=>R.readCampaignMaterials({query:tx.query,brand:'fish',campaignIds:[100]})),e=>e.code==='AB_MATERIAL_READ_BOUNDARY');
 const corrected=await x.read();assert.deepEqual(corrected.materials,before.materials);
});
test('deadline and later abort signal stop the result without claiming the underlying query was cancelled',async()=>{
 for(const mode of ['deadline','abort']){
  let release,observedSignal,calls=0;const c=new AbortController();
  const query=(_q,_v,options)=>{calls++;observedSignal=options.signal;return new Promise(resolve=>{release=()=>resolve({rows:[]});});};
  const reading=R.readCampaignMaterials({query,brand:'fish',campaignIds:[100],signal:c.signal,timeoutMs:20});
  if(mode==='abort')c.abort();
  await assert.rejects(reading,e=>e.code===(mode==='deadline'?'AB_MATERIAL_READ_TIMEOUT':'AB_MATERIAL_READ_ABORTED'));
  assert.equal(observedSignal.aborted,true);release();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 }
});
