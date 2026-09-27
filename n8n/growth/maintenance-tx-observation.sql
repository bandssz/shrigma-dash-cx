-- Temporary aggregate input probe only. No event bodies, recipients, IDs or secrets.
-- Separate schema: this does not alter the installed CART schema or its seal.
BEGIN;
CREATE SCHEMA crm_tx_input_probe;
REVOKE ALL ON SCHEMA crm_tx_input_probe FROM PUBLIC;
CREATE TABLE crm_tx_input_probe.outcome (
 normalizer_sha256 text NOT NULL CHECK(normalizer_sha256~'^[a-f0-9]{64}$'),
 brand text NOT NULL CHECK(brand IN ('fish','aristo')),
 event_type text NOT NULL CHECK(event_type IN ('recebido','confirmado','preparando','em_rota','entregue','cancelado','other')),
 verdict text NOT NULL CHECK(verdict IN ('accepted','rejected')),
 reason text NOT NULL CHECK(reason IN ('ok','body','scope','control','items','field','identity','header','json','unconfirmed')),
 observations bigint NOT NULL CHECK(observations>0),unknown_field_observations bigint NOT NULL CHECK(unknown_field_observations>=0 AND unknown_field_observations<=observations),
 first_seen timestamptz NOT NULL,last_seen timestamptz NOT NULL,
 PRIMARY KEY(normalizer_sha256,brand,event_type,verdict,reason)
);
CREATE TABLE crm_tx_input_probe.field_type (
 normalizer_sha256 text NOT NULL,brand text NOT NULL,event_type text NOT NULL,verdict text NOT NULL,reason text NOT NULL,
 stage text NOT NULL CHECK(stage IN ('input','normalized')),path text NOT NULL,type text NOT NULL CHECK(type IN ('string','number','boolean','null','object','array')),
 observations bigint NOT NULL CHECK(observations>0),
 PRIMARY KEY(normalizer_sha256,brand,event_type,verdict,reason,stage,path,type),
 FOREIGN KEY(normalizer_sha256,brand,event_type,verdict,reason) REFERENCES crm_tx_input_probe.outcome
);
CREATE FUNCTION crm_tx_input_probe.record_v1(p jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog SET lock_timeout='250ms' AS $probe$
DECLARE f jsonb;seen timestamptz:=clock_timestamp();
 allowed text[]:=ARRAY['email','name','from_email','reply_to','subject','template_id','order_id','event_type','address','cancel_reason','carrier','checkout_url','coupon_code','coupon_heading','coupon_text','coupon_value','cta_text','delivered_at','delivered_by','delivery_estimate','e','first_name','nome','brand','brand_name','store_url','shop_url','has_discount','headline','items','items_count','last_update','nps_url','order_number','order_url','p','paragraph_1','paragraph_2','paragraph_3','paragraph_4','payment_deadline','payment_method','preheader','refund_method','refund_status','review_url','s','shipping_label','shipping_name','shipping_value','status','subtotal','total','tracking_company','tracking_number','tracking_status','tracking_updated_at','tracking_url','urgency_text','urgency_title','items[].image','items[].name','items[].price','items[].qty','items[].quantity','items[].title','items[].variant'];
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>32768
 OR p-ARRAY['contract','normalizer_sha256','brand','event_type','verdict','reason','unknown_fields','fields']<>'{}'::jsonb
 OR (SELECT count(*) FROM jsonb_object_keys(p))<>8
 OR p->>'contract' IS DISTINCT FROM 'maintenance_tx_input_probe_v1'
 OR coalesce(p->>'normalizer_sha256','')!~'^[a-f0-9]{64}$'
 OR coalesce(p->>'brand','') NOT IN ('fish','aristo')
 OR coalesce(p->>'event_type','') NOT IN ('recebido','confirmado','preparando','em_rota','entregue','cancelado','other')
 OR coalesce(p->>'verdict','') NOT IN ('accepted','rejected')
 OR coalesce(p->>'reason','') NOT IN ('ok','body','scope','control','items','field','identity','header','json','unconfirmed')
 OR (p->>'verdict'='accepted') IS DISTINCT FROM (p->>'reason'='ok')
 OR (p->>'verdict'='accepted' AND p->>'event_type'='other')
 OR jsonb_typeof(p->'unknown_fields') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(p->'fields') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'TX_PROBE_INPUT';END IF;
 IF jsonb_array_length(p->'fields')>256 OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(p->'fields') x)<>jsonb_array_length(p->'fields') THEN RAISE EXCEPTION 'TX_PROBE_INPUT';END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(p->'fields') LOOP
  IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR f-ARRAY['stage','path','type']<>'{}'::jsonb OR (SELECT count(*) FROM jsonb_object_keys(f))<>3
  OR coalesce(f->>'stage','') NOT IN ('input','normalized') OR NOT coalesce(f->>'path','')=ANY(allowed)
  OR coalesce(f->>'type','') NOT IN ('string','number','boolean','null','object','array')
  OR (p->>'verdict'='rejected' AND f->>'stage'='normalized') THEN RAISE EXCEPTION 'TX_PROBE_INPUT';END IF;
 END LOOP;
 INSERT INTO crm_tx_input_probe.outcome(normalizer_sha256,brand,event_type,verdict,reason,observations,unknown_field_observations,first_seen,last_seen)
 VALUES(p->>'normalizer_sha256',p->>'brand',p->>'event_type',p->>'verdict',p->>'reason',1,CASE WHEN (p->>'unknown_fields')::boolean THEN 1 ELSE 0 END,seen,seen)
 ON CONFLICT(normalizer_sha256,brand,event_type,verdict,reason) DO UPDATE
 SET observations=crm_tx_input_probe.outcome.observations+1,unknown_field_observations=crm_tx_input_probe.outcome.unknown_field_observations+EXCLUDED.unknown_field_observations,last_seen=greatest(crm_tx_input_probe.outcome.last_seen,EXCLUDED.last_seen);
 -- A field/type is counted once per observation, not once per item/customer.
 FOR f IN SELECT value FROM jsonb_array_elements(p->'fields') ORDER BY value->>'stage',value->>'path',value->>'type' LOOP
  INSERT INTO crm_tx_input_probe.field_type(normalizer_sha256,brand,event_type,verdict,reason,stage,path,type,observations)
  VALUES(p->>'normalizer_sha256',p->>'brand',p->>'event_type',p->>'verdict',p->>'reason',f->>'stage',f->>'path',f->>'type',1)
  ON CONFLICT(normalizer_sha256,brand,event_type,verdict,reason,stage,path,type) DO UPDATE SET observations=crm_tx_input_probe.field_type.observations+1;
 END LOOP;
 RETURN true;
END $probe$;
REVOKE ALL ON crm_tx_input_probe.outcome,crm_tx_input_probe.field_type FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_tx_input_probe.record_v1(jsonb) FROM PUBLIC;
COMMIT;
