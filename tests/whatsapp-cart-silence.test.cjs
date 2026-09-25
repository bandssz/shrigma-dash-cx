'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const {expressions,OLD_COMMENT,patchCode,patchWorkflow,sha256}=require('../n8n/growth/whatsapp-cart-silence.cjs');
async function setup(){const db=new PGlite();await db.exec(`
 CREATE FUNCTION shrigma_flow_wait(brand text,channel text,piece text,minutes numeric) RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT make_interval(secs=>minutes::double precision*60) $$;
 CREATE FUNCTION shrigma_wa_silencio(ts timestamptz) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT date_part('hour',ts AT TIME ZONE 'America/Sao_Paulo') NOT BETWEEN 8 AND 21 $$;
`);return db;}
async function evaluate(db,cartAt,now,piece,brand='aristo'){
 const e=expressions(brand,piece),clock="'"+now+"'::timestamptz";
 const q=`WITH g AS(SELECT $1::timestamptz AS cart_at,${clock}-$1::timestamptz AS idade)
 SELECT ${e.deadline} AS deadline,${e.old.replaceAll('now()',clock)} AS old_upper,
  NOT shrigma_wa_silencio(${clock}) AND ${clock}>=${e.due} AND ${e.replacement.replaceAll('now()',clock)} AS eligible
 FROM g`;
 return (await db.query(q,[cartAt])).rows[0];
}
test('t1 due exactly 22h waits until 08h and keeps all of the 08h–12h window',async()=>{
 const db=await setup();try{for(const brand of ['aristo','fish']){
  const cart='2026-09-23T21:30:00-03:00',piece='carrinho-30min';
  for(const [now,expected] of [['2026-09-23T21:59:59-03:00',false],['2026-09-23T22:00:00-03:00',false],['2026-09-24T07:59:59-03:00',false],['2026-09-24T08:00:00-03:00',true],['2026-09-24T08:30:00-03:00',true],['2026-09-24T11:59:59-03:00',true],['2026-09-24T12:00:00-03:00',false]]){
   const r=await evaluate(db,cart,now,piece,brand);assert.equal(r.eligible,expected,brand+' '+now);assert.equal(r.deadline.toISOString(),'2026-09-24T15:00:00.000Z');
   if(now==='2026-09-24T08:30:00-03:00')assert.equal(r.old_upper,false,'the previous 11h ceiling expired at 08:30');
  }
 }}finally{await db.close();}
});
test('t24 due exactly 22h is no longer discarded at the next opening',async()=>{
 const db=await setup();try{for(const brand of ['aristo','fish']){
  for(const [now,expected] of [['2026-09-24T22:00:00-03:00',false],['2026-09-25T07:59:59-03:00',false],['2026-09-25T08:00:00-03:00',true],['2026-09-25T11:59:59-03:00',true],['2026-09-25T12:00:00-03:00',false]]){
   const r=await evaluate(db,'2026-09-23T22:00:00-03:00',now,'carrinho-24h',brand);assert.equal(r.eligible,expected);assert.equal(r.deadline.toISOString(),'2026-09-25T15:00:00.000Z');
   if(now==='2026-09-25T08:00:00-03:00')assert.equal(r.old_upper,false,'34h previously elapsed before a single permitted send');
  }
 }}finally{await db.close();}
});
test('midnight/morning due times open on the same morning, while exactly 08h keeps normal deadlines',async()=>{
 const db=await setup();try{
  for(const [cart,piece] of [['2026-09-24T01:30:00-03:00','carrinho-30min'],['2026-09-23T02:00:00-03:00','carrinho-24h'],['2026-09-24T07:29:59-03:00','carrinho-30min']]){
   assert.equal((await evaluate(db,cart,'2026-09-24T07:59:59-03:00',piece)).eligible,false);
   assert.equal((await evaluate(db,cart,'2026-09-24T08:00:00-03:00',piece)).eligible,true);
   assert.equal((await evaluate(db,cart,'2026-09-24T11:59:59-03:00',piece)).eligible,true);
   assert.equal((await evaluate(db,cart,'2026-09-24T12:00:00-03:00',piece)).eligible,false);
  }
  assert.equal((await evaluate(db,'2026-09-24T07:30:00-03:00','2026-09-24T08:00:00-03:00','carrinho-30min')).deadline.toISOString(),'2026-09-24T14:30:00.000Z');
  assert.equal((await evaluate(db,'2026-09-23T08:00:00-03:00','2026-09-24T08:00:00-03:00','carrinho-24h')).deadline.toISOString(),'2026-09-24T14:00:00.000Z');
 }finally{await db.close();}
});
test('due before 22h is unchanged; no late catch-up or t1/t24 overlap is introduced',async()=>{
 const db=await setup();try{
  for(const [cart,piece]of [['2026-09-23T21:29:00-03:00','carrinho-30min'],['2026-09-22T21:59:00-03:00','carrinho-24h']]){
   const active=await evaluate(db,cart,'2026-09-23T21:59:00-03:00',piece);assert.equal(active.eligible,true);
   assert.equal((await evaluate(db,cart,'2026-09-23T22:00:00-03:00',piece)).eligible,false);
   assert.equal((await evaluate(db,cart,'2026-09-24T08:00:00-03:00',piece)).eligible,false);
  }
  const e=expressions('aristo','carrinho-30min');
  const r=(await db.query(`WITH g AS(SELECT t AS cart_at FROM generate_series('2026-09-23T00:00:00-03:00'::timestamptz,'2026-09-24T00:00:00-03:00'::timestamptz,interval '1 minute')t) SELECT max(${e.deadline}-cart_at)<interval '24 hours' AS nonoverlap FROM g`)).rows[0];assert.equal(r.nonoverlap,true);
 }finally{await db.close();}
});
test('only reviewed expressions and comment change; other rules and nodes remain byte-identical',()=>{
 const code=OLD_COMMENT+'\nconst guards="optout reservation NOT shrigma_wa_silencio(now())";\nconst a=`'+expressions('aristo','carrinho-30min').old+'`;const b=`'+expressions('aristo','carrinho-24h').old+'`;';
 const nodes=[{name:'Monta SQL elegíveis',type:'n8n-nodes-base.code',parameters:{jsCode:code}},{name:'Sender untouched',parameters:{reserve:true}}];
 const w={id:'APG7xy5uY4YzU6vA',versionId:'fresh',activeVersionId:'fresh',active:true,nodes,connections:{untouched:true},activeVersion:{versionId:'fresh',nodes:structuredClone(nodes),connections:{untouched:true}}};
 const expected={versionId:'fresh',codeSha256:sha256(code)},before=structuredClone(w),r=patchWorkflow(w,expected);
 assert.deepEqual(w,before);assert.deepEqual(r.workflow.nodes[1],w.nodes[1]);assert.deepEqual(r.workflow.connections,w.connections);assert.deepEqual(r.workflow.activeVersion,w.activeVersion);
 assert.ok(r.workflow.nodes[0].parameters.jsCode.includes('const guards="optout reservation NOT shrigma_wa_silencio(now())";'));
 assert.throws(()=>patchWorkflow(w,{...expected,versionId:'stale'}),/VERSION_DRIFT/);assert.throws(()=>patchCode(code.replace('interval \'11 hours\'','interval \'12 hours\''),'aristo'),/SOURCE_DRIFT/);
 assert.throws(()=>patchCode(r.workflow.nodes[0].parameters.jsCode,'aristo'),/ALREADY_PATCHED/);
});
