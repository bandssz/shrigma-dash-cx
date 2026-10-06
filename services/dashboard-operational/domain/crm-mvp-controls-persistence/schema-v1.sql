-- Static PostgreSQL17 proposal. Root-only future installation; no installer.
CREATE SCHEMA dashboard_crm_controls;
CREATE TABLE dashboard_crm_controls.crm_mvp_operations_v1 (
 brand text NOT NULL CHECK (brand IN ('fish','aristo')),
 operation_id uuid NOT NULL CHECK (operation_id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
 attempt_id uuid NOT NULL CHECK (attempt_id=operation_id),
 principal_ref_hash text NOT NULL CHECK (principal_ref_hash ~ '^[a-f0-9]{64}$'),
 registration_evidence_hash text NOT NULL CHECK (registration_evidence_hash ~ '^[a-f0-9]{64}$'),
 revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
 state text NOT NULL CHECK (state IN ('registered','reserved','uncertain','accepted','rejected_before_send')),
 reservation_attempted boolean NOT NULL,
 outcome_write_state text NOT NULL CHECK (outcome_write_state IN ('idle','pending','uncertain')),
 registered_at bigint NOT NULL CHECK (registered_at BETWEEN 0 AND 9007199254740991),
 updated_at bigint NOT NULL CHECK (updated_at BETWEEN registered_at AND 9007199254740991),
 receipt_hash text NOT NULL CHECK (receipt_hash ~ '^[a-f0-9]{64}$'),
 scope jsonb,
 reservation boolean NOT NULL,
 reserved_member_count bigint,
 reserved_members_hash text,
 capacity_evidence_hash text,
 CHECK (state<>'registered' OR (NOT reservation_attempted AND revision=1) OR (reservation_attempted AND revision=2)),
 CHECK (state NOT IN ('accepted','rejected_before_send') OR outcome_write_state='idle'),
 PRIMARY KEY (brand,operation_id), UNIQUE (brand,attempt_id), UNIQUE (brand,operation_id,attempt_id),
 CHECK ((state='registered' AND scope IS NULL AND NOT reservation AND reserved_member_count IS NULL AND reserved_members_hash IS NULL AND capacity_evidence_hash IS NULL AND outcome_write_state='idle') OR
        (state<>'registered' AND scope IS NOT NULL AND reserved_member_count IS NOT NULL AND reserved_members_hash IS NOT NULL AND capacity_evidence_hash IS NOT NULL AND reservation AND reservation_attempted AND reserved_member_count=(scope->>'memberCount')::bigint AND reserved_members_hash=scope->>'membersHash' AND capacity_evidence_hash=scope->>'evidenceHash')),
 CHECK (scope IS NULL OR (jsonb_typeof(scope) = 'object' AND
 scope ?& ARRAY['brand','operationId','distributionId','selectionHash','membersHash','memberCount','campaignId','campaignVersion','ledgerRevision','evidenceRevision','evidenceHash','expiresAt'] AND
 scope - ARRAY['brand','operationId','distributionId','selectionHash','membersHash','memberCount','campaignId','campaignVersion','ledgerRevision','evidenceRevision','evidenceHash','expiresAt'] = '{}'::jsonb AND
 scope->>'brand' = brand AND
 scope->>'operationId' = operation_id::text AND
 scope->>'distributionId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND
 jsonb_typeof(scope->'selectionHash') = 'string' AND
 scope->>'selectionHash' ~ '^[a-f0-9]{64}$' AND
 jsonb_typeof(scope->'membersHash') = 'string' AND
 scope->>'membersHash' ~ '^[a-f0-9]{64}$' AND
 jsonb_typeof(scope->'evidenceHash') = 'string' AND
 scope->>'evidenceHash' ~ '^[a-f0-9]{64}$' AND
 jsonb_typeof(scope->'memberCount') = 'number' AND
 (scope->>'memberCount')::numeric BETWEEN 1 AND 9007199254740991 AND
 (scope->>'memberCount')::numeric = trunc((scope->>'memberCount')::numeric) AND
 jsonb_typeof(scope->'campaignId') = 'number' AND
 (scope->>'campaignId')::numeric BETWEEN 1 AND 9007199254740991 AND
 (scope->>'campaignId')::numeric = trunc((scope->>'campaignId')::numeric) AND
 jsonb_typeof(scope->'campaignVersion') = 'number' AND
 (scope->>'campaignVersion')::numeric BETWEEN 1 AND 9007199254740991 AND
 (scope->>'campaignVersion')::numeric = trunc((scope->>'campaignVersion')::numeric) AND
 jsonb_typeof(scope->'ledgerRevision') = 'number' AND
 (scope->>'ledgerRevision')::numeric BETWEEN 1 AND 9007199254740991 AND
 (scope->>'ledgerRevision')::numeric = trunc((scope->>'ledgerRevision')::numeric) AND
 jsonb_typeof(scope->'evidenceRevision') = 'number' AND
 (scope->>'evidenceRevision')::numeric BETWEEN 1 AND 9007199254740991 AND
 (scope->>'evidenceRevision')::numeric = trunc((scope->>'evidenceRevision')::numeric) AND
 jsonb_typeof(scope->'expiresAt') = 'number' AND
 (scope->>'expiresAt')::numeric BETWEEN 1 AND 9007199254740991 AND
 (scope->>'expiresAt')::numeric = trunc((scope->>'expiresAt')::numeric) AND
 (scope->>'memberCount')::numeric <= 100000) IS TRUE)
);
CREATE TABLE dashboard_crm_controls.crm_mvp_outcome_intents_v1 (
 brand text NOT NULL CHECK (brand IN ('fish','aristo')),
 operation_id uuid NOT NULL,
 attempt_id uuid NOT NULL CHECK (attempt_id=operation_id),
 expected_operation_revision bigint NOT NULL CHECK (expected_operation_revision BETWEEN 1 AND 9007199254740990),
 target_outcome text NOT NULL CHECK (target_outcome IN ('unknown','accepted','rejected_before_send')),
 evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
 prior_scope_hash text NOT NULL CHECK (prior_scope_hash ~ '^[a-f0-9]{64}$'),
 created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
 phase text NOT NULL CHECK (phase IN ('pending','finished')),
 PRIMARY KEY (brand,operation_id,expected_operation_revision),
 FOREIGN KEY (brand,operation_id,attempt_id) REFERENCES dashboard_crm_controls.crm_mvp_operations_v1 (brand,operation_id,attempt_id)
);
-- Guards protect immutable facts/fences even against an accidentally broad UPDATE.
-- Native role/DDL/function admission still belongs to Root; no privileges are issued.
CREATE FUNCTION dashboard_crm_controls.guard_operation_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CRM_CONTROLS_HISTORY_IMMUTABLE'; END IF;
 IF NEW.brand IS DISTINCT FROM OLD.brand OR NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id OR NEW.principal_ref_hash IS DISTINCT FROM OLD.principal_ref_hash OR NEW.registration_evidence_hash IS DISTINCT FROM OLD.registration_evidence_hash OR NEW.registered_at IS DISTINCT FROM OLD.registered_at THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CRM_CONTROLS_IDENTITY_IMMUTABLE'; END IF;
 IF OLD.reservation_attempted AND NOT NEW.reservation_attempted THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CRM_CONTROLS_FENCE_IRREVERSIBLE'; END IF;
 IF NEW.revision<OLD.revision OR NEW.revision>OLD.revision+1 OR NEW.updated_at<OLD.updated_at THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CRM_CONTROLS_REVISION_REFUSED'; END IF;
 IF OLD.state IN ('accepted','rejected_before_send') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CRM_CONTROLS_TERMINAL_IMMUTABLE'; END IF;
 IF OLD.scope IS NOT NULL AND (NEW.scope IS DISTINCT FROM OLD.scope OR NEW.reservation IS DISTINCT FROM OLD.reservation OR NEW.reserved_member_count IS DISTINCT FROM OLD.reserved_member_count OR NEW.reserved_members_hash IS DISTINCT FROM OLD.reserved_members_hash OR NEW.capacity_evidence_hash IS DISTINCT FROM OLD.capacity_evidence_hash) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CRM_CONTROLS_RESERVATION_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_controls_operation_guard BEFORE UPDATE OR DELETE ON dashboard_crm_controls.crm_mvp_operations_v1 FOR EACH ROW EXECUTE FUNCTION dashboard_crm_controls.guard_operation_v1();
CREATE TRIGGER crm_controls_operation_truncate_guard BEFORE TRUNCATE ON dashboard_crm_controls.crm_mvp_operations_v1 FOR EACH STATEMENT EXECUTE FUNCTION dashboard_crm_controls.guard_operation_v1();
CREATE FUNCTION dashboard_crm_controls.guard_intent_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CRM_CONTROLS_HISTORY_IMMUTABLE'; END IF;
 IF NEW.brand IS DISTINCT FROM OLD.brand OR NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id OR NEW.expected_operation_revision IS DISTINCT FROM OLD.expected_operation_revision OR NEW.target_outcome IS DISTINCT FROM OLD.target_outcome OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash OR NEW.prior_scope_hash IS DISTINCT FROM OLD.prior_scope_hash OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.phase='finished' AND NEW.phase<>'finished' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CRM_CONTROLS_INTENT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_controls_intent_guard BEFORE UPDATE OR DELETE ON dashboard_crm_controls.crm_mvp_outcome_intents_v1 FOR EACH ROW EXECUTE FUNCTION dashboard_crm_controls.guard_intent_v1();
CREATE TRIGGER crm_controls_intent_truncate_guard BEFORE TRUNCATE ON dashboard_crm_controls.crm_mvp_outcome_intents_v1 FOR EACH STATEMENT EXECUTE FUNCTION dashboard_crm_controls.guard_intent_v1();
