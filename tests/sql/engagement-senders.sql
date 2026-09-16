-- Database regression: existing popup senders, all NPS paths and safety guards.
-- Invoke as a single SQL statement through the protected SQL utility. No HTTP.
-- Every fixture, reservation, log and subscriber marker is rolled back.
DO $test$ DECLARE b jsonb;r record;r2 record;z record;brand text;piece text;tpl int;sender text;sid int;n integer:=0;BEGIN BEGIN
INSERT INTO subscribers(uuid,email,name,status,attribs) VALUES(gen_random_uuid(),'ses-engagement-fixture@example.invalid','Fixture','enabled','{}') RETURNING id INTO sid;
FOREACH brand IN ARRAY ARRAY['fish','aristo'] LOOP
 FOREACH piece IN ARRAY ARRAY['nps-d0','nps-d3','cupom-boas-vindas'] LOOP
  UPDATE subscribers SET attribs=CASE WHEN piece='nps-d3' THEN jsonb_build_object('nps_sent',jsonb_build_object('order','ses-engagement-fixture-'||brand||piece,'brand',brand,'date',now()-interval '4 days','reminded',false)) ELSE '{}' END WHERE id=sid;
  tpl=CASE brand WHEN 'fish' THEN CASE piece WHEN 'nps-d0' THEN 29 WHEN 'nps-d3' THEN 31 ELSE 23 END ELSE CASE piece WHEN 'nps-d0' THEN 28 WHEN 'nps-d3' THEN 30 ELSE 22 END END;
  sender=(CASE brand WHEN 'fish' THEN 'Fishermans <' ELSE 'O Aristocrata <' END)||(CASE WHEN piece='cupom-boas-vindas' THEN 'pedidos@' ELSE 'contato@' END)||(CASE brand WHEN 'fish' THEN 'fishermans.com.br>' ELSE 'oaristocrata.com>' END);
  b=jsonb_build_object('brand',brand,'piece',piece,'email','Ses-Engagement-Fixture@EXAMPLE.INVALID','ref','ses-engagement-fixture-'||brand||piece,'tx',jsonb_build_object('subscriber_email','ses-engagement-fixture@example.invalid','template_id',tpl,'from_email',sender,'content_type','html','data',jsonb_build_object('order_number','ses-engagement-fixture-'||brand||piece,'e','ses-engagement-fixture@example.invalid','s','fixture-signature')));
  IF piece='nps-d3' THEN
   SELECT * INTO r FROM public.shrigma_email_claim_engagement(b);
   IF r.should_send OR r.reason<>'initial_not_confirmed' THEN RAISE EXCEPTION 'unconfirmed initial reminder allowed';END IF;
   INSERT INTO shrigma_send_log(email,brand,kind,flow,channel,piece,template_id,ref)
   VALUES('ses-engagement-fixture@example.invalid',brand,'tx','nps','email','nps-d0',CASE brand WHEN 'fish' THEN 29 ELSE 28 END,b->>'ref');
  END IF;
  SELECT * INTO r FROM public.shrigma_email_claim_engagement(b);
  IF r.should_send IS DISTINCT FROM true OR r.payload->>'subscriber_email'<>'ses-engagement-fixture@example.invalid' OR NOT (r.payload->'headers' @> jsonb_build_array(jsonb_build_object('X-SES-CONFIGURATION-SET',CASE brand WHEN 'fish' THEN 'cs-fishermans-tx' ELSE 'cs-aristocrata-tx' END))) THEN RAISE EXCEPTION 'claim/header failed % %: %',brand,piece,r.reason;END IF;n=n+1;
  SELECT * INTO r2 FROM public.shrigma_email_claim_engagement(b);
  IF r.payload#>>'{headers,0,Reply-To}' IS DISTINCT FROM (CASE WHEN brand='fish' AND piece='cupom-boas-vindas' THEN 'pedidos@fishermans.com.br' WHEN brand='fish' THEN 'contato@fishermans.com.br' ELSE 'contato@oaristocrata.com' END) THEN RAISE EXCEPTION 'reply-to mismatch';END IF;
  IF r2.should_send IS DISTINCT FROM false THEN RAISE EXCEPTION 'duplicate attempt not blocked';END IF;n=n+1;
  -- A concurrent vote must survive finalization of the email.
  UPDATE subscribers SET attribs=attribs||jsonb_build_object('nps',jsonb_build_object('order','newer-order','score',9)) WHERE id=sid;
  SELECT * INTO z FROM public.shrigma_email_finish_engagement(r.dispatch_id,r.claim_token,'accepted',r.context);
  IF z.transport_state<>'accepted' OR z.send_log_id IS NULL OR NOT EXISTS(SELECT 1 FROM subscribers WHERE id=sid AND attribs->'nps'->>'order'='newer-order') THEN RAISE EXCEPTION 'finish/log/concurrent vote failure';END IF;n=n+1;
  IF piece='nps-d3' AND NOT EXISTS(SELECT 1 FROM subscribers WHERE id=sid AND attribs->'nps_sent'->>'reminded'='true') THEN RAISE EXCEPTION 'reminder marker missing';END IF;
  SELECT * INTO r2 FROM public.shrigma_email_finish_engagement(r.dispatch_id,r.claim_token,'accepted',r.context);
  IF r2.send_log_id<>z.send_log_id THEN RAISE EXCEPTION 'finish replay duplicated log';END IF;n=n+1;
  BEGIN PERFORM * FROM public.shrigma_email_finish_engagement(r.dispatch_id,gen_random_uuid(),'accepted',r.context);RAISE EXCEPTION 'bad claim accepted';EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'ENGAGEMENT_FINISH_MISMATCH' THEN RAISE;END IF;END;n=n+1;
 END LOOP;
