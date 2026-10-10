DO $nps_guard$
DECLARE actual jsonb;expected jsonb;f jsonb;fk jsonb;jobs_oid oid;subscriber_oid oid;own_function oid;own_trigger jsonb;
BEGIN
 SELECT snapshot INTO actual FROM (WITH rels AS (
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
  'metadataSha256',encode(sha256(convert_to((to_jsonb(p)-'prosrc'-'probin'-'lanname')::text,'UTF8')),'hex')) ORDER BY p.oid) FROM funcs p),'[]'::jsonb)) AS snapshot) catalog;
 expected=current_setting('shrigma.nps.expected',true)::jsonb;
 IF expected IS NULL OR expected->>'schema'<>'nps-delete-catalog-v1' OR actual->>'serverMajor'<>'17' THEN RAISE EXCEPTION 'NPS_EXPECTED_CHECKPOINT_REQUIRED';END IF;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'NPS_CATALOG_CAS_REFUSED';END IF;
 jobs_oid=(actual->'tables'->'shrigma_nps_vote_sync'->>'oid')::oid;subscriber_oid=(actual->'tables'->'subscribers'->>'oid')::oid;
 IF jobs_oid IS NULL OR subscriber_oid IS NULL OR actual->'tables'->'subscribers'->>'kind'<>'r' OR actual->'tables'->'shrigma_nps_vote_sync'->>'kind'<>'r'
  OR (actual->'tables'->'subscribers'->>'rls')::boolean OR (actual->'tables'->'shrigma_nps_vote_sync'->>'rls')::boolean
  OR (actual->'tables'->'subscribers'->>'forceRls')::boolean OR (actual->'tables'->'shrigma_nps_vote_sync'->>'forceRls')::boolean
 THEN RAISE EXCEPTION 'NPS_RELATION_SHAPE_REFUSED';END IF;
 IF NOT has_table_privilege(subscriber_oid,'DELETE') OR NOT has_table_privilege(jobs_oid,'UPDATE') THEN RAISE EXCEPTION 'NPS_CURRENT_ROLE_PRIVILEGE_REFUSED';END IF;
 IF (SELECT jsonb_agg(jsonb_build_array(a->>'name',(a->>'typeOid')::int,(a->>'ordinal')::int,(a->>'typmod')::int) ORDER BY (a->>'ordinal')::int) FROM jsonb_array_elements(actual->'tables'->'shrigma_nps_vote_sync'->'columns') a)
  IS DISTINCT FROM '[["id",2950,1,-1],["subscriber_id",23,2,-1],["brand",25,3,-1],["order_ref",25,4,-1],["vote_date",25,5,-1],["payload",3802,6,-1],["state",25,7,-1],["task_id",25,8,-1],["created_at",1184,9,-1],["updated_at",1184,10,-1]]'::jsonb
 THEN RAISE EXCEPTION 'NPS_COLUMN_SHAPE_REFUSED';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(actual->'tables'->'shrigma_nps_vote_sync'->'columns') a WHERE a->>'name' IN('subscriber_id','payload','order_ref','vote_date') AND (a->>'notNull')::boolean IS DISTINCT FROM false) THEN RAISE EXCEPTION 'NPS_NULLABILITY_REFUSED';END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(actual->'constraints') a WHERE (a->>'relationOid')::oid=jobs_oid AND a->>'kind'='f' AND (a->>'referenceOid')::oid=subscriber_oid)<>1 THEN RAISE EXCEPTION 'NPS_FK_CARDINALITY_REFUSED';END IF;
 SELECT a INTO fk FROM jsonb_array_elements(actual->'constraints') a WHERE a->>'name'='shrigma_nps_vote_sync_subscriber_id_fkey' AND (a->>'relationOid')::oid=jobs_oid;
 IF fk IS NULL OR fk->>'kind'<>'f' OR (fk->>'referenceOid')::oid IS DISTINCT FROM subscriber_oid OR fk->'keys'<>'[2]'::jsonb OR fk->'referenceKeys'<>'[1]'::jsonb
  OR fk->>'onDelete'<>'n' OR fk->>'onUpdate'<>'a' OR fk->>'match'<>'s' OR (fk->>'deferrable')::boolean OR (fk->>'deferred')::boolean OR NOT (fk->>'validated')::boolean THEN RAISE EXCEPTION 'NPS_FK_SHAPE_REFUSED';END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(actual->'functions') a WHERE a->>'name' IN('shrigma_nps_claim_vote_sync','shrigma_nps_finish_vote_sync'))<>2 THEN RAISE EXCEPTION 'NPS_FUNCTION_CARDINALITY_REFUSED';END IF;
 FOR f IN SELECT a FROM jsonb_array_elements(actual->'functions') a WHERE a->>'name' IN('shrigma_nps_claim_vote_sync','shrigma_nps_finish_vote_sync') LOOP
  IF f->>'language'<>'plpgsql' OR f->>'volatility'<>'v' OR (f->>'securityDefiner')::boolean OR f->'config'<>'null'::jsonb
   OR (f->>'publicExecute')::boolean OR (f->>'nonOwnerExecute')::boolean
   OR f->>'returnOid'<>(CASE WHEN f->>'name'='shrigma_nps_claim_vote_sync' THEN '2249' ELSE '16' END) OR (f->>'returnsSet')::boolean IS DISTINCT FROM (f->>'name'='shrigma_nps_claim_vote_sync')
   OR f->>'argOids'<>(CASE WHEN f->>'name'='shrigma_nps_claim_vote_sync' THEN '2950' ELSE '2950 3802' END)
   OR f->>'bodySha256'<>(CASE WHEN f->>'name'='shrigma_nps_claim_vote_sync' THEN 'd6121f65e34b728c40552a06505bcd41fe6171b97ce21d013fd5ee59af247354' ELSE '54fef3bc9205cfdb31a042c33ac1a3cab06eb1e8217e70298a08644c3fea0fff' END)
  THEN RAISE EXCEPTION 'NPS_FUNCTION_PIN_REFUSED';END IF;
 END LOOP;
 IF false AND EXISTS(SELECT 1 FROM jsonb_array_elements(actual->'functions') a WHERE a->>'name' IN('shrigma_nps_claim_vote_sync','shrigma_nps_finish_vote_sync') AND a->>'definitionSha256'<>(CASE WHEN a->>'name'='shrigma_nps_claim_vote_sync' THEN '8bcc55ecd0f609a981bb87f791a63856c932535fd3147a70539cba259becf11f' ELSE 'e228e7c72cd9958d36cb33937e8f0ef667add124a0845b336fd7c3f2ba58cd16' END)) THEN RAISE EXCEPTION 'NPS_FUNCTION_DEFINITION_PIN_REFUSED';END IF;
 SELECT (a->>'oid')::oid INTO own_function FROM jsonb_array_elements(actual->'functions') a WHERE a->>'name'='shrigma_nps_detach_deleted_subscriber';
 IF (SELECT count(*) FROM jsonb_array_elements(actual->'functions') a WHERE a->>'name'='shrigma_nps_detach_deleted_subscriber')>1 THEN RAISE EXCEPTION 'NPS_OWN_FUNCTION_COLLISION';END IF;
 IF own_function IS NOT NULL THEN
  SELECT a INTO f FROM jsonb_array_elements(actual->'functions') a WHERE (a->>'oid')::oid=own_function;
  IF f->>'bodySha256'<>'6f70c57016d3414e387a6af09303f4b736b6df29980ac8f999fa935ad67ce4d8' OR f->>'argOids'<>'' OR f->>'returnOid'<>'2279' OR (f->>'returnsSet')::boolean
   OR f->>'language'<>'plpgsql' OR f->>'volatility'<>'v' OR (f->>'securityDefiner')::boolean OR f->'config'<>'["search_path=pg_catalog"]'::jsonb
   OR (f->>'ownerOid')::oid<>(actual->'tables'->'shrigma_nps_vote_sync'->>'ownerOid')::oid OR (f->>'publicExecute')::boolean OR (f->>'nonOwnerExecute')::boolean THEN RAISE EXCEPTION 'NPS_OWN_FUNCTION_COLLISION';END IF;
 END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(actual->'triggers') a WHERE a->>'name'='shrigma_nps_subscriber_delete_detach')>1 THEN RAISE EXCEPTION 'NPS_OWN_TRIGGER_COLLISION';END IF;
 SELECT a INTO own_trigger FROM jsonb_array_elements(actual->'triggers') a WHERE a->>'name'='shrigma_nps_subscriber_delete_detach';
 IF own_trigger IS NOT NULL AND ((own_trigger->>'relationOid')::oid IS DISTINCT FROM subscriber_oid OR (own_trigger->>'functionOid')::oid IS DISTINCT FROM own_function
  OR own_trigger->>'type'<>'11' OR own_trigger->>'enabled'<>'O' OR own_trigger->>'argsBytes'<>'0' OR (own_trigger->>'hasWhen')::boolean)
 THEN RAISE EXCEPTION 'NPS_OWN_TRIGGER_COLLISION';END IF;
 IF own_function IS NULL OR own_trigger IS NULL THEN RAISE EXCEPTION 'NPS_OWN_OBJECT_REQUIRED';END IF;
 IF EXISTS(SELECT 1 FROM public.shrigma_nps_vote_sync WHERE subscriber_id IS NULL) THEN RAISE EXCEPTION 'NPS_RESTORE_ERASURE_IRREVERSIBLE';END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=jobs_oid AND conname='shrigma_nps_vote_sync_detached_data_check') THEN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=jobs_oid AND conname='shrigma_nps_vote_sync_detached_data_check' AND contype='c' AND convalidated
   AND pg_get_expr(conbin,conrelid)='(((subscriber_id IS NOT NULL) AND (payload IS NOT NULL) AND (order_ref IS NOT NULL) AND (vote_date IS NOT NULL)) OR ((subscriber_id IS NULL) AND (payload IS NULL) AND (order_ref IS NULL) AND (vote_date IS NULL) AND (task_id IS NULL)))')
  THEN RAISE EXCEPTION 'NPS_OWN_CHECK_COLLISION';END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=jobs_oid AND conname='shrigma_nps_vote_sync_detached_data_check') THEN RAISE EXCEPTION 'NPS_OWN_CHECK_REQUIRED';END IF;
