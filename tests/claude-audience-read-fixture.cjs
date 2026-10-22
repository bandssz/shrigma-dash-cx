'use strict';
// Fixture sintética (PGlite ou PostgreSQL descartável) para a leitura isolada
// de públicos. Instala o mesmo schema dos testes de vínculo e a proposta
// n8n/growth/crm-audience-read-access.sql (sem a trava de owner/listmonk,
// que só faz sentido na instalação real).
const {createHash}=require('node:crypto');
const F=require('./segment-campaign-binding-fixture.cjs'),A=require('./segment-audience-store-fixture.cjs');
const R=require('../services/crm-audience/read-store.cjs');
const sha=x=>createHash('sha256').update(x).digest('hex');
// Mesmo formato do principal emitido pelo provisionamento #214.
const PRINCIPAL='dcrm-'+'a'.repeat(32),KEY='b'.repeat(64);
function readAccessSQL(){
 return A.read('n8n/growth/crm-audience-read-access.sql')
  .replace("IF current_user<>'postgres' OR current_database()<>'listmonk' THEN RAISE EXCEPTION 'CRM_AUDIENCE_READ_OWNER'; END IF;",'')
  .replace('GRANT CONNECT ON DATABASE listmonk TO crm_audience_reader;','');
}
async function install(db){
 const f=await F.setup(db);
 await db.exec(readAccessSQL());
 await db.query("INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash) VALUES($1,'growth','gestor@oaristocrata.com',$2)",[PRINCIPAL,sha(KEY)]);
 await db.query("INSERT INTO shrigma_panel_permission_v1 VALUES($1,'growth','[\"read_content\",\"list_history\",\"submission\"]'::jsonb)",[PRINCIPAL]);
 return f;
}
// Estado observável de todas as tabelas de usuário, incluindo xmin/xmax:
// bloqueio de linha (FOR SHARE/UPDATE) muda xmax mesmo sem alterar dados.
async function snapshot(db){
 const tables=(await db.query("SELECT n.nspname AS s,c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN('public','crm_audience_v2','crm_audience_read') ORDER BY 1,2")).rows;
 const out={};
 for(const {s,t}of tables){const r=(await db.query(`SELECT count(*)::int AS n,coalesce(md5(string_agg(x::text||'|'||x.xmin::text||'|'||x.xmax::text,',' ORDER BY x::text)),'') AS h FROM "${s}"."${t}" x`)).rows[0];out[s+'.'+t]=r.n+':'+r.h;}
 return out;
}
// Pool mínimo sobre PGlite (uma sessão): após o BEGIN do módulo, assume o
// papel de leitura, como faria um LOGIN crm_audience_reader real.
function pglitePool(db,{role=R.ROLE,log=[],hook=null}={}){
 const stats={connects:0};
 return {stats,log,async connect(){stats.connects++;return {async query(q){const text=typeof q==='string'?q:q.text,values=typeof q==='string'?[]:q.values||[];log.push(text);
  const hooked=hook?await hook(text,values):undefined;const r=await db.query(hooked?.text??text,hooked?.values??values);if(/^BEGIN /.test(text))await db.query(`SET LOCAL ROLE ${role}`);return r;},release(){}};}};
}
module.exports={install,snapshot,pglitePool,readAccessSQL,PRINCIPAL,KEY,sha};
