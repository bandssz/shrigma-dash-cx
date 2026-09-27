-- Incremental TX only. No public route/grants, no transport or activation.
BEGIN;
DO $guard$ BEGIN
 IF to_regprocedure('crm_maintenance_candidate.claim_v1(uuid)') IS NULL OR to_regprocedure('public.shrigma_email_finish_fish(uuid,uuid,text,jsonb)') IS NULL OR to_regprocedure('public.shrigma_email_finish_aristo(uuid,uuid,text,jsonb)') IS NULL OR to_regprocedure('public.shrigma_email_transport_outcome(jsonb)') IS NULL THEN RAISE EXCEPTION 'MAINTENANCE_TX_DEPENDENCY';END IF;
END $guard$;
CREATE TABLE crm_maintenance_candidate.tx_inbox(event_id uuid PRIMARY KEY REFERENCES crm_maintenance_candidate.event(id));
CREATE TRIGGER maintenance_tx_inbox_immutable BEFORE UPDATE OR DELETE ON crm_maintenance_candidate.tx_inbox FOR EACH ROW EXECUTE FUNCTION crm_maintenance_candidate.immutable_v1();
CREATE SEQUENCE crm_maintenance_candidate.tx_turn;
CREATE TABLE crm_maintenance_candidate.tx_attempt(event_id uuid PRIMARY KEY REFERENCES crm_maintenance_candidate.event(id),last_turn bigint NOT NULL DEFAULT nextval('crm_maintenance_candidate.tx_turn'),last_attempt_at timestamptz NOT NULL,attempts integer NOT NULL CHECK(attempts>0));
CREATE INDEX maintenance_tx_fairness ON crm_maintenance_candidate.tx_attempt(last_turn,event_id);
CREATE FUNCTION crm_maintenance_candidate.tx_admit_v1(brand text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE k text;v jsonb;item jsonb;expected integer;receipt jsonb;
BEGIN
 IF brand IS NULL OR brand NOT IN('fish','aristo') OR jsonb_typeof(b) IS DISTINCT FROM 'object' OR octet_length(b::text)>131072 THEN RAISE EXCEPTION 'MAINTENANCE_TX_BODY';END IF;
 FOR k,v IN SELECT * FROM jsonb_each(b) LOOP
  IF k IN('email','name','from_email','reply_to','subject') AND (b->>k)~E'[\r\n]' THEN RAISE EXCEPTION 'MAINTENANCE_TX_HEADER';END IF;
  IF NOT k=ANY(ARRAY['email','name','from_email','reply_to','subject','template_id','order_id','event_type','address','cancel_reason','carrier','checkout_url','coupon_code','coupon_heading','coupon_text','coupon_value','cta_text','delivered_at','delivered_by','delivery_estimate','e','first_name','nome','brand','brand_name','store_url','shop_url','has_discount','headline','items','items_count','last_update','nps_url','order_number','order_url','p','paragraph_1','paragraph_2','paragraph_3','paragraph_4','payment_deadline','payment_method','preheader','refund_method','refund_status','review_url','s','shipping_label','shipping_name','shipping_value','status','subtotal','total','tracking_company','tracking_number','tracking_status','tracking_updated_at','tracking_url','urgency_text','urgency_title']) THEN RAISE EXCEPTION 'MAINTENANCE_TX_FIELD';END IF;
  IF k='items' THEN
   IF jsonb_typeof(v) IS DISTINCT FROM 'array' OR jsonb_array_length(v)>200 THEN RAISE EXCEPTION 'MAINTENANCE_TX_ITEMS';END IF;
   FOR item IN SELECT * FROM jsonb_array_elements(v) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_each(item) x WHERE x.key<>ALL(ARRAY['image','name','price','qty','quantity','title','variant']) OR jsonb_typeof(x.value) NOT IN('string','number','boolean','null') OR octet_length(x.value::text)>65538) THEN RAISE EXCEPTION 'MAINTENANCE_TX_ITEMS';END IF;
   END LOOP;
  ELSIF jsonb_typeof(v) NOT IN('string','number','boolean','null') OR octet_length(v::text)>65538 THEN RAISE EXCEPTION 'MAINTENANCE_TX_FIELD';END IF;
 END LOOP;
 expected:=CASE brand WHEN 'fish' THEN CASE b->>'event_type' WHEN 'recebido' THEN 6 WHEN 'confirmado' THEN 5 WHEN 'preparando' THEN 12 WHEN 'em_rota' THEN 7 WHEN 'entregue' THEN 8 WHEN 'cancelado' THEN 9 END ELSE CASE b->>'event_type' WHEN 'recebido' THEN 14 WHEN 'confirmado' THEN 15 WHEN 'preparando' THEN 17 WHEN 'em_rota' THEN 18 WHEN 'entregue' THEN 20 WHEN 'cancelado' THEN 16 END END;
 IF expected IS NULL OR coalesce(b->>'template_id','')!~'^[0-9]+$' OR (b->>'template_id')::integer<>expected OR coalesce(b->>'from_email','') !~* (CASE brand WHEN 'fish' THEN '(^|<)[^<>[:space:]@]+@fishermans\.com\.br>?$' ELSE '(^|<)[^<>[:space:]@]+@oaristocrata\.com>?$' END) THEN RAISE EXCEPTION 'MAINTENANCE_TX_SCOPE';END IF;
 IF jsonb_typeof(b->'email') IS DISTINCT FROM 'string' OR b->>'email'<>lower(b->>'email') OR coalesce(b->>'email','')!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR length(b->>'email')>320 OR jsonb_typeof(b->'subject') IS DISTINCT FROM 'string' OR coalesce(b->>'subject','')='' OR length(b->>'subject')>1000 THEN RAISE EXCEPTION 'MAINTENANCE_TX_IDENTITY';END IF;
 receipt:=crm_maintenance_candidate.admit_v1(brand,'transactional',b);
 INSERT INTO crm_maintenance_candidate.tx_inbox(event_id) VALUES((receipt->>'event_id')::uuid) ON CONFLICT DO NOTHING;
 RETURN receipt;
