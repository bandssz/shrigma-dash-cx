-- Product migration W2. Only the admitted application schema, never public.
BEGIN;
SET LOCAL lock_timeout='250ms';
SET LOCAL statement_timeout='5s';
CREATE TABLE crm_worker.campaigns_v1 (
 id uuid PRIMARY KEY, brand text NOT NULL CHECK(brand IN ('fish','aristo')),
 owner_id text NOT NULL, revision integer NOT NULL CHECK(revision>0),
 name text NOT NULL, definition jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('draft','scheduled','cancelled')),
 source_revision text NOT NULL CHECK(source_revision ~ '^[a-f0-9]{40}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE crm_worker.tasks_v1 (
 id uuid PRIMARY KEY, campaign_id uuid NOT NULL REFERENCES crm_worker.campaigns_v1(id),
 parent_id uuid REFERENCES crm_worker.tasks_v1(id),
 brand text NOT NULL CHECK(brand IN ('fish','aristo')), owner_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('wa.test','wa.schedule','wa.message')),
 identity text NOT NULL UNIQUE, source_revision text NOT NULL CHECK(source_revision ~ '^[a-f0-9]{40}$'),
 campaign_revision integer NOT NULL, payload jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','leased','sending','accepted','refused','uncertain','cancelled')),
 run_at timestamptz NOT NULL, lease_token uuid, lease_until timestamptz,
 attempt integer NOT NULL DEFAULT 0, provider_id text, safe_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((state IN ('leased','sending'))=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX tasks_v1_due ON crm_worker.tasks_v1(run_at,id) WHERE state='pending';
CREATE INDEX tasks_v1_campaign ON crm_worker.tasks_v1(brand,owner_id,campaign_id);
CREATE TABLE crm_worker.attempts_v1 (
 task_id uuid NOT NULL REFERENCES crm_worker.tasks_v1(id), attempt integer NOT NULL,
 lease_token uuid NOT NULL, source_revision text NOT NULL, state text NOT NULL,
 provider_id text, safe_code text, started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
 PRIMARY KEY(task_id,attempt)
);
-- Existing schema defaults grant DML to crm_api/crm_worker. No grants/roles/functions/triggers here.
COMMIT;
