'use strict';
// Original SQLite/native issuer/store; disposable PGlite only. No production I/O.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {fixture,hosts}=require('./corporate-writer-fixture.cjs'),F=require('./segment-audience-store-fixture.cjs');
const {createWriterClient}=require('../services/dashboard-operational/crm-manager-writer-client.cjs');
const {createWriterCoordinator}=require('../services/dashboard-operational/crm-manager-writer-coordinator.cjs');
const {verifyCampaignWriterCredential}=require('../services/dashboard-operational/crm-campaign-writer-attestation.cjs');
const Store=require('../n8n/growth/segment-audience-store.cjs'),API=require('../n8n/growth/segment-audience-api.cjs');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
async function setup(t){
 const f=await fixture(t);f.advance(Date.now()-f.now);
 const master=await f.auth.login({email:f.config.bootstrapAdminEmail,password:'Synthetic writer manager password 2026!',host:hosts.manager,origin:'https://'+hosts.manager});Object.assign(f.context,{cookieHeader:master.cookie.split(';')[0],csrf:master.csrf});
 const db=new PGlite();t.after(()=>db.close());
 await db.exec('CREATE TABLE public.crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL,dono text,ativo boolean DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer DEFAULT 0);CREATE TABLE public.shrigma_template_key_v2(key_hash text,active boolean,actor text,capabilities jsonb);');
 for(const p of ['n8n/access/panel-auth.sql','n8n/access/panel-operator.sql','n8n/access/panel-short-keys.sql','tests/campaign-provider-schema.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-recovery.sql','n8n/growth/campaign-template-ownership.sql','n8n/growth/campaign-provider.sql','n8n/growth/campaign-write-guard.sql'])await db.exec(read(p));
 await db.exec('CREATE ROLE central_leitor NOLOGIN;ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO central_leitor;');await db.exec(read('tools/crm-manager-writer-review/writer-provision-v1.sql'));
 await db.exec('CREATE ROLE crm_manager_audience_fixture LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;GRANT EXECUTE ON FUNCTION public.crm_manager_writer_prepare_v1(jsonb),public.crm_manager_writer_commit_v1(jsonb),public.crm_manager_writer_revoke_v1(jsonb),public.crm_manager_writer_status_v1(jsonb) TO crm_manager_audience_fixture;');
 await db.query('INSERT INTO crm_manager_writer_issuer_v1(issuer_id,namespace_id,login_role,allowed_email_domains,active) VALUES($1,$2,$3,$4,true)',[f.config.crmManagedWriter.issuerId,f.config.crmManagedWriter.namespaceId,'crm_manager_audience_fixture',f.config.allowedEmailDomains]);
 await db.exec(read('n8n/growth/crm-campaign-gateway-role.sql'));
 await db.exec(read('n8n/growth/segment-audience-store.sql'));
 // Reuse aggregate-only provenance helpers from the existing Store fixture.
 await db.exec("CREATE FUNCTION crm_audience_v2.shopify_snapshot(text) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('current',false)$$;");
 await db.exec('CREATE ROLE crm_audience_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;GRANT USAGE ON SCHEMA crm_audience_v2 TO crm_audience_api;');
 await db.exec(read('n8n/growth/segment-corporate-writer-auth.sql'));
 const refresh=brand=>db.query("UPDATE crm_audience_v2.config SET enabled=true,base_list_id=$2,revision=revision+1,catalog=$3::jsonb,checked_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()+interval '4 minutes' WHERE brand=$1",[brand,brand==='fish'?17:16,JSON.stringify(F.source(brand))]);
 for(const brand of ['fish','aristo'])await refresh(brand);
 await db.exec("SET statement_timeout='20s'");
 const nativeAuth=key=>db.query('SELECT shrigma_crm_campaign_auth_v1($1) AS r',[key]);
 const invoke=async({procedure,parameters})=>{await db.exec('SET SESSION AUTHORIZATION crm_manager_audience_fixture');try{const r=(await db.query('SELECT '+procedure+'($1::jsonb) AS r',parameters)).rows[0].r;f.advance(Date.now()-f.now);return r;}finally{await db.exec('SET SESSION AUTHORIZATION postgres');}};
 const client=createWriterClient({issuerId:f.config.crmManagedWriter.issuerId,namespaceId:f.config.crmManagedWriter.namespaceId,allowedEmailDomains:f.config.allowedEmailDomains,now:()=>f.now,invoke});
 const attest=async input=>verifyCampaignWriterCredential(input,{fetchImpl:async url=>{const v=(await nativeAuth(input.bearer)).rows[0].r;assert.ok(v);const response=new Response(JSON.stringify({schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',owner:input.owner,allowedPanels:['growth'],permissions:{growth:{who:v.actor,label:input.owner,caps:v.caps},influs:null}}),{headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;}});
 const coordinator=createWriterCoordinator({journal:f.auth.managedCampaignWriterJournal,client,attest,now:()=>f.now});
 async function manager(brand){const email=brand+'@'+(brand==='fish'?'fishermans.com.br':'oaristocrata.com'),i=f.invite(email,'growth',brand);await f.accept(i);f.promoteRead(i.userId);f.auth.fulfillManagedCampaignWriterRequests();assert.deepEqual(await coordinator.run(f.operation(i.userId)),{state:'ready'});const ctx=await f.login(email),key=f.auth.getUpstreamCredential({...ctx,area:'growth',brand,slot:'growth-campaign',edit:true});return{id:i.userId,ctx,key,brand};}
 const users={fish:await manager('fish'),aristo:await manager('aristo')};let afterQuery=null;
 const transaction=(work,options)=>db.transaction(tx=>work({query:async(text,args=[])=>{const r=await tx.query(text,args);if(afterQuery)await afterQuery(text,args,tx);return r;}}));
 const store=Store.createAudienceStore({transaction,corporateWriter:true,countProvider:null}),api=API.createAudienceAPI({store});
 const call=(p,key)=>api.handle({method:['segmento_criar','segmento_salvar','segmento_arquivar','segmento_contar'].includes(p.acao)?'POST':'GET',request:{headers:{Authorization:'Bearer '+key},[['segmento_criar','segmento_salvar','segmento_arquivar','segmento_contar'].includes(p.acao)?'body':'query']:p}});
 const create=async(brand,key)=>{const c=await call({acao:'segmentos_listar',brand,limit:50,offset:0},key);assert.equal(c.status,200,JSON.stringify(c));return{acao:'segmento_criar',brand,idempotency_key:crypto.randomUUID(),definition:F.definition(brand,{op:'in_list',list_id:brand==='fish'?17:16}),expected_catalog_hash:c.body.catalog.catalog_hash};};
 return{f,db,users,call,create,store,api,refresh,set afterQuery(v){afterQuery=v;}};
}
module.exports={setup,hosts,read,sha};
