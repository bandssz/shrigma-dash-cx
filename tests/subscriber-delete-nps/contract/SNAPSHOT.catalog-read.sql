WITH rels AS (
 SELECT c.*,n.nspname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN ('subscribers','shrigma_nps_vote_sync')
), funcs AS (
 SELECT p.*,l.lanname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND p.proname IN
 ('shrigma_nps_sign','shrigma_nps_prepare','shrigma_nps_record_vote','shrigma_nps_claim_vote_sync','shrigma_nps_finish_vote_sync','shrigma_nps_detach_deleted_subscriber')
)
SELECT jsonb_build_object(
 'schema','nps-delete-catalog-v1','database',current_database(),'serverMajor',current_setting('server_version_num')::int/10000,
 'roleOid',(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user),
 'tables',coalesce((SELECT jsonb_object_agg(r.relname,jsonb_build_object(
  'oid',r.oid,'schemaOid',r.relnamespace,'ownerOid',r.relowner,'kind',r.relkind,'persistence',r.relpersistence,
  'rls',r.relrowsecurity,'forceRls',r.relforcerowsecurity,'aclSha256',encode(sha256(convert_to(coalesce(r.relacl::text,''),'UTF8')),'hex'),
  'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'ordinal',a.attnum,'typeOid',a.atttypid,'typmod',a.atttypmod,
    'notNull',a.attnotnull,'collationOid',a.attcollation,'identity',a.attidentity,'generated',a.attgenerated,
    'aclSha256',encode(sha256(convert_to(coalesce(a.attacl::text,''),'UTF8')),'hex'),
    'defaultSha256',encode(sha256(convert_to(coalesce(pg_get_expr(d.adbin,d.adrelid),''),'UTF8')),'hex')) ORDER BY a.attnum)
   FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped))) FROM rels r),'{}'::jsonb),
 'constraints',coalesce((SELECT jsonb_agg(jsonb_build_object('oid',c.oid,'name',c.conname,'relationOid',c.conrelid,
  'kind',c.contype,'referenceOid',c.confrelid,'keys',c.conkey,'referenceKeys',c.confkey,'validated',c.convalidated,
  'deferrable',c.condeferrable,'deferred',c.condeferred,'match',c.confmatchtype,'onDelete',c.confdeltype,'onUpdate',c.confupdtype,
  'definitionSha256',encode(sha256(convert_to(pg_get_constraintdef(c.oid,false),'UTF8')),'hex')) ORDER BY c.oid)
  FROM pg_catalog.pg_constraint c WHERE c.conrelid IN(SELECT oid FROM rels) OR c.confrelid=(SELECT oid FROM rels WHERE relname='subscribers')),'[]'::jsonb),
 'triggers',coalesce((SELECT jsonb_agg(jsonb_build_object('oid',t.oid,'name',t.tgname,'relationOid',t.tgrelid,'functionOid',t.tgfoid,
  'type',t.tgtype,'enabled',t.tgenabled,'internal',t.tgisinternal,'argsBytes',length(t.tgargs),'hasWhen',t.tgqual IS NOT NULL,
  'metadataSha256',encode(sha256(convert_to((to_jsonb(t)-'tgargs'-'tgqual')::text||encode(t.tgargs,'hex')||coalesce(t.tgqual::text,''),'UTF8')),'hex'),
  'functionBodySha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')) ORDER BY t.oid)
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid IN(SELECT oid FROM rels) AND NOT t.tgisinternal),'[]'::jsonb),
 'functions',coalesce((SELECT jsonb_agg(jsonb_build_object('oid',p.oid,'name',p.proname,'argOids',p.proargtypes::text,
  'returnOid',p.prorettype,'returnsSet',p.proretset,'language',p.lanname,'volatility',p.provolatile,'securityDefiner',p.prosecdef,
  'config',p.proconfig,'ownerOid',p.proowner,'publicExecute',EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE'),
  'nonOwnerExecute',EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE'),
  'bodySha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'bodyBytes',octet_length(p.prosrc),
  'definitionSha256',encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'),
  'metadataSha256',encode(sha256(convert_to((to_jsonb(p)-'prosrc'-'probin'-'lanname')::text,'UTF8')),'hex')) ORDER BY p.oid) FROM funcs p),'[]'::jsonb)) AS snapshot;
