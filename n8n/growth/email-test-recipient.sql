-- Additive recipient-selectable template tests. Reapplying preserves policy and receipts; new installation starts OFF.
BEGIN;
SET LOCAL lock_timeout='3s';
CREATE TABLE IF NOT EXISTS public.crm_email_test_policy_v2(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),enabled boolean NOT NULL DEFAULT false);
INSERT INTO public.crm_email_test_policy_v2 VALUES(true,false) ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.crm_email_test_allowlist_v2(brand text NOT NULL CHECK(brand IN ('fish','aristo')),recipient text NOT NULL,enabled boolean NOT NULL,expires_at timestamptz NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),actor text NOT NULL CHECK(actor LIKE 'panel:%'),PRIMARY KEY(brand,recipient));
CREATE TABLE IF NOT EXISTS public.crm_email_test_allowlist_audit_v2(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,brand text NOT NULL,recipient text NOT NULL,enabled boolean NOT NULL,expires_at timestamptz NOT NULL,actor text NOT NULL,at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE IF NOT EXISTS public.crm_email_test_preview_v2(token text PRIMARY KEY CHECK(token~'^[a-f0-9]{64}$'),actor text NOT NULL,draft_id text NOT NULL,draft_version integer NOT NULL,brand text NOT NULL,recipient text NOT NULL,snapshot_hash text NOT NULL,source_hash text,rendered_hash text,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE IF NOT EXISTS public.crm_email_test_operation_v2(id uuid PRIMARY KEY,actor text NOT NULL CHECK(actor LIKE 'panel:%'),request_payload jsonb NOT NULL,request_sha256 text NOT NULL CHECK(request_sha256~'^[a-f0-9]{64}$'),draft_id text NOT NULL,draft_version integer NOT NULL CHECK(draft_version>0),recipient text NOT NULL,brand text CHECK(brand IN ('fish','aristo')),state text NOT NULL CHECK(state IN ('rejected','claimed','accepted','outcome_unknown')),code text NOT NULL,dispatch_id uuid UNIQUE REFERENCES public.shrigma_email_dispatch(dispatch_id),template_id integer,content_sha256 text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,CHECK((state='rejected')=(dispatch_id IS NULL)));
CREATE UNIQUE INDEX IF NOT EXISTS crm_email_test_once_v2 ON public.crm_email_test_operation_v2(draft_id,draft_version,recipient) WHERE dispatch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_email_test_quota_actor_v2 ON public.crm_email_test_operation_v2(actor,created_at) WHERE dispatch_id IS NOT NULL;
REVOKE ALL ON public.crm_email_test_policy_v2,public.crm_email_test_allowlist_v2,public.crm_email_test_allowlist_audit_v2,public.crm_email_test_preview_v2,public.crm_email_test_operation_v2 FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.crm_email_test_normalize_v2(e text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN length(e)<=254 AND lower(btrim(e))~'^[a-z0-9][a-z0-9._+\-]*@[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)+$' AND position('..' in e)=0 THEN lower(btrim(e)) END
$$;
CREATE OR REPLACE FUNCTION public.crm_email_test_capabilities_v2(actor text) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN public.crm_email_test_actor_v1(actor) THEN jsonb_build_object('_http',200,'_body',jsonb_build_object('contract','crm_email_test_recipient_v2','policy_version',2,'enabled',p.enabled,'brands',jsonb_build_array('fish','aristo'),'recipient_input',true,'existing_only',false,'limits',jsonb_build_object('per_revision',5,'per_actor_hour',20),'preview_ttl_seconds',300,'prefix','[TESTE] ')) ELSE jsonb_build_object('_http',403,'_body',jsonb_build_object('erro','manager_required')) END FROM public.crm_email_test_policy_v2 p WHERE singleton
$$;
CREATE OR REPLACE FUNCTION public.crm_email_test_testers_v2(actor text,b text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE rows jsonb;
BEGIN
 IF NOT public.crm_email_test_actor_v1(actor) THEN RETURN jsonb_build_object('_http',403,'_body',jsonb_build_object('erro','manager_required'));END IF;
 IF b IS NULL OR b NOT IN ('fish','aristo') THEN RAISE EXCEPTION 'EMAIL_TEST_REQUEST_INVALID';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('recipient',a.recipient,'enabled',a.enabled,'expires_at',a.expires_at,'updated_at',a.updated_at) ORDER BY a.recipient),'[]') INTO rows FROM public.crm_email_test_allowlist_v2 a WHERE a.brand=b;
 RETURN jsonb_build_object('_http',200,'_body',jsonb_build_object('contract','crm_email_test_recipient_v2','brand',b,'testers',rows));
END $$;
CREATE OR REPLACE FUNCTION public.crm_email_test_set_tester_v2(actor text,b text,e text,allowed boolean) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE addr text:=public.crm_email_test_normalize_v2(e);expiry timestamptz:=clock_timestamp()+interval '30 days';
BEGIN
 PERFORM 1 FROM public.crm_email_test_policy_v2 WHERE singleton FOR UPDATE;
 IF NOT public.crm_email_test_actor_v1(actor) THEN RETURN jsonb_build_object('_http',403,'_body',jsonb_build_object('erro','manager_required'));END IF;
 IF b IS NULL OR b NOT IN ('fish','aristo') OR addr IS NULL OR allowed IS NULL THEN RAISE EXCEPTION 'EMAIL_TEST_REQUEST_INVALID';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.crm_email_test_allowlist_v2 WHERE brand=b AND recipient=addr) AND (SELECT count(*) FROM public.crm_email_test_allowlist_v2 WHERE brand=b)>=50 THEN RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('erro','tester_limit'));END IF;
 INSERT INTO public.crm_email_test_allowlist_v2 AS a(brand,recipient,enabled,expires_at,actor) VALUES(b,addr,allowed,expiry,actor) ON CONFLICT(brand,recipient) DO UPDATE SET enabled=excluded.enabled,expires_at=excluded.expires_at,actor=excluded.actor,updated_at=clock_timestamp();
 INSERT INTO public.crm_email_test_allowlist_audit_v2(brand,recipient,enabled,expires_at,actor) VALUES(b,addr,allowed,expiry,actor);
 RETURN public.crm_email_test_testers_v2(actor,b);
