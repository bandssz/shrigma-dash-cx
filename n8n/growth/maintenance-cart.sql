-- Incremental CART integration candidate. No grants, transport, activation or producer edits.
BEGIN;
DO $guard$ BEGIN
 IF to_regprocedure('crm_maintenance_candidate.claim_v1(uuid)') IS NULL
 OR pg_get_function_result('crm_maintenance_candidate.claim_v1(uuid)'::regprocedure) IS DISTINCT FROM 'TABLE(should_send boolean, event_id uuid, dispatch_id uuid, claim_token uuid, payload jsonb, context jsonb, reason text)'
 THEN RAISE EXCEPTION 'MAINTENANCE_CART_BASE_CONTRACT';END IF;
 IF to_regprocedure('public.shrigma_email_finish_cart(uuid,uuid,text,jsonb)') IS NULL OR pg_get_function_result(to_regprocedure('public.shrigma_email_finish_cart(uuid,uuid,text,jsonb)')) IS DISTINCT FROM 'TABLE(dispatch_id uuid, transport_state text, send_log_id bigint, error_code text)' THEN RAISE EXCEPTION 'MAINTENANCE_CART_FINISH_CONTRACT';END IF;
END $guard$;
CREATE SEQUENCE crm_maintenance_candidate.cart_turn;
CREATE TABLE crm_maintenance_candidate.cart_attempt(
 event_id uuid PRIMARY KEY REFERENCES crm_maintenance_candidate.event(id),
 last_turn bigint NOT NULL DEFAULT nextval('crm_maintenance_candidate.cart_turn'),last_attempt_at timestamptz NOT NULL,attempts integer NOT NULL CHECK(attempts>0)
);
CREATE INDEX maintenance_cart_fairness ON crm_maintenance_candidate.cart_attempt(last_turn,event_id);

