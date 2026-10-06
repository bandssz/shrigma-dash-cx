-- Source only. Root installs in the EXISTING dashboard_crm_controls namespace.
-- No initial revisions/default evidence, roles, grants, databases or provider side effects.
CREATE TABLE dashboard_crm_controls.control_fact_batches_v1 (
 brand text NOT NULL CHECK(brand IN ('fish','aristo')),
 source_ref text NOT NULL CHECK(source_ref ~ '^[a-f0-9]{64}$'), event_ref text NOT NULL CHECK(event_ref ~ '^[a-f0-9]{64}$'),
 brand_revision bigint NOT NULL CHECK(brand_revision BETWEEN 1 AND 9007199254740991),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'), authority_ref text NOT NULL CHECK(authority_ref ~ '^[a-f0-9]{64}$'),
 recorded_at bigint NOT NULL CHECK(recorded_at BETWEEN 0 AND 9007199254740991), envelope jsonb NOT NULL CHECK(jsonb_typeof(envelope)='object'),
 PRIMARY KEY(brand,source_ref,event_ref), UNIQUE(brand,brand_revision), UNIQUE(brand,source_ref,event_ref,brand_revision)
);
CREATE TABLE dashboard_crm_controls.control_fact_brand_heads_v1 (
 brand text PRIMARY KEY CHECK(brand IN ('fish','aristo')), revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 FOREIGN KEY(brand,revision) REFERENCES dashboard_crm_controls.control_fact_batches_v1(brand,brand_revision)
);
CREATE TABLE dashboard_crm_controls.control_fact_versions_v1 (
 brand text NOT NULL CHECK(brand IN ('fish','aristo')), kind text NOT NULL CHECK(kind IN ('consent','policy','suspension','capping','capacity','claims')),
 fact_key text NOT NULL CHECK(length(fact_key) BETWEEN 1 AND 300), revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'),
 observed_at bigint NOT NULL CHECK(observed_at BETWEEN 0 AND 9007199254740991), expires_at bigint NOT NULL,
 source_ref text NOT NULL, event_ref text NOT NULL, brand_revision bigint NOT NULL,
 CHECK(expires_at>observed_at AND expires_at-observed_at<=60000 AND expires_at<=9007199254740991),
 PRIMARY KEY(brand,kind,fact_key,revision),
 FOREIGN KEY(brand,source_ref,event_ref,brand_revision) REFERENCES dashboard_crm_controls.control_fact_batches_v1(brand,source_ref,event_ref,brand_revision)
);
CREATE TABLE dashboard_crm_controls.control_fact_heads_v1 (
 brand text NOT NULL, kind text NOT NULL, fact_key text NOT NULL, revision bigint NOT NULL,
 PRIMARY KEY(brand,kind,fact_key),
 FOREIGN KEY(brand,kind,fact_key,revision) REFERENCES dashboard_crm_controls.control_fact_versions_v1(brand,kind,fact_key,revision)
);
CREATE FUNCTION dashboard_crm_controls.control_fact_history_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CONTROL_FACT_HISTORY_IMMUTABLE'; END $$;
CREATE TRIGGER control_fact_batches_immutable_v1 BEFORE UPDATE OR DELETE ON dashboard_crm_controls.control_fact_batches_v1 FOR EACH ROW EXECUTE FUNCTION dashboard_crm_controls.control_fact_history_guard_v1();
CREATE TRIGGER control_fact_batches_no_truncate_v1 BEFORE TRUNCATE ON dashboard_crm_controls.control_fact_batches_v1 FOR EACH STATEMENT EXECUTE FUNCTION dashboard_crm_controls.control_fact_history_guard_v1();
CREATE TRIGGER control_fact_versions_immutable_v1 BEFORE UPDATE OR DELETE ON dashboard_crm_controls.control_fact_versions_v1 FOR EACH ROW EXECUTE FUNCTION dashboard_crm_controls.control_fact_history_guard_v1();
CREATE TRIGGER control_fact_versions_no_truncate_v1 BEFORE TRUNCATE ON dashboard_crm_controls.control_fact_versions_v1 FOR EACH STATEMENT EXECUTE FUNCTION dashboard_crm_controls.control_fact_history_guard_v1();
CREATE FUNCTION dashboard_crm_controls.control_fact_head_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CONTROL_FACT_HEAD_IMMUTABLE'; END IF;
 IF NEW.brand IS DISTINCT FROM OLD.brand OR NEW.revision<=OLD.revision OR (TG_TABLE_NAME='control_fact_heads_v1' AND (to_jsonb(NEW)->>'kind' IS DISTINCT FROM to_jsonb(OLD)->>'kind' OR to_jsonb(NEW)->>'fact_key' IS DISTINCT FROM to_jsonb(OLD)->>'fact_key')) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CONTROL_FACT_HEAD_REGRESSION'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER control_fact_head_monotone_v1 BEFORE UPDATE OR DELETE ON dashboard_crm_controls.control_fact_heads_v1 FOR EACH ROW EXECUTE FUNCTION dashboard_crm_controls.control_fact_head_guard_v1();
CREATE TRIGGER control_fact_brand_head_monotone_v1 BEFORE UPDATE OR DELETE ON dashboard_crm_controls.control_fact_brand_heads_v1 FOR EACH ROW EXECUTE FUNCTION dashboard_crm_controls.control_fact_head_guard_v1();
CREATE TRIGGER control_fact_heads_no_truncate_v1 BEFORE TRUNCATE ON dashboard_crm_controls.control_fact_heads_v1 FOR EACH STATEMENT EXECUTE FUNCTION dashboard_crm_controls.control_fact_history_guard_v1();
CREATE TRIGGER control_fact_brand_heads_no_truncate_v1 BEFORE TRUNCATE ON dashboard_crm_controls.control_fact_brand_heads_v1 FOR EACH STATEMENT EXECUTE FUNCTION dashboard_crm_controls.control_fact_history_guard_v1();