END $$;
CREATE OR REPLACE FUNCTION public.crm_email_test_recipient_v2(b text,e text) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN b IS NULL OR b NOT IN ('fish','aristo') THEN 'brand_unavailable'
 WHEN public.crm_email_test_normalize_v2(e) IS NULL OR e<>public.crm_email_test_normalize_v2(e) THEN 'recipient_invalid'
 WHEN EXISTS(SELECT 1 FROM public.crm_email_test_allowlist_v2 a WHERE a.brand=b AND a.recipient=e AND (NOT a.enabled OR a.expires_at<=statement_timestamp())) THEN 'recipient_not_allowed'
 WHEN split_part(e,'@',2) NOT IN ('oaristocrata.com','fishermans.com.br','shrigma.com.br') AND NOT EXISTS(SELECT 1 FROM public.crm_email_test_allowlist_v2 a WHERE a.brand=b AND a.recipient=e AND a.enabled AND a.expires_at>statement_timestamp()) THEN 'recipient_not_allowed'
 WHEN (SELECT count(*) FROM public.subscribers s WHERE lower(s.email)=e)>1 THEN 'recipient_ambiguous'
 WHEN EXISTS(SELECT 1 FROM public.subscribers s WHERE lower(s.email)=e AND s.status::text<>'enabled') THEN 'recipient_disabled'
 WHEN EXISTS(SELECT 1 FROM public.subscriber_lists sl JOIN public.subscribers s ON s.id=sl.subscriber_id JOIN public.lists l ON l.id=sl.list_id WHERE lower(s.email)=e AND ((b='fish' AND (l.id=17 OR coalesce(l.tags,'{}')&&ARRAY['fish','fishermans']::varchar[])) OR (b='aristo' AND (l.id=16 OR coalesce(l.tags,'{}')&&ARRAY['aristo','aristocrata']::varchar[]))) AND sl.status::text='unsubscribed') THEN 'recipient_opted_out' END
