-- PROPOSTA OFFLINE (2026-10-03). NÃO EXECUTADA em produção por esta entrega.
-- Leitura isolada de listas, públicos salvos e vínculo de campanha para o
-- portal (crm-panel-read). Aditiva, fresh-only: recusa instalar sobre nomes
-- existentes. Executar somente como owner (postgres) em listmonk, numa
-- instalação revisada; o segredo de LOGIN é provisionado à parte, nunca em Git.
--
-- Por que funções novas: crm_audience_v2.config_snapshot/catalog_lists e
-- crm_audience_v2.campaign_snapshot usam FOR SHARE/FOR UPDATE (bloqueio de
-- linha = escrita em xmax/multixact). Em transação READ ONLY o PostgreSQL
-- recusa "SELECT FOR SHARE"; e refresh_native_catalog grava config. As
-- funções abaixo leem o mesmo dado sem bloqueio e sem escrita.
DO $crm_audience_read_install$
BEGIN
 PERFORM pg_catalog.set_config('lock_timeout','500ms',true);
 IF current_user<>'postgres' OR current_database()<>'listmonk' THEN RAISE EXCEPTION 'CRM_AUDIENCE_READ_OWNER'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='crm_audience_reader')
  OR pg_catalog.to_regnamespace('crm_audience_read') IS NOT NULL THEN
  RAISE EXCEPTION 'CRM_AUDIENCE_READ_INSTALL_COLLISION';
 END IF;
 IF pg_catalog.to_regclass('crm_audience_v2.config') IS NULL
  OR pg_catalog.to_regclass('crm_audience_v2.audience') IS NULL
  OR pg_catalog.to_regclass('crm_audience_v2.campaign_binding') IS NULL
  OR pg_catalog.to_regclass('crm_audience_v2.campaign_binding_release') IS NULL
  OR pg_catalog.to_regprocedure('crm_audience_v2.authenticate(text)') IS NULL
  OR pg_catalog.to_regprocedure('public.shrigma_campaign_list_brand(public.lists)') IS NULL
  OR pg_catalog.to_regprocedure('public.shrigma_campaign_current(integer)') IS NULL THEN
  RAISE EXCEPTION 'CRM_AUDIENCE_READ_DEPENDENCY';
 END IF;
 CREATE SCHEMA crm_audience_read;
 REVOKE ALL ON SCHEMA crm_audience_read FROM PUBLIC;
 -- Mesma linha de crm_audience_v2.config_snapshot, sem FOR SHARE.
 EXECUTE $ddl$CREATE FUNCTION crm_audience_read.config_snapshot(b text)
 RETURNS SETOF crm_audience_v2.config LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT * FROM crm_audience_v2.config WHERE brand=b AND b IN ('fish','aristo')
 $fn$$ddl$;
 -- Mesmas listas de crm_audience_v2.catalog_lists, sem FOR SHARE OF l.
 EXECUTE $ddl$CREATE FUNCTION crm_audience_read.catalog_lists(b text)
 RETURNS TABLE(id integer,name text,status text,optin text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT l.id,l.name::text,l.status::text,l.optin::text FROM public.lists l
 WHERE b IN ('fish','aristo') AND public.shrigma_campaign_list_brand(l)=b
 ORDER BY l.id LIMIT 1001
 $fn$$ddl$;
 -- Estado atual da campanha CRM (mesma versão md5 do provider), sem lock e
 -- sem conceder SELECT nas tabelas nativas ao papel de leitura.
 EXECUTE $ddl$CREATE FUNCTION crm_audience_read.campaign_current(cid integer)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT public.shrigma_campaign_current(cid)
 $fn$$ddl$;
 REVOKE ALL ON ALL FUNCTIONS IN SCHEMA crm_audience_read FROM PUBLIC;

 CREATE ROLE crm_audience_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
 ALTER ROLE crm_audience_reader SET default_transaction_read_only=on;
 ALTER ROLE crm_audience_reader SET statement_timeout='8s';
 ALTER ROLE crm_audience_reader SET lock_timeout='500ms';
 ALTER ROLE crm_audience_reader SET idle_in_transaction_session_timeout='15s';
 ALTER ROLE crm_audience_reader SET search_path=pg_catalog;
 GRANT CONNECT ON DATABASE listmonk TO crm_audience_reader;
 GRANT USAGE ON SCHEMA crm_audience_read,crm_audience_v2 TO crm_audience_reader;
 -- Somente SELECT; nenhuma tabela de recibo/contador/config/revisão.
 GRANT SELECT ON crm_audience_v2.audience,crm_audience_v2.campaign_binding,crm_audience_v2.campaign_binding_release TO crm_audience_reader;
 GRANT EXECUTE ON FUNCTION crm_audience_v2.authenticate(text),crm_audience_read.config_snapshot(text),
  crm_audience_read.catalog_lists(text),crm_audience_read.campaign_current(integer) TO crm_audience_reader;
 -- Evidências opcionais (STABLE, somente leitura) existem só em algumas
 -- instalações; o catálogo as consulta apenas quando o config as anuncia.
 IF pg_catalog.to_regprocedure('crm_audience_v2.recorded_origin_source_current(text,text,text)') IS NOT NULL THEN
  GRANT EXECUTE ON FUNCTION crm_audience_v2.recorded_origin_source_current(text,text,text) TO crm_audience_reader;
 END IF;
 IF pg_catalog.to_regprocedure('crm_audience_v2.shopify_snapshot(text)') IS NOT NULL THEN
  GRANT EXECUTE ON FUNCTION crm_audience_v2.shopify_snapshot(text) TO crm_audience_reader;
 END IF;
 IF pg_catalog.to_regprocedure('crm_audience_v2.rfm_snapshot(text)') IS NOT NULL THEN
  GRANT EXECUTE ON FUNCTION crm_audience_v2.rfm_snapshot(text) TO crm_audience_reader;
 END IF;
END $crm_audience_read_install$;

-- Conferência pós-instalação (somente leitura; o resultado esperado é zero
-- linhas em cada consulta). Rodar antes de qualquer LOGIN.
-- 1) Nenhum privilégio de escrita direto:
--   SELECT table_schema,table_name,privilege_type FROM information_schema.role_table_grants
--   WHERE grantee='crm_audience_reader' AND privilege_type<>'SELECT';
-- 2) Nenhuma função de escrita executável:
--   SELECT p.oid::regprocedure FROM pg_proc p WHERE has_function_privilege('crm_audience_reader',p.oid,'EXECUTE')
--   AND p.pronamespace IN ('crm_audience_v2'::regnamespace,'public'::regnamespace)
--   AND p.oid::regprocedure::text IN ('crm_audience_v2.refresh_native_catalog(text)','crm_audience_v2.touch_campaign(integer)',
--    'crm_audience_v2.campaign_snapshot(integer,boolean)','crm_audience_v2.lock_campaign_dependencies(integer)',
--    'crm_audience_v2.config_snapshot(text)','crm_audience_v2.catalog_lists(text)','public.shrigma_campaign_provider(text,jsonb)');
-- 3) Nenhuma associação a outros papéis:
--   SELECT * FROM pg_auth_members WHERE member='crm_audience_reader'::regrole;

-- Reversão (somente com o serviço de leitura desligado e sem conexões):
--   DROP ROLE crm_audience_reader exige REVOKE prévio; DROP SCHEMA crm_audience_read CASCADE.
