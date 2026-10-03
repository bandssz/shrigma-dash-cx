'use strict';
// Prova NATIVA descartável do listener services/crm-template-read (contrato
// crm-template-read-v1) em PostgreSQL 17.10: SQL proposto SEM alteração, papel
// crm_template_reader com LOGIN só neste cluster, pool pg@8.13.1 real, HTTP em
// 127.0.0.1 e a ponte real do portal na frente. Duas sessões: escritor com
// bloqueio de linha, bloqueio de tabela (prazo), revogação e expiração vistas
// por outra sessão. Zero efeito e nenhuma conexão sobra.
// Uso: tools/claude-native-proofs/run-pg17.sh (ou TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:<porta>/listmonk
//      CRM_TEMPLATE_TEST_ISOLATED=1 CRM_PG_EXPECTED_VERSION_NUM=170010 PG_MODULE=<pg> node --test este-arquivo)
const {test}=require('node:test'),assert=require('node:assert/strict');
const PG=require(process.env.PG_MODULE||'pg');
const X=require('./claude-template-read-fixture.cjs'),{chain,get}=require('./claude-template-read-listener-harness.cjs'),{start}=require('../services/crm-template-read/main.cjs');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_TEMPLATE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||['5432','5433'].includes(u.port))throw Error('ISOLATED_DATABASE_REQUIRED');
const EXPECTED=Number(process.env.CRM_PG_EXPECTED_VERSION_NUM||170010);
const REV='c'.repeat(40),Q='?acao=listar&brand=fish&channel=email&offset=0&limit=20',A={authorization:'Bearer '+X.KEY};

