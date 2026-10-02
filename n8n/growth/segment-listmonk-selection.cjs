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
