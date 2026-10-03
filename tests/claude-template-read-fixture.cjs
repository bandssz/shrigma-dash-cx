'use strict';
// Fixture sintética (PGlite ou PostgreSQL 16 descartável) para a leitura de
// templates com marca obrigatória (agente N). Esquema mínimo copiado das
// fixtures existentes (email-test-fixture, journey-graph-*), autenticação real
// de n8n/access e a proposta n8n/growth/crm-template-read-access.sql.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const sha=x=>createHash('sha256').update(x).digest('hex');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const PRINCIPAL='dcrm-'+'a'.repeat(32),KEY='b'.repeat(64);
const NOCAP_PRINCIPAL='dcrm-'+'c'.repeat(32),NOCAP_KEY='d'.repeat(64);
const REVOKED_PRINCIPAL='dcrm-'+'e'.repeat(32),REVOKED_KEY='f'.repeat(64);
const LEGACY_KEY='growth-legacy-key',TEMPLATE_V2_KEY='1'.repeat(64);
const SQL_FILE='n8n/growth/crm-template-read-access.sql';
// Sem a trava de owner/listmonk, que só faz sentido na instalação real (PGlite).
function accessSQL({strict=false}={}){
 const s=read(SQL_FILE);if(strict)return s;
 return s.replace("IF current_user<>'postgres' OR current_database()<>'listmonk' THEN RAISE EXCEPTION 'CRM_TEMPLATE_READ_OWNER'; END IF;",'')
  .replace('GRANT CONNECT ON DATABASE listmonk TO crm_template_reader;','');
}
async function schema(db){
 await db.exec(`CREATE TABLE public.crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL,dono text,ativo boolean NOT NULL DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer NOT NULL DEFAULT 0);
 CREATE TABLE public.shrigma_template_key_v2(key_hash text,active boolean,actor text,capabilities jsonb);`);
 for(const f of ['n8n/access/panel-auth.sql','n8n/access/panel-operator.sql','n8n/access/panel-short-keys.sql'])await db.exec(read(f));
 await db.exec(`CREATE TABLE public.templates(id integer PRIMARY KEY,name text NOT NULL,type text NOT NULL,subject text,body text,body_source text,is_default boolean DEFAULT false,created_at timestamptz DEFAULT '2026-09-01T00:00:00Z',updated_at timestamptz DEFAULT '2026-09-02T00:00:00Z');
 CREATE TABLE public.shrigma_template_email_registry(template_id integer,brand text CONSTRAINT shrigma_template_email_registry_brand_check CHECK(brand IN ('fish','aristo','olivas')),draft_id text);
 CREATE TABLE public.shrigma_template_draft(draft_id text PRIMARY KEY,brand text,channel text,nome text,version integer,estado text,rascunho jsonb,components jsonb);
 CREATE TABLE public.shrigma_template_submissao(submission_id text,draft_id text,draft_version integer,provider text,provider_id text,estado text,provider_status text);
 CREATE TABLE public.shrigma_template_evento(draft_id text,action text,to_version integer,result text,at timestamptz,who text);`);
}
async function data(db){
 const t=(id,name,type,body='<p>Olá {{ .Subscriber.FirstName }}</p>',subject='Assunto '+id)=>db.query('INSERT INTO public.templates(id,name,type,subject,body) VALUES($1,$2,$3,$4,$5)',[id,name,type,subject,body]);
 await t(1,'Boas-vindas Fishermans','tx');await t(2,'Newsletter Aristocrata','campaign');await t(3,'Legado sem registro','campaign');
 await t(4,'Ambíguo','tx');await t(5,'NPS Olivas','tx');await t(6,'Fishermans grande','tx','x'.repeat(400001));
 await t(7,'__shrigma_journey_tx_v1_clone','tx');await t(8,'Layout Fishermans','campaign');await t(9,'Campanha Aristocrata','campaign');
 const r=(id,brand,draft=null)=>db.query('INSERT INTO public.shrigma_template_email_registry VALUES($1,$2,$3)',[id,brand,draft]);
 await r(1,'fish','d_fish_1');await r(2,'aristo','d_aristo_1');await r(4,'fish');await r(4,'aristo');await r(5,'olivas','d_olivas_1');await r(6,'fish');await r(7,'fish');
 await r(8,'fish','d_fish_2');await r(8,'fish','d_fish_3');await r(9,'aristo');
 for(const [id,brand,channel] of [['d_fish_1','fish','email'],['d_fish_2','fish','whatsapp'],['d_aristo_1','aristo','email'],['d_olivas_1','olivas','email']])
  await db.query("INSERT INTO public.shrigma_template_draft VALUES($1,$2,$3,'Rascunho',2,'submetido','{}','[]')",[id,brand,channel]);
 for(const [d,a,v,res,at,who] of [['d_fish_1','rascunho',1,'201','2026-09-10T10:00:00Z','gestor fish'],['d_fish_1','validate',2,'ok','2026-09-10T11:00:00Z','gestor fish'],['d_fish_1','submeter',2,'202','2026-09-10T12:00:00Z',null],['d_aristo_1','rascunho',1,'201','2026-09-11T10:00:00Z','gestor aristo'],['d_olivas_1','rascunho',1,'201',null,null]])
  await db.query('INSERT INTO public.shrigma_template_evento VALUES($1,$2,$3,$4,$5,$6)',[d,a,v,res,at,who]);
 for(const [s,d,v,p,e,ps] of [['s_fish_1','d_fish_1',2,'meta','submetido','PENDING'],['s_aristo_1','d_aristo_1',2,'listmonk','publicado','APPROVED'],['s_olivas_1','d_olivas_1',1,'listmonk','publicado','APPROVED'],['s_orfa','d_inexistente',1,'meta','submetido','PENDING']])
  await db.query('INSERT INTO public.shrigma_template_submissao VALUES($1,$2,$3,$4,$5,$6,$7)',[s,d,v,p,'prov-'+s,e,ps]);
 const all='["read_content","list_history","submission"]';
 for(const [id,key,caps,revoked] of [[PRINCIPAL,KEY,all,false],[NOCAP_PRINCIPAL,NOCAP_KEY,'["read_content"]',false],[REVOKED_PRINCIPAL,REVOKED_KEY,all,true]]){
  await db.query("INSERT INTO public.crm_dash_chave(chave,painel,dono,chave_hash,revogada_em) VALUES($1,'growth','gestor@oaristocrata.com',$2,$3)",[id,sha(key),revoked?'2026-10-01T00:00:00Z':null]);
  await db.query("INSERT INTO public.shrigma_panel_permission_v1 VALUES($1,'growth',$2::jsonb)",[id,caps]);
 }
 // Chaves legadas válidas no handler n8n: aqui não leem.
 await db.query("INSERT INTO public.crm_dash_chave(chave,painel,dono) VALUES($1,'growth','time growth')",[LEGACY_KEY]);
 await db.query("INSERT INTO public.shrigma_template_key_v2 VALUES($1,true,'legacy-template-actor','[\"read_content\",\"list_history\",\"submission\"]')",[sha(TEMPLATE_V2_KEY)]);
}
async function install(db,options){await schema(db);await data(db);await db.exec(accessSQL(options));}
// Estado observável (linhas + xmin/xmax): bloqueio de linha muda xmax.
async function snapshot(db){
 const tables=(await db.query("SELECT n.nspname AS s,c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN('public','crm_template_read') ORDER BY 1,2")).rows;
 const out={};
 for(const {s,t}of tables){const r=(await db.query(`SELECT count(*)::int AS n,coalesce(md5(string_agg(x::text||'|'||x.xmin::text||'|'||x.xmax::text,',' ORDER BY x::text)),'') AS h FROM "${s}"."${t}" x`)).rows[0];out[s+'.'+t]=r.n+':'+r.h;}
 return out;
}
module.exports={install,schema,data,accessSQL,snapshot,sha,PRINCIPAL,KEY,NOCAP_KEY,REVOKED_KEY,LEGACY_KEY,TEMPLATE_V2_KEY,SQL_FILE};
