WITH tables AS MATERIALIZED (
 SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname=ANY(ARRAY['crm_manager_writer_issuer_v1','crm_manager_writer_subject_v1','crm_manager_writer_operation_v1','crm_manager_writer_generation_v1'])
), functions AS MATERIALIZED (
 SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname=ANY(ARRAY['crm_manager_writer_canonical_v1','crm_manager_writer_error_v1','crm_manager_writer_apply_v1','crm_manager_writer_prepare_v1','crm_manager_writer_commit_v1','crm_manager_writer_revoke_v1','crm_manager_writer_status_v1'])
), identities(classid,objid,label) AS MATERIALIZED (
 SELECT 'pg_class'::regclass::oid,c.oid,'table:'||c.relname FROM tables c
 UNION ALL SELECT 'pg_proc'::regclass::oid,p.oid,'function:'||p.oid::regprocedure::text FROM functions p
 UNION ALL SELECT 'pg_class'::regclass::oid,i.indexrelid,'index:'||c.relname FROM pg_index i JOIN tables t ON t.oid=i.indrelid JOIN pg_class c ON c.oid=i.indexrelid
 UNION ALL SELECT 'pg_class'::regclass::oid,t.reltoastrelid,'toast:'||t.relname FROM tables t WHERE t.reltoastrelid<>0
 UNION ALL SELECT 'pg_class'::regclass::oid,i.indexrelid,'toastindex:'||t.relname FROM tables t JOIN pg_index i ON i.indrelid=t.reltoastrelid
 UNION ALL SELECT 'pg_type'::regclass::oid,t.reltype,'rowtype:'||t.relname FROM tables t
 UNION ALL SELECT 'pg_type'::regclass::oid,y.typarray,'arraytype:'||t.relname FROM tables t JOIN pg_type y ON y.oid=t.reltype
 UNION ALL SELECT 'pg_constraint'::regclass::oid,c.oid,'constraint:'||t.relname||':'||c.conname FROM tables t JOIN pg_constraint c ON c.conrelid=t.oid
 UNION ALL SELECT 'pg_attrdef'::regclass::oid,d.oid,'default:'||t.relname||':'||a.attname FROM tables t JOIN pg_attrdef d ON d.adrelid=t.oid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.adnum
 UNION ALL SELECT 'pg_trigger'::regclass::oid,g.oid,'trigger:'||c.conname||':'||r.relname||':'||g.tgtype FROM tables t JOIN pg_constraint c ON c.conrelid=t.oid JOIN pg_trigger g ON g.tgconstraint=c.oid JOIN pg_class r ON r.oid=g.tgrelid
), dependency_edges AS MATERIALIZED (
 SELECT coalesce(a.label,pg_describe_object(d.classid,d.objid,0)) AS object,d.objsubid,
  coalesce(b.label,pg_describe_object(d.refclassid,d.refobjid,0)) AS reference,d.refobjsubid,d.deptype,
  a.label IS NOT NULL AS object_inside,b.label IS NOT NULL AS reference_inside,
  d.classid::regclass::text AS object_class,d.refclassid::regclass::text AS reference_class
 FROM pg_depend d LEFT JOIN identities a ON a.classid=d.classid AND a.objid=d.objid
 LEFT JOIN identities b ON b.classid=d.refclassid AND b.objid=d.refobjid
 WHERE a.label IS NOT NULL OR b.label IS NOT NULL
), shared_edges AS MATERIALIZED (
 SELECT pg_get_userbyid(d.refobjid) AS role,coalesce(i.label,pg_describe_object(d.classid,d.objid,0)) AS object,
  d.classid::regclass::text AS object_class,d.objsubid,d.deptype,
  d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AS current_database
 FROM pg_shdepend d LEFT JOIN identities i ON i.classid=d.classid AND i.objid=d.objid
 WHERE i.label IS NOT NULL OR (d.refclassid='pg_authid'::regclass AND d.refobjid IN (SELECT oid FROM pg_roles WHERE rolname IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1')))
), records(kind,label,data) AS (
 SELECT 'table',t.relname,jsonb_build_object('kind',t.relkind,'persistence',t.relpersistence,
  'owner',pg_get_userbyid(t.relowner),'rls',t.relrowsecurity,'force_rls',t.relforcerowsecurity,
  'partition',t.relispartition,'options',t.reloptions,'inherits',(SELECT count(*) FROM pg_inherits h WHERE h.inhrelid=t.oid OR h.inhparent=t.oid),
  'columns',(SELECT jsonb_agg(jsonb_build_object('num',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
   'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'inherited',a.attinhcount,'collation',CASE WHEN a.attcollation=0 THEN '' ELSE a.attcollation::regcollation::text END,
   'default',pg_get_expr(d.adbin,d.adrelid,true)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('name',c.conname,'definition',pg_get_constraintdef(c.oid,true),'validated',c.convalidated,'deferrable',c.condeferrable,'deferred',c.condeferred) ORDER BY c.conname) FROM pg_constraint c WHERE c.conrelid=t.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'owner',pg_get_userbyid(c.relowner)) ORDER BY c.relname) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=t.oid),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('constraint',c.conname,'internal',g.tgisinternal,'enabled',g.tgenabled,'type',g.tgtype,'deferrable',g.tgdeferrable,'deferred',g.tginitdeferred,'function',g.tgfoid::regprocedure::text) ORDER BY c.conname,g.tgtype) FROM pg_trigger g LEFT JOIN pg_constraint c ON c.oid=g.tgconstraint WHERE g.tgrelid=t.oid),
  'policies',(SELECT count(*) FROM pg_policy p WHERE p.polrelid=t.oid),
  'rules',(SELECT count(*) FROM pg_rewrite r WHERE r.ev_class=t.oid)) FROM tables t
 UNION ALL SELECT 'type',i.label,jsonb_build_object('name',y.typname,'namespace',n.nspname,'owner',pg_get_userbyid(y.typowner),'kind',y.typtype,'category',y.typcategory) FROM identities i JOIN pg_type y ON i.classid='pg_type'::regclass AND y.oid=i.objid JOIN pg_namespace n ON n.oid=y.typnamespace
 UNION ALL SELECT 'function',p.oid::regprocedure::text,jsonb_build_object('owner',pg_get_userbyid(p.proowner),'language',l.lanname,'kind',p.prokind,'definer',p.prosecdef,'volatile',p.provolatile,'parallel',p.proparallel,'strict',p.proisstrict,'leakproof',p.proleakproof,'set',p.proretset,'returns',p.prorettype::regtype::text,'args',oidvectortypes(p.proargtypes),'allargs',p.proallargtypes,'modes',p.proargmodes,'names',p.proargnames,'defaults',p.pronargdefaults,'variadic',p.provariadic,'path',p.proconfig,'body_sha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')) FROM functions p JOIN pg_language l ON l.oid=p.prolang
 UNION ALL SELECT 'acl_relation',coalesce(i.label,'legacy:'||c.relname),jsonb_agg(jsonb_build_object('grantee',pg_get_userbyid(a.grantee),'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grant_option',a.is_grantable) ORDER BY a.grantee,a.privilege_type)
  FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a LEFT JOIN identities i ON i.classid='pg_class'::regclass AND i.objid=c.oid
  WHERE a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1')) OR i.label LIKE 'table:%'
  GROUP BY c.oid,c.relname,i.label
 UNION ALL SELECT 'acl_column',c.relname||':'||a.attname,jsonb_agg(jsonb_build_object('grantee',pg_get_userbyid(x.grantee),'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grant_option',x.is_grantable) ORDER BY x.grantee,x.privilege_type)
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid CROSS JOIN LATERAL aclexplode(a.attacl) x
  WHERE a.attrelid IN (SELECT oid FROM tables) OR x.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1')) GROUP BY c.relname,a.attname
 UNION ALL SELECT 'acl_function',p.oid::regprocedure::text,jsonb_agg(jsonb_build_object('grantee',pg_get_userbyid(a.grantee),'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grant_option',a.is_grantable) ORDER BY a.grantee,a.privilege_type)
  FROM functions p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a GROUP BY p.oid
 UNION ALL SELECT 'acl_schema',n.nspname,jsonb_agg(jsonb_build_object('grantee',pg_get_userbyid(a.grantee),'grantor_is_schema_owner',a.grantor=n.nspowner,'privilege',a.privilege_type,'grant_option',a.is_grantable) ORDER BY a.grantee,a.privilege_type)
  FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1')) GROUP BY n.nspname,n.nspowner
 UNION ALL SELECT 'identity_count','closed',jsonb_build_object('count',count(*),'unique',count(DISTINCT label)) FROM identities
 UNION ALL SELECT 'dependency_graph','closed',jsonb_agg(to_jsonb(d) ORDER BY d.object_class,d.object,d.objsubid,d.reference_class,d.reference,d.refobjsubid,d.deptype) FROM dependency_edges d
 UNION ALL SELECT 'shared_graph','closed',jsonb_agg(to_jsonb(d) ORDER BY d.role,d.object_class,d.object,d.objsubid,d.deptype) FROM shared_edges d
)
SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('kind',kind,'label',label,'data',data) ORDER BY kind,label),'[]'::jsonb)::text,'UTF8')),'hex') AS profile_sha256 FROM records;
