-- Run after nps-native.sql inside a transaction that is always rolled back.
DO $tests$
DECLARE sid int;r record;r2 record;job uuid;j record;b jsonb;v jsonb;m text;cnt int;
BEGIN
 INSERT INTO subscribers(uuid,email,name,status,attribs) VALUES(gen_random_uuid(),'nps-native-fixture@example.invalid','Fixture','enabled','{"keep":"yes"}') RETURNING id INTO sid;
 FOREACH m IN ARRAY ARRAY['fish','aristo'] LOOP
  UPDATE subscribers SET attribs='{"keep":"yes"}' WHERE id=sid;
  b=jsonb_build_object('n',9,'p','fixture-'||m,'e','nps-native-fixture@example.invalid','m',m,'s',public.shrigma_nps_sign('fixture-'||m,'nps-native-fixture@example.invalid'));
  SELECT * INTO r FROM public.shrigma_nps_record_vote(b||'{"s":"bad"}');
  IF r.response->>'ok'<>'false' OR r.sync_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid signature accepted';END IF;
  SELECT * INTO r FROM public.shrigma_nps_record_vote(b||'{"n":"9oops"}');
  IF r.response->>'ok'<>'false' THEN RAISE EXCEPTION 'Malformed score accepted';END IF;
  SELECT * INTO r FROM public.shrigma_nps_record_vote(b);
  IF r.response->>'ok'<>'true' OR r.response->>'bucket'<>'promotor' OR r.sync_id IS NULL THEN RAISE EXCEPTION 'Vote not stored';END IF;
  job=r.sync_id;
  IF NOT EXISTS(SELECT 1 FROM subscribers WHERE id=sid AND attribs->>'keep'='yes' AND attribs->'nps'->>'score'='9') THEN RAISE EXCEPTION 'Vote/other attributes lost';END IF;
  SELECT count(*) INTO cnt FROM public.shrigma_nps_vote_sync WHERE subscriber_id=sid;
  SELECT * INTO r FROM public.shrigma_nps_record_vote(b);
  IF r.response->>'repetido'<>'true' OR r.sync_id IS NOT NULL OR cnt<>(SELECT count(*) FROM public.shrigma_nps_vote_sync WHERE subscriber_id=sid) THEN RAISE EXCEPTION 'Repeated vote duplicated';END IF;
  SELECT * INTO j FROM public.shrigma_nps_claim_vote_sync(job);
  IF j.sync_id<>job THEN RAISE EXCEPTION 'Sync claim failed';END IF;
  IF EXISTS(SELECT 1 FROM public.shrigma_nps_claim_vote_sync(job)) THEN RAISE EXCEPTION 'Sync claimed twice';END IF;
  UPDATE subscribers SET attribs=jsonb_set(attribs,'{nps,comment}','"concurrent comment"') WHERE id=sid;
  SELECT * INTO r2 FROM public.shrigma_nps_record_vote(b||'{"n":5}');
  IF r2.response->>'acao'<>'revoto' OR r2.response->>'bucket'<>'detrator' THEN RAISE EXCEPTION 'Revote failed';END IF;
  IF EXISTS(SELECT 1 FROM public.shrigma_nps_claim_vote_sync(r2.sync_id)) THEN RAISE EXCEPTION 'Concurrent remote job allowed';END IF;
  PERFORM public.shrigma_nps_finish_vote_sync(job,'{"ok":true,"task_id":"fixture-task"}');
  IF NOT EXISTS(SELECT 1 FROM subscribers WHERE id=sid AND attribs->'nps'->>'score'='5' AND attribs->'nps'->>'comment'='concurrent comment' AND attribs->'nps'->>'task_id'='fixture-task') THEN RAISE EXCEPTION 'Sync overwrote vote/comment';END IF;
  SELECT * INTO j FROM public.shrigma_nps_claim_vote_sync(r2.sync_id);
  IF j.payload->>'task_id'<>'fixture-task' THEN RAISE EXCEPTION 'Revote task ID not propagated';END IF;
  PERFORM public.shrigma_nps_finish_vote_sync(r2.sync_id,'{"ok":false}');
  IF NOT EXISTS(SELECT 1 FROM subscribers WHERE id=sid AND attribs->'nps'->>'score'='5') THEN RAISE EXCEPTION 'Remote failure lost vote';END IF;
  IF EXISTS(SELECT 1 FROM public.shrigma_nps_claim_vote_sync(r2.sync_id)) THEN RAISE EXCEPTION 'Unknown side effect retried';END IF;
  UPDATE subscribers SET attribs=jsonb_set(attribs,'{nps,date}',to_jsonb((now()-interval '8 days')::text)) WHERE id=sid;
  SELECT * INTO r FROM public.shrigma_nps_record_vote(b||'{"n":7}');
  IF r.response->>'locked'<>'true' OR r.sync_id IS NOT NULL THEN RAISE EXCEPTION 'Revote window ignored';END IF;
  UPDATE shrigma_nps_vote_sync SET state='synced' WHERE subscriber_id=sid;
 END LOOP;
END $tests$;
