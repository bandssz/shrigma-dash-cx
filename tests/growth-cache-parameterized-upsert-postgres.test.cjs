'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const P=require('../n8n/growth/growth-cache-parameterized-upsert.cjs');

const schema='(painel text PRIMARY KEY,payload jsonb NOT NULL,gerado_em timestamptz NOT NULL DEFAULT now(),bytes integer,origem_ms integer)';
function legacy(table,input,started,now){
 const {parameters:[text,bytes,origin]}=P.prepareCacheParameters(input,started,now);
 const literal=text.includes('$crmjson$')?`'${text.replace(/'/g,"''")}'`:`$crmjson$${text}$crmjson$`;
 return `INSERT INTO ${table} (painel,payload,gerado_em,bytes,origem_ms) VALUES ('growth',${literal}::jsonb,now(),${bytes},${origin}) ON CONFLICT (painel) DO UPDATE SET payload=EXCLUDED.payload,gerado_em=now(),bytes=EXCLUDED.bytes,origem_ms=EXCLUDED.origem_ms`;
}
async function rows(db){
 const a=await db.query("SELECT painel,payload,gerado_em::text,bytes::text,origem_ms::text FROM legacy_cache WHERE painel='growth'");
 const b=await db.query("SELECT painel,payload,gerado_em::text,bytes::text,origem_ms::text FROM dash_payload_cache WHERE painel='growth'");
 return [a.rows[0],b.rows[0]];
}
test('legacy literal and parameterized upserts are contract-identical for insert and update',async t=>{
 const db=new PGlite();t.after(()=>db.close());await db.exec(`CREATE TABLE legacy_cache${schema};CREATE TABLE dash_payload_cache${schema};BEGIN`);
 const direct={gerado_em:'2026-09-29T18:00:00Z',title:'direto 😀',nested:{quote:"O'Brien",tag:'$crmjson$'}};
 const noCollision={gerado_em:'2026-09-29T17:50:00Z',title:"O'Brien 😀 sem colisão",rows:[1,null,false]};
 const wrapped={body:{gerado_em:'2026-09-29T18:10:00Z',title:"x'); DROP TABLE dash_payload_cache; --",rows:['𐐷',null,true],tag:'$crmjson$'}};
 for(const input of [noCollision,direct,wrapped]){
  const args=P.prepareCacheParameters(input,1000,2250).parameters;
  await db.exec(legacy('legacy_cache',input,1000,2250));await db.query(P.SQL,args);
  const [oldRow,newRow]=await rows(db);assert.deepEqual(newRow,oldRow);assert.deepEqual(newRow.payload,P.payloadFrom(input));assert.equal(newRow.bytes,String(args[1]));assert.equal(newRow.origem_ms,'1250');
 }
 assert.equal((await db.query("SELECT to_regclass('dash_payload_cache') IS NOT NULL AS ok")).rows[0].ok,true);
 await db.exec('ROLLBACK');
});
