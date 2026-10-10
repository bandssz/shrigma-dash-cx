'use strict';
// LOCAL CANDIDATE ONLY. Compose the pinned upstream SQL in memory; no image,
// deployment pin, existing A/B patch, runtime or activation API is changed.
const {createHash}=require('node:crypto');
const AB=require('./ab-listmonk-cohort-patch.cjs');
const AB_SOURCE_SHA256='50a7d13f140674e8e252d1a47a70862f083a20fcaf1a8c771803c589bdb1adb9';
const REGULAR_WORKER_SOURCE_SHA256='084a9493713b21b618d24daae98b38db59fb84febf0c367914bea1ed7aa84c2d';
const RFM_WORKER_SOURCE_SHA256='f8bfbb7fe60c22e0bcc937fb5bbc49414a8cd080265d076d4098606d68000c2f';
const sha=s=>createHash('sha256').update(s).digest('hex');
const predicate=(campaign,helper='selection_allowed')=>'crm_audience_v2.'+helper+'('+campaign+', s.id)';
function patchRegularSource(source){
 if(typeof source!=='string'||sha(source)!==AB.SOURCE_SHA256)throw Error('SEGMENT_NATIVE_SOURCE_DRIFT');
 let next=source;
 const replace=(name,replacements)=>{
  const section=AB.section(next,name);let text=section.text;
  for(const [anchor,replacement]of replacements){if(text.split(anchor).length!==2)throw Error('SEGMENT_NATIVE_ANCHOR');text=text.replace(anchor,replacement);}
  next=next.slice(0,section.start)+text+next.slice(section.end);
 };
 replace('next-campaigns',[
  ['WITH camps AS (','WITH eligibleCamps AS MATERIALIZED ('],
  ["),\ncampLists AS (",
   "),\naudienceContexts AS MATERIALIZED (\n    SELECT id, crm_audience_v2.selection_regular_context(id) AS context FROM eligibleCamps\n),\ncamps AS MATERIALIZED (\n    SELECT eligibleCamps.* FROM eligibleCamps JOIN audienceContexts USING (id) WHERE context IS NOT NULL\n),\ncampLists AS ("],
  ['counts AS (','eligibleCounts AS ('],
  ['FROM camps\n    JOIN campLists','FROM camps\n    JOIN audienceContexts ac ON ac.id = camps.id\n    JOIN campLists'],
  ["JOIN subscribers s ON (s.id = sl.subscriber_id AND s.status != 'blocklisted')",
   "JOIN subscribers s ON (s.id = sl.subscriber_id AND s.status != 'blocklisted')\n        AND "+predicate('ac.context','selection_regular_matches')],
  ["),\nupdateCounts AS (",
   "),\ncounts AS (\n    SELECT * FROM eligibleCounts\n    UNION ALL\n    SELECT camps.id AS campaign_id, 0::bigint AS to_send, 0::integer AS max_subscriber_id\n    FROM camps\n    WHERE EXISTS (SELECT 1 FROM crm_audience_v2.campaign_binding_effective(camps.id))\n        AND NOT EXISTS (SELECT 1 FROM eligibleCounts e WHERE e.campaign_id = camps.id)\n),\nupdateCounts AS ("]
 ]);
 replace('next-campaign-subscribers',[
  ['WITH campLists AS (','WITH audienceContext AS MATERIALIZED (\n    SELECT crm_audience_v2.selection_regular_context($1) AS context\n),\ncampLists AS ('],
  ['WHERE campaign_lists.campaign_id = $1',
   "WHERE campaign_lists.campaign_id = $1\n        AND (NOT EXISTS (SELECT 1 FROM crm_audience_v2.campaign_binding_effective($1))\n            OR EXISTS (SELECT 1 FROM campaigns ca WHERE ca.id = $1 AND ca.status = 'running'))"],
  ["AND s.status != 'blocklisted'",
   "AND s.status != 'blocklisted'\n            AND "+predicate('(SELECT context FROM audienceContext)','selection_regular_matches')],
  ['SELECT * FROM subs;',
   'SELECT * FROM subs OFFSET (SELECT CASE WHEN context IS NOT NULL THEN 0 ELSE 1 END FROM audienceContext);']
 ]);
 return {source:next,upstream:'v6.1.0',source_sha256:AB.SOURCE_SHA256,
  patched_sha256:sha(next),changed_queries:['next-campaigns','next-campaign-subscribers'],
  variant:'selection-only',requires_ab:false,fixture_only:true,authorizes_selection:false,authorizes_send:false};
}
function patchSource(source){
 const ab=AB.patchSource(source);
 if(ab.patched_sha256!==AB_SOURCE_SHA256)throw Error('SEGMENT_NATIVE_AB_SOURCE_DRIFT');
 let next=ab.source;
 for(const [name,anchor,replacement] of [
  ['next-campaigns',
   'WHERE ab_owned.campaign_id IS NULL OR ab_eligible.subscriber_id IS NOT NULL',
   'WHERE (ab_owned.campaign_id IS NULL OR ab_eligible.subscriber_id IS NOT NULL)\n        AND '+predicate('camps.id')],
  ['next-campaign-subscribers',
   "AND s.status != 'blocklisted'",
   "AND s.status != 'blocklisted'\n            AND "+predicate('$1')]
 ]){
  const section=AB.section(next,name);
  if(section.text.split(anchor).length!==2)throw Error('SEGMENT_NATIVE_ANCHOR');
  next=next.slice(0,section.start)+section.text.replace(anchor,replacement)+next.slice(section.end);
 }
 return {source:next,upstream:ab.upstream,source_sha256:ab.source_sha256,
  ab_source_sha256:ab.patched_sha256,patched_sha256:sha(next),
  changed_queries:ab.changed_queries,fixture_only:true,authorizes_selection:false,authorizes_send:false};
}
// Future native-worker composition. Selection must not acknowledge delivery:
// only the durable recipient finish may advance a bound campaign's cursor/count.
// This variant is deliberately separate from the proven selection-only artifact.
function patchRegularWorkerSource(source){
 const regular=patchRegularSource(source);let next=regular.source;
 const replace=(name,anchor,replacement)=>{
  const section=AB.section(next,name);
  if(section.text.split(anchor).length!==2)throw Error('SEGMENT_WORKER_NATIVE_ANCHOR');
  next=next.slice(0,section.start)+section.text.replace(anchor,replacement)+next.slice(section.end);
 };
 for(const name of regular.changed_queries){
  const section=AB.section(next,name);
  next=next.slice(0,section.start)+section.text.replaceAll('selection_regular_context(', 'selection_worker_context(')+next.slice(section.end);
 }
 replace('next-campaigns','FROM uc WHERE campaigns.id = uc.campaign_id',
  'FROM uc WHERE campaigns.id = uc.campaign_id\n        AND NOT EXISTS (SELECT 1 FROM crm_audience_v2.campaign_binding_effective(campaigns.id))');
 replace('next-campaign-subscribers','WHERE (SELECT COUNT(id) FROM subs) > 0 AND id=$1',
  'WHERE (SELECT COUNT(id) FROM subs) > 0 AND id=$1\n        AND NOT EXISTS (SELECT 1 FROM crm_audience_v2.campaign_binding_effective($1))');
 replace('next-campaign-subscribers','    SELECT s.*\n    FROM (',
  '    SELECT s.*, to_jsonb(s) AS crm_delivery_snapshot\n    FROM (');
 replace('update-campaign-counts','WHERE id=$1;',
  'WHERE id=$1\n    AND NOT EXISTS (SELECT 1 FROM crm_audience_v2.campaign_binding_effective($1));');
 return {...regular,source:next,patched_sha256:sha(next),variant:'regular-worker-checkpoint',
  changed_queries:[...regular.changed_queries,'update-campaign-counts'],
  requires_durable_finish:true,requires_serial_recipient_ack:true};
}
// Future OFF-only RFM worker composition. The historical 084a worker remains
// byte-identical above; this adds a separately pinned query candidate that
// replaces per-subscriber RFM source/config reads only for an exact root leaf.
// Mixed rules, unbound campaigns, A/B composition and all existing native
// consent/status predicates retain their prior paths.
function patchRfmWorkerSource(source){
 const worker=patchRegularWorkerSource(source);
 if(worker.patched_sha256!==REGULAR_WORKER_SOURCE_SHA256)throw Error('RFM_NATIVE_WORKER_SOURCE_DRIFT');
 let next=worker.source;
 const replace=(name,anchor,replacement)=>{
  const section=AB.section(next,name);
  if(section.text.split(anchor).length!==2)throw Error('RFM_NATIVE_WORKER_ANCHOR');
  next=next.slice(0,section.start)+section.text.replace(anchor,replacement)+next.slice(section.end);
 };
 replace('next-campaigns',
  '    SELECT eligibleCamps.* FROM eligibleCamps JOIN audienceContexts USING (id) WHERE context IS NOT NULL\n),\ncampLists AS (',
  `    SELECT eligibleCamps.* FROM eligibleCamps JOIN audienceContexts USING (id) WHERE context IS NOT NULL
),
genericAudienceContexts AS MATERIALIZED (
    SELECT * FROM audienceContexts WHERE NOT crm_audience_v2.rfm_native_context_fast(context)
),
rfmAudienceContexts AS MATERIALIZED (
    SELECT * FROM audienceContexts WHERE crm_audience_v2.rfm_native_context_fast(context)
),
campLists AS (`);
 replace('next-campaigns','eligibleCounts AS (','genericCounts AS (');
 replace('next-campaigns','    JOIN audienceContexts ac ON ac.id = camps.id\n    JOIN campLists',
  '    JOIN genericAudienceContexts ac ON ac.id = camps.id\n    JOIN campLists');
 replace('next-campaigns',
  '        AND crm_audience_v2.selection_regular_matches(ac.context, s.id)\n    GROUP BY camps.id\n),\ncounts AS (',
  `        AND crm_audience_v2.selection_regular_matches(ac.context, s.id)
    GROUP BY camps.id
),
rfmCounts AS MATERIALIZED (
    SELECT camps.id AS campaign_id, r.to_send, r.max_subscriber_id
    FROM camps
    JOIN rfmAudienceContexts ac ON ac.id = camps.id
    CROSS JOIN LATERAL crm_audience_v2.rfm_native_count(ac.context) r
),
eligibleCounts AS (
    SELECT * FROM genericCounts
    UNION ALL
    SELECT * FROM rfmCounts
),
counts AS (`);
 replace('next-campaign-subscribers',
  '),\nsubs AS (',
  `),
fastContext AS MATERIALIZED (
    SELECT context FROM audienceContext
    WHERE crm_audience_v2.rfm_native_context_fast(context)
      AND EXISTS (SELECT 1 FROM campLists)
),
rfmIDs AS MATERIALIZED (
    SELECT ids.id FROM fastContext
    CROSS JOIN LATERAL crm_audience_v2.rfm_native_subscriber_ids(
        fastContext.context,$2::text,$5::integer[],$3::integer,$4::integer,$6::integer) ids
),
subs AS (`);
 {
  const section=AB.section(next,'next-campaign-subscribers'),start=section.text.indexOf('subs AS ('),end=section.text.indexOf('),\nu AS (',start);
  if(start<0||end<0||section.text.indexOf('subs AS (',start+1)>=0)throw Error('RFM_NATIVE_SUBSCRIBER_BRANCH_ANCHOR');
  const replacement=`legacyIDs AS MATERIALIZED (
    SELECT DISTINCT s.id
    FROM subscriber_lists sl
    JOIN campLists ON sl.list_id = campLists.list_id
    JOIN subscribers s ON s.id = sl.subscriber_id
    WHERE NOT crm_audience_v2.rfm_native_context_fast((SELECT context FROM audienceContext))
        AND sl.list_id = ANY($5::INT[])
        AND s.id > $3 AND s.id <= $4
        AND s.status != 'blocklisted'
        AND crm_audience_v2.selection_regular_matches((SELECT context FROM audienceContext), s.id)
        AND (($2 = 'optin' AND sl.status = 'unconfirmed' AND campLists.optin = 'double')
          OR ($2 != 'optin' AND ((campLists.optin = 'double' AND sl.status = 'confirmed')
            OR (campLists.optin != 'double' AND sl.status != 'unsubscribed'))))
    ORDER BY s.id LIMIT $6
),
selectedIDs AS MATERIALIZED (
    SELECT id FROM rfmIDs
    UNION ALL
    SELECT id FROM legacyIDs
),
subs AS (
    SELECT s.*, to_jsonb(s) AS crm_delivery_snapshot
    FROM selectedIDs selected JOIN subscribers s ON s.id=selected.id ORDER BY s.id
)`;
  const changed=section.text.slice(0,start)+replacement+section.text.slice(end+1);
  next=next.slice(0,section.start)+changed+next.slice(section.end);
 }
 const patched=sha(next);if(patched!==RFM_WORKER_SOURCE_SHA256)throw Error('RFM_NATIVE_WORKER_ASSEMBLY_DRIFT');
 return {...worker,source:next,patched_sha256:patched,variant:'regular-worker-rfm-fast-path',
  base_worker_sha256:worker.patched_sha256,rfm_fast_path:true,authorizes_selection:false,authorizes_send:false};
}
module.exports={AB_SOURCE_SHA256,REGULAR_WORKER_SOURCE_SHA256,RFM_WORKER_SOURCE_SHA256,patchRegularSource,patchRegularWorkerSource,patchRfmWorkerSource,patchSource,section:AB.section};