END LOOP;
-- Different D0 order in cooldown, D3 already voted, disabled subscriber and rejected outcome.
b=jsonb_set(b,'{tx,from_email}','"O Aristocrata <contato@oaristocrata.com>"');b=jsonb_set(b,'{piece}','"nps-d0"');b=jsonb_set(b,'{tx,template_id}','28');b=jsonb_set(b,'{ref}','"new-order"');b=jsonb_set(b,'{tx,data,order_number}','"new-order"');
UPDATE subscribers SET attribs=jsonb_build_object('nps_sent',jsonb_build_object('order','old-order','date',now(),'brand','aristo','reminded',false)) WHERE id=sid;
SELECT * INTO r FROM public.shrigma_email_claim_engagement(b);IF r.reason<>'nps_cooldown' THEN RAISE EXCEPTION 'cooldown ignored';END IF;
b=jsonb_set(b,'{piece}','"nps-d3"');b=jsonb_set(b,'{tx,template_id}','30');
UPDATE subscribers SET attribs=jsonb_build_object('nps_sent',jsonb_build_object('order','new-order','date',now()-interval '4 days','brand','aristo','reminded',false),'nps',jsonb_build_object('order','new-order')) WHERE id=sid;
SELECT * INTO r FROM public.shrigma_email_claim_engagement(b);IF r.should_send OR r.reason NOT IN ('reminder_ineligible','initial_not_confirmed') THEN RAISE EXCEPTION 'voted reminder accepted';END IF;
UPDATE subscribers SET status='blocklisted' WHERE id=sid;
SELECT * INTO r FROM public.shrigma_email_claim_engagement(b);IF r.reason<>'subscriber_unavailable' THEN RAISE EXCEPTION 'blocklist ignored';END IF;
UPDATE subscribers SET status='enabled',attribs='{}' WHERE id=sid;
b=jsonb_set(b,'{tx,from_email}','"O Aristocrata <pedidos@oaristocrata.com>"');b=jsonb_set(b,'{piece}','"cupom-boas-vindas"');b=jsonb_set(b,'{tx,template_id}','22');
SELECT * INTO r FROM public.shrigma_email_claim_engagement(b);SELECT * INTO z FROM public.shrigma_email_finish_engagement(r.dispatch_id,r.claim_token,'outcome_unknown',r.context);
IF z.send_log_id IS NOT NULL OR z.transport_state<>'outcome_unknown' THEN RAISE EXCEPTION 'unknown transport logged as accepted';END IF;
IF n<>30 THEN RAISE EXCEPTION 'wrong test count';END IF;
RAISE EXCEPTION USING ERRCODE='Z9912',MESSAGE='successful rollback';
EXCEPTION WHEN SQLSTATE 'Z9912' THEN NULL;END;END $test$;
SELECT NOT EXISTS(SELECT 1 FROM subscribers WHERE email='ses-engagement-fixture@example.invalid') fixture_absent,34 AS cases;
