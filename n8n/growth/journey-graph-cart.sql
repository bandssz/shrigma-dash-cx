-- Candidate first cart email only. Install OFF; original finish is never changed.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $install$ BEGIN
 IF to_regclass('crm_graph_candidate.intent') IS NULL OR to_regclass('crm_graph_candidate.native_template_v1') IS NULL
 OR to_regprocedure('public.shrigma_email_claim_cart(jsonb)') IS NULL OR to_regprocedure('public.shrigma_email_finish_cart(uuid,uuid,text,jsonb)') IS NULL THEN RAISE EXCEPTION 'GRAPH_CART_DEPENDENCY';END IF;
 IF (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid='public.shrigma_email_claim_cart(jsonb)'::regprocedure) IS DISTINCT FROM '2ac184cbc776d61c3f3e6cd8d943ce99'
 OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid='public.shrigma_email_finish_cart(uuid,uuid,text,jsonb)'::regprocedure) IS DISTINCT FROM 'd34ea14526664f660d749017023ef537' THEN RAISE EXCEPTION 'GRAPH_CART_LEGACY_DRIFT';END IF;
 IF EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='crm_graph_candidate'::regnamespace AND relname IN ('cart_control_v1','cart_epoch_v1','cart_owner_v1','cart_delivery_v1','cart_permit_v1'))
 OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='crm_graph_candidate'::regnamespace AND proname IN ('cart_maintenance_guard_v1','cart_immutable_v1','cart_epoch_open_v1','cart_epoch_close_v1','cart_owned_v1','cart_enroll_v1','cart_pin_v1','cart_url_v1','cart_dispatch_v1','cart_claim_v1')) THEN RAISE EXCEPTION 'GRAPH_CART_COLLISION';END IF;