END $$;

-- Selection grants no transport. Missing subscribers may be prepared by the
-- original insert-only API; a fresh SQL check is mandatory before original claim.
CREATE FUNCTION crm_maintenance_candidate.tx_next_v1(brand text)
RETURNS TABLE(event_id uuid,body jsonb,subscriber_needed boolean)
LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE c crm_maintenance_candidate.control%ROWTYPE;e crm_maintenance_candidate.event%ROWTYPE;
BEGIN
 IF brand IS NULL OR brand NOT IN('fish','aristo') THEN RAISE EXCEPTION 'MAINTENANCE_TX_SCOPE';END IF;
 SELECT * INTO STRICT c FROM crm_maintenance_candidate.control WHERE singleton FOR SHARE;
 IF NOT c.enabled OR c.mode<>'open' THEN RETURN;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('maintenance-tx-turn:'||brand,0));
 SELECT x.* INTO e FROM crm_maintenance_candidate.event x JOIN crm_maintenance_candidate.tx_inbox i ON i.event_id=x.id LEFT JOIN crm_maintenance_candidate.tx_attempt a ON a.event_id=x.id
 WHERE x.brand=tx_next_v1.brand AND x.kind='transactional' AND x.flow='transacional' AND x.state='queued' AND (a.last_attempt_at IS NULL OR a.last_attempt_at<clock_timestamp()-interval '30 seconds')
 ORDER BY a.last_turn ASC NULLS FIRST,x.received_at,x.id LIMIT 1 FOR UPDATE OF x SKIP LOCKED;
 IF NOT FOUND THEN RETURN;END IF;
 INSERT INTO crm_maintenance_candidate.tx_attempt(event_id,last_attempt_at,attempts) VALUES(e.id,clock_timestamp(),1)
 ON CONFLICT ON CONSTRAINT tx_attempt_pkey DO UPDATE SET last_turn=EXCLUDED.last_turn,last_attempt_at=EXCLUDED.last_attempt_at,attempts=crm_maintenance_candidate.tx_attempt.attempts+1;
 RETURN QUERY SELECT e.id,e.payload,NOT EXISTS(SELECT 1 FROM public.subscribers s WHERE lower(s.email)=e.payload->>'email');
END $$;

