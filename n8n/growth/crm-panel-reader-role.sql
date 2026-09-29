-- Additive, starts NOLOGIN. The deployment sets a generated password separately.
DO $crm_panel_reader$
BEGIN
 PERFORM pg_catalog.set_config('lock_timeout','500ms',true);
 IF current_user<>'postgres' OR current_database()<>'listmonk' THEN RAISE EXCEPTION 'CRM_PANEL_READER_OWNER'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_panel_reader') THEN RAISE EXCEPTION 'CRM_PANEL_READER_ALREADY_EXISTS'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.shrigma_crm_read_fast_v1(text,text,jsonb)'::regprocedure AND proowner::regrole::text='postgres' AND prosecdef AND md5(prosrc)='0c3b2e1b3094cccae44fa2b89fbfb18b') THEN RAISE EXCEPTION 'CRM_PANEL_READER_FUNCTION_DRIFT'; END IF;
 CREATE ROLE crm_panel_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
 GRANT CONNECT ON DATABASE listmonk TO crm_panel_reader;
 GRANT USAGE ON SCHEMA public TO crm_panel_reader;
 GRANT EXECUTE ON FUNCTION public.shrigma_crm_read_fast_v1(text,text,jsonb) TO crm_panel_reader;
 ALTER ROLE crm_panel_reader SET statement_timeout='8s';
 ALTER ROLE crm_panel_reader SET lock_timeout='500ms';
 ALTER ROLE crm_panel_reader SET search_path=pg_catalog,public;
END $crm_panel_reader$;
