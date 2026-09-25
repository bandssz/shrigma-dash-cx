-- CRM05 only. No subscriber/list/template edits and no transport in SQL.
BEGIN;
SET LOCAL lock_timeout='3s';
CREATE TABLE public.crm_email_test_operation_v1(
 id uuid PRIMARY KEY,actor text NOT NULL CHECK(actor LIKE 'panel:%'),request_payload jsonb NOT NULL,
 request_sha256 text NOT NULL CHECK(request_sha256~'^[a-f0-9]{64}$'),
 draft_id text NOT NULL,draft_version integer NOT NULL CHECK(draft_version>0),
 state text NOT NULL CHECK(state IN ('rejected','claimed','accepted','outcome_unknown')),
 code text NOT NULL,dispatch_id uuid UNIQUE REFERENCES public.shrigma_email_dispatch(dispatch_id),
 template_id integer,content_sha256 text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 CHECK((state='rejected')=(dispatch_id IS NULL))
);
CREATE UNIQUE INDEX crm_email_test_once_v1 ON public.crm_email_test_operation_v1(draft_id,draft_version) WHERE dispatch_id IS NOT NULL;
REVOKE ALL ON public.crm_email_test_operation_v1 FROM PUBLIC;

CREATE FUNCTION public.crm_email_test_actor_v1(actor text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.crm_dash_chave c JOIN public.shrigma_panel_permission_v1 p ON p.principal_id=c.chave
 WHERE 'panel:'||c.chave=actor AND c.painel IN ('growth','todos') AND p.area='growth'
 AND c.ativo AND c.revogada_em IS NULL AND (c.expira_em IS NULL OR c.expira_em>now()) AND c.chave_hash IS NOT NULL
 AND p.caps @> '["draft","validate","submit"]'::jsonb)
$$;
CREATE FUNCTION public.crm_email_test_optout_v1(b text) RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN b NOT IN ('fish','aristo') OR b IS NULL THEN 'brand_unavailable'
 WHEN (SELECT count(*) FROM public.subscribers s WHERE lower(s.email)='felipebandeira@oaristocrata.com')<>1 THEN 'recipient_unavailable'
 WHEN EXISTS(SELECT 1 FROM public.subscribers s WHERE lower(s.email)='felipebandeira@oaristocrata.com' AND s.status::text<>'enabled') THEN 'recipient_disabled'
 WHEN EXISTS(SELECT 1 FROM public.subscriber_lists sl JOIN public.subscribers s ON s.id=sl.subscriber_id JOIN public.lists l ON l.id=sl.list_id
 WHERE lower(s.email)='felipebandeira@oaristocrata.com' AND ((b='fish' AND (l.id=17 OR coalesce(l.tags,'{}') && ARRAY['fish','fishermans']::varchar[])) OR (b='aristo' AND (l.id=16 OR coalesce(l.tags,'{}') && ARRAY['aristo','aristocrata']::varchar[]))) AND sl.status::text='unsubscribed') THEN 'recipient_opted_out'
 ELSE NULL END