test('listener nativo: duas marcas pela ponte, duas sessões, prazo, revogação/expiração, zero efeito e nenhuma conexão sobrando',async()=>{
 const owner=new PG.Pool({connectionString:uri,max:3}),out={};let svc;
 // Conta toda chamada HTTP que não seja ao listener local (provedor, Listmonk, Meta): tem de ser zero.
 const realFetch=globalThis.fetch;let external=0;globalThis.fetch=(url,init)=>{if(new URL(String(url)).hostname!=='127.0.0.1')external++;return realFetch(url,init);};
 try{
  const info=(await owner.query("SELECT current_user AS who,current_setting('server_version_num')::int AS v,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r') AS existing")).rows[0];
  assert.equal(info.who,'postgres');assert.equal(info.v,EXPECTED);assert.equal(info.existing,0,'banco vazio');out.postgres=info.v;
  const db={query:(q,p)=>owner.query(q,p),exec:q=>owner.query(q)};
  await X.schema(db);await X.data(db);await db.exec(X.accessSQL({strict:true}));
  // LOGIN só neste cluster descartável (trust em loopback). Produção provisiona à parte.
  await owner.query('ALTER ROLE crm_template_reader LOGIN');
  // A configuração fixa a porta 5432; aqui o pool real é apontado para o cluster descartável.
  class Pool extends PG.Pool{constructor(o){assert.equal(o.user,'crm_template_reader');assert.equal(o.max,4);super({...o,host:'127.0.0.1',port:Number(u.port)});}}
  svc=start({CRM_TEMPLATE_READ_ENABLED:'true',CRM_TEMPLATE_READ_REVISION:REV,CRM_PG_HOST:'127.0.0.1',CRM_PG_USER:'crm_template_reader',CRM_PG_DATABASE:'listmonk',CRM_PG_PASSWORD:'trust-only-disposable'},{Pool,port:0,host:'127.0.0.1'});
  await new Promise(r=>svc.app.server.listening?r():svc.app.server.once('listening',r));const port=svc.app.server.address().port;
  const before=await X.snapshot(db),c=chain(port,X.KEY);

  // Duas marcas, paginação, histórico e submissão pela ponte real.
  const fish=await c.read({acao:'listar',marca:'fish'}),aristo=await c.read({acao:'listar',marca:'aristo'});
  assert.deepEqual(fish.body.templates.map(t=>t.id),['1','6','8']);assert.deepEqual(aristo.body.templates.map(t=>t.id),['2','9']);
  assert.ok(fish.body.templates.every(t=>t.brand==='fish')&&aristo.body.templates.every(t=>t.brand==='aristo'));
  const p2=await c.read({acao:'listar',marca:'fish',offset:'2',limit:'2'});assert.deepEqual([p2.body.templates.map(t=>t.id),p2.body.next_offset],[['8'],null]);
  assert.equal((await c.read({acao:'historico',marca:'fish',draft_id:'d_fish_1'})).body.events.length,3);
  const sub=(await c.read({acao:'submissao',marca:'aristo',submission_id:'s_aristo_1'})).body;assert.equal(sub.provider_polled,false);
  await assert.rejects(c.read({acao:'historico',marca:'aristo',draft_id:'d_fish_1'}),{status:404});
  out.brands=['fish','aristo'];
  // Leituras paralelas das duas marcas (pool 4): cada resposta só da sua marca.
  const par=await Promise.all(['fish','aristo','fish','aristo'].map(m=>c.read({acao:'listar',marca:m}).then(r=>[m,r.body.templates.every(t=>t.brand===m)])));
  assert.ok(par.every(([,ok])=>ok));out.parallel_reads=par.length;
  assert.deepEqual(await X.snapshot(db),before,'nenhuma linha, xmin ou xmax mudou');out.zero_effect=true;

  // Sessão 2 (escritor): bloqueio de linha não segura a leitura.
  const w=await owner.connect();
  try{
   await w.query('BEGIN');await w.query('SELECT 1 FROM public.templates FOR UPDATE');await w.query('SELECT 1 FROM public.shrigma_template_draft FOR UPDATE');await w.query('SELECT 1 FROM public.crm_dash_chave FOR UPDATE');
   let t0=Date.now();assert.equal((await get(port,Q,A)).status,200);out.read_under_row_locks_ms=Date.now()-t0;assert.ok(out.read_under_row_locks_ms<1000);
   await w.query('ROLLBACK');
   // Bloqueio exclusivo da tabela: lock_timeout 500 ms → 503, sem pendurar; liberado, volta a 200.
   await w.query('BEGIN');await w.query('LOCK TABLE public.templates IN ACCESS EXCLUSIVE MODE');
   t0=Date.now();const blocked=await get(port,Q,A);out.blocked_ms=Date.now()-t0;
   assert.equal(blocked.status,503);assert.deepEqual(JSON.parse(blocked.text),{error:'TEMPLATE_READ_UNAVAILABLE'});assert.ok(out.blocked_ms>=400&&out.blocked_ms<5000,String(out.blocked_ms));
   await w.query('ROLLBACK');assert.equal((await get(port,Q,A)).status,200);out.table_lock='503_then_200';
   // Revogação confirmada por outra sessão: a próxima leitura já nega (listener 401, ponte 403 sem ler corpo).
   await w.query('UPDATE public.crm_dash_chave SET revogada_em=now() WHERE chave=$1',[X.PRINCIPAL]);
   assert.equal((await get(port,Q,A)).status,401);await assert.rejects(c.read({acao:'listar',marca:'fish'}),{status:403,code:'TEMPLATE_READ_UPSTREAM_DENIED'});
   await w.query('UPDATE public.crm_dash_chave SET revogada_em=NULL,expira_em=now()-interval \'1 second\' WHERE chave=$1',[X.PRINCIPAL]);
   assert.equal((await get(port,Q,A)).status,401);
   await w.query('UPDATE public.crm_dash_chave SET expira_em=NULL WHERE chave=$1',[X.PRINCIPAL]);assert.equal((await get(port,Q,A)).status,200);
   out.revocation_expiry_two_sessions=true;
  }finally{w.release();}

  // O papel não lê tabela nem escreve, mesmo fora do listener.
  const ru=new URL(uri);ru.username='crm_template_reader';const direct=new PG.Client({connectionString:ru.href});await direct.connect();
  try{await assert.rejects(direct.query('SELECT * FROM public.templates'),e=>e.code==='42501');await assert.rejects(direct.query("SELECT crm_template_read.listar($1,'fish',0,51)",[X.KEY]),/CRM_TEMPLATE_READ_PAGE/);}finally{await direct.end();}

  // Parada limpa: nenhuma conexão do papel, nenhuma transação aberta.
  await svc.stop();svc=null;
  const left=(await owner.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='crm_template_reader'")).rows[0].n;assert.equal(left,0);out.connections_after_stop=left;
  assert.equal(external,0);out.non_loopback_http_calls=external;console.log(JSON.stringify(out));
 }finally{globalThis.fetch=realFetch;if(svc)await svc.stop();await owner.end();}
});