END $nps_guard$;
DROP TRIGGER shrigma_nps_subscriber_delete_detach ON public.subscribers;
DROP FUNCTION public.shrigma_nps_detach_deleted_subscriber() RESTRICT;
ALTER TABLE public.shrigma_nps_vote_sync DROP CONSTRAINT shrigma_nps_vote_sync_detached_data_check;
ALTER TABLE public.shrigma_nps_vote_sync DROP CONSTRAINT shrigma_nps_vote_sync_subscriber_id_fkey;
ALTER TABLE public.shrigma_nps_vote_sync ADD CONSTRAINT shrigma_nps_vote_sync_subscriber_id_fkey FOREIGN KEY(subscriber_id) REFERENCES public.subscribers(id) MATCH SIMPLE ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE;
ALTER TABLE public.shrigma_nps_vote_sync ALTER COLUMN subscriber_id SET NOT NULL, ALTER COLUMN order_ref SET NOT NULL, ALTER COLUMN vote_date SET NOT NULL, ALTER COLUMN payload SET NOT NULL;
CREATE OR REPLACE FUNCTION public.shrigma_nps_claim_vote_sync(job uuid)
RETURNS TABLE(sync_id uuid,payload jsonb)
LANGUAGE plpgsql AS $$
DECLARE j public.shrigma_nps_vote_sync%ROWTYPE;
BEGIN
 SELECT * INTO j FROM public.shrigma_nps_vote_sync WHERE id=job;
 IF NOT FOUND THEN RETURN;END IF;
 PERFORM 1 FROM subscribers WHERE id=j.subscriber_id FOR UPDATE;
 SELECT * INTO j FROM public.shrigma_nps_vote_sync WHERE id=job FOR UPDATE;
 IF NOT FOUND OR j.state<>'pending' THEN RETURN;END IF;
 -- Serialize side effects for the same subscriber, including concurrent revotes.
 IF EXISTS(SELECT 1 FROM public.shrigma_nps_vote_sync WHERE subscriber_id=j.subscriber_id AND id<>j.id AND state IN ('in_flight','outcome_unknown')) THEN RETURN;END IF;
 UPDATE public.shrigma_nps_vote_sync SET state='in_flight',updated_at=now() WHERE id=j.id;
 sync_id=j.id;payload=j.payload;
 SELECT payload||jsonb_build_object('task_id',coalesce(attribs->'nps'->>'task_id',j.task_id)) INTO payload FROM subscribers
 WHERE id=j.subscriber_id AND attribs->'nps'->>'order'=j.order_ref;
 IF payload IS NULL THEN payload=j.payload;END IF;
 RETURN NEXT;
