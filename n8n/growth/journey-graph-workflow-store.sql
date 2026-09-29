-- Additive HTTP draft bridge. No schema change, catalog ownership, publish or runtime.
BEGIN;
CREATE OR REPLACE FUNCTION crm_graph_candidate.workflow_response_v1(status integer,body jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('status',status,'headers',jsonb_build_object('Cache-Control','no-store'),'body',jsonb_build_object('contract','journey_graph_draft_api_v1','authorizes_publish',false,'authorizes_send',false)||body)
$$;
CREATE OR REPLACE FUNCTION crm_graph_candidate.workflow_request_v1(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE fields text[];
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>196608 OR p->>'brand' IS NULL OR p->>'brand' NOT IN ('fish','aristo') THEN RETURN false;END IF;
 fields:=CASE p->>'action' WHEN 'capabilities' THEN ARRAY['action','brand'] WHEN 'catalog' THEN ARRAY['action','brand'] WHEN 'list' THEN ARRAY['action','brand','after','limit'] WHEN 'get' THEN ARRAY['action','brand','journey_id'] WHEN 'operation' THEN ARRAY['action','brand','request_id'] WHEN 'create' THEN ARRAY['action','brand','request_id','definition'] WHEN 'save' THEN ARRAY['action','brand','request_id','journey_id','expected_version','definition'] END;
 IF fields IS NULL OR p-fields<>'{}'::jsonb OR (SELECT count(*) FROM jsonb_object_keys(p))<>cardinality(fields) THEN RETURN false;END IF;
 IF p?'request_id' AND coalesce(p->>'request_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN RETURN false;END IF;
 IF p?'journey_id' AND coalesce(p->>'journey_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN RETURN false;END IF;
 IF p->>'action'='list' AND ((p->'after'<>'null'::jsonb AND coalesce(p->>'after','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') OR jsonb_typeof(p->'limit')<>'number' OR coalesce(p->>'limit','')!~'^([1-9]|[1-4][0-9]|50)$') THEN RETURN false;END IF;
 IF p->>'action'='save' AND (jsonb_typeof(p->'expected_version')<>'number' OR coalesce(p->>'expected_version','')!~'^[1-9][0-9]{0,9}$' OR (p->>'expected_version')::bigint>=2147483647) THEN RETURN false;END IF;
 IF p?'definition' AND (jsonb_typeof(p->'definition') IS DISTINCT FROM 'object' OR p#>>'{definition,brand}' IS DISTINCT FROM p->>'brand') THEN RETURN false;END IF;
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION crm_graph_candidate.workflow_read_v1(k text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='2s' AS $$
DECLARE auth jsonb;needed text;row record;revision record;payload jsonb;items jsonb;cursor_id uuid;ui jsonb;acquired boolean;
BEGIN
 IF NOT crm_graph_candidate.workflow_request_v1(p) THEN RETURN crm_graph_candidate.workflow_response_v1(400,'{"error":"GRAPH_REQUEST_INVALID"}');END IF;
 needed:=CASE WHEN p->>'action' IN ('create','save') THEN 'draft' ELSE 'read_content' END;
 auth:=public.shrigma_panel_operator_v1(k,'growth');
 IF auth->>'who' IS NULL OR auth->>'who'!~'^panel:[A-Za-z0-9_.:-]{1,122}$' OR jsonb_typeof(auth->'caps') IS DISTINCT FROM 'array' THEN RETURN crm_graph_candidate.workflow_response_v1(401,'{"error":"GRAPH_UNAUTHORIZED"}');END IF;
 IF NOT coalesce(auth->'caps' ? needed,false) THEN RETURN crm_graph_candidate.workflow_response_v1(403,'{"error":"GRAPH_PERMISSION_REQUIRED"}');END IF;
 IF p->>'action'='capabilities' THEN RETURN crm_graph_candidate.workflow_response_v1(200,'{"features":{"drafts":true,"simulation":true,"publish":false,"runtime":false},"simulation_mode":"local"}');END IF;
 IF p->>'action' IN ('create','save') THEN
  SELECT * INTO row FROM crm_graph_candidate.operation WHERE request_id=(p->>'request_id')::uuid;
  IF FOUND THEN RETURN jsonb_build_object('_private',true,'auth',jsonb_build_object('who',auth->'who'),'existing',true);END IF;
  RETURN jsonb_build_object('_private',true,'auth',jsonb_build_object('who',auth->'who'),'catalog',crm_graph_candidate.catalog_v1(p->>'brand'),'existing',false);
 END IF;
 IF p->>'action'='catalog' THEN
  ui:=crm_graph_candidate.catalog_ui_v1(p->>'brand');RETURN crm_graph_candidate.workflow_response_v1(200,ui);
 END IF;
 IF p->>'action'='list' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('journey_id',j.id,'brand',j.brand,'version',j.version,'revision',j.head_revision,'published_revision',j.published_revision,'paused',j.paused,'name',r.definition->>'name') ORDER BY j.id),'[]') INTO items FROM (SELECT * FROM crm_graph_candidate.journey WHERE brand=p->>'brand' AND (p->>'after' IS NULL OR id>(p->>'after')::uuid) ORDER BY id LIMIT (p->>'limit')::integer+1)j JOIN crm_graph_candidate.revision r ON r.journey_id=j.id AND r.revision=j.head_revision AND r.brand=j.brand;
  IF jsonb_array_length(items)>(p->>'limit')::integer THEN items:=items-(jsonb_array_length(items)-1);cursor_id:=(items->(jsonb_array_length(items)-1)->>'journey_id')::uuid;END IF;
  RETURN crm_graph_candidate.workflow_response_v1(200,jsonb_build_object('journeys',items,'next_cursor',cursor_id));
 END IF;
 IF p->>'action'='get' THEN
  SELECT j.*,r.definition,r.catalog,r.content_hash INTO row FROM crm_graph_candidate.journey j JOIN crm_graph_candidate.revision r ON r.journey_id=j.id AND r.revision=j.head_revision AND r.brand=j.brand WHERE j.id=(p->>'journey_id')::uuid AND j.brand=p->>'brand';
  IF NOT FOUND THEN RETURN crm_graph_candidate.workflow_response_v1(404,'{"error":"GRAPH_NOT_FOUND"}');END IF;
  ui:=crm_graph_candidate.catalog_ui_v1(p->>'brand');
  RETURN jsonb_build_object('_private',true,'kind','get','definition',row.definition,'stored_catalog',row.catalog,'content_hash',row.content_hash,'response',crm_graph_candidate.workflow_response_v1(200,ui||jsonb_build_object('server',jsonb_build_object('journey_id',row.id,'brand',row.brand,'version',row.version,'revision',row.head_revision,'published_revision',row.published_revision,'paused',row.paused),'definition',row.definition)));
 END IF;
 IF p->>'action'='operation' THEN
  SELECT * INTO row FROM crm_graph_candidate.operation WHERE request_id=(p->>'request_id')::uuid;
  IF NOT FOUND THEN
   acquired:=pg_try_advisory_xact_lock(hashtextextended(p->>'request_id',0));
   IF acquired THEN SELECT * INTO row FROM crm_graph_candidate.operation WHERE request_id=(p->>'request_id')::uuid;END IF;
  END IF;
  IF row.request_id IS NULL THEN RETURN crm_graph_candidate.workflow_response_v1(202,jsonb_build_object('state','unconfirmed','actor',auth->>'who','request_id',p->>'request_id','retry_same_request_only',true));END IF;
  IF row.actor IS DISTINCT FROM auth->>'who' OR row.brand IS DISTINCT FROM p->>'brand' OR row.action NOT IN ('create','save') THEN RETURN crm_graph_candidate.workflow_response_v1(404,'{"error":"GRAPH_OPERATION_NOT_FOUND"}');END IF;
  SELECT r.* INTO revision FROM crm_graph_candidate.revision r WHERE r.journey_id=(row.response->>'journey_id')::uuid AND r.revision=(row.response->>'revision')::integer AND r.brand=row.brand;
  IF NOT FOUND OR row.response->>'contract' IS DISTINCT FROM 'journey_graph_store_v1' OR row.response->>'operation_id' IS DISTINCT FROM p->>'request_id' OR row.response->>'brand' IS DISTINCT FROM row.brand OR row.response->'authorizes_send' IS DISTINCT FROM 'false'::jsonb THEN RETURN crm_graph_candidate.workflow_response_v1(503,'{"error":"GRAPH_READBACK_UNCONFIRMED"}');END IF;
  payload:=jsonb_build_object('action',row.action,'brand',row.brand,'request_id',row.request_id,'definition',revision.definition);
  IF row.action='save' THEN payload:=payload||jsonb_build_object('journey_id',row.response->>'journey_id','expected_version',(row.response->>'version')::integer-1);END IF;
  RETURN jsonb_build_object('_private',true,'kind','operation','actor',row.actor,'request_hash',row.request_hash,'definition',revision.definition,'stored_catalog',revision.catalog,'content_hash',revision.content_hash,'response',crm_graph_candidate.workflow_response_v1(200,jsonb_build_object('state','succeeded','actor',auth->>'who','request_id',row.request_id,'action',row.action,'request_payload',payload,'receipt',row.response)));
 END IF;
 RETURN crm_graph_candidate.workflow_response_v1(400,'{"error":"GRAPH_ACTION_UNAVAILABLE"}');
END $$;
CREATE OR REPLACE FUNCTION crm_graph_candidate.workflow_commit_v1(k text,p jsonb,proof jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE auth jsonb;actor text;old crm_graph_candidate.operation%ROWTYPE;j crm_graph_candidate.journey%ROWTYPE;catalog jsonb;request_hash text;content_hash text;now_at timestamptz;receipt jsonb;command jsonb;
BEGIN
 IF NOT crm_graph_candidate.workflow_request_v1(p) OR p->>'action' NOT IN ('create','save') THEN RETURN crm_graph_candidate.workflow_response_v1(400,'{"error":"GRAPH_REQUEST_INVALID"}');END IF;
 auth:=public.shrigma_panel_operator_v1(k,'growth');
 IF auth->>'who' IS NULL OR auth->>'who'!~'^panel:[A-Za-z0-9_.:-]{1,122}$' OR jsonb_typeof(auth->'caps') IS DISTINCT FROM 'array' THEN RETURN crm_graph_candidate.workflow_response_v1(401,'{"error":"GRAPH_UNAUTHORIZED"}');END IF;
 IF NOT coalesce(auth->'caps'?'draft',false) THEN RETURN crm_graph_candidate.workflow_response_v1(403,'{"error":"GRAPH_PERMISSION_REQUIRED"}');END IF;
 actor:=auth->>'who';
 PERFORM pg_advisory_xact_lock(hashtextextended(p->>'request_id',0));
 auth:=public.shrigma_panel_operator_v1(k,'growth');
 IF auth->>'who' IS DISTINCT FROM actor OR jsonb_typeof(auth->'caps') IS DISTINCT FROM 'array' THEN RETURN crm_graph_candidate.workflow_response_v1(401,'{"error":"GRAPH_UNAUTHORIZED"}');END IF;
 IF NOT coalesce(auth->'caps'?'draft',false) THEN RETURN crm_graph_candidate.workflow_response_v1(403,'{"error":"GRAPH_PERMISSION_REQUIRED"}');END IF;
 command:=(p-'action')||jsonb_build_object('actor',actor);
 IF jsonb_typeof(proof) IS DISTINCT FROM 'object' OR proof-ARRAY['actor','catalog','request_canonical','content_canonical']<>'{}'::jsonb OR (SELECT count(*) FROM jsonb_object_keys(proof))<>4 OR proof->>'actor' IS DISTINCT FROM actor OR coalesce(octet_length(proof->>'request_canonical'),0) NOT BETWEEN 1 AND 262144 OR (proof->>'request_canonical')::jsonb IS DISTINCT FROM jsonb_build_object('action',p->>'action','request',command) THEN RETURN crm_graph_candidate.workflow_response_v1(422,'{"error":"GRAPH_PROOF_INVALID"}');END IF;
 request_hash:=encode(sha256(convert_to(proof->>'request_canonical','UTF8')),'hex');
 SELECT * INTO old FROM crm_graph_candidate.operation WHERE request_id=(p->>'request_id')::uuid;
 IF FOUND THEN
  IF old.actor IS DISTINCT FROM actor OR old.brand IS DISTINCT FROM p->>'brand' OR old.action IS DISTINCT FROM p->>'action' OR old.request_hash IS DISTINCT FROM request_hash THEN RETURN crm_graph_candidate.workflow_response_v1(409,'{"error":"GRAPH_REPLAY_MISMATCH"}');END IF;
  RETURN crm_graph_candidate.workflow_response_v1(CASE p->>'action' WHEN 'create' THEN 201 ELSE 200 END,jsonb_build_object('state','succeeded','actor',actor,'request_id',p->>'request_id','request_payload',p,'receipt',old.response));
 END IF;
 PERFORM 1 FROM crm_graph_candidate.control WHERE singleton FOR SHARE;
 IF NOT FOUND THEN RETURN crm_graph_candidate.workflow_response_v1(503,'{"error":"GRAPH_SERVICE_UNAVAILABLE"}');END IF;
 IF p->>'action'='save' THEN
  SELECT * INTO j FROM crm_graph_candidate.journey WHERE id=(p->>'journey_id')::uuid AND brand=p->>'brand' FOR UPDATE;
  IF NOT FOUND THEN RETURN crm_graph_candidate.workflow_response_v1(404,'{"error":"GRAPH_NOT_FOUND"}');END IF;
  IF j.published_revision IS NOT NULL THEN RETURN crm_graph_candidate.workflow_response_v1(409,'{"error":"GRAPH_PUBLISHED_READ_ONLY"}');END IF;
  IF j.version<>(p->>'expected_version')::integer THEN RETURN crm_graph_candidate.workflow_response_v1(409,'{"error":"GRAPH_VERSION_CONFLICT"}');END IF;
 END IF;
 -- Control and journey row locks can also wait. Reauthorize after every
 -- blocking lock, immediately before catalog checks and any persistent write.
 auth:=public.shrigma_panel_operator_v1(k,'growth');
 IF auth->>'who' IS DISTINCT FROM actor OR jsonb_typeof(auth->'caps') IS DISTINCT FROM 'array' THEN RETURN crm_graph_candidate.workflow_response_v1(401,'{"error":"GRAPH_UNAUTHORIZED"}');END IF;
 IF NOT coalesce(auth->'caps'?'draft',false) THEN RETURN crm_graph_candidate.workflow_response_v1(403,'{"error":"GRAPH_PERMISSION_REQUIRED"}');END IF;
 catalog:=crm_graph_candidate.catalog_v1(p->>'brand');
 IF catalog IS DISTINCT FROM proof->'catalog' THEN RETURN crm_graph_candidate.workflow_response_v1(409,'{"error":"GRAPH_CATALOG_CHANGED"}');END IF;
 IF jsonb_typeof(proof->'catalog') IS DISTINCT FROM 'object' OR coalesce(octet_length(proof->>'content_canonical'),0) NOT BETWEEN 1 AND 262144 OR (proof->>'content_canonical')::jsonb IS DISTINCT FROM jsonb_build_object('definition',p->'definition','catalog',catalog) THEN RETURN crm_graph_candidate.workflow_response_v1(422,'{"error":"GRAPH_PROOF_INVALID"}');END IF;
 content_hash:=encode(sha256(convert_to(proof->>'content_canonical','UTF8')),'hex');now_at:=date_trunc('milliseconds',clock_timestamp());
 IF p->>'action'='create' THEN INSERT INTO crm_graph_candidate.journey(brand) VALUES(p->>'brand') RETURNING * INTO j;
 ELSE UPDATE crm_graph_candidate.journey SET version=version+1,head_revision=head_revision+1 WHERE id=j.id RETURNING * INTO j;END IF;
 INSERT INTO crm_graph_candidate.revision(journey_id,brand,revision,definition,catalog,content_hash,created_at) VALUES(j.id,j.brand,j.head_revision,p->'definition',catalog,content_hash,now_at);
 receipt:=jsonb_build_object('contract','journey_graph_store_v1','operation_id',p->>'request_id','authorizes_send',false,'journey_id',j.id,'brand',j.brand,'version',j.version,'revision',j.head_revision,'published_revision',j.published_revision,'paused',j.paused);
 INSERT INTO crm_graph_candidate.operation(request_id,actor,brand,action,request_hash,response,created_at) VALUES((p->>'request_id')::uuid,actor,p->>'brand',p->>'action',request_hash,receipt,now_at);
 RETURN crm_graph_candidate.workflow_response_v1(CASE p->>'action' WHEN 'create' THEN 201 ELSE 200 END,jsonb_build_object('state','succeeded','actor',actor,'request_id',p->>'request_id','request_payload',p,'receipt',receipt));
END $$;
REVOKE ALL ON FUNCTION crm_graph_candidate.workflow_response_v1(integer,jsonb),crm_graph_candidate.workflow_request_v1(jsonb),crm_graph_candidate.workflow_read_v1(text,jsonb),crm_graph_candidate.workflow_commit_v1(text,jsonb,jsonb) FROM PUBLIC;
COMMIT;
