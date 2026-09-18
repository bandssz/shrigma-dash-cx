-- Isolated PostgreSQL fixture matching the Listmonk fields used by this adapter.
-- Never apply this file to a live database.
CREATE TABLE lists(id integer PRIMARY KEY,name text,tags varchar(100)[],status text);
CREATE TABLE templates(id integer PRIMARY KEY,name text,type text,body text,updated_at timestamptz DEFAULT now());
CREATE TABLE campaigns(id integer PRIMARY KEY,name text,subject text,from_email text,body text,altbody text,body_source text,
 content_type text,send_at timestamptz,headers jsonb,status text,tags varchar(100)[],type text,messenger text,template_id integer,
 sent integer,started_at timestamptz,updated_at timestamptz DEFAULT now(),attribs jsonb,archive boolean DEFAULT false);
CREATE TABLE campaign_lists(id serial PRIMARY KEY,campaign_id integer,list_id integer,list_name text,UNIQUE(campaign_id,list_id));
CREATE TABLE campaign_media(id serial PRIMARY KEY,campaign_id integer,media_id integer,filename text);
CREATE TABLE crm_familia_campanha(marca text,utm_campaign text,familia text,criado_em timestamptz DEFAULT now(),PRIMARY KEY(marca,utm_campaign));
INSERT INTO lists VALUES(3,'Fish',ARRAY['fishermans'],'active'),(7,'Aristo',ARRAY['aristocrata'],'active'),
 (9,'Cross',ARRAY['fishermans','aristocrata'],'active'),(10,'Unknown',NULL,'active'),(11,'Archived',ARRAY['fishermans'],'archived'),
 (12,'Cross campaign',ARRAY['fish','cross'],'active'),(16,'Base Aristo',NULL,'active'),(17,'Base Fish',NULL,'active');
INSERT INTO templates(id,name,type,body) VALUES(1,'Campaign','campaign','{{ template "content" . }}'),(2,'Transactional','tx','body');
INSERT INTO campaigns(id,name,subject,from_email,body,altbody,content_type,headers,status,tags,type,messenger,template_id,sent,attribs,send_at)
 VALUES(100,'Draft','Subject','contato@fishermans.com.br','<p>Original</p>','Original','html',
 '[{"Reply-To":"old@fishermans.com.br","X-SES-CONFIGURATION-SET":"cs-fishermans-mkt"},{"X-Other":"keep"}]',
 'draft',ARRAY['old'],'regular','email',1,0,
 '{"other":"keep","crm":{"policy":"crm-campaign-v1","brand":"fish","initiative_key":"week","initiative_name":"Week","utm_campaign":"week","created_operation_id":"keep"}}',now()+interval '1 day');
INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(100,3,'Fish');
INSERT INTO campaign_media(campaign_id,media_id,filename) VALUES(100,1,'attachment.pdf');
INSERT INTO campaigns(id,name,subject,from_email,body,altbody,content_type,headers,status,tags,type,messenger,template_id,sent,attribs,send_at)
 SELECT 200,name,subject,'contato@oaristocrata.com',body,altbody,content_type,'[{"Reply-To":"contato@oaristocrata.com"}]',status,tags,type,messenger,template_id,sent,
 jsonb_set(attribs,'{crm,brand}','"aristo"'),send_at FROM campaigns WHERE id=100;
INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(200,7,'Aristo');
