'use strict';
// Prova com PostgreSQL real e duas sessões (agente K). Somente banco
// descartável em loopback, porta diferente de 5432, database listmonk vazio.
// Uso: TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55433/listmonk
//      CRM_AUDIENCE_TEST_ISOLATED=1 PG_MODULE=<caminho do pacote pg> node este-arquivo
//      [CRM_PG_EXPECTED_VERSION_NUM=170010] (PG 17.10: tools/claude-native-proofs/run-pg17.sh)
const assert=require('node:assert/strict'),fs=require('node:fs');
const {Pool}=require(process.env.PG_MODULE||'pg');
const F=require('./segment-campaign-binding-fixture.cjs'),X=require('./claude-audience-read-fixture.cjs');
const R=require('../services/crm-audience/read-store.cjs'),S=require('../n8n/growth/segment-audience-store.cjs'),GCAC=require('../growth-campaign-audience-client.js');
const {createReadServer}=require('../services/crm-audience/read-server.cjs'),Bridge=require('../services/dashboard-operational/crm-audience-read-bridge.cjs');
// Versão alvo explícita: sem variável mantém a prova original (16.x); com
// CRM_PG_EXPECTED_VERSION_NUM=160015|170010 exige exatamente a versão informada.
const assertPgVersion=v=>{const e=process.env.CRM_PG_EXPECTED_VERSION_NUM;if(!e){assert.ok(v>=160000&&v<170000,'PostgreSQL 16 (defina CRM_PG_EXPECTED_VERSION_NUM para outra versão)');return;}assert.ok(['160015','170010'].includes(e),'CRM_PG_EXPECTED_VERSION_NUM não suportado: '+e);assert.equal(v,Number(e));};
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const owner=new Pool({connectionString:uri,max:4,statement_timeout:10000});
const db={query:(q,p)=>owner.query(q,p),exec:q=>owner.query(q),transaction:async work=>{const c=await owner.connect();try{await c.query('BEGIN');const r=await work(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
let reader,app;
(async()=>{try{
 const info=(await db.query("SELECT current_database() AS db,current_user AS who,current_setting('server_version_num')::int AS v,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r') AS existing")).rows[0];
 assert.equal(info.db,'listmonk');assert.equal(info.who,'postgres');assertPgVersion(info.v);assert.equal(info.existing,0);
 const f=await F.setup(db);
 // Arquivo proposto SEM alteração (owner postgres, database listmonk).
 await db.exec(fs.readFileSync(require.resolve('../n8n/growth/crm-audience-read-access.sql'),'utf8'));
 await assert.rejects(db.exec(fs.readFileSync(require.resolve('../n8n/growth/crm-audience-read-access.sql'),'utf8')),/CRM_AUDIENCE_READ_INSTALL_COLLISION/);
 const role=(await db.query("SELECT rolcanlogin,rolsuper,rolinherit,rolconfig FROM pg_roles WHERE rolname='crm_audience_reader'")).rows[0];
 assert.equal(role.rolcanlogin,false);assert.ok(role.rolconfig.includes('default_transaction_read_only=on'));
 assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee='crm_audience_reader' AND privilege_type<>'SELECT'")).rows[0].n,0);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_auth_members WHERE member='crm_audience_reader'::regrole")).rows[0].n,0);
 for(const fn of ['crm_audience_v2.refresh_native_catalog(text)','crm_audience_v2.touch_campaign(integer)','crm_audience_v2.campaign_snapshot(integer,boolean)','crm_audience_v2.lock_campaign_dependencies(integer)','crm_audience_v2.config_snapshot(text)','crm_audience_v2.catalog_lists(text)','public.shrigma_campaign_provider(text,jsonb)']){
  const exists=(await db.query('SELECT to_regprocedure($1) IS NOT NULL AS e',[fn])).rows[0].e;if(exists)assert.equal((await db.query("SELECT has_function_privilege('crm_audience_reader',$1,'EXECUTE') AS x",[fn])).rows[0].x,false,fn);
 }
 await db.query("INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash) VALUES($1,'growth','gestor@oaristocrata.com',$2)",[X.PRINCIPAL,X.sha(X.KEY)]);
 await db.query("INSERT INTO shrigma_panel_permission_v1 VALUES($1,'growth','[\"read_content\",\"list_history\",\"submission\"]'::jsonb)",[X.PRINCIPAL]);
 const fishAudience=await f.createAudience('fish','pg16-fish');const intent=(await f.inspect('fish',100,fishAudience)).body.intent;assert.equal((await f.bind(intent,'pg16-bind-fish')).status,201);
 await db.exec('ALTER ROLE crm_audience_reader LOGIN'); // Somente nesta fixture local (trust).
 const ru=new URL(uri);ru.username='crm_audience_reader';reader=new Pool({connectionString:ru.href,max:4});
 // Mesmo fora do módulo, o papel não escreve: default read only e sem GRANT.
 await assert.rejects(reader.query("UPDATE crm_audience_v2.config SET revision=revision"),e=>['25006','42501'].includes(e.code));
 {const c=await reader.connect();try{await c.query('BEGIN READ WRITE');await assert.rejects(c.query('UPDATE crm_audience_v2.config SET revision=revision'),e=>e.code==='42501');}finally{await c.query('ROLLBACK').catch(()=>{});c.release();}}
 const hooks={before:null};
 const wrapped={connect:async()=>{const c=await reader.connect();return {query:async q=>{const text=typeof q==='string'?q:q.text;if(hooks.before)await hooks.before(text);return c.query(q);},release:d=>c.release(d)};},end:()=>reader.end()};
 const transaction=R.createReadTransaction({pool:wrapped}),store=R.createAudienceReadStore({transaction});
 app=createReadServer({handler:store,revision:'1'.repeat(40),enabled:true});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+app.server.address().port,get=async q=>{const r=await fetch(base+'/audience-read?'+new URLSearchParams(q),{headers:{Authorization:'Bearer '+X.KEY}});return {status:r.status,body:await r.json()};};
 const results={};
 // 1) Leituras nas duas marcas; zero efeito (linhas, xmin, xmax).
 let before=await X.snapshot(db);
 for(const [brand,ids]of [['fish',[100,300]],['aristo',[200]]]){
  assert.equal((await get({acao:'publicos_listas',brand})).status,200);
  const list=await get({acao:'segmentos_listar',brand,limit:'10',offset:'0'});assert.equal(list.status,200);assert.equal(list.body.segments.length,brand==='fish'?1:0);
  for(const id of ids){const ctx=await get({acao:'campanha_publico_contexto',brand,campaign_id:String(id)});assert.equal(ctx.status,200);assert.equal(ctx.body.list_only,id!==100);
   Bridge.responseShape(Bridge.decision('campaign_audience','GET',new URLSearchParams({acao:'campanha_publico_contexto',brand,campaign_id:String(id)})),ctx.body);
   const b=await get({acao:'campanha_publico_obter',brand,campaign_id:String(id)});assert.equal(GCAC.validation.readBody(b.body,brand,id),true);}
 }
 assert.deepEqual(await X.snapshot(db),before);results.zero_effect=true;
 // 2) Escritor concorrente segurando config/lista/campanha em FOR UPDATE: a
 // leitura não espera (o legado com FOR SHARE esbarraria no lock_timeout).
 const writer=await owner.connect();
 try{
  await writer.query('BEGIN');await writer.query("SELECT * FROM crm_audience_v2.config FOR UPDATE");await writer.query('SELECT * FROM lists FOR UPDATE');await writer.query('SELECT * FROM campaigns WHERE id=100 FOR UPDATE');
  let t0=Date.now();const r=await get({acao:'campanha_publico_contexto',brand:'fish',campaign_id:'100'});results.read_ms_under_writer=Date.now()-t0;assert.equal(r.status,200);assert.ok(results.read_ms_under_writer<2000);
  const legacy=await owner.connect();try{await legacy.query('BEGIN');await legacy.query("SET LOCAL lock_timeout='500ms'");t0=Date.now();await assert.rejects(S.readCatalog((q,v)=>legacy.query(q,v),'fish'),e=>e.code==='55P03');results.legacy_lock_wait_ms=Date.now()-t0;}finally{await legacy.query('ROLLBACK').catch(()=>{});legacy.release();}
 }finally{await writer.query('ROLLBACK');writer.release();}
 // 3) Duas sessões: revogação confirmada por outra sessão no meio da leitura
 // é vista pela reautenticação final (READ COMMITTED) e nada sai.
 let seen=0;hooks.before=async text=>{if(text===S.SQL.auth&&++seen===2)await owner.query('UPDATE crm_dash_chave SET revogada_em=now() WHERE chave=$1',[X.PRINCIPAL]);};
 assert.deepEqual(await get({acao:'segmentos_listar',brand:'fish',limit:'10',offset:'0'}),{status:401,body:{error:'SEGMENT_UNAUTHORIZED'}});hooks.before=null;
 assert.deepEqual(await get({acao:'publicos_listas',brand:'fish'}),{status:401,body:{error:'SEGMENT_UNAUTHORIZED'}});
 await owner.query("UPDATE crm_dash_chave SET revogada_em=NULL,expira_em=clock_timestamp()+interval '2 seconds' WHERE chave=$1",[X.PRINCIPAL]);
 assert.equal((await get({acao:'publicos_listas',brand:'fish'})).status,200);await new Promise(r=>setTimeout(r,2100));
 assert.deepEqual(await get({acao:'publicos_listas',brand:'fish'}),{status:401,body:{error:'SEGMENT_UNAUTHORIZED'}});results.revocation_two_sessions=true;results.expiry=true;
 await owner.query("UPDATE crm_dash_chave SET expira_em=NULL WHERE chave=$1",[X.PRINCIPAL]);
 // 4) Catálogo vencido: informado, sem renovação e sem prova.
 await owner.query("UPDATE crm_audience_v2.config SET checked_at=clock_timestamp()-interval '30 minutes',expires_at=clock_timestamp()-interval '26 minutes'");before=await X.snapshot(db);
 const old=await get({acao:'campanha_publico_contexto',brand:'fish',campaign_id:'100'});assert.equal(old.body.freshness.stale,true);assert.equal(old.body.schedule_proof,false);assert.equal(old.body.binding.semantic_context.current,false);assert.ok(old.body.freshness.catalog_age_seconds>=1799);
 assert.deepEqual(await X.snapshot(db),before);results.stale_not_proof=true;
 console.log(JSON.stringify({postgres:info.v,role:'crm_audience_reader',brands:['fish','aristo'],...results,sends:0}));
}finally{if(app)await app.stop();if(reader)await reader.end();await owner.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
