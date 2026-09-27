'use strict';
// Only disposable synthetic databases; no source/recipient/transport access.
const assert=require('node:assert/strict');
const G=require('../tools/graph-install/deploy.cjs'),D=require('../tools/maintenance-tx-deploy/deploy.cjs');
const F=require('./journey-graph-install-fixture.cjs');
const NONCE='30000000-0000-4000-8000-000000000001';
const metadata=async db=>(await db.query(D.METADATA_SQL)).rows[0];
async function setup(t,options={}){
 const x=await F.installBase(t,options);
 // Existing invoker dependencies, present before graph installation is sealed.
 await x.db.exec(`
 CREATE FUNCTION public.shrigma_email_claim_fish(b jsonb,is_test boolean DEFAULT false) RETURNS TABLE(should_send boolean,dispatch_id uuid,claim_token uuid,payload jsonb,reason text) LANGUAGE sql AS $$SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,'fixture_unused'::text$$;
 CREATE FUNCTION public.shrigma_email_claim_aristo(b jsonb,is_test boolean DEFAULT false) RETURNS TABLE(should_send boolean,dispatch_id uuid,claim_token uuid,payload jsonb,reason text) LANGUAGE sql AS $$SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,'fixture_unused'::text$$;
 CREATE FUNCTION public.shrigma_flow_slot_wa_versioned_v1(text,text,text,text,text,text,text) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"_managed":false}'::jsonb$$;
 CREATE FUNCTION public.shrigma_email_finish_fish(p_id uuid,p_claim uuid,outcome text,b jsonb) RETURNS TABLE(dispatch_id uuid,transport_state text,send_log_id bigint,error_code text) LANGUAGE sql AS $$SELECT p_id,outcome,42::bigint,NULL::text$$;
 CREATE FUNCTION public.shrigma_email_finish_aristo(p_id uuid,p_claim uuid,outcome text,b jsonb) RETURNS TABLE(dispatch_id uuid,transport_state text,send_log_id bigint,error_code text) LANGUAGE sql AS $$SELECT p_id,outcome,42::bigint,NULL::text$$;
 CREATE FUNCTION public.shrigma_email_transport_outcome(r jsonb) RETURNS text LANGUAGE sql AS $$SELECT CASE WHEN r->>'statusCode'='200' THEN 'accepted' ELSE 'outcome_unknown' END$$;`);
 const graphBefore=(await x.query(G.METADATA_SQL)).rows[0];
 await x.db.exec(G.atomicInstall(F.ROOT,graphBefore,F.NONCE).sql);
 return {...x,before:await metadata(x.db),control:(await x.query(D.STATE_SQL)).rows[0].control};
}
function migration(x){return D.atomicInstall(F.ROOT,x.before,x.control,NONCE);}
async function composition(x){
 const rows=await F.rowSnapshot(x.db),m=migration(x),original=JSON.parse(x.before.graph_seal);
 const marker="EXECUTE format('COMMENT ON SCHEMA crm_graph_candidate IS %L',next_graph_seal::text);";
 assert.ok(m.sql.includes(marker));
 await assert.rejects(x.db.exec(m.sql.replace(marker,'PERFORM missing_tx_graph_fixture();\n'+marker)),/missing_tx_graph_fixture/);
 assert.deepEqual(await metadata(x.db),x.before);assert.deepEqual(await F.rowSnapshot(x.db),rows);
 assert.equal((await x.query('SELECT 1 ok')).rows[0].ok,1);
 await x.db.exec(m.sql);
 const after=await metadata(x.db),ms=JSON.parse(after.seal),gs=JSON.parse(after.graph_seal);
 assert.deepEqual(ms,{...m.seal,shape:after.shape});
 assert.deepEqual(gs,{...original,maintenance_shape:after.graph_maintenance_shape,maintenance_extension:m.graph.extension});
 assert.notEqual(after.graph_maintenance_shape,x.before.graph_maintenance_shape);
 for(const k of ['graph_shape','graph_public_shape','graph_worker_role'])assert.deepEqual(after[k],x.before[k]);
 assert.deepEqual(await F.rowSnapshot(x.db),rows);assert.deepEqual(after.dependencies,x.before.dependencies);
 assert.throws(()=>D.previousSeal(after),/OLD_SEAL/);
 await assert.rejects(x.db.exec(m.sql),/OLD_SEAL_DRIFT/);assert.equal((await x.query('SELECT 2 ok')).rows[0].ok,2);
 assert.deepEqual(await metadata(x.db),after);
 for(const brand of ['fish','aristo']){
  const grant=await x.claim(brand);assert.equal(grant.should_send,true);
  const repeated=await x.claim(brand);assert.equal(repeated.should_send,false);assert.equal(repeated.dispatch_id,grant.dispatch_id);
  const finish=await x.finish(grant);assert.equal(finish.transport_state,'accepted');assert.equal((await x.finish(grant)).send_log_id,finish.send_log_id);
 }
 assert.equal((await x.query('SELECT enabled FROM crm_graph_candidate.control')).rows[0].enabled,false);
 assert.deepEqual((await x.query(G.OFF_SQL)).rows[0],{cart_off:true,epochs:'0',owners:'0',sources:'0',clones:'0'});
 return {m,after};
}
module.exports={setup,migration,composition,metadata,NONCE,ROOT:F.ROOT,rowSnapshot:F.rowSnapshot};
