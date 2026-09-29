-- Bounded locks for the restricted audience API. No native write permission.
-- The caller owns one READ COMMITTED transaction and the authenticated context.

CREATE FUNCTION crm_audience_v2.ab_material_campaigns(ids integer[]) RETURNS TABLE(id integer,template_id integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
 IF ids IS NULL OR cardinality(ids)>2 OR EXISTS(SELECT 1 FROM unnest(ids) i WHERE i IS NULL OR i<1)
  OR cardinality(ids)<>(SELECT count(DISTINCT i) FROM unnest(ids) i)
  OR current_setting('transaction_isolation')<>'read committed'
  OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000)
  OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='lock_timeout' AND setting::integer BETWEEN 1 AND 500)
 THEN RAISE EXCEPTION 'AB_MATERIAL_ACCESS_BOUNDARY'; END IF;
 RETURN QUERY SELECT c.id,c.template_id FROM public.campaigns c WHERE c.id=ANY(ids) ORDER BY c.id FOR UPDATE OF c;
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.ab_material_campaigns(integer[]) FROM PUBLIC;

CREATE FUNCTION crm_audience_v2.ab_material_list_links(ids integer[]) RETURNS TABLE(campaign_id integer,list_id integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
 IF ids IS NULL OR cardinality(ids)>2 OR EXISTS(SELECT 1 FROM unnest(ids) i WHERE i IS NULL OR i<1)
  OR cardinality(ids)<>(SELECT count(DISTINCT i) FROM unnest(ids) i)
  OR current_setting('transaction_isolation')<>'read committed'
  OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000)
  OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='lock_timeout' AND setting::integer BETWEEN 1 AND 500)
 THEN RAISE EXCEPTION 'AB_MATERIAL_ACCESS_BOUNDARY'; END IF;
 RETURN QUERY SELECT cl.campaign_id,cl.list_id FROM public.campaign_lists cl WHERE cl.campaign_id=ANY(ids) ORDER BY cl.campaign_id,cl.list_id LIMIT 1001 FOR SHARE OF cl;
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.ab_material_list_links(integer[]) FROM PUBLIC;

CREATE FUNCTION crm_audience_v2.ab_material_media_links(ids integer[]) RETURNS TABLE(campaign_id integer,media_id integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
 IF ids IS NULL OR cardinality(ids)>2 OR EXISTS(SELECT 1 FROM unnest(ids) i WHERE i IS NULL OR i<1)
  OR cardinality(ids)<>(SELECT count(DISTINCT i) FROM unnest(ids) i)
  OR current_setting('transaction_isolation')<>'read committed'
  OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000)
  OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='lock_timeout' AND setting::integer BETWEEN 1 AND 500)
 THEN RAISE EXCEPTION 'AB_MATERIAL_ACCESS_BOUNDARY'; END IF;
 RETURN QUERY SELECT cm.campaign_id,cm.media_id FROM public.campaign_media cm WHERE cm.campaign_id=ANY(ids) ORDER BY cm.campaign_id,cm.media_id,cm.filename LIMIT 1001 FOR SHARE OF cm;
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.ab_material_media_links(integer[]) FROM PUBLIC;

CREATE FUNCTION crm_audience_v2.ab_material_lists(ids integer[]) RETURNS TABLE(id integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
 IF ids IS NULL OR cardinality(ids)>1000 OR EXISTS(SELECT 1 FROM unnest(ids) i WHERE i IS NULL OR i<1)
  OR cardinality(ids)<>(SELECT count(DISTINCT i) FROM unnest(ids) i)
  OR current_setting('transaction_isolation')<>'read committed'
  OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000)
  OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='lock_timeout' AND setting::integer BETWEEN 1 AND 500)
 THEN RAISE EXCEPTION 'AB_MATERIAL_ACCESS_BOUNDARY'; END IF;
 RETURN QUERY SELECT l.id FROM public.lists l WHERE l.id=ANY(ids) ORDER BY l.id FOR SHARE OF l;
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.ab_material_lists(integer[]) FROM PUBLIC;

CREATE FUNCTION crm_audience_v2.ab_material_templates(ids integer[]) RETURNS TABLE(id integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
 IF ids IS NULL OR cardinality(ids)>2 OR EXISTS(SELECT 1 FROM unnest(ids) i WHERE i IS NULL OR i<1)
  OR cardinality(ids)<>(SELECT count(DISTINCT i) FROM unnest(ids) i)
  OR current_setting('transaction_isolation')<>'read committed'
  OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000)
  OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='lock_timeout' AND setting::integer BETWEEN 1 AND 500)
 THEN RAISE EXCEPTION 'AB_MATERIAL_ACCESS_BOUNDARY'; END IF;
 RETURN QUERY SELECT t.id FROM public.templates t WHERE t.id=ANY(ids) ORDER BY t.id FOR SHARE OF t;
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.ab_material_templates(integer[]) FROM PUBLIC;

CREATE FUNCTION crm_audience_v2.ab_material_media(ids integer[]) RETURNS TABLE(id integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
 IF ids IS NULL OR cardinality(ids)>1000 OR EXISTS(SELECT 1 FROM unnest(ids) i WHERE i IS NULL OR i<1)
  OR cardinality(ids)<>(SELECT count(DISTINCT i) FROM unnest(ids) i)
  OR current_setting('transaction_isolation')<>'read committed'
  OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000)
  OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='lock_timeout' AND setting::integer BETWEEN 1 AND 500)
 THEN RAISE EXCEPTION 'AB_MATERIAL_ACCESS_BOUNDARY'; END IF;
 RETURN QUERY SELECT m.id FROM public.media m WHERE m.id=ANY(ids) ORDER BY m.id FOR SHARE OF m;
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.ab_material_media(integer[]) FROM PUBLIC;
