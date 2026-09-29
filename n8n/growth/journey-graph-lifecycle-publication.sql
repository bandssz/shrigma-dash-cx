-- Candidate paused publication only. No activation, enrollment or transport grants.
DO $install$
BEGIN
 IF pg_catalog.to_regclass('crm_graph_candidate.lifecycle_prepared_v1') IS NULL
 OR pg_catalog.to_regclass('crm_graph_candidate.revision') IS NULL
 OR pg_catalog.to_regprocedure('crm_graph_candidate.immutable_row()') IS NULL
 THEN RAISE EXCEPTION 'GRAPH_PUBLICATION_DEPENDENCY'; END IF;

 CREATE TABLE crm_graph_candidate.lifecycle_publication_v1(
  request_id uuid PRIMARY KEY,
  prepared_id uuid NOT NULL UNIQUE REFERENCES crm_graph_candidate.lifecycle_prepared_v1(request_id),
  actor text NOT NULL,brand text NOT NULL CHECK(brand IN ('fish','aristo')),
  journey_id uuid NOT NULL,base_version integer NOT NULL CHECK(base_version>0),
  base_revision integer NOT NULL CHECK(base_revision>0),published_revision integer NOT NULL CHECK(published_revision>0),
  prepared_hash text NOT NULL CHECK(prepared_hash~'^[a-f0-9]{64}$'),
  publication_hash text NOT NULL CHECK(publication_hash~'^[a-f0-9]{64}$'),
  publication jsonb NOT NULL CHECK(pg_catalog.jsonb_typeof(publication)='object' AND pg_catalog.octet_length(publication::text)<=65536),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY(journey_id,brand,published_revision) REFERENCES crm_graph_candidate.revision(journey_id,brand,revision));

 CREATE TABLE crm_graph_candidate.lifecycle_publication_operation_v1(
  request_id uuid PRIMARY KEY REFERENCES crm_graph_candidate.lifecycle_publication_v1(request_id),
  actor text NOT NULL,brand text NOT NULL CHECK(brand IN ('fish','aristo')),
  request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
  request jsonb NOT NULL,response jsonb NOT NULL CHECK(pg_catalog.jsonb_typeof(response)='object' AND pg_catalog.octet_length(response::text)<=16384),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp());

 CREATE TRIGGER lifecycle_publication_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.lifecycle_publication_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.immutable_row();
 CREATE TRIGGER lifecycle_publication_operation_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.lifecycle_publication_operation_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.immutable_row();
 REVOKE ALL ON crm_graph_candidate.lifecycle_publication_v1,crm_graph_candidate.lifecycle_publication_operation_v1 FROM PUBLIC;
END $install$;