$$;
CREATE FUNCTION public.crm_email_test_snapshot_v1(actor text,did text,v integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE d public.shrigma_template_draft%ROWTYPE;s public.shrigma_template_submissao%ROWTYPE;t public.templates%ROWTYPE;reason text;
BEGIN
 IF NOT public.crm_email_test_actor_v1(actor) THEN RETURN jsonb_build_object('eligible',false,'code','manager_required');END IF;
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
 reason:=public.crm_email_test_optout_v1(d.brand);IF reason IS NOT NULL THEN RETURN jsonb_build_object('eligible',false,'code',reason);END IF;
 IF EXISTS(SELECT 1 FROM public.crm_email_test_operation_v1 o WHERE o.draft_id=did AND o.draft_version=v AND o.dispatch_id IS NOT NULL) THEN RETURN jsonb_build_object('eligible',false,'code','version_already_attempted');END IF;
 RETURN jsonb_build_object('eligible',true,'draft_id',did,'version',v,'brand',d.brand,'rascunho',d.rascunho,'components',d.components,
 'native',jsonb_build_object('id',t.id,'type',t.type,'subject',t.subject,'body',t.body),'submission_id',s.submission_id);
END $$;
CREATE FUNCTION public.crm_email_test_operation_v1(actor text,oid uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE o public.crm_email_test_operation_v1%ROWTYPE;events jsonb;
BEGIN
 IF NOT public.crm_email_test_actor_v1(actor) THEN RETURN jsonb_build_object('_http',403,'_body',jsonb_build_object('erro','manager_required'));END IF;
 SELECT * INTO o FROM public.crm_email_test_operation_v1 WHERE id=oid;
 IF FOUND AND o.actor<>actor THEN RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('erro','operation_identity_mismatch'));END IF;
 IF o.id IS NULL THEN RETURN jsonb_build_object('_http',200,'_body',jsonb_build_object('contract','crm_email_test_v1','operation',jsonb_build_object('idempotency_key',oid,'actor',actor,'state','missing','request_payload',NULL,'request_sha256',NULL,'http_accepted',false,'ses',jsonb_build_object())));END IF;
 SELECT coalesce(jsonb_object_agg(e.status,e.at),'{}') INTO events FROM (SELECT s.status,max(s.ocorreu_em) at FROM public.shrigma_email_status s
 WHERE s.dispatch_id=o.dispatch_id AND s.is_test=true AND s.reconciliation_status='matched' GROUP BY s.status)e;
 RETURN jsonb_build_object('_http',200,'_body',jsonb_build_object('contract','crm_email_test_v1','operation',jsonb_build_object(
 'idempotency_key',o.id,'actor',o.actor,'state',o.state,'code',o.code,'request_payload',o.request_payload,'request_sha256',o.request_sha256,'request_hash_schema','postgres-jsonb-text-sha256-v1',
 'draft_id',o.draft_id,'version',o.draft_version,'template_id',o.template_id,'content_sha256',o.content_sha256,'dispatch_id',o.dispatch_id,
 'http_accepted',o.state='accepted','ses',events,'created_at',o.created_at,'finished_at',o.finished_at)));
END $$;
CREATE FUNCTION public.crm_email_test_claim_v1(actor text,p jsonb,plan jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE o public.crm_email_test_operation_v1%ROWTYPE;snap jsonb;reason text;oid uuid;did uuid;token uuid;cfg text;tx jsonb;hash text;
BEGIN
 IF NOT public.crm_email_test_actor_v1(actor) THEN RETURN jsonb_build_object('should_send',false,'result',jsonb_build_object('_http',403,'_body',jsonb_build_object('erro','manager_required')));END IF;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (p-ARRAY['draft_id','expected_version','idempotency_key','confirm'])<>'{}'::jsonb OR (SELECT count(*) FROM jsonb_object_keys(p))<>4
 OR jsonb_typeof(p->'expected_version') IS DISTINCT FROM 'number' OR coalesce(p->>'draft_id','')!~'^d_[A-Za-z0-9_-]{1,96}$' OR coalesce(p->>'expected_version','')!~'^[1-9][0-9]{0,8}$'
 OR coalesce(p->>'idempotency_key','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$' OR p->>'confirm' IS DISTINCT FROM 'enviar_teste' THEN RAISE EXCEPTION 'EMAIL_TEST_REQUEST_INVALID';END IF;
 oid:=(p->>'idempotency_key')::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended('crm-email-test-operation:'||oid,0));
 SELECT * INTO o FROM public.crm_email_test_operation_v1 WHERE id=oid;
 IF FOUND THEN
  IF o.actor<>actor OR o.request_payload IS DISTINCT FROM p THEN RETURN jsonb_build_object('should_send',false,'result',jsonb_build_object('_http',409,'_body',jsonb_build_object('erro','operation_identity_mismatch')));END IF;
  RETURN jsonb_build_object('should_send',false,'result',public.crm_email_test_operation_v1(actor,oid));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('crm-email-test-version:'||(p->>'draft_id')||':'||(p->>'expected_version'),0));
 PERFORM 1 FROM public.shrigma_template_draft WHERE draft_id=p->>'draft_id' FOR SHARE;
 PERFORM 1 FROM public.subscribers WHERE lower(email)='felipebandeira@oaristocrata.com' FOR SHARE;
 PERFORM 1 FROM public.subscriber_lists sl JOIN public.subscribers s ON s.id=sl.subscriber_id WHERE lower(s.email)='felipebandeira@oaristocrata.com' FOR SHARE OF sl;
 snap:=public.crm_email_test_snapshot_v1(actor,p->>'draft_id',(p->>'expected_version')::integer);
 IF snap->>'eligible' IS DISTINCT FROM 'true' THEN reason:=snap->>'code';
 ELSIF plan->>'eligible' IS DISTINCT FROM 'true' THEN reason:=CASE WHEN plan->>'code' IN ('email_envelope_required','published_content_mismatch','brand_unavailable','unsupported_template_expression','unsupported_test_variable','subject_invalid','unsupported_variable_context') THEN plan->>'code' ELSE 'plan_unavailable' END;
 ELSIF plan->'snapshot' IS DISTINCT FROM snap OR plan->>'recipient' IS DISTINCT FROM 'felipebandeira@oaristocrata.com'
 OR plan->>'from_email' IS DISTINCT FROM snap#>>'{rascunho,from_email}' OR plan->>'reply_to' IS DISTINCT FROM snap#>>'{rascunho,reply_to}'
 OR jsonb_typeof(plan->'data') IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_each_text(plan->'data') x WHERE x.key NOT IN ('first_name','name','nome','brand','brand_name','store_url','shop_url') OR x.value IS DISTINCT FROM CASE WHEN x.key IN ('first_name','name','nome') THEN 'Felipe' WHEN x.key IN ('brand','brand_name') THEN CASE snap->>'brand' WHEN 'fish' THEN 'Fishermans' ELSE 'O Aristocrata' END ELSE CASE snap->>'brand' WHEN 'fish' THEN 'https://fishermans.com.br' ELSE 'https://oaristocrata.com' END END)
 OR plan->>'subject' IS DISTINCT FROM '✅ FINAL — '||regexp_replace(snap#>>'{native,subject}','^(✅ FINAL — )+','') THEN reason:='plan_changed';END IF;
 IF reason IS NOT NULL THEN
  INSERT INTO public.crm_email_test_operation_v1(id,actor,request_payload,request_sha256,draft_id,draft_version,state,code,finished_at)
  VALUES(oid,actor,p,encode(sha256(convert_to(p::text,'UTF8')),'hex'),p->>'draft_id',(p->>'expected_version')::integer,'rejected',reason,clock_timestamp());
  RETURN jsonb_build_object('should_send',false,'result',public.crm_email_test_operation_v1(actor,oid));
 END IF;
 PERFORM 1 FROM public.templates WHERE id=(snap#>>'{native,id}')::integer FOR SHARE;
 IF public.crm_email_test_snapshot_v1(actor,p->>'draft_id',(p->>'expected_version')::integer) IS DISTINCT FROM snap THEN RAISE EXCEPTION 'EMAIL_TEST_SNAPSHOT_CHANGED';END IF;
 did:=gen_random_uuid();token:=gen_random_uuid();cfg:=CASE snap->>'brand' WHEN 'fish' THEN 'cs-fishermans-tx' ELSE 'cs-aristocrata-tx' END;
 hash:=encode(sha256(convert_to(snap::text,'UTF8')),'hex');
 tx:=jsonb_build_object('subscriber_email','felipebandeira@oaristocrata.com','subscriber_mode','external','template_id',(snap#>>'{native,id}')::integer,'content_type','html','from_email',plan->>'from_email','subject',plan->>'subject','data',plan->'data','headers',jsonb_build_array(jsonb_build_object('Reply-To',plan->>'reply_to'),jsonb_build_object('X-SES-CONFIGURATION-SET',cfg),jsonb_build_object('X-SES-MESSAGE-TAGS','crm_dispatch_id='||did||', crm_test=true')));
 INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,account_id,region,configuration_set,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token)
 SELECT did,snap->>'brand','crm-test','template',jsonb_build_array(p->>'draft_id',(p->>'expected_version')::integer)::text,hash,'379757086665','us-east-2',cfg,k.recipient_key,k.key_version,true,'in_flight',clock_timestamp(),token FROM public.shrigma_email_recipient_key('felipebandeira@oaristocrata.com') k;
 IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_TEST_RECIPIENT_KEY_UNAVAILABLE';END IF;
 INSERT INTO public.crm_email_test_operation_v1(id,actor,request_payload,request_sha256,draft_id,draft_version,state,code,dispatch_id,template_id,content_sha256)
 VALUES(oid,actor,p,encode(sha256(convert_to(p::text,'UTF8')),'hex'),p->>'draft_id',(p->>'expected_version')::integer,'claimed','transport_unconfirmed',did,(snap#>>'{native,id}')::integer,hash);
 RETURN jsonb_build_object('should_send',true,'operation_id',oid,'dispatch_id',did,'claim_token',token,'payload',tx);
END $$;
CREATE FUNCTION public.crm_email_test_finish_v1(oid uuid,token uuid,outcome text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE o public.crm_email_test_operation_v1%ROWTYPE;d public.shrigma_email_dispatch%ROWTYPE;
BEGIN
 IF outcome NOT IN ('accepted','outcome_unknown') OR outcome IS NULL THEN RAISE EXCEPTION 'EMAIL_TEST_OUTCOME_INVALID';END IF;
 SELECT * INTO STRICT o FROM public.crm_email_test_operation_v1 WHERE id=oid FOR UPDATE;
 SELECT * INTO STRICT d FROM public.shrigma_email_dispatch WHERE dispatch_id=o.dispatch_id FOR UPDATE;
 IF token IS NULL OR d.claim_token IS DISTINCT FROM token OR NOT d.is_test OR d.flow<>'crm-test' OR d.piece<>'template' THEN RAISE EXCEPTION 'EMAIL_TEST_CLAIM_MISMATCH';END IF;
 IF o.state NOT IN ('claimed',outcome) THEN RAISE EXCEPTION 'EMAIL_TEST_OUTCOME_CONFLICT';END IF;
 UPDATE public.shrigma_email_dispatch SET transport_state=outcome,outcome_at=clock_timestamp(),accepted_at=CASE WHEN outcome='accepted' THEN coalesce(accepted_at,clock_timestamp()) END,error_code=CASE WHEN outcome='outcome_unknown' THEN 'LISTMONK_UNCONFIRMED' END WHERE dispatch_id=o.dispatch_id;
 UPDATE public.crm_email_test_operation_v1 SET state=outcome,code=CASE WHEN outcome='accepted' THEN 'http_accepted' ELSE 'transport_unconfirmed' END,finished_at=clock_timestamp() WHERE id=oid;
 RETURN public.crm_email_test_operation_v1(o.actor,oid);
END $$;
REVOKE ALL ON FUNCTION public.crm_email_test_actor_v1(text),public.crm_email_test_optout_v1(text),public.crm_email_test_snapshot_v1(text,text,integer),public.crm_email_test_operation_v1(text,uuid),public.crm_email_test_claim_v1(text,jsonb,jsonb),public.crm_email_test_finish_v1(uuid,uuid,text) FROM PUBLIC;
COMMIT;
