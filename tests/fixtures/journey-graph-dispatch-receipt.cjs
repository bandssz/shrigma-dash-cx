'use strict';
const fs=require('node:fs'),{fixture,id,faultPool}=require('./journey-graph-runtime.cjs'),{createGraphRuntime}=require('../../n8n/growth/journey-graph-runtime.cjs');
const store=fs.readFileSync(require.resolve('../../n8n/growth/journey-graph-store.sql'),'utf8'),migration=fs.readFileSync(require.resolve('../../n8n/growth/journey-graph-dispatch-receipt.sql'),'utf8');
// Minimal SQL-only trusted bridge fixture; no HTTP or native claim implementation.
const bridge=`CREATE TABLE public.shrigma_email_dispatch(dispatch_id uuid PRIMARY KEY,brand text NOT NULL,transport_state text NOT NULL CHECK(transport_state IN ('in_flight','accepted','rejected','outcome_unknown')));
CREATE TABLE crm_graph_candidate.cart_delivery_v1(intent_id uuid PRIMARY KEY REFERENCES crm_graph_candidate.intent(id),dispatch_id uuid NOT NULL UNIQUE REFERENCES public.shrigma_email_dispatch(dispatch_id));
CREATE FUNCTION crm_graph_candidate.cart_dispatch_v1(b text,iid uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE out jsonb;
BEGIN
 SELECT jsonb_build_object('contract','journey_graph_cart_dispatch_v1','brand',i.brand,'intent_id',i.id,'entry_id',e.id,'revision',e.revision,'node_id',i.node_id,'attempt_key',i.attempt_key,'dispatch_id',d.dispatch_id,'transport_state',d.transport_state)
 INTO out FROM crm_graph_candidate.intent i JOIN crm_graph_candidate.entry e ON e.id=i.entry_id AND e.brand=i.brand JOIN crm_graph_candidate.cart_delivery_v1 l ON l.intent_id=i.id JOIN public.shrigma_email_dispatch d ON d.dispatch_id=l.dispatch_id AND d.brand=i.brand WHERE i.id=iid AND i.brand=b FOR SHARE OF d;RETURN out;
END $$;`;
const readDispatch=async({query,brand,intent_id})=>(await query('SELECT crm_graph_candidate.cart_dispatch_v1($1,$2) result',[brand,intent_id])).rows[0].result;
function receiptFixture(pool,brand='fish'){
 const f=fixture(pool,brand),settings={...f.settings,readDispatch};let dispatchSequence=3000,event=0;
 const api=createGraphRuntime(settings),req=e=>f.request({entry_id:e.entry_id,expected_version:e.version,intent_id:e.intent_id});
 return {...f,settings,api,req,
  async pending(j){f.proof.event_id='synthetic-receipt-event-'+(++event);f.setTime('2026-09-25T12:00:00.000Z');const e=await f.atMessage(j);return f.step(e);},
  async bind(e,state='accepted'){
   const did=id(dispatchSequence++);await f.query('INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,transport_state) VALUES($1,$2,$3)',[did,brand,state]);await f.query('INSERT INTO crm_graph_candidate.cart_delivery_v1(intent_id,dispatch_id) VALUES($1,$2)',[e.intent_id,did]);return did;
  },
  async row(e){return (await f.query('SELECT * FROM crm_graph_candidate.entry WHERE id=$1',[e.entry_id])).rows[0];},
  async count(table){return Number((await f.query('SELECT count(*) n FROM crm_graph_candidate.'+table)).rows[0].n);}
 };
}
module.exports={store,migration,bridge,readDispatch,receiptFixture,id,faultPool};
