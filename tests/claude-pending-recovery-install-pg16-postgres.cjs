/* Instalador da recuperação de tentativas pendentes · regressões da revisão Codex (#220)
   em PostgreSQL NATIVO (16/17), com o gateway instalado (effect_v1/auth_v1 pinados e o
   wrapper de encerrar). Exige CRM_PENDING_RECOVERY_TEST_ISOLATED=1 e TEST_DATABASE_URL
   postgresql://postgres@127.0.0.1:<porta≠5432>/listmonk de um banco descartável NOVO
   (sem a cadeia de campanha). Sem rede, sem Listmonk, sem envio. */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {Client}=require('pg');
if(process.env.CRM_PENDING_RECOVERY_TEST_ISOLATED!=='1'||!process.env.TEST_DATABASE_URL)throw Error('isolated PostgreSQL required');
const parsed=new URL(process.env.TEST_DATABASE_URL);
// Versão alvo explícita opcional: CRM_PG_EXPECTED_VERSION_NUM=160015|170010 exige exatamente
// a versão informada; sem a variável, aceita 16 ou 17 como antes.
const assertPgVersion=v=>{assert.ok(/^1[67]\d{4}$/.test(v),'PostgreSQL 16 ou 17');const e=process.env.CRM_PG_EXPECTED_VERSION_NUM;if(e){assert.ok(['160015','170010'].includes(e),'CRM_PG_EXPECTED_VERSION_NUM não suportado: '+e);assert.equal(String(v),e);}};
if(parsed.protocol!=='postgresql:'||parsed.hostname!=='127.0.0.1'||parsed.port===''||parsed.port==='5432'||parsed.pathname!=='/listmonk'||parsed.username!=='postgres'||parsed.password)throw Error('isolated PostgreSQL URL required');
const cases=require('./claude-pending-recovery-install-cases.cjs');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8'),sha=s=>createHash('sha256').update(s).digest('hex');
const atomic=sql=>`DO $campaign_gateway$ BEGIN EXECUTE $gateway_ddl$${sql}$gateway_ddl$; END $campaign_gateway$;`;

test('instalador recusa qualquer desvio antes do DDL; reinstalação exata no-op; gate OFF mantém a cerca (PostgreSQL nativo)',async t=>{
 const c=new Client({connectionString:parsed.href});await c.connect();t.after(()=>c.end());
 const version=(await c.query('SHOW server_version_num')).rows[0].server_version_num;assertPgVersion(version);
 assert.equal((await c.query("SELECT to_regclass('public.shrigma_campaign_operation') AS r")).rows[0].r,null,'banco descartável novo exigido');
 await c.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE TABLE crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL,dono text,ativo boolean DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer DEFAULT 0); CREATE TABLE shrigma_template_key_v2(key_hash text,active boolean,actor text,capabilities jsonb);`);
 for(const f of ['n8n/access/panel-auth.sql','n8n/access/panel-operator.sql','n8n/access/panel-short-keys.sql','tests/campaign-provider-schema.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-recovery.sql','n8n/growth/campaign-template-ownership.sql','n8n/growth/campaign-provider.sql'])await c.query(read(f));
 // Papel do cluster descartável pode ter ficado com LOGIN de outro teste: volta ao estado da migração.
 await c.query("DO $r$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_campaign_api') THEN ALTER ROLE crm_campaign_api NOLOGIN PASSWORD NULL; END IF; END $r$");
 await c.query(atomic(read('n8n/growth/crm-campaign-gateway-role.sql')));
 const db={exec:sql=>c.query(sql),query:(sql,params)=>c.query(sql,params)};
 const r=await cases(db,{native:true});
 console.log(JSON.stringify({postgres:version,...r,native_calls:0,sends:0}));
});
