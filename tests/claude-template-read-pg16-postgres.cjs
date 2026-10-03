'use strict';
// Prova com PostgreSQL real (agente N): arquivo SQL SEM alteração, papel com
// LOGIN só neste banco descartável, duas sessões. Somente loopback, porta
// diferente de 5432, database listmonk vazio.
// Uso: TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55435/listmonk
//      CRM_TEMPLATE_TEST_ISOLATED=1 PG_MODULE=<caminho do pacote pg> node este-arquivo
//      [CRM_PG_EXPECTED_VERSION_NUM=170010] (PG 17.10: tools/claude-native-proofs/run-pg17.sh)
const assert=require('node:assert/strict');
const {Pool}=require(process.env.PG_MODULE||'pg');
const X=require('./claude-template-read-fixture.cjs'),B=require('../services/dashboard-operational/crm-template-read-bridge.cjs');
// Versão alvo explícita: sem variável mantém a prova original (16.x); com
// CRM_PG_EXPECTED_VERSION_NUM=160015|170010 exige exatamente a versão informada.
const assertPgVersion=v=>{const e=process.env.CRM_PG_EXPECTED_VERSION_NUM;if(!e){assert.ok(v>=160000&&v<170000,'PostgreSQL 16 (defina CRM_PG_EXPECTED_VERSION_NUM para outra versão)');return;}assert.ok(['160015','170010'].includes(e),'CRM_PG_EXPECTED_VERSION_NUM não suportado: '+e);assert.equal(v,Number(e));};
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_TEMPLATE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const owner=new Pool({connectionString:uri,max:3});
const db={query:(q,p)=>owner.query(q,p),exec:q=>owner.query(q)};
let reader;
const accepts=(query,body)=>{B.responseShape(B.decision('templates','GET',new URLSearchParams(query)),JSON.parse(JSON.stringify(body)));return true;};
(async()=>{const out={};try{
 const info=(await db.query("SELECT current_database() AS db,current_user AS who,current_setting('server_version_num')::int AS v,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r') AS existing")).rows[0];
 assert.equal(info.db,'listmonk');assert.equal(info.who,'postgres');assertPgVersion(info.v);assert.equal(info.existing,0);out.server_version_num=info.v;
 await X.schema(db);await X.data(db);
 await db.exec(X.accessSQL({strict:true}));
 await assert.rejects(db.exec(X.accessSQL({strict:true})),/CRM_TEMPLATE_READ_INSTALL_COLLISION/);out.install='strict_file_ok_reinstall_refused';
 assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee='crm_template_reader'")).rows[0].n,0);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_auth_members WHERE member='crm_template_reader'::regrole")).rows[0].n,0);
 for(const fn of ['public.shrigma_panel_auth_v1(text,text,text)','public.shrigma_panel_operator_v1(text,text)','public.shrigma_crm_operator_auth_v1(text)','crm_template_read.principal(text,text)'])
  assert.equal((await db.query("SELECT has_function_privilege('crm_template_reader',$1,'EXECUTE') AS x",[fn])).rows[0].x,false,fn);
 // Pré-existente (n8n/access/panel-short-keys.sql não revoga de PUBLIC): qualquer papel com CONNECT
 // executa shrigma_template_auth_v2. É STABLE e não grava; registrado como observação, não alterado aqui.
 const legacy=(await db.query("SELECT has_function_privilege('crm_template_reader','public.shrigma_template_auth_v2(text)','EXECUTE') AS x,(SELECT provolatile FROM pg_proc WHERE oid='public.shrigma_template_auth_v2(text)'::regprocedure) AS v")).rows[0];
 assert.equal(legacy.v,'s');out.preexisting_public_execute_template_auth_v2=legacy.x;
 // LOGIN apenas neste cluster descartável (trust em loopback); produção provisiona à parte.
 await db.exec('ALTER ROLE crm_template_reader LOGIN');
 const ru=new URL(uri);ru.username='crm_template_reader';reader=new Pool({connectionString:ru.href,max:2});
 const before=await X.snapshot(db);
 const call=async(c,fn,args)=>(await c.query(`SELECT crm_template_read.${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS r`,args)).rows[0].r;
 const rc=await reader.connect();
 try{
  assert.equal((await rc.query("SELECT current_setting('transaction_read_only') AS r")).rows[0].r,'on','READ ONLY por padrão do papel');
  await rc.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
  const fish=await call(rc,'listar',[X.KEY,'fish',0,20]),aristo=await call(rc,'listar',[X.KEY,'aristo',0,20]);
  assert.deepEqual(fish.templates.map(t=>t.id),['1','6','8']);assert.deepEqual(aristo.templates.map(t=>t.id),['2','9']);
  assert.ok(accepts({acao:'listar',marca:'fish'},fish)&&accepts({acao:'listar',marca:'aristo'},aristo));
  assert.ok(accepts({acao:'historico',marca:'fish',draft_id:'d_fish_1'},await call(rc,'historico',[X.KEY,'fish','d_fish_1'])));
  assert.ok(accepts({acao:'submissao',marca:'aristo',submission_id:'s_aristo_1'},await call(rc,'submissao',[X.KEY,'aristo','s_aristo_1'])));
  assert.equal((await rc.query('SELECT txid_current_if_assigned() AS x')).rows[0].x,null);
  await rc.query('ROLLBACK');
  for(const [fn,args] of [['historico',[X.KEY,'aristo','d_fish_1']],['submissao',[X.KEY,'fish','s_aristo_1']]])await assert.rejects(call(rc,fn,args),/CRM_TEMPLATE_READ_NOT_FOUND/);
  out.brand_isolation='ok';
  // Escrita direta recusada mesmo pedindo READ WRITE.
  await rc.query('BEGIN READ WRITE');await assert.rejects(rc.query("INSERT INTO public.templates(id,name,type) VALUES(99,'x','tx')"),e=>e.code==='42501');await rc.query('ROLLBACK');
  await assert.rejects(rc.query('SELECT * FROM public.templates'),e=>e.code==='42501');
  await assert.rejects(rc.query(`SELECT * FROM public.shrigma_panel_auth_v1('${X.KEY}','growth','header')`),e=>e.code==='42501');
  out.role_privileges='only_three_functions';
  // Zero efeito das leituras (antes da parte com escritor concorrente, cujo FOR UPDATE do owner muda xmax).
  assert.deepEqual(await X.snapshot(db),before);out.zero_effect='ok';
  // Escritor com FOR UPDATE noutra sessão: a leitura não espera lock de linha.
  const oc=await owner.connect();
  try{
   await oc.query('BEGIN');await oc.query('SELECT 1 FROM public.templates FOR UPDATE');await oc.query('SELECT 1 FROM public.shrigma_template_draft FOR UPDATE');await oc.query('SELECT 1 FROM public.crm_dash_chave FOR UPDATE');
   const t0=Date.now();await call(rc,'listar',[X.KEY,'fish',0,20]);await call(rc,'historico',[X.KEY,'fish','d_fish_1']);out.read_under_writer_lock_ms=Date.now()-t0;assert.ok(out.read_under_writer_lock_ms<400);
   await oc.query('ROLLBACK');
   // Revogação confirmada por outra sessão é vista na próxima leitura (READ COMMITTED).
   await rc.query('BEGIN READ ONLY');await call(rc,'listar',[X.KEY,'fish',0,20]);
   await oc.query("UPDATE public.crm_dash_chave SET revogada_em=now() WHERE chave=$1",[X.PRINCIPAL]);
   await assert.rejects(call(rc,'listar',[X.KEY,'fish',0,20]),/CRM_TEMPLATE_READ_UNAUTHORIZED/);await rc.query('ROLLBACK');
   await oc.query("UPDATE public.crm_dash_chave SET revogada_em=NULL WHERE chave=$1",[X.PRINCIPAL]);out.revocation_two_sessions='ok';
  }finally{oc.release();}
 }finally{rc.release();}
 out.passed=true;console.log(JSON.stringify(out));
}catch(e){console.error(e);process.exitCode=1;}finally{await reader?.end();await owner.end();}})();
