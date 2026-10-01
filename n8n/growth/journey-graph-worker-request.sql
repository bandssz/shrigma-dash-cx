-- Durable service-call identity for bounded scheduler ticks. This does not
-- grant a send, open a control, or retry work whose outcome is unknown.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $$ BEGIN
 IF to_regnamespace('crm_graph_candidate') IS NULL OR to_regrole('crm_graph_worker') IS NULL THEN RAISE EXCEPTION 'GRAPH_WORKER_REQUEST_PREREQUISITE';END IF;
 IF to_regclass('crm_graph_candidate.source_batch_v1') IS NULL THEN RAISE EXCEPTION 'GRAPH_WORKER_REQUEST_PREREQUISITE';END IF;
 IF to_regclass('crm_graph_candidate.worker_request_v1') IS NOT NULL
 OR to_regprocedure('crm_graph_candidate.worker_request_begin_v1(text,uuid,jsonb)') IS NOT NULL
 OR to_regprocedure('crm_graph_candidate.worker_request_finish_v1(text,uuid,jsonb)') IS NOT NULL
 OR to_regprocedure('crm_graph_candidate.worker_request_read_v1(text,uuid)') IS NOT NULL
 OR to_regprocedure('crm_graph_candidate.source_handoff_read_v1(text,uuid)') IS NOT NULL THEN RAISE EXCEPTION 'GRAPH_WORKER_REQUEST_COLLISION';END IF;