END $install$;
CREATE TABLE crm_graph_candidate.cart_control_v1(brand text PRIMARY KEY CHECK(brand IN ('fish','aristo')),enabled boolean NOT NULL DEFAULT false,cache_target text);
INSERT INTO crm_graph_candidate.cart_control_v1(brand) VALUES('fish'),('aristo');
CREATE TABLE crm_graph_candidate.cart_epoch_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand text NOT NULL REFERENCES crm_graph_candidate.cart_control_v1(brand),
 journey_id uuid NOT NULL,revision integer NOT NULL,release_id uuid NOT NULL REFERENCES crm_graph_candidate.message_release_v1(id),
 material_sha256 text NOT NULL,native_id uuid NOT NULL REFERENCES crm_graph_candidate.native_template_v1(id),cache_target text NOT NULL,
 starts_at timestamptz NOT NULL DEFAULT clock_timestamp(),ends_at timestamptz,actor text NOT NULL,
 FOREIGN KEY(journey_id,revision,brand) REFERENCES crm_graph_candidate.revision(journey_id,revision,brand),CHECK(ends_at IS NULL OR ends_at>=starts_at),UNIQUE(id,brand)
);
CREATE UNIQUE INDEX graph_cart_one_open_epoch ON crm_graph_candidate.cart_epoch_v1(brand) WHERE ends_at IS NULL;
CREATE TABLE crm_graph_candidate.cart_owner_v1(
 source_ref uuid PRIMARY KEY REFERENCES crm_graph_candidate.source_event_v1(id),epoch_id uuid NOT NULL,brand text NOT NULL,
 entry_id uuid NOT NULL UNIQUE,subscriber_id integer NOT NULL,ref timestamptz NOT NULL,piece text NOT NULL DEFAULT 'carrinho-30min' CHECK(piece='carrinho-30min'),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(epoch_id,brand) REFERENCES crm_graph_candidate.cart_epoch_v1(id,brand),FOREIGN KEY(entry_id,brand) REFERENCES crm_graph_candidate.entry(id,brand),
 UNIQUE(brand,subscriber_id,ref,piece),CHECK(expires_at=ref+interval '1 hour')
);
CREATE TABLE crm_graph_candidate.cart_delivery_v1(
 intent_id uuid PRIMARY KEY REFERENCES crm_graph_candidate.intent(id),entry_id uuid NOT NULL UNIQUE,brand text NOT NULL,
 revision integer NOT NULL,node_id text NOT NULL,attempt_key text NOT NULL UNIQUE,
 source_ref uuid NOT NULL UNIQUE REFERENCES crm_graph_candidate.cart_owner_v1(source_ref),dispatch_id uuid NOT NULL UNIQUE REFERENCES public.shrigma_email_dispatch(dispatch_id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),FOREIGN KEY(entry_id,brand) REFERENCES crm_graph_candidate.entry(id,brand)
);
-- Exists only inside the claim transaction; stores hashes, never recipient/body.
CREATE TABLE crm_graph_candidate.cart_permit_v1(
 intent_id uuid PRIMARY KEY REFERENCES crm_graph_candidate.intent(id),brand text NOT NULL,tx bigint NOT NULL,
 body_sha256 text NOT NULL,raw_url_sha256 text NOT NULL,url_sha256 text NOT NULL,clone_id integer NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE FUNCTION crm_graph_candidate.cart_immutable_v1() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
 IF TG_TABLE_NAME='cart_epoch_v1' AND TG_OP='UPDATE' AND OLD.ends_at IS NULL AND NEW.ends_at IS NOT NULL AND NEW.ends_at>=OLD.starts_at
 AND to_jsonb(NEW)-'ends_at'=to_jsonb(OLD)-'ends_at' THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'GRAPH_CART_IMMUTABLE';
END $f$;
CREATE TRIGGER graph_cart_epoch_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.cart_epoch_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.cart_immutable_v1();
CREATE TRIGGER graph_cart_owner_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.cart_owner_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.cart_immutable_v1();
CREATE TRIGGER graph_cart_delivery_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.cart_delivery_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.cart_immutable_v1();

-- The retention gate is a required execution dependency, never a best-effort check.
CREATE FUNCTION crm_graph_candidate.cart_maintenance_guard_v1() RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE c record;
BEGIN
 IF to_regclass('crm_maintenance_candidate.control') IS NULL THEN RAISE EXCEPTION 'GRAPH_CART_MAINTENANCE_UNAVAILABLE';END IF;
 SELECT enabled,mode INTO c FROM crm_maintenance_candidate.control WHERE singleton FOR SHARE;
 IF NOT FOUND OR c.enabled IS DISTINCT FROM true OR c.mode IS DISTINCT FROM 'open' THEN RAISE EXCEPTION 'GRAPH_CART_MAINTENANCE_CLOSED';END IF;
END $f$;
CREATE FUNCTION crm_graph_candidate.cart_epoch_open_v1(a text,b text,jid uuid,expected integer,target text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,crm_graph_candidate SET lock_timeout='3s' AS $f$
DECLARE j crm_graph_candidate.journey%ROWTYPE;r crm_graph_candidate.revision%ROWTYPE;e crm_graph_candidate.cart_epoch_v1%ROWTYPE;m jsonb;n jsonb;
BEGIN
 PERFORM crm_graph_candidate.cart_maintenance_guard_v1();
 IF coalesce(a,'')!~'^panel:.{1,194}$' OR coalesce(b,'') NOT IN ('fish','aristo') THEN RAISE EXCEPTION 'GRAPH_CART_INPUT';END IF;
 PERFORM 1 FROM crm_graph_candidate.control WHERE singleton AND enabled FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_CART_DISABLED';END IF;
 PERFORM 1 FROM crm_graph_candidate.cart_control_v1 WHERE brand=b AND enabled AND cache_target=target FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_CART_DISABLED';END IF;
 SELECT * INTO j FROM crm_graph_candidate.journey WHERE id=jid AND brand=b FOR UPDATE;
 IF NOT FOUND OR j.version IS DISTINCT FROM expected OR j.published_revision IS NULL THEN RAISE EXCEPTION 'GRAPH_CART_VERSION';END IF;
 SELECT * INTO r FROM crm_graph_candidate.revision WHERE journey_id=jid AND revision=j.published_revision AND brand=b;
 IF (SELECT count(*) FROM jsonb_array_elements(r.definition->'nodes') x WHERE x->>'type'='message')<>1 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.definition->'nodes') x WHERE x->>'type'='trigger' AND x->>'event'='cart.abandoned') THEN RAISE EXCEPTION 'GRAPH_CART_SCOPE';END IF;
 SELECT x INTO m FROM jsonb_array_elements(r.catalog->'messages') x WHERE x->>'key'=(SELECT y->>'binding' FROM jsonb_array_elements(r.definition->'nodes') y WHERE y->>'type'='message');
 IF m->>'brand' IS DISTINCT FROM b OR m->>'channel' IS DISTINCT FROM 'email' OR m#>>'{material,version}' IS DISTINCT FROM 'cart_email_material_v2' THEN RAISE EXCEPTION 'GRAPH_CART_SCOPE';END IF;
 n:=crm_graph_candidate.native_resolve_v1(b,(m#>>'{material,release_id}')::uuid,m#>>'{material,material_sha256}',target);
 SELECT * INTO e FROM crm_graph_candidate.cart_epoch_v1 WHERE brand=b AND ends_at IS NULL;
 IF FOUND THEN
  IF e.journey_id<>jid OR e.revision<>j.published_revision OR e.native_id<>(n->>'native_id')::uuid OR e.cache_target<>target OR e.actor<>a THEN RAISE EXCEPTION 'GRAPH_CART_EPOCH_CONFLICT';END IF;
 ELSE INSERT INTO crm_graph_candidate.cart_epoch_v1(brand,journey_id,revision,release_id,material_sha256,native_id,cache_target,actor)
 VALUES(b,jid,j.published_revision,(n->>'release_id')::uuid,n->>'material_sha256',(n->>'native_id')::uuid,target,a) RETURNING * INTO e;END IF;
 RETURN jsonb_build_object('epoch_id',e.id,'brand',b,'journey_id',jid,'revision',e.revision,'starts_at',e.starts_at,'ends_at',e.ends_at);
END $f$;
CREATE FUNCTION crm_graph_candidate.cart_epoch_close_v1(b text,eid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,crm_graph_candidate SET lock_timeout='3s' AS $f$
DECLARE e crm_graph_candidate.cart_epoch_v1%ROWTYPE;
BEGIN
 PERFORM 1 FROM crm_graph_candidate.cart_control_v1 WHERE brand=b FOR UPDATE;
 SELECT * INTO e FROM crm_graph_candidate.cart_epoch_v1 WHERE id=eid AND brand=b FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_CART_NOT_FOUND';END IF;
 IF e.ends_at IS NULL THEN UPDATE crm_graph_candidate.cart_epoch_v1 SET ends_at=clock_timestamp() WHERE id=eid RETURNING * INTO e;END IF;
 RETURN jsonb_build_object('epoch_id',e.id,'brand',b,'journey_id',e.journey_id,'revision',e.revision,'starts_at',e.starts_at,'ends_at',e.ends_at);
END $f$;
-- Even paused or closed epochs keep ownership of their original cohort forever.
CREATE FUNCTION crm_graph_candidate.cart_owned_v1(b jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,crm_graph_candidate AS $f$
DECLARE at timestamptz;sid integer;v_brand text:=b->>'brand';
BEGIN
 IF v_brand NOT IN ('fish','aristo') OR b->>'toque' IS DISTINCT FROM 't05' THEN RETURN false;END IF;
 IF coalesce(b->>'subscriber_id','')!~'^[1-9][0-9]{0,8}$' OR coalesce(b->>'ref','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN RETURN false;END IF;
 at:=(b->>'ref')::timestamptz;sid:=(b->>'subscriber_id')::integer;
 PERFORM 1 FROM crm_graph_candidate.cart_control_v1 WHERE brand=v_brand FOR SHARE;
 RETURN EXISTS(SELECT 1 FROM crm_graph_candidate.cart_owner_v1 WHERE brand=v_brand AND subscriber_id=sid AND ref=at)
 OR EXISTS(SELECT 1 FROM crm_graph_candidate.cart_epoch_v1 WHERE brand=v_brand AND at>=starts_at AND (ends_at IS NULL OR at<ends_at));
END $f$;
CREATE FUNCTION crm_graph_candidate.cart_enroll_v1(b text,eid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,crm_graph_candidate SET lock_timeout='3s' AS $f$
DECLARE e crm_graph_candidate.entry%ROWTYPE;s crm_graph_candidate.source_event_v1%ROWTYPE;ep crm_graph_candidate.cart_epoch_v1%ROWTYPE;o crm_graph_candidate.cart_owner_v1%ROWTYPE;
BEGIN
 PERFORM 1 FROM crm_graph_candidate.control WHERE singleton AND enabled FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_CART_DISABLED';END IF;
 PERFORM 1 FROM crm_graph_candidate.cart_control_v1 WHERE brand=b AND enabled FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_CART_DISABLED';END IF;
 SELECT * INTO e FROM crm_graph_candidate.entry WHERE id=eid AND brand=b;
 IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_CART_NOT_FOUND';END IF;
 PERFORM 1 FROM crm_graph_candidate.journey WHERE id=e.journey_id AND brand=b FOR UPDATE;
 SELECT * INTO e FROM crm_graph_candidate.entry WHERE id=eid AND brand=b FOR UPDATE;
 SELECT * INTO s FROM crm_graph_candidate.source_event_v1 WHERE id=e.source_ref AND brand=b;
 SELECT * INTO ep FROM crm_graph_candidate.cart_epoch_v1 WHERE brand=b AND s.ref>=starts_at AND (ends_at IS NULL OR s.ref<ends_at);
 IF NOT FOUND OR s.ref IS DISTINCT FROM date_trunc('milliseconds',s.ref) OR ep.journey_id<>e.journey_id OR ep.revision<>e.revision THEN RAISE EXCEPTION 'GRAPH_CART_COHORT_MISMATCH';END IF;
 SELECT * INTO o FROM crm_graph_candidate.cart_owner_v1 WHERE source_ref=s.id;
 IF FOUND THEN IF o.entry_id<>eid OR o.brand<>b OR o.epoch_id<>ep.id THEN RAISE EXCEPTION 'GRAPH_CART_OWNER_CONFLICT';END IF;
 ELSE INSERT INTO crm_graph_candidate.cart_owner_v1(source_ref,epoch_id,brand,entry_id,subscriber_id,ref,expires_at) VALUES(s.id,ep.id,b,eid,s.subscriber_id,s.ref,s.ref+interval '1 hour') RETURNING * INTO o;END IF;
 RETURN jsonb_build_object('brand',b,'entry_id',eid,'epoch_id',ep.id,'source_ref',s.id,'expires_at',o.expires_at);
END $f$;
CREATE FUNCTION crm_graph_candidate.cart_pin_v1(b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,crm_graph_candidate AS $f$
DECLARE p crm_graph_candidate.cart_permit_v1%ROWTYPE;h text;
BEGIN
 SELECT * INTO p FROM crm_graph_candidate.cart_permit_v1 WHERE intent_id=(b->>'graph_intent_id')::uuid AND brand=b->>'brand' AND tx=txid_current();
 h:=encode(sha256(convert_to(((b-'template_id'-'tx')||jsonb_build_object('tx',(b->'tx')-'template_id'))::text,'UTF8')),'hex');
 IF NOT FOUND OR p.body_sha256 IS DISTINCT FROM h OR clock_timestamp()>=p.expires_at THEN RAISE EXCEPTION 'GRAPH_CART_PERMIT_INVALID';END IF;
 RETURN b||jsonb_build_object('template_id',p.clone_id,'tx',jsonb_set(b->'tx','{template_id}',to_jsonb(p.clone_id)));
END $f$;
CREATE FUNCTION crm_graph_candidate.cart_url_v1(b jsonb,raw_url text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,crm_graph_candidate AS $f$
 SELECT EXISTS(SELECT 1 FROM crm_graph_candidate.cart_permit_v1 p WHERE p.intent_id=(b->>'graph_intent_id')::uuid AND p.brand=b->>'brand' AND p.tx=txid_current()
 AND p.raw_url_sha256=encode(sha256(convert_to(raw_url,'UTF8')),'hex') AND p.url_sha256=encode(sha256(convert_to(b#>>'{tx,data,checkout_url}','UTF8')),'hex') AND clock_timestamp()<p.expires_at)
$f$;
CREATE FUNCTION crm_graph_candidate.cart_dispatch_v1(b text,iid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,crm_graph_candidate AS $f$
DECLARE l crm_graph_candidate.cart_delivery_v1%ROWTYPE;o crm_graph_candidate.cart_owner_v1%ROWTYPE;d public.shrigma_email_dispatch%ROWTYPE;i crm_graph_candidate.intent%ROWTYPE;
BEGIN
 SELECT * INTO l FROM crm_graph_candidate.cart_delivery_v1 WHERE intent_id=iid AND brand=b;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO i FROM crm_graph_candidate.intent WHERE id=iid AND brand=b;
 SELECT * INTO o FROM crm_graph_candidate.cart_owner_v1 WHERE source_ref=l.source_ref AND brand=b;
 SELECT * INTO d FROM public.shrigma_email_dispatch WHERE dispatch_id=l.dispatch_id FOR SHARE;
 IF i.entry_id IS DISTINCT FROM l.entry_id OR i.node_id IS DISTINCT FROM l.node_id OR i.attempt_key IS DISTINCT FROM l.attempt_key OR o.entry_id IS DISTINCT FROM l.entry_id
 OR d.brand IS DISTINCT FROM b OR d.flow IS DISTINCT FROM 'carrinho' OR d.piece IS DISTINCT FROM 'carrinho-30min' OR d.is_test IS DISTINCT FROM false
 OR d.dedupe_key IS DISTINCT FROM jsonb_build_array('email',to_char(o.ref AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),o.subscriber_id,false)::text THEN RAISE EXCEPTION 'GRAPH_CART_DISPATCH_MISMATCH';END IF;
 RETURN jsonb_build_object('contract','journey_graph_cart_dispatch_v1','brand',b,'intent_id',iid,'entry_id',l.entry_id,'revision',l.revision,'node_id',l.node_id,'attempt_key',l.attempt_key,'dispatch_id',d.dispatch_id,'transport_state',d.transport_state);
END $f$;

CREATE FUNCTION crm_graph_candidate.cart_claim_v1(b text,iid uuid,expected integer,p jsonb,target text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,crm_graph_candidate SET lock_timeout='3s' AS $f$
DECLARE i crm_graph_candidate.intent%ROWTYPE;e crm_graph_candidate.entry%ROWTYPE;j crm_graph_candidate.journey%ROWTYPE;o crm_graph_candidate.cart_owner_v1%ROWTYPE;ep crm_graph_candidate.cart_epoch_v1%ROWTYPE;
 s public.subscribers%ROWTYPE;existing public.shrigma_email_dispatch%ROWTYPE;r jsonb;native jsonb;source jsonb;body jsonb;v_tx jsonb;h text;deadline timestamptz;checked timestamptz;reply record;timedout boolean:=false;
BEGIN
 PERFORM crm_graph_candidate.cart_maintenance_guard_v1();
 IF coalesce(b,'') NOT IN ('fish','aristo') OR iid IS NULL OR expected IS NULL OR expected<1 OR jsonb_typeof(p) IS DISTINCT FROM 'object'
 OR p-ARRAY['contract','intent_id','brand','entry_id','entry_version','source_ref','release_id','material_sha256','native_id','checked_at','expires_at','authorizes_send','transport','recipient','ref','message','source_checkout_url']<>'{}'::jsonb OR (SELECT count(*) FROM jsonb_object_keys(p))<>17
 OR p->>'contract' IS DISTINCT FROM 'journey_graph_message_preflight_v1' OR p->>'brand' IS DISTINCT FROM b OR p->>'intent_id' IS DISTINCT FROM iid::text OR p->>'entry_version' IS DISTINCT FROM expected::text OR p->'authorizes_send' IS DISTINCT FROM 'false'::jsonb OR p->'transport' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'GRAPH_CART_PROOF_INVALID';END IF;
 checked:=(p->>'checked_at')::timestamptz;deadline:=(p->>'expires_at')::timestamptz;
 IF checked IS NULL OR deadline IS NULL OR checked>clock_timestamp() OR deadline<=clock_timestamp() OR deadline>checked+interval '5 seconds' THEN RAISE EXCEPTION 'GRAPH_CART_PROOF_EXPIRED';END IF;
 PERFORM 1 FROM crm_graph_candidate.control WHERE singleton AND enabled FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_CART_DISABLED';END IF;
 PERFORM 1 FROM crm_graph_candidate.cart_control_v1 WHERE brand=b AND enabled AND cache_target=target FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_CART_DISABLED';END IF;
 SELECT * INTO i FROM crm_graph_candidate.intent WHERE id=iid AND brand=b;IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_CART_NOT_FOUND';END IF;
 SELECT * INTO e FROM crm_graph_candidate.entry WHERE id=i.entry_id AND brand=b;
 SELECT * INTO j FROM crm_graph_candidate.journey WHERE id=e.journey_id AND brand=b FOR UPDATE;
 SELECT * INTO e FROM crm_graph_candidate.entry WHERE id=i.entry_id AND brand=b FOR UPDATE;
 SELECT * INTO i FROM crm_graph_candidate.intent WHERE id=iid AND brand=b FOR UPDATE;
 r:=crm_graph_candidate.cart_dispatch_v1(b,iid);
 IF r IS NOT NULL THEN RETURN jsonb_build_object('should_send',false,'dispatch_id',r->'dispatch_id','claim_token',NULL,'payload',NULL,'context',NULL,'reason',r->>'transport_state');END IF;
 IF j.paused OR e.stopped_reason IS NOT NULL OR e.version IS DISTINCT FROM expected OR e.state->>'status' IS DISTINCT FROM 'waiting_message' OR e.state->>'node_id' IS DISTINCT FROM i.node_id OR e.state->>'attempt_key' IS DISTINCT FROM i.attempt_key OR i.channel<>'email' OR i.authorizes_send THEN RAISE EXCEPTION 'GRAPH_CART_NOT_PENDING';END IF;
 SELECT * INTO o FROM crm_graph_candidate.cart_owner_v1 WHERE entry_id=e.id AND brand=b;
 IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_CART_OWNER_REQUIRED';END IF;
 SELECT * INTO ep FROM crm_graph_candidate.cart_epoch_v1 WHERE id=o.epoch_id AND brand=b;
 IF ep.journey_id<>j.id OR ep.revision<>e.revision OR ep.cache_target IS DISTINCT FROM target OR p->>'entry_id' IS DISTINCT FROM e.id::text OR p->>'source_ref' IS DISTINCT FROM o.source_ref::text OR p->>'release_id' IS DISTINCT FROM ep.release_id::text OR p->>'native_id' IS DISTINCT FROM ep.native_id::text OR p->>'material_sha256' IS DISTINCT FROM ep.material_sha256 OR (p->>'ref')::timestamptz IS DISTINCT FROM o.ref THEN RAISE EXCEPTION 'GRAPH_CART_BINDING';END IF;
 IF i.release IS DISTINCT FROM 'release_'||ep.release_id::text OR NOT EXISTS(SELECT 1 FROM crm_graph_candidate.revision rv CROSS JOIN LATERAL jsonb_array_elements(rv.catalog->'messages') m WHERE rv.journey_id=j.id AND rv.revision=e.revision AND m->>'key'=i.binding AND m->>'release'=i.release AND m#>>'{material,release_id}'=ep.release_id::text AND m#>>'{material,material_sha256}'=ep.material_sha256) THEN RAISE EXCEPTION 'GRAPH_CART_BINDING';END IF;
 native:=crm_graph_candidate.native_resolve_v1(b,ep.release_id,ep.material_sha256,target);
 IF jsonb_typeof(p->'recipient') IS DISTINCT FROM 'object' OR (p->'recipient')-ARRAY['subscriber_id','subject_id','email']<>'{}'::jsonb OR (SELECT count(*) FROM jsonb_object_keys(p->'recipient'))<>3
 OR jsonb_typeof(p->'message') IS DISTINCT FROM 'object' OR (p->'message')-ARRAY['template_id','subscriber_email','from_email','headers','data']<>'{}'::jsonb OR (SELECT count(*) FROM jsonb_object_keys(p->'message'))<>5
 OR p#>>'{message,template_id}' IS DISTINCT FROM native->>'clone_template_id' OR jsonb_typeof(p#>'{message,data}') IS DISTINCT FROM 'object' OR octet_length(p::text)>131072 THEN RAISE EXCEPTION 'GRAPH_CART_PROOF_INVALID';END IF;
 -- The common legacy advisory lock precedes subscriber/list locks for both paths.
 PERFORM pg_advisory_xact_lock(hashtextextended('r4-claim:'||b||':carrinho:carrinho-30min:'||jsonb_build_array('email',to_char(o.ref AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),o.subscriber_id,false)::text,0));
 SELECT * INTO existing FROM public.shrigma_email_dispatch WHERE brand=b AND flow='carrinho' AND piece='carrinho-30min' AND dedupe_key=jsonb_build_array('email',to_char(o.ref AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),o.subscriber_id,false)::text FOR UPDATE;
 IF FOUND THEN RETURN jsonb_build_object('should_send',false,'dispatch_id',existing.dispatch_id,'claim_token',NULL,'payload',NULL,'context',NULL,'reason','legacy_existing_dispatch');END IF;
 SELECT * INTO s FROM public.subscribers WHERE id=o.subscriber_id FOR UPDATE;
 PERFORM 1 FROM public.subscriber_lists WHERE subscriber_id=o.subscriber_id ORDER BY list_id FOR SHARE;
 source:=crm_graph_candidate.source_read_v1(b,o.source_ref);
 IF s.id IS NULL OR p#>>'{recipient,subscriber_id}' IS DISTINCT FROM s.id::text OR p#>>'{recipient,subject_id}' IS DISTINCT FROM s.uuid::text OR p#>>'{recipient,email}' IS DISTINCT FROM s.email
 OR p#>>'{message,subscriber_email}' IS DISTINCT FROM s.email OR p->>'source_checkout_url' IS DISTINCT FROM s.attribs#>>ARRAY[b,'cart_url']
 OR source->'eligible' IS DISTINCT FROM 'true'::jsonb OR source->'consent' IS DISTINCT FROM 'true'::jsonb OR source->'suppressed' IS DISTINCT FROM 'false'::jsonb OR source->'purchase_positive'='true'::jsonb THEN RAISE EXCEPTION 'GRAPH_CART_SOURCE_CHANGED';END IF;
 IF clock_timestamp()>=least(deadline,o.expires_at) THEN RAISE EXCEPTION 'GRAPH_CART_PROOF_EXPIRED';END IF;
 v_tx:=(p->'message')||jsonb_build_object('template_id',CASE b WHEN 'fish' THEN 60 ELSE 95 END,'content_type','html');
 body:=jsonb_build_object('brand',b,'toque','t05','piece','carrinho-30min','chave','cart_t05_at','subscriber_id',s.id,'email',s.email,'ref',to_char(o.ref AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'template_id',CASE b WHEN 'fish' THEN 60 ELSE 95 END,'tx',v_tx,'graph_intent_id',iid,'graph_expires_at',to_char(least(deadline,o.expires_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 h:=encode(sha256(convert_to(((body-'template_id'-'tx')||jsonb_build_object('tx',(body->'tx')-'template_id'))::text,'UTF8')),'hex');
 BEGIN
  INSERT INTO crm_graph_candidate.cart_permit_v1 VALUES(iid,b,txid_current(),h,encode(sha256(convert_to(p->>'source_checkout_url','UTF8')),'hex'),encode(sha256(convert_to(p#>>'{message,data,checkout_url}','UTF8')),'hex'),(native->>'clone_template_id')::integer,least(deadline,o.expires_at));
  SELECT * INTO reply FROM public.shrigma_email_claim_cart(body);
  IF reply.should_send IS DISTINCT FROM false AND reply.should_send IS DISTINCT FROM true THEN RAISE EXCEPTION 'GRAPH_CART_CLAIM_UNCONFIRMED';END IF;
  IF clock_timestamp()>=least(deadline,o.expires_at) THEN timedout:=true;RAISE SQLSTATE 'PZ002' USING MESSAGE='GRAPH_CART_PROOF_EXPIRED';END IF;
  IF reply.should_send THEN
   IF reply.dispatch_id IS NULL OR reply.claim_token IS NULL OR reply.context->>'graph_intent_id' IS DISTINCT FROM iid::text OR reply.context->>'template_id' IS DISTINCT FROM native->>'clone_template_id' OR reply.payload->>'template_id' IS DISTINCT FROM native->>'clone_template_id' THEN RAISE EXCEPTION 'GRAPH_CART_CLAIM_UNCONFIRMED';END IF;
   INSERT INTO crm_graph_candidate.cart_delivery_v1(intent_id,entry_id,brand,revision,node_id,attempt_key,source_ref,dispatch_id) VALUES(iid,e.id,b,e.revision,i.node_id,i.attempt_key,o.source_ref,reply.dispatch_id);
   PERFORM crm_graph_candidate.cart_dispatch_v1(b,iid);
  END IF;
  DELETE FROM crm_graph_candidate.cart_permit_v1 WHERE intent_id=iid;
 EXCEPTION WHEN SQLSTATE 'PZ002' THEN IF NOT timedout THEN RAISE;END IF;
 END;
 IF timedout THEN RETURN jsonb_build_object('should_send',false,'dispatch_id',NULL,'claim_token',NULL,'payload',NULL,'context',NULL,'reason','graph_proof_expired');END IF;
 RETURN jsonb_build_object('should_send',reply.should_send,'dispatch_id',reply.dispatch_id,'claim_token',reply.claim_token,'payload',reply.payload,'context',reply.context,'reason',reply.reason);
END $f$;

-- Patch only exact anchors; unowned legacy requests retain original rules.
DO $patch$ DECLARE src text;anchor text;replacement text; BEGIN
 SELECT pg_get_functiondef('public.shrigma_email_claim_cart(jsonb)'::regprocedure) INTO src;
 anchor:='v_piece=''carrinho-''||CASE v_stage';
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'GRAPH_CART_PATCH_DRIFT';END IF;
 src:=replace(src,anchor,'-- GRAPH_CART_BRIDGE_V1: cohort remains owned even while paused.
IF NOT b ? ''graph_intent_id'' AND crm_graph_candidate.cart_owned_v1(b) THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,''graph_owned'';RETURN;END IF;
'||anchor);
 anchor:='IF coalesce(b->>''subscriber_id'','''') !~ ''^[1-9][0-9]*$''';
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'GRAPH_CART_PATCH_DRIFT';END IF;
 src:=replace(src,anchor,'IF b ? ''graph_intent_id'' THEN b:=crm_graph_candidate.cart_pin_v1(b);v_template:=(b->>''template_id'')::integer;v_tx:=b->''tx'';END IF;
'||anchor);
 anchor:='OR v_tx#>>''{data,checkout_url}'' IS DISTINCT FROM (a->>''cart_url'')||(CASE WHEN position(''?'' in a->>''cart_url'')>0 THEN ''&'' ELSE ''?'' END)||''utm_source=email&utm_medium=fluxo&utm_campaign=''||v_brand||''-carrinho&utm_content=''||v_piece';
 replacement:='OR (CASE WHEN b ? ''graph_intent_id'' THEN NOT crm_graph_candidate.cart_url_v1(b,a->>''cart_url'') ELSE v_tx#>>''{data,checkout_url}'' IS DISTINCT FROM (a->>''cart_url'')||(CASE WHEN position(''?'' in a->>''cart_url'')>0 THEN ''&'' ELSE ''?'' END)||''utm_source=email&utm_medium=fluxo&utm_campaign=''||v_brand||''-carrinho&utm_content=''||v_piece END)';
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'GRAPH_CART_PATCH_DRIFT';END IF;
 src:=replace(src,anchor,replacement);
 anchor:='a=s.attribs->v_brand; f=coalesce(a->''flows'',''{}'');';
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'GRAPH_CART_PATCH_DRIFT';END IF;
 src:=replace(src,anchor,'IF NOT b ? ''graph_intent_id'' AND crm_graph_candidate.cart_owned_v1(b) THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,''graph_owned'';RETURN;END IF;
'||anchor);EXECUTE src;
END $patch$;
REVOKE ALL ON crm_graph_candidate.cart_control_v1,crm_graph_candidate.cart_epoch_v1,crm_graph_candidate.cart_owner_v1,crm_graph_candidate.cart_delivery_v1,crm_graph_candidate.cart_permit_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_graph_candidate.cart_maintenance_guard_v1(),crm_graph_candidate.cart_immutable_v1(),crm_graph_candidate.cart_epoch_open_v1(text,text,uuid,integer,text),crm_graph_candidate.cart_epoch_close_v1(text,uuid),crm_graph_candidate.cart_owned_v1(jsonb),crm_graph_candidate.cart_enroll_v1(text,uuid),crm_graph_candidate.cart_pin_v1(jsonb),crm_graph_candidate.cart_url_v1(jsonb,text),crm_graph_candidate.cart_dispatch_v1(text,uuid),crm_graph_candidate.cart_claim_v1(text,uuid,integer,jsonb,text) FROM PUBLIC;
COMMIT;
