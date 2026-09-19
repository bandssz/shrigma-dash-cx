/* Synthetic PostgreSQL fixtures; no network, private snapshots or production writes. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {PGlite}=require(process.env.TTS_PGLITE_MODULE||process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {ORIGINAL,RECONCILED,patchCode}=require('../n8n/tiktok/canal-reconciliation-patch.cjs');
(async()=>{
 const db=new PGlite();
 try{
  await db.exec(`CREATE TABLE crm_tts_canal_v(marca text,dia date,gmv numeric,gmv_afiliado numeric,gmv_proprio numeric,gmv_live numeric DEFAULT 20,gmv_video numeric DEFAULT 30,gmv_vitrine numeric DEFAULT 50,gmv_ads numeric DEFAULT 10,pedidos integer DEFAULT 5,visitantes integer DEFAULT 50,reembolso numeric DEFAULT 0);
   INSERT INTO crm_tts_canal_v(marca,dia,gmv,gmv_afiliado,gmv_proprio) VALUES
   ('ok','2026-09-01',100,30,70),('ok','2026-09-02',200,80,120),
   ('above','2026-09-01',100,110,0),('above','2026-09-02',200,100,100),
   ('opposite','2026-09-01',100,110,0),('opposite','2026-09-02',100,80,10),
   ('missing_total','2026-09-01',NULL,20,NULL),('missing_aff','2026-09-01',100,NULL,NULL),
   ('missing_legacy','2026-09-01',100,20,NULL),('mixed_missing','2026-09-01',NULL,20,NULL),('mixed_missing','2026-09-02',100,20,80),
   ('zero','2026-09-01',0,0,0),('zero_above','2026-09-01',0,10,0),
   ('equal','2026-09-01',100,100,0),('outside','2026-08-31',900,800,100),('outside','2026-09-20',900,800,100);`);
  const query=fragment=>`WITH j AS (SELECT '2026-09-01'::date ini,'2026-09-19'::date fim),${fragment.trim().replace(/,$/,'')}
   SELECT jsonb_build_object('daily',(SELECT jsonb_agg(to_jsonb(c) ORDER BY marca,dia) FROM canal c),'total',(SELECT jsonb_agg(to_jsonb(c) ORDER BY marca) FROM canal_tot c)) payload`;
  const before=(await db.query(query(ORIGINAL))).rows[0].payload;
  const after=(await db.query(query(RECONCILED))).rows[0].payload;
  for(const grain of ['daily','total']){
   assert.equal(after[grain].length,before[grain].length,'no rows duplicated or dropped');
   for(let i=0;i<before[grain].length;i++)for(const k of Object.keys(before[grain][i]))assert.deepEqual(after[grain][i][k],before[grain][i][k],`original ${grain}.${k}`);
  }
  const total=brand=>after.total.find(r=>r.marca===brand),day=(brand,d='2026-09-01')=>after.daily.find(r=>r.marca===brand&&r.dia===d);
  assert.equal(total('ok').gmv_saldo_nao_afiliado,190);assert.equal(total('ok').origem_estado,'saldo_calculado');assert.equal(total('ok').gmv_ajuste_origem,0);
  assert.equal(day('above').gmv_afiliado,110,'source is never clipped to total');assert.equal(day('above').gmv_proprio,0,'legacy remains auditable');
  assert.equal(day('above').gmv_saldo_nao_afiliado,null);assert.equal(day('above').gmv_ajuste_origem,-10);assert.equal(total('above').origem_dias_divergentes,1);
  assert.equal(total('above').gmv_saldo_nao_afiliado,null,'positive balance another day cannot hide mismatch');
  assert.equal(total('opposite').gmv_ajuste_origem,0);assert.equal(total('opposite').gmv_ajuste_origem_absoluto,20);assert.equal(total('opposite').origem_dias_divergentes,2);assert.equal(total('opposite').origem_estado,'divergente');
  for(const brand of ['missing_total','missing_aff','missing_legacy','mixed_missing']){
   assert.equal(total(brand).origem_estado,'indisponivel');assert.equal(total(brand).origem_dias_indisponiveis,1);assert.equal(total(brand).gmv_saldo_nao_afiliado,null);assert.equal(total(brand).gmv_ajuste_origem,null);assert.equal(total(brand).gmv_ajuste_origem_absoluto,null);
  }
  for(const brand of ['zero','equal'])assert.equal(total(brand).gmv_saldo_nao_afiliado,0,'known zero remains zero');
  assert.equal(total('zero_above').origem_estado,'divergente');assert.equal(total('outside'),undefined,'window preserved');
  for(const row of after.daily){
   assert.equal(row.origem_modelo,'analytics_total_menos_pedidos_afiliados');
   if(row.origem_estado==='saldo_calculado')assert.equal(row.gmv_afiliado+row.gmv_saldo_nao_afiliado,row.gmv,'compatible parts reconcile');
   else assert.equal(row.gmv_saldo_nao_afiliado,null,'incompatible/unknown does not invent origin');
  }
  // Parse and execute the COMPLETE real node-generated query against the repository DDL.
  // This catches aliases/types/JSON integration errors hidden by isolated CTE tests.
  const full=new PGlite();
  try{
   const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
   await full.exec(read('n8n/tiktok/ddl_crm_tts.sql'));
   // Existing runtime column, confirmed via information_schema; absent from legacy repository DDL.
   await full.exec('ALTER TABLE crm_tts_token ADD COLUMN granted_scopes text[]');
   await full.exec(`INSERT INTO crm_tts_canal_dia(marca,dia,superficie,origem,gmv) VALUES ('fixture','2026-09-01','total','total',100),('fixture','2026-09-02','total','total',200);
    INSERT INTO crm_tts_pedido(marca,order_id,sku_id,dia,base_real,settlement_status) VALUES ('fixture','synthetic-one','sku','2026-09-01',110,'SETTLED'),('fixture','synthetic-two','sku','2026-09-02',100,'SETTLED'),('fixture','synthetic-ineligible','sku','2026-09-02',999,'INELIGIBLE');`);
   const source=read('n8n/tiktok/api_sql.js');
   const execute=code=>new vm.Script('(function(){'+code+'})()').runInNewContext({$json:{body:{ini:'2026-09-01',fim:'2026-09-02'}}})[0].json.sql;
   const originalPayload=(await full.query(execute(patchCode(source,{remove:true})))).rows[0].payload;
   const newPayload=(await full.query(execute(source))).rows[0].payload;
   assert.deepEqual(newPayload.janela,{ini:'2026-09-01',fim:'2026-09-02'});
   for(const key of Object.keys(originalPayload))if(!['gerado_em','canal','canal_total'].includes(key))assert.deepEqual(newPayload[key],originalPayload[key],`full payload ${key}`);
   for(const key of ['canal','canal_total'])for(let i=0;i<originalPayload[key].length;i++)for(const field of Object.keys(originalPayload[key][i]))assert.deepEqual(newPayload[key][i][field],originalPayload[key][i][field],`full original ${key}.${field}`);
   assert.equal(newPayload.canal_total[0].gmv_saldo_nao_afiliado,null);
   assert.equal(newPayload.canal_total[0].gmv_afiliado,210,'ineligible excluded by actual source view');
   assert.equal(newPayload.canal_total[0].gmv_ajuste_origem,-10);
   assert.equal(newPayload.canal_total[0].origem_dias_divergentes,1);
  }finally{await full.close();}
  console.log('PASS TikTok Canal PostgreSQL: original values, daily/period compatibility, signed/absolute adjustment, null vs zero, no cancellation, isolated brands/window.');
 }finally{await db.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
