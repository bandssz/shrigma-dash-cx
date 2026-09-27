-- Candidate ONLY: no HTTP, schedules, existing producer changes or public grants.
-- Install once in an isolated/reviewed database; default closed + disabled.
BEGIN;
DO $dependency$
DECLARE signature text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.shrigma_email_claim_cart(jsonb)','public.shrigma_flow_email_claim_tx(text,jsonb)','public.shrigma_email_claim_engagement(jsonb)'] LOOP
  IF to_regprocedure(signature) IS NULL OR pg_get_function_result(to_regprocedure(signature)) IS DISTINCT FROM 'TABLE(should_send boolean, dispatch_id uuid, claim_token uuid, payload jsonb, context jsonb, reason text)' THEN
   RAISE EXCEPTION 'MAINTENANCE_DEPENDENCY_CONTRACT';
  END IF;
 END LOOP;
END $dependency$;
CREATE SCHEMA crm_maintenance_candidate;
REVOKE ALL ON SCHEMA crm_maintenance_candidate FROM PUBLIC;
CREATE TABLE crm_maintenance_candidate.control(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 enabled boolean NOT NULL DEFAULT false,mode text NOT NULL DEFAULT 'closed' CHECK(mode IN('open','closed')),
 cutoff_at timestamptz,
 CHECK(enabled OR mode='closed')
);
INSERT INTO crm_maintenance_candidate.control(singleton) VALUES(true);
CREATE TABLE crm_maintenance_candidate.event(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand text NOT NULL CHECK(brand IN('fish','aristo')),
 kind text NOT NULL CHECK(kind IN('cart','transactional','popup')),flow text NOT NULL,piece text NOT NULL,
 dedupe_key text NOT NULL CHECK(octet_length(dedupe_key)<=2048),payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=131072),
 payload_hash text NOT NULL CHECK(payload_hash~'^[a-f0-9]{64}$'),received_at timestamptz NOT NULL,expires_at timestamptz,
 receipt jsonb NOT NULL,state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','claimed','accepted','rejected','outcome_unknown','review_required','expired')),
 dispatch_id uuid UNIQUE,claimed_at timestamptz,reason text,UNIQUE(brand,flow,piece,dedupe_key),
 CHECK((state IN('claimed','accepted','rejected','outcome_unknown'))=(dispatch_id IS NOT NULL)),CHECK(expires_at IS NULL OR expires_at>received_at OR state='expired')
);
CREATE INDEX maintenance_queued ON crm_maintenance_candidate.event(received_at,id) WHERE state='queued';
CREATE TABLE crm_maintenance_candidate.operation(id uuid PRIMARY KEY,request jsonb NOT NULL,response jsonb NOT NULL,at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE FUNCTION crm_maintenance_candidate.immutable_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='operation' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'MAINTENANCE_IMMUTABLE';END IF;
 IF (to_jsonb(NEW)-ARRAY['state','dispatch_id','claimed_at','reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','dispatch_id','claimed_at','reason'])
 OR (OLD.dispatch_id IS NOT NULL AND NEW.dispatch_id IS DISTINCT FROM OLD.dispatch_id)
 OR (OLD.state<>'queued' AND NEW.state='queued') THEN RAISE EXCEPTION 'MAINTENANCE_IMMUTABLE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER maintenance_event_immutable BEFORE UPDATE OR DELETE ON crm_maintenance_candidate.event FOR EACH ROW EXECUTE FUNCTION crm_maintenance_candidate.immutable_v1();
CREATE TRIGGER maintenance_operation_immutable BEFORE UPDATE OR DELETE ON crm_maintenance_candidate.operation FOR EACH ROW EXECUTE FUNCTION crm_maintenance_candidate.immutable_v1();

-- Server-normalized claim arguments only: never an HTTP request or credential bag.
CREATE FUNCTION crm_maintenance_candidate.identity_v1(brand text,kind text,b jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE ref text;piece text;flow text;key text;body jsonb:=b;original_expiry timestamptz;subscriber integer;email text;
BEGIN
 IF brand IS NULL OR brand NOT IN('fish','aristo') OR kind IS NULL OR kind NOT IN('cart','transactional','popup')
 OR jsonb_typeof(b) IS DISTINCT FROM 'object' OR octet_length(b::text)>131072
 OR b ?| ARRAY['authorization','Authorization','password','secret','api_key','access_token','claim_token','request','headers','credentials','is_test','test'] THEN RAISE EXCEPTION 'MAINTENANCE_INPUT';END IF;
 IF kind='cart' THEN
  IF b->>'brand' IS DISTINCT FROM brand OR coalesce(b->>'subscriber_id','')!~'^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'MAINTENANCE_CART_IDENTITY';END IF;
  subscriber:=(b->>'subscriber_id')::integer;
  IF coalesce(b->>'ref','')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' THEN RAISE EXCEPTION 'MAINTENANCE_CART_REF';END IF;
  ref:=to_char((b->>'ref')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  piece:='carrinho-'||CASE b->>'toque' WHEN 't05' THEN '30min' WHEN 't1' THEN '1h' WHEN 't2' THEN '2h' WHEN 't24' THEN '24h' WHEN 't48' THEN '48h' END;
  IF piece IS NULL OR b->>'piece' IS DISTINCT FROM piece OR b->>'chave' IS DISTINCT FROM 'cart_'||(b->>'toque')||'_at' THEN RAISE EXCEPTION 'MAINTENANCE_CART_STAGE';END IF;
  flow:='carrinho';key:=jsonb_build_array('email',ref,subscriber,false)::text;
  body:=jsonb_set(b-'marketing_7d','{ref}',to_jsonb(ref));
  original_expiry:=(ref::timestamptz)+make_interval(hours=>CASE b->>'toque' WHEN 't05' THEN 1 WHEN 't1' THEN 4 WHEN 't2' THEN 5 WHEN 't24' THEN 27 ELSE 51 END);
 ELSIF kind='transactional' THEN
  ref:=nullif(b->>'order_id','');
  IF ref IS NULL OR octet_length(ref)>256 OR b->>'event_type' IS NULL OR b->>'event_type' NOT IN('recebido','confirmado','preparando','enviado','em_rota','entregue','cancelado') THEN RAISE EXCEPTION 'MAINTENANCE_TX_IDENTITY';END IF;
  flow:='transacional';piece:='pedido-'||(b->>'event_type');key:=jsonb_build_array('email',ref,0,false)::text;
 ELSE
  ref:=b->>'ref';email:=lower(b->>'email');
  IF b->>'brand' IS DISTINCT FROM brand OR b->>'piece' IS DISTINCT FROM 'cupom-boas-vindas' OR coalesce(ref,'')!~'^popup-execution:[0-9]{1,30}$'
  OR email IS NULL OR email<>btrim(email) OR email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN RAISE EXCEPTION 'MAINTENANCE_POPUP_IDENTITY';END IF;
  flow:='popup';piece:='cupom-boas-vindas';key:=jsonb_build_array('email',ref,email,false)::text;
 END IF;
 RETURN jsonb_build_object('brand',brand,'kind',kind,'flow',flow,'piece',piece,'dedupe_key',key,'payload',body,'original_expiry',original_expiry);
END $$;

CREATE FUNCTION crm_maintenance_candidate.admit_v1(brand text,kind text,b jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE c crm_maintenance_candidate.control%ROWTYPE;e crm_maintenance_candidate.event%ROWTYPE;
 identity jsonb:=crm_maintenance_candidate.identity_v1(brand,kind,b);h text;t timestamptz;expiry timestamptz;receipt jsonb;
BEGIN
 -- Same lock as claim, in the same order; a close gets an exclusive row lock.
 SELECT * INTO STRICT c FROM crm_maintenance_candidate.control WHERE singleton FOR SHARE;
 PERFORM pg_advisory_xact_lock(hashtextextended('maintenance-event:'||jsonb_build_array(brand,identity->>'flow',identity->>'piece',identity->>'dedupe_key')::text,0));
 h:=encode(sha256(convert_to((identity->'payload')::text,'UTF8')),'hex');
 SELECT * INTO e FROM crm_maintenance_candidate.event x WHERE x.brand=identity->>'brand' AND x.flow=identity->>'flow' AND x.piece=identity->>'piece' AND x.dedupe_key=identity->>'dedupe_key';
 IF FOUND THEN IF e.payload_hash<>h THEN RAISE EXCEPTION 'MAINTENANCE_REPLAY_MISMATCH';END IF;RETURN e.receipt;END IF;
 t:=clock_timestamp();expiry:=(identity->>'original_expiry')::timestamptz;
 e.id:=gen_random_uuid();
 receipt:=jsonb_build_object('contract','growth-maintenance-retention-v1','event_id',e.id,'brand',brand,'flow',identity->>'flow','piece',identity->>'piece','payload_hash',h,'received_at',t,'expires_at',expiry,'persisted',true,'authorizes_send',false);
 INSERT INTO crm_maintenance_candidate.event(id,brand,kind,flow,piece,dedupe_key,payload,payload_hash,received_at,expires_at,receipt,state,reason)
 VALUES(e.id,brand,kind,identity->>'flow',identity->>'piece',identity->>'dedupe_key',identity->'payload',h,t,expiry,receipt,CASE WHEN expiry<=t THEN 'expired' ELSE 'queued' END,CASE WHEN expiry<=t THEN 'original_window_expired' ELSE NULL END);
 RETURN receipt;
END $$;

-- Administrative, server-only CAS. Replay returns the ORIGINAL cutoff/receipt.
CREATE FUNCTION crm_maintenance_candidate.control_v1(op uuid,expected integer,want_enabled boolean,want_mode text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE c crm_maintenance_candidate.control%ROWTYPE;r crm_maintenance_candidate.operation%ROWTYPE;
 p jsonb:=jsonb_build_object('expected',expected,'enabled',want_enabled,'mode',want_mode);answer jsonb;
BEGIN
 IF op IS NULL OR expected IS NULL OR expected<1 OR want_enabled IS NULL OR want_mode IS NULL OR want_mode NOT IN('open','closed') OR (NOT want_enabled AND want_mode<>'closed') THEN RAISE EXCEPTION 'MAINTENANCE_CONTROL_INPUT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('maintenance-control:'||op::text,0));
 SELECT * INTO r FROM crm_maintenance_candidate.operation WHERE id=op;
 IF FOUND THEN IF r.request<>p THEN RAISE EXCEPTION 'MAINTENANCE_REPLAY_MISMATCH';END IF;RETURN r.response;END IF;
 SELECT * INTO STRICT c FROM crm_maintenance_candidate.control WHERE singleton FOR UPDATE;
 IF c.version<>expected THEN RAISE EXCEPTION 'MAINTENANCE_VERSION_CONFLICT';END IF;
 UPDATE crm_maintenance_candidate.control SET version=version+1,enabled=want_enabled,mode=want_mode,
 cutoff_at=CASE WHEN want_mode='closed' THEN clock_timestamp() ELSE cutoff_at END WHERE singleton RETURNING * INTO c;
 answer:=jsonb_build_object('contract','growth-maintenance-control-v1','version',c.version,'enabled',c.enabled,'mode',c.mode,'cutoff_at',c.cutoff_at,'drained',false,
 'reserved_unconfirmed',(SELECT count(*) FROM crm_maintenance_candidate.event WHERE state='claimed'),'authorizes_send',false);
 INSERT INTO crm_maintenance_candidate.operation(id,request,response) VALUES(op,p,answer);RETURN answer;
END $$;

-- Only the first successful reservation returns the original transport payload/token.
-- No HTTP is performed here; a lost SQL response is fenced, never reclaimed by time.
CREATE FUNCTION crm_maintenance_candidate.claim_v1(eid uuid)
RETURNS TABLE(should_send boolean,event_id uuid,dispatch_id uuid,claim_token uuid,payload jsonb,context jsonb,reason text)
LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE c crm_maintenance_candidate.control%ROWTYPE;e crm_maintenance_candidate.event%ROWTYPE;r record;d public.shrigma_email_dispatch%ROWTYPE;window_elapsed boolean:=false;
BEGIN
 SELECT * INTO STRICT c FROM crm_maintenance_candidate.control WHERE singleton FOR SHARE;
 SELECT * INTO STRICT e FROM crm_maintenance_candidate.event WHERE id=eid FOR UPDATE;
 IF e.state<>'queued' THEN RETURN QUERY SELECT false,e.id,e.dispatch_id,NULL::uuid,NULL::jsonb,NULL::jsonb,'already_'||e.state;RETURN;END IF;
 IF NOT c.enabled OR c.mode<>'open' THEN RETURN QUERY SELECT false,e.id,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'retained';RETURN;END IF;
 IF clock_timestamp()>=e.expires_at THEN UPDATE crm_maintenance_candidate.event SET state='expired',reason='original_window_expired' WHERE id=e.id;RETURN QUERY SELECT false,e.id,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'expired';RETURN;END IF;
 BEGIN -- A deadline crossed while waiting for the original claim rolls it back.
 IF e.kind='cart' THEN SELECT * INTO r FROM public.shrigma_email_claim_cart(e.payload);
 ELSIF e.kind='transactional' THEN SELECT * INTO r FROM public.shrigma_flow_email_claim_tx(e.brand,e.payload);
 ELSE SELECT * INTO r FROM public.shrigma_email_claim_engagement(e.payload);END IF;
 IF r.should_send IS TRUE AND e.expires_at IS NOT NULL AND clock_timestamp()>=e.expires_at THEN
  window_elapsed:=true;RAISE EXCEPTION USING ERRCODE='PZ001',MESSAGE='MAINTENANCE_ORIGINAL_WINDOW_ELAPSED';
 END IF;
 IF r.dispatch_id IS NOT NULL THEN
  SELECT * INTO STRICT d FROM public.shrigma_email_dispatch WHERE shrigma_email_dispatch.dispatch_id=r.dispatch_id FOR SHARE;
  IF d.brand IS DISTINCT FROM e.brand OR d.flow IS DISTINCT FROM e.flow OR d.piece IS DISTINCT FROM e.piece OR d.dedupe_key IS DISTINCT FROM e.dedupe_key OR d.is_test IS DISTINCT FROM false
  OR d.transport_state NOT IN('in_flight','accepted','rejected','outcome_unknown') THEN RAISE EXCEPTION 'MAINTENANCE_CLAIM_IDENTITY';END IF;
  IF r.should_send IS TRUE AND (d.transport_state<>'in_flight' OR r.claim_token IS NULL OR r.claim_token IS DISTINCT FROM d.claim_token OR jsonb_typeof(r.payload) IS DISTINCT FROM 'object' OR jsonb_typeof(r.context) IS DISTINCT FROM 'object') THEN RAISE EXCEPTION 'MAINTENANCE_CLAIM_RESPONSE';END IF;
  UPDATE crm_maintenance_candidate.event SET state=CASE WHEN d.transport_state='in_flight' THEN 'claimed' ELSE d.transport_state END,dispatch_id=d.dispatch_id,claimed_at=clock_timestamp(),reason=r.reason WHERE id=e.id;
  RETURN QUERY SELECT r.should_send IS TRUE,e.id,d.dispatch_id,CASE WHEN r.should_send IS TRUE THEN r.claim_token ELSE NULL::uuid END,
   CASE WHEN r.should_send IS TRUE THEN r.payload ELSE NULL::jsonb END,CASE WHEN r.should_send IS TRUE THEN r.context ELSE NULL::jsonb END,r.reason;RETURN;
 END IF;
 IF r.should_send IS DISTINCT FROM false THEN RAISE EXCEPTION 'MAINTENANCE_CLAIM_RESPONSE';END IF;
 IF r.reason IN('flow_paused','journey_paused','not_due','cadence_or_cap_changed') THEN
  UPDATE crm_maintenance_candidate.event SET reason=r.reason WHERE id=e.id;
  RETURN QUERY SELECT false,e.id,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'retained_'||r.reason;RETURN;
 END IF;
 -- Unknown/refused inputs remain auditable and blocked; never reinterpret as sent/discarded.
 UPDATE crm_maintenance_candidate.event SET state='review_required',reason=CASE WHEN r.reason IN('subscriber_missing','subscriber_unavailable','eligibility_changed','legacy_already_accepted','optout') THEN r.reason ELSE 'unrecognized_original_refusal' END WHERE id=e.id;
 RETURN QUERY SELECT false,e.id,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'review_required';
 EXCEPTION WHEN SQLSTATE 'PZ001' THEN
  IF NOT window_elapsed THEN RAISE;END IF;
  UPDATE crm_maintenance_candidate.event SET state='expired',reason='original_window_expired' WHERE id=e.id;
  RETURN QUERY SELECT false,e.id,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'expired';
 END;
END $$;

-- Existing finish functions remain authoritative. This never calls claim or transport.
CREATE FUNCTION crm_maintenance_candidate.reconcile_v1(eid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE e crm_maintenance_candidate.event%ROWTYPE;d public.shrigma_email_dispatch%ROWTYPE;
BEGIN
 SELECT * INTO STRICT e FROM crm_maintenance_candidate.event WHERE id=eid FOR UPDATE;
 IF e.dispatch_id IS NOT NULL THEN
  SELECT * INTO STRICT d FROM public.shrigma_email_dispatch WHERE dispatch_id=e.dispatch_id FOR SHARE;
  IF d.brand IS DISTINCT FROM e.brand OR d.flow IS DISTINCT FROM e.flow OR d.piece IS DISTINCT FROM e.piece OR d.dedupe_key IS DISTINCT FROM e.dedupe_key OR d.is_test IS DISTINCT FROM false
  OR d.transport_state NOT IN('in_flight','accepted','rejected','outcome_unknown') THEN RAISE EXCEPTION 'MAINTENANCE_DISPATCH_DRIFT';END IF;
  IF e.state IN('accepted','rejected','outcome_unknown') AND d.transport_state='in_flight' THEN RAISE EXCEPTION 'MAINTENANCE_DISPATCH_REGRESSION';END IF;
  UPDATE crm_maintenance_candidate.event SET state=CASE WHEN d.transport_state='in_flight' THEN 'claimed' ELSE d.transport_state END WHERE id=e.id RETURNING * INTO e;
 END IF;
 RETURN jsonb_build_object('event_id',e.id,'state',e.state,'dispatch_id',e.dispatch_id,'authorizes_send',false,'drained',false);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA crm_maintenance_candidate FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA crm_maintenance_candidate FROM PUBLIC;
COMMIT;
