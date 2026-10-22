CREATE OR REPLACE FUNCTION crm_audience_v2.catalog_lists(b text)
 RETURNS TABLE(id integer, name text, status text, optin text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
 SELECT l.id,l.name::text,l.status::text,l.optin::text FROM public.lists l
 WHERE b IN ('fish','aristo') AND public.shrigma_campaign_list_brand(l)=b
 ORDER BY l.id LIMIT 1001 FOR SHARE OF l
 $function$;
