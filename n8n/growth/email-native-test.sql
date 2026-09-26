-- CRM23: additive extended-template tests; existing CRM05 receipts/once and simple path stay unchanged.
BEGIN;
SET LOCAL lock_timeout='3s';
CREATE FUNCTION public.crm_email_native_data_v1(b text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
 SELECT CASE b WHEN 'fish' THEN '{"first_name":"Felipe","name":"Felipe","nome":"Felipe","brand":"Fishermans","brand_name":"Fishermans","store_url":"https://fishermans.com.br","shop_url":"https://fishermans.com.br","address":"Endereço fictício para revisão","cancel_reason":"Exemplo de cancelamento","carrier":"Transportadora de exemplo","checkout_url":"https://example.invalid/checkout","coupon_code":"EXEMPLO","coupon_heading":"Cupom de exemplo","coupon_text":"Benefício fictício","coupon_value":"R$ 10,00","cta_text":"Ver exemplo","delivered_at":"01/01/2026","delivered_by":"Recebedor fictício","delivery_estimate":"Data ilustrativa","e":"synthetic@example.invalid","has_discount":true,"headline":"Exemplo de mensagem","items_count":2,"last_update":"01/01/2026","nps_url":"https://example.invalid/nps","order_number":"EXEMPLO-001","order_url":"https://example.invalid/order","p":"synthetic-token-not-valid","paragraph_1":"Primeiro parágrafo de exemplo","paragraph_2":"Segundo parágrafo de exemplo","paragraph_3":"Terceiro parágrafo de exemplo","paragraph_4":"Quarto parágrafo de exemplo","payment_deadline":"01/01/2026","payment_method":"Pagamento fictício","preheader":"Resumo fictício para revisão","refund_method":"Forma de estorno fictícia","refund_status":"Estorno ilustrativo","review_url":"https://example.invalid/review","s":"synthetic-signature-not-valid","shipping_label":"Frete de exemplo","shipping_name":"Destinatário fictício","shipping_value":"R$ 10,00","status":"Estado ilustrativo","subtotal":"R$ 90,00","total":"R$ 100,00","tracking_company":"Transportadora de exemplo","tracking_number":"EXEMPLO-RASTREIO","tracking_status":"Status fictício","tracking_updated_at":"01/01/2026","tracking_url":"https://example.invalid/tracking","urgency_text":"Prazo ilustrativo","urgency_title":"Informação de exemplo","items":[{"image":"https://example.invalid/item-one.png","name":"Item de exemplo A","title":"Item de exemplo A","price":"R$ 30,00","qty":1,"quantity":1,"variant":"Variação ilustrativa"},{"image":"https://example.invalid/item-two.png","name":"Item de exemplo B","title":"Item de exemplo B","price":"R$ 60,00","qty":1,"quantity":1,"variant":"Variação ilustrativa"}]}'::jsonb WHEN 'aristo' THEN '{"first_name":"Felipe","name":"Felipe","nome":"Felipe","brand":"O Aristocrata","brand_name":"O Aristocrata","store_url":"https://oaristocrata.com","shop_url":"https://oaristocrata.com","address":"Endereço fictício para revisão","cancel_reason":"Exemplo de cancelamento","carrier":"Transportadora de exemplo","checkout_url":"https://example.invalid/checkout","coupon_code":"EXEMPLO","coupon_heading":"Cupom de exemplo","coupon_text":"Benefício fictício","coupon_value":"R$ 10,00","cta_text":"Ver exemplo","delivered_at":"01/01/2026","delivered_by":"Recebedor fictício","delivery_estimate":"Data ilustrativa","e":"synthetic@example.invalid","has_discount":true,"headline":"Exemplo de mensagem","items_count":2,"last_update":"01/01/2026","nps_url":"https://example.invalid/nps","order_number":"EXEMPLO-001","order_url":"https://example.invalid/order","p":"synthetic-token-not-valid","paragraph_1":"Primeiro parágrafo de exemplo","paragraph_2":"Segundo parágrafo de exemplo","paragraph_3":"Terceiro parágrafo de exemplo","paragraph_4":"Quarto parágrafo de exemplo","payment_deadline":"01/01/2026","payment_method":"Pagamento fictício","preheader":"Resumo fictício para revisão","refund_method":"Forma de estorno fictícia","refund_status":"Estorno ilustrativo","review_url":"https://example.invalid/review","s":"synthetic-signature-not-valid","shipping_label":"Frete de exemplo","shipping_name":"Destinatário fictício","shipping_value":"R$ 10,00","status":"Estado ilustrativo","subtotal":"R$ 90,00","total":"R$ 100,00","tracking_company":"Transportadora de exemplo","tracking_number":"EXEMPLO-RASTREIO","tracking_status":"Status fictício","tracking_updated_at":"01/01/2026","tracking_url":"https://example.invalid/tracking","urgency_text":"Prazo ilustrativo","urgency_title":"Informação de exemplo","items":[{"image":"https://example.invalid/item-one.png","name":"Item de exemplo A","title":"Item de exemplo A","price":"R$ 30,00","qty":1,"quantity":1,"variant":"Variação ilustrativa"},{"image":"https://example.invalid/item-two.png","name":"Item de exemplo B","title":"Item de exemplo B","price":"R$ 60,00","qty":1,"quantity":1,"variant":"Variação ilustrativa"}]}'::jsonb ELSE NULL END
$fn$;
CREATE FUNCTION public.crm_email_native_snapshot_v1(actor text,did text,v integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE base jsonb; recipient jsonb; result jsonb;
BEGIN
 base:=public.crm_email_test_snapshot_v1(actor,did,v);
 IF base->>'eligible' IS DISTINCT FROM 'true' THEN RETURN base;END IF;
 -- Exact native lookup, no create/fallback. Only a default-mode test will use it.
 SELECT jsonb_build_object('id',s.id,'email',s.email,'name',coalesce(s.name,''),'uuid',s.uuid::text) INTO recipient
 FROM public.subscribers s WHERE s.email='felipebandeira@oaristocrata.com';
 result:=jsonb_build_object('eligible',true,'snapshot',base,'recipient',recipient,'profile','crm_email_synthetic_v1');
 RETURN result||jsonb_build_object('preview_token',encode(sha256(convert_to(actor||':'||result::text,'UTF8')),'hex'));
END $fn$;
CREATE FUNCTION public.crm_email_native_claim_v1(actor text,p jsonb,plan jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $fn$
DECLARE o public.crm_email_test_operation_v1%ROWTYPE; snap jsonb; base jsonb; reason text; oid uuid; did uuid; token uuid; cfg text; tx jsonb; hash text; samples jsonb; sub jsonb;
BEGIN
 IF NOT public.crm_email_test_actor_v1(actor) THEN RETURN jsonb_build_object('should_send',false,'result',jsonb_build_object('_http',403,'_body',jsonb_build_object('erro','manager_required')));END IF;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (p-ARRAY['draft_id','expected_version','idempotency_key','confirm','preview_token'])<>'{}'::jsonb OR (SELECT count(*) FROM jsonb_object_keys(p))<>5
 OR jsonb_typeof(p->'expected_version') IS DISTINCT FROM 'number' OR coalesce(p->>'draft_id','')!~'^d_[A-Za-z0-9_-]{1,96}$' OR coalesce(p->>'expected_version','')!~'^[1-9][0-9]{0,8}$'
 OR coalesce(p->>'idempotency_key','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$'
 OR coalesce(p->>'preview_token','')!~'^[a-f0-9]{64}$' OR p->>'confirm' IS DISTINCT FROM 'enviar_teste' THEN RAISE EXCEPTION 'EMAIL_TEST_REQUEST_INVALID';END IF;
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
 snap:=public.crm_email_native_snapshot_v1(actor,p->>'draft_id',(p->>'expected_version')::integer);base:=snap->'snapshot';
 samples:=public.crm_email_native_data_v1(base->>'brand');
 sub:=CASE WHEN plan->>'subscriber_mode'='default' THEN jsonb_build_object('Name',snap#>>'{recipient,name}','UUID',snap#>>'{recipient,uuid}') ELSE jsonb_build_object('Name','','UUID','') END;
 IF snap->>'eligible' IS DISTINCT FROM 'true' THEN reason:=snap->>'code';
 ELSIF plan->>'eligible' IS DISTINCT FROM 'true' THEN reason:=CASE WHEN plan->>'code' IN ('email_envelope_required','published_content_mismatch','brand_unavailable','unsupported_template_expression','unsupported_test_variable','unsupported_subject_expression','unsupported_subject_variable','subject_invalid','native_preview_unconfirmed','native_preview_unsafe','recipient_identity_unavailable','preview_context_invalid') THEN plan->>'code' ELSE 'plan_unavailable' END;
 ELSIF p->>'preview_token' IS DISTINCT FROM snap->>'preview_token' OR plan->>'preview_token' IS DISTINCT FROM p->>'preview_token' THEN reason:='preview_changed';
 ELSIF plan->'snapshot' IS DISTINCT FROM snap OR plan->>'recipient' IS DISTINCT FROM 'felipebandeira@oaristocrata.com'
 OR plan->>'render_policy' IS DISTINCT FROM 'crm_email_native_preview_v1' OR plan->>'profile' IS DISTINCT FROM 'crm_email_synthetic_v1'
 OR plan->'native_verified' IS DISTINCT FROM 'true'::jsonb OR plan->'native_render_verified' IS DISTINCT FROM 'true'::jsonb
 OR plan->>'from_email' IS DISTINCT FROM base#>>'{rascunho,from_email}' OR plan->>'reply_to' IS DISTINCT FROM base#>>'{rascunho,reply_to}'
 OR jsonb_typeof(plan->'data') IS DISTINCT FROM 'object' OR samples IS NULL
 OR EXISTS(SELECT 1 FROM jsonb_each(plan->'data') x WHERE NOT (samples ? x.key) OR x.value IS DISTINCT FROM samples->x.key)
 OR plan->'context' IS DISTINCT FROM jsonb_build_object('Tx',jsonb_build_object('Data',plan->'data'),'Subscriber',sub)
 OR plan->>'subscriber_mode' NOT IN ('default','external') OR plan->>'subscriber_mode' IS NULL
 OR plan->'requires_subscriber' IS DISTINCT FROM to_jsonb(plan->>'subscriber_mode'='default')
 OR (plan->>'subscriber_mode'='default' AND (snap#>>'{recipient,email}' IS DISTINCT FROM 'felipebandeira@oaristocrata.com' OR coalesce(snap#>>'{recipient,uuid}','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' OR coalesce(length(snap#>>'{recipient,name}'),256)>255))
 OR plan->>'subject' IS DISTINCT FROM '✅ FINAL — '||regexp_replace(base#>>'{native,subject}','^(✅ FINAL — )+','')
 OR jsonb_typeof(plan->'body_html') IS DISTINCT FROM 'string' OR coalesce(length(plan->>'body_html'),0) NOT BETWEEN 1 AND 400000
 OR coalesce(plan->>'source_hash','')!~'^[a-f0-9]{64}$' THEN reason:='plan_changed';END IF;
 IF reason IS NOT NULL THEN
  INSERT INTO public.crm_email_test_operation_v1(id,actor,request_payload,request_sha256,draft_id,draft_version,state,code,finished_at)
  VALUES(oid,actor,p,encode(sha256(convert_to(p::text,'UTF8')),'hex'),p->>'draft_id',(p->>'expected_version')::integer,'rejected',reason,clock_timestamp());
  RETURN jsonb_build_object('should_send',false,'result',public.crm_email_test_operation_v1(actor,oid));
 END IF;
 PERFORM 1 FROM public.templates WHERE id=(base#>>'{native,id}')::integer FOR SHARE;
 IF public.crm_email_native_snapshot_v1(actor,p->>'draft_id',(p->>'expected_version')::integer) IS DISTINCT FROM snap THEN RAISE EXCEPTION 'EMAIL_TEST_SNAPSHOT_CHANGED';END IF;
 did:=gen_random_uuid();token:=gen_random_uuid();cfg:=CASE base->>'brand' WHEN 'fish' THEN 'cs-fishermans-tx' ELSE 'cs-aristocrata-tx' END;
 hash:=encode(sha256(convert_to(snap::text,'UTF8')),'hex');
 tx:=jsonb_build_object('subscriber_email','felipebandeira@oaristocrata.com','subscriber_mode',plan->>'subscriber_mode','template_id',(base#>>'{native,id}')::integer,'content_type','html','from_email',plan->>'from_email','subject',plan->>'subject','data',plan->'data','headers',jsonb_build_array(jsonb_build_object('Reply-To',plan->>'reply_to'),jsonb_build_object('X-SES-CONFIGURATION-SET',cfg),jsonb_build_object('X-SES-MESSAGE-TAGS','crm_dispatch_id='||did||', crm_test=true')));
 INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,account_id,region,configuration_set,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token)
 SELECT did,base->>'brand','crm-test','template',jsonb_build_array(p->>'draft_id',(p->>'expected_version')::integer)::text,hash,'379757086665','us-east-2',cfg,k.recipient_key,k.key_version,true,'in_flight',clock_timestamp(),token FROM public.shrigma_email_recipient_key('felipebandeira@oaristocrata.com') k;
 IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_TEST_RECIPIENT_KEY_UNAVAILABLE';END IF;
 INSERT INTO public.crm_email_test_operation_v1(id,actor,request_payload,request_sha256,draft_id,draft_version,state,code,dispatch_id,template_id,content_sha256)
 VALUES(oid,actor,p,encode(sha256(convert_to(p::text,'UTF8')),'hex'),p->>'draft_id',(p->>'expected_version')::integer,'claimed','transport_unconfirmed',did,(base#>>'{native,id}')::integer,hash);
 RETURN jsonb_build_object('should_send',true,'operation_id',oid,'dispatch_id',did,'claim_token',token,'payload',tx);
END $fn$;
REVOKE ALL ON FUNCTION public.crm_email_native_data_v1(text),public.crm_email_native_snapshot_v1(text,text,integer),public.crm_email_native_claim_v1(text,jsonb,jsonb) FROM PUBLIC;
COMMIT;
