-- Additional catalog-only proposal. Never emit addresses/options/role names.
-- Bucket membership is metadata classification, NOT a login or first-match proof.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL search_path=pg_catalog;
SET LOCAL statement_timeout='4s';
SET LOCAL lock_timeout='500ms';
SET LOCAL idle_in_transaction_session_timeout='5s';
WITH execution_context AS MATERIALIZED (
 SELECT current_database()='listmonk' AND current_user='postgres' AND session_user='postgres'
  AND current_setting('transaction_read_only')='on' AS verified
), candidate_hba AS MATERIALIZED (
 SELECT h.type,h.auth_method,h.address,h.netmask FROM pg_hba_file_rules h
 CROSS JOIN execution_context x WHERE x.verified AND h.error IS NULL
  AND ('all'=ANY(h.database) OR 'listmonk'=ANY(h.database))
  AND ('all'=ANY(h.user_name) OR 'crm_manager_provisioner'=ANY(h.user_name))
), classified_hba AS MATERIALIZED (
 SELECT auth_method,CASE
  WHEN type='local' THEN 'local'
  WHEN type NOT IN ('host','hostssl','hostnossl') THEN 'unclassified'
  WHEN address='all' THEN 'non_loopback'
  WHEN NOT coalesce(pg_input_is_valid(address,'inet') AND pg_input_is_valid(netmask,'inet'),false) THEN 'unclassified'
  WHEN family(address::inet)<>family(netmask::inet) THEN 'unclassified'
  WHEN family(address::inet)=4 AND host(address::inet)::inet <<= '127.0.0.0/8'::inet
   AND (netmask::inet & '255.0.0.0'::inet)='255.0.0.0'::inet THEN 'loopback_only'
  WHEN family(address::inet)=6 AND host(address::inet)::inet='::1'::inet
   AND netmask::inet='ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'::inet THEN 'loopback_only'
  ELSE 'non_loopback' END AS scope
 FROM candidate_hba
), scopes AS (
 SELECT v.* FROM (VALUES(1,'local'),(2,'loopback_only'),(3,'non_loopback'),(4,'unclassified')) v(ord,target)
), hba_scopes AS MATERIALIZED (
 SELECT s.ord,s.target,count(h.scope) AS total,
  count(h.scope) FILTER(WHERE h.auth_method='trust') AS trust,
  count(h.scope) FILTER(WHERE h.auth_method='password') AS password,
  count(h.scope) FILTER(WHERE h.auth_method='md5') AS md5,
  count(h.scope) FILTER(WHERE h.auth_method='scram-sha-256') AS scram,
  count(h.scope) FILTER(WHERE h.auth_method='reject') AS reject,
  count(h.scope) FILTER(WHERE h.auth_method NOT IN ('trust','password','md5','scram-sha-256','reject')) AS other
 FROM scopes s LEFT JOIN classified_hba h ON h.scope=s.target CROSS JOIN execution_context x
 WHERE x.verified GROUP BY s.ord,s.target
), hba_summary AS MATERIALIZED (
 SELECT 'provisioner_hba'::text AS target,
  (SELECT count(*) FROM pg_hba_file_rules h CROSS JOIN execution_context x WHERE x.verified AND h.error IS NOT NULL) AS rule_errors,
  (SELECT count(*) FROM candidate_hba) AS candidate_rules,
  (SELECT count(*) FROM pg_hba_file_rules h CROSS JOIN execution_context x WHERE x.verified AND h.error IS NULL AND (
   EXISTS(SELECT 1 FROM unnest(h.database) t(v) WHERE v LIKE '@%' OR v LIKE '/%' OR v IN ('sameuser','samerole','samegroup'))
   OR EXISTS(SELECT 1 FROM unnest(h.user_name) t(v) WHERE v LIKE '+%' OR v LIKE '@%' OR v LIKE '/%'))) AS ambiguous_selector_rules
 FROM execution_context x WHERE x.verified
), extra_defaults AS MATERIALIZED (
 SELECT a.grantee=(SELECT oid FROM pg_roles WHERE rolname='central_leitor') AS central_leitor,
  CASE WHEN a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')
   THEN a.privilege_type ELSE 'OTHER' END AS privilege,
  d.defaclnamespace=0 AS global_scope,a.is_grantable,a.grantor<>d.defaclrole AS foreign_grantor
 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a CROSS JOIN execution_context x
 WHERE x.verified AND d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname='postgres')
  AND (d.defaclnamespace=0 OR d.defaclnamespace='public'::regnamespace)
  AND d.defaclobjtype='r' AND a.grantee NOT IN (0,d.defaclrole)
), privilege_classes AS (
 SELECT v.* FROM (VALUES(1,'SELECT'),(2,'INSERT'),(3,'UPDATE'),(4,'DELETE'),(5,'TRUNCATE'),(6,'REFERENCES'),(7,'TRIGGER'),(8,'MAINTAIN'),(9,'OTHER')) v(ord,privilege)
), default_acl AS MATERIALIZED (
 SELECT c.central_leitor,p.ord,p.privilege,count(d.privilege) AS entry_count,
  count(d.privilege) FILTER(WHERE d.global_scope) AS global_count,
  count(d.privilege) FILTER(WHERE NOT d.global_scope) AS public_schema_count,
  count(d.privilege) FILTER(WHERE d.is_grantable) AS grant_option_count,
  count(d.privilege) FILTER(WHERE d.foreign_grantor) AS foreign_grantor_count
 FROM (VALUES(true),(false)) c(central_leitor) CROSS JOIN privilege_classes p
 CROSS JOIN execution_context x LEFT JOIN extra_defaults d
 ON coalesce(d.central_leitor,false)=c.central_leitor AND d.privilege=p.privilege
 WHERE x.verified GROUP BY c.central_leitor,p.ord,p.privilege
)
SELECT jsonb_build_object('schema','crm-manager-auth-scope-metadata-v1',
 'contextVerified',(SELECT verified FROM execution_context),'reports',
 CASE WHEN (SELECT verified FROM execution_context) THEN jsonb_build_array(
  jsonb_build_object('section','hba_summary','rows',(SELECT jsonb_agg(to_jsonb(h)) FROM hba_summary h)),
  jsonb_build_object('section','hba_scopes','rows',(SELECT jsonb_agg(to_jsonb(h)-'ord' ORDER BY h.ord) FROM hba_scopes h)),
  jsonb_build_object('section','default_acl','rows',(SELECT jsonb_agg(to_jsonb(d)-'ord' ORDER BY d.central_leitor DESC,d.ord) FROM default_acl d)))
 ELSE '[]'::jsonb END) AS body;
ROLLBACK;
