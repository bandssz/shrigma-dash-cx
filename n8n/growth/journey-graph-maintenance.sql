-- One-shot candidate AFTER graph CART and maintenance-retention/cart migrations.
-- No activation, transport, grants, reset or requeue. Retention's deployment seal
-- must be explicitly reviewed/replaced by the future graph installer; drift is expected.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $install$
DECLARE definition text;
BEGIN
 IF to_regclass('crm_graph_candidate.cart_epoch_v1') IS NULL
 OR to_regclass('crm_graph_candidate.cart_owner_v1') IS NULL
 OR to_regprocedure('crm_graph_candidate.cart_owned_v1(jsonb)') IS NULL
 OR to_regprocedure('crm_maintenance_candidate.claim_v1(uuid)') IS NULL
 OR to_regprocedure('crm_maintenance_candidate.cart_attempt_v1(uuid)') IS NULL
 THEN RAISE EXCEPTION 'GRAPH_MAINTENANCE_DEPENDENCY';END IF;
 IF to_regclass('crm_graph_candidate.maintenance_delegation_v1') IS NOT NULL
 OR to_regprocedure('crm_graph_candidate.maintenance_delegate_v1(uuid)') IS NOT NULL
 OR to_regprocedure('crm_graph_candidate.maintenance_delegated_guard_v1()') IS NOT NULL
 THEN RAISE EXCEPTION 'GRAPH_MAINTENANCE_COLLISION';END IF;
 IF encode(sha256(convert_to(pg_get_functiondef('crm_maintenance_candidate.claim_v1(uuid)'::regprocedure),'UTF8')),'hex')
 IS DISTINCT FROM '6d48133b9b37d55f7efccd1205d38638064050e7cb72e938792375da06fc05c1'
 THEN RAISE EXCEPTION 'GRAPH_MAINTENANCE_CLAIM_DRIFT';END IF;
 SELECT regexp_replace(pg_get_constraintdef(oid),'[[:space:]]','','g') INTO definition FROM pg_constraint
 WHERE conrelid='crm_maintenance_candidate.event'::regclass AND conname='event_state_check' AND contype='c' AND convalidated;
 IF definition IS DISTINCT FROM 'CHECK((state=ANY(ARRAY[''queued''::text,''claimed''::text,''accepted''::text,''rejected''::text,''outcome_unknown''::text,''review_required''::text,''expired''::text])))'
 THEN RAISE EXCEPTION 'GRAPH_MAINTENANCE_STATE_DRIFT';END IF;
 -- Keep the original dispatch/null constraint: delegated never owns a transport grant.
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='crm_maintenance_candidate.event'::regclass AND contype='c' AND convalidated
 AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]','','g')='CHECK(((state=ANY(ARRAY[''claimed''::text,''accepted''::text,''rejected''::text,''outcome_unknown''::text]))=(dispatch_idISNOTNULL)))')
 THEN RAISE EXCEPTION 'GRAPH_MAINTENANCE_DISPATCH_DRIFT';END IF;
END $install$;
ALTER TABLE crm_maintenance_candidate.event DROP CONSTRAINT event_state_check;
ALTER TABLE crm_maintenance_candidate.event ADD CONSTRAINT event_state_check
 CHECK(state IN('queued','claimed','accepted','rejected','outcome_unknown','review_required','expired','delegated'));
CREATE TABLE crm_graph_candidate.maintenance_delegation_v1(
 event_id uuid PRIMARY KEY REFERENCES crm_maintenance_candidate.event(id),
 epoch_id uuid NOT NULL,brand text NOT NULL CHECK(brand IN('fish','aristo')),
 delegated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(epoch_id,brand) REFERENCES crm_graph_candidate.cart_epoch_v1(id,brand)
);
CREATE TRIGGER graph_maintenance_delegation_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.maintenance_delegation_v1
 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.immutable_row();

-- Additional guard only for the new state. Original event/receipt immutability remains.
CREATE FUNCTION crm_graph_candidate.maintenance_delegated_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
 IF TG_OP='UPDATE' AND OLD.state='delegated' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)
 THEN RAISE EXCEPTION 'GRAPH_MAINTENANCE_TERMINAL';END IF;
 IF NEW.state='delegated' THEN
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'GRAPH_MAINTENANCE_TRANSITION';END IF;
  IF OLD.state NOT IN('queued','delegated') OR NEW.kind<>'cart' OR NEW.flow<>'carrinho' OR NEW.piece<>'carrinho-30min'
  OR NEW.payload->>'brand' IS DISTINCT FROM NEW.brand OR NEW.payload->>'toque' IS DISTINCT FROM 't05'
  OR NEW.dispatch_id IS NOT NULL OR NEW.claimed_at IS NOT NULL OR NEW.reason IS DISTINCT FROM 'graph_owned'
  OR NOT EXISTS(SELECT 1 FROM crm_graph_candidate.maintenance_delegation_v1 d WHERE d.event_id=NEW.id AND d.brand=NEW.brand)
  THEN RAISE EXCEPTION 'GRAPH_MAINTENANCE_TRANSITION';END IF;
 END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER graph_maintenance_delegated_guard BEFORE INSERT OR UPDATE ON crm_maintenance_candidate.event
 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.maintenance_delegated_guard_v1();

