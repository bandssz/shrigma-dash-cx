-- Synthetic compatibility boundary only. Never install this fixture in production.
CREATE TABLE shrigma_flow_definition(key text PRIMARY KEY,name text,brand text,draft jsonb,binding jsonb,enabled boolean,trigger text,version integer,published jsonb,updated_at timestamptz,updated_by text,runtime_ready boolean,published_version integer);
CREATE TABLE shrigma_flow_template(brand text,id text,data jsonb,PRIMARY KEY(brand,id));
CREATE TABLE shrigma_flow_request(idem text PRIMARY KEY,actor text,payload jsonb,response jsonb);
CREATE TABLE shrigma_flow_revision(flow_key text,version integer,definition jsonb,actor text,PRIMARY KEY(flow_key,version));
CREATE TABLE shrigma_flow_audit(id integer GENERATED ALWAYS AS IDENTITY,flow_key text,actor text,action text,version integer,detail jsonb);
CREATE TABLE templates(id integer PRIMARY KEY,name text,body text,subject text,type text);
CREATE TABLE shrigma_template_email_registry(template_id integer,brand text,draft_id text);
CREATE TABLE shrigma_send_log(id integer PRIMARY KEY,ref text UNIQUE,wamid text,erro text);
INSERT INTO shrigma_send_log VALUES(1,'synthetic-existing-reservation',NULL,'UNCERTAIN_META');
CREATE FUNCTION shrigma_template_auth_v2(k text) RETURNS jsonb LANGUAGE sql AS $$ SELECT CASE k
 WHEN 'publisher-A' THEN '{"who":"synthetic-A","caps":["submit"]}'::jsonb
 WHEN 'publisher-B' THEN '{"who":"synthetic-B","caps":["submit"]}'::jsonb
 WHEN 'reader' THEN '{"who":"synthetic-reader","caps":["read_content"]}'::jsonb
 ELSE '{}'::jsonb END $$;
-- Observed signature shape for this fixture's TEXT/BODY/URL components only.
-- The production migration reuses the installed shrigma_wa_signature unchanged.
CREATE FUNCTION shrigma_wa_signature(cs jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_agg(CASE c->>'type' WHEN 'BUTTONS' THEN
  jsonb_build_object('type','BUTTONS','buttons',(SELECT jsonb_agg(jsonb_build_object('type',b->>'type','url',b->>'url','phone',b->>'phone_number','reply',b->>'payload') ORDER BY bi) FROM jsonb_array_elements(c->'buttons') WITH ORDINALITY q(b,bi)))
 ELSE jsonb_build_object('type',c->>'type','format',c->>'format','vars',coalesce((SELECT jsonb_agg(m[1]) FROM regexp_matches(coalesce(c->>'text',''),'\{\{([0-9]+)\}\}','g')m),'[]'::jsonb)) END ORDER BY ci)
 FROM jsonb_array_elements(cs) WITH ORDINALITY q(c,ci) WHERE c->>'type' IN ('HEADER','BODY','BUTTONS')
$$;
