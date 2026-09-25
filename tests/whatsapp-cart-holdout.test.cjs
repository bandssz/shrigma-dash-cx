'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const {START,END,patchCode,patchWorkflow,sha256}=require('../n8n/growth/whatsapp-cart-holdout.cjs');
const migration=fs.readFileSync(path.join(__dirname,'../n8n/growth/whatsapp-cart-holdout.sql'),'utf8');
const candidate=(id,toque='carrinho-30min')=>({subscriber_id:id,cart_ref:'synthetic-cart-'+id,cart_at:new Date(Date.now()-3600000).toISOString(),phone:'55119'+String(id).padStart(8,'0'),piece:toque});
async function setup(){
 const db=new PGlite();
 await db.exec("CREATE TABLE shrigma_send_log(brand text,channel text,flow text,ref text,piece text,wamid text);"+migration);
 return db;
}
async function enable(db){await db.exec("UPDATE growth_wa_cart_holdout_run SET enrollment_enabled=true,starts_at=now()-interval '2 hours',enrollment_ends_at=now()+interval '7 days'");}
async function gate(db,rows){return (await db.query('SELECT growth_wa_cart_holdout_gate_v1($1,$2::jsonb) AS d',['aristo',JSON.stringify(rows)])).rows[0].d;}
const count=async(db,table)=>Number((await db.query('SELECT count(*) AS n FROM '+table)).rows[0].n);
const key=c=>c.subscriber_id+'|'+c.cart_ref+'|'+c.piece;
test('default is disabled and writes no population; only a 5% protocol can be configured',async()=>{
 const db=await setup();try{
  const c=candidate(1),d=await gate(db,[c]);assert.equal(d[key(c)].send,true);assert.equal(d[key(c)].arm,'outside_experiment');
  assert.equal(await count(db,'growth_wa_cart_holdout_unit'),0);
  await assert.rejects(db.exec('UPDATE growth_wa_cart_holdout_run SET holdout_bps=1000'));
  await assert.rejects(db.exec('UPDATE growth_wa_cart_holdout_run SET enrollment_enabled=true'));
 }finally{await db.close();}
});
test('both arms are registered; repeated t1/t24 and new carts preserve the person allocation',async()=>{
 const db=await setup();try{
  await enable(db);const rows=Array.from({length:2000},(_,i)=>candidate(i+1));
  const d=await gate(db,rows),holdout=rows.filter(c=>d[key(c)].arm==='holdout');
  assert.ok(holdout.length>60&&holdout.length<140,'deterministic 5% probability, not a forced exact quota');
  assert.equal(await count(db,'growth_wa_cart_holdout_unit'),2000);assert.equal(await count(db,'growth_wa_cart_holdout_journey'),2000);
  assert.equal(await count(db,'growth_wa_cart_holdout_eligibility'),2000);
  const h=holdout[0],t24={...h,piece:'carrinho-24h'},samePerson={...h,cart_ref:'synthetic-repeat-cart'};
  for(const c of [h,t24,samePerson,{...h,phone:'5511900000000',subscriber_id:90001}])assert.equal((await gate(db,[c]))[key(c)].send,false);
  assert.equal(await count(db,'growth_wa_cart_holdout_unit'),2000);assert.equal(await count(db,'growth_wa_cart_holdout_journey'),2001);
  assert.equal(await count(db,'growth_wa_cart_holdout_eligibility'),2002);assert.equal(await count(db,'shrigma_send_log'),0);
  await assert.rejects(db.exec("UPDATE growth_wa_cart_holdout_run SET allocation_salt='edfae6b1-73fc-4565-bc4e-2647e4eaf2ae'"),/HOLDOUT_PROTOCOL_ALREADY_ENROLLED/);
  await assert.rejects(db.exec("UPDATE growth_wa_cart_holdout_run SET starts_at=now()"),/HOLDOUT_PROTOCOL_ALREADY_ENROLLED/);
  await assert.rejects(db.exec("UPDATE growth_wa_cart_holdout_run SET enrollment_ends_at=now()+interval '1 day'"),/HOLDOUT_PROTOCOL_ALREADY_ENROLLED/);
 }finally{await db.close();}
});
test('old carts, isolated t24, and any existing send reservation are outside the experiment',async()=>{
 const db=await setup();try{
  await enable(db);
  const old={...candidate(1),cart_at:new Date(Date.now()-10800000).toISOString()},t24=candidate(2,'carrinho-24h'),reserved=candidate(3);
  await db.query("INSERT INTO shrigma_send_log VALUES('aristo','whatsapp','carrinho',$1,'carrinho-30min',NULL)",[reserved.cart_ref]);
  const d=await gate(db,[old,t24,reserved]);for(const c of [old,t24,reserved])assert.equal(d[key(c)].arm,'outside_experiment');
  assert.equal(await count(db,'growth_wa_cart_holdout_unit'),0);assert.equal(await count(db,'shrigma_send_log'),1);
 }finally{await db.close();}
});
test('stopping enrollment never releases held journeys or creates a catch-up t24',async()=>{
 const db=await setup();try{
  await enable(db);const rows=Array.from({length:100},(_,i)=>candidate(i+1)),d=await gate(db,rows),h=rows.find(c=>d[key(c)].arm==='holdout');assert.ok(h);
  await db.exec('UPDATE growth_wa_cart_holdout_run SET enrollment_enabled=false');
  const existing={...h,piece:'carrinho-24h'},newCart={...h,cart_ref:'after-stop'};
  assert.equal((await gate(db,[existing]))[key(existing)].send,false);
  assert.equal((await gate(db,[newCart]))[key(newCart)].arm,'outside_experiment');
  assert.equal(await count(db,'growth_wa_cart_holdout_journey'),100);
 }finally{await db.close();}
});
// A synthetic query contract; no production export or customer data belongs here.
const code="const sql=`WITH classificado AS (SELECT * FROM fixture)\n"+START+"       'a' AS variant\nFROM (\n  SELECT cl.*, row_number() OVER(PARTITION BY cart_id,toque ORDER BY id) AS cart_rank\n  FROM classificado cl WHERE cl.toque IS NOT NULL\n"+END+"`; return [{json:{sql}}];";
test('patch binds fresh active version and changes only the two Growth candidate selectors',()=>{
 const node={name:'Monta SQL elegíveis',type:'n8n-nodes-base.code',parameters:{jsCode:code}},nodes=[node,{name:'No change',parameters:{guard:'optout-silence-reservation'}}];
 const w={id:'APG7xy5uY4YzU6vA',active:true,versionId:'fresh',activeVersionId:'fresh',nodes,connections:{untouched:true},activeVersion:{versionId:'fresh',nodes:structuredClone(nodes),connections:{untouched:true}}};
 const before=structuredClone(w),expected={versionId:'fresh',codeSha256:sha256(code)},r=patchWorkflow(w,expected);
 assert.deepEqual(w,before);assert.deepEqual(r.workflow.nodes[1],w.nodes[1]);assert.deepEqual(r.workflow.connections,w.connections);assert.deepEqual(r.workflow.activeVersion,w.activeVersion);
 assert.throws(()=>patchWorkflow(w,{...expected,versionId:'stale'}),/VERSION_DRIFT/);assert.throws(()=>patchWorkflow({...w,id:'excluded'},expected),/VERSION_DRIFT/);
 assert.throws(()=>patchCode(code+'\n'+END,'aristo'),/SOURCE_DRIFT/);assert.throws(()=>patchCode(r.workflow.nodes[0].parameters.jsCode,'aristo'),/ALREADY_PATCHED/);
});
test('SQL records every eligible candidate before limiting the send list to 500',async()=>{
 const db=await setup();try{
  await enable(db);
  await db.exec("CREATE TABLE fixture(id integer,email text,first_name text,cart_url text,cart_items jsonb,cart_id text,cart_phone text,cart_at timestamptz,toque text); INSERT INTO fixture SELECT n,NULL,NULL,'synthetic',NULL,'synthetic-'||n,'55119'||lpad(n::text,8,'0'),now()-interval '1 hour','t1' FROM generate_series(1,600)n");
  const sql=vm.runInNewContext('(function(){'+patchCode(code,'aristo')+'})()')[0].json.sql;
  assert.equal((await db.query(sql)).rows.length,500);assert.equal(await count(db,'growth_wa_cart_holdout_journey'),600);
  assert.equal(await count(db,'growth_wa_cart_holdout_eligibility'),600);
 }finally{await db.close();}
});
