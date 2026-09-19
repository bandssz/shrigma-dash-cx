/* Isolated real PostgreSQL; no network, production tables or transport.
   CAMPAIGN_PGLITE_MODULE / ORGANICO_PGLITE_MODULE points to installed PGlite. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {classify}=require('../n8n/growth/attribution');
const {patchQuery,SCOPE_TOKEN}=require('../n8n/organico/api-patch.cjs');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const {PGlite}=require(process.env.ORGANICO_PGLITE_MODULE||process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
(async()=>{
 const db=new PGlite();
 try{
  // Actual ledger table/model/quality definitions, not a reimplemented financial view.
  const schema=read('n8n/growth/attribution-schema.sql');
  await db.exec(schema.slice(0,schema.indexOf('REVOKE ALL')));
  for(const name of ['crm_attribution_order_model_v2','crm_attribution_quality_v2']){
   const start=schema.indexOf(`CREATE VIEW public.${name} AS`);assert.ok(start>=0);
   await db.exec(schema.slice(start,schema.indexOf(';',start)+1));
  }
  const projection=read('n8n/organico/attribution.sql');
  await db.exec(projection);await db.exec(projection); // repeatable additive installation
  await db.query(`INSERT INTO crm_attribution_coverage_v2 VALUES
   ('aristo','2026-09-19','2026-09-19T18:00:00Z','fixture'),('fish','2026-09-19','2026-09-19T17:00:00Z','fixture')`);
  const visit=(source,medium,campaign='20260919_Campanha',at='2026-09-19T12:00:00Z')=>({occurredAt:at,source:'direct',referrerUrl:null,utmParameters:{source,medium,campaign,content:'',term:''}});
  async function insert(id,source,medium,opt={}){
   const last=opt.last===undefined?visit(source,medium):opt.last,previous=opt.previous||[];
   const o={_marca:opt.brand||'aristo',id:`gid://shopify/Order/${id}`,name:'#synthetic',createdAt:opt.createdAt||'2026-09-19T15:00:00Z',updatedAt:'2026-09-19T16:00:00Z',test:opt.test||false,
    cancelledAt:opt.cancelled?'2026-09-19T16:00:00Z':null,displayFinancialStatus:opt.financial||'PAID',
    netPaymentSet:{shopMoney:{amount:String(opt.amount??100),currencyCode:opt.currency||'BRL'}},
    customerJourneySummary:{ready:opt.ready!==false,lastVisit:last,firstVisit:previous[0]||last,moments:{nodes:[...previous,...(last?[last]:[])],pageInfo:{hasNextPage:!!opt.incomplete}},customerOrderIndex:1}};
   const p=classify(o);
   if(opt.keepLedgerCase)for(const model of ['last_click','last_non_direct']){p[model].source='Instagram_Social';p[model].campaign='Campanha_Como_Armazenada';}
   await db.query(`INSERT INTO crm_attribution_order_v2 VALUES($1,$2,$3::jsonb,$4,'2026-09-19T18:00:00Z')`,[p.brand,p.order_id,JSON.stringify(p),p.updated_at]);
  }
  for(const [id,source,medium,amount] of [[1,'instagram_social','story',120],[2,'instagram_social','linktree',80],[3,'instagram_social','dm',60],[4,'instagram','dm-automation',40],[5,'instagram','social',20],[6,'linktree','social',30],[7,'instagram_social','paid',70],[8,'instagram_social','cpc',50],[9,'facebook_ads','story',90],[10,'email','campaign',110],[11,'tiktok_social','story',130]])await insert(id,source,medium,{amount});
  await insert(12,'','',{amount:140,last:visit('','','')});
  await insert(13,'','',{amount:150,last:visit('','',''),previous:[visit('instagram_social','story','prior','2026-09-19T10:00:00Z')]});
  await insert(14,'instagram_social','story',{amount:999,cancelled:true});
  await insert(15,'instagram_social','story',{amount:999,financial:'REFUNDED'});
  await insert(16,'instagram_social','story',{amount:65,financial:'PARTIALLY_REFUNDED'});
  await insert(17,'instagram_social','story',{amount:999,currency:'USD'});
  await insert(18,'instagram_social','story',{amount:999,test:true});
  await insert(19,'instagram_social','story',{amount:160,ready:false});
  await insert(20,'instagram_social','story',{amount:170,last:null,incomplete:true});
  await insert(21,'instagram_social','story',{amount:180,last:visit('instagram_social','story','outside','2026-08-19T10:00:00Z')});
  await insert(22,'instagram_social','story',{amount:190,createdAt:'2026-09-18T15:00:00Z',last:visit('instagram_social','story','uncovered','2026-09-18T12:00:00Z')});
  await insert(1,'instagram_social','story',{amount:200,brand:'fish',keepLedgerCase:true});
  const rows=(await db.query('SELECT * FROM crm_organico_attribution_order_v2')).rows;
  const find=(id,model='last_click',marca='aristo')=>rows.find(r=>r.order_id===`gid://shopify/Order/${id}`&&r.model===model&&r.marca===marca);
  for(const [id,expected] of [[1,'editorial'],[2,'bio'],[3,'automacao_dm'],[4,'automacao_dm'],[5,'legado_ambiguo'],[6,'legado_ambiguo'],[7,'midia_paga'],[8,'midia_paga'],[9,'midia_paga'],[10,'crm'],[11,'nao_classificado']])assert.equal(find(id).classification,expected,`classification ${id}`);
  assert.equal(find(2).rede,'instagram');assert.equal(find(2).superficie,'bio');assert.equal(find(2).piece_status,'nao_identificada');
  assert.equal(find(12,'last_non_direct').rule_reason,'modelo_conhecido_sem_toque');
  assert.equal(find(13).classification,'nao_classificado');assert.equal(find(13,'last_non_direct').classification,'editorial');
  assert.equal(Number(find(16).receita_liquida),65,'partially refunded retains net amount');
  for(const id of [14,15,17,18,19,20,22])assert.equal(rows.some(r=>r.order_id===`gid://shopify/Order/${id}`),false,`ineligible/unknown/uncovered ${id}`);
  assert.equal(find(21),undefined,'outside-window strict touch has no credit');
  assert.equal(find(21,'last_non_direct').classification,'nao_classificado','complete no-touch remains reconciliation only');
  assert.equal(find(1,'last_click','fish').utm_source,'Instagram_Social');assert.equal(find(1,'last_click','fish').utm_campaign,'Campanha_Como_Armazenada');
  assert.equal(new Set(rows.map(r=>`${r.marca}|${r.order_id}|${r.model}`)).size,rows.length,'unique order/brand/model');
  assert.equal(rows.some(r=>r.utm_raw_available||r.source_system!=='shopify'),false);
  const base=(await db.query('SELECT brand,model,count(*)::int pedidos,sum(amount) receita FROM crm_attribution_order_model_v2 GROUP BY 1,2 ORDER BY 1,2')).rows;
  const daily=(await db.query('SELECT marca AS brand,model,sum(pedidos)::int pedidos,sum(receita_liquida) receita FROM crm_organico_attribution_daily_v2 GROUP BY 1,2 ORDER BY 1,2')).rows;
  assert.deepEqual(daily,base,'known models reconcile including cross-channel and known no-touch');
  assert.ok(!projection.includes('JOIN public.crm_organico_utm'),'no piece lookup fanout');
  const payload=(await db.query("SELECT crm_organico_attribution_payload_v2('2026-09-19','2026-09-19') payload")).rows[0].payload;
  assert.equal(payload.default_model,'last_click');assert.equal(payload.window_days,30);assert.equal(payload.assistance_available,false);assert.equal(payload.utm_raw_available,false);
  assert.equal(payload.coverage.length,2);assert.equal(payload.quality.length,2,'quality not multiplied by model/UTM');
  const aristo=payload.quality.find(q=>q.marca==='aristo');assert.equal(aristo.pedidos_lidos,21);assert.equal(aristo.pagos_elegiveis,17);assert.equal(aristo.ultima_sessao_desconhecida,3);assert.equal(aristo.origem_nao_direta_desconhecida,2);
  assert.equal(payload.daily.some(r=>r.order_id),false,'API does not expose order identifiers');
  const detailClasses=['editorial','bio','automacao_dm','legado_ambiguo'];
  for(const row of payload.daily){
   if(detailClasses.includes(row.classification))assert.equal(row.detail_level,'utm');
   else{
    assert.equal(row.detail_level,'channel_summary');assert.equal(row.rule_reason,'resumo_diario_canal');
    for(const field of ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','rede','superficie'])assert.equal(row[field],null,`summary ${field}`);
    assert.equal(row.utm_provenance,'channel_summary');assert.equal(row.piece_status,'nao_aplicavel_resumo');
   }
  }
  const summaries=payload.daily.filter(r=>r.detail_level==='channel_summary');
  assert.equal(new Set(summaries.map(r=>[r.marca,r.dia,r.model,r.classification].join('|'))).size,summaries.length);
  assert.equal(summaries.find(r=>r.marca==='aristo'&&r.model==='last_click'&&r.classification==='midia_paga').pedidos,3,'multiple paid UTMs retain total in one channel row');
  const mismatch=(await db.query(`WITH p AS (
   SELECT marca,dia,model,classification,sum(pedidos) pedidos,sum(receita_liquida) receita
   FROM jsonb_to_recordset(crm_organico_attribution_payload_v2('2026-09-19','2026-09-19')->'daily')
    AS x(marca text,dia date,model text,classification text,pedidos integer,receita_liquida numeric)
   GROUP BY 1,2,3,4), v AS (
   SELECT marca,dia,model,classification,sum(pedidos) pedidos,sum(receita_liquida) receita
   FROM crm_organico_attribution_daily_v2 WHERE dia='2026-09-19' GROUP BY 1,2,3,4)
   SELECT * FROM p FULL JOIN v USING(marca,dia,model,classification)
   WHERE p.pedidos IS DISTINCT FROM v.pedidos OR p.receita IS DISTINCT FROM v.receita`)).rows;
  assert.deepEqual(mismatch,[],'payload preserves every daily brand/model/classification total');
  const detailMismatch=(await db.query(`WITH p AS (
    SELECT x-'detail_level' row FROM jsonb_array_elements(crm_organico_attribution_payload_v2('2026-09-19','2026-09-19')->'daily') x
    WHERE x->>'detail_level'='utm'), v AS (
    SELECT to_jsonb(d) row FROM crm_organico_attribution_daily_v2 d WHERE dia='2026-09-19'
      AND classification IN ('editorial','bio','automacao_dm','legado_ambiguo'))
    (SELECT * FROM p EXCEPT SELECT * FROM v) UNION ALL (SELECT * FROM v EXCEPT SELECT * FROM p)`)).rows;
  assert.deepEqual(detailMismatch,[],'organic UTM rows retain exact original details without conflation');
  const functionStart=projection.indexOf('CREATE OR REPLACE FUNCTION public.crm_organico_attribution_payload_v2(');
  const functionEnd=projection.indexOf('END;$function$;',functionStart)+'END;$function$;'.length;
  assert.equal(read('n8n/organico/payload-function.sql'),projection.slice(functionStart,functionEnd)+'\n','incremental patch equals full SQL function');
  await db.exec(read('n8n/organico/payload-function.sql')); // no view recreation required
  const empty=(await db.query("SELECT crm_organico_attribution_payload_v2('2026-08-01','2026-08-01') payload")).rows[0].payload;
  assert.deepEqual(empty.daily,[]);assert.deepEqual(empty.quality,[]);assert.deepEqual(empty.coverage,[]);
  await assert.rejects(db.query("SELECT crm_organico_attribution_payload_v2('2026-09-20','2026-09-19')"),/ORGANICO_WINDOW_INVALID/);
  // Regression for the 19/09 shared API incident: its central builder was
  // already at PostgreSQL's 100-argument limit. No production export is used.
  const pairs=Array.from({length:50},(_,i)=>`'existing_${i}',${i}`).join(',');
  const baselineQuery=`SELECT json_build_object(${pairs})::jsonb AS payload;`;
  const baseline=(await db.query(baselineQuery)).rows[0].payload;
  assert.equal(Object.keys(baseline).length,50);
  await assert.rejects(db.query(`SELECT json_build_object(${pairs},'organico_attribution',null) AS payload;`),/cannot pass more than 100 arguments/i,'adding pair 51 inside the same call fails in PostgreSQL');
  const patched=patchQuery(baselineQuery);
  assert.equal(patchQuery(patched,{remove:true}),baselineQuery,'reversal retains the original query exactly');
  await db.exec(`BEGIN;
   CREATE TEMP TABLE organic_api_probe_calls(ini date,fim date);
   CREATE OR REPLACE FUNCTION public.crm_organico_attribution_payload_v2(p_ini date,p_fim date)
   RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $probe$
   BEGIN
    INSERT INTO organic_api_probe_calls VALUES(p_ini,p_fim);
    RETURN jsonb_build_object('synthetic',true,'ini',p_ini,'fim',p_fim);
   END;$probe$;`);
  for(const scope of ['cx','growth','influs','']){
   const result=(await db.query(patched.replaceAll(SCOPE_TOKEN,scope))).rows[0].payload;
   assert.equal(result.organico_attribution,null);const {organico_attribution,...existing}=result;
   assert.deepEqual(existing,baseline,`false scope preserves all original fields: ${scope}`);
  }
  assert.equal((await db.query('SELECT count(*)::int n FROM organic_api_probe_calls')).rows[0].n,0,'false scope must not invoke the payload function');
  for(const scope of ['organico','todos']){
   const result=(await db.query(patched.replaceAll(SCOPE_TOKEN,scope))).rows[0].payload;
   assert.equal(Object.keys(result).length,51,'separate concatenation safely returns field 51');
   const {organico_attribution,...existing}=result;assert.deepEqual(existing,baseline);assert.equal(organico_attribution.synthetic,true);
  }
  const calls=(await db.query("SELECT count(*)::int n,bool_and(fim-ini=399) window_ok,bool_and(fim=(now() AT TIME ZONE 'America/Sao_Paulo')::date) brt_ok FROM organic_api_probe_calls")).rows[0];
  assert.equal(calls.n,2);assert.equal(calls.window_ok,true);assert.equal(calls.brt_ok,true);
  await db.exec('ROLLBACK');
  console.log('Organic attribution PostgreSQL scenarios passed: actual v2 views, financial boundaries, UTM rules, separate models, reconciliation, coverage, 100-argument API limit, false-scope short circuit, no fanout or transport.');
 }finally{await db.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