END $$;
CREATE OR REPLACE FUNCTION public.shrigma_nps_finish_vote_sync(job uuid,result jsonb)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE j public.shrigma_nps_vote_sync%ROWTYPE;t text=nullif(result->>'task_id','');
BEGIN
 SELECT * INTO j FROM public.shrigma_nps_vote_sync WHERE id=job;
 IF NOT FOUND THEN RETURN false;END IF;
 PERFORM 1 FROM subscribers WHERE id=j.subscriber_id FOR UPDATE;
 SELECT * INTO j FROM public.shrigma_nps_vote_sync WHERE id=job FOR UPDATE;
 IF NOT FOUND OR j.state<>'in_flight' THEN RETURN false;END IF;
 UPDATE public.shrigma_nps_vote_sync SET state=CASE WHEN result->>'ok'='true' AND t IS NOT NULL THEN 'synced' ELSE 'outcome_unknown' END,
 task_id=coalesce(t,task_id),updated_at=now() WHERE id=job;
 IF t IS NOT NULL THEN
  -- Only attach the external ID; never rewrite a newer score or a concurrent comment.
  UPDATE subscribers SET attribs=jsonb_set(attribs,'{nps,task_id}',to_jsonb(t)),updated_at=now()
  WHERE id=j.subscriber_id AND attribs->'nps'->>'order'=j.order_ref AND attribs->'nps'->>'brand'=j.brand;
 END IF;
 RETURN true;
