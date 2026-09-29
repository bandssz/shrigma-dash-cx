-- SHADOW ONLY. Separate prepared snapshots, never runtime revisions or native templates.
-- Install in a disposable database after graph-store + graph-release. No role grants.
DO $install$
BEGIN
 IF pg_catalog.to_regclass('crm_graph_candidate.revision') IS NULL
 OR pg_catalog.to_regclass('crm_graph_candidate.message_release_v1') IS NULL
 OR pg_catalog.to_regprocedure('crm_graph_candidate.immutable_row()') IS NULL
 THEN RAISE EXCEPTION 'GRAPH_PREPARE_DEPENDENCY';END IF;
 CREATE TABLE crm_graph_candidate.lifecycle_review_v1(
  review_hash text PRIMARY KEY CHECK(review_hash~'^[a-f0-9]{64}$'),
  actor text NOT NULL,brand text NOT NULL CHECK(brand IN ('fish','aristo')),
  journey_id uuid NOT NULL,base_revision integer NOT NULL,base_version integer NOT NULL CHECK(base_version>0),
  checkout_sha text NOT NULL CHECK(checkout_sha~'^[a-f0-9]{40}$'),control_pin jsonb NOT NULL,
  request jsonb NOT NULL,evidence jsonb NOT NULL CHECK(pg_catalog.octet_length(evidence::text)<=300000),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY(journey_id,brand,base_revision) REFERENCES crm_graph_candidate.revision(journey_id,brand,revision));
 CREATE TABLE crm_graph_candidate.lifecycle_prepared_v1(
  request_id uuid PRIMARY KEY,review_hash text NOT NULL UNIQUE REFERENCES crm_graph_candidate.lifecycle_review_v1(review_hash),
  actor text NOT NULL,brand text NOT NULL CHECK(brand IN ('fish','aristo')),
  journey_id uuid NOT NULL,base_revision integer NOT NULL,base_version integer NOT NULL CHECK(base_version>0),
  release_id uuid NOT NULL REFERENCES crm_graph_candidate.message_release_v1(id),
  prepared_hash text NOT NULL CHECK(prepared_hash~'^[a-f0-9]{64}$'),
  prepared jsonb NOT NULL CHECK(pg_catalog.octet_length(prepared::text)<=500000),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY(journey_id,brand,base_revision) REFERENCES crm_graph_candidate.revision(journey_id,brand,revision));
 CREATE TABLE crm_graph_candidate.lifecycle_prepare_operation_v1(
  request_id uuid PRIMARY KEY REFERENCES crm_graph_candidate.lifecycle_prepared_v1(request_id),
  actor text NOT NULL,brand text NOT NULL CHECK(brand IN ('fish','aristo')),
  request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
  request jsonb NOT NULL,response jsonb NOT NULL CHECK(pg_catalog.octet_length(response::text)<=8192),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp());
 CREATE TRIGGER lifecycle_review_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.lifecycle_review_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.immutable_row();
 CREATE TRIGGER lifecycle_prepared_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.lifecycle_prepared_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.immutable_row();
 CREATE TRIGGER lifecycle_prepare_operation_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.lifecycle_prepare_operation_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.immutable_row();
 REVOKE ALL ON crm_graph_candidate.lifecycle_review_v1,crm_graph_candidate.lifecycle_prepared_v1,crm_graph_candidate.lifecycle_prepare_operation_v1 FROM PUBLIC;
END $install$;
