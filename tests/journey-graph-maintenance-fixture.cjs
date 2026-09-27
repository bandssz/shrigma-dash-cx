'use strict';
const fs=require('node:fs'),Cart=require('./journey-graph-cart-fixture.cjs'),M=require('./maintenance-cart-fixture.cjs');
const migration=fs.readFileSync(require.resolve('../n8n/growth/journey-graph-maintenance.sql'),'utf8');
async function install(t,{db,pool,migrate=true}={}){
 const x=await Cart.install(t,db,pool);
 // Replace only the disposable cart fixture's gate with the complete retention schema.
 // Real cart claim/finish, graph ownership, source and release SQL remain installed.
 await x.db.exec(`DROP TABLE crm_maintenance_candidate.control;DROP SCHEMA crm_maintenance_candidate;
 CREATE FUNCTION public.shrigma_flow_email_claim_tx(text,jsonb) RETURNS TABLE(should_send boolean,dispatch_id uuid,claim_token uuid,payload jsonb,context jsonb,reason text) LANGUAGE sql AS $$SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'graph_owned'::text$$;
 CREATE FUNCTION public.shrigma_email_claim_engagement(jsonb) RETURNS TABLE(should_send boolean,dispatch_id uuid,claim_token uuid,payload jsonb,context jsonb,reason text) LANGUAGE sql AS $$SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'graph_owned'::text$$;`);
 await x.db.exec(M.store);await x.db.exec(M.cartSQL);
 const maintenance=M.cartAPI({query:x.query});await maintenance.control(1,true,'open');
 if(migrate)await x.db.exec(migration);
 return {...x,maintenance,migrate:()=>x.db.exec(migration),async legacyBody(f){return (await f.legacy()).body;},
  async snapshot(eid){return (await x.query("SELECT to_jsonb(e)-ARRAY['state','reason'] value FROM crm_maintenance_candidate.event e WHERE id=$1",[eid])).rows[0].value;},
  async count(table){if(!['crm_graph_candidate.maintenance_delegation_v1','shrigma_email_dispatch','shrigma_send_log'].includes(table))throw Error('FIXTURE_TABLE');return Number((await x.query('SELECT count(*) n FROM '+table)).rows[0].n);}
 };
}
module.exports={install,migration,M};
