'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {fixture,id}=require('./journey-graph-runtime.cjs'),{API}=require('../../n8n/growth/journey-graph-workflow.cjs');
const read=p=>fs.readFileSync(path.join(__dirname,'../..',p),'utf8'),hash=s=>createHash('sha256').update(s).digest('hex');
async function setup({db=new PGlite()}={}){
 await db.exec(read('tests/fixtures/journey-graph-auth.sql'));await db.exec("CREATE TABLE shrigma_panel_permission_v1(principal_id text,area text,caps jsonb,PRIMARY KEY(principal_id,area));");
 const auth=read('n8n/access/panel-short-keys.sql'),start=auth.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_panel_operator_v1(k text,a text)'),end=auth.indexOf('REVOKE ALL ON FUNCTION public.shrigma_panel_operator_v1(text,text) FROM PUBLIC;',start);if(start<0||end<start)throw Error('Auth fixture anchor drift');await db.exec(auth.slice(start,end)+'REVOKE ALL ON FUNCTION public.shrigma_panel_operator_v1(text,text) FROM PUBLIC;');
 for(const [actor,caps]of [['manager',['draft','read_content']],['other',['draft','read_content']],['reader',['read_content']]]){await db.query('INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash,chave_hash_curta) VALUES($1,\'growth\',$1,$2,$3)',[actor,hash('synthetic-'+actor+'-key'),actor==='manager'?hash('synshort'):null]);await db.query("INSERT INTO shrigma_panel_permission_v1 VALUES($1,'growth',$2)",[actor,JSON.stringify(caps)]);}
 await db.exec(read('n8n/growth/journey-graph-store.sql'));await db.exec('CREATE TABLE fixture_catalog(brand text PRIMARY KEY,payload jsonb);CREATE FUNCTION crm_graph_candidate.catalog_v1(b text) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT payload FROM public.fixture_catalog WHERE brand=b $$;CREATE FUNCTION crm_graph_candidate.catalog_ui_v1(b text) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object(\'catalog\',crm_graph_candidate.catalog_v1(b),\'readiness\',jsonb_build_object(\'draft_only\',true,\'publish\',false,\'runtime\',false,\'transport\',false)) $$;');
 const pool={async connect(){return {query:db.query.bind(db),release(){}};}},fish=fixture(pool),aristo=fixture(pool,'aristo');for(const f of[fish,aristo])await db.query('INSERT INTO fixture_catalog VALUES($1,$2)',[f.catalog.brand,JSON.stringify(f.catalog)]);
 await db.exec(read('n8n/growth/journey-graph-workflow-store.sql'));
 const entry=(p,key='synthetic-manager-key',method=['create','save'].includes(p.action)?'POST':'GET')=>API.parse({method,request:{headers:{authorization:'Bearer '+key},[method==='POST'?'body':'query']:p}});
 const sqlRead=async(e,query=db.query.bind(db))=>(await query('SELECT crm_graph_candidate.workflow_read_v1($1,$2) result',[e.key,JSON.stringify(e.request)])).rows[0].result;
 const sqlCommit=async(e,proof,query=db.query.bind(db))=>(await query('SELECT crm_graph_candidate.workflow_commit_v1($1,$2,$3) result',[e.key,JSON.stringify(e.request),JSON.stringify(proof)])).rows[0].result;
 const call=async(p,key)=>{const e=entry(p,key);if(e.route==='response')return e.response;const v=API.prepare(e,await sqlRead(e));return v.route==='response'?v.response:API.finish(e,await sqlCommit(e,v.proof)).response;};
 return {db,pool,fish,aristo,entry,sqlRead,sqlCommit,call};
}
module.exports={setup,id,read};