END $$;
CREATE TABLE crm_graph_candidate.worker_request_v1(
 request_id uuid PRIMARY KEY,brand text NOT NULL CHECK(brand IN ('fish','aristo')),
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),state text NOT NULL CHECK(state IN ('in_flight','completed')),
 response jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 CHECK((state='in_flight' AND response IS NULL AND completed_at IS NULL) OR (state='completed' AND response IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE FUNCTION crm_graph_candidate.worker_request_begin_v1(b text,rid uuid,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,crm_graph_candidate SET lock_timeout='3s' AS $f$
DECLARE old crm_graph_candidate.worker_request_v1%ROWTYPE;h text;
BEGIN
 IF b IS NULL OR b NOT IN ('fish','aristo') OR rid IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object'
 OR p-ARRAY['brand','limit','request_id']<>'{}' OR (SELECT count(*) FROM jsonb_object_keys(p))<>3
 OR p->>'brand' IS DISTINCT FROM b OR p->>'request_id' IS DISTINCT FROM rid::text
 OR jsonb_typeof(p->'limit') IS DISTINCT FROM 'number' OR coalesce(p->>'limit','')!~'^[1-5]$' THEN RAISE EXCEPTION 'GRAPH_WORKER_REQUEST_INPUT';END IF;
 h:=encode(sha256(convert_to(p::text,'UTF8')),'hex');PERFORM pg_advisory_xact_lock(hashtextextended('graph-worker-request:'||rid::text,0));
 SELECT * INTO old FROM crm_graph_candidate.worker_request_v1 WHERE request_id=rid;
 IF FOUND THEN
  IF old.brand<>b OR old.request_hash<>h THEN RAISE EXCEPTION 'GRAPH_WORKER_REQUEST_REPLAY';END IF;
  RETURN jsonb_build_object('contract','journey_graph_worker_request_v1','state',old.state,'brand',old.brand,'request_id',old.request_id,'response',old.response,'fresh',false,'authorizes_send',false);
 END IF;
 INSERT INTO crm_graph_candidate.worker_request_v1(request_id,brand,request_hash,state) VALUES(rid,b,h,'in_flight');
 RETURN jsonb_build_object('contract','journey_graph_worker_request_v1','state','in_flight','brand',b,'request_id',rid,'response',NULL,'fresh',true,'authorizes_send',false);
END $f$;
CREATE FUNCTION crm_graph_candidate.worker_request_finish_v1(b text,rid uuid,v jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,crm_graph_candidate SET lock_timeout='3s' AS $f$
DECLARE old crm_graph_candidate.worker_request_v1%ROWTYPE;n integer;
BEGIN
 IF b IS NULL OR b NOT IN ('fish','aristo') OR rid IS NULL OR jsonb_typeof(v) IS DISTINCT FROM 'object'
 OR v->>'contract' IS DISTINCT FROM 'journey_graph_worker_v1' OR v->>'brand' IS DISTINCT FROM b THEN RAISE EXCEPTION 'GRAPH_WORKER_REQUEST_RESULT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('graph-worker-request:'||rid::text,0));SELECT * INTO old FROM crm_graph_candidate.worker_request_v1 WHERE request_id=rid FOR UPDATE;
 IF NOT FOUND OR old.brand<>b THEN RAISE EXCEPTION 'GRAPH_WORKER_REQUEST_NOT_FOUND';END IF;
 IF old.state='completed' THEN IF old.response<>v THEN RAISE EXCEPTION 'GRAPH_WORKER_REQUEST_REPLAY';END IF;RETURN jsonb_build_object('contract','journey_graph_worker_request_v1','state','completed','brand',b,'request_id',rid,'response',old.response,'authorizes_send',false);END IF;
 UPDATE crm_graph_candidate.worker_request_v1 SET state='completed',response=v,completed_at=clock_timestamp() WHERE request_id=rid AND state='in_flight';GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'GRAPH_WORKER_REQUEST_UNCONFIRMED';END IF;
 RETURN jsonb_build_object('contract','journey_graph_worker_request_v1','state','completed','brand',b,'request_id',rid,'response',v,'authorizes_send',false);
END $f$;
CREATE FUNCTION crm_graph_candidate.worker_request_read_v1(b text,rid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,crm_graph_candidate AS $f$
 SELECT CASE WHEN r.request_id IS NULL THEN jsonb_build_object('contract','journey_graph_worker_request_v1','state','missing','brand',b,'request_id',rid,'response',NULL,'authorizes_send',false)
 ELSE jsonb_build_object('contract','journey_graph_worker_request_v1','state',r.state,'brand',r.brand,'request_id',r.request_id,'response',r.response,'authorizes_send',false) END
 FROM (SELECT 1) x LEFT JOIN crm_graph_candidate.worker_request_v1 r ON r.request_id=rid AND r.brand=b
 WHERE b IN ('fish','aristo') AND rid IS NOT NULL
$f$;
CREATE FUNCTION crm_graph_candidate.source_handoff_read_v1(b text,rid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,crm_graph_candidate AS $f$
 SELECT CASE WHEN r.receipt_id IS NULL THEN jsonb_build_object('state','missing','brand',b,'receipt_id',rid,'response',NULL)
 ELSE jsonb_build_object('state','found','brand',r.brand,'receipt_id',r.receipt_id,'response',r.response) END
 FROM (SELECT 1) x LEFT JOIN crm_graph_candidate.source_batch_v1 r ON r.receipt_id=rid AND r.brand=b
 WHERE b IN ('fish','aristo') AND rid IS NOT NULL
$f$;
REVOKE ALL ON crm_graph_candidate.worker_request_v1 FROM PUBLIC,crm_graph_worker;
REVOKE ALL ON FUNCTION crm_graph_candidate.worker_request_begin_v1(text,uuid,jsonb),crm_graph_candidate.worker_request_finish_v1(text,uuid,jsonb),crm_graph_candidate.worker_request_read_v1(text,uuid),crm_graph_candidate.source_handoff_read_v1(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_graph_candidate.worker_request_begin_v1(text,uuid,jsonb),crm_graph_candidate.worker_request_finish_v1(text,uuid,jsonb),crm_graph_candidate.worker_request_read_v1(text,uuid),crm_graph_candidate.source_handoff_read_v1(text,uuid) TO crm_graph_worker;
COMMIT;
