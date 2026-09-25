DO $tests$
DECLARE cat jsonb;c jsonb;op jsonb;sch jsonb;d jsonb;p jsonb;r jsonb;v text;tv text;bad boolean;
BEGIN
 cat:=public.shrigma_campaign_catalog('fish');
 ASSERT (SELECT count(*) FROM jsonb_array_elements(cat->'lists') x WHERE (x->>'available')::boolean)=2,'only verified active Fish audiences';
 ASSERT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(cat->'lists') x WHERE (x->>'id')::integer IN (7,9,10,12)),'no ambiguous/cross/other brand lists';
 ASSERT jsonb_array_length(cat->'templates')=1,'transactional template excluded';
 ASSERT public.shrigma_campaign_catalog('olivas') IS NULL,'Olivas not exposed';
 c:=public.shrigma_campaign_current(100);v:=c->>'version';d:=c->'definition';
 ASSERT d->>'reply_to'='old@fishermans.com.br','reply-to projection';
 ASSERT d->'list_ids'='[3]'::jsonb,'verified list projection';
 tv:=cat#>>'{templates,0,version}';
 op:=public.shrigma_campaign_store('claim',jsonb_build_object('actor','test','key','provider-test-save-00001','hash',repeat('a',64),'brand','fish','action','salvar'));
 d:=d||'{"name":"Updated","subject":"New subject","html":"<p>Prepared</p>","text":"Prepared","reply_to":"contato@fishermans.com.br","tags":["new"]}'::jsonb;
 p:=jsonb_build_object('id',100,'operationId',op->>'id','expectedVersion',v,'definition',d,'templateVersion',tv,'contentValidated',true);
 bad:=false;BEGIN PERFORM public.shrigma_campaign_provider('update',p||'{"expectedVersion":"old"}');EXCEPTION WHEN raise_exception THEN bad:=SQLERRM='VERSION_CONFLICT';END;
 ASSERT bad,'stale version rejected';
 bad:=false;BEGIN PERFORM public.shrigma_campaign_provider('update',p||jsonb_build_object('definition',d||'{"list_ids":[7]}'));EXCEPTION WHEN raise_exception THEN bad:=SQLERRM='LIST_SCOPE';END;
 ASSERT bad,'cross-brand update rejected';
 bad:=false;BEGIN PERFORM public.shrigma_campaign_provider('update',p||'{"contentValidated":false}');EXCEPTION WHEN raise_exception THEN bad:=SQLERRM='CONTENT_UNVALIDATED';END;
 ASSERT bad,'uncompiled body cannot be saved';
 r:=public.shrigma_campaign_provider('update',p);
 ASSERT r->>'version'<>v AND r#>>'{definition,name}'='Updated','atomic content update';
 ASSERT (SELECT attribs->>'other'='keep' AND attribs#>>'{crm,created_operation_id}'='keep' FROM campaigns WHERE id=100),'unrelated metadata kept';
 ASSERT (SELECT headers @> '[{"X-SES-CONFIGURATION-SET":"cs-fishermans-mkt"},{"X-Other":"keep"}]'::jsonb FROM campaigns WHERE id=100),'unrelated headers retained';
 ASSERT (SELECT count(*) FROM campaign_media WHERE campaign_id=100)=1,'attachments unchanged';
 ASSERT (SELECT familia FROM crm_familia_campanha WHERE marca='fish' AND utm_campaign='week')='week','initiative mapped atomically';
 ASSERT (SELECT provider_id FROM shrigma_campaign_operation WHERE id=(op->>'id')::uuid)=100,'operation bound to native id';
 sch:=public.shrigma_campaign_store('claim',jsonb_build_object('actor','test','key','provider-test-schedule-01','hash',repeat('b',64),'brand','fish','action','agendar'));
 p:=jsonb_build_object('id',100,'operationId',sch->>'id','expectedVersion',r->>'version');
 bad:=false;BEGIN PERFORM public.shrigma_campaign_provider('schedule',p);EXCEPTION WHEN raise_exception THEN bad:=SQLERRM='VALIDATION_STALE';END;
 ASSERT bad,'cannot schedule without current validation';
 PERFORM public.shrigma_campaign_store('validation_set',jsonb_build_object('providerId',100,'validation',jsonb_build_object('policy','crm-campaign-v1','version',r->>'version','ok',true,'validated_at',now())));
 UPDATE campaigns SET subject='External edit' WHERE id=100;
 bad:=false;BEGIN PERFORM public.shrigma_campaign_provider('schedule',p);EXCEPTION WHEN raise_exception THEN bad:=SQLERRM='VERSION_CONFLICT';END;
 ASSERT bad,'external edit invalidates scheduling even if timestamp did not change';
 r:=public.shrigma_campaign_current(100);p:=p||jsonb_build_object('expectedVersion',r->>'version');
 PERFORM public.shrigma_campaign_store('validation_set',jsonb_build_object('providerId',100,'validation',jsonb_build_object('policy','crm-campaign-v1','version',r->>'version','ok',true,'validated_at',now())));
 p:=p||jsonb_build_object('audienceReviewId',public.fixture_audience_review(100)#>>'{audience,review_id}');
 r:=public.shrigma_campaign_provider('schedule',p);
 ASSERT r->>'status'='scheduled','only reviewed revision scheduled';
 ASSERT r->>'sent'='0' AND r->>'started_at' IS NULL,'no immediate send';
END $tests$;
DO $aristo$
DECLARE c jsonb;op jsonb;p jsonb;r jsonb;bad boolean;
BEGIN
 c:=public.shrigma_campaign_current(200);
 op:=public.shrigma_campaign_store('claim',jsonb_build_object('actor','test','key','provider-aristo-save-001','hash',repeat('c',64),'brand','aristo','action','salvar'));
 p:=jsonb_build_object('id',200,'operationId',op->>'id','expectedVersion',c->>'version','definition',(c->'definition')||'{"name":"Aristo edited"}',
 'templateVersion',public.shrigma_campaign_catalog('aristo')#>>'{templates,0,version}','contentValidated',true);
 r:=public.shrigma_campaign_provider('update',p);
 ASSERT r#>>'{definition,brand}'='aristo' AND r#>>'{definition,name}'='Aristo edited','Aristo can edit own managed draft';
 ASSERT (SELECT familia FROM crm_familia_campanha WHERE marca='aristo' AND utm_campaign='week')='week','same UTM maps independently per brand';
 p:=p||jsonb_build_object('expectedVersion',r->>'version');
 UPDATE crm_familia_campanha SET familia='other' WHERE marca='aristo' AND utm_campaign='week';
 bad:=false;BEGIN PERFORM public.shrigma_campaign_provider('update',p);EXCEPTION WHEN raise_exception THEN bad:=SQLERRM='INITIATIVE_CONFLICT';END;
 ASSERT bad,'an existing initiative cannot be silently remapped';
END $aristo$;
