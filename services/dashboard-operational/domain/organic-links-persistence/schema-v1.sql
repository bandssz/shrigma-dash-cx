-- C2 · organic-links-persistence · schema-v1 (ADITIVO)
-- Persistência própria de links UTM do Orgânico no PostgreSQL central, namespace EXISTENTE dashboard_crm_controls.
-- Preparado por C2, aplicado somente por Root (DDL/roles/grants/migração são de Root). Fonte apenas; não operacional.
-- Não cria schema, role, banco, extensão, grant nem dado. Não importa registros legados (organico_link_utm_v1/planilha):
-- eles continuam na leitura legada; revisão 1 nasce só de criação original comprovada por operação deste módulo.
-- Reaplicável: CREATE ... IF NOT EXISTS e CREATE OR REPLACE (PostgreSQL >= 14; alvo PG17).

CREATE TABLE IF NOT EXISTS dashboard_crm_controls.organic_links_v1 (
  brand                  text        NOT NULL CHECK (brand IN ('aristo', 'fish')),
  link_id                text        NOT NULL CHECK (link_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  destination            text        NOT NULL CHECK (char_length(destination) BETWEEN 9 AND 2000 AND destination LIKE 'https://%'),
  origin                 text        NOT NULL CHECK (origin IN ('instagram_social', 'facebook_social', 'tiktok_social', 'youtube', 'whatsapp')),
  surface                text        NOT NULL CHECK (surface IN ('story', 'linktree', 'dm', 'feed', 'reels', 'comunidade', 'direct', 'grupo')),
  campaign               text        NOT NULL CHECK (campaign ~ '^[A-Za-z0-9_-]{2,60}$'),
  campaign_date          date        NULL,
  utm_campaign           text        NOT NULL CHECK (utm_campaign ~ '^([0-9]{8}_)?[A-Za-z0-9_-]{2,60}$'),
  url                    text        NOT NULL CHECK (char_length(url) <= 2400 AND url LIKE 'https://%'),
  state                  text        NOT NULL CHECK (state IN ('active', 'archived')),
  revision               integer     NOT NULL CHECK (revision >= 1),
  created_operation_id   text        NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  archived_operation_id  text        NULL,
  archived_at            timestamptz NULL,
  CONSTRAINT organic_links_v1_pk PRIMARY KEY (brand, link_id),
  CONSTRAINT organic_links_v1_link_id_uq UNIQUE (link_id),
  CONSTRAINT organic_links_v1_brand_url_uq UNIQUE (brand, url),
  CONSTRAINT organic_links_v1_utm_campaign_ck CHECK (
    (campaign_date IS NULL AND utm_campaign = campaign) OR
    (campaign_date IS NOT NULL AND utm_campaign = to_char(campaign_date, 'YYYYMMDD') || '_' || campaign)),
  CONSTRAINT organic_links_v1_archive_ck CHECK (
    (state = 'active' AND archived_operation_id IS NULL AND archived_at IS NULL) OR
    (state = 'archived' AND archived_operation_id IS NOT NULL AND archived_at IS NOT NULL AND revision >= 2))
);

CREATE TABLE IF NOT EXISTS dashboard_crm_controls.organic_link_operations_v1 (
  operation_id              text        NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  brand                     text        NOT NULL CHECK (brand IN ('aristo', 'fish')),
  kind                      text        NOT NULL CHECK (kind IN ('link.create', 'link.archive')),
  intent_hash               text        NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  record_id                 text        NOT NULL,
  expected_record_revision  integer     NULL,
  outcome                   text        NOT NULL CHECK (outcome IN ('confirmed', 'rejected')),
  reason                    text        NULL CHECK (reason IS NULL OR reason ~ '^[a-z_]{3,48}$'),
  result_revision           integer     NULL,
  receipt_reference         text        NOT NULL CHECK (receipt_reference ~ '^olr1-[0-9a-f]{40}$'),
  context_revision          text        NOT NULL,
  session_revision          text        NULL,
  actor_reference           text        NOT NULL,
  actor_role                text        NOT NULL CHECK (actor_role IN ('master', 'write')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organic_link_operations_v1_pk PRIMARY KEY (operation_id),
  CONSTRAINT organic_link_operations_v1_outcome_ck CHECK (
    (outcome = 'confirmed' AND reason IS NULL AND result_revision IS NOT NULL) OR
    (outcome = 'rejected' AND reason IS NOT NULL AND result_revision IS NULL)),
  CONSTRAINT organic_link_operations_v1_kind_ck CHECK (
    (kind = 'link.create' AND expected_record_revision IS NULL) OR
    (kind = 'link.archive' AND expected_record_revision >= 1))
);

CREATE TABLE IF NOT EXISTS dashboard_crm_controls.organic_link_history_v1 (
  brand          text        NOT NULL,
  link_id        text        NOT NULL,
  revision       integer     NOT NULL CHECK (revision >= 1),
  event          text        NOT NULL CHECK (event IN ('created', 'archived')),
  state          text        NOT NULL CHECK (state IN ('active', 'archived')),
  operation_id   text        NOT NULL,
  destination    text        NOT NULL,
  origin         text        NOT NULL,
  surface        text        NOT NULL,
  campaign       text        NOT NULL,
  campaign_date  date        NULL,
  utm_campaign   text        NOT NULL,
  url            text        NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organic_link_history_v1_pk PRIMARY KEY (brand, link_id, revision),
  CONSTRAINT organic_link_history_v1_link_fk FOREIGN KEY (brand, link_id) REFERENCES dashboard_crm_controls.organic_links_v1 (brand, link_id),
  CONSTRAINT organic_link_history_v1_op_fk FOREIGN KEY (operation_id) REFERENCES dashboard_crm_controls.organic_link_operations_v1 (operation_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT organic_link_history_v1_event_ck CHECK (
    (event = 'created' AND state = 'active' AND revision = 1) OR (event = 'archived' AND state = 'archived' AND revision >= 2))
);

CREATE INDEX IF NOT EXISTS organic_links_v1_brand_state_idx ON dashboard_crm_controls.organic_links_v1 (brand, state, created_at, link_id);
CREATE INDEX IF NOT EXISTS organic_link_operations_v1_brand_idx ON dashboard_crm_controls.organic_link_operations_v1 (brand, operation_id);

-- Guardas no banco (defesa em profundidade, independentes do módulo):
-- links: só existe a transição active -> archived com revision + 1; arquivado nunca reabre nem muda; sem DELETE.
CREATE OR REPLACE FUNCTION dashboard_crm_controls.organic_links_v1_guard() RETURNS trigger
LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'organic_links_v1: delete not allowed' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.state <> 'active' OR NEW.state <> 'archived' OR NEW.revision <> OLD.revision + 1
     OR NEW.brand IS DISTINCT FROM OLD.brand OR NEW.link_id IS DISTINCT FROM OLD.link_id
     OR NEW.destination IS DISTINCT FROM OLD.destination OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.surface IS DISTINCT FROM OLD.surface OR NEW.campaign IS DISTINCT FROM OLD.campaign
     OR NEW.campaign_date IS DISTINCT FROM OLD.campaign_date OR NEW.utm_campaign IS DISTINCT FROM OLD.utm_campaign
     OR NEW.url IS DISTINCT FROM OLD.url OR NEW.created_operation_id IS DISTINCT FROM OLD.created_operation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'organic_links_v1: only active->archived with revision+1' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$guard$;

CREATE OR REPLACE TRIGGER organic_links_v1_guard_trg
  BEFORE UPDATE OR DELETE ON dashboard_crm_controls.organic_links_v1
  FOR EACH ROW EXECUTE FUNCTION dashboard_crm_controls.organic_links_v1_guard();

-- operações e histórico: somente inserção (recibo original e trilha imutáveis).
CREATE OR REPLACE FUNCTION dashboard_crm_controls.organic_links_v1_append_only() RETURNS trigger
LANGUAGE plpgsql AS $append$
BEGIN
  RAISE EXCEPTION '%: append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$append$;

CREATE OR REPLACE TRIGGER organic_link_operations_v1_append_only_trg
  BEFORE UPDATE OR DELETE ON dashboard_crm_controls.organic_link_operations_v1
  FOR EACH ROW EXECUTE FUNCTION dashboard_crm_controls.organic_links_v1_append_only();

CREATE OR REPLACE TRIGGER organic_link_history_v1_append_only_trg
  BEFORE UPDATE OR DELETE ON dashboard_crm_controls.organic_link_history_v1
  FOR EACH ROW EXECUTE FUNCTION dashboard_crm_controls.organic_links_v1_append_only();
