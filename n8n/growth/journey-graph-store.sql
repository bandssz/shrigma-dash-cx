-- Candidate foundation only. No public API, existing journey tables or transport.
-- One-shot transactional installation: any existing schema is a collision and is refused.
-- Installation never enables execution and never grants a runtime role access.
BEGIN;
CREATE SCHEMA crm_graph_candidate;
REVOKE ALL ON SCHEMA crm_graph_candidate FROM PUBLIC;
CREATE TABLE crm_graph_candidate.control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), enabled boolean NOT NULL DEFAULT false
);
INSERT INTO crm_graph_candidate.control(singleton) VALUES(true);
CREATE TABLE crm_graph_candidate.journey (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand text NOT NULL CHECK(brand IN ('fish','aristo')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), head_revision integer NOT NULL DEFAULT 1 CHECK(head_revision>0),
 published_revision integer CHECK(published_revision>0), paused boolean NOT NULL DEFAULT true,
 CHECK(paused OR published_revision IS NOT NULL), UNIQUE(id,brand)
);
CREATE TABLE crm_graph_candidate.revision (
 journey_id uuid NOT NULL, brand text NOT NULL, revision integer NOT NULL CHECK(revision>0),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object' AND octet_length(definition::text)<=131072),
 catalog jsonb NOT NULL CHECK(jsonb_typeof(catalog)='object' AND octet_length(catalog::text)<=131072),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL, PRIMARY KEY(journey_id,revision), UNIQUE(journey_id,revision,brand),
 FOREIGN KEY(journey_id,brand) REFERENCES crm_graph_candidate.journey(id,brand),
 CHECK((definition->>'brand') IS NOT DISTINCT FROM brand AND (catalog->>'brand') IS NOT DISTINCT FROM brand),
 CHECK((definition->>'version') IS NOT DISTINCT FROM 'journey_graph_v1' AND (catalog->>'version') IS NOT DISTINCT FROM 'journey_graph_v1')
);
ALTER TABLE crm_graph_candidate.journey
 ADD FOREIGN KEY(id,head_revision,brand) REFERENCES crm_graph_candidate.revision(journey_id,revision,brand) DEFERRABLE INITIALLY DEFERRED,
 ADD FOREIGN KEY(id,published_revision,brand) REFERENCES crm_graph_candidate.revision(journey_id,revision,brand) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE crm_graph_candidate.entry (
 id uuid PRIMARY KEY, journey_id uuid NOT NULL, revision integer NOT NULL, brand text NOT NULL,
 source_ref uuid NOT NULL, event_key text NOT NULL CHECK(event_key ~ '^[a-f0-9]{64}$'),
 source_identity_hash text NOT NULL CHECK(source_identity_hash ~ '^[a-f0-9]{64}$'),
 identity jsonb NOT NULL CHECK(jsonb_typeof(identity)='object'),
 state jsonb NOT NULL CHECK(jsonb_typeof(state)='object' AND octet_length(state::text)<=524288),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), next_due_at timestamptz,
 stopped_reason text CHECK(stopped_reason IN ('source_ineligible','consent_withdrawn','suppressed')),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 UNIQUE(id,brand), UNIQUE(journey_id,event_key), FOREIGN KEY(journey_id,revision,brand) REFERENCES crm_graph_candidate.revision(journey_id,revision,brand)
);
CREATE INDEX graph_entry_due ON crm_graph_candidate.entry(next_due_at,id) WHERE stopped_reason IS NULL;
CREATE TABLE crm_graph_candidate.intent (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entry_id uuid NOT NULL,
 node_id text NOT NULL, attempt_key text NOT NULL UNIQUE,
 brand text NOT NULL CHECK(brand IN ('fish','aristo')), channel text NOT NULL CHECK(channel='email'),
 binding text NOT NULL, release text NOT NULL, authorizes_send boolean NOT NULL DEFAULT false CHECK(NOT authorizes_send),
 created_at timestamptz NOT NULL, UNIQUE(entry_id,node_id),
 FOREIGN KEY(entry_id,brand) REFERENCES crm_graph_candidate.entry(id,brand)
);
CREATE TABLE crm_graph_candidate.transition (
 entry_id uuid NOT NULL REFERENCES crm_graph_candidate.entry(id), entry_version integer NOT NULL CHECK(entry_version>1),
 kind text NOT NULL, node_id text NOT NULL, state text NOT NULL, reason text,
 created_at timestamptz NOT NULL, PRIMARY KEY(entry_id,entry_version)
);
CREATE TABLE crm_graph_candidate.operation (
 request_id uuid PRIMARY KEY, actor text NOT NULL, brand text NOT NULL CHECK(brand IN ('fish','aristo')),
 action text NOT NULL CHECK(action IN ('create','save','publish','pause','enroll','step')),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 response jsonb NOT NULL CHECK(jsonb_typeof(response)='object' AND octet_length(response::text)<=8192),
 created_at timestamptz NOT NULL
);
CREATE FUNCTION crm_graph_candidate.immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'GRAPH_IMMUTABLE'; END $$;
CREATE FUNCTION crm_graph_candidate.entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['state','version','next_due_at','stopped_reason','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','next_due_at','stopped_reason','updated_at'])
    OR NEW.version<>OLD.version+1 OR (OLD.stopped_reason IS NOT NULL AND NEW.stopped_reason IS DISTINCT FROM OLD.stopped_reason)
 THEN RAISE EXCEPTION 'GRAPH_ENTRY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['revision','intent','transition','operation'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=format('crm_graph_candidate.%I',t)::regclass AND tgname='graph_immutable') THEN
   EXECUTE format('CREATE TRIGGER graph_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.%I FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.immutable_row()',t);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='crm_graph_candidate.entry'::regclass AND tgname='graph_entry_guard') THEN
  CREATE TRIGGER graph_entry_guard BEFORE UPDATE ON crm_graph_candidate.entry FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.entry_guard();
 END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA crm_graph_candidate FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA crm_graph_candidate FROM PUBLIC;
COMMIT;
