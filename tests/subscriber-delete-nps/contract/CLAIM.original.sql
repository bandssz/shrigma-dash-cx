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
