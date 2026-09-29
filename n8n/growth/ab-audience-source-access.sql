-- Narrow read/row-lock authority for the private A/B preparation path.
-- The API role receives EXECUTE only; it receives no UPDATE privilege on the
-- native Listmonk or A/B tables. Each exported function is one SQL statement,
-- so all captured rows share the caller command snapshot and its locks remain
-- held until the caller's transaction ends.

DO $install$
BEGIN
 IF pg_catalog.to_regnamespace('crm_audience_v2') IS NULL THEN RAISE EXCEPTION 'AB_SOURCE_ACCESS_SCHEMA_MISSING'; END IF;
 IF pg_catalog.to_regprocedure('public.shrigma_campaign_list_brand(public.lists)') IS NULL THEN RAISE EXCEPTION 'AB_SOURCE_ACCESS_BRAND_HELPER_MISSING'; END IF;
 IF pg_catalog.to_regclass('public.crm_ab_experiment_v2') IS NULL
 OR pg_catalog.to_regclass('public.crm_ab_arm_v2') IS NULL
 OR pg_catalog.to_regclass('public.crm_ab_member_v2') IS NULL THEN RAISE EXCEPTION 'AB_SOURCE_ACCESS_AB_SCHEMA_MISSING'; END IF;
 IF pg_catalog.to_regprocedure('crm_audience_v2.ab_audience_list_rule_valid(jsonb,integer[],integer)') IS NOT NULL
 OR pg_catalog.to_regprocedure('crm_audience_v2.ab_audience_list_rule_match(jsonb,integer[],integer)') IS NOT NULL
 OR pg_catalog.to_regprocedure('crm_audience_v2.ab_audience_cohort_source(text,integer[],integer,jsonb)') IS NOT NULL
 OR pg_catalog.to_regprocedure('crm_audience_v2.ab_audience_allocated_source(text,integer[],uuid,integer,jsonb)') IS NOT NULL
 THEN RAISE EXCEPTION 'AB_SOURCE_ACCESS_COLLISION'; END IF;
END $install$;

CREATE FUNCTION crm_audience_v2.ab_audience_list_rule_valid(rule jsonb,allowed integer[],depth integer)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path=pg_catalog
AS $fn$
DECLARE op text; child jsonb; n integer;
BEGIN
 IF depth<0 OR depth>8 OR jsonb_typeof(rule) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 SELECT count(*) INTO n FROM jsonb_object_keys(rule);
 op:=rule->>'op';
 IF op='in_list' THEN
  RETURN COALESCE(n=2 AND jsonb_typeof(rule->'list_id')='number'
   AND (rule->>'list_id')~'^[1-9][0-9]{0,9}$'
   AND (rule->>'list_id')::bigint<=2147483647
   AND (rule->>'list_id')::integer=ANY(allowed),false);
 END IF;
 IF op IS NULL OR op NOT IN('and','or') OR n<>2 OR jsonb_typeof(rule->'rules') IS DISTINCT FROM 'array'
 OR jsonb_array_length(rule->'rules')<2 OR jsonb_array_length(rule->'rules')>20 THEN RETURN false; END IF;
 FOR child IN SELECT value FROM jsonb_array_elements(rule->'rules') LOOP
  IF crm_audience_v2.ab_audience_list_rule_valid(child,allowed,depth+1) IS DISTINCT FROM true THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $fn$;

