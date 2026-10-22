-- campaigns
-- name: create-campaign
-- This creates the campaign and inserts campaign_lists relationships.
WITH tpl AS (
    -- Select the template for the given template ID or use the default template.
    SELECT
        -- If the template is a visual template, then use it's HTML body as the campaign
        -- body and its block source as the campaign's block source,
        -- and don't set a template_id in the campaigns table, as it's essentially an
        -- HTML template body "import" during creation.
        (CASE WHEN type = 'campaign_visual' THEN NULL ELSE id END) AS id,
        (CASE WHEN type = 'campaign_visual' THEN body ELSE '' END) AS body,
        (CASE WHEN type = 'campaign_visual' THEN body_source ELSE NULL END) AS body_source,
        (CASE WHEN type = 'campaign_visual' THEN 'visual' ELSE 'richtext' END) AS content_type
    FROM templates
    WHERE
        CASE
            -- If a template ID is present, use it. If not, use the default template only if
            -- it's not a visual template.
            WHEN $14::INT IS NOT NULL THEN id = $14::INT
            ELSE $8 != 'visual' AND is_default = TRUE
        END
    LIMIT 1
),
camp AS (
    INSERT INTO campaigns (uuid, type, name, subject, from_email, body, altbody,
        content_type, send_at, headers, attribs, tags, messenger, template_id, to_send,
        max_subscriber_id, archive, archive_slug, archive_template_id, archive_meta, body_source)
        SELECT $1, $2, $3, $4, $5,
            -- body
            COALESCE(NULLIF($6, ''), (SELECT body FROM tpl), ''),
            $7,
            $8::content_type,
            $9, $10, $11, $12, $13,
            (SELECT id FROM tpl),
            0,
            0,
            $16, $17,
            -- archive_template_id
            $18,
            $19,
            -- body_source
            COALESCE($21, (SELECT body_source FROM tpl))
        RETURNING id
),
med AS (
    INSERT INTO campaign_media (campaign_id, media_id, filename)
        (SELECT (SELECT id FROM camp), id, filename FROM media WHERE id=ANY($20::INT[]))
),
insLists AS (
    INSERT INTO campaign_lists (campaign_id, list_id, list_name)
        SELECT (SELECT id FROM camp), id, name FROM lists WHERE id=ANY($15::INT[])
)
SELECT id FROM camp;

-- name: query-campaigns
-- Here, 'lists' is returned as an aggregated JSON array from campaign_lists because
-- the list reference may have been deleted.
-- While the results are sliced using offset+limit,
-- there's a COUNT() OVER() that still returns the total result count
-- for pagination in the frontend, albeit being a field that'll repeat
-- with every resultant row.
SELECT  c.*,
        COUNT(*) OVER () AS total,
        (
            SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG(l)), '[]') FROM (
                SELECT COALESCE(campaign_lists.list_id, 0) AS id,
                campaign_lists.list_name AS name
                FROM campaign_lists WHERE campaign_lists.campaign_id = c.id
        ) l
    ) AS lists
FROM campaigns c
WHERE ($1 = 0 OR id = $1)
    AND (CARDINALITY($2::campaign_status[]) = 0 OR status = ANY($2))
    AND (CARDINALITY($3::VARCHAR(100)[]) = 0 OR $3 <@ tags)
    AND ($4 = '' OR TO_TSVECTOR(CONCAT(name, ' ', subject)) @@ TO_TSQUERY($4) OR CONCAT(c.name, ' ', c.subject) ILIKE $4)
    -- Get all campaigns or filter by list IDs.
    AND (
        $5 OR EXISTS (
            SELECT 1 FROM campaign_lists WHERE campaign_id = c.id AND list_id = ANY($6::INT[])
        )
    )
ORDER BY %order% OFFSET $7 LIMIT (CASE WHEN $8 < 1 THEN NULL ELSE $8 END);

-- name: get-campaign
SELECT campaigns.*,
    COALESCE(templates.body, (SELECT body FROM templates WHERE is_default = true LIMIT 1), '') AS template_body
    FROM campaigns
    LEFT JOIN templates ON (
        CASE WHEN $4 = 'default' THEN templates.id = campaigns.template_id
        ELSE templates.id = campaigns.archive_template_id END
    )
    WHERE CASE
            WHEN $1 > 0 THEN campaigns.id = $1
            WHEN $3 != '' THEN campaigns.archive_slug = $3
            ELSE uuid = $2
          END;

