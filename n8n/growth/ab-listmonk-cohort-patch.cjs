'use strict';
// A build-time patch, never an n8n/HTTP operation. No supported query override
// was found in Listmonk v6.1.0 initFS/initFlags: bundled SQL requires a custom build.
const {createHash}=require('node:crypto');
const SOURCE_SHA256='37b1b131a6b9005141b1bf2e32dde53a68838184bc4348f6c97fb61b581c5882';
const sha=s=>createHash('sha256').update(s).digest('hex');
function section(source,name){const marker='-- name: '+name+'\n',start=source.indexOf(marker);if(start<0||source.indexOf(marker,start+1)>=0)throw Error('AB_NATIVE_SECTION');const end=source.indexOf('-- name:',start+marker.length);return {start,end:end<0?source.length:end,text:source.slice(start,end<0?source.length:end)};}
function insertPredicate(query,{phase}){
 const cid=phase==='count'?'camps.id':phase==='batch'?'$1':null;if(!cid)throw Error('AB_NATIVE_PHASE');
 const anchor=phase==='count'?"JOIN subscribers s ON (s.id = sl.subscriber_id AND s.status != 'blocklisted')":"AND s.status != 'blocklisted'";
 if(query.split(anchor).length!==2)throw Error('AB_NATIVE_ANCHOR');
 // The uncorrelated NOT IN becomes a hashed/init plan. Non-A/B campaigns do not
 // call the per-member function; the native opt-in/blocklist predicates remain.
 const predicate=`(${cid} NOT IN (SELECT campaign_id FROM public.crm_ab_arm_v2) OR public.crm_ab_delivery_allowed_v2(${cid}, s.id))`;
 return query.replace(anchor,phase==='count'?anchor.slice(0,-1)+' AND '+predicate+')':anchor+'\n                    AND '+predicate);
}
function patchSource(source){
 if(typeof source!=='string'||sha(source)!==SOURCE_SHA256)throw Error('AB_NATIVE_SOURCE_DRIFT');
 let next=source;
 for(const [name,phase] of [['next-campaigns','count'],['next-campaign-subscribers','batch']]){const s=section(next,name);next=next.slice(0,s.start)+insertPredicate(s.text,{phase})+next.slice(s.end);}
 return {source:next,upstream:'v6.1.0',source_sha256:SOURCE_SHA256,patched_sha256:sha(next),changed_queries:['next-campaigns','next-campaign-subscribers']};
}
module.exports={SOURCE_SHA256,patchSource,insertPredicate,section};
