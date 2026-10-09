CREATE ROLE shrigma_app_runtime_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
--@@
CREATE SCHEMA dashboard_crm_controls AUTHORIZATION CURRENT_USER;
--@@
REVOKE ALL ON SCHEMA dashboard_crm_controls FROM PUBLIC;
--@@
GRANT USAGE ON SCHEMA dashboard_crm_controls TO shrigma_app_runtime_v1;
--@@
CREATE TABLE dashboard_crm_controls.foundation_operation_v1 (
 operation_id uuid PRIMARY KEY,
 capsule_id text NOT NULL CHECK (capsule_id='shrigma-own-foundation-bootstrap-v1'),
 capsule_sha256 text NOT NULL CHECK (capsule_sha256 ~ '^[a-f0-9]{64}$'),
 target_sha256 text NOT NULL CHECK (target_sha256 ~ '^[a-f0-9]{64}$'),
 admission_receipt_sha256 text NOT NULL CHECK (admission_receipt_sha256 ~ '^[a-f0-9]{64}$'),
 reservation_receipt_sha256 text NOT NULL CHECK (reservation_receipt_sha256 ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK (state='applied'),
 applied_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp()
);
--@@
REVOKE ALL ON TABLE dashboard_crm_controls.foundation_operation_v1 FROM PUBLIC;