END $$;
DO $nps_guard$
DECLARE actual jsonb;expected jsonb;f jsonb;fk jsonb;jobs_oid oid;subscriber_oid oid;own_function oid;own_trigger jsonb;
BEGIN
 SELECT snapshot INTO actual FROM (WITH rels AS (
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
  'metadataSha256',encode(sha256(convert_to((to_jsonb(p)-'prosrc'-'probin'-'lanname')::text,'UTF8')),'hex')) ORDER BY p.oid) FROM funcs p),'[]'::jsonb)) AS snapshot) catalog;
 expected=current_setting('shrigma.nps.expected',true)::jsonb;
 IF expected IS NULL OR expected->>'schema'<>'nps-delete-catalog-v1' OR actual->>'serverMajor'<>'17' THEN RAISE EXCEPTION 'NPS_EXPECTED_CHECKPOINT_REQUIRED';END IF;
 IF jsonb_build_object('database',actual->'database','serverMajor',actual->'serverMajor','roleOid',actual->'roleOid',
 'tables',(SELECT jsonb_object_agg(k,v||jsonb_build_object('columns',(SELECT jsonb_agg(CASE WHEN k='shrigma_nps_vote_sync' AND a->>'name' IN('subscriber_id','payload','order_ref','vote_date') THEN a-'notNull' ELSE a END ORDER BY (a->>'ordinal')::int) FROM jsonb_array_elements(v->'columns') a))) FROM jsonb_each(actual->'tables') z(k,v)),
 'constraints',(SELECT coalesce(jsonb_agg(a ORDER BY (a->>'oid')::bigint),'[]'::jsonb) FROM jsonb_array_elements(actual->'constraints') a WHERE a->>'name' NOT IN('shrigma_nps_vote_sync_subscriber_id_fkey','shrigma_nps_vote_sync_detached_data_check')),
 'triggers',(SELECT coalesce(jsonb_agg(a ORDER BY (a->>'oid')::bigint),'[]'::jsonb) FROM jsonb_array_elements(actual->'triggers') a WHERE a->>'name'<>'shrigma_nps_subscriber_delete_detach'),
 'functions',(SELECT coalesce(jsonb_agg(CASE WHEN a->>'name' IN('shrigma_nps_claim_vote_sync','shrigma_nps_finish_vote_sync') THEN a-'bodySha256'-'bodyBytes'-'definitionSha256' ELSE a END ORDER BY (a->>'oid')::bigint),'[]'::jsonb) FROM jsonb_array_elements(actual->'functions') a WHERE a->>'name'<>'shrigma_nps_detach_deleted_subscriber')) IS DISTINCT FROM jsonb_build_object('database',expected->'database','serverMajor',expected->'serverMajor','roleOid',expected->'roleOid',
 'tables',(SELECT jsonb_object_agg(k,v||jsonb_build_object('columns',(SELECT jsonb_agg(CASE WHEN k='shrigma_nps_vote_sync' AND a->>'name' IN('subscriber_id','payload','order_ref','vote_date') THEN a-'notNull' ELSE a END ORDER BY (a->>'ordinal')::int) FROM jsonb_array_elements(v->'columns') a))) FROM jsonb_each(expected->'tables') z(k,v)),
 'constraints',(SELECT coalesce(jsonb_agg(a ORDER BY (a->>'oid')::bigint),'[]'::jsonb) FROM jsonb_array_elements(expected->'constraints') a WHERE a->>'name' NOT IN('shrigma_nps_vote_sync_subscriber_id_fkey','shrigma_nps_vote_sync_detached_data_check')),
 'triggers',(SELECT coalesce(jsonb_agg(a ORDER BY (a->>'oid')::bigint),'[]'::jsonb) FROM jsonb_array_elements(expected->'triggers') a WHERE a->>'name'<>'shrigma_nps_subscriber_delete_detach'),
 'functions',(SELECT coalesce(jsonb_agg(CASE WHEN a->>'name' IN('shrigma_nps_claim_vote_sync','shrigma_nps_finish_vote_sync') THEN a-'bodySha256'-'bodyBytes'-'definitionSha256' ELSE a END ORDER BY (a->>'oid')::bigint),'[]'::jsonb) FROM jsonb_array_elements(expected->'functions') a WHERE a->>'name'<>'shrigma_nps_detach_deleted_subscriber')) THEN RAISE EXCEPTION 'NPS_PRESERVATION_REFUSED';END IF;
 jobs_oid=(actual->'tables'->'shrigma_nps_vote_sync'->>'oid')::oid;subscriber_oid=(actual->'tables'->'subscribers'->>'oid')::oid;
 IF jobs_oid IS NULL OR subscriber_oid IS NULL OR actual->'tables'->'subscribers'->>'kind'<>'r' OR actual->'tables'->'shrigma_nps_vote_sync'->>'kind'<>'r'
  OR (actual->'tables'->'subscribers'->>'rls')::boolean OR (actual->'tables'->'shrigma_nps_vote_sync'->>'rls')::boolean
  OR (actual->'tables'->'subscribers'->>'forceRls')::boolean OR (actual->'tables'->'shrigma_nps_vote_sync'->>'forceRls')::boolean
 THEN RAISE EXCEPTION 'NPS_RELATION_SHAPE_REFUSED';END IF;
 IF NOT has_table_privilege(subscriber_oid,'DELETE') OR NOT has_table_privilege(jobs_oid,'UPDATE') THEN RAISE EXCEPTION 'NPS_CURRENT_ROLE_PRIVILEGE_REFUSED';END IF;
 IF (SELECT jsonb_agg(jsonb_build_array(a->>'name',(a->>'typeOid')::int,(a->>'ordinal')::int,(a->>'typmod')::int) ORDER BY (a->>'ordinal')::int) FROM jsonb_array_elements(actual->'tables'->'shrigma_nps_vote_sync'->'columns') a)
  IS DISTINCT FROM '[["id",2950,1,-1],["subscriber_id",23,2,-1],["brand",25,3,-1],["order_ref",25,4,-1],["vote_date",25,5,-1],["payload",3802,6,-1],["state",25,7,-1],["task_id",25,8,-1],["created_at",1184,9,-1],["updated_at",1184,10,-1]]'::jsonb
 THEN RAISE EXCEPTION 'NPS_COLUMN_SHAPE_REFUSED';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(actual->'tables'->'shrigma_nps_vote_sync'->'columns') a WHERE a->>'name' IN('subscriber_id','payload','order_ref','vote_date') AND (a->>'notNull')::boolean IS DISTINCT FROM true) THEN RAISE EXCEPTION 'NPS_NULLABILITY_REFUSED';END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(actual->'constraints') a WHERE (a->>'relationOid')::oid=jobs_oid AND a->>'kind'='f' AND (a->>'referenceOid')::oid=subscriber_oid)<>1 THEN RAISE EXCEPTION 'NPS_FK_CARDINALITY_REFUSED';END IF;
 SELECT a INTO fk FROM jsonb_array_elements(actual->'constraints') a WHERE a->>'name'='shrigma_nps_vote_sync_subscriber_id_fkey' AND (a->>'relationOid')::oid=jobs_oid;
 IF fk IS NULL OR fk->>'kind'<>'f' OR (fk->>'referenceOid')::oid IS DISTINCT FROM subscriber_oid OR fk->'keys'<>'[2]'::jsonb OR fk->'referenceKeys'<>'[1]'::jsonb
  OR fk->>'onDelete'<>'a' OR fk->>'onUpdate'<>'a' OR fk->>'match'<>'s' OR (fk->>'deferrable')::boolean OR (fk->>'deferred')::boolean OR NOT (fk->>'validated')::boolean THEN RAISE EXCEPTION 'NPS_FK_SHAPE_REFUSED';END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(actual->'functions') a WHERE a->>'name' IN('shrigma_nps_claim_vote_sync','shrigma_nps_finish_vote_sync'))<>2 THEN RAISE EXCEPTION 'NPS_FUNCTION_CARDINALITY_REFUSED';END IF;
 FOR f IN SELECT a FROM jsonb_array_elements(actual->'functions') a WHERE a->>'name' IN('shrigma_nps_claim_vote_sync','shrigma_nps_finish_vote_sync') LOOP
  IF f->>'language'<>'plpgsql' OR f->>'volatility'<>'v' OR (f->>'securityDefiner')::boolean OR f->'config'<>'null'::jsonb
   OR (f->>'publicExecute')::boolean OR (f->>'nonOwnerExecute')::boolean
   OR f->>'returnOid'<>(CASE WHEN f->>'name'='shrigma_nps_claim_vote_sync' THEN '2249' ELSE '16' END) OR (f->>'returnsSet')::boolean IS DISTINCT FROM (f->>'name'='shrigma_nps_claim_vote_sync')
   OR f->>'argOids'<>(CASE WHEN f->>'name'='shrigma_nps_claim_vote_sync' THEN '2950' ELSE '2950 3802' END)
   OR f->>'bodySha256'<>(CASE WHEN f->>'name'='shrigma_nps_claim_vote_sync' THEN 'd7e16f99696e74be022680b968470244a6269740bb656c1febaaeb9ba2f0e559' ELSE 'baf270d964263acc30a144357312d7b34bd7f199b9f8685f9c2b7df07d360acc' END)
  THEN RAISE EXCEPTION 'NPS_FUNCTION_PIN_REFUSED';END IF;
 END LOOP;
 IF true AND EXISTS(SELECT 1 FROM jsonb_array_elements(actual->'functions') a WHERE a->>'name' IN('shrigma_nps_claim_vote_sync','shrigma_nps_finish_vote_sync') AND a->>'definitionSha256'<>(CASE WHEN a->>'name'='shrigma_nps_claim_vote_sync' THEN '8bcc55ecd0f609a981bb87f791a63856c932535fd3147a70539cba259becf11f' ELSE 'e228e7c72cd9958d36cb33937e8f0ef667add124a0845b336fd7c3f2ba58cd16' END)) THEN RAISE EXCEPTION 'NPS_FUNCTION_DEFINITION_PIN_REFUSED';END IF;
 SELECT (a->>'oid')::oid INTO own_function FROM jsonb_array_elements(actual->'functions') a WHERE a->>'name'='shrigma_nps_detach_deleted_subscriber';
 IF (SELECT count(*) FROM jsonb_array_elements(actual->'functions') a WHERE a->>'name'='shrigma_nps_detach_deleted_subscriber')>1 THEN RAISE EXCEPTION 'NPS_OWN_FUNCTION_COLLISION';END IF;
 IF own_function IS NOT NULL THEN
  SELECT a INTO f FROM jsonb_array_elements(actual->'functions') a WHERE (a->>'oid')::oid=own_function;
  IF f->>'bodySha256'<>'6f70c57016d3414e387a6af09303f4b736b6df29980ac8f999fa935ad67ce4d8' OR f->>'argOids'<>'' OR f->>'returnOid'<>'2279' OR (f->>'returnsSet')::boolean
   OR f->>'language'<>'plpgsql' OR f->>'volatility'<>'v' OR (f->>'securityDefiner')::boolean OR f->'config'<>'["search_path=pg_catalog"]'::jsonb
   OR (f->>'ownerOid')::oid<>(actual->'tables'->'shrigma_nps_vote_sync'->>'ownerOid')::oid OR (f->>'publicExecute')::boolean OR (f->>'nonOwnerExecute')::boolean THEN RAISE EXCEPTION 'NPS_OWN_FUNCTION_COLLISION';END IF;
 END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(actual->'triggers') a WHERE a->>'name'='shrigma_nps_subscriber_delete_detach')>1 THEN RAISE EXCEPTION 'NPS_OWN_TRIGGER_COLLISION';END IF;
 SELECT a INTO own_trigger FROM jsonb_array_elements(actual->'triggers') a WHERE a->>'name'='shrigma_nps_subscriber_delete_detach';
 IF own_trigger IS NOT NULL AND ((own_trigger->>'relationOid')::oid IS DISTINCT FROM subscriber_oid OR (own_trigger->>'functionOid')::oid IS DISTINCT FROM own_function
  OR own_trigger->>'type'<>'11' OR own_trigger->>'enabled'<>'O' OR own_trigger->>'argsBytes'<>'0' OR (own_trigger->>'hasWhen')::boolean)
 THEN RAISE EXCEPTION 'NPS_OWN_TRIGGER_COLLISION';END IF;
 IF own_function IS NOT NULL OR own_trigger IS NOT NULL THEN RAISE EXCEPTION 'NPS_RESTORE_OWN_OBJECT_REFUSED';END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=jobs_oid AND conname='shrigma_nps_vote_sync_detached_data_check') THEN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=jobs_oid AND conname='shrigma_nps_vote_sync_detached_data_check' AND contype='c' AND convalidated
   AND pg_get_expr(conbin,conrelid)='(((subscriber_id IS NOT NULL) AND (payload IS NOT NULL) AND (order_ref IS NOT NULL) AND (vote_date IS NOT NULL)) OR ((subscriber_id IS NULL) AND (payload IS NULL) AND (order_ref IS NULL) AND (vote_date IS NULL) AND (task_id IS NULL)))')
  THEN RAISE EXCEPTION 'NPS_OWN_CHECK_COLLISION';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=jobs_oid AND conname='shrigma_nps_vote_sync_detached_data_check') THEN RAISE EXCEPTION 'NPS_RESTORE_CHECK_REFUSED';END IF;
END $nps_guard$;