// Separate OFF-only COUNT batch variant. The historical variants above stay exact.
// The kernel argument is trusted source bytes from the pinned file, never JSON SQL.
const BATCH_KERNEL_SHA256='7d9e4cd7fd4e3c6f9967386c5ca7b1410e755690fac3a77149d8d032d2c4e8b4';
function patchBatchWorkerSource(source,kernelSQL,expectedKernelSha256=BATCH_KERNEL_SHA256){
 if(typeof kernelSQL!=='string'||!/^[a-f0-9]{64}$/.test(expectedKernelSha256)||sha(kernelSQL)!==expectedKernelSha256)throw Error('BATCH_KERNEL_SOURCE_DRIFT');
 const worker=patchRegularWorkerSource(source);
 if(worker.patched_sha256!==REGULAR_WORKER_SOURCE_SHA256)throw Error('BATCH_NATIVE_WORKER_SOURCE_DRIFT');
 const section=AB.section(worker.source,'next-campaigns');
 let text=section.text;
 const campsAnchor='    SELECT eligibleCamps.* FROM eligibleCamps JOIN audienceContexts USING (id) WHERE context IS NOT NULL\n),\ncampLists AS (';
 if(text.split(campsAnchor).length!==2)throw Error('BOUNDED_CAMPS_CONTEXT_ANCHOR_DRIFT');
 text=text.replace(campsAnchor,'    SELECT eligibleCamps.* FROM eligibleCamps JOIN audienceContexts USING (id) WHERE context IS NOT NULL\n    ORDER BY eligibleCamps.send_at ASC NULLS FIRST,eligibleCamps.id ASC LIMIT 1\n),\ncampLists AS (');
 const start=text.indexOf('eligibleCounts AS ('),end=text.indexOf('),\ncounts AS (',start);
 if(start<0||end<0||text.indexOf('eligibleCounts AS (',start+1)>=0)throw Error('BATCH_COUNT_ANCHOR_DRIFT');
 const prior=text.slice(start,end);
 const from=prior.indexOf('    FROM camps'),group=prior.indexOf('    GROUP BY camps.id');
 if(from<0||group<0)throw Error('BATCH_NATIVE_POPULATION_DRIFT');
 const predicate='\n        AND crm_audience_v2.selection_regular_matches(ac.context, s.id)';
 if(prior.split(predicate).length!==2)throw Error('BATCH_NATIVE_MATCH_ANCHOR_DRIFT');
 const native=prior.slice(from,group).replace(predicate,'');
 const subscriberJoin='    JOIN subscribers s ON (s.id = sl.subscriber_id AND s.status != \'blocklisted\')\n';
 if(native.split(subscriberJoin).length!==2)throw Error('BATCH_NATIVE_SUBSCRIBER_ANCHOR_DRIFT');
 const nativeMembers=native.replace(subscriberJoin,'');
 let kernel=kernelSQL.replace(/\$1\b/g,'cp.context').replace(/\$2\b/g,'cp.ids').trim().replace(/;$/,'');
 // COUNT already owns the identical DISTINCT campaign population; expose its relation cardinality.
 // Recipient keeps the closed ARRAY kernel because its lazy blocks are independently bounded.
 const candidateAnchor='candidates AS MATERIALIZED (SELECT DISTINCT unnest(cp.ids::integer[]) sid),';
 if(kernel.split(candidateAnchor).length!==2)throw Error('BATCH_COUNT_CANDIDATE_RELATION_DRIFT');
 kernel=kernel.replace(candidateAnchor,'candidates AS MATERIALIZED (SELECT nc.sid FROM nativeCandidates nc WHERE nc.campaign_id=cp.campaign_id),');
 const replacement=`sourceVisibility AS MATERIALIZED (
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
${nativeMembers}),
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
${kernel}
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
`;
 text=text.slice(0,start)+replacement+text.slice(end);
 const zero='        AND NOT EXISTS (SELECT 1 FROM eligibleCounts e WHERE e.campaign_id = camps.id)';
 if(text.split(zero).length!==2)throw Error('BATCH_ZERO_ANCHOR_DRIFT');
 text=text.replace(zero,zero+'\n        AND EXISTS (SELECT 1 FROM postContexts pc WHERE pc.campaign_id=camps.id AND pc.same_context)');
 const next=worker.source.slice(0,section.start)+text+worker.source.slice(section.end);
 return {...worker,source:next,patched_sha256:sha(next),variant:'regular-worker-fixed-batch-count',
  campaign_scan_batch_size:1,batch_kernel_sha256:expectedKernelSha256,base_worker_sha256:worker.patched_sha256,
  requires_native_kernel_acceptance:true,fixture_only:true,authorizes_selection:false,authorizes_send:false};
}
module.exports={...module.exports,BATCH_KERNEL_SHA256,patchBatchWorkerSource};