-- name: get-archived-campaigns
SELECT COUNT(*) OVER () AS total, campaigns.*,
    COALESCE(templates.body, (SELECT body FROM templates WHERE is_default = true LIMIT 1), '') AS template_body
    FROM campaigns
    LEFT JOIN templates ON (
        CASE WHEN $3 = 'default' THEN templates.id = campaigns.template_id
        ELSE templates.id = campaigns.archive_template_id END
    )
    WHERE campaigns.archive=true AND campaigns.type='regular' AND campaigns.status=ANY('{running, paused, finished}')
    ORDER by campaigns.created_at DESC OFFSET $1 LIMIT $2;

-- name: get-campaign-stats
-- This query is used to lazy load campaign stats (views, counts, list of lists) given a list of campaign IDs.
-- The query returns results in the same order as the given campaign IDs, and for non-existent campaign IDs,
-- the query still returns a row with 0 values. Thus, for lazy loading, the application simply iterate on the results in
-- the same order as the list of campaigns it would've queried and attach the results.
WITH lists AS (
    SELECT campaign_id, JSON_AGG(JSON_BUILD_OBJECT('id', list_id, 'name', list_name)) AS lists FROM campaign_lists
    WHERE campaign_id = ANY($1) GROUP BY campaign_id
),
media AS (
    SELECT campaign_id, JSON_AGG(JSON_BUILD_OBJECT('id', media_id, 'filename', filename)) AS media FROM campaign_media
    WHERE campaign_id = ANY($1) GROUP BY campaign_id
),
views AS (
    SELECT campaign_id, COUNT(campaign_id) as num FROM campaign_views
    WHERE campaign_id = ANY($1)
    GROUP BY campaign_id
),
clicks AS (
    SELECT campaign_id, COUNT(campaign_id) as num FROM link_clicks
    WHERE campaign_id = ANY($1)
    GROUP BY campaign_id
),
bounces AS (
    SELECT campaign_id, COUNT(campaign_id) as num FROM bounces
    WHERE campaign_id = ANY($1)
    GROUP BY campaign_id
)
SELECT id as campaign_id,
    COALESCE(v.num, 0) AS views,
    COALESCE(c.num, 0) AS clicks,
    COALESCE(b.num, 0) AS bounces,
    COALESCE(l.lists, '[]') AS lists,
    COALESCE(m.media, '[]') AS media
FROM (SELECT id FROM UNNEST($1) AS id) x
LEFT JOIN lists AS l ON (l.campaign_id = id)
LEFT JOIN media AS m ON (m.campaign_id = id)
LEFT JOIN views AS v ON (v.campaign_id = id)
LEFT JOIN clicks AS c ON (c.campaign_id = id)
LEFT JOIN bounces AS b ON (b.campaign_id = id)
ORDER BY ARRAY_POSITION($1, id);

-- name: get-campaign-for-preview
SELECT campaigns.*, COALESCE(templates.body, '') AS template_body,
(
	SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG(l)), '[]') FROM (
		SELECT COALESCE(campaign_lists.list_id, 0) AS id,
        campaign_lists.list_name AS name
        FROM campaign_lists WHERE campaign_lists.campaign_id = campaigns.id
	) l
) AS lists
FROM campaigns
LEFT JOIN templates ON (templates.id = (CASE WHEN $2=0 THEN campaigns.template_id ELSE $2 END))
WHERE campaigns.id = $1;

-- name: get-campaign-status
SELECT id, status, to_send, sent, started_at, updated_at FROM campaigns WHERE status=$1;

-- name: campaign-has-lists
-- Returns TRUE if the campaign $1 has any of the lists given in $2.
SELECT EXISTS (
    SELECT TRUE FROM campaign_lists WHERE campaign_id = $1 AND list_id = ANY($2::INT[])
);