$$;
CREATE OR REPLACE FUNCTION public.crm_email_test_snapshot_v2(actor text,did text,v integer,e text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE d public.shrigma_template_draft%ROWTYPE;s public.shrigma_template_submissao%ROWTYPE;t public.templates%ROWTYPE;reason text;recipient jsonb;
BEGIN
 IF NOT public.crm_email_test_actor_v1(actor) THEN RETURN jsonb_build_object('eligible',false,'code','manager_required');END IF;
 IF NOT EXISTS(SELECT 1 FROM public.crm_email_test_policy_v2 WHERE singleton AND enabled) THEN RETURN jsonb_build_object('eligible',false,'code','recipient_policy_disabled');END IF;
 SELECT * INTO d FROM public.shrigma_template_draft WHERE draft_id=did;
 IF NOT FOUND OR d.channel<>'email' OR d.brand NOT IN ('fish','aristo') THEN RETURN jsonb_build_object('eligible',false,'code','draft_unavailable');END IF;
 IF d.rascunho->>'marca' IS DISTINCT FROM d.brand OR d.rascunho->>'canal' IS DISTINCT FROM 'email' THEN RETURN jsonb_build_object('eligible',false,'code','draft_unavailable');END IF;
 IF d.version IS DISTINCT FROM v THEN RETURN jsonb_build_object('eligible',false,'code','version_conflict');END IF;
 IF d.estado<>'publicado' OR NOT EXISTS(SELECT 1 FROM public.shrigma_template_evento e WHERE e.draft_id=did AND e.action='validate' AND e.to_version=v AND e.result='ok') THEN RETURN jsonb_build_object('eligible',false,'code','published_validated_version_required');END IF;
 IF (SELECT count(*) FROM public.shrigma_template_submissao WHERE draft_id=did AND draft_version=v AND provider='listmonk' AND estado='publicado' AND provider_status='APPROVED')<>1 THEN RETURN jsonb_build_object('eligible',false,'code','published_identity_ambiguous');END IF;
 SELECT * INTO s FROM public.shrigma_template_submissao WHERE draft_id=did AND draft_version=v AND provider='listmonk' AND estado='publicado' AND provider_status='APPROVED';
 IF s.provider_id!~'^[1-9][0-9]{0,8}$' OR s.provider_id IS NULL THEN RETURN jsonb_build_object('eligible',false,'code','provider_identity_invalid');END IF;
 SELECT * INTO t FROM public.templates WHERE id=s.provider_id::integer AND type::text='tx';
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.shrigma_template_email_registry r WHERE r.template_id=t.id AND r.draft_id=did AND r.brand=d.brand)
 OR t.subject IS DISTINCT FROM d.components->>'subject' OR t.body IS DISTINCT FROM d.components->>'body_html' THEN RETURN jsonb_build_object('eligible',false,'code','published_content_mismatch');END IF;
 reason:=public.crm_email_test_recipient_v2(d.brand,e);IF reason IS NOT NULL THEN RETURN jsonb_build_object('eligible',false,'code',reason);END IF;
 SELECT jsonb_build_object('id',x.id,'email',x.email,'name',coalesce(x.name,''),'uuid',x.uuid::text) INTO recipient FROM public.subscribers x WHERE lower(x.email)=e;
 IF EXISTS(SELECT 1 FROM public.crm_email_test_operation_v2 o WHERE o.draft_id=did AND o.draft_version=v AND o.recipient=e AND o.dispatch_id IS NOT NULL)
 OR (e='felipebandeira@oaristocrata.com' AND EXISTS(SELECT 1 FROM public.crm_email_test_operation_v1 o WHERE o.draft_id=did AND o.draft_version=v AND o.dispatch_id IS NOT NULL)) THEN RETURN jsonb_build_object('eligible',false,'code','recipient_already_attempted');END IF;
 IF (SELECT count(*) FROM public.crm_email_test_operation_v2 o WHERE o.draft_id=did AND o.draft_version=v AND o.dispatch_id IS NOT NULL)+(SELECT count(*) FROM public.crm_email_test_operation_v1 o WHERE o.draft_id=did AND o.draft_version=v AND o.dispatch_id IS NOT NULL)>=5 THEN RETURN jsonb_build_object('eligible',false,'code','revision_quota');END IF;
 IF (SELECT count(*) FROM public.crm_email_test_operation_v2 o WHERE o.actor=$1 AND o.created_at>statement_timestamp()-interval '1 hour' AND o.dispatch_id IS NOT NULL)+(SELECT count(*) FROM public.crm_email_test_operation_v1 o WHERE o.actor=$1 AND o.created_at>statement_timestamp()-interval '1 hour' AND o.dispatch_id IS NOT NULL)>=20 THEN RETURN jsonb_build_object('eligible',false,'code','actor_quota');END IF;
 RETURN jsonb_build_object('eligible',true,'recipient',e,'subscriber',recipient,'draft_id',did,'version',v,'brand',d.brand,'rascunho',d.rascunho,'components',d.components,
 'native',jsonb_build_object('id',t.id,'type',t.type,'subject',t.subject,'body',t.body),'submission_id',s.submission_id);