// Full source-only batch variant: kernel bytes come from the closed Root profile.
function patchFullBatchWorkerSource(source,kernelSQL,expectedKernelSha256=BATCH_KERNEL_SHA256){
 const count=patchBatchWorkerSource(source,kernelSQL,expectedKernelSha256);
 const prior=AB.section(count.source,'next-campaign-subscribers');
 const start=prior.text.indexOf('subs AS ('),end=prior.text.indexOf('),\nu AS (',start);
 if(start<0||end<0)throw Error('BATCH_RECIPIENT_ANCHOR_DRIFT');
 const sub=prior.text.slice(start,end),from=sub.indexOf('        FROM subscriber_lists sl'),finish=sub.indexOf('        ORDER BY s.id LIMIT $6');
 if(from<0||finish<0)throw Error('BATCH_RECIPIENT_POPULATION_DRIFT');
 const native=sub.slice(from,finish);
 const scalar='            AND crm_audience_v2.selection_regular_matches((SELECT context FROM audienceContext), s.id)\n';
 if(native.split(scalar).length!==2)throw Error('BATCH_RECIPIENT_MATCH_ANCHOR_DRIFT');
 const legacyNative=native.replace('        WHERE\n','        WHERE (SELECT context FROM audienceContext)->\'bound\'=\'false\'::jsonb AND\n');
 const boundNative=native.replace(scalar,'').replace('        WHERE\n',"        WHERE (SELECT context FROM audienceContext)->'bound' IS DISTINCT FROM 'false'::jsonb AND\n");
 const orderedBlock=boundNative.replace(/s\.id > \$3/g,'s.id > walk.cursor');
 if(orderedBlock===boundNative)throw Error('BATCH_RECIPIENT_CURSOR_ANCHOR_DRIFT');
 const countSection=AB.section(count.source,'next-campaigns').text;
 const gateStart=countSection.indexOf('sourceVisibility AS MATERIALIZED ('),gateEnd=countSection.indexOf('nativeListMembers AS MATERIALIZED (',gateStart);
 if(gateStart<0||gateEnd<0)throw Error('BATCH_RECIPIENT_VISIBILITY_ANCHOR_DRIFT');
 const visibility=countSection.slice(gateStart,gateEnd);
 const kernel=kernelSQL.replace(/\$1\b/g,'cp.context').replace(/\$2\b/g,'cp.ids').trim().replace(/;$/,'');
 const replacement=`${visibility}legacyIDs AS MATERIALIZED (
        SELECT DISTINCT s.id AS sid
${legacyNative}        ORDER BY s.id LIMIT $6
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
${orderedBlock}            AND ($6 IS NULL OR $6>0)
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
${kernel}
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
`;
 let text=prior.text.slice(0,start)+replacement+prior.text.slice(end);
 if(text.split('WITH audienceContext AS MATERIALIZED (').length!==2)throw Error('BATCH_RECIPIENT_RECURSIVE_ANCHOR_DRIFT');
 text=text.replace('WITH audienceContext AS MATERIALIZED (','WITH RECURSIVE audienceContext AS MATERIALIZED (');
 const offset='OFFSET (SELECT CASE WHEN context IS NOT NULL THEN 0 ELSE 1 END FROM audienceContext)';
 if(text.split(offset).length!==2)throw Error('BATCH_RECIPIENT_POSTGATE_ANCHOR_DRIFT');
 text=text.replace(offset,`OFFSET (SELECT CASE WHEN context IS NOT NULL AND
    (context->'bound'='false'::jsonb OR COALESCE((SELECT bool_and(same_context) FROM recipientPostContext),false))
    THEN 0 ELSE CASE WHEN crm_audience_v2.selection_regular_matches(NULL::jsonb,NULL::integer) THEN 0 ELSE 1 END END FROM audienceContext)`);
 const next=count.source.slice(0,prior.start)+text+count.source.slice(prior.end);
 return {...count,source:next,patched_sha256:sha(next),variant:'regular-worker-fixed-batch-count-recipient',
  recipient_batch:true,recipient_block_size:256,recipient_lazy:true,requires_native_recipient_performance_acceptance:true,
  batch_kernel_sha256:expectedKernelSha256,authorizes_selection:false,authorizes_send:false};
}
module.exports={...module.exports,patchFullBatchWorkerSource};