-- Server-only, same gate/event/cart-control order as the existing retained claim.
-- No subscriber/dispatch/journey locks; ownership and the selected epoch are immutable.
CREATE FUNCTION crm_graph_candidate.maintenance_delegate_v1(eid uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $f$
DECLARE e crm_maintenance_candidate.event%ROWTYPE;c crm_maintenance_candidate.control%ROWTYPE;
 identity jsonb;epoch uuid;matches uuid[];at timestamptz;sid integer;
BEGIN
 SELECT * INTO STRICT c FROM crm_maintenance_candidate.control WHERE singleton FOR SHARE;
 SELECT * INTO STRICT e FROM crm_maintenance_candidate.event WHERE id=eid FOR UPDATE;
 IF e.state='delegated' THEN
  IF NOT EXISTS(SELECT 1 FROM crm_graph_candidate.maintenance_delegation_v1 d WHERE d.event_id=e.id AND d.brand=e.brand)
  THEN RAISE EXCEPTION 'GRAPH_MAINTENANCE_LINK';END IF;
  RETURN;
 END IF;
 IF e.state<>'queued' OR e.dispatch_id IS NOT NULL OR e.claimed_at IS NOT NULL
 OR e.kind<>'cart' OR e.brand NOT IN('fish','aristo') OR e.flow<>'carrinho' OR e.piece<>'carrinho-30min'
 OR e.payload->>'toque' IS DISTINCT FROM 't05' OR e.payload ? 'graph_intent_id'
 THEN RAISE EXCEPTION 'GRAPH_MAINTENANCE_SCOPE';END IF;
 IF NOT c.enabled OR c.mode<>'open' THEN RAISE EXCEPTION 'GRAPH_MAINTENANCE_CLOSED';END IF;
 identity:=crm_maintenance_candidate.identity_v1(e.brand,e.kind,e.payload);
 IF identity->'payload' IS DISTINCT FROM e.payload OR identity->>'dedupe_key' IS DISTINCT FROM e.dedupe_key
 OR encode(sha256(convert_to(e.payload::text,'UTF8')),'hex') IS DISTINCT FROM e.payload_hash
 OR crm_graph_candidate.cart_owned_v1(e.payload) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'GRAPH_MAINTENANCE_NOT_OWNED';END IF;
 at:=(e.payload->>'ref')::timestamptz;sid:=(e.payload->>'subscriber_id')::integer;
 SELECT o.epoch_id INTO epoch FROM crm_graph_candidate.cart_owner_v1 o
 WHERE o.brand=e.brand AND o.subscriber_id=sid AND o.ref=at AND o.piece=e.piece;
 IF epoch IS NULL THEN
  SELECT array_agg(ep.id) INTO matches FROM crm_graph_candidate.cart_epoch_v1 ep
  WHERE ep.brand=e.brand AND at>=ep.starts_at AND (ep.ends_at IS NULL OR at<ep.ends_at);
  IF coalesce(cardinality(matches),0)<>1 THEN RAISE EXCEPTION 'GRAPH_MAINTENANCE_EPOCH';END IF;
  epoch:=matches[1];
 END IF;
 INSERT INTO crm_graph_candidate.maintenance_delegation_v1(event_id,epoch_id,brand) VALUES(e.id,epoch,e.brand);
 UPDATE crm_maintenance_candidate.event SET state='delegated',reason='graph_owned' WHERE id=e.id;
END $f$;

DO $patch$
DECLARE source text:=pg_get_functiondef('crm_maintenance_candidate.claim_v1(uuid)'::regprocedure);
 anchor text:=' IF r.should_send IS DISTINCT FROM false THEN RAISE EXCEPTION ''MAINTENANCE_CLAIM_RESPONSE'';END IF;';
BEGIN
 IF (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'GRAPH_MAINTENANCE_PATCH_ANCHOR';END IF;
 source:=replace(source,anchor,anchor||E'\n'||$insert$ IF r.reason='graph_owned' AND e.kind='cart' AND e.brand IN('fish','aristo')
 AND e.flow='carrinho' AND e.piece='carrinho-30min' AND e.payload->>'toque'='t05'
 AND crm_graph_candidate.cart_owned_v1(e.payload) IS TRUE THEN
  PERFORM crm_graph_candidate.maintenance_delegate_v1(e.id);
  RETURN QUERY SELECT false,e.id,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'delegated';RETURN;
 END IF;$insert$);
 EXECUTE source;
END $patch$;
REVOKE ALL ON crm_graph_candidate.maintenance_delegation_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_graph_candidate.maintenance_delegate_v1(uuid),crm_graph_candidate.maintenance_delegated_guard_v1() FROM PUBLIC;
COMMIT;
