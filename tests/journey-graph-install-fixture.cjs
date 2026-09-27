'use strict';
// Disposable synthetic database only. Reproduce the installed draft foundation and
// sealed CART retention before the composed graph installer adds execution SQL.
const fs=require('node:fs'),path=require('node:path');
const Cart=require('./journey-graph-cart-fixture.cjs');
const C=require('../tools/maintenance-cart-deploy/deploy.cjs');
const M=require('./maintenance-cart-fixture.cjs');
const ROOT=path.join(__dirname,'..');
const NONCE='20000000-0000-4000-8000-000000000001';
const read=f=>fs.readFileSync(path.join(ROOT,f),'utf8');
async function installBase(t,{db,pool}={}){
 const x=await Cart.install(t,db,pool);
 await x.db.exec(`DROP SCHEMA crm_graph_candidate CASCADE;
 DROP INDEX public.graph_native_template_name_v1;
 DROP TABLE crm_maintenance_candidate.control;DROP SCHEMA crm_maintenance_candidate;
 ALTER SEQUENCE public.synthetic_cart_send_log RENAME TO shrigma_send_log_id_seq;
 ALTER SEQUENCE public.shrigma_send_log_id_seq OWNED BY public.shrigma_send_log.id;
 CREATE TABLE public.graph_install_fixture_secret(value text NOT NULL);
 INSERT INTO public.graph_install_fixture_secret VALUES('synthetic-key-only');
 REVOKE ALL ON public.graph_install_fixture_secret FROM PUBLIC;
 CREATE OR REPLACE FUNCTION public.shrigma_email_recipient_key(email text)
 RETURNS TABLE(recipient_key text,key_version text) LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT md5(lower(email)||value),'fixture'::text FROM public.graph_install_fixture_secret$$;
 REVOKE ALL ON FUNCTION public.shrigma_email_recipient_key(text) FROM PUBLIC;
 CREATE FUNCTION public.shrigma_flow_email_claim_tx(text,jsonb)
 RETURNS TABLE(should_send boolean,dispatch_id uuid,claim_token uuid,payload jsonb,context jsonb,reason text)
 LANGUAGE sql AS $$SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'fixture_unused'::text$$;
 CREATE FUNCTION public.shrigma_email_claim_engagement(jsonb)
 RETURNS TABLE(should_send boolean,dispatch_id uuid,claim_token uuid,payload jsonb,context jsonb,reason text)
 LANGUAGE sql AS $$SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'fixture_unused'::text$$;
 CREATE FUNCTION public.shrigma_panel_operator_v1(text,text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('who','panel:synthetic','caps',jsonb_build_array('draft','read_content'))$$;`);
 await x.db.exec(read('tests/journey-graph-cart-legacy-fixture.sql'));
 await x.db.exec(read('n8n/growth/journey-graph-store.sql'));
 await x.db.exec(read('n8n/growth/journey-graph-catalog.sql'));
 await x.db.exec(read('n8n/growth/journey-graph-workflow-store.sql'));
 const {createGraphRuntime}=require('../n8n/growth/journey-graph-runtime.cjs');
 const drafts=createGraphRuntime({pool:x.pool,readSource:async()=>{throw Error('FIXTURE_DRAFT_ONLY');},catalogFor:async({brand})=>(await x.query('SELECT crm_graph_candidate.catalog_v1($1) value',[brand])).rows[0].value});
 for(const [i,brand] of ['fish','aristo'].entries())await drafts.create({request_id:'20000000-0000-4000-8000-00000000000'+(i+2),actor:'panel:synthetic',brand,
  definition:{version:'journey_graph_v1',brand,name:'Existing synthetic draft '+brand,nodes:[{id:'start',type:'trigger',event:'cart.abandoned'},{id:'end',type:'exit',reason:'finished'}],edges:[{from:'start',to:'end',port:'next'}]}});
 const maintenanceBefore=(await x.query(C.METADATA_SQL)).rows[0];
 await x.db.exec(C.atomicInstall(ROOT,maintenanceBefore,NONCE).sql);
 const maintenance=M.cartAPI({query:x.query});await maintenance.control(1,true,'open');
 async function legacyBody(brand='fish'){
  const row=(await x.query('SELECT email,attribs->$1 AS a FROM public.subscribers WHERE id=1',[brand])).rows[0];
  const address=brand==='fish'?'contato@fishermans.com.br':'contato@oaristocrata.com';
  const template_id=brand==='fish'?60:95;
  return {brand,toque:'t05',piece:'carrinho-30min',chave:'cart_t05_at',subscriber_id:1,email:row.email,ref:row.a.cart_abandoned_at,template_id,
   tx:{template_id,subscriber_email:row.email,from_email:(brand==='fish'?'Fishermans':'O Aristocrata')+' <'+address+'>',headers:[{'Reply-To':address}],content_type:'html',
    data:{checkout_url:row.a.cart_url+(row.a.cart_url.includes('?')?'&':'?')+'utm_source=email&utm_medium=fluxo&utm_campaign='+brand+'-carrinho&utm_content=carrinho-30min'}}};
 }
 // Retention already holds a real synthetic receipt. Installing must not consume
 // or mutate it merely because the graph capability is being installed OFF.
 const retained=await maintenance.admit('fish','cart',await legacyBody('fish'));
 return {...x,maintenance,retained,legacyBody,
  claim:async brand=>(await x.query('SELECT * FROM public.shrigma_email_claim_cart($1::jsonb)',[JSON.stringify(await legacyBody(brand))])).rows[0],
  finish:async grant=>(await x.query('SELECT * FROM public.shrigma_email_finish_cart($1,$2,$3,$4)',[grant.dispatch_id,grant.claim_token,'accepted',JSON.stringify(grant.context)])).rows[0]};
}
const rowSnapshot=async db=>(await db.query(`SELECT jsonb_build_object(
 'graph_control',(SELECT jsonb_agg(to_jsonb(t)) FROM crm_graph_candidate.control t),
 'journeys',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM crm_graph_candidate.journey t),
 'revisions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY journey_id,revision) FROM crm_graph_candidate.revision t),
 'entries',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM crm_graph_candidate.entry t),
 'intents',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM crm_graph_candidate.intent t),
 'transitions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY entry_id,entry_version) FROM crm_graph_candidate.transition t),
 'operations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY request_id) FROM crm_graph_candidate.operation t),
 'maintenance_control',(SELECT jsonb_agg(to_jsonb(t)) FROM crm_maintenance_candidate.control t),
 'events',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM crm_maintenance_candidate.event t),
 'maintenance_operations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM crm_maintenance_candidate.operation t),
 'attempts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY event_id) FROM crm_maintenance_candidate.cart_attempt t),
 'dispatches',(SELECT jsonb_agg(to_jsonb(t) ORDER BY dispatch_id) FROM public.shrigma_email_dispatch t),
 'send_log',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.shrigma_send_log t)) value`)).rows[0].value;
module.exports={ROOT,NONCE,installBase,rowSnapshot};
