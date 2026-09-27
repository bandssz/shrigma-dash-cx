-- Additive, one-shot candidate. Records original dispatch results only.
-- No transport, activation, new participants or grants to runtime roles.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $install$
DECLARE definition text;
BEGIN
 IF to_regclass('crm_graph_candidate.cart_delivery_v1') IS NULL OR to_regprocedure('crm_graph_candidate.cart_dispatch_v1(text,uuid)') IS NULL
 OR to_regclass('public.shrigma_email_dispatch') IS NULL OR to_regclass('crm_graph_candidate.operation') IS NULL THEN RAISE EXCEPTION 'GRAPH_RECEIPT_DEPENDENCY';END IF;
 IF to_regclass('crm_graph_candidate.dispatch_receipt_v1') IS NOT NULL THEN RAISE EXCEPTION 'GRAPH_RECEIPT_COLLISION';END IF;
 SELECT regexp_replace(pg_get_constraintdef(oid),'[[:space:]]','','g') INTO definition FROM pg_constraint
 WHERE conrelid='crm_graph_candidate.operation'::regclass AND conname='operation_action_check' AND contype='c' AND convalidated;
 IF definition IS DISTINCT FROM 'CHECK((action=ANY(ARRAY[''create''::text,''save''::text,''publish''::text,''pause''::text,''enroll''::text,''step''::text])))'
 THEN RAISE EXCEPTION 'GRAPH_RECEIPT_SCHEMA_CHANGED';END IF;
END $install$;
ALTER TABLE crm_graph_candidate.operation DROP CONSTRAINT operation_action_check;
ALTER TABLE crm_graph_candidate.operation ADD CONSTRAINT operation_action_check CHECK(action IN ('create','save','publish','pause','enroll','step','apply_dispatch'));
CREATE TABLE crm_graph_candidate.dispatch_receipt_v1(
 intent_id uuid NOT NULL REFERENCES crm_graph_candidate.cart_delivery_v1(intent_id),
 dispatch_id uuid NOT NULL REFERENCES public.shrigma_email_dispatch(dispatch_id),
 entry_id uuid NOT NULL,brand text NOT NULL CHECK(brand IN ('fish','aristo')),
 revision integer NOT NULL CHECK(revision>0),node_id text NOT NULL,attempt_key text NOT NULL,
 transport_state text NOT NULL CHECK(transport_state IN ('in_flight','accepted','rejected','outcome_unknown')),
 entry_version integer NOT NULL CHECK(entry_version>1),
 transition_kind text NOT NULL CHECK(transition_kind IN ('await_receipt','advance','failed','unknown')),
 operation_id uuid NOT NULL UNIQUE REFERENCES crm_graph_candidate.operation(request_id) DEFERRABLE INITIALLY DEFERRED,
 observed_at timestamptz NOT NULL,PRIMARY KEY(intent_id,transport_state),
 FOREIGN KEY(entry_id,brand) REFERENCES crm_graph_candidate.entry(id,brand),
 FOREIGN KEY(entry_id,entry_version) REFERENCES crm_graph_candidate.transition(entry_id,entry_version)
);
CREATE TRIGGER graph_receipt_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.dispatch_receipt_v1
 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.immutable_row();
REVOKE ALL ON crm_graph_candidate.dispatch_receipt_v1 FROM PUBLIC;
COMMIT;