END $$;
CREATE OR REPLACE FUNCTION public.crm_email_test_operation_v2(actor text,oid uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE o public.crm_email_test_operation_v2%ROWTYPE;events jsonb;
BEGIN
 IF NOT public.crm_email_test_actor_v1(actor) THEN RETURN jsonb_build_object('_http',403,'_body',jsonb_build_object('erro','manager_required'));END IF;
 SELECT * INTO o FROM public.crm_email_test_operation_v2 WHERE id=oid;
 IF FOUND AND o.actor<>actor THEN RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('erro','operation_identity_mismatch'));END IF;
 IF o.id IS NULL THEN RETURN jsonb_build_object('_http',200,'_body',jsonb_build_object('contract','crm_email_test_recipient_v2','operation',jsonb_build_object('idempotency_key',oid,'actor',actor,'state','missing','request_payload',NULL,'request_sha256',NULL,'http_accepted',false,'ses',jsonb_build_object())));END IF;
 SELECT coalesce(jsonb_object_agg(e.status,e.at),'{}') INTO events FROM (SELECT s.status,max(s.ocorreu_em) at FROM public.shrigma_email_status s
 WHERE s.dispatch_id=o.dispatch_id AND s.is_test=true AND s.reconciliation_status='matched' GROUP BY s.status)e;
 RETURN jsonb_build_object('_http',200,'_body',jsonb_build_object('contract','crm_email_test_recipient_v2','operation',jsonb_build_object(
 'idempotency_key',o.id,'actor',o.actor,'state',o.state,'code',o.code,'request_payload',o.request_payload,'request_sha256',o.request_sha256,'request_hash_schema','postgres-jsonb-text-sha256-v1',
 'draft_id',o.draft_id,'version',o.draft_version,'template_id',o.template_id,'content_sha256',o.content_sha256,'dispatch_id',o.dispatch_id,
 'http_accepted',o.state='accepted','ses',events,'created_at',o.created_at,'finished_at',o.finished_at)));
