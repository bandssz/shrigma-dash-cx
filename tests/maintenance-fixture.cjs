'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const store=fs.readFileSync(path.join(__dirname,'../n8n/growth/maintenance-retention.sql'),'utf8');
// Synthetic originals: prove retention mechanics, not production eligibility policy.
const fixtureSQL=`
CREATE TABLE public.shrigma_email_dispatch(dispatch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand text,flow text,piece text,dedupe_key text,is_test boolean NOT NULL DEFAULT false,transport_state text NOT NULL DEFAULT 'in_flight',claim_token uuid NOT NULL DEFAULT gen_random_uuid(),UNIQUE(brand,flow,piece,dedupe_key));
CREATE TABLE public.maintenance_fixture_policy(singleton boolean PRIMARY KEY DEFAULT true,paused boolean DEFAULT false,optout boolean DEFAULT false,bad_token boolean DEFAULT false,crash boolean DEFAULT false,refusal text,delay_seconds numeric DEFAULT 0);
INSERT INTO public.maintenance_fixture_policy DEFAULT VALUES;
CREATE FUNCTION public.maintenance_fixture_claim(brand text,kind text,b jsonb)
RETURNS TABLE(should_send boolean,dispatch_id uuid,claim_token uuid,payload jsonb,context jsonb,reason text) LANGUAGE plpgsql AS $$
DECLARE f text;p text;k text;r text;d public.shrigma_email_dispatch%ROWTYPE;pol public.maintenance_fixture_policy%ROWTYPE;
BEGIN
 SELECT * INTO pol FROM public.maintenance_fixture_policy;
 IF pol.refusal IS NOT NULL THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,pol.refusal;RETURN;END IF;
 IF pol.paused THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'flow_paused';RETURN;END IF;
 IF pol.optout THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'optout';RETURN;END IF;
 IF kind='cart' THEN
  r:=to_char((b->>'ref')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  f:='carrinho';p:=b->>'piece';k:=jsonb_build_array('email',r,(b->>'subscriber_id')::integer,false)::text;
 ELSIF kind='transactional' THEN f:='transacional';p:='pedido-'||(b->>'event_type');k:=jsonb_build_array('email',b->>'order_id',0,false)::text;
 ELSE f:='popup';p:='cupom-boas-vindas';k:=jsonb_build_array('email',b->>'ref',lower(b->>'email'),false)::text;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('synthetic-original:'||brand||f||p||k,0));
 SELECT * INTO d FROM public.shrigma_email_dispatch x WHERE x.brand=maintenance_fixture_claim.brand AND x.flow=f AND x.piece=p AND x.dedupe_key=k;
 IF FOUND THEN RETURN QUERY SELECT false,d.dispatch_id,NULL::uuid,NULL::jsonb,NULL::jsonb,'existing_dispatch';RETURN;END IF;
 INSERT INTO public.shrigma_email_dispatch(brand,flow,piece,dedupe_key) VALUES(brand,f,p,k) RETURNING * INTO d;
 PERFORM pg_sleep(pol.delay_seconds::double precision);
 IF pol.crash THEN RAISE EXCEPTION 'synthetic original failure';END IF;
 RETURN QUERY SELECT true,d.dispatch_id,CASE WHEN pol.bad_token THEN gen_random_uuid() ELSE d.claim_token END,b,jsonb_build_object('brand',brand),'claimed';
END $$;
CREATE FUNCTION public.shrigma_email_claim_cart(b jsonb) RETURNS TABLE(should_send boolean,dispatch_id uuid,claim_token uuid,payload jsonb,context jsonb,reason text) LANGUAGE sql AS $$ SELECT * FROM public.maintenance_fixture_claim(b->>'brand','cart',b) $$;
CREATE FUNCTION public.shrigma_flow_email_claim_tx(brand text,b jsonb) RETURNS TABLE(should_send boolean,dispatch_id uuid,claim_token uuid,payload jsonb,context jsonb,reason text) LANGUAGE sql AS $$ SELECT * FROM public.maintenance_fixture_claim(brand,'transactional',b) $$;
CREATE FUNCTION public.shrigma_email_claim_engagement(b jsonb) RETURNS TABLE(should_send boolean,dispatch_id uuid,claim_token uuid,payload jsonb,context jsonb,reason text) LANGUAGE sql AS $$ SELECT * FROM public.maintenance_fixture_claim(b->>'brand','popup',b) $$;
`;
function cart(brand='fish',overrides={}) {return {brand,subscriber_id:17,ref:new Date(Date.now()-45*60000).toISOString(),toque:'t05',piece:'carrinho-30min',chave:'cart_t05_at',tx:{subscriber_email:'synthetic@example.invalid',data:{checkout_url:'https://example.invalid/cart'}},...overrides};}
function tx(overrides={}) {return {order_id:'synthetic-'+randomUUID(),event_type:'confirmado',email:'synthetic@example.invalid',template_id:17,subject:'Synthetic',...overrides};}
function popup(brand='fish',overrides={}) {return {brand,piece:'cupom-boas-vindas',email:'synthetic@example.invalid',ref:'popup-execution:12345',tx:{template_id:19,data:{first_name:'Synthetic'}},...overrides};}
function api(db) {
 const scalar=async(q,p=[])=>(await db.query(q,p)).rows[0].value;
 return {
  admit:(brand,kind,b)=>scalar('SELECT crm_maintenance_candidate.admit_v1($1,$2,$3::jsonb) value',[brand,kind,JSON.stringify(b)]),
  claim:async id=>(await db.query('SELECT * FROM crm_maintenance_candidate.claim_v1($1)',[id])).rows[0],
  control:(version,enabled,mode,op=randomUUID())=>scalar('SELECT crm_maintenance_candidate.control_v1($1,$2,$3,$4) value',[op,version,enabled,mode]),
  reconcile:id=>scalar('SELECT crm_maintenance_candidate.reconcile_v1($1) value',[id]),
  row:async id=>(await db.query('SELECT * FROM crm_maintenance_candidate.event WHERE id=$1',[id])).rows[0]
 };
}
module.exports={fixtureSQL,store,cart,tx,popup,api};
