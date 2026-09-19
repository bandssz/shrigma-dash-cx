DO $tests$
DECLARE bad boolean; q text; before_version text; op jsonb; c jsonb; d jsonb;
BEGIN
 -- 100 is scheduled, 200 is a draft from the provider scenarios.
 FOREACH q IN ARRAY ARRAY[
  'UPDATE campaigns SET subject=''stale editor'' WHERE id=200',
  'UPDATE campaigns SET attribs=''{}'' WHERE id=200',
  'UPDATE campaigns SET status=''scheduled'' WHERE id=200',
  'UPDATE campaigns SET status=''running'' WHERE id=200',
  'DELETE FROM campaigns WHERE id=200',
  'DELETE FROM campaign_lists WHERE campaign_id=200',
  'UPDATE campaign_lists SET campaign_id=100 WHERE campaign_id=200',
  'INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(200,16,''Other'')',
  'DELETE FROM campaign_media WHERE campaign_id=100',
  'UPDATE campaigns SET status=''running'' WHERE id=100',
  'UPDATE campaigns SET body=''after review'' WHERE id=100'
 ] LOOP
  bad:=false;BEGIN EXECUTE q;EXCEPTION WHEN raise_exception THEN bad:=SQLERRM IN ('CAMPAIGN_EDITOR_REQUIRED','CAMPAIGN_REVIEW_REQUIRED');END;
  ASSERT bad,'external write must be rejected: '||q;
 END LOOP;
 -- Native no-op timestamp updates must not confer authority for relation edits.
 UPDATE campaigns SET updated_at=clock_timestamp() WHERE id=200;
 bad:=false;BEGIN INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(200,16,'Other');
 EXCEPTION WHEN raise_exception THEN bad:=SQLERRM='CAMPAIGN_EDITOR_REQUIRED';END;
 ASSERT bad,'touching a draft cannot impersonate creation';
 FOREACH q IN ARRAY ARRAY[
  'UPDATE templates SET body=''changed wrapper'' WHERE id=1',
  'DELETE FROM templates WHERE id=1',
  'UPDATE lists SET tags=ARRAY[''aristo''] WHERE id=3',
  'DELETE FROM lists WHERE id=3',
  'UPDATE media SET filename=''replaced.pdf'' WHERE id=1'
 ] LOOP
  bad:=false;BEGIN EXECUTE q;EXCEPTION WHEN raise_exception THEN bad:=SQLERRM='CAMPAIGN_DEPENDENCY_IN_USE';END;
  ASSERT bad,'scheduled dependencies must remain reviewed: '||q;
 END LOOP;
 UPDATE campaigns SET status='paused' WHERE id=100;
 UPDATE campaigns SET status='scheduled' WHERE id=100;
 UPDATE campaigns SET status='cancelled' WHERE id=100;
 bad:=false;BEGIN UPDATE campaigns SET status='running' WHERE id=100;
 EXCEPTION WHEN raise_exception THEN bad:=SQLERRM='CAMPAIGN_REVIEW_REQUIRED';END;
 ASSERT bad,'cancelled campaigns cannot restart accidentally';
 -- Shared edits are allowed after stopping. For drafts they invalidate revisions.
 before_version:=public.shrigma_campaign_current(200)->>'version';
 UPDATE templates SET body=body||' changed' WHERE id=1;
 ASSERT public.shrigma_campaign_current(200)->>'version'<>before_version,'wrapper edits invalidate draft review';
 -- Authorized provider writes still work and restore their transaction context.
 UPDATE crm_familia_campanha SET familia='week' WHERE marca='aristo' AND utm_campaign='week';
 c:=public.shrigma_campaign_current(200);d:=c->'definition';
 op:=public.shrigma_campaign_store('claim',jsonb_build_object('actor','guard','key','guard-update-0000001','hash',repeat('d',64),'brand','aristo','action','salvar'));
 PERFORM public.shrigma_campaign_provider('update',jsonb_build_object('id',200,'expectedVersion',c->>'version','operationId',op->>'id',
 'definition',d||'{"subject":"Owned write"}','templateVersion',public.shrigma_campaign_catalog('aristo')#>>'{templates,0,version}','contentValidated',true));
 ASSERT coalesce(current_setting('shrigma.campaign_writer',true),'')='','provider authority does not leak';
 bad:=false;BEGIN UPDATE campaigns SET subject='same transaction external write' WHERE id=200;
 EXCEPTION WHEN raise_exception THEN bad:=SQLERRM='CAMPAIGN_EDITOR_REQUIRED';END;
 ASSERT bad,'provider return must not authorize the next caller';
 -- Existing campaigns and Olivas do not become owned by this migration.
 INSERT INTO campaigns(id,name,status,sent,attribs) VALUES(400,'Legacy','draft',0,'{}'),(401,'Olivas','draft',0,'{"crm":{"policy":"crm-campaign-v1","brand":"olivas"}}');
 UPDATE campaigns SET subject='Legacy editor',status='running' WHERE id IN (400,401);
 DELETE FROM campaigns WHERE id IN (400,401);
 -- Native worker lifecycle: counters, due start, pause, resume, finish.
 PERFORM set_config('shrigma.campaign_writer','200',true);
 UPDATE campaigns SET status='scheduled',send_at=clock_timestamp()-interval '1 minute' WHERE id=200;
 PERFORM set_config('shrigma.campaign_writer','',true);
 UPDATE campaigns SET status='running',started_at=clock_timestamp() WHERE id=200;
 UPDATE campaigns SET sent=sent+1 WHERE id=200;
 UPDATE campaigns SET status='paused' WHERE id=200;
 UPDATE campaigns SET status='scheduled' WHERE id=200;
 UPDATE campaigns SET status='running' WHERE id=200;
 UPDATE campaigns SET status='finished' WHERE id=200;
 ASSERT (SELECT sent=1 AND status='finished' FROM campaigns WHERE id=200),'native lifecycle preserved';
END $tests$;