CREATE FUNCTION crm_maintenance_candidate.tx_claim_v1(eid uuid)
RETURNS TABLE(should_send boolean,event_id uuid,dispatch_id uuid,claim_token uuid,payload jsonb,context jsonb,reason text)
LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE c crm_maintenance_candidate.control%ROWTYPE;e crm_maintenance_candidate.event%ROWTYPE;r record;s record;matches integer:=0;blocked boolean:=false;related boolean:=false;ls record;
BEGIN
 SELECT * INTO STRICT c FROM crm_maintenance_candidate.control WHERE singleton FOR SHARE;
 SELECT * INTO STRICT e FROM crm_maintenance_candidate.event WHERE id=eid FOR UPDATE;
 IF e.kind<>'transactional' OR e.flow<>'transacional' OR e.brand NOT IN('fish','aristo') OR NOT EXISTS(SELECT 1 FROM crm_maintenance_candidate.tx_inbox i WHERE i.event_id=e.id) THEN RAISE EXCEPTION 'MAINTENANCE_TX_SCOPE';END IF;
 IF e.state<>'queued' OR NOT c.enabled OR c.mode<>'open' THEN RETURN QUERY SELECT * FROM crm_maintenance_candidate.claim_v1(eid);RETURN;END IF;
 FOR s IN SELECT x.id,x.status FROM public.subscribers x WHERE lower(x.email)=e.payload->>'email' ORDER BY x.id FOR SHARE LOOP
  matches:=matches+1;blocked:=blocked OR s.status IS DISTINCT FROM 'enabled';
  FOR ls IN SELECT l.status FROM public.subscriber_lists l WHERE l.subscriber_id=s.id AND l.list_id=ANY(CASE e.brand WHEN 'fish' THEN ARRAY[3,17] ELSE ARRAY[7,16] END) ORDER BY l.list_id FOR SHARE LOOP
   related:=true;blocked:=blocked OR ls.status='unsubscribed';
  END LOOP;
 END LOOP;
 IF matches=0 THEN UPDATE crm_maintenance_candidate.event SET reason='subscriber_pending' WHERE id=e.id;RETURN QUERY SELECT false,e.id,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'retained_subscriber_pending';RETURN;END IF;
 IF matches<>1 OR blocked OR NOT related THEN
  UPDATE crm_maintenance_candidate.event SET state='review_required',reason=CASE WHEN matches<>1 THEN 'subscriber_ambiguous' WHEN blocked THEN 'optout' ELSE 'brand_membership_missing' END WHERE id=e.id;
  RETURN QUERY SELECT false,e.id,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'review_required';RETURN;
 END IF;
 BEGIN
  SELECT * INTO STRICT r FROM crm_maintenance_candidate.claim_v1(eid);
  RETURN QUERY SELECT r.should_send,r.event_id,r.dispatch_id,r.claim_token,r.payload,r.context,r.reason;
 EXCEPTION WHEN OTHERS THEN
  UPDATE crm_maintenance_candidate.event SET state='review_required',reason='tx_claim_failed' WHERE id=e.id;
  RETURN QUERY SELECT false,e.id,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'review_required';
 END;
END $$;

CREATE FUNCTION crm_maintenance_candidate.tx_finish_v1(p_id uuid,p_claim uuid,response jsonb,b jsonb)
RETURNS TABLE(dispatch_id uuid,transport_state text,send_log_id bigint,error_code text)
LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE e crm_maintenance_candidate.event%ROWTYPE;r record;receipt jsonb;outcome text;
BEGIN
 SELECT * INTO STRICT e FROM crm_maintenance_candidate.event x WHERE x.dispatch_id=p_id FOR UPDATE;
 IF e.kind<>'transactional' OR e.flow<>'transacional' OR e.brand NOT IN('fish','aristo') OR NOT EXISTS(SELECT 1 FROM crm_maintenance_candidate.tx_inbox i WHERE i.event_id=e.id) THEN RAISE EXCEPTION 'MAINTENANCE_TX_SCOPE';END IF;
 outcome:=public.shrigma_email_transport_outcome(response);
 IF e.brand='fish' THEN SELECT * INTO STRICT r FROM public.shrigma_email_finish_fish(p_id,p_claim,outcome,b);
 ELSE SELECT * INTO STRICT r FROM public.shrigma_email_finish_aristo(p_id,p_claim,outcome,b);END IF;
 IF r.dispatch_id IS DISTINCT FROM p_id THEN RAISE EXCEPTION 'MAINTENANCE_TX_FINISH_IDENTITY';END IF;
 receipt:=crm_maintenance_candidate.reconcile_v1(e.id);
 IF receipt->>'dispatch_id' IS DISTINCT FROM p_id::text OR receipt->>'state' IS DISTINCT FROM r.transport_state THEN RAISE EXCEPTION 'MAINTENANCE_TX_FINISH_STATE';END IF;
 RETURN QUERY SELECT r.dispatch_id,r.transport_state,r.send_log_id,r.error_code;
END $$;
REVOKE ALL ON crm_maintenance_candidate.tx_inbox,crm_maintenance_candidate.tx_attempt FROM PUBLIC;
REVOKE ALL ON SEQUENCE crm_maintenance_candidate.tx_turn FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_maintenance_candidate.tx_admit_v1(text,jsonb),crm_maintenance_candidate.tx_next_v1(text),crm_maintenance_candidate.tx_claim_v1(uuid),crm_maintenance_candidate.tx_finish_v1(uuid,uuid,jsonb,jsonb) FROM PUBLIC;
COMMIT;
