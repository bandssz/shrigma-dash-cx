'use strict';
// Admissão do catálogo pelo listener (preparo para ON, revisão 5974202110):
// a cada pedido, as três leituras, o principal e shrigma_panel_operator_v1 têm
// de ser exatamente os revisados (corpo md5, dono, SECURITY DEFINER, STABLE,
// search_path, quem executa). Divergência: 503 TEMPLATE_READ_NOT_READY e a
// leitura não é chamada. PGlite + SQL proposto; nada real.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const X=require('./claude-template-read-fixture.cjs'),S=require('../services/crm-template-read/store.cjs');
const md5=x=>createHash('md5').update(x).digest('hex'),read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const L=[['acao','listar'],['brand','fish'],['channel','email'],['offset','0'],['limit','20']];

test('pins do listener = md5 dos corpos nos próprios arquivos SQL versionados',()=>{
 const sql=read(X.SQL_FILE),bodies={};
 for(const m of sql.matchAll(/CREATE FUNCTION crm_template_read\.(\w+)\([^]*?AS \$fn\$([^]*?)\$fn\$/g))bodies[m[1]]=md5(m[2]);
 const op=read('n8n/access/panel-short-keys.sql').match(/shrigma_panel_operator_v1\(k text,\s*a text\)[^]*?AS \$(\w*)\$([^]*?)\$\1\$/);
 bodies.shrigma_panel_operator_v1=md5(op[2]);
 assert.deepEqual(Object.fromEntries(S.ATTEST_ROWS.map(r=>[r.name,r.src])),bodies);
 assert.deepEqual(S.ATTEST_ROWS.map(r=>[r.name,r.executable]),[['historico',true],['listar',true],['principal',false],['submissao',true],['shrigma_panel_operator_v1',false]]);
});

function pool(db){let chain=Promise.resolve(),calls=[];return {calls,async connect(){let release;const turn=new Promise(r=>release=r),prev=chain;chain=chain.then(()=>turn);await prev;
 return {async query(q,v){const text=typeof q==='string'?q:q.text;calls.push(text);const r=await db.query(text,(typeof q==='string'?v:q.values)||[]);if(/^BEGIN /.test(text))await db.query('SET LOCAL ROLE crm_template_reader');return r;},release(){release();}};}};}
async function handle(db){const p=pool(db),h=S.createTemplateReadStore({transaction:S.createReadTransaction({pool:p})});const r=await h.handle({authorization:'Bearer '+X.KEY,pairs:L});await r.settled;return {r,calls:p.calls};}

test('catálogo revisado passa; corpo trocado, dono/SECURITY/search_path alterados ou EXECUTE a mais: 503 NOT_READY sem chamar a leitura',async t=>{
 const db=new PGlite();t.after(()=>db.close());await X.install(db);
 const ok=await handle(db);assert.equal(ok.r.status,200);assert.ok(ok.calls.includes(S.SQL.listar));
 const listar=read(X.SQL_FILE).match(/EXECUTE \$ddl\$(CREATE FUNCTION crm_template_read\.listar[^]*?)\$ddl\$;/)[1];
 const changes=[
  ['corpo trocado',listar.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION').replace("'coverage','registered_email_only'","'coverage','registered_email_only' ")],
  ['SECURITY INVOKER','ALTER FUNCTION crm_template_read.historico(text,text,text) SECURITY INVOKER'],
  ['search_path','ALTER FUNCTION crm_template_read.submissao(text,text,text) SET search_path=public,pg_catalog'],
  ['VOLATILE','ALTER FUNCTION crm_template_read.listar(text,text,integer,integer) VOLATILE'],
  ['EXECUTE no principal','GRANT EXECUTE ON FUNCTION crm_template_read.principal(text,text) TO crm_template_reader'],
  ['EXECUTE na autenticação','GRANT EXECUTE ON FUNCTION public.shrigma_panel_operator_v1(text,text) TO PUBLIC'],
  ['função extra','CREATE FUNCTION crm_template_read.extra() RETURNS int LANGUAGE sql STABLE AS $$ SELECT 1 $$'],
  ['dono','CREATE ROLE outro_dono; ALTER FUNCTION crm_template_read.listar(text,text,integer,integer) OWNER TO outro_dono']
 ];
 for(const [name,ddl] of changes){
  await db.exec('BEGIN');try{
   await db.exec(ddl);
   const bad=await handle(db);assert.equal(bad.r.status,503,name);assert.deepEqual(bad.r.body,{error:'TEMPLATE_READ_NOT_READY'},name);
   assert.equal(bad.calls.some(c=>[S.SQL.listar,S.SQL.historico,S.SQL.submissao].includes(c)),false,name+': leitura não chamada');
  }finally{await db.exec('ROLLBACK');}
 }
 assert.equal((await handle(db)).r.status,200,'desfeita a alteração, volta a ler');
});
