-- Extend the existing application queue. No customer, Listmonk or public DDL.
BEGIN;
SET LOCAL lock_timeout='250ms';
SET LOCAL statement_timeout='5s';
ALTER TABLE crm_worker.tasks_v1 DROP CONSTRAINT tasks_v1_kind_check;
ALTER TABLE crm_worker.tasks_v1 ADD CONSTRAINT tasks_v1_kind_check
 CHECK(kind IN ('wa.test','wa.schedule','wa.message','email.schedule','audience.resolve'));
COMMIT;