-- name: next-campaigns
-- Retreives campaigns that are running (or scheduled and the time's up) and need
-- to be processed. It updates the to_send count and max_subscriber_id of the campaign,
-- that is, the total number of subscribers to be processed across all lists of a campaign.
-- Thus, it has a sideaffect.
-- In addition, it finds the max_subscriber_id, the upper limit across all lists of
-- a campaign. This is used to fetch and slice subscribers for the campaign in next-campaign-subscribers.
WITH eligibleCamps AS MATERIALIZED (
    -- Get all running campaigns and their template bodies (if the template's deleted, the default template body instead)
    SELECT campaigns.*, COALESCE(templates.body, (SELECT body FROM templates WHERE is_default = true LIMIT 1), '') AS template_body
    FROM campaigns
    LEFT JOIN templates ON (templates.id = campaigns.template_id)
    WHERE (status='running' OR (status='scheduled' AND NOW() >= campaigns.send_at))
    AND NOT(campaigns.id = ANY($1::INT[]))
),
audienceContexts AS MATERIALIZED (
    SELECT id, crm_audience_v2.selection_worker_context(id) AS context FROM eligibleCamps
),
camps AS MATERIALIZED (
    SELECT eligibleCamps.* FROM eligibleCamps JOIN audienceContexts USING (id) WHERE context IS NOT NULL
    ORDER BY eligibleCamps.send_at ASC NULLS FIRST,eligibleCamps.id ASC LIMIT 1
),
campLists AS (
    -- Get the list_ids and their optin statuses for the campaigns found in the previous step.
    SELECT lists.id AS list_id, campaign_id, optin FROM lists
    INNER JOIN campaign_lists ON (campaign_lists.list_id = lists.id)
    WHERE campaign_lists.campaign_id = ANY(SELECT id FROM camps)
),
campMedia AS (
    -- Get the list_ids and their optin statuses for the campaigns found in the previous step.
    SELECT campaign_id, ARRAY_AGG(campaign_media.media_id)::INT[] AS media_id FROM campaign_media
    WHERE campaign_id = ANY(SELECT id FROM camps) AND media_id IS NOT NULL
    GROUP BY campaign_id
),
sourceVisibility AS MATERIALIZED (
    SELECT CASE WHEN COUNT(*)=16 AND COALESCE(bool_and(
        c.oid IS NOT NULL AND c.relkind IN ('r','p')
        AND pg_catalog.has_table_privilege(current_user,c.oid,'SELECT')
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity),false)
    THEN true ELSE crm_audience_v2.selection_regular_matches(NULL::jsonb,NULL::integer) END AS ok
    FROM (VALUES
        ('crm_audience_v2.recorded_origin_receipt'),
        ('crm_audience_v2.recorded_origin_source'),
        ('crm_audience_v2.shopify_customer_fact'),
        ('crm_audience_v2.shopify_customer_product'),
        ('crm_audience_v2.shopify_identity'),
        ('crm_audience_v2.shopify_product_batch'),
        ('crm_audience_v2.shopify_product_history_gap'),
        ('crm_audience_v2.shopify_source'),
        ('public.campaign_views'),
        ('public.campaigns'),
        ('public.crm_ab_member_v2'),
        ('public.link_clicks'),
        ('public.subscriber_lists'),
        ('public.subscribers'),
        ('public.campaign_lists'),
        ('public.lists')
    ) fixed(name) LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(fixed.name)
),
nativeListMembers AS MATERIALIZED (
    SELECT camps.id AS campaign_id, sl.subscriber_id AS sid
    FROM camps
    JOIN audienceContexts ac ON ac.id = camps.id
    JOIN campLists cl ON cl.campaign_id = camps.id
    JOIN subscriber_lists sl ON sl.list_id = cl.list_id
        AND (
            CASE
                WHEN camps.type = 'optin' THEN sl.status = 'unconfirmed' AND cl.optin = 'double'
                WHEN cl.optin = 'double' THEN sl.status = 'confirmed'
                ELSE sl.status != 'unsubscribed'
            END
        )
),
nativeCandidateBoundary AS MATERIALIZED (
    SELECT n.campaign_id,n.sid,s.status::text status
    FROM nativeListMembers n FULL JOIN (SELECT id,status FROM subscribers) s ON s.id=n.sid
),
nativeCandidates AS MATERIALIZED (
    SELECT DISTINCT campaign_id,sid FROM nativeCandidateBoundary
    WHERE campaign_id IS NOT NULL AND sid IS NOT NULL AND status!='blocklisted'
),
populationIDs AS MATERIALIZED (
    SELECT nc.campaign_id,array_agg(DISTINCT nc.sid ORDER BY nc.sid) FILTER(WHERE nc.sid IS NOT NULL) AS ids
    FROM nativeCandidates nc GROUP BY nc.campaign_id
),
candidatePopulation AS MATERIALIZED (
    SELECT camps.id AS campaign_id,ac.context,COALESCE(pop.ids,ARRAY[]::integer[]) AS ids
    FROM camps JOIN audienceContexts ac ON ac.id=camps.id
    CROSS JOIN sourceVisibility visibility LEFT JOIN populationIDs pop ON pop.campaign_id=camps.id
    WHERE visibility.ok
),
batchMatches AS MATERIALIZED (
    SELECT cp.campaign_id, evaluated.sid, evaluated.matched
    FROM candidatePopulation cp CROSS JOIN LATERAL (
-- V7 PREPARED SELECT ONLY. cp.context=jsonb ORIGINAL admitted worker context; cp.ids=integer[].
-- No authority/context builder, DDL, SQL from JSON, persistent cache or writes.
-- Caller must preserve original selection_worker_context/readiness/worker fences.
WITH RECURSIVE
input AS MATERIALIZED (SELECT cp.context::jsonb ctx,cp.ids::integer[] ids),
candidates AS MATERIALIZED (SELECT nc.sid FROM nativeCandidates nc WHERE nc.campaign_id=cp.campaign_id),
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
FROM candidates c CROSS JOIN input i CROSS JOIN final_gate g ORDER BY c.sid
    ) evaluated
),
batchReductions AS MATERIALIZED (
    SELECT bm.campaign_id,COUNT(bm.sid) AS evaluated,
        COUNT(bm.sid) FILTER (WHERE bm.matched) AS to_send,
        COALESCE(MAX(bm.sid) FILTER (WHERE bm.matched),0) AS max_subscriber_id
    FROM batchMatches bm GROUP BY bm.campaign_id
),
batchTotals AS MATERIALIZED (
    SELECT cp.campaign_id,cp.context,cp.ids,COALESCE(br.evaluated,0::bigint) AS evaluated,
        COALESCE(br.to_send,0::bigint) AS to_send,COALESCE(br.max_subscriber_id,0) AS max_subscriber_id
    FROM candidatePopulation cp LEFT JOIN batchReductions br ON br.campaign_id=cp.campaign_id
),
postContexts AS MATERIALIZED (
    -- Reading totals first forces completion of the materialized batch result.
    SELECT bt.*, CASE
        WHEN bt.context IS NOT NULL
          AND bt.context IS NOT DISTINCT FROM crm_audience_v2.selection_worker_context(bt.campaign_id)
          AND bt.evaluated=cardinality(bt.ids)
        THEN true ELSE crm_audience_v2.selection_regular_matches(NULL::jsonb,NULL::integer)
        END AS same_context
    FROM batchTotals bt
),
eligibleCounts AS (
    SELECT campaign_id, to_send, max_subscriber_id FROM postContexts
    WHERE cardinality(ids)>0 AND same_context
),
counts AS (
    SELECT * FROM eligibleCounts
    UNION ALL
    SELECT camps.id AS campaign_id, 0::bigint AS to_send, 0::integer AS max_subscriber_id
    FROM camps
    WHERE EXISTS (SELECT 1 FROM crm_audience_v2.campaign_binding_effective(camps.id))
        AND NOT EXISTS (SELECT 1 FROM eligibleCounts e WHERE e.campaign_id = camps.id)
        AND EXISTS (SELECT 1 FROM postContexts pc WHERE pc.campaign_id=camps.id AND pc.same_context)
),
updateCounts AS (
    WITH uc (campaign_id, sent_count) AS (SELECT * FROM unnest($1::INT[], $2::INT[]))
    UPDATE campaigns
    SET sent = sent + uc.sent_count
    FROM uc WHERE campaigns.id = uc.campaign_id
        AND NOT EXISTS (SELECT 1 FROM crm_audience_v2.campaign_binding_effective(campaigns.id))
),
u AS (
    -- For each campaign, update the to_send count and set the max_subscriber_id.
    UPDATE campaigns AS ca
    SET to_send = co.to_send,
        status = (CASE WHEN status != 'running' THEN 'running' ELSE status END),
        max_subscriber_id = co.max_subscriber_id,
        started_at=(CASE WHEN ca.started_at IS NULL THEN NOW() ELSE ca.started_at END)
    FROM (SELECT * FROM counts) co
    WHERE ca.id = co.campaign_id
)
SELECT camps.*, campMedia.media_id FROM camps LEFT JOIN campMedia ON (campMedia.campaign_id = camps.id);

-- name: get-campaign-analytics-unique-counts
WITH intval AS (
    -- For intervals < a week, aggregate counts hourly, otherwise daily.
    SELECT CASE WHEN (EXTRACT (EPOCH FROM ($3::TIMESTAMP - $2::TIMESTAMP)) / 86400) >= 7 THEN 'day' ELSE 'hour' END
),
uniqIDs AS (
    SELECT DISTINCT ON(subscriber_id) subscriber_id, campaign_id, DATE_TRUNC((SELECT * FROM intval), created_at) AS "timestamp"
    FROM %s
    WHERE campaign_id=ANY($1) AND created_at >= $2 AND created_at <= $3
    ORDER BY subscriber_id, "timestamp"
)
SELECT COUNT(*) AS "count", campaign_id, "timestamp"
    FROM uniqIDs GROUP BY campaign_id, "timestamp" ORDER BY "timestamp" ASC;

-- name: get-campaign-analytics-counts
-- raw: true
WITH intval AS (
    -- For intervals < a week, aggregate counts hourly, otherwise daily.
    SELECT CASE WHEN (EXTRACT (EPOCH FROM ($3::TIMESTAMP - $2::TIMESTAMP)) / 86400) >= 7 THEN 'day' ELSE 'hour' END
)
SELECT campaign_id, COUNT(*) AS "count", DATE_TRUNC((SELECT * FROM intval), created_at) AS "timestamp"
    FROM %s
    WHERE campaign_id=ANY($1) AND created_at >= $2 AND created_at <= $3
    GROUP BY campaign_id, "timestamp" ORDER BY "timestamp" ASC;

-- name: get-campaign-bounce-counts
WITH intval AS (
    -- For intervals < a week, aggregate counts hourly, otherwise daily.
    SELECT CASE WHEN (EXTRACT (EPOCH FROM ($3::TIMESTAMP - $2::TIMESTAMP)) / 86400) >= 7 THEN 'day' ELSE 'hour' END
)
SELECT campaign_id, COUNT(*) AS "count", DATE_TRUNC((SELECT * FROM intval), created_at) AS "timestamp"
    FROM bounces
    WHERE campaign_id=ANY($1) AND created_at >= $2 AND created_at <= $3
    GROUP BY campaign_id, "timestamp" ORDER BY "timestamp" ASC;

-- name: get-campaign-link-counts
-- raw: true
-- %s = * or DISTINCT subscriber_id (prepared based on based on individual tracking=on/off). Prepared on boot.
SELECT COUNT(%s) AS "count", url
    FROM link_clicks
    LEFT JOIN links ON (link_clicks.link_id = links.id)
    WHERE campaign_id=ANY($1) AND link_clicks.created_at >= $2 AND link_clicks.created_at <= $3
    GROUP BY links.url ORDER BY "count" DESC LIMIT 50;

-- name: get-running-campaign
-- Returns the metadata for a running campaign that is required by next-campaign-subscribers to retrieve
-- a batch of campaign subscribers for processing.
SELECT campaigns.id AS campaign_id, campaigns.type as campaign_type, last_subscriber_id, max_subscriber_id, lists.id AS list_id
    FROM campaigns
    JOIN campaign_lists ON (campaign_lists.campaign_id = campaigns.id)
    JOIN lists ON (lists.id = campaign_lists.list_id)
    WHERE campaigns.id = $1 AND campaigns.status='running';

-- name: next-campaign-subscribers
-- Returns a batch of subscribers in a given campaign starting from the last checkpoint
-- (last_subscriber_id). Every fetch updates the checkpoint and the sent count, which means
-- every fetch returns a new batch of subscribers until all rows are exhausted.
--
-- In previous versions, get-running-campaign + this was a single query spread across multiple
-- CTEs, but despite numerous permutations and combinations, Postgres query planner simply would not use
-- the right indexes on subscriber_lists when the JOIN or ids were referenced dynamically from campLists
-- (be it a CTE or various kinds of joins). However, statically providing the list IDs to JOIN on ($5::INT[])
-- the query planner works as expected. The difference is staggering. ~15 seconds on a subscribers table with 15m
-- rows and a subscriber_lists table with 70 million rows when fetching subscribers for a campaign with a single list,
-- vs. a few million seconds using this current approach.
WITH RECURSIVE audienceContext AS MATERIALIZED (
    SELECT crm_audience_v2.selection_worker_context($1) AS context
),
campLists AS (
    SELECT lists.id AS list_id, optin FROM lists
    LEFT JOIN campaign_lists ON campaign_lists.list_id = lists.id
    WHERE campaign_lists.campaign_id = $1
        AND (NOT EXISTS (SELECT 1 FROM crm_audience_v2.campaign_binding_effective($1))
            OR EXISTS (SELECT 1 FROM campaigns ca WHERE ca.id = $1 AND ca.status = 'running'))
),
sourceVisibility AS MATERIALIZED (
    SELECT CASE WHEN COUNT(*)=16 AND COALESCE(bool_and(
        c.oid IS NOT NULL AND c.relkind IN ('r','p')
        AND pg_catalog.has_table_privilege(current_user,c.oid,'SELECT')
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity),false)
    THEN true ELSE crm_audience_v2.selection_regular_matches(NULL::jsonb,NULL::integer) END AS ok
    FROM (VALUES
        ('crm_audience_v2.recorded_origin_receipt'),
        ('crm_audience_v2.recorded_origin_source'),
        ('crm_audience_v2.shopify_customer_fact'),
        ('crm_audience_v2.shopify_customer_product'),
        ('crm_audience_v2.shopify_identity'),
        ('crm_audience_v2.shopify_product_batch'),
        ('crm_audience_v2.shopify_product_history_gap'),
        ('crm_audience_v2.shopify_source'),
        ('public.campaign_views'),
        ('public.campaigns'),
        ('public.crm_ab_member_v2'),
        ('public.link_clicks'),
        ('public.subscriber_lists'),
        ('public.subscribers'),
        ('public.campaign_lists'),
        ('public.lists')
    ) fixed(name) LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(fixed.name)
),
legacyIDs AS MATERIALIZED (
        SELECT DISTINCT s.id AS sid
        FROM subscriber_lists sl
        JOIN campLists ON sl.list_id = campLists.list_id
        JOIN subscribers s ON s.id = sl.subscriber_id
        WHERE (SELECT context FROM audienceContext)->'bound'='false'::jsonb AND
            sl.list_id = ANY($5::INT[])
            -- last_subscriber_id
            AND s.id > $3
             -- max_subscriber_id
            AND s.id <= $4
             -- Subscriber should not be blacklisted.
            AND s.status != 'blocklisted'
            AND crm_audience_v2.selection_regular_matches((SELECT context FROM audienceContext), s.id)
            AND (
                -- If it's an optin campaign and the list is double-optin, only pick unconfirmed subscribers.
                ($2 = 'optin' AND sl.status = 'unconfirmed' AND campLists.optin = 'double')
                OR (
                    -- It is a regular campaign.
                    $2 != 'optin' AND (
                        -- It is a double optin list. Only pick confirmed subscribers.
                        (campLists.optin = 'double' AND sl.status = 'confirmed') OR

                        -- It is a single optin list. Pick all non-unsubscribed subscribers.
                        (campLists.optin != 'double' AND sl.status != 'unsubscribed')
                    )
                )
            )
        ORDER BY s.id LIMIT $6
),
recipientWalk(context,cursor,chosen,evaluated,blocks,done) AS (
    SELECT ac.context,$3::integer,ARRAY[]::integer[],0::bigint,0,false
    FROM audienceContext ac CROSS JOIN sourceVisibility visibility
    WHERE ac.context->'bound' IS DISTINCT FROM 'false'::jsonb AND visibility.ok
    UNION ALL
    SELECT cp.context,COALESCE(cp.ids[cardinality(cp.ids)],walk.cursor),
        (walk.chosen||result.hits)[1:COALESCE($6,2147483647)],
        walk.evaluated+result.evaluated,walk.blocks+1,
        cardinality(cp.ids)<256 OR cardinality(walk.chosen||result.hits)>=COALESCE($6,2147483647)
    FROM recipientWalk walk
    CROSS JOIN LATERAL (
        SELECT walk.context,ARRAY(
            SELECT DISTINCT s.id
        FROM subscriber_lists sl
        JOIN campLists ON sl.list_id = campLists.list_id
        JOIN subscribers s ON s.id = sl.subscriber_id
        WHERE (SELECT context FROM audienceContext)->'bound' IS DISTINCT FROM 'false'::jsonb AND
            sl.list_id = ANY($5::INT[])
            -- last_subscriber_id
            AND s.id > walk.cursor
             -- max_subscriber_id
            AND s.id <= $4
             -- Subscriber should not be blacklisted.
            AND s.status != 'blocklisted'
            AND (
                -- If it's an optin campaign and the list is double-optin, only pick unconfirmed subscribers.
                ($2 = 'optin' AND sl.status = 'unconfirmed' AND campLists.optin = 'double')
                OR (
                    -- It is a regular campaign.
                    $2 != 'optin' AND (
                        -- It is a double optin list. Only pick confirmed subscribers.
                        (campLists.optin = 'double' AND sl.status = 'confirmed') OR

                        -- It is a single optin list. Pick all non-unsubscribed subscribers.
                        (campLists.optin != 'double' AND sl.status != 'unsubscribed')
                    )
                )
            )
            AND ($6 IS NULL OR $6>0)
            ORDER BY s.id LIMIT 256
        ) AS ids OFFSET 0
    ) cp
    CROSS JOIN LATERAL (
        SELECT COUNT(evaluated.sid) AS evaluated,
            CASE WHEN COUNT(evaluated.sid)=cardinality(cp.ids)
                AND COUNT(*) FILTER(WHERE evaluated.matched IS NULL)=0
            THEN COALESCE(array_agg(evaluated.sid ORDER BY evaluated.sid) FILTER(WHERE evaluated.matched),ARRAY[]::integer[])
            ELSE CASE WHEN crm_audience_v2.selection_regular_matches(NULL::jsonb,NULL::integer)
                THEN ARRAY[]::integer[] ELSE NULL::integer[] END END AS hits
        FROM (
-- V7 PREPARED SELECT ONLY. cp.context=jsonb ORIGINAL admitted worker context; cp.ids=integer[].
-- No authority/context builder, DDL, SQL from JSON, persistent cache or writes.
-- Caller must preserve original selection_worker_context/readiness/worker fences.
WITH RECURSIVE
input AS MATERIALIZED (SELECT cp.context::jsonb ctx,cp.ids::integer[] ids),
candidates AS MATERIALIZED (SELECT DISTINCT unnest(cp.ids::integer[]) sid),
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
FROM candidates c CROSS JOIN input i CROSS JOIN final_gate g ORDER BY c.sid
        ) evaluated OFFSET 0
    ) result
    WHERE NOT walk.done
),
recipientCompleted AS MATERIALIZED (
    SELECT * FROM recipientWalk WHERE done
),
recipientPostContext AS MATERIALIZED (
    SELECT completed.*,CASE WHEN context IS NOT NULL
      AND context IS NOT DISTINCT FROM crm_audience_v2.selection_worker_context($1)
    THEN true ELSE crm_audience_v2.selection_regular_matches(NULL::jsonb,NULL::integer) END AS same_context
    FROM recipientCompleted completed
),
batchIDs AS MATERIALIZED (
    SELECT unnest(chosen) AS sid FROM recipientPostContext WHERE same_context
),
selectedIDs AS MATERIALIZED (
    SELECT sid FROM legacyIDs UNION ALL SELECT sid FROM batchIDs
),
subs AS (
    SELECT s.*,to_jsonb(s) AS crm_delivery_snapshot
    FROM selectedIDs selected JOIN subscribers s ON s.id=selected.sid ORDER BY s.id
),
u AS (
    UPDATE campaigns
    SET last_subscriber_id = (SELECT MAX(id) FROM subs), updated_at = NOW()
    WHERE (SELECT COUNT(id) FROM subs) > 0 AND id=$1
        AND NOT EXISTS (SELECT 1 FROM crm_audience_v2.campaign_binding_effective($1))
)
SELECT * FROM subs OFFSET (SELECT CASE WHEN context IS NOT NULL AND
    (context->'bound'='false'::jsonb OR COALESCE((SELECT bool_and(same_context) FROM recipientPostContext),false))
    THEN 0 ELSE CASE WHEN crm_audience_v2.selection_regular_matches(NULL::jsonb,NULL::integer) THEN 0 ELSE 1 END END FROM audienceContext);

-- name: delete-campaign-views
DELETE FROM campaign_views WHERE created_at < $1;

-- name: delete-campaign-link-clicks
DELETE FROM link_clicks WHERE created_at < $1;

-- name: get-one-campaign-subscriber
SELECT * FROM subscribers
LEFT JOIN subscriber_lists ON (subscribers.id = subscriber_lists.subscriber_id AND subscriber_lists.status != 'unsubscribed')
WHERE subscriber_lists.list_id=ANY(
    SELECT list_id FROM campaign_lists where campaign_id=$1 AND list_id IS NOT NULL
)
ORDER BY RANDOM() LIMIT 1;

-- name: update-campaign
WITH camp AS (
    UPDATE campaigns SET
        name=$2,
        subject=$3,
        from_email=$4,
        body=$5,
        altbody=(CASE WHEN $6 = '' THEN NULL ELSE $6 END),
        content_type=$7::content_type,
        send_at=$8::TIMESTAMP WITH TIME ZONE,
        status=(
            CASE
                WHEN status = 'scheduled' AND $8 IS NULL THEN 'draft'
                ELSE status
            END
        ),
        headers=$9,
        attribs=$10,
        tags=$11::VARCHAR(100)[],
        messenger=$12,
        -- template_id shouldn't be saved for visual campaigns.
        template_id=(CASE WHEN $7::content_type = 'visual' THEN NULL ELSE $13::INT END),
        archive=$15,
        archive_slug=$16,
        archive_template_id=(CASE WHEN $7::content_type = 'visual' THEN NULL ELSE $17::INT END),
        archive_meta=$18,
        body_source=$20,
        updated_at=NOW()
    WHERE id = $1 RETURNING id
),
clists AS (
    -- Reset list relationships
    DELETE FROM campaign_lists WHERE campaign_id = $1 AND NOT(list_id = ANY($14))
),
med AS (
    DELETE FROM campaign_media WHERE campaign_id = $1
    AND ( media_id IS NULL or NOT(media_id = ANY($19))) RETURNING media_id
),
medi AS (
    INSERT INTO campaign_media (campaign_id, media_id, filename)
        (SELECT $1 AS campaign_id, id, filename FROM media WHERE id=ANY($19::INT[]))
        ON CONFLICT (campaign_id, media_id) DO NOTHING
)
INSERT INTO campaign_lists (campaign_id, list_id, list_name)
    (SELECT $1 as campaign_id, id, name FROM lists WHERE id=ANY($14::INT[]))
    ON CONFLICT (campaign_id, list_id) DO UPDATE SET list_name = EXCLUDED.list_name;

-- name: update-campaign-counts
UPDATE campaigns SET
    to_send=(CASE WHEN $2 != 0 THEN $2 ELSE to_send END),
    sent=sent+$3,
    last_subscriber_id=(CASE WHEN $4 > 0 THEN $4 ELSE last_subscriber_id END),
    updated_at=NOW()
WHERE id=$1
    AND NOT EXISTS (SELECT 1 FROM crm_audience_v2.campaign_binding_effective($1));

-- name: update-campaign-status
UPDATE campaigns SET
    status=(
        CASE
            WHEN send_at IS NOT NULL AND $2 = 'running' THEN 'scheduled'
            ELSE $2::campaign_status
        END
    ),
    updated_at=NOW()
WHERE id = $1;

-- name: update-campaign-archive
UPDATE campaigns SET
    archive=$2,
    archive_slug=(CASE WHEN $3::TEXT = '' THEN NULL ELSE $3 END),
    archive_template_id=(CASE WHEN $4 > 0 THEN $4 ELSE archive_template_id END),
    archive_meta=(CASE WHEN $5::TEXT != '' THEN $5::JSONB ELSE archive_meta END),
    updated_at=NOW()
    WHERE id=$1;

-- name: delete-campaign
DELETE FROM campaigns WHERE id=$1;

-- name: delete-campaigns
DELETE FROM campaigns c
WHERE (
    CASE
        WHEN CARDINALITY($1::INT[]) > 0 THEN id = ANY($1)
        ELSE $2 = '' OR TO_TSVECTOR(CONCAT(name, ' ', subject)) @@ TO_TSQUERY($2) OR CONCAT(c.name, ' ', c.subject) ILIKE $2
    END
)
-- Get all campaigns or filter by permitted list IDs.
AND (
    $3 OR EXISTS (
        SELECT 1 FROM campaign_lists WHERE campaign_id = c.id AND list_id = ANY($4::INT[])
    )
);

-- name: register-campaign-view
WITH view AS (
    SELECT campaigns.id as campaign_id, subscribers.id AS subscriber_id FROM campaigns
    LEFT JOIN subscribers ON (CASE WHEN $2::TEXT != '' THEN subscribers.uuid = $2::UUID ELSE FALSE END)
    WHERE campaigns.uuid = $1
)
INSERT INTO campaign_views (campaign_id, subscriber_id)
    VALUES((SELECT campaign_id FROM view), (SELECT subscriber_id FROM view));

