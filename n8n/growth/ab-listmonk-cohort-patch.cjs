'use strict';
// A build-time patch, never an n8n/HTTP operation. No supported query override
// was found in Listmonk v6.1.0 initFS/initFlags: bundled SQL requires a custom build.
const {createHash}=require('node:crypto');
const SOURCE_SHA256='37b1b131a6b9005141b1bf2e32dde53a68838184bc4348f6c97fb61b581c5882';
const sha=s=>createHash('sha256').update(s).digest('hex');
function section(source,name){const marker='-- name: '+name+'\n',start=source.indexOf(marker);if(start<0||source.indexOf(marker,start+1)>=0)throw Error('AB_NATIVE_SECTION');const end=source.indexOf('-- name:',start+marker.length);return {start,end:end<0?source.length:end,text:source.slice(start,end<0?source.length:end)};}
function insertCountPredicate(query){
 const marker='counts AS (',anchor="JOIN subscribers s ON (s.id = sl.subscriber_id AND s.status != 'blocklisted')";
 if(query.split(marker).length!==2||query.split(anchor).length!==2)throw Error('AB_NATIVE_ANCHOR');
 // The canonical function's only per-member gates are enabled + not revoked.
 // Choose a member satisfying those gates, then evaluate the canonical runtime /
 // experiment gates ONCE per admitted arm. Native consent must not be used for
 // this probe: an opted-out representative cannot suppress the rest of an arm.
 // MATERIALIZED prevents the planner from expanding the function per native row.
 const readiness=`abOwned AS MATERIALIZED (
    SELECT a.campaign_id, a.test_id, a.arm
    FROM public.crm_ab_arm_v2 a JOIN camps ON camps.id = a.campaign_id
),
abReady AS MATERIALIZED (
    SELECT a.campaign_id, a.test_id, a.arm,
        public.crm_ab_delivery_allowed_v2(a.campaign_id, probe.subscriber_id) AS allowed
    FROM abOwned a
    LEFT JOIN LATERAL (
        SELECT m.subscriber_id
        FROM public.crm_ab_member_v2 m
        JOIN public.subscribers s ON s.id = m.subscriber_id AND s.status::text = 'enabled'
        WHERE m.test_id = a.test_id AND m.arm = a.arm AND m.revoked_at IS NULL
        ORDER BY m.subscriber_id LIMIT 1
    ) probe ON true
),
abEligible AS MATERIALIZED (
    SELECT a.campaign_id, m.subscriber_id
    FROM abReady a
    JOIN public.crm_ab_member_v2 m ON m.test_id = a.test_id AND m.arm = a.arm
    JOIN public.subscribers s ON s.id = m.subscriber_id AND s.status::text = 'enabled'
    WHERE a.allowed AND m.revoked_at IS NULL
),
`;
 const joins=`${anchor}
    LEFT JOIN abOwned ab_owned ON ab_owned.campaign_id = camps.id
    LEFT JOIN abEligible ab_eligible ON ab_eligible.campaign_id = camps.id AND ab_eligible.subscriber_id = s.id
    WHERE ab_owned.campaign_id IS NULL OR ab_eligible.subscriber_id IS NOT NULL`;
 return query.replace(marker,readiness+marker).replace(anchor,joins);
}
function insertPredicate(query,{phase}){
 if(phase==='count')return insertCountPredicate(query);
 if(phase!=='batch')throw Error('AB_NATIVE_PHASE');
 const cid='$1',anchor="AND s.status != 'blocklisted'";
 if(query.split(anchor).length!==2)throw Error('AB_NATIVE_ANCHOR');
 // Keep batch selection byte-identical: original consent and fresh per-member
 // checks are still required at every native batch.
 const predicate=`(${cid} NOT IN (SELECT campaign_id FROM public.crm_ab_arm_v2) OR public.crm_ab_delivery_allowed_v2(${cid}, s.id))`;
 return query.replace(anchor,anchor+'\n                    AND '+predicate);
}
function patchSource(source){
 if(typeof source!=='string'||sha(source)!==SOURCE_SHA256)throw Error('AB_NATIVE_SOURCE_DRIFT');
 let next=source;
 for(const [name,phase] of [['next-campaigns','count'],['next-campaign-subscribers','batch']]){const s=section(next,name);next=next.slice(0,s.start)+insertPredicate(s.text,{phase})+next.slice(s.end);}
 return {source:next,upstream:'v6.1.0',source_sha256:SOURCE_SHA256,patched_sha256:sha(next),changed_queries:['next-campaigns','next-campaign-subscribers']};
}
module.exports={SOURCE_SHA256,patchSource,insertPredicate,section};
