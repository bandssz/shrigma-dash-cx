-- Explicit first-CART activation. Installation is inert: controls and journeys
-- remain OFF/paused until a reviewed, brand-scoped command commits.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $install$ BEGIN
 IF to_regprocedure('crm_graph_candidate.lifecycle_activation_readiness_v1(uuid,text,integer,integer,text)') IS NULL
 OR to_regprocedure('crm_graph_candidate.cart_epoch_open_v1(text,text,uuid,integer,text)') IS NULL
 OR to_regclass('crm_graph_candidate.source_batch_v1') IS NULL
 OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='crm_graph_candidate'::regnamespace AND relname IN('cart_activation_review_v1','cart_activation_receipt_v1'))
 OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='crm_graph_candidate'::regnamespace AND proname IN('cart_activation_check_v1','cart_activation_review_v1','cart_activation_commit_v1','cart_activation_operation_v1','cart_activation_status_v1'))
 THEN RAISE EXCEPTION 'GRAPH_ACTIVATION_DEPENDENCY_OR_COLLISION';END IF;
END $install$;
CREATE TABLE crm_graph_candidate.cart_activation_review_v1(
 request_id uuid PRIMARY KEY,actor text NOT NULL CHECK(actor~'^panel:[A-Za-z0-9_.:-]{1,122}$'),brand text NOT NULL CHECK(brand IN('fish','aristo')),
 journey_id uuid NOT NULL,expected_version integer NOT NULL CHECK(expected_version>0),published_revision integer NOT NULL CHECK(published_revision>0),
 publication_hash text NOT NULL CHECK(publication_hash~'^[a-f0-9]{64}$'),request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 review_hash text NOT NULL CHECK(review_hash~'^[a-f0-9]{64}$'),review jsonb NOT NULL,created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 FOREIGN KEY(journey_id,brand) REFERENCES crm_graph_candidate.journey(id,brand),CHECK(expires_at>created_at)
);
CREATE TABLE crm_graph_candidate.cart_activation_receipt_v1(
 request_id uuid PRIMARY KEY REFERENCES crm_graph_candidate.cart_activation_review_v1(request_id),receipt jsonb NOT NULL,created_at timestamptz NOT NULL
);
CREATE TRIGGER graph_cart_activation_review_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.cart_activation_review_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.immutable_row();
CREATE TRIGGER graph_cart_activation_receipt_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.cart_activation_receipt_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.immutable_row();