CREATE FUNCTION crm_audience_v2.ab_audience_list_rule_match(rule jsonb,consented integer[],depth integer)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path=pg_catalog
AS $fn$
DECLARE op text; child jsonb; matched boolean;
BEGIN
 IF depth<0 OR depth>8 OR jsonb_typeof(rule) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'AB_SOURCE_ACCESS_RULE_INVALID' USING ERRCODE='22023'; END IF;
 op:=rule->>'op';
 IF op='in_list' THEN RETURN (rule->>'list_id')::integer=ANY(consented); END IF;
 IF op IS NULL OR op NOT IN('and','or') OR jsonb_typeof(rule->'rules') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'AB_SOURCE_ACCESS_RULE_INVALID' USING ERRCODE='22023'; END IF;
 matched:=(op='and');
 FOR child IN SELECT value FROM jsonb_array_elements(rule->'rules') LOOP
  IF op='and' THEN matched:=matched AND crm_audience_v2.ab_audience_list_rule_match(child,consented,depth+1);
  ELSE matched:=matched OR crm_audience_v2.ab_audience_list_rule_match(child,consented,depth+1); END IF;
 END LOOP;
 RETURN matched;
END $fn$;

CREATE FUNCTION crm_audience_v2.ab_audience_cohort_source(p_brand text,p_list_ids integer[],p_base_list_id integer,p_rule jsonb)
RETURNS TABLE(source_confirmed boolean,unknown_reason text,member_ids jsonb,eligible_count bigint,checked_at timestamptz)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog
AS $fn$
WITH args AS MATERIALIZED (
 SELECT COALESCE(p_brand IN('fish','aristo') AND p_list_ids IS NOT NULL
  AND cardinality(p_list_ids) BETWEEN 1 AND 1000
  AND p_list_ids=ARRAY(SELECT DISTINCT x FROM unnest(p_list_ids) x WHERE x>0 ORDER BY x)
  AND p_base_list_id=ANY(p_list_ids)
  AND crm_audience_v2.ab_audience_list_rule_valid(p_rule,p_list_ids,0),false) AS valid
), boundary AS MATERIALIZED (
 SELECT a.valid,pg_catalog.current_setting('transaction_isolation')='read committed'
  AND (SELECT setting::bigint BETWEEN 1 AND 30000 FROM pg_catalog.pg_settings WHERE name='statement_timeout')
  AND (SELECT setting::bigint BETWEEN 1 AND 500 FROM pg_catalog.pg_settings WHERE name='lock_timeout') AS confirmed FROM args a
), locked_lists AS MATERIALIZED (
 SELECT l.id,l.status::text AS status,l.optin::text AS optin,public.shrigma_campaign_list_brand(l) AS brand
 FROM public.lists l CROSS JOIN boundary b WHERE b.valid AND b.confirmed AND l.id=ANY(p_list_ids)
 ORDER BY l.id FOR SHARE OF l
), list_scope AS MATERIALIZED (
 SELECT b.valid,b.confirmed AS boundary_confirmed,b.valid AND b.confirmed AND
  (SELECT count(*) FROM locked_lists WHERE status='active' AND brand=p_brand AND optin IN('single','double'))=cardinality(p_list_ids) AS confirmed
 FROM boundary b
), base_candidates AS MATERIALIZED (
 SELECT sl.subscriber_id FROM public.subscriber_lists sl CROSS JOIN list_scope scope
 WHERE scope.confirmed AND sl.list_id=p_base_list_id ORDER BY sl.subscriber_id LIMIT 100001
), cohort_scope AS MATERIALIZED (
 SELECT s.valid,s.boundary_confirmed,s.confirmed AS lists_confirmed,(SELECT count(*) FROM base_candidates) AS base_count FROM list_scope s
), locked_subscribers AS MATERIALIZED (
 SELECT s.id,s.status::text AS status FROM public.subscribers s JOIN base_candidates c ON c.subscriber_id=s.id
 CROSS JOIN cohort_scope scope WHERE scope.boundary_confirmed AND scope.lists_confirmed AND scope.base_count<=100000
 ORDER BY s.id FOR SHARE OF s
), locked_memberships AS MATERIALIZED (
 SELECT sl.subscriber_id,sl.list_id,sl.status::text AS status
 FROM public.subscriber_lists sl JOIN locked_subscribers s ON s.id=sl.subscriber_id
 CROSS JOIN (SELECT count(*) AS n FROM locked_subscribers) subscriber_lock_barrier
 WHERE subscriber_lock_barrier.n<=100000 AND sl.list_id=ANY(p_list_ids)
 ORDER BY sl.subscriber_id,sl.list_id FOR SHARE OF sl
), memberships AS MATERIALIZED (
 SELECT sl.subscriber_id,array_agg(sl.list_id ORDER BY sl.list_id) AS list_ids
 FROM locked_memberships sl JOIN locked_lists l ON l.id=sl.list_id
 WHERE (l.optin='double' AND sl.status='confirmed') OR (l.optin='single' AND sl.status IN('confirmed','unconfirmed')) GROUP BY sl.subscriber_id
), eligible AS MATERIALIZED (
 SELECT s.id FROM locked_subscribers s JOIN memberships m ON m.subscriber_id=s.id
 WHERE s.status='enabled' AND p_base_list_id=ANY(m.list_ids)
 AND crm_audience_v2.ab_audience_list_rule_match(p_rule,m.list_ids,0)
)
SELECT scope.valid AND scope.boundary_confirmed AND scope.lists_confirmed AND scope.base_count<=100000,
 CASE WHEN NOT scope.valid THEN 'list_source_unavailable' WHEN NOT scope.boundary_confirmed THEN 'session_boundary_unconfirmed'
  WHEN NOT scope.lists_confirmed THEN 'list_source_unavailable' WHEN scope.base_count>100000 THEN 'base_limit_exceeded' ELSE NULL END,
 CASE WHEN scope.valid AND scope.boundary_confirmed AND scope.lists_confirmed AND scope.base_count<=100000
  THEN (SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]'::jsonb) FROM eligible) ELSE NULL END,
 CASE WHEN scope.valid AND scope.boundary_confirmed AND scope.lists_confirmed AND scope.base_count<=100000
  THEN (SELECT count(*) FROM eligible) ELSE NULL END,statement_timestamp()
