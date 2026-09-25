'use strict';
const fs=require('node:fs'),path=require('node:path');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const P=require('../../n8n/growth/email-test-protocol.cjs');
const GEC=require(process.env.CRM_EMAIL_CONTRACT_MODULE||'../../growth-email-contract.js');
const uuid=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const draft=()=>({marca:'fish',canal:'email',nome:'synthetic',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',preheader:'Fixture',assunto:'Oi {{ .Tx.Data.first_name }}',corpo:'<p>Olá {{ .Tx.Data.first_name }}</p>',botoes:[]});
async function setup({db=new PGlite()}={}){await db.exec(`
 CREATE TABLE crm_dash_chave(chave text PRIMARY KEY,painel text,ativo boolean,revogada_em timestamptz,expira_em timestamptz,chave_hash text);
 CREATE TABLE shrigma_panel_permission_v1(principal_id text,area text,caps jsonb);
 INSERT INTO crm_dash_chave VALUES('manager','growth',true,NULL,NULL,'hash'),('other','growth',true,NULL,NULL,'hash'),('viewer','growth',true,NULL,NULL,'hash');
 INSERT INTO shrigma_panel_permission_v1 VALUES('manager','growth','["draft","validate","submit"]'),('other','growth','["draft","validate","submit"]'),('viewer','growth','["read_content"]');
 CREATE TABLE subscribers(id integer PRIMARY KEY,email text,status text);CREATE TABLE lists(id integer PRIMARY KEY,tags varchar[]);
 CREATE TABLE subscriber_lists(subscriber_id integer,list_id integer,status text,PRIMARY KEY(subscriber_id,list_id));
 INSERT INTO subscribers VALUES(1,'felipebandeira@oaristocrata.com','enabled');INSERT INTO lists VALUES(16,ARRAY['aristo']),(17,ARRAY['fish']);INSERT INTO subscriber_lists VALUES(1,16,'confirmed');
 CREATE TABLE templates(id integer PRIMARY KEY,type text,subject text,body text);
 CREATE TABLE shrigma_template_draft(draft_id text PRIMARY KEY,brand text,channel text,nome text,version integer,estado text,rascunho jsonb,components jsonb);
 CREATE TABLE shrigma_template_submissao(submission_id text,draft_id text,draft_version integer,provider text,provider_id text,estado text,provider_status text);
 CREATE TABLE shrigma_template_email_registry(template_id integer,brand text,draft_id text);
 CREATE TABLE shrigma_template_evento(draft_id text,action text,to_version integer,result text);
 CREATE TABLE shrigma_email_dispatch(dispatch_id uuid PRIMARY KEY,brand text,flow text,piece text,dedupe_key text,payload_sha256 text,account_id text,region text,configuration_set text,recipient_key text,recipient_key_version text,is_test boolean,transport_state text,started_at timestamptz,accepted_at timestamptz,outcome_at timestamptz,claim_token uuid,error_code text,UNIQUE(brand,flow,piece,dedupe_key));
 CREATE TABLE shrigma_email_status(dispatch_id uuid,is_test boolean,reconciliation_status text,status text,ocorreu_em timestamptz);
 CREATE FUNCTION shrigma_email_recipient_key(text) RETURNS TABLE(recipient_key text,key_version text) LANGUAGE sql AS $$ SELECT repeat('a',64),'synthetic-v1' $$;
 `);await db.exec(fs.readFileSync(path.join(__dirname,'../../n8n/growth/email-test.sql'),'utf8'));
 const r=draft(),native=GEC.payload(r);await db.query("INSERT INTO templates VALUES(100,'tx',$1,$2)",[native.subject,native.body]);
 await db.query("INSERT INTO shrigma_template_draft VALUES('d_fixture','fish','email','fixture',1,'publicado',$1,$2)",[r,{subject:native.subject,body_html:native.body}]);
 await db.exec("INSERT INTO shrigma_template_submissao VALUES('s_fixture','d_fixture',1,'listmonk','100','publicado','APPROVED');INSERT INTO shrigma_template_email_registry VALUES(100,'fish','d_fixture');INSERT INTO shrigma_template_evento VALUES('d_fixture','validate',1,'ok');");
 const snapshot=async(actor='panel:manager')=>(await db.query("SELECT crm_email_test_snapshot_v1($1,'d_fixture',1) s",[actor])).rows[0].s;
 const request=n=>({draft_id:'d_fixture',expected_version:1,idempotency_key:uuid(n),confirm:'enviar_teste'});
 const claim=async(n,plan,actor='panel:manager',p=request(n))=>(await db.query('SELECT crm_email_test_claim_v1($1,$2,$3) r',[actor,p,plan||P.plan(await snapshot(actor),GEC)])).rows[0].r;
 const receipt=async(n,actor='panel:manager')=>(await db.query('SELECT crm_email_test_operation_v1($1,$2) r',[actor,uuid(n)])).rows[0].r;
 return {db,snapshot,request,claim,receipt};}

module.exports={setup,uuid,draft,GEC,P};
