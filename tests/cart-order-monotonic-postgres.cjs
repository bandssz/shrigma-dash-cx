/* Isolated engine, optional fresh PRIVATE workflow export supplied externally.
   No external request, customer data or live mutation. */
'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const {patchOrderResolution}=require('../n8n/growth/cart-order-monotonic-patch.cjs');
const query=`WITH alvo AS (SELECT id FROM subscribers WHERE lower(email)=lower($1) LIMIT 1),
upd AS (UPDATE subscribers s SET attribs=coalesce(s.attribs,'{}')||jsonb_build_object($2,coalesce(s.attribs->$2,'{}')
 || jsonb_build_object('last_order_at', $4::text)),updated_at=now()
 FROM alvo a\n  WHERE s.id = a.id RETURNING s.id),
del AS (DELETE FROM subscriber_lists USING alvo WHERE subscriber_id=alvo.id AND list_id=$3::int RETURNING subscriber_id)
SELECT (SELECT count(*) FROM upd) subscriber_atualizado,(SELECT count(*) FROM del) removido_da_lista_carrinho;`;
(async()=>{const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite();try{
 const source=process.env.ORDER_WORKFLOW_FILE?JSON.parse(fs.readFileSync(process.env.ORDER_WORKFLOW_FILE,'utf8')):{versionId:'fixture',nodes:[{name:'Resolve carrinho (PG)',type:'n8n-nodes-base.postgres',parameters:{query}}]};
 const patched=patchOrderResolution(source,{expectedVersion:source.versionId}),q=patched.nodes.find(n=>n.name==='Resolve carrinho (PG)').parameters.query;
 await db.exec("CREATE TABLE subscribers(id integer PRIMARY KEY,email text,attribs jsonb,updated_at timestamptz);CREATE TABLE subscriber_lists(subscriber_id integer,list_id integer);CREATE TABLE fixture_reservation(id integer,state text);INSERT INTO fixture_reservation VALUES(1,'outcome_unknown');INSERT INTO subscribers VALUES(1,'fixture@example.invalid','{\"fish\":{\"other\":\"keep\",\"flows\":{\"other_flow\":true}},\"aristo\":{\"last_order_at\":\"2025-01-01T00:00:00Z\"}}',now());INSERT INTO subscriber_lists VALUES(1,22),(1,999)");
 await db.exec('CREATE FUNCTION fixture_order(text,text,integer,text) RETURNS TABLE(subscriber_atualizado bigint,removido_da_lista_carrinho bigint) LANGUAGE sql AS $fixture_order$'+q+'$fixture_order$');
 const get=async()=>(await db.query('SELECT attribs FROM subscribers WHERE id=1')).rows[0].attribs;
 const run=at=>db.query('SELECT * FROM fixture_order($1,$2,$3,$4)',['fixture@example.invalid','fish',22,at]);
 await run('2026-09-19T12:00:00Z');assert.equal((await get()).fish.last_order_at,'2026-09-19T12:00:00Z');
 await run('2026-09-18T12:00:00Z');assert.equal((await get()).fish.last_order_at,'2026-09-19T12:00:00Z','out-of-order event cannot regress marker');
 await run('2026-09-19T09:00:00-03:00');assert.equal((await get()).fish.last_order_at,'2026-09-19T12:00:00Z','same instant in another timezone preserves original marker');
 await run('2026-09-20T12:00:00Z');assert.equal((await get()).fish.last_order_at,'2026-09-20T12:00:00Z');
 assert.equal((await get()).fish.other,'keep');assert.equal((await get()).aristo.last_order_at,'2025-01-01T00:00:00Z');assert.equal((await get()).fish.flows.other_flow,true);
 assert.deepEqual((await db.query('SELECT * FROM subscriber_lists')).rows,[{subscriber_id:1,list_id:999}]);assert.equal((await db.query('SELECT state FROM fixture_reservation')).rows[0].state,'outcome_unknown');
 await assert.rejects(run('not-a-date'));assert.equal((await get()).fish.last_order_at,'2026-09-20T12:00:00Z');
 console.log('PASS order marker monotonicity, equal timezone instants, unrelated fields/lists/reservation preserved; '+(process.env.ORDER_WORKFLOW_FILE?'fresh full query':'synthetic query')+'; no transport.');
}finally{await db.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
