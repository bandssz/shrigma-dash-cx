-- Local, fresh-only candidate. The JS service is the trusted validator/writer;
-- this schema is never exposed as an HTTP/RPC endpoint. No grants to app roles.
DO $audience_store_install$
BEGIN
 IF pg_catalog.to_regnamespace('crm_audience_v2') IS NOT NULL THEN
  RAISE EXCEPTION 'AUDIENCE_STORE_INSTALL_COLLISION';
 END IF;
 IF pg_catalog.to_regprocedure('public.shrigma_panel_operator_v1(text,text)') IS NULL
 OR pg_catalog.to_regprocedure('public.shrigma_campaign_list_brand(public.lists)') IS NULL THEN
  RAISE EXCEPTION 'AUDIENCE_STORE_DEPENDENCY';
 END IF;
 PERFORM pg_catalog.set_config('lock_timeout','500ms',true);
 CREATE SCHEMA crm_audience_v2;
 REVOKE ALL ON SCHEMA crm_audience_v2 FROM PUBLIC;
 CREATE TABLE crm_audience_v2.config (
  brand text PRIMARY KEY CHECK (brand IN ('fish','aristo')),
  enabled boolean NOT NULL DEFAULT false,
  base_list_id integer CHECK (base_list_id > 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  catalog jsonb,
  checked_at timestamptz,
  expires_at timestamptz,
  CHECK (NOT enabled OR (base_list_id IS NOT NULL AND catalog IS NOT NULL AND
    checked_at IS NOT NULL AND expires_at > checked_at AND expires_at <= checked_at + interval '5 minutes'))
 );
 INSERT INTO crm_audience_v2.config(brand) VALUES ('fish'),('aristo');
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.config_snapshot(b text)
 RETURNS SETOF crm_audience_v2.config LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT * FROM crm_audience_v2.config WHERE brand=b AND b IN ('fish','aristo') FOR SHARE
 $fn$$ddl$;
 -- PostgreSQL row locks require UPDATE privilege. Keep that privilege out of
 -- the HTTP role: this bounded helper only reads/locks the two CRM brands.
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.catalog_lists(b text)
 RETURNS TABLE(id integer,name text,status text,optin text)
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT l.id,l.name::text,l.status::text,l.optin::text FROM public.lists l
 WHERE b IN ('fish','aristo') AND public.shrigma_campaign_list_brand(l)=b
 ORDER BY l.id LIMIT 1001 FOR SHARE OF l
 $fn$$ddl$;
 -- The HTTP role can authenticate one supplied key; it cannot enumerate keys,
 -- hashes, owners or the permission registry. Preserve the live-clock check.
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.authenticate(k text)
 RETURNS TABLE(operator jsonb,live_count integer,live_actor text)
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 WITH live AS MATERIALIZED (SELECT 'panel:'||c.chave AS actor FROM public.crm_dash_chave c JOIN public.shrigma_panel_permission_v1 p ON p.principal_id=c.chave AND p.area='growth' WHERE c.painel IN('growth','todos') AND c.ativo AND c.revogada_em IS NULL AND (c.expira_em IS NULL OR c.expira_em>pg_catalog.clock_timestamp()) AND c.chave_hash IS NOT NULL AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(k,'UTF8')),'hex') IN(c.chave_hash,c.chave_hash_curta)) SELECT public.shrigma_panel_operator_v1(k,'growth') AS operator,(SELECT pg_catalog.count(*)::integer FROM live) AS live_count,(SELECT pg_catalog.min(actor) FROM live) AS live_actor
 $fn$$ddl$;
 CREATE TABLE crm_audience_v2.audience (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  brand text NOT NULL CHECK (brand IN ('fish','aristo')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object' AND definition->>'schema_version'='crm-audience-v2'),
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  context jsonb NOT NULL CHECK (jsonb_typeof(context)='object'),
  context_hash text NOT NULL CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  archived boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (definition->>'brand'=brand AND definition->>'name'=name)
 );
 CREATE INDEX audience_brand_updated ON crm_audience_v2.audience(brand,updated_at DESC,id);
 CREATE TABLE crm_audience_v2.revision (
  audience_id uuid NOT NULL REFERENCES crm_audience_v2.audience(id),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 999999999),
  definition jsonb NOT NULL,
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  context jsonb NOT NULL,
  context_hash text NOT NULL CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  archived boolean NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(audience_id,version)
 );
 ALTER TABLE crm_audience_v2.audience ADD CONSTRAINT current_revision_exists
  FOREIGN KEY (id,version) REFERENCES crm_audience_v2.revision(audience_id,version) DEFERRABLE INITIALLY DEFERRED;
 CREATE TABLE crm_audience_v2.request (
  actor text NOT NULL CHECK (actor ~ '^panel:[A-Za-z0-9_.:-]{1,194}$'),
  operation_key text NOT NULL CHECK (operation_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  brand text NOT NULL CHECK (brand IN ('fish','aristo')),
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(actor,operation_key)
 );
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.append_only() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 BEGIN RAISE EXCEPTION 'AUDIENCE_HISTORY_IMMUTABLE'; END $fn$$ddl$;
 CREATE TRIGGER revision_append_only BEFORE UPDATE OR DELETE ON crm_audience_v2.revision
  FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.append_only();
 CREATE TRIGGER request_append_only BEFORE UPDATE OR DELETE ON crm_audience_v2.request
  FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.append_only();
 REVOKE ALL ON ALL TABLES IN SCHEMA crm_audience_v2 FROM PUBLIC;
 REVOKE ALL ON ALL FUNCTIONS IN SCHEMA crm_audience_v2 FROM PUBLIC;
END $audience_store_install$;