CREATE FUNCTION crm_graph_candidate.cart_activation_check_v1(jid uuid,b text,v integer,rev integer,h text,lock_rows boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE readiness jsonb;worker jsonb;target text;blockers jsonb;source_at timestamptz;at timestamptz;cc record;j record;
BEGIN
 IF jid IS NULL OR coalesce(b,'') NOT IN('fish','aristo') OR coalesce(v,0)<1 OR coalesce(rev,0)<1 OR coalesce(h,'')!~'^[a-f0-9]{64}$' OR lock_rows IS NULL THEN RAISE EXCEPTION 'GRAPH_ACTIVATION_INPUT';END IF;
 IF lock_rows THEN
  PERFORM 1 FROM crm_graph_candidate.control WHERE singleton FOR UPDATE;
  PERFORM 1 FROM crm_graph_candidate.cart_control_v1 WHERE brand=b FOR UPDATE;
  PERFORM 1 FROM crm_graph_candidate.journey WHERE id=jid AND brand=b FOR UPDATE;
  PERFORM 1 FROM crm_graph_candidate.graph_worker_deployment_v1 WHERE singleton FOR SHARE;
  PERFORM 1 FROM crm_graph_candidate.graph_worker_lease_v1 FOR SHARE;
 END IF;
 SELECT * INTO j FROM crm_graph_candidate.journey WHERE id=jid AND brand=b;
 IF NOT FOUND OR j.version IS DISTINCT FROM v OR j.published_revision IS DISTINCT FROM rev OR j.paused IS DISTINCT FROM true THEN RAISE EXCEPTION 'GRAPH_ACTIVATION_DRIFT';END IF;
 readiness:=crm_graph_candidate.lifecycle_activation_readiness_v1(jid,b,v,rev,h);
 blockers:=coalesce(readiness->'blockers','[]'::jsonb)-'graph_control_off';
 worker:=crm_graph_candidate.graph_worker_readiness_v1();target:=worker#>>'{pins,cache_target}';
 SELECT enabled,cache_target INTO cc FROM crm_graph_candidate.cart_control_v1 WHERE brand=b;
 IF cc.enabled OR cc.cache_target IS NOT NULL THEN blockers:=blockers||'"brand_control_not_off"'::jsonb;END IF;
 SELECT max(recorded_at) INTO source_at FROM crm_graph_candidate.source_batch_v1 WHERE brand=b;
 at:=clock_timestamp();
 IF source_at IS NULL OR source_at<at-interval '2 hours' OR source_at>at THEN blockers:=blockers||'"source_receipt_stale"'::jsonb;END IF;
 IF target IS NULL OR target!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN blockers:=blockers||'"worker_unavailable"'::jsonb;END IF;
 SELECT coalesce(jsonb_agg(x ORDER BY x),'[]'::jsonb) INTO blockers FROM (SELECT DISTINCT jsonb_array_elements_text(blockers) x) q;
 RETURN jsonb_build_object('contract','journey_graph_cart_activation_review_v1','state',CASE WHEN jsonb_array_length(blockers)=0 THEN 'ready' ELSE 'blocked' END,
  'brand',b,'journey_id',jid,'version',v,'published_revision',rev,'publication_hash',h,'cache_target',target,
  'source_observed_at',source_at,'checked_at',at,'expires_at',at+interval '30 seconds','blockers',blockers,
  'authorizes_activate',false,'authorizes_enrollment',false,'authorizes_send',false);
END $fn$;

CREATE FUNCTION crm_graph_candidate.cart_activation_review_v1(a text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE old crm_graph_candidate.cart_activation_review_v1%ROWTYPE;r jsonb;rh text;qh text;at timestamptz;
BEGIN
 IF coalesce(a,'')!~'^panel:[A-Za-z0-9_.:-]{1,122}$' OR jsonb_typeof(p) IS DISTINCT FROM 'object'
 OR p-ARRAY['action','brand','request_id','journey_id','expected_version','published_revision','publication_hash']<>'{}'::jsonb
 OR p->>'action' IS DISTINCT FROM 'activation_review' OR coalesce(p->>'brand','') NOT IN('fish','aristo') THEN RAISE EXCEPTION 'GRAPH_ACTIVATION_INPUT';END IF;
 qh:=encode(sha256(convert_to(p::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('graph-activation:'||(p->>'request_id'),0));
 SELECT * INTO old FROM crm_graph_candidate.cart_activation_review_v1 WHERE request_id=(p->>'request_id')::uuid;
 IF FOUND THEN IF old.actor<>a OR old.request_hash<>qh THEN RAISE EXCEPTION 'GRAPH_ACTIVATION_REPLAY_MISMATCH';END IF;RETURN old.review;END IF;
 r:=crm_graph_candidate.cart_activation_check_v1((p->>'journey_id')::uuid,p->>'brand',(p->>'expected_version')::integer,(p->>'published_revision')::integer,p->>'publication_hash',false);
 at:=clock_timestamp();rh:=encode(sha256(convert_to((r-'checked_at'-'expires_at')::text,'UTF8')),'hex');
 r:=r||jsonb_build_object('request_id',p->>'request_id','review_hash',rh,'checked_at',at,'expires_at',at+interval '30 seconds');
 INSERT INTO crm_graph_candidate.cart_activation_review_v1 VALUES((p->>'request_id')::uuid,a,p->>'brand',(p->>'journey_id')::uuid,(p->>'expected_version')::integer,(p->>'published_revision')::integer,p->>'publication_hash',qh,rh,r,at,at+interval '30 seconds');
 RETURN r;
END $fn$;

CREATE FUNCTION crm_graph_candidate.cart_activation_commit_v1(a text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE rv crm_graph_candidate.cart_activation_review_v1%ROWTYPE;done crm_graph_candidate.cart_activation_receipt_v1%ROWTYPE;check_now jsonb;e jsonb;j record;receipt jsonb;target text;at timestamptz;
BEGIN
 IF coalesce(a,'')!~'^panel:[A-Za-z0-9_.:-]{1,122}$' OR jsonb_typeof(p) IS DISTINCT FROM 'object'
 OR p-ARRAY['action','brand','request_id','journey_id','expected_version','published_revision','publication_hash','admission_review_hash','confirm']<>'{}'::jsonb
 OR p->>'action' IS DISTINCT FROM 'activate' OR p->>'confirm' IS DISTINCT FROM 'ativar' THEN RAISE EXCEPTION 'GRAPH_ACTIVATION_INPUT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('graph-activation:'||(p->>'request_id'),0));
 SELECT * INTO done FROM crm_graph_candidate.cart_activation_receipt_v1 WHERE request_id=(p->>'request_id')::uuid;
 SELECT * INTO rv FROM crm_graph_candidate.cart_activation_review_v1 WHERE request_id=(p->>'request_id')::uuid;
 IF NOT FOUND OR rv.actor IS DISTINCT FROM a OR rv.brand IS DISTINCT FROM p->>'brand' OR rv.journey_id IS DISTINCT FROM (p->>'journey_id')::uuid OR rv.expected_version IS DISTINCT FROM (p->>'expected_version')::integer
 OR rv.published_revision IS DISTINCT FROM (p->>'published_revision')::integer OR rv.publication_hash IS DISTINCT FROM p->>'publication_hash' OR rv.review_hash IS DISTINCT FROM p->>'admission_review_hash'
 OR rv.review->>'state' IS DISTINCT FROM 'ready' THEN RAISE EXCEPTION 'GRAPH_ACTIVATION_REPLAY_MISMATCH';END IF;
 IF done.request_id IS NOT NULL THEN RETURN done.receipt;END IF;
 IF rv.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'GRAPH_ACTIVATION_REVIEW_EXPIRED';END IF;
 check_now:=crm_graph_candidate.cart_activation_check_v1(rv.journey_id,rv.brand,rv.expected_version,rv.published_revision,rv.publication_hash,true);
 IF check_now->>'state'<>'ready' OR check_now->'blockers'<>'[]'::jsonb THEN RAISE EXCEPTION 'GRAPH_ACTIVATION_DRIFT';END IF;
 target:=check_now->>'cache_target';
 UPDATE crm_graph_candidate.control SET enabled=true WHERE singleton AND enabled=false;
 UPDATE crm_graph_candidate.cart_control_v1 SET enabled=true,cache_target=target WHERE brand=rv.brand AND enabled=false AND cache_target IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_ACTIVATION_DRIFT';END IF;
 UPDATE crm_graph_candidate.journey SET paused=false,version=version+1 WHERE id=rv.journey_id AND brand=rv.brand AND version=rv.expected_version AND paused=true RETURNING * INTO j;
 IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_ACTIVATION_DRIFT';END IF;
 e:=crm_graph_candidate.cart_epoch_open_v1(a,rv.brand,rv.journey_id,j.version,target);at:=clock_timestamp();
 receipt:=jsonb_build_object('contract','journey_graph_cart_activation_v1','state','active','request_id',rv.request_id,'brand',rv.brand,'journey_id',rv.journey_id,
  'base_version',rv.expected_version,'version',j.version,'published_revision',rv.published_revision,'publication_hash',rv.publication_hash,'review_hash',rv.review_hash,
  'epoch_id',e->>'epoch_id','activated_at',at,'authorizes_activate',false,'authorizes_enrollment',false,'authorizes_send',false);
 INSERT INTO crm_graph_candidate.cart_activation_receipt_v1 VALUES(rv.request_id,receipt,at);RETURN receipt;
END $fn$;

CREATE FUNCTION crm_graph_candidate.cart_activation_operation_v1(a text,rid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT CASE WHEN r.request_id IS NOT NULL THEN jsonb_build_object('state','succeeded','actor',v.actor,'request_id',v.request_id,'receipt',r.receipt)
  WHEN v.request_id IS NOT NULL THEN jsonb_build_object('state','reviewed','actor',v.actor,'request_id',v.request_id,'review',v.review)
  ELSE jsonb_build_object('state','unconfirmed','actor',a,'request_id',rid,'automatic_retry',false) END
 FROM (SELECT 1) z LEFT JOIN crm_graph_candidate.cart_activation_review_v1 v ON v.request_id=rid AND v.actor=a
 LEFT JOIN crm_graph_candidate.cart_activation_receipt_v1 r ON r.request_id=v.request_id
$fn$;
CREATE FUNCTION crm_graph_candidate.cart_activation_status_v1(jid uuid,b text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT to_jsonb(current_status) FROM (
  SELECT j.id journey_id,j.brand,j.version,j.head_revision revision,j.published_revision,j.paused,
   rv.definition,rv.catalog,ar.receipt activation_receipt,po.response publication_receipt
  FROM crm_graph_candidate.journey j
  JOIN crm_graph_candidate.revision rv ON rv.journey_id=j.id AND rv.brand=j.brand AND rv.revision=j.published_revision
  JOIN crm_graph_candidate.cart_activation_review_v1 av ON av.journey_id=j.id AND av.brand=j.brand AND av.published_revision=j.published_revision
  JOIN crm_graph_candidate.cart_activation_receipt_v1 ar ON ar.request_id=av.request_id
  JOIN crm_graph_candidate.cart_epoch_v1 ce ON ce.id=(ar.receipt->>'epoch_id')::uuid AND ce.brand=j.brand AND ce.journey_id=j.id AND ce.ends_at IS NULL
  JOIN crm_graph_candidate.lifecycle_publication_v1 lp ON lp.journey_id=j.id AND lp.brand=j.brand AND lp.published_revision=j.published_revision
  JOIN crm_graph_candidate.lifecycle_publication_operation_v1 po ON po.request_id=lp.request_id
  WHERE j.id=jid AND j.brand=b AND NOT j.paused
 ) current_status
$fn$;
REVOKE ALL ON crm_graph_candidate.cart_activation_review_v1,crm_graph_candidate.cart_activation_receipt_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_graph_candidate.cart_activation_check_v1(uuid,text,integer,integer,text,boolean),crm_graph_candidate.cart_activation_review_v1(text,jsonb),crm_graph_candidate.cart_activation_commit_v1(text,jsonb),crm_graph_candidate.cart_activation_operation_v1(text,uuid),crm_graph_candidate.cart_activation_status_v1(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_graph_candidate.cart_activation_review_v1(text,jsonb),crm_graph_candidate.cart_activation_commit_v1(text,jsonb),crm_graph_candidate.cart_activation_operation_v1(text,uuid),crm_graph_candidate.cart_activation_status_v1(uuid,text) TO crm_audience_api;
COMMIT;
