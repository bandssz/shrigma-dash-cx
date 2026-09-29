-- Candidate access for the existing crm-audience service. It remains OFF and
-- cannot update native sources, journey rows, credentials, enrollment or transport.
DO $install$
DECLARE r pg_roles%ROWTYPE;
BEGIN
 SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname='crm_audience_api';
 IF NOT FOUND OR r.rolsuper OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles p ON p.oid=m.member JOIN pg_catalog.pg_roles g ON g.oid=m.roleid WHERE p.rolname='crm_audience_api' OR g.rolname='crm_audience_api')
 OR EXISTS(SELECT 1 FROM (VALUES ('public.templates'),('public.shrigma_flow_definition'),('public.shrigma_template_email_registry'),('public.crm_dash_chave'),('public.shrigma_panel_permission_v1'),('crm_graph_candidate.control'),('crm_graph_candidate.journey'),('crm_graph_candidate.revision')) x(rel) WHERE has_table_privilege('crm_audience_api',x.rel,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege('crm_audience_api',x.rel,'INSERT,UPDATE,REFERENCES'))
 OR pg_catalog.to_regclass('crm_graph_candidate.lifecycle_publication_v1') IS NULL
 OR pg_catalog.to_regclass('crm_graph_candidate.lifecycle_prepared_v1') IS NULL
 THEN RAISE EXCEPTION 'GRAPH_LIFECYCLE_ACCESS_PRECONDITION'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='crm_graph_candidate'::regnamespace AND p.proname LIKE 'lifecycle\_%\_v1' ESCAPE '\' AND p.proname IN ('lifecycle_auth_v1','lifecycle_prepare_pins_v1','lifecycle_native_snapshot_v1','lifecycle_release_source_v1','lifecycle_release_get_v1','lifecycle_release_material_hash_v1','lifecycle_release_operation_v1','lifecycle_release_prepare_v1','lifecycle_publication_lock_v1','lifecycle_publication_commit_v1')) THEN RAISE EXCEPTION 'GRAPH_LIFECYCLE_ACCESS_COLLISION'; END IF;

 EXECUTE $ddl$CREATE FUNCTION crm_graph_candidate.lifecycle_auth_v1(k text) RETURNS jsonb
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
 WITH live AS MATERIALIZED (
  SELECT 'panel:'||c.chave AS actor FROM public.crm_dash_chave c JOIN public.shrigma_panel_permission_v1 p ON p.principal_id=c.chave AND p.area='growth'
  WHERE c.ativo AND c.revogada_em IS NULL AND c.painel IN ('growth','todos') AND c.chave_hash IS NOT NULL
   AND encode(sha256(convert_to(k,'UTF8')),'hex') IN(c.chave_hash,c.chave_hash_curta) AND (c.expira_em IS NULL OR c.expira_em>clock_timestamp()))
 SELECT jsonb_build_object('auth',public.shrigma_panel_operator_v1(k,'growth'),'live_count',(SELECT count(*) FROM live),'live_actor',(SELECT min(actor) FROM live))
 $fn$$ddl$;

 EXECUTE $ddl$CREATE FUNCTION crm_graph_candidate.lifecycle_prepare_pins_v1(jid uuid,b text,v integer) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,crm_graph_candidate AS $fn$
 DECLARE c record;j crm_graph_candidate.journey%ROWTYPE;
 BEGIN
  IF b IS NULL OR b NOT IN ('fish','aristo') OR jid IS NULL OR v IS NULL OR v<1 THEN RAISE EXCEPTION 'GRAPH_PREPARE_INPUT';END IF;
  SELECT enabled,xmin::text AS row_version INTO c FROM crm_graph_candidate.control WHERE singleton FOR SHARE;
  IF NOT FOUND OR c.enabled THEN RAISE EXCEPTION 'GRAPH_PREPARE_CONTROL';END IF;
  SELECT * INTO j FROM crm_graph_candidate.journey WHERE id=jid AND brand=b FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_PREPARE_NOT_FOUND';END IF;
  IF j.version<>v THEN RAISE EXCEPTION 'GRAPH_PREPARE_VERSION';END IF;
  RETURN jsonb_build_object('enabled',c.enabled,'row_version',c.row_version);
 END $fn$$ddl$;

 EXECUTE $ddl$CREATE FUNCTION crm_graph_candidate.lifecycle_native_snapshot_v1(b text,tid integer DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,crm_graph_candidate AS $fn$
 DECLARE s jsonb:=NULL;c jsonb;
 BEGIN
  IF b IS NULL OR b NOT IN ('fish','aristo') OR (tid IS NOT NULL AND tid<=0) THEN RAISE EXCEPTION 'GRAPH_RELEASE_BRAND';END IF;
  LOCK TABLE public.shrigma_flow_definition,public.templates,public.shrigma_template_email_registry IN SHARE MODE;
  c:=crm_graph_candidate.catalog_v1(b);
  IF tid IS NOT NULL THEN s:=crm_graph_candidate.release_source_v1(b,tid);END IF;
  RETURN jsonb_build_object('catalog',c,'source',s);
 END $fn$$ddl$;

 EXECUTE $ddl$CREATE FUNCTION crm_graph_candidate.lifecycle_release_source_v1(b text,tid integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,crm_graph_candidate AS $fn$ SELECT crm_graph_candidate.release_source_v1(b,tid) $fn$$ddl$;
 EXECUTE $ddl$CREATE FUNCTION crm_graph_candidate.lifecycle_release_get_v1(b text,rid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,crm_graph_candidate AS $fn$ SELECT crm_graph_candidate.release_get_v1(b,rid) $fn$$ddl$;
 EXECUTE $ddl$CREATE FUNCTION crm_graph_candidate.lifecycle_release_material_hash_v1(b text,rid uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,crm_graph_candidate AS $fn$ SELECT encode(sha256(convert_to(material::text,'UTF8')),'hex') FROM crm_graph_candidate.message_release_v1 WHERE id=rid AND brand=b $fn$$ddl$;
 EXECUTE $ddl$CREATE FUNCTION crm_graph_candidate.lifecycle_release_operation_v1(a text,p jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,crm_graph_candidate AS $fn$ SELECT crm_graph_candidate.release_operation_v1(a,p) $fn$$ddl$;
 EXECUTE $ddl$CREATE FUNCTION crm_graph_candidate.lifecycle_release_prepare_v1(a text,p jsonb,e jsonb,m jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,crm_graph_candidate AS $fn$ SELECT crm_graph_candidate.release_prepare_v1(a,p,e,m) $fn$$ddl$;

 EXECUTE $ddl$CREATE FUNCTION crm_graph_candidate.lifecycle_publication_lock_v1(jid uuid,b text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,crm_graph_candidate AS $fn$
 DECLARE c record;j crm_graph_candidate.journey%ROWTYPE;h text;
 BEGIN
  IF b IS NULL OR b NOT IN ('fish','aristo') OR jid IS NULL THEN RAISE EXCEPTION 'GRAPH_PUBLICATION_INPUT';END IF;
  SELECT enabled,xmin::text AS row_version INTO c FROM crm_graph_candidate.control WHERE singleton FOR SHARE;
  IF NOT FOUND OR c.enabled THEN RAISE EXCEPTION 'GRAPH_PUBLICATION_DRIFT';END IF;
  SELECT * INTO j FROM crm_graph_candidate.journey WHERE id=jid AND brand=b FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_PUBLICATION_NOT_FOUND';END IF;
  SELECT content_hash INTO h FROM crm_graph_candidate.revision WHERE journey_id=j.id AND brand=j.brand AND revision=j.head_revision;
  RETURN jsonb_build_object('control',jsonb_build_object('enabled',c.enabled,'row_version',c.row_version),'journey',jsonb_build_object('id',j.id,'brand',j.brand,'version',j.version,'head_revision',j.head_revision,'published_revision',j.published_revision,'paused',j.paused,'content_hash',h));
 END $fn$$ddl$;

 EXECUTE $ddl$CREATE FUNCTION crm_graph_candidate.lifecycle_publication_commit_v1(a text,p jsonb,pub jsonb,receipt jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,crm_graph_candidate AS $fn$
 DECLARE s crm_graph_candidate.lifecycle_prepared_v1%ROWTYPE;c record;j crm_graph_candidate.journey%ROWTYPE;next_version integer;rev integer;n jsonb;expected_receipt jsonb;
 BEGIN
  IF a IS NULL OR a!~'^panel:[A-Za-z0-9_.:-]{1,122}$' OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->>'action' IS DISTINCT FROM 'publish' OR p->>'confirm' IS DISTINCT FROM 'publicar' OR p-ARRAY['action','brand','journey_id','expected_version','request_id','prepared_revision','prepared_hash','confirm']<>'{}'::jsonb OR (SELECT count(*) FROM jsonb_object_keys(p))<>8 OR jsonb_typeof(pub) IS DISTINCT FROM 'object' OR pub-ARRAY['contract','state','request_id','brand','journey_id','base_version','base_revision','version','published_revision','prepared_id','prepared_hash','release_id','content_hash','checkout_sha','paused','authorizes_activate','authorizes_enrollment','authorizes_send','publication_hash','prepared_snapshot','request_hash']<>'{}'::jsonb OR (SELECT count(*) FROM jsonb_object_keys(pub))<>21 OR pub->>'contract' IS DISTINCT FROM 'journey_graph_lifecycle_publication_v1' OR coalesce(pub->>'publication_hash','')!~'^[a-f0-9]{64}$' OR coalesce(pub->>'request_hash','')!~'^[a-f0-9]{64}$' OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'GRAPH_PUBLICATION_INPUT';END IF;
  SELECT * INTO s FROM crm_graph_candidate.lifecycle_prepared_v1 WHERE journey_id=(p->>'journey_id')::uuid AND brand=p->>'brand' AND prepared_hash=p->>'prepared_hash';
  IF NOT FOUND OR s.actor IS DISTINCT FROM a OR s.prepared_hash IS DISTINCT FROM p->>'prepared_hash' OR s.prepared IS DISTINCT FROM pub->'prepared_snapshot' THEN RAISE EXCEPTION 'GRAPH_PUBLICATION_CORRUPT';END IF;
  n:=crm_graph_candidate.lifecycle_native_snapshot_v1(s.brand,(s.prepared#>>'{source,template_id}')::integer);
  IF n->'source' IS DISTINCT FROM s.prepared->'source' OR n->'catalog' IS DISTINCT FROM s.prepared->'planning_catalog' THEN RAISE EXCEPTION 'GRAPH_PUBLICATION_DRIFT';END IF;
  SELECT enabled,xmin::text AS row_version INTO c FROM crm_graph_candidate.control WHERE singleton FOR SHARE;
  IF NOT FOUND OR c.enabled OR s.prepared->'control_pin' IS DISTINCT FROM jsonb_build_object('enabled',c.enabled,'row_version',c.row_version) THEN RAISE EXCEPTION 'GRAPH_PUBLICATION_DRIFT';END IF;
  SELECT * INTO j FROM crm_graph_candidate.journey WHERE id=s.journey_id AND brand=s.brand FOR UPDATE;
  rev:=(p->>'prepared_revision')::integer;next_version:=(p->>'expected_version')::integer+1;
  IF NOT FOUND OR j.version IS DISTINCT FROM (p->>'expected_version')::integer OR j.head_revision IS DISTINCT FROM s.base_revision OR j.published_revision IS DISTINCT FROM (s.prepared#>>'{base,published_revision}')::integer OR j.paused IS DISTINCT FROM (s.prepared#>>'{base,paused}')::boolean
   OR s.base_version IS DISTINCT FROM (p->>'expected_version')::integer OR rev IS DISTINCT FROM s.base_revision+1 OR (s.prepared->>'proposed_revision')::integer IS DISTINCT FROM rev
   OR pub->>'request_id' IS DISTINCT FROM p->>'request_id' OR pub->>'brand' IS DISTINCT FROM s.brand OR pub->>'journey_id' IS DISTINCT FROM s.journey_id::text OR (pub->>'base_version')::integer IS DISTINCT FROM s.base_version OR (pub->>'base_revision')::integer IS DISTINCT FROM s.base_revision OR pub->>'prepared_id' IS DISTINCT FROM s.request_id::text OR pub->>'prepared_hash' IS DISTINCT FROM s.prepared_hash
   OR (pub->>'version')::integer IS DISTINCT FROM next_version OR (pub->>'published_revision')::integer IS DISTINCT FROM rev OR pub->>'state' IS DISTINCT FROM 'published_paused' OR pub->>'paused' IS DISTINCT FROM 'true'
   OR pub->>'authorizes_activate' IS DISTINCT FROM 'false' OR pub->>'authorizes_enrollment' IS DISTINCT FROM 'false' OR pub->>'authorizes_send' IS DISTINCT FROM 'false'
   OR pub->>'release_id' IS DISTINCT FROM s.release_id::text OR pub->>'content_hash' IS DISTINCT FROM s.prepared->>'content_hash' OR pub->>'checkout_sha' IS DISTINCT FROM s.prepared->>'checkout_sha'
   OR receipt->>'publication_hash' IS DISTINCT FROM pub->>'publication_hash' OR receipt->>'request_id' IS DISTINCT FROM p->>'request_id' OR receipt->>'state' IS DISTINCT FROM 'published_paused'
  THEN RAISE EXCEPTION 'GRAPH_PUBLICATION_VERSION';END IF;
  IF j.published_revision IS NOT NULL OR s.prepared#>'{base,published_revision}' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'GRAPH_PUBLICATION_ALREADY_PUBLISHED';END IF;
  expected_receipt:=jsonb_build_object('contract','journey_graph_lifecycle_publication_v1','state','published_paused','request_id',p->>'request_id','brand',s.brand,'journey_id',s.journey_id,'base_version',s.base_version,'base_revision',s.base_revision,'version',next_version,'published_revision',rev,'prepared_id',s.request_id,'prepared_hash',s.prepared_hash,'release_id',s.prepared#>>'{message,release_id}','content_hash',s.prepared->>'content_hash','checkout_sha',s.prepared->>'checkout_sha','publication_hash',pub->>'publication_hash','paused',true,'authorizes_activate',false,'authorizes_enrollment',false,'authorizes_send',false);
  IF receipt IS DISTINCT FROM expected_receipt THEN RAISE EXCEPTION 'GRAPH_PUBLICATION_CORRUPT';END IF;
  INSERT INTO crm_graph_candidate.revision(journey_id,brand,revision,definition,catalog,content_hash,created_at) VALUES(s.journey_id,s.brand,rev,s.prepared->'definition',s.prepared->'operational_catalog',s.prepared->>'content_hash',date_trunc('milliseconds',clock_timestamp()));
  UPDATE crm_graph_candidate.journey SET version=next_version,head_revision=rev,published_revision=rev,paused=true WHERE id=j.id;
  INSERT INTO crm_graph_candidate.lifecycle_publication_v1(request_id,prepared_id,actor,brand,journey_id,base_version,base_revision,published_revision,prepared_hash,publication_hash,publication) VALUES((p->>'request_id')::uuid,s.request_id,a,s.brand,s.journey_id,s.base_version,s.base_revision,rev,s.prepared_hash,pub->>'publication_hash',pub-ARRAY['prepared_snapshot','request_hash']);
  INSERT INTO crm_graph_candidate.lifecycle_publication_operation_v1(request_id,actor,brand,request_hash,request,response) VALUES((p->>'request_id')::uuid,a,s.brand,pub->>'request_hash',p,receipt);
  RETURN jsonb_build_object('publication',pub-ARRAY['prepared_snapshot','request_hash'],'receipt',receipt);
 END $fn$$ddl$;

 REVOKE ALL ON FUNCTION crm_graph_candidate.lifecycle_auth_v1(text),crm_graph_candidate.lifecycle_prepare_pins_v1(uuid,text,integer),crm_graph_candidate.lifecycle_native_snapshot_v1(text,integer),crm_graph_candidate.lifecycle_release_source_v1(text,integer),crm_graph_candidate.lifecycle_release_get_v1(text,uuid),crm_graph_candidate.lifecycle_release_material_hash_v1(text,uuid),crm_graph_candidate.lifecycle_release_operation_v1(text,jsonb),crm_graph_candidate.lifecycle_release_prepare_v1(text,jsonb,jsonb,jsonb),crm_graph_candidate.lifecycle_publication_lock_v1(uuid,text),crm_graph_candidate.lifecycle_publication_commit_v1(text,jsonb,jsonb,jsonb) FROM PUBLIC;
 GRANT USAGE ON SCHEMA crm_graph_candidate TO crm_audience_api;
 GRANT SELECT,INSERT ON crm_graph_candidate.lifecycle_review_v1,crm_graph_candidate.lifecycle_prepared_v1,crm_graph_candidate.lifecycle_prepare_operation_v1 TO crm_audience_api;
 GRANT SELECT ON crm_graph_candidate.lifecycle_publication_v1,crm_graph_candidate.lifecycle_publication_operation_v1 TO crm_audience_api;
 GRANT SELECT ON crm_graph_candidate.control,crm_graph_candidate.journey,crm_graph_candidate.revision TO crm_audience_api;
 GRANT EXECUTE ON FUNCTION crm_graph_candidate.lifecycle_auth_v1(text),crm_graph_candidate.lifecycle_prepare_pins_v1(uuid,text,integer),crm_graph_candidate.lifecycle_native_snapshot_v1(text,integer),crm_graph_candidate.lifecycle_release_source_v1(text,integer),crm_graph_candidate.lifecycle_release_get_v1(text,uuid),crm_graph_candidate.lifecycle_release_material_hash_v1(text,uuid),crm_graph_candidate.lifecycle_release_operation_v1(text,jsonb),crm_graph_candidate.lifecycle_release_prepare_v1(text,jsonb,jsonb,jsonb),crm_graph_candidate.lifecycle_publication_lock_v1(uuid,text),crm_graph_candidate.lifecycle_publication_commit_v1(text,jsonb,jsonb,jsonb) TO crm_audience_api;
END $install$;
