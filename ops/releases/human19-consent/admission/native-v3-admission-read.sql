WITH signatures(signature) AS (VALUES
 ('crm_audience_v2.freeze_native_internal_saved_audience_20261017(text,text,uuid,integer,text,text,text,jsonb,jsonb,text,text)'),
 ('crm_audience_v2.native_internal_snapshot_v1(integer)'),
 ('crm_audience_v2.native_internal_snapshot_history_v1(integer)'),
 ('crm_audience_v2.native_internal_effect_v1(text,jsonb,jsonb)'),
 ('crm_audience_v2.catalog_lists(text)')),
functions AS (
 SELECT s.signature,p.oid,pg_get_userbyid(p.proowner) AS owner,
 p.prosecdef AS security_definer,p.provolatile,md5(p.prosrc) AS body_md5,
 CASE WHEN p.oid IS NULL THEN NULL ELSE encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') END AS definition_sha256,
 CASE WHEN p.oid IS NULL THEN NULL ELSE encode(sha256(convert_to(coalesce(p.proconfig::text,''),'UTF8')),'hex') END AS config_sha256,
 CASE WHEN p.oid IS NULL THEN NULL ELSE encode(sha256(convert_to(coalesce(p.proacl::text,''),'UTF8')),'hex') END AS acl_sha256
 FROM signatures s LEFT JOIN pg_proc p ON p.oid=to_regprocedure(s.signature)
), shape AS (
 SELECT n.nspname||'.'||c.relname AS relation,a.attname AS column_name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 WHERE n.nspname='public' AND c.relname IN('lists','subscriber_lists')
)
SELECT jsonb_build_object(
 'schema','shrigma-native-freeze-v3-admission-read-v1',
 'correct_database',current_database()='listmonk',
 'functions',(SELECT jsonb_agg(to_jsonb(f) ORDER BY f.signature) FROM functions f),
 'membership_shape',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.relation,s.column_name) FROM shape s),
 'business_rows',false,'function_bodies_returned',false,'ddl_executed',false
) AS admission;