END $$;
CREATE OR REPLACE FUNCTION public.crm_email_test_request_v2(p jsonb,sending boolean) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(jsonb_typeof(p)='object' AND (p-CASE WHEN sending THEN ARRAY['draft_id','expected_version','recipient','preview_token','idempotency_key','confirm'] ELSE ARRAY['draft_id','expected_version','recipient'] END)='{}'::jsonb
 AND (SELECT count(*) FROM jsonb_object_keys(p))=CASE WHEN sending THEN 6 ELSE 3 END
 AND jsonb_typeof(p->'expected_version')='number' AND coalesce(p->>'draft_id','')~'^d_[A-Za-z0-9_-]{1,96}$' AND coalesce(p->>'expected_version','')~'^[1-9][0-9]{0,8}$'
 AND public.crm_email_test_normalize_v2(p->>'recipient')=p->>'recipient'
 AND (NOT sending OR (coalesce(p->>'preview_token','')~'^[a-f0-9]{64}$' AND coalesce(p->>'idempotency_key','')~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$' AND p->>'confirm'='enviar_teste')),false)
$$;
CREATE OR REPLACE FUNCTION public.crm_email_test_prepare_v2(actor text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE snap jsonb;t text;expiry timestamptz:=clock_timestamp()+interval '5 minutes';
BEGIN
 IF NOT public.crm_email_test_request_v2(p,false) THEN RAISE EXCEPTION 'EMAIL_TEST_REQUEST_INVALID';END IF;
 snap:=public.crm_email_test_snapshot_v2(actor,p->>'draft_id',(p->>'expected_version')::integer,p->>'recipient');
 IF snap->>'eligible' IS DISTINCT FROM 'true' THEN RETURN snap;END IF;
 t:=encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex');
 INSERT INTO public.crm_email_test_preview_v2(token,actor,draft_id,draft_version,brand,recipient,snapshot_hash,expires_at) VALUES(t,actor,p->>'draft_id',(p->>'expected_version')::integer,snap->>'brand',p->>'recipient',encode(sha256(convert_to(snap::text,'UTF8')),'hex'),expiry);
 RETURN jsonb_build_object('eligible',true,'snapshot',snap,'preview_token',t,'expires_at',expiry);
END $$;
CREATE OR REPLACE FUNCTION public.crm_email_test_review_v2(actor text,p jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE snap jsonb;rev public.crm_email_test_preview_v2%ROWTYPE;
BEGIN
 IF NOT public.crm_email_test_request_v2(p,true) THEN RAISE EXCEPTION 'EMAIL_TEST_REQUEST_INVALID';END IF;
 snap:=public.crm_email_test_snapshot_v2(actor,p->>'draft_id',(p->>'expected_version')::integer,p->>'recipient');
 IF snap->>'eligible' IS DISTINCT FROM 'true' THEN RETURN snap;END IF;
 SELECT * INTO rev FROM public.crm_email_test_preview_v2 pv WHERE pv.token=p->>'preview_token';
 IF NOT FOUND OR rev.actor IS DISTINCT FROM actor OR rev.draft_id IS DISTINCT FROM p->>'draft_id' OR rev.draft_version IS DISTINCT FROM (p->>'expected_version')::integer OR rev.recipient IS DISTINCT FROM p->>'recipient' OR rev.expires_at<=statement_timestamp() OR rev.source_hash IS NULL OR rev.snapshot_hash IS DISTINCT FROM encode(sha256(convert_to(snap::text,'UTF8')),'hex') THEN RETURN jsonb_build_object('eligible',false,'code','preview_changed');END IF;
 RETURN jsonb_build_object('eligible',true,'snapshot',snap,'preview_token',rev.token,'expires_at',rev.expires_at);
END $$;
CREATE OR REPLACE FUNCTION public.crm_email_test_plan_v2(plan jsonb,snap jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(plan->>'eligible'='true' AND plan->'snapshot'=snap AND plan->>'recipient'=snap->>'recipient'
 AND plan->>'profile'='crm_email_synthetic_v1' AND plan->'native_verified'='true'::jsonb AND plan->'native_render_verified'='true'::jsonb
 AND plan->>'from_email'=snap#>>'{rascunho,from_email}' AND plan->>'reply_to'=snap#>>'{rascunho,reply_to}'
 AND jsonb_typeof(plan->'data')='object' AND NOT EXISTS(SELECT 1 FROM jsonb_each(plan->'data') x WHERE NOT(public.crm_email_native_data_v1(snap->>'brand')?x.key) OR x.value IS DISTINCT FROM public.crm_email_native_data_v1(snap->>'brand')->x.key)
 AND plan->'context'=jsonb_build_object('Tx',jsonb_build_object('Data',plan->'data'),'Subscriber',CASE WHEN plan->>'subscriber_mode'='default' THEN jsonb_build_object('Name',snap#>>'{subscriber,name}','UUID',snap#>>'{subscriber,uuid}') ELSE jsonb_build_object('Name','','UUID','') END)
 AND plan->>'subscriber_mode' IN ('default','external') AND plan->'requires_subscriber'=to_jsonb(plan->>'subscriber_mode'='default')
 AND (plan->>'subscriber_mode'='external' OR (public.crm_email_test_normalize_v2(snap#>>'{subscriber,email}')=snap->>'recipient' AND coalesce(snap#>>'{subscriber,uuid}','')~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' AND length(snap#>>'{subscriber,name}')<=255))
 AND plan->>'subject'='[TESTE] '||regexp_replace(snap#>>'{native,subject}','^(✅ FINAL — |\[TESTE\] )+','')
 AND jsonb_typeof(plan->'body_html')='string' AND length(plan->>'body_html') BETWEEN 1 AND 400000 AND coalesce(plan->>'source_hash','')~'^[a-f0-9]{64}$',false)
$$;
CREATE OR REPLACE FUNCTION public.crm_email_test_preview_finish_v2(actor text,t text,plan jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE rev public.crm_email_test_preview_v2%ROWTYPE;snap jsonb;
BEGIN
 SELECT * INTO rev FROM public.crm_email_test_preview_v2 WHERE token=t FOR UPDATE;
 IF NOT FOUND OR rev.actor IS DISTINCT FROM actor OR rev.expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('eligible',false,'code','preview_changed');END IF;
 snap:=public.crm_email_test_snapshot_v2(actor,rev.draft_id,rev.draft_version,rev.recipient);
 IF snap->>'eligible' IS DISTINCT FROM 'true' THEN RETURN snap;END IF;
 IF rev.snapshot_hash IS DISTINCT FROM encode(sha256(convert_to(snap::text,'UTF8')),'hex') OR plan->>'preview_token' IS DISTINCT FROM t OR NOT public.crm_email_test_plan_v2(plan,snap) THEN RETURN jsonb_build_object('eligible',false,'code','preview_changed');END IF;
 IF rev.source_hash IS NOT NULL AND (rev.source_hash IS DISTINCT FROM plan->>'source_hash' OR rev.rendered_hash IS DISTINCT FROM encode(sha256(convert_to(plan->>'body_html','UTF8')),'hex')) THEN RETURN jsonb_build_object('eligible',false,'code','preview_changed');END IF;
 UPDATE public.crm_email_test_preview_v2 SET source_hash=plan->>'source_hash',rendered_hash=encode(sha256(convert_to(plan->>'body_html','UTF8')),'hex') WHERE token=t;
 RETURN jsonb_build_object('eligible',true,'code','ready');
END $$;
CREATE OR REPLACE FUNCTION public.crm_email_test_claim_v2(actor text,p jsonb,plan jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE o public.crm_email_test_operation_v2%ROWTYPE;rev public.crm_email_test_preview_v2%ROWTYPE;snap jsonb;reason text;oid uuid;did uuid;token uuid;cfg text;tx jsonb;hash text;b text;
BEGIN
 IF NOT public.crm_email_test_actor_v1(actor) THEN RETURN jsonb_build_object('should_send',false,'result',jsonb_build_object('_http',403,'_body',jsonb_build_object('erro','manager_required')));END IF;
 IF NOT public.crm_email_test_request_v2(p,true) THEN RAISE EXCEPTION 'EMAIL_TEST_REQUEST_INVALID';END IF;
 oid:=(p->>'idempotency_key')::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended('crm-email-test-operation:'||oid,0));
 SELECT * INTO o FROM public.crm_email_test_operation_v2 WHERE id=oid;
 IF FOUND THEN
  IF o.actor<>actor OR o.request_payload IS DISTINCT FROM p THEN RETURN jsonb_build_object('should_send',false,'result',jsonb_build_object('_http',409,'_body',jsonb_build_object('erro','operation_identity_mismatch')));END IF;
  RETURN jsonb_build_object('should_send',false,'result',public.crm_email_test_operation_v2(actor,oid));
 END IF;
 PERFORM 1 FROM public.crm_email_test_policy_v2 WHERE singleton FOR SHARE;
 PERFORM pg_advisory_xact_lock(hashtextextended('crm-email-test-actor:'||actor,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('crm-email-test-version:'||(p->>'draft_id')||':'||(p->>'expected_version'),0));
 PERFORM 1 FROM public.shrigma_template_draft WHERE draft_id=p->>'draft_id' FOR SHARE;
 PERFORM 1 FROM public.subscribers WHERE lower(email)=p->>'recipient' FOR SHARE;
 PERFORM 1 FROM public.subscriber_lists sl JOIN public.subscribers s ON s.id=sl.subscriber_id WHERE lower(s.email)=p->>'recipient' FOR SHARE OF sl;
 SELECT brand INTO b FROM public.shrigma_template_draft WHERE draft_id=p->>'draft_id' AND brand IN ('fish','aristo');
 PERFORM 1 FROM public.crm_email_test_allowlist_v2 WHERE brand=b AND recipient=p->>'recipient' FOR SHARE;
 SELECT * INTO rev FROM public.crm_email_test_preview_v2 pv WHERE pv.token=p->>'preview_token' FOR UPDATE;
 snap:=public.crm_email_test_snapshot_v2(actor,p->>'draft_id',(p->>'expected_version')::integer,p->>'recipient');
 IF snap->>'eligible'='true' THEN
  PERFORM 1 FROM public.templates WHERE id=(snap#>>'{native,id}')::integer FOR SHARE;
  snap:=public.crm_email_test_snapshot_v2(actor,p->>'draft_id',(p->>'expected_version')::integer,p->>'recipient');
 END IF;
 IF snap->>'eligible' IS DISTINCT FROM 'true' THEN reason:=snap->>'code';
 ELSIF plan->>'eligible' IS DISTINCT FROM 'true' THEN reason:=CASE WHEN plan->>'code' IN ('recipient_identity_required','recipient_identity_unavailable','subject_invalid','native_preview_unconfirmed','native_preview_unsafe','preview_context_invalid') THEN plan->>'code' ELSE 'plan_unavailable' END;
 ELSIF rev.actor IS DISTINCT FROM actor OR rev.draft_id IS DISTINCT FROM p->>'draft_id' OR rev.draft_version IS DISTINCT FROM (p->>'expected_version')::integer OR rev.recipient IS DISTINCT FROM p->>'recipient' OR rev.expires_at<=clock_timestamp() OR rev.token IS NULL
 OR rev.snapshot_hash IS DISTINCT FROM encode(sha256(convert_to(snap::text,'UTF8')),'hex') OR rev.source_hash IS DISTINCT FROM plan->>'source_hash' OR rev.rendered_hash IS DISTINCT FROM encode(sha256(convert_to(plan->>'body_html','UTF8')),'hex') OR plan->>'preview_token' IS DISTINCT FROM p->>'preview_token' THEN reason:='preview_changed';
 ELSIF NOT public.crm_email_test_plan_v2(plan,snap) THEN reason:='plan_changed';END IF;
 IF reason IS NOT NULL THEN
  INSERT INTO public.crm_email_test_operation_v2(id,actor,request_payload,request_sha256,draft_id,draft_version,recipient,brand,state,code,finished_at) VALUES(oid,actor,p,encode(sha256(convert_to(p::text,'UTF8')),'hex'),p->>'draft_id',(p->>'expected_version')::integer,p->>'recipient',b,'rejected',reason,clock_timestamp());
  RETURN jsonb_build_object('should_send',false,'result',public.crm_email_test_operation_v2(actor,oid));
 END IF;
 did:=gen_random_uuid();token:=gen_random_uuid();cfg:=CASE b WHEN 'fish' THEN 'cs-fishermans-tx' ELSE 'cs-aristocrata-tx' END;hash:=encode(sha256(convert_to(snap::text,'UTF8')),'hex');
 tx:=jsonb_build_object('subscriber_email',CASE WHEN plan->>'subscriber_mode'='default' THEN snap#>>'{subscriber,email}' ELSE p->>'recipient' END,'subscriber_mode',plan->>'subscriber_mode','template_id',(snap#>>'{native,id}')::integer,'content_type','html','from_email',plan->>'from_email','subject',plan->>'subject','data',plan->'data','headers',jsonb_build_array(jsonb_build_object('Reply-To',plan->>'reply_to'),jsonb_build_object('X-SES-CONFIGURATION-SET',cfg),jsonb_build_object('X-SES-MESSAGE-TAGS','crm_dispatch_id='||did||', crm_test=true')));
 INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,account_id,region,configuration_set,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token) SELECT did,b,'crm-test','template-v2',jsonb_build_array(p->>'draft_id',(p->>'expected_version')::integer,p->>'recipient')::text,hash,'379757086665','us-east-2',cfg,k.recipient_key,k.key_version,true,'in_flight',clock_timestamp(),token FROM public.shrigma_email_recipient_key(p->>'recipient') k;
 IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_TEST_RECIPIENT_KEY_UNAVAILABLE';END IF;
 INSERT INTO public.crm_email_test_operation_v2(id,actor,request_payload,request_sha256,draft_id,draft_version,recipient,brand,state,code,dispatch_id,template_id,content_sha256) VALUES(oid,actor,p,encode(sha256(convert_to(p::text,'UTF8')),'hex'),p->>'draft_id',(p->>'expected_version')::integer,p->>'recipient',b,'claimed','transport_unconfirmed',did,(snap#>>'{native,id}')::integer,hash);
 RETURN jsonb_build_object('should_send',true,'operation_id',oid,'dispatch_id',did,'claim_token',token,'payload',tx);
END $$;
CREATE OR REPLACE FUNCTION public.crm_email_test_finish_v2(oid uuid,token uuid,outcome text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE o public.crm_email_test_operation_v2%ROWTYPE;d public.shrigma_email_dispatch%ROWTYPE;
BEGIN
 IF outcome NOT IN ('accepted','outcome_unknown') OR outcome IS NULL THEN RAISE EXCEPTION 'EMAIL_TEST_OUTCOME_INVALID';END IF;
 SELECT * INTO STRICT o FROM public.crm_email_test_operation_v2 WHERE id=oid FOR UPDATE;
 SELECT * INTO STRICT d FROM public.shrigma_email_dispatch WHERE dispatch_id=o.dispatch_id FOR UPDATE;
 IF token IS NULL OR d.claim_token IS DISTINCT FROM token OR NOT d.is_test OR d.flow<>'crm-test' OR d.piece<>'template-v2' THEN RAISE EXCEPTION 'EMAIL_TEST_CLAIM_MISMATCH';END IF;
 IF o.state NOT IN ('claimed',outcome) THEN RAISE EXCEPTION 'EMAIL_TEST_OUTCOME_CONFLICT';END IF;
 UPDATE public.shrigma_email_dispatch SET transport_state=outcome,outcome_at=clock_timestamp(),accepted_at=CASE WHEN outcome='accepted' THEN coalesce(accepted_at,clock_timestamp()) END,error_code=CASE WHEN outcome='outcome_unknown' THEN 'LISTMONK_UNCONFIRMED' END WHERE dispatch_id=o.dispatch_id;
 UPDATE public.crm_email_test_operation_v2 SET state=outcome,code=CASE WHEN outcome='accepted' THEN 'http_accepted' ELSE 'transport_unconfirmed' END,finished_at=clock_timestamp() WHERE id=oid;
 RETURN public.crm_email_test_operation_v2(o.actor,oid);
END $$;
-- Only the deployment role can enable the additive route after draining legacy attempts.
CREATE OR REPLACE FUNCTION public.crm_email_test_enable_v2(value boolean) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
BEGIN
 IF value IS NULL THEN RAISE EXCEPTION 'EMAIL_TEST_POLICY_INVALID';END IF;
 PERFORM 1 FROM public.crm_email_test_policy_v2 WHERE singleton FOR UPDATE;
 IF value AND EXISTS(SELECT 1 FROM public.crm_email_test_operation_v1 o JOIN public.shrigma_email_dispatch d ON d.dispatch_id=o.dispatch_id WHERE o.state='claimed' OR d.transport_state='in_flight') THEN RAISE EXCEPTION 'EMAIL_TEST_LEGACY_IN_FLIGHT';END IF;
 UPDATE public.crm_email_test_policy_v2 SET enabled=value WHERE singleton;
END $$;
CREATE OR REPLACE FUNCTION public.crm_email_test_legacy_claim_v2(actor text,p jsonb,plan jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM 1 FROM public.crm_email_test_policy_v2 WHERE singleton FOR SHARE;
 IF EXISTS(SELECT 1 FROM public.crm_email_test_policy_v2 WHERE singleton AND enabled) OR EXISTS(SELECT 1 FROM public.crm_email_test_operation_v2 o WHERE o.draft_id=p->>'draft_id' AND o.draft_version=(p->>'expected_version')::integer AND o.dispatch_id IS NOT NULL) THEN RETURN jsonb_build_object('should_send',false,'result',jsonb_build_object('_http',409,'_body',jsonb_build_object('erro','recipient_policy_required')));END IF;
 IF p?'preview_token' THEN RETURN public.crm_email_native_claim_v1(actor,p,plan);END IF;
 RETURN public.crm_email_test_claim_v1(actor,p,plan);
END $$;
REVOKE ALL ON FUNCTION public.crm_email_test_normalize_v2(text),public.crm_email_test_capabilities_v2(text),public.crm_email_test_testers_v2(text,text),public.crm_email_test_set_tester_v2(text,text,text,boolean),public.crm_email_test_recipient_v2(text,text),public.crm_email_test_snapshot_v2(text,text,integer,text),public.crm_email_test_operation_v2(text,uuid),public.crm_email_test_request_v2(jsonb,boolean),public.crm_email_test_prepare_v2(text,jsonb),public.crm_email_test_review_v2(text,jsonb),public.crm_email_test_plan_v2(jsonb,jsonb),public.crm_email_test_preview_finish_v2(text,text,jsonb),public.crm_email_test_claim_v2(text,jsonb,jsonb),public.crm_email_test_finish_v2(uuid,uuid,text),public.crm_email_test_enable_v2(boolean),public.crm_email_test_legacy_claim_v2(text,jsonb,jsonb) FROM PUBLIC;
COMMIT;
