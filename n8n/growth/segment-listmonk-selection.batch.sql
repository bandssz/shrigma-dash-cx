-- V7 PREPARED SELECT ONLY. $1=jsonb ORIGINAL admitted worker context; $2=integer[].
-- No authority/context builder, DDL, SQL from JSON, persistent cache or writes.
-- Caller must preserve original selection_worker_context/readiness/worker fences.
WITH RECURSIVE
input AS MATERIALIZED (SELECT $1::jsonb ctx,$2::integer[] ids),
candidates AS MATERIALIZED (SELECT DISTINCT unnest($2::integer[]) sid),
allowed_lists AS MATERIALIZED (
 SELECT DISTINCT v.list_id::integer list_id,
 EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ctx->'single_list_ids')='array' THEN ctx->'single_list_ids' ELSE '[]'::jsonb END) x WHERE x.value=to_jsonb(v.list_id::integer)) single
 FROM input CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(ctx->'list_ids')='array' THEN ctx->'list_ids' ELSE '[]'::jsonb END)v(list_id)
 WHERE ctx->'bound' IS DISTINCT FROM 'false'::jsonb
),
ab AS MATERIALIZED (
 SELECT (ctx->>'ab_test_id')::uuid test_id,ctx->>'ab_arm' arm,ctx ? 'ab_test_id' required,
 (ctx->>'base_list_id')::integer base_list_id FROM input WHERE ctx->'bound' IS DISTINCT FROM 'false'::jsonb
),
members AS MATERIALIZED (
 SELECT DISTINCT m.subscriber_id sid FROM public.crm_ab_member_v2 m JOIN ab a ON m.test_id=a.test_id AND m.arm=a.arm
 JOIN candidates c ON c.sid=m.subscriber_id WHERE m.revoked_at IS NULL
),
candidate_size AS MATERIALIZED (SELECT count(*) n FROM candidates),
small_consents AS MATERIALIZED (
 SELECT c.sid,array_agg(sl.list_id) consented FROM candidates c CROSS JOIN allowed_lists a
 CROSS JOIN candidate_size size
 CROSS JOIN LATERAL(SELECT sl.list_id FROM public.subscriber_lists sl
  WHERE sl.subscriber_id=c.sid AND sl.list_id=a.list_id
  AND(sl.status='confirmed' OR(sl.status='unconfirmed' AND a.single)) OFFSET 0)sl
 WHERE size.n<=4096 GROUP BY c.sid
),
bulk_list_ids AS MATERIALIZED (
 SELECT ARRAY(SELECT a.list_id FROM allowed_lists a) ids,
        ARRAY(SELECT a.list_id FROM allowed_lists a WHERE a.single) single_ids
),
bulk_consent_boundary AS MATERIALIZED (
 SELECT c.sid,sl.list_id,sl.status::text status
 FROM candidates c FULL JOIN (
  SELECT sl.subscriber_id,sl.list_id,sl.status
  FROM public.subscriber_lists sl CROSS JOIN bulk_list_ids lists CROSS JOIN candidate_size size
  WHERE size.n>4096 AND sl.list_id=ANY(lists.ids)
 ) sl ON sl.subscriber_id=c.sid
),
bulk_consents AS MATERIALIZED (
 SELECT b.sid,array_agg(b.list_id) consented
 FROM bulk_consent_boundary b CROSS JOIN bulk_list_ids lists CROSS JOIN candidate_size size
 WHERE size.n>4096 AND b.sid IS NOT NULL AND b.list_id IS NOT NULL
 AND(b.status='confirmed' OR(b.status='unconfirmed' AND b.list_id=ANY(lists.single_ids)))
 GROUP BY b.sid
),
consents AS MATERIALIZED (
 SELECT sid,consented FROM small_consents
 UNION ALL SELECT sid,consented FROM bulk_consents
),
small_native AS MATERIALIZED (
 SELECT c.sid,s.uuid,s.email,s.status::text status,coalesce(cs.consented,ARRAY[]::integer[]) consented,
 coalesce(NOT a.required OR m.sid IS NOT NULL,true) ab_allowed,a.base_list_id
 FROM candidates c LEFT JOIN public.subscribers s ON s.id=c.sid LEFT JOIN consents cs ON cs.sid=c.sid
 LEFT JOIN ab a ON true LEFT JOIN members m ON m.sid=c.sid CROSS JOIN candidate_size size
 WHERE size.n<=4096
),
bulk_subscriber_boundary AS MATERIALIZED (
 SELECT c.sid,s.uuid,s.email,s.status::text status
 FROM candidates c FULL JOIN (
  SELECT s.id,s.uuid,s.email,s.status FROM public.subscribers s CROSS JOIN candidate_size size WHERE size.n>4096
 ) s ON s.id=c.sid
),
bulk_native_consent_boundary AS MATERIALIZED (
 SELECT n.sid,n.uuid,n.email,n.status,coalesce(cs.consented,ARRAY[]::integer[]) consented
 FROM bulk_subscriber_boundary n FULL JOIN consents cs ON cs.sid=n.sid
),
bulk_native_member_boundary AS MATERIALIZED (
 SELECT n.*,m.sid member_sid FROM bulk_native_consent_boundary n FULL JOIN members m ON m.sid=n.sid
),
bulk_native AS MATERIALIZED (
 SELECT n.sid,n.uuid,n.email,n.status,n.consented,
 coalesce(NOT a.required OR n.member_sid IS NOT NULL,true) ab_allowed,a.base_list_id
 FROM bulk_native_member_boundary n LEFT JOIN ab a ON true CROSS JOIN candidate_size size
 WHERE size.n>4096 AND n.sid IS NOT NULL
),
native AS MATERIALIZED (
 SELECT * FROM small_native UNION ALL SELECT * FROM bulk_native
),
eligible AS MATERIALIZED (
 SELECT n.* FROM native n CROSS JOIN input i WHERE i.ctx->'bound' IS DISTINCT FROM 'false'::jsonb
 AND n.status='enabled' AND n.ab_allowed AND n.base_list_id=ANY(n.consented)
),
tree(path,node,depth) AS (
 SELECT ARRAY[]::integer[],ctx#>'{definition,rule}',1 FROM input
 WHERE ctx->'bound' IS DISTINCT FROM 'false'::jsonb AND EXISTS(SELECT 1 FROM eligible)
 UNION ALL
 SELECT t.path||v.ord::integer,v.child,t.depth+1 FROM tree t
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN t.node->>'op' IN('and','or')
 AND jsonb_typeof(t.node->'rules')='array' THEN t.node->'rules' ELSE '[]'::jsonb END)
 WITH ORDINALITY v(child,ord) WHERE t.depth<5
),
leaves AS MATERIALIZED (
 SELECT path,node,node->>'op' op,
 CASE WHEN node->>'op'='confirmed' THEN node->'rule' ELSE node END rule,
 CASE WHEN node->>'op'='confirmed' THEN node#>>'{rule,field}' ELSE node->>'field' END field
 FROM tree WHERE node->>'op' IS NULL OR node->>'op' NOT IN('and','or')
 -- Valid contexts have at most32 total nodes. Structural still checks the complete tree.
 -- The33rd leaf never hides overflow: it only bounds the planner's leaf projection.
 LIMIT 33
),
leaf_valid AS MATERIALIZED (
 SELECT l.*,CASE WHEN l.field IN('purchase.product','purchase.count','purchase.amount','purchase.last_date')
 THEN crm_audience_v2.shopify_rule_valid(l.rule) ELSE false END shop_valid,
 CASE WHEN l.field='signup.recorded_origin' THEN crm_audience_v2.recorded_origin_rule_valid(l.rule) ELSE false END origin_valid,
 coalesce(jsonb_typeof(l.rule)='object' AND l.rule->>'op'='condition'
 AND l.rule ?& ARRAY['op','field','operator','value'] AND l.rule-'op'-'field'-'operator'-'value'='{}'::jsonb
 AND jsonb_typeof(l.rule->'field')='string' AND jsonb_typeof(l.rule->'operator')='string'
 AND l.field IN('email.opened','email.clicked') AND l.rule->>'operator' IN('within_last_days','not_within_last_days')
 AND jsonb_typeof(l.rule->'value')='number' AND l.rule->>'value'~'^[1-9][0-9]{0,3}$'
 AND CASE WHEN l.rule->>'value'~'^[1-9][0-9]{0,3}$' THEN (l.rule->>'value')::numeric<=3650 ELSE false END
 AND i.ctx->>'brand' IN('fish','aristo'),false) engagement_valid
 FROM leaves l CROSS JOIN input i
),
structural AS MATERIALIZED (
 SELECT i.ctx IS NOT NULL AND i.ids IS NOT NULL AND cardinality(i.ids)<=1000000 AND NOT EXISTS(SELECT 1 FROM candidates WHERE sid IS NULL OR sid<1)
 AND (i.ctx->'bound'='false'::jsonb OR
  (jsonb_typeof(i.ctx)='object' AND i.ctx->'bound'='true'::jsonb AND i.ctx->>'brand' IN('fish','aristo')
  AND jsonb_typeof(i.ctx->'list_ids')='array' AND jsonb_typeof(i.ctx->'single_list_ids')='array'
  AND (SELECT count(*)+count(*) FILTER(WHERE node->>'op'='confirmed')<=32 AND coalesce(bool_and(depth+CASE WHEN node->>'op'='confirmed' THEN 1 ELSE 0 END<=4),true) FROM tree)
  AND NOT EXISTS(SELECT 1 FROM tree t WHERE t.node->>'op' IN('and','or') AND
   (t.node-'op'-'rules'<>'{}'::jsonb OR jsonb_typeof(t.node->'rules') IS DISTINCT FROM 'array'
    OR jsonb_array_length(t.node->'rules') NOT BETWEEN 1 AND 16)))) ok FROM input i
),
cfg_pre AS MATERIALIZED (
 SELECT s.*,crm_audience_v2.shopify_snapshot(s.brand) snapshot
 FROM crm_audience_v2.shopify_source s CROSS JOIN input i WHERE s.brand=i.ctx->>'brand'
 AND EXISTS(SELECT 1 FROM leaf_valid WHERE field IN('purchase.product','purchase.count','purchase.amount','purchase.last_date'))
),
source_pre AS MATERIALIZED (
 SELECT l.*,cfg.field_hashes->>l.field pin,
 coalesce(cfg.enabled AND cfg.field_hashes->>l.field IS NOT NULL
  AND cfg.snapshot->'current'='true'::jsonb,false) shop_available,
 CASE WHEN l.op='confirmed' AND l.shop_valid THEN
  crm_audience_v2.shopify_source_current(i.ctx->>'brand',l.field,cfg.field_hashes->>l.field)
 ELSE true END confirmed_available,
 (SELECT crm_audience_v2.recorded_origin_descriptor(s)->>'provenance_hash'
  FROM crm_audience_v2.recorded_origin_source s WHERE s.brand=i.ctx->>'brand'
  AND s.canonical_origin=l.rule->>'value' AND s.enabled) origin_pin
 FROM leaf_valid l CROSS JOIN input i LEFT JOIN cfg_pre cfg ON true
),
leaf_pre AS MATERIALIZED (
 SELECT p.*,CASE WHEN p.field='signup.recorded_origin' AND p.origin_valid THEN
  crm_audience_v2.recorded_origin_source_current(i.ctx->>'brand',p.rule->>'value',p.origin_pin)
 ELSE false END origin_available
 FROM source_pre p CROSS JOIN input i
),
small_subject_facts AS MATERIALIZED (
 SELECT e.*,f.customer_gid,f.orders_count,f.amount_spent,f.last_order_at,f.fact_cardinality
 FROM eligible e LEFT JOIN cfg_pre cfg ON true CROSS JOIN candidate_size size
 LEFT JOIN LATERAL(
  SELECT x.customer_gid,x.orders_count,x.amount_spent,x.last_order_at,count(*)OVER()fact_cardinality
  FROM crm_audience_v2.shopify_customer_fact x
  JOIN crm_audience_v2.shopify_identity ident ON ident.brand=x.brand AND ident.customer_gid=x.customer_gid
   AND ident.subscriber_id=x.subscriber_id AND ident.subscriber_uuid=x.subscriber_uuid
  WHERE x.brand=cfg.brand AND x.operation_id=cfg.current_operation AND x.subscriber_id=e.sid
   AND x.identity_state='resolved' AND x.subscriber_uuid=e.uuid AND x.email=lower(btrim(e.email))
  OFFSET 0
 )f ON true WHERE size.n<=4096
),
bulk_fact_rows AS MATERIALIZED (
 SELECT x.brand,x.customer_gid,x.subscriber_id,x.subscriber_uuid,x.email,x.orders_count,x.amount_spent,x.last_order_at
 FROM crm_audience_v2.shopify_customer_fact x CROSS JOIN cfg_pre cfg CROSS JOIN candidate_size size
 WHERE size.n>4096 AND x.brand=cfg.brand AND x.operation_id=cfg.current_operation AND x.identity_state='resolved'
),
bulk_identity_rows AS MATERIALIZED (
 SELECT ident.brand,ident.customer_gid,ident.subscriber_id,ident.subscriber_uuid
 FROM crm_audience_v2.shopify_identity ident CROSS JOIN cfg_pre cfg CROSS JOIN candidate_size size
 WHERE size.n>4096 AND ident.brand=cfg.brand
),
bulk_fact_identity_boundary AS MATERIALIZED (
 SELECT x.*,ident.customer_gid identity_gid
 FROM bulk_fact_rows x FULL JOIN bulk_identity_rows ident
 ON ident.brand=x.brand AND ident.customer_gid=x.customer_gid
 AND ident.subscriber_id=x.subscriber_id AND ident.subscriber_uuid=x.subscriber_uuid
),
bulk_valid_facts AS MATERIALIZED (
 SELECT brand,customer_gid,subscriber_id,subscriber_uuid,email,orders_count,amount_spent,last_order_at
 FROM bulk_fact_identity_boundary WHERE customer_gid IS NOT NULL AND identity_gid IS NOT NULL
),
bulk_subject_boundary AS MATERIALIZED (
 SELECT e.*,x.customer_gid,x.orders_count,x.amount_spent,x.last_order_at,
 CASE WHEN x.customer_gid IS NOT NULL THEN count(x.customer_gid)OVER(PARTITION BY e.sid) END fact_cardinality
 FROM eligible e FULL JOIN bulk_valid_facts x
 ON x.subscriber_id=e.sid AND x.subscriber_uuid=e.uuid AND x.email=lower(btrim(e.email))
),
subject_facts AS MATERIALIZED (
 SELECT * FROM small_subject_facts
 UNION ALL
 SELECT b.* FROM bulk_subject_boundary b CROSS JOIN candidate_size size WHERE size.n>4096 AND b.sid IS NOT NULL
),
product_scope AS MATERIALIZED (
 SELECT p.brand,p.operation_id,p.customer_gid,p.products,p.history_complete
 FROM crm_audience_v2.shopify_customer_product p JOIN cfg_pre cfg
 ON p.brand=cfg.brand AND p.operation_id=cfg.current_operation
 WHERE EXISTS(SELECT 1 FROM leaf_pre WHERE field='purchase.product')
),
product_batch_scope AS MATERIALIZED (
 SELECT batch.brand,batch.operation_id,batch.ready
 FROM crm_audience_v2.shopify_product_batch batch JOIN cfg_pre cfg
 ON batch.brand=cfg.brand AND batch.operation_id=cfg.current_operation
 WHERE batch.ready AND EXISTS(SELECT 1 FROM leaf_pre WHERE field='purchase.product')
),
product_gap_scope AS MATERIALIZED (
 SELECT gap.brand,gap.operation_id,gap.customer_gid
 FROM crm_audience_v2.shopify_product_history_gap gap JOIN cfg_pre cfg
 ON gap.brand=cfg.brand AND gap.operation_id=cfg.current_operation
 WHERE EXISTS(SELECT 1 FROM leaf_pre WHERE field='purchase.product')
),
subjects AS MATERIALIZED (
 SELECT f.*,
  coalesce(batch.ready AND p.customer_gid IS NOT NULL,false) product_present,
  CASE WHEN batch.ready THEN p.products END products,
  CASE WHEN batch.ready THEN p.history_complete END history_complete,
  gap.customer_gid IS NOT NULL product_gap
 FROM subject_facts f LEFT JOIN cfg_pre cfg ON true
 LEFT JOIN product_scope p ON p.brand=cfg.brand AND p.operation_id=cfg.current_operation
  AND p.customer_gid=f.customer_gid AND EXISTS(SELECT 1 FROM leaf_pre WHERE field='purchase.product')
 LEFT JOIN product_batch_scope batch ON batch.brand=p.brand AND batch.operation_id=p.operation_id AND batch.ready
 LEFT JOIN product_gap_scope gap ON gap.brand=p.brand AND gap.operation_id=p.operation_id AND gap.customer_gid=p.customer_gid
),
product_hits AS MATERIALIZED (
 SELECT DISTINCT p.sid,l.path FROM subjects p CROSS JOIN LATERAL jsonb_array_elements(p.products) item
 JOIN leaf_pre l ON l.field='purchase.product' AND l.shop_valid AND item->>'id'=l.rule->>'value'
),
origin_sources AS MATERIALIZED (
 SELECT l.path,src.*,crm_audience_v2.recorded_origin_descriptor(src)->>'provenance_hash' pin
 FROM leaf_pre l CROSS JOIN input i JOIN crm_audience_v2.recorded_origin_source src
 ON src.brand=i.ctx->>'brand' AND src.canonical_origin=l.rule->>'value' AND src.enabled
 WHERE l.field='signup.recorded_origin'
),
origin_hits AS MATERIALIZED (
 SELECT DISTINCT e.sid,l.path FROM eligible e JOIN crm_audience_v2.recorded_origin_receipt r ON r.subscriber_id=e.sid AND r.subscriber_uuid=e.uuid
 JOIN origin_sources src ON src.scope_id=r.scope_id AND src.producer_id=r.producer_id
 JOIN leaf_pre l ON l.path=src.path AND src.pin=l.origin_pin AND l.origin_available
 WHERE r.accepted_at>=src.coverage_started_at AND r.accepted_at<=statement_timestamp()
),
engagement_bounds AS MATERIALIZED (
 SELECT field,max(CASE WHEN engagement_valid THEN(rule->>'value')::integer END) days
 FROM leaf_pre WHERE engagement_valid GROUP BY field
),
small_events AS MATERIALIZED (
 SELECT original.* FROM (
 SELECT e.sid,'email.opened'::text field,v.created_at FROM eligible e
 JOIN public.campaign_views v ON v.subscriber_id=e.sid JOIN public.campaigns c ON c.id=v.campaign_id CROSS JOIN input i
 JOIN engagement_bounds bounds ON bounds.field='email.opened'
 WHERE v.created_at>=statement_timestamp()-(bounds.days::double precision*86400*interval '1 second')
 AND v.created_at<=statement_timestamp()
 AND c.attribs#>>'{crm,policy}'='crm-campaign-v1' AND c.attribs#>>'{crm,brand}'=i.ctx->>'brand'
 AND c.messenger::text='email' AND c.type::text='regular'
 UNION ALL
 SELECT e.sid,'email.clicked'::text,v.created_at FROM eligible e
 JOIN public.link_clicks v ON v.subscriber_id=e.sid JOIN public.campaigns c ON c.id=v.campaign_id CROSS JOIN input i
 JOIN engagement_bounds bounds ON bounds.field='email.clicked'
 WHERE v.created_at>=statement_timestamp()-(bounds.days::double precision*86400*interval '1 second')
 AND v.created_at<=statement_timestamp()
 AND c.attribs#>>'{crm,policy}'='crm-campaign-v1' AND c.attribs#>>'{crm,brand}'=i.ctx->>'brand'
 AND c.messenger::text='email' AND c.type::text='regular'
 ) original CROSS JOIN candidate_size size WHERE size.n<=4096
),
bulk_event_source AS MATERIALIZED (
 SELECT filtered.* FROM (
 SELECT v.subscriber_id AS sid,'email.opened'::text field,v.created_at FROM public.campaign_views v JOIN public.campaigns c ON c.id=v.campaign_id CROSS JOIN input i
 JOIN engagement_bounds bounds ON bounds.field='email.opened'
 WHERE v.created_at>=statement_timestamp()-(bounds.days::double precision*86400*interval '1 second')
 AND v.created_at<=statement_timestamp()
 AND c.attribs#>>'{crm,policy}'='crm-campaign-v1' AND c.attribs#>>'{crm,brand}'=i.ctx->>'brand'
 AND c.messenger::text='email' AND c.type::text='regular'
 UNION ALL
 SELECT v.subscriber_id AS sid,'email.clicked'::text,v.created_at FROM public.link_clicks v JOIN public.campaigns c ON c.id=v.campaign_id CROSS JOIN input i
 JOIN engagement_bounds bounds ON bounds.field='email.clicked'
 WHERE v.created_at>=statement_timestamp()-(bounds.days::double precision*86400*interval '1 second')
 AND v.created_at<=statement_timestamp()
 AND c.attribs#>>'{crm,policy}'='crm-campaign-v1' AND c.attribs#>>'{crm,brand}'=i.ctx->>'brand'
 AND c.messenger::text='email' AND c.type::text='regular'
 ) filtered CROSS JOIN candidate_size size WHERE size.n>4096
),
bulk_event_boundary AS MATERIALIZED (
 SELECT e.sid AS candidate_sid,v.sid AS event_sid,v.field,v.created_at
 FROM eligible e FULL JOIN bulk_event_source v ON v.sid=e.sid
),
events AS MATERIALIZED (
 SELECT sid,field,created_at FROM small_events
 UNION ALL
 SELECT b.candidate_sid AS sid,b.field,b.created_at
 FROM bulk_event_boundary b CROSS JOIN candidate_size size
 WHERE size.n>4096 AND b.candidate_sid IS NOT NULL AND b.event_sid IS NOT NULL
),
event_lasts AS MATERIALIZED (
 SELECT sid,field,max(created_at)FILTER(WHERE created_at<=statement_timestamp())last_at FROM events GROUP BY sid,field
),
event_hits AS MATERIALIZED (
 SELECT ev.sid,l.path FROM event_lasts ev JOIN leaf_pre l ON l.field=ev.field AND l.engagement_valid
 WHERE ev.last_at>=statement_timestamp()-((l.rule->>'value')::integer::double precision*86400*interval '1 second')
),
small_raw_matches AS MATERIALIZED (
 SELECT e.sid,l.path,l.op leaf_op,
 CASE
 WHEN l.op='in_list' THEN (l.rule->>'list_id')::integer=ANY(e.consented)
 WHEN l.field IN('email.opened','email.clicked') THEN CASE WHEN l.engagement_valid THEN
 CASE WHEN l.rule->>'operator'='within_last_days' THEN (e.sid,l.path) IN(SELECT sid,path FROM event_hits) ELSE (e.sid,l.path) NOT IN(SELECT sid,path FROM event_hits) END END
 WHEN l.field='signup.recorded_origin' THEN CASE WHEN l.origin_valid AND l.origin_available AND e.uuid IS NOT NULL THEN (e.sid,l.path) IN(SELECT sid,path FROM origin_hits) END
 WHEN l.field IN('purchase.product','purchase.count','purchase.amount','purchase.last_date') THEN
  CASE WHEN NOT l.shop_valid OR NOT l.shop_available OR e.customer_gid IS NULL THEN NULL
  WHEN l.field='purchase.product' THEN CASE WHEN NOT e.product_present THEN NULL
   WHEN (e.sid,l.path) IN(SELECT sid,path FROM product_hits) THEN l.rule->>'operator'='purchased'
   WHEN NOT e.history_complete OR (e.orders_count=0 AND(e.last_order_at IS NOT NULL OR e.amount_spent>0)) OR e.product_gap THEN NULL
   ELSE l.rule->>'operator'='not_purchased' END
  WHEN e.orders_count=0 AND(e.last_order_at IS NOT NULL OR e.amount_spent>0) THEN NULL
  WHEN l.field='purchase.last_date' THEN CASE WHEN e.last_order_at IS NULL THEN CASE WHEN e.orders_count=0 THEN false END
   ELSE CASE l.rule->>'operator'
    WHEN 'eq' THEN (e.last_order_at AT TIME ZONE cfg.timezone)::date=(l.rule->>'value')::date
    WHEN 'before' THEN (e.last_order_at AT TIME ZONE cfg.timezone)::date<(l.rule->>'value')::date
    WHEN 'on_or_before' THEN (e.last_order_at AT TIME ZONE cfg.timezone)::date<=(l.rule->>'value')::date
    WHEN 'after' THEN (e.last_order_at AT TIME ZONE cfg.timezone)::date>(l.rule->>'value')::date
    WHEN 'on_or_after' THEN (e.last_order_at AT TIME ZONE cfg.timezone)::date>=(l.rule->>'value')::date END END
  ELSE CASE l.rule->>'operator'
   WHEN 'eq' THEN (CASE l.field WHEN 'purchase.count' THEN e.orders_count ELSE e.amount_spent END)=(l.rule->>'value')::numeric
   WHEN 'gt' THEN (CASE l.field WHEN 'purchase.count' THEN e.orders_count ELSE e.amount_spent END)>(l.rule->>'value')::numeric
   WHEN 'gte' THEN (CASE l.field WHEN 'purchase.count' THEN e.orders_count ELSE e.amount_spent END)>=(l.rule->>'value')::numeric
   WHEN 'lt' THEN (CASE l.field WHEN 'purchase.count' THEN e.orders_count ELSE e.amount_spent END)<(l.rule->>'value')::numeric
   WHEN 'lte' THEN (CASE l.field WHEN 'purchase.count' THEN e.orders_count ELSE e.amount_spent END)<=(l.rule->>'value')::numeric END END
 END value,
 coalesce(l.op NOT IN('in_list','condition','confirmed') OR l.op IS NULL
  OR (l.op='confirmed' AND(l.node-'op'-'rule'<>'{}'::jsonb OR NOT(l.node?&ARRAY['op','rule']) OR NOT l.shop_valid OR NOT l.confirmed_available))
  OR (l.op='condition' AND l.field NOT IN('purchase.product','purchase.count','purchase.amount','purchase.last_date','signup.recorded_origin') AND NOT l.engagement_valid),true) fatal
 FROM subjects e CROSS JOIN leaf_pre l CROSS JOIN input i LEFT JOIN cfg_pre cfg ON true CROSS JOIN candidate_size size WHERE size.n<=4096
),
bulk_hit_demand AS MATERIALIZED (
 SELECT 'event'::text hit_kind WHERE EXISTS(
  SELECT 1 FROM subjects e CROSS JOIN leaf_pre l CROSS JOIN candidate_size size
  WHERE size.n>4096 AND l.op IS DISTINCT FROM 'in_list'
   AND l.field IN('email.opened','email.clicked') AND l.engagement_valid IS TRUE)
 UNION ALL
 SELECT 'origin'::text WHERE EXISTS(
  SELECT 1 FROM subjects e CROSS JOIN leaf_pre l CROSS JOIN candidate_size size
  WHERE size.n>4096 AND l.op IS DISTINCT FROM 'in_list' AND l.field='signup.recorded_origin'
   AND (l.origin_valid AND l.origin_available AND e.uuid IS NOT NULL) IS TRUE)
 UNION ALL
 SELECT 'product'::text WHERE EXISTS(
  SELECT 1 FROM subjects e CROSS JOIN leaf_pre l CROSS JOIN candidate_size size
  WHERE size.n>4096 AND l.op IS DISTINCT FROM 'in_list' AND l.field='purchase.product'
   AND (NOT l.shop_valid OR NOT l.shop_available OR e.customer_gid IS NULL) IS NOT TRUE
   AND (NOT e.product_present) IS NOT TRUE)
),
bulk_hit_keys AS MATERIALIZED (
 SELECT DISTINCT h.sid,h.path,'event'::text hit_kind,true hit_present
 FROM bulk_hit_demand demand CROSS JOIN LATERAL(
  SELECT sid,path FROM event_hits WHERE demand.hit_kind='event' OFFSET 0
 )h WHERE demand.hit_kind='event'
 UNION ALL
 SELECT DISTINCT h.sid,h.path,'origin'::text,true
 FROM bulk_hit_demand demand CROSS JOIN LATERAL(
  SELECT sid,path FROM origin_hits WHERE demand.hit_kind='origin' OFFSET 0
 )h WHERE demand.hit_kind='origin'
 UNION ALL
 SELECT DISTINCT h.sid,h.path,'product'::text,true
 FROM bulk_hit_demand demand CROSS JOIN LATERAL(
  SELECT sid,path FROM product_hits WHERE demand.hit_kind='product' OFFSET 0
 )h WHERE demand.hit_kind='product'
),
bulk_hit_integrity AS MATERIALIZED (
 SELECT coalesce(bool_and(sid IS NOT NULL AND path IS NOT NULL),true)ok FROM bulk_hit_keys
),
bulk_raw_boundary AS MATERIALIZED (
 SELECT e.sid,l.path,l.op leaf_op,
 CASE
 WHEN l.op='in_list' THEN (l.rule->>'list_id')::integer=ANY(e.consented)
 WHEN l.field IN('email.opened','email.clicked') THEN CASE WHEN l.engagement_valid THEN
 CASE WHEN l.rule->>'operator'='within_last_days' THEN (h.hit_present IS TRUE) ELSE (h.hit_present IS NOT TRUE) END END
 WHEN l.field='signup.recorded_origin' THEN CASE WHEN l.origin_valid AND l.origin_available AND e.uuid IS NOT NULL THEN (h.hit_present IS TRUE) END
 WHEN l.field IN('purchase.product','purchase.count','purchase.amount','purchase.last_date') THEN
  CASE WHEN NOT l.shop_valid OR NOT l.shop_available OR e.customer_gid IS NULL THEN NULL
  WHEN l.field='purchase.product' THEN CASE WHEN NOT e.product_present THEN NULL
   WHEN (h.hit_present IS TRUE) THEN l.rule->>'operator'='purchased'
   WHEN NOT e.history_complete OR (e.orders_count=0 AND(e.last_order_at IS NOT NULL OR e.amount_spent>0)) OR e.product_gap THEN NULL
   ELSE l.rule->>'operator'='not_purchased' END
  WHEN e.orders_count=0 AND(e.last_order_at IS NOT NULL OR e.amount_spent>0) THEN NULL
  WHEN l.field='purchase.last_date' THEN CASE WHEN e.last_order_at IS NULL THEN CASE WHEN e.orders_count=0 THEN false END
   ELSE CASE l.rule->>'operator'
    WHEN 'eq' THEN (e.last_order_at AT TIME ZONE cfg.timezone)::date=(l.rule->>'value')::date
    WHEN 'before' THEN (e.last_order_at AT TIME ZONE cfg.timezone)::date<(l.rule->>'value')::date
    WHEN 'on_or_before' THEN (e.last_order_at AT TIME ZONE cfg.timezone)::date<=(l.rule->>'value')::date
    WHEN 'after' THEN (e.last_order_at AT TIME ZONE cfg.timezone)::date>(l.rule->>'value')::date
    WHEN 'on_or_after' THEN (e.last_order_at AT TIME ZONE cfg.timezone)::date>=(l.rule->>'value')::date END END
  ELSE CASE l.rule->>'operator'
   WHEN 'eq' THEN (CASE l.field WHEN 'purchase.count' THEN e.orders_count ELSE e.amount_spent END)=(l.rule->>'value')::numeric
   WHEN 'gt' THEN (CASE l.field WHEN 'purchase.count' THEN e.orders_count ELSE e.amount_spent END)>(l.rule->>'value')::numeric
   WHEN 'gte' THEN (CASE l.field WHEN 'purchase.count' THEN e.orders_count ELSE e.amount_spent END)>=(l.rule->>'value')::numeric
   WHEN 'lt' THEN (CASE l.field WHEN 'purchase.count' THEN e.orders_count ELSE e.amount_spent END)<(l.rule->>'value')::numeric
   WHEN 'lte' THEN (CASE l.field WHEN 'purchase.count' THEN e.orders_count ELSE e.amount_spent END)<=(l.rule->>'value')::numeric END END
 END value,
 coalesce(l.op NOT IN('in_list','condition','confirmed') OR l.op IS NULL
  OR (l.op='confirmed' AND(l.node-'op'-'rule'<>'{}'::jsonb OR NOT(l.node?&ARRAY['op','rule']) OR NOT l.shop_valid OR NOT l.confirmed_available))
  OR (l.op='condition' AND l.field NOT IN('purchase.product','purchase.count','purchase.amount','purchase.last_date','signup.recorded_origin') AND NOT l.engagement_valid),true) fatal
,
 e.sid IS NOT NULL AND l.path IS NOT NULL raw_present
 FROM (subjects e CROSS JOIN leaf_pre l CROSS JOIN input i LEFT JOIN cfg_pre cfg ON true
 CROSS JOIN (SELECT n FROM candidate_size WHERE n>4096) size)
 FULL JOIN bulk_hit_keys h ON h.sid=e.sid AND h.path=l.path AND h.hit_kind=
 CASE WHEN l.op='in_list' THEN NULL WHEN l.field IN('email.opened','email.clicked') THEN 'event'
 WHEN l.field='signup.recorded_origin' THEN 'origin' WHEN l.field='purchase.product' THEN 'product' END
),
raw_matches AS MATERIALIZED (
 SELECT sid,path,leaf_op,value,fatal FROM small_raw_matches
 UNION ALL
 SELECT b.sid,b.path,b.leaf_op,
 CASE WHEN integrity.ok IS DISTINCT FROM true THEN crm_audience_v2.selection_regular_matches(NULL::jsonb,NULL::integer) ELSE b.value END value,b.fatal
 FROM bulk_raw_boundary b CROSS JOIN candidate_size size CROSS JOIN bulk_hit_integrity integrity
 WHERE size.n>4096 AND b.raw_present
),
leaf_matches AS MATERIALIZED (
 SELECT r.sid,r.path,CASE WHEN r.leaf_op='confirmed' THEN coalesce(r.value,false) ELSE r.value END value,r.fatal
 FROM raw_matches r
),
branch_children AS MATERIALIZED (
 SELECT t.path,t.depth,t.node->>'op' op,t.path||v.n::integer child FROM tree t
 CROSS JOIN LATERAL jsonb_array_elements(t.node->'rules') WITH ORDINALITY v(node,n)
 WHERE t.node->>'op' IN('and','or')
),
children_3 AS MATERIALIZED (SELECT sid,path,value FROM leaf_matches WHERE cardinality(path)=3),
branches_3 AS MATERIALIZED (
 SELECT m.sid,b.path,CASE WHEN b.op='and' THEN CASE
  WHEN bool_or(m.value IS FALSE) THEN false WHEN bool_or(m.value IS NULL) THEN NULL ELSE true END
  ELSE CASE WHEN bool_or(m.value IS TRUE) THEN true WHEN bool_or(m.value IS NULL) THEN NULL ELSE false END END value
 FROM branch_children b JOIN children_3 m ON m.path=b.child WHERE b.depth=3 GROUP BY m.sid,b.path,b.op
),
children_2 AS MATERIALIZED (SELECT sid,path,value FROM leaf_matches WHERE cardinality(path)=2 UNION ALL SELECT sid,path,value FROM branches_3),
branches_2 AS MATERIALIZED (
 SELECT m.sid,b.path,CASE WHEN b.op='and' THEN CASE
  WHEN bool_or(m.value IS FALSE) THEN false WHEN bool_or(m.value IS NULL) THEN NULL ELSE true END
  ELSE CASE WHEN bool_or(m.value IS TRUE) THEN true WHEN bool_or(m.value IS NULL) THEN NULL ELSE false END END value
 FROM branch_children b JOIN children_2 m ON m.path=b.child WHERE b.depth=2 GROUP BY m.sid,b.path,b.op
),
children_1 AS MATERIALIZED (SELECT sid,path,value FROM leaf_matches WHERE cardinality(path)=1 UNION ALL SELECT sid,path,value FROM branches_2),
branches_1 AS MATERIALIZED (
 SELECT m.sid,b.path,CASE WHEN b.op='and' THEN CASE
  WHEN bool_or(m.value IS FALSE) THEN false WHEN bool_or(m.value IS NULL) THEN NULL ELSE true END
  ELSE CASE WHEN bool_or(m.value IS TRUE) THEN true WHEN bool_or(m.value IS NULL) THEN NULL ELSE false END END value
 FROM branch_children b JOIN children_1 m ON m.path=b.child WHERE b.depth=1 GROUP BY m.sid,b.path,b.op
),
roots AS MATERIALIZED (SELECT sid,value matched FROM leaf_matches WHERE path=ARRAY[]::integer[] UNION ALL SELECT sid,value FROM branches_1),
completed AS MATERIALIZED (
 SELECT (SELECT count(*) FROM roots) n,(SELECT count(*)FILTER(WHERE value IS NULL) FROM leaf_matches) nulls,
 EXISTS(SELECT 1 FROM leaf_matches WHERE fatal) fatal,
 (EXISTS(SELECT 1 FROM subjects WHERE fact_cardinality>1) OR EXISTS(SELECT sid FROM roots GROUP BY sid HAVING count(*)>1)) ambiguous
),
cfg_post AS MATERIALIZED (
 SELECT cfg.brand,crm_audience_v2.shopify_snapshot(cfg.brand) snapshot
 FROM cfg_pre cfg CROSS JOIN completed d WHERE d.n>=0
),
source_post AS MATERIALIZED (
 SELECT l.path,
 coalesce(cfg.enabled AND cfg.field_hashes->>l.field IS NOT NULL AND cp.snapshot->'current'='true'::jsonb,false) shop_available,
 CASE WHEN l.op='confirmed' AND l.shop_valid THEN crm_audience_v2.shopify_source_current(i.ctx->>'brand',l.field,l.pin) ELSE true END confirmed_available,
 CASE WHEN l.field='signup.recorded_origin' AND l.origin_valid THEN
  crm_audience_v2.recorded_origin_source_current(i.ctx->>'brand',l.rule->>'value',l.origin_pin) ELSE false END origin_available
 FROM leaf_pre l CROSS JOIN input i CROSS JOIN completed d LEFT JOIN cfg_pre cfg ON true LEFT JOIN cfg_post cp ON true WHERE d.n>=0
),
final_gate AS MATERIALIZED (
 SELECT s.ok AND NOT d.fatal AND NOT d.ambiguous AND NOT EXISTS(
 SELECT 1 FROM leaf_pre pre JOIN source_post post USING(path) WHERE
 pre.shop_available IS DISTINCT FROM post.shop_available
 OR pre.confirmed_available IS DISTINCT FROM post.confirmed_available OR pre.origin_available IS DISTINCT FROM post.origin_available
 OR (pre.op='confirmed' AND NOT post.confirmed_available)) ok FROM structural s CROSS JOIN completed d
)
SELECT c.sid,CASE
 WHEN g.ok IS DISTINCT FROM true THEN crm_audience_v2.selection_regular_matches(NULL::jsonb,NULL::integer)
 WHEN i.ctx->'bound'='false'::jsonb THEN true
 WHEN c.sid NOT IN(SELECT sid FROM eligible) THEN false
 WHEN c.sid IN(SELECT sid FROM roots WHERE matched IS TRUE) THEN true
 WHEN c.sid IN(SELECT sid FROM roots WHERE matched IS FALSE) THEN false
 ELSE crm_audience_v2.selection_regular_matches(NULL::jsonb,NULL::integer) END matched
FROM candidates c CROSS JOIN input i CROSS JOIN final_gate g ORDER BY c.sid;
