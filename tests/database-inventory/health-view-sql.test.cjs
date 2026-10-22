'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {PGlite}=require(process.env.CATALOG_PGLITE_MODULE||'@electric-sql/pglite');
const I=require(path.join(process.env.DB_INVENTORY_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational'),'native-database-inventory.cjs'));
const name='public.shrigma_growth_email_ses_health_v1';
test('fixed catalog SQL parses on isolated PostgreSQL17 and distinguishes structural evidence without reading the view',async()=>{
 const db=new PGlite();
 try{
  assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name,'template1');
  assert.equal(Math.floor(Number((await db.query("SELECT current_setting('server_version_num') AS version")).rows[0].version)/10000),17);
  // PGlite has its isolated template1 database. Check the production guard
  // unchanged, then substitute only this literal for SQL grammar cases.
  const guard="pg_catalog.current_database()='listmonk'";
  assert.equal(I.CATALOG.healthView.sql.split(guard).length,2);
  const grammarSql=I.CATALOG.healthView.sql.replace(guard,"pg_catalog.current_database()='template1'");
  const check=async(sql,expected)=>{
   await db.exec('CREATE OR REPLACE VIEW '+name+' AS '+sql);
   await db.exec(I.BEGIN);
   try{
    assert.equal((await db.query(I.CATALOG.healthView.sql)).rows.length,0);
    const rows=(await db.query(grammarSql)).rows;
    assert.equal(rows.length,1);
    const row=rows[0];assert.equal(row.namespace,'public');assert.equal(row.name,'shrigma_growth_email_ses_health_v1');
    assert.match(row.definition_sha256,/^[a-f0-9]{64}$/);assert(row.definition_utf8_bytes>0);
    for(const [k,v] of Object.entries(expected))assert.equal(row[k],v,k);
    assert.deepEqual(Object.keys(row),['oid','namespace','name','ownerRole','acl','definition_utf8_bytes','definition_sha256','fixed_fish_aristo_values_seed','empty_brands_literal','brands_jsonb_agg','_definition_source']);
    assert.equal(typeof row._definition_source,'string');
    assert.equal(Buffer.byteLength(row._definition_source,'utf8'),row.definition_utf8_bytes);
    assert.equal(require('node:crypto').createHash('sha256').update(row._definition_source,'utf8').digest('hex'),row.definition_sha256);
    assert(!Object.hasOwn(row,'payload'));assert(!Object.hasOwn(row,'source'));assert(!Object.hasOwn(row,'definition'));
   }finally{await db.exec(I.ROLLBACK);}
  };
  await check("SELECT jsonb_build_object('brands','[]'::jsonb) AS payload",{fixed_fish_aristo_values_seed:false,empty_brands_literal:true,brands_jsonb_agg:false});
  await check("SELECT jsonb_build_object('brands',(SELECT jsonb_agg(jsonb_build_object('marca',b.marca)) FROM (VALUES ('fish'),('aristo')) b(marca))) AS payload",{fixed_fish_aristo_values_seed:true,empty_brands_literal:false,brands_jsonb_agg:true});
  await check("SELECT jsonb_build_object('brands',(SELECT jsonb_agg(jsonb_build_object('marca',b.marca)) FROM (VALUES ('aristo'),('fish')) b(marca))) AS payload",{fixed_fish_aristo_values_seed:true,empty_brands_literal:false,brands_jsonb_agg:true});
  await check("SELECT jsonb_build_object('brands',jsonb_build_array(jsonb_build_object('marca','fish'))) AS payload",{fixed_fish_aristo_values_seed:false,empty_brands_literal:false,brands_jsonb_agg:false});
  // An error if the view were evaluated proves that catalog inspection does
  // not execute its payload expression. No original resource is involved.
  await check("SELECT jsonb_build_object('brands',(1 / 0)) AS payload",{fixed_fish_aristo_values_seed:false,empty_brands_literal:false,brands_jsonb_agg:false});
  await db.exec('DROP VIEW '+name);
  assert.equal((await db.query(grammarSql)).rows.length,0);
 }finally{await db.close();}
});
