-- Synthetic native PostgreSQL contract. No production schema/data/credentials.
DO $$BEGIN IF current_database()<>'consent_fixture' THEN RAISE EXCEPTION 'FIXTURE_DATABASE_REQUIRED';END IF;END$$;
CREATE SCHEMA crm_audience_v2;
CREATE TYPE subscription_status AS ENUM('unconfirmed','confirmed','unsubscribed');
CREATE TABLE public.subscribers(id integer PRIMARY KEY,status text NOT NULL DEFAULT 'enabled');
CREATE TABLE public.lists(id integer PRIMARY KEY,uuid uuid NOT NULL UNIQUE,brand text NOT NULL,optin text NOT NULL,status text NOT NULL DEFAULT 'active',type text NOT NULL DEFAULT 'private');
CREATE TABLE public.subscriber_lists(subscriber_id integer REFERENCES public.subscribers(id) ON DELETE CASCADE,list_id integer REFERENCES public.lists(id) ON DELETE CASCADE,meta jsonb NOT NULL DEFAULT '{}',status subscription_status NOT NULL DEFAULT 'unconfirmed',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(subscriber_id,list_id));
CREATE TABLE public.campaigns(id integer PRIMARY KEY,brand text NOT NULL,created_operation_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE public.campaign_lists(campaign_id integer REFERENCES public.campaigns(id),list_id integer REFERENCES public.lists(id) ON DELETE CASCADE,PRIMARY KEY(campaign_id,list_id));
CREATE TABLE public.shrigma_campaign_operation(id uuid PRIMARY KEY,actor text NOT NULL,brand text NOT NULL,action text NOT NULL,state text NOT NULL,provider_id integer,created_at timestamptz DEFAULT clock_timestamp());
CREATE TABLE crm_audience_v2.request(actor text NOT NULL,operation_key text NOT NULL,brand text NOT NULL,payload jsonb NOT NULL,payload_hash text NOT NULL,response jsonb NOT NULL,created_at timestamptz DEFAULT clock_timestamp(),PRIMARY KEY(actor,operation_key));
CREATE FUNCTION crm_audience_v2.append_only() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$BEGIN RAISE EXCEPTION 'AUDIENCE_HISTORY_IMMUTABLE';END$$;
CREATE TRIGGER request_append_only BEFORE UPDATE OR DELETE ON crm_audience_v2.request FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.append_only();
REVOKE ALL ON SCHEMA crm_audience_v2 FROM PUBLIC;
