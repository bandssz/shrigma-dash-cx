-- PROPOSTA OFFLINE (2026-10-03, agente N). NÃO EXECUTADA em produção.
-- Leitura isolada da biblioteca Growth de templates para o portal
-- (principal individual crm-panel-read), com marca obrigatória e filtro no
-- servidor. Substitui, só para leitura, o handler n8n não versionado
-- (acao=listar aceita todas as marcas; historico/submissao sem marca).
-- Aditiva e fresh-only: recusa instalar sobre nomes existentes. Executar
-- somente como owner (postgres) em listmonk, numa instalação revisada; o
-- segredo de LOGIN do papel é provisionado à parte, nunca em Git.
--
-- De onde vem a marca (sem inventar):
--  * e-mail publicado: public.shrigma_template_email_registry(template_id,brand),
--    o mesmo critério das funções versionadas journey-graph-catalog.sql e
--    engagement-editor-validation.sql (registro da marca pedida E nenhum
--    registro de outra marca). Template Listmonk sem registro não tem marca e
--    NÃO aparece (cobertura 'registered_email_only').
--  * histórico e submissão: public.shrigma_template_draft.brand do rascunho
--    (mesmo critério de email-test-recipient.sql).
--  * WhatsApp publicado (Meta): nenhuma tabela versionada liga template
--    aprovado a marca. NÃO é servido aqui (ver PARIDADE-LEITURA-PORTAL §9).
--
-- Colunas não declaradas em SQL versionado (somente em fixtures: evento.at,
-- evento.who, evento.from_version, evento.detail, submissao.rejected_reason,
-- submissao.checked_at, templates.updated_at) são lidas por to_jsonb(linha)
-- e saem null quando ausentes; nada é deduzido.
--
-- Efeito: funções STABLE, sem FOR SHARE/UPDATE, sem INSERT/UPDATE/DELETE, sem
-- chamar a Meta/Listmonk. A autenticação usa shrigma_panel_operator_v1
-- (STABLE); o caminho que grava ultimo_uso (shrigma_panel_auth_v1) não é usado.
DO $crm_template_read_install$
BEGIN
 PERFORM pg_catalog.set_config('lock_timeout','500ms',true);
 IF current_user<>'postgres' OR current_database()<>'listmonk' THEN RAISE EXCEPTION 'CRM_TEMPLATE_READ_OWNER'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='crm_template_reader')
  OR pg_catalog.to_regnamespace('crm_template_read') IS NOT NULL THEN
  RAISE EXCEPTION 'CRM_TEMPLATE_READ_INSTALL_COLLISION';
 END IF;
 IF pg_catalog.to_regclass('public.templates') IS NULL
  OR pg_catalog.to_regclass('public.shrigma_template_email_registry') IS NULL
  OR pg_catalog.to_regclass('public.shrigma_template_draft') IS NULL
  OR pg_catalog.to_regclass('public.shrigma_template_submissao') IS NULL
  OR pg_catalog.to_regclass('public.shrigma_template_evento') IS NULL
  OR pg_catalog.to_regprocedure('public.shrigma_panel_operator_v1(text,text)') IS NULL THEN
  RAISE EXCEPTION 'CRM_TEMPLATE_READ_DEPENDENCY';
 END IF;
 CREATE SCHEMA crm_template_read;
 REVOKE ALL ON SCHEMA crm_template_read FROM PUBLIC;

 -- Somente o principal individual do portal (panel:dcrm-<32 hex>, chave de
 -- 64 hex). Chaves legadas compartilhadas (crm_dash_chave sem hash ou
 -- shrigma_template_key_v2) não leem por aqui. Não concedida ao papel.
 EXECUTE $ddl$CREATE FUNCTION crm_template_read.principal(k text,cap text)
 RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE a jsonb;
 BEGIN
  IF k IS NULL OR k !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'CRM_TEMPLATE_READ_UNAUTHORIZED'; END IF;
  a:=public.shrigma_panel_operator_v1(k,'growth');
  IF a IS NULL OR jsonb_typeof(a->'caps') IS DISTINCT FROM 'array' OR (a->>'who') !~ '^panel:dcrm-[a-f0-9]{32}$' THEN
   RAISE EXCEPTION 'CRM_TEMPLATE_READ_UNAUTHORIZED';
  END IF;
  IF NOT ((a->'caps') ? cap) THEN RAISE EXCEPTION 'CRM_TEMPLATE_READ_ACCESS_DENIED'; END IF;
  RETURN a->>'who';
 END $fn$$ddl$;

 EXECUTE $ddl$CREATE FUNCTION crm_template_read.listar(k text,b text,p_offset integer,p_limit integer)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE total integer;items jsonb;
 BEGIN
  PERFORM crm_template_read.principal(k,'read_content');
  IF b IS NULL OR b NOT IN ('fish','aristo') THEN RAISE EXCEPTION 'CRM_TEMPLATE_READ_BRAND'; END IF;
  IF p_offset IS NULL OR p_offset<0 OR p_offset>100000 OR p_limit IS NULL OR p_limit<1 OR p_limit>50 THEN RAISE EXCEPTION 'CRM_TEMPLATE_READ_PAGE'; END IF;
  WITH owned AS (
   SELECT t.id,t.name::text AS name,t.type::text AS type,to_jsonb(t) AS j,
    (SELECT CASE WHEN count(DISTINCT r.draft_id)=1 THEN max(r.draft_id::text) END FROM public.shrigma_template_email_registry r WHERE r.template_id=t.id) AS draft_id
   FROM public.templates t
   WHERE t.type::text IN ('campaign','tx')
    AND NOT starts_with(t.name,'__shrigma_journey_tx_v1_') AND NOT starts_with(t.name,'__shrigma_graph_tx_v1_')
    AND EXISTS(SELECT 1 FROM public.shrigma_template_email_registry r WHERE r.template_id=t.id AND r.brand=b)
    AND NOT EXISTS(SELECT 1 FROM public.shrigma_template_email_registry r WHERE r.template_id=t.id AND r.brand IS DISTINCT FROM b)
  ),page AS (SELECT * FROM owned ORDER BY id OFFSET p_offset LIMIT p_limit)
  SELECT (SELECT count(*)::int FROM owned),
   coalesce((SELECT jsonb_agg(jsonb_build_object(
    'key','email.template.'||p.id::text,'brand',b,'channel','email','id',p.id::text,
    'name',left(regexp_replace(coalesce(nullif(btrim(p.name),''),'E-mail '||p.id::text),'[[:cntrl:]]','','g'),160),
    'type',p.type,'draft_id',p.draft_id,
    -- Corpo acima do limite de prévia do painel não é truncado: sai sem conteúdo.
    'components',CASE WHEN length(coalesce(p.j->>'body',''))<=400000 AND length(coalesce(p.j->>'subject',''))<=1000
     THEN jsonb_build_object('subject',coalesce(p.j->>'subject',''),'body_html',coalesce(p.j->>'body',''),'altbody',NULL) END,
    'content_available',length(coalesce(p.j->>'body',''))<=400000 AND length(coalesce(p.j->>'subject',''))<=1000,
    'content_hash',encode(sha256(convert_to(jsonb_build_object('type',p.type,'subject',p.j->'subject','body',p.j->'body','body_source',p.j->'body_source')::text,'UTF8')),'hex'),
    'updated_at',p.j->'updated_at') ORDER BY p.id) FROM page p),'[]'::jsonb)
  INTO total,items;
  RETURN jsonb_build_object('contract','crm-template-read-v1','brand',b,'channel','email','templates',items,
   'offset',p_offset,'limit',p_limit,'total',total,'next_offset',CASE WHEN p_offset+p_limit<total THEN p_offset+p_limit END,
   'coverage','registered_email_only','consultado_em',to_jsonb(statement_timestamp()),'schedule_proof',false);
 END $fn$$ddl$;

 EXECUTE $ddl$CREATE FUNCTION crm_template_read.historico(k text,b text,did text)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE events jsonb;n integer;
 BEGIN
  PERFORM crm_template_read.principal(k,'list_history');
  IF b IS NULL OR b NOT IN ('fish','aristo') THEN RAISE EXCEPTION 'CRM_TEMPLATE_READ_BRAND'; END IF;
  IF did IS NULL OR did !~ '^[A-Za-z0-9_-]{1,64}$' THEN RAISE EXCEPTION 'CRM_TEMPLATE_READ_REQUEST'; END IF;
  -- Rascunho de outra marca (ou inexistente) é "não encontrado", sem distinção.
  IF (SELECT count(*) FROM public.shrigma_template_draft d WHERE d.draft_id=did AND d.brand=b)<>1 THEN RAISE EXCEPTION 'CRM_TEMPLATE_READ_NOT_FOUND'; END IF;
  WITH e AS (SELECT to_jsonb(x) AS j FROM public.shrigma_template_evento x WHERE x.draft_id=did),
  ordered AS (SELECT j,row_number() OVER (ORDER BY j->>'at' NULLS FIRST,(j->>'to_version') NULLS FIRST,j::text) AS rn FROM e)
  SELECT (SELECT count(*)::int FROM e),coalesce(jsonb_agg(jsonb_build_object(
   'at',j->'at','who',j->'who','action',j->'action',
   'from_version',CASE WHEN j->>'from_version' ~ '^[0-9]{1,9}$' THEN (j->>'from_version')::int END,
   'to_version',CASE WHEN j->>'to_version' ~ '^[0-9]{1,9}$' THEN (j->>'to_version')::int END,
   'result',j->'result','detail',j->'detail') ORDER BY rn),'[]'::jsonb) INTO n,events FROM ordered WHERE rn<=200;
  RETURN jsonb_build_object('contract','crm-template-history-read-v1','brand',b,'draft_id',did,'events',events,'truncated',n>200,
   'read_at',to_jsonb(statement_timestamp()));
 END $fn$$ddl$;

 EXECUTE $ddl$CREATE FUNCTION crm_template_read.submissao(k text,b text,sid text)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE j jsonb;n integer;
 BEGIN
  PERFORM crm_template_read.principal(k,'submission');
  IF b IS NULL OR b NOT IN ('fish','aristo') THEN RAISE EXCEPTION 'CRM_TEMPLATE_READ_BRAND'; END IF;
  IF sid IS NULL OR sid !~ '^[A-Za-z0-9_-]{1,64}$' THEN RAISE EXCEPTION 'CRM_TEMPLATE_READ_REQUEST'; END IF;
  SELECT count(*)::int,max(to_jsonb(s)::text)::jsonb INTO n,j FROM public.shrigma_template_submissao s
   JOIN public.shrigma_template_draft d ON d.draft_id=s.draft_id
   WHERE s.submission_id=sid AND d.brand=b;
  IF n<>1 THEN RAISE EXCEPTION 'CRM_TEMPLATE_READ_NOT_FOUND'; END IF;
  -- Estado gravado. A leitura não consulta a Meta/Listmonk: provider_polled=false.
  RETURN jsonb_build_object('contract','crm-template-submission-read-v1','brand',b,'submission_id',sid,
   'draft_id',j->'draft_id','draft_version',CASE WHEN j->>'draft_version' ~ '^[0-9]{1,9}$' THEN (j->>'draft_version')::int END,
   'provider',j->'provider','estado',j->'estado','provider_status',j->'provider_status','rejected_reason',j->'rejected_reason',
   'checked_at',j->'checked_at','read_at',to_jsonb(statement_timestamp()),'provider_polled',false);
 END $fn$$ddl$;
 REVOKE ALL ON ALL FUNCTIONS IN SCHEMA crm_template_read FROM PUBLIC;

 CREATE ROLE crm_template_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
 ALTER ROLE crm_template_reader SET default_transaction_read_only=on;
 ALTER ROLE crm_template_reader SET statement_timeout='8s';
 ALTER ROLE crm_template_reader SET lock_timeout='500ms';
 ALTER ROLE crm_template_reader SET idle_in_transaction_session_timeout='15s';
 ALTER ROLE crm_template_reader SET search_path=pg_catalog;
 GRANT CONNECT ON DATABASE listmonk TO crm_template_reader;
 GRANT USAGE ON SCHEMA crm_template_read TO crm_template_reader;
 -- Nenhuma tabela; só as três leituras com marca obrigatória.
 GRANT EXECUTE ON FUNCTION crm_template_read.listar(text,text,integer,integer),
  crm_template_read.historico(text,text,text),crm_template_read.submissao(text,text,text) TO crm_template_reader;
END $crm_template_read_install$;

-- Conferência pós-instalação (somente leitura; esperado: zero linhas em cada uma).
-- 1) Nenhum privilégio de tabela:
--   SELECT table_schema,table_name,privilege_type FROM information_schema.role_table_grants WHERE grantee='crm_template_reader';
-- 2) Só as três funções executáveis no schema novo e nada de autenticação com escrita:
--   SELECT p.oid::regprocedure FROM pg_proc p WHERE has_function_privilege('crm_template_reader',p.oid,'EXECUTE')
--   AND (p.pronamespace='crm_template_read'::regnamespace AND p.proname NOT IN ('listar','historico','submissao')
--    OR p.oid::regprocedure::text IN ('shrigma_panel_auth_v1(text,text,text)','shrigma_panel_operator_v1(text,text)','shrigma_template_auth_v2(text)'));
-- 3) Nenhuma associação a outros papéis:
--   SELECT * FROM pg_auth_members WHERE member='crm_template_reader'::regrole;

-- Reversão (serviço de leitura desligado, sem conexões):
--   DROP SCHEMA crm_template_read CASCADE; DROP OWNED BY crm_template_reader; DROP ROLE crm_template_reader;
