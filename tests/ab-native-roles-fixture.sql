-- Synthetic dependencies and data for an EMPTY disposable native Listmonk DB.
-- Authentication table has only the columns used by the unchanged panel helper.
CREATE TABLE public.crm_familia_campanha(marca text,utm_campaign text,familia text,criado_em timestamptz DEFAULT now(),PRIMARY KEY(marca,utm_campaign));
CREATE TABLE public.crm_dash_chave(chave text PRIMARY KEY,dono text,painel text,ativo boolean,revogada_em timestamptz,expira_em timestamptz,chave_hash text);
CREATE FUNCTION public.shrigma_template_auth_v2(text) RETURNS jsonb LANGUAGE sql AS $$SELECT NULL::jsonb$$;
REVOKE ALL ON FUNCTION public.shrigma_template_auth_v2(text) FROM PUBLIC;
INSERT INTO public.crm_dash_chave VALUES
 ('synthetic-manager','Synthetic manager','growth',true,NULL,NULL,encode(sha256(convert_to('synthetic-manager-key','UTF8')),'hex')),
 ('synthetic-reader','Synthetic reader','growth',true,NULL,NULL,encode(sha256(convert_to('synthetic-reader-key','UTF8')),'hex'));
INSERT INTO templates(id,name,subject,body,is_default) VALUES(1,'Synthetic wrapper','','{{ template "content" . }}',true);
INSERT INTO lists(id,uuid,name,type,optin,tags) VALUES
 (3,gen_random_uuid(),'Synthetic Fish double','private','double',ARRAY['fish']),
 (17,gen_random_uuid(),'Synthetic Fish overlap','private','single',ARRAY['fish']),
 (7,gen_random_uuid(),'Synthetic Aristo double','private','double',ARRAY['aristo']);
INSERT INTO subscribers(id,uuid,email,name)
 SELECT n,gen_random_uuid(),'synthetic-'||n||'@example.invalid','Synthetic '||n FROM generate_series(1,1002)n;
UPDATE subscribers SET status='blocklisted' WHERE id=1001;
INSERT INTO subscriber_lists(subscriber_id,list_id,status)
 SELECT n,3,CASE WHEN n=1002 THEN 'unsubscribed'::subscription_status ELSE 'confirmed'::subscription_status END FROM generate_series(1,1002)n;
INSERT INTO subscriber_lists(subscriber_id,list_id,status) SELECT n,17,'unconfirmed' FROM generate_series(1,500)n;
INSERT INTO subscriber_lists(subscriber_id,list_id,status) SELECT n,7,'confirmed' FROM generate_series(1,1000)n;
INSERT INTO campaigns(id,uuid,name,subject,from_email,body,altbody,content_type,status,send_at,messenger,template_id,attribs)
 SELECT id,gen_random_uuid(),'Synthetic '||id,'Synthetic subject','Synthetic <synthetic@example.invalid>',
 '<p>Synthetic content</p><a href="{{ UnsubscribeURL }}">Unsubscribe</a>','Synthetic content','html','draft',
 date_trunc('milliseconds',clock_timestamp()+interval '2 hours'),'email',1,
 jsonb_build_object('crm',jsonb_build_object('policy','crm-campaign-v1','brand',brand,'initiative_key','synthetic','initiative_name','Synthetic','utm_campaign','synthetic'))
 FROM (VALUES(100,'fish'),(101,'fish'),(200,'aristo'),(201,'aristo')) c(id,brand);
-- Both arms must have exactly the same timestamp; current revisions include it.
UPDATE campaigns SET send_at=(SELECT send_at FROM campaigns WHERE id=100);
INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES
 (100,3,'Synthetic Fish double'),(100,17,'Synthetic Fish overlap'),(101,3,'Synthetic Fish double'),(101,17,'Synthetic Fish overlap'),
 (200,7,'Synthetic Aristo double'),(201,7,'Synthetic Aristo double');
UPDATE settings SET value='false' WHERE key='privacy.disable_tracking';
UPDATE settings SET value='true' WHERE key='privacy.individual_tracking';
