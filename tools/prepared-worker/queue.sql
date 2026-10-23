-- CONTRACT ONLY. Not installed by the image, API or worker.
-- Apply only after a dedicated Shrigma queue PostgreSQL binding is admitted.
-- Never apply this schema in Listmonk or an unrelated/shared service database.
BEGIN;
CREATE SCHEMA shrigma_worker;
CREATE TABLE shrigma_worker.tasks (
 id uuid PRIMARY KEY,
 brand text NOT NULL CHECK (brand IN ('aristo','fish')),
 kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.-]{0,79}$'),
 event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
 execution_revision char(40) NOT NULL CHECK (execution_revision ~ '^[a-f0-9]{40}$'),
 payload_ref text NOT NULL CHECK (length(payload_ref) BETWEEN 1 AND 512),
 available_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','succeeded','failed','cancelled')),
 owner text CHECK (length(owner) BETWEEN 1 AND 128),
 ownership_token uuid,
 acquired_at timestamptz,
 attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
 max_attempts integer NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 100),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 UNIQUE (brand,kind,event_id),
 CHECK (attempt_count <= max_attempts),
 CHECK ((state='running' AND owner IS NOT NULL AND ownership_token IS NOT NULL AND acquired_at IS NOT NULL AND attempt_count>0)
     OR (state<>'running' AND owner IS NULL AND ownership_token IS NULL AND acquired_at IS NULL)),
 CHECK ((state IN ('succeeded','failed','cancelled') AND finished_at IS NOT NULL) OR (state IN ('pending','running') AND finished_at IS NULL))
);
CREATE INDEX tasks_ready ON shrigma_worker.tasks (execution_revision,available_at,id) WHERE state='pending';
CREATE TABLE shrigma_worker.attempts (
 task_id uuid NOT NULL REFERENCES shrigma_worker.tasks(id) ON DELETE RESTRICT,
 attempt_no integer NOT NULL CHECK (attempt_no>0),
 owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 128),
 ownership_token uuid NOT NULL,
 started_at timestamptz NOT NULL,
 finished_at timestamptz,
 outcome text CHECK (outcome IN ('succeeded','failed','cancelled')),
 PRIMARY KEY (task_id,attempt_no),
 CHECK ((finished_at IS NULL AND outcome IS NULL) OR (finished_at IS NOT NULL AND outcome IS NOT NULL AND finished_at>=started_at))
);
REVOKE ALL ON SCHEMA shrigma_worker FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA shrigma_worker FROM PUBLIC;
COMMIT;