FROM cohort_scope scope
$fn$;

CREATE FUNCTION crm_audience_v2.ab_audience_allocated_source(p_brand text,p_list_ids integer[],p_test_id uuid,p_base_list_id integer,p_rule jsonb)
RETURNS TABLE(source_confirmed boolean,unknown_reason text,checked_at timestamptz,members jsonb,arms jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog
AS $fn$
WITH args AS MATERIALIZED (
 SELECT COALESCE(p_brand IN('fish','aristo') AND p_list_ids IS NOT NULL AND p_test_id IS NOT NULL
  AND cardinality(p_list_ids) BETWEEN 1 AND 1000
  AND p_list_ids=ARRAY(SELECT DISTINCT x FROM unnest(p_list_ids) x WHERE x>0 ORDER BY x)
  AND p_base_list_id=ANY(p_list_ids)
  AND crm_audience_v2.ab_audience_list_rule_valid(p_rule,p_list_ids,0),false) AS valid
), boundary AS MATERIALIZED (
 SELECT a.valid,pg_catalog.current_setting('transaction_isolation')='read committed'
  AND (SELECT setting::bigint BETWEEN 1 AND 30000 FROM pg_catalog.pg_settings WHERE name='statement_timeout')
  AND (SELECT setting::bigint BETWEEN 1 AND 500 FROM pg_catalog.pg_settings WHERE name='lock_timeout') AS confirmed FROM args a
), locked_experiment AS MATERIALIZED (
 SELECT e.test_id,e.brand FROM public.crm_ab_experiment_v2 e CROSS JOIN boundary b
 WHERE b.valid AND b.confirmed AND e.test_id=p_test_id ORDER BY e.test_id FOR SHARE OF e
), experiment_scope AS MATERIALIZED (
 SELECT b.valid,b.confirmed AS boundary_confirmed,b.valid AND b.confirmed AND (SELECT count(*) FROM locked_experiment WHERE brand=p_brand)=1 AS confirmed FROM boundary b
), locked_arms AS MATERIALIZED (
 SELECT a.arm,a.allocated_count FROM public.crm_ab_arm_v2 a CROSS JOIN experiment_scope e
 WHERE e.confirmed AND a.test_id=p_test_id ORDER BY a.arm FOR SHARE OF a
), arm_scope AS MATERIALIZED (
 SELECT e.*,(SELECT count(*) FROM locked_arms)=2 AND (SELECT count(DISTINCT arm) FROM locked_arms WHERE arm IN('a','b') AND allocated_count>=1)=2 AS arms_confirmed FROM experiment_scope e
), locked_lists AS MATERIALIZED (
 SELECT l.id,l.status::text AS status,l.optin::text AS optin,public.shrigma_campaign_list_brand(l) AS brand
 FROM public.lists l CROSS JOIN arm_scope a WHERE a.confirmed AND a.arms_confirmed AND l.id=ANY(p_list_ids)
 ORDER BY l.id FOR SHARE OF l
), list_scope AS MATERIALIZED (
 SELECT a.*,(SELECT count(*) FROM locked_lists WHERE status='active' AND brand=p_brand AND optin IN('single','double'))=cardinality(p_list_ids) AS lists_confirmed FROM arm_scope a
), member_candidates AS MATERIALIZED (
 SELECT m.subscriber_id,m.arm,m.revoked_at FROM public.crm_ab_member_v2 m CROSS JOIN list_scope s
 WHERE s.confirmed AND s.arms_confirmed AND s.lists_confirmed AND m.test_id=p_test_id ORDER BY m.subscriber_id LIMIT 100001
), candidate_scope AS MATERIALIZED (
 SELECT CASE WHEN NOT s.valid THEN 'allocation_unavailable' WHEN NOT s.boundary_confirmed THEN 'session_boundary_unconfirmed'
  WHEN NOT s.confirmed THEN 'allocation_unavailable' WHEN NOT s.arms_confirmed THEN 'allocation_malformed'
  WHEN NOT s.lists_confirmed THEN 'list_source_unavailable' WHEN (SELECT count(*) FROM member_candidates)>100000 THEN 'allocated_limit_exceeded'
  WHEN (SELECT count(*) FROM member_candidates)<2 THEN 'allocation_unavailable'
  WHEN EXISTS(SELECT 1 FROM member_candidates WHERE subscriber_id<=0 OR arm NOT IN('a','b') OR revoked_at IS NOT NULL AND NOT isfinite(revoked_at))
  OR EXISTS(SELECT 1 FROM locked_arms a WHERE a.allocated_count<>(SELECT count(*) FROM member_candidates m WHERE m.arm=a.arm))
  THEN 'allocation_malformed' ELSE NULL END AS reason FROM list_scope s
), locked_members AS MATERIALIZED (
 SELECT m.subscriber_id,m.arm,m.revoked_at,c.arm AS original_arm,c.revoked_at AS original_revoked_at
 FROM public.crm_ab_member_v2 m JOIN member_candidates c ON c.subscriber_id=m.subscriber_id CROSS JOIN candidate_scope s
 WHERE s.reason IS NULL AND m.test_id=p_test_id ORDER BY m.subscriber_id FOR SHARE OF m
), member_scope AS MATERIALIZED (
 SELECT COALESCE(s.reason,CASE WHEN (SELECT count(*) FROM locked_members)<>(SELECT count(*) FROM member_candidates)
  OR EXISTS(SELECT 1 FROM locked_members WHERE arm IS DISTINCT FROM original_arm OR original_revoked_at IS NOT NULL AND revoked_at IS DISTINCT FROM original_revoked_at)
  THEN 'allocation_changed' WHEN EXISTS(SELECT 1 FROM locked_members WHERE revoked_at IS NOT NULL AND NOT isfinite(revoked_at)) THEN 'allocation_malformed' ELSE NULL END) AS reason FROM candidate_scope s
), locked_subscribers AS MATERIALIZED (
 SELECT s.id,s.status::text AS status FROM public.subscribers s JOIN locked_members m ON m.subscriber_id=s.id CROSS JOIN member_scope scope
 WHERE scope.reason IS NULL ORDER BY s.id FOR SHARE OF s
), locked_memberships AS MATERIALIZED (
 SELECT sl.subscriber_id,sl.list_id,sl.status::text AS status FROM public.subscriber_lists sl JOIN locked_subscribers s ON s.id=sl.subscriber_id
 CROSS JOIN (SELECT count(*) AS n FROM locked_subscribers) subscriber_lock_barrier
 WHERE subscriber_lock_barrier.n<=100000 AND sl.list_id=ANY(p_list_ids)
 ORDER BY sl.subscriber_id,sl.list_id FOR SHARE OF sl
), memberships AS MATERIALIZED (
 SELECT sl.subscriber_id,array_agg(sl.list_id ORDER BY sl.list_id) AS list_ids FROM locked_memberships sl JOIN locked_lists l ON l.id=sl.list_id
 WHERE (l.optin='double' AND sl.status='confirmed') OR (l.optin='single' AND sl.status IN('confirmed','unconfirmed')) GROUP BY sl.subscriber_id
), classified AS MATERIALIZED (
 SELECT m.subscriber_id,m.arm,m.revoked_at,CASE WHEN m.revoked_at IS NOT NULL THEN 'revoked' WHEN s.id IS NULL THEN 'missing'
  WHEN s.status IS DISTINCT FROM 'enabled' THEN 'global_disabled' WHEN NOT COALESCE(p_base_list_id=ANY(ms.list_ids),false) THEN 'base_consent'
  WHEN NOT COALESCE(crm_audience_v2.ab_audience_list_rule_match(p_rule,ms.list_ids,0),false) THEN 'rule' ELSE 'eligible' END AS reason
 FROM locked_members m LEFT JOIN locked_subscribers s ON s.id=m.subscriber_id LEFT JOIN memberships ms ON ms.subscriber_id=m.subscriber_id
), arm_results AS MATERIALIZED (
 SELECT arm,count(*) AS allocated,count(*) FILTER(WHERE reason='eligible') AS eligible,count(*) FILTER(WHERE reason<>'eligible') AS excluded,
 count(*) FILTER(WHERE reason='revoked') AS revoked,count(*) FILTER(WHERE reason='missing') AS missing FROM classified GROUP BY arm
)
SELECT scope.reason IS NULL,scope.reason,statement_timestamp(),
 CASE WHEN scope.reason IS NULL THEN (SELECT jsonb_agg(jsonb_build_object('subscriber_id',subscriber_id,'arm',arm,'revoked_at',revoked_at,'reason',reason,'eligible',reason='eligible') ORDER BY subscriber_id) FROM classified) ELSE NULL END,
 CASE WHEN scope.reason IS NULL THEN (SELECT jsonb_agg(jsonb_build_object('arm',arm,'allocated',allocated,'eligible',eligible,'excluded',excluded,'revoked',revoked,'missing',missing) ORDER BY arm) FROM arm_results) ELSE NULL END
FROM member_scope scope
$fn$;

REVOKE ALL ON FUNCTION crm_audience_v2.ab_audience_list_rule_valid(jsonb,integer[],integer),
 crm_audience_v2.ab_audience_list_rule_match(jsonb,integer[],integer),
 crm_audience_v2.ab_audience_cohort_source(text,integer[],integer,jsonb),
 crm_audience_v2.ab_audience_allocated_source(text,integer[],uuid,integer,jsonb) FROM PUBLIC;
-- The deployment access manifest grants EXECUTE to crm_audience_api after the
-- role exists. Keeping that grant out of this source DDL allows the functions
-- to be installed before the runtime role without temporarily fabricating it.
