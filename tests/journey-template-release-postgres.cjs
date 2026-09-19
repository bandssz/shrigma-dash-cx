/* Synthetic PostgreSQL and native-template adapter. No live API or transport.
   The fixture digest tests equality, not SHA-256 implementation. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createTemplateReleaseProvider}=require('../n8n/growth/journey-template-provider.cjs');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
(async()=>{
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite();
 try{
  await db.exec(read('tests/sql/journey-cart-fixture.sql'));
  const sql=read('n8n/growth/journey-template-release.sql');await db.exec(sql);await db.exec(sql);
  let nativeCalls=0;const cache=new Map();
  const create=async p=>{
   nativeCalls++;
   const t=(await db.query('INSERT INTO templates(name,type,subject,body,body_source) VALUES($1,$2,$3,$4,$5) RETURNING *',[p.name,p.type,p.subject,p.body,p.body_source])).rows[0];
   cache.set(t.id,{...p});return {status:200,body:{data:t}};
  };
  const provider=createTemplateReleaseProvider({query:(q,a)=>db.query(q,a),nativeCreate:create,cacheTarget:'fixture-single-instance'});
  const plan=await provider.prepare(60);assert.equal(plan.state,'reserved');assert.equal((await provider.prepare(60)).id,plan.id);
  assert.ok(!('claim_token' in plan));
  await assert.rejects(db.query('INSERT INTO templates(name,type,subject,body) VALUES($1,$2,$3,$4)',[plan.clone_name,'tx','Fixture','Fixture']),/RESERVED_CONTENT_REQUIRED/);
  const ready=await provider.create(plan.id),clone=ready.release.clone_template_id;assert.equal(ready.state,'ready');assert.equal(nativeCalls,1);
  assert.equal((await provider.create(plan.id)).created,false);assert.equal(nativeCalls,1,'replay cannot repeat POST');
  assert.equal(cache.get(clone).body,'Fixture');
  // Existing source and default maintenance remain editable; release stays fixed.
  await db.exec("UPDATE templates SET body='New source content' WHERE id=60;UPDATE templates SET is_default=(id=60),updated_at=clock_timestamp()");
  assert.equal((await db.query('SELECT body FROM templates WHERE id=$1',[clone])).rows[0].body,'Fixture');
  assert.equal(cache.get(clone).body,'Fixture');assert.notEqual((await provider.prepare(60)).id,plan.id);
  for(const [column,value] of [['body','Changed'],['subject','Changed'],['name','Ordinary name'],['type','campaign'],['body_source','visual'],['id',900]]){
   await assert.rejects(db.query(`UPDATE templates SET ${column}=$1 WHERE id=$2`,[value,clone]),/IMMUTABLE/);
  }
  await assert.rejects(db.query('UPDATE templates SET is_default=true WHERE id=$1',[clone]),/IMMUTABLE/);
  await assert.rejects(db.query('DELETE FROM templates WHERE id=$1',[clone]),/IMMUTABLE/);
  await assert.rejects(db.query('UPDATE templates SET name=$1 WHERE id=61',[plan.clone_name]),/CREATE_REQUIRED/);
  await assert.rejects(db.query("UPDATE shrigma_journey_template_release_v1 SET snapshot='{}' WHERE id=$1",[plan.id]),/IMMUTABLE/);
  await assert.rejects(db.query('DELETE FROM shrigma_journey_template_release_v1 WHERE id=$1',[plan.id]),/PRESERVE/);
  assert.equal((await db.query('SELECT count(*)::int n FROM shrigma_template_email_registry WHERE template_id=$1',[clone])).rows[0].n,0,'clone is outside branded editor catalog');
  await assert.rejects(db.query("INSERT INTO shrigma_template_email_registry VALUES($1,'fish')",[clone]),/NOT_EDITABLE_CATALOG/);
  await assert.rejects(db.query('UPDATE shrigma_template_email_registry SET template_id=$1 WHERE template_id=61',[clone]),/NOT_EDITABLE_CATALOG/);
  await assert.rejects(provider.prepare(999),/SOURCE_UNAVAILABLE/);
  await db.exec("INSERT INTO templates(id,type,name,subject,body) VALUES(80,'tx','Other brand','Other','Other');INSERT INTO shrigma_template_email_registry VALUES(80,'aristo')");
  await assert.rejects(provider.prepare(80),/SOURCE_UNAVAILABLE/);
  await assert.rejects(db.query('SELECT shrigma_journey_template_begin_v1($1,$2)',[plan.id,'another-instance']),/CACHE_TARGET_MISMATCH/);
  // A dropped acknowledgement retains the same creating reservation and clone.
  const second=await provider.prepare(61),uncertain=createTemplateReleaseProvider({query:(q,a)=>db.query(q,a),cacheTarget:'fixture-single-instance',nativeCreate:async p=>{await create(p);throw Error('Synthetic lost acknowledgement');}});
  await assert.rejects(uncertain.create(second.id),/lost acknowledgement/);const calls=nativeCalls;
  const pending=await provider.create(second.id);assert.equal(pending.state,'creating');assert.equal(pending.created,false);assert.equal(nativeCalls,calls);
  assert.equal((await db.query('SELECT count(*)::int n FROM templates WHERE name=$1',[second.clone_name])).rows[0].n,1);
  await db.exec(sql);assert.equal((await provider.create(second.id)).state,'creating','reinstallation does not release uncertainty');
  console.log('PASS immutable template releases: guarded native clone, source/default edits preserved, cache fixture pinned, no create retry, branded catalog isolation and installation replay. No live cache proof or send.');
 }finally{await db.close();}
})().catch(e=>{console.error(e.message,e.where||'');process.exitCode=1;});