-- Used only inside the existing selector before LIMIT: retained rows must not
-- monopolize its first 500 positions during a closed maintenance window.
CREATE FUNCTION crm_maintenance_candidate.cart_known_v1(brand text,toque text,subscriber_id integer,ref timestamptz)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE v_piece text;canon text;
BEGIN
 IF brand IS NULL OR brand NOT IN('fish','aristo') THEN RETURN false;END IF;
 v_piece:='carrinho-'||CASE toque WHEN 't05' THEN '30min' WHEN 't1' THEN '1h' WHEN 't2' THEN '2h' WHEN 't24' THEN '24h' WHEN 't48' THEN '48h' END;
 IF v_piece IS NULL OR subscriber_id IS NULL OR subscriber_id<=0 OR ref IS NULL THEN RAISE EXCEPTION 'MAINTENANCE_CART_IDENTITY';END IF;
 canon:=to_char(ref AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 RETURN EXISTS(SELECT 1 FROM crm_maintenance_candidate.event e WHERE e.brand=cart_known_v1.brand AND e.kind='cart' AND e.flow='carrinho' AND e.piece=v_piece AND e.dedupe_key=jsonb_build_array('email',canon,subscriber_id,false)::text);
END $$;

-- Takes the same gate before the event row as claim_v1. Any original SQL error
-- rolls back that claim's effects, then blocks this retained event for review.
CREATE FUNCTION crm_maintenance_candidate.cart_attempt_v1(eid uuid)
RETURNS TABLE(should_send boolean,event_id uuid,dispatch_id uuid,claim_token uuid,payload jsonb,context jsonb,reason text)
LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE e crm_maintenance_candidate.event%ROWTYPE;c crm_maintenance_candidate.control%ROWTYPE;r record;
BEGIN
 SELECT * INTO STRICT c FROM crm_maintenance_candidate.control WHERE singleton FOR SHARE;
 SELECT * INTO STRICT e FROM crm_maintenance_candidate.event WHERE id=eid FOR UPDATE;
 IF e.kind<>'cart' OR e.brand NOT IN('fish','aristo') OR e.flow<>'carrinho' THEN RAISE EXCEPTION 'MAINTENANCE_CART_SCOPE';END IF;
 IF e.state='queued' AND c.enabled AND c.mode='open' THEN
  INSERT INTO crm_maintenance_candidate.cart_attempt(event_id,last_attempt_at,attempts) VALUES(e.id,clock_timestamp(),1)
  ON CONFLICT ON CONSTRAINT cart_attempt_pkey DO UPDATE SET last_turn=EXCLUDED.last_turn,last_attempt_at=EXCLUDED.last_attempt_at,attempts=crm_maintenance_candidate.cart_attempt.attempts+1;
 END IF;
 BEGIN
  SELECT * INTO STRICT r FROM crm_maintenance_candidate.claim_v1(e.id);
  RETURN QUERY SELECT r.should_send,r.event_id,r.dispatch_id,r.claim_token,r.payload,r.context,r.reason;
 EXCEPTION WHEN OTHERS THEN
  -- No external effect is performed by any wrapped claim. Transaction failure
  -- cannot release a transport token; never record the raw exception/payload.
  IF e.state<>'queued' THEN RAISE;END IF;
  UPDATE crm_maintenance_candidate.event SET state='review_required',reason='cart_claim_failed' WHERE id=e.id;
  RETURN QUERY SELECT false,e.id,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'review_required';
 END;
END $$;

CREATE FUNCTION crm_maintenance_candidate.cart_admit_claim_v1(b jsonb)
RETURNS TABLE(should_send boolean,event_id uuid,dispatch_id uuid,claim_token uuid,payload jsonb,context jsonb,reason text)
LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE receipt jsonb;
BEGIN
 receipt:=crm_maintenance_candidate.admit_v1(b->>'brand','cart',b);
 RETURN QUERY SELECT * FROM crm_maintenance_candidate.cart_attempt_v1((receipt->>'event_id')::uuid);
END $$;

-- One original claim per SQL transaction, avoiding multi-subscriber lock cycles.
-- Least recently tried entries rotate; a paused first page cannot hide later ones.
CREATE FUNCTION crm_maintenance_candidate.cart_next_v1(brand text)
RETURNS TABLE(should_send boolean,event_id uuid,dispatch_id uuid,claim_token uuid,payload jsonb,context jsonb,reason text)
LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE c crm_maintenance_candidate.control%ROWTYPE;eid uuid;
BEGIN
 IF brand IS NULL OR brand NOT IN('fish','aristo') THEN RAISE EXCEPTION 'MAINTENANCE_CART_BATCH';END IF;
 SELECT * INTO STRICT c FROM crm_maintenance_candidate.control WHERE singleton FOR SHARE;
 IF NOT c.enabled OR c.mode<>'open' THEN RETURN;END IF;
 SELECT e.id INTO eid FROM crm_maintenance_candidate.event e
 LEFT JOIN crm_maintenance_candidate.cart_attempt a ON a.event_id=e.id
 WHERE e.kind='cart' AND e.flow='carrinho' AND e.brand=cart_next_v1.brand AND e.state='queued'
 ORDER BY a.last_turn ASC NULLS FIRST,e.received_at,e.id
 LIMIT 1 FOR UPDATE OF e SKIP LOCKED;
 IF NOT FOUND THEN RETURN;END IF;
 RETURN QUERY SELECT * FROM crm_maintenance_candidate.cart_attempt_v1(eid);
END $$;
-- Same native return/context; event is locked before dispatch, consistently with
-- reconcile. A failed reconciliation rolls back SQL finish effects, never HTTP.
CREATE FUNCTION crm_maintenance_candidate.cart_finish_v1(p_id uuid,p_claim uuid,p_outcome text,b jsonb)
RETURNS TABLE(dispatch_id uuid,transport_state text,send_log_id bigint,error_code text)
LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE e crm_maintenance_candidate.event%ROWTYPE;r record;receipt jsonb;
BEGIN
 SELECT * INTO STRICT e FROM crm_maintenance_candidate.event x WHERE x.dispatch_id=p_id FOR UPDATE;
 IF e.kind<>'cart' OR e.flow<>'carrinho' OR e.brand NOT IN('fish','aristo') OR e.brand IS DISTINCT FROM b->>'brand' THEN RAISE EXCEPTION 'MAINTENANCE_CART_SCOPE';END IF;
 SELECT * INTO STRICT r FROM public.shrigma_email_finish_cart(p_id,p_claim,p_outcome,b);
 IF r.dispatch_id IS DISTINCT FROM p_id THEN RAISE EXCEPTION 'MAINTENANCE_CART_FINISH_IDENTITY';END IF;
 receipt:=crm_maintenance_candidate.reconcile_v1(e.id);
 IF receipt->>'dispatch_id' IS DISTINCT FROM p_id::text OR receipt->>'state' IS DISTINCT FROM r.transport_state THEN RAISE EXCEPTION 'MAINTENANCE_CART_FINISH_STATE';END IF;
 RETURN QUERY SELECT r.dispatch_id,r.transport_state,r.send_log_id,r.error_code;
END $$;
REVOKE ALL ON crm_maintenance_candidate.cart_attempt FROM PUBLIC;
REVOKE ALL ON SEQUENCE crm_maintenance_candidate.cart_turn FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_maintenance_candidate.cart_known_v1(text,text,integer,timestamptz),crm_maintenance_candidate.cart_attempt_v1(uuid),crm_maintenance_candidate.cart_admit_claim_v1(jsonb),crm_maintenance_candidate.cart_next_v1(text),crm_maintenance_candidate.cart_finish_v1(uuid,uuid,text,jsonb) FROM PUBLIC;
COMMIT;
