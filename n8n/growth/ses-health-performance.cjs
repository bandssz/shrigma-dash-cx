'use strict';
// Read-only query rewrite. Keeps the live three-brand metrics intact and narrows
// native dispatches before correlated coverage/status checks. Never transports.
const {createHash}=require('node:crypto');
const SOURCE_SHA256='039880495056b8e0d52ccdee53d42e47d852a5fc3e9f903ee427736d8075e260';
const VIEW='public.shrigma_growth_email_ses_health_v1';
const sha=s=>createHash('sha256').update(s).digest('hex');
function patchDefinition(source){
 if(typeof source!=='string'||sha(source)!==SOURCE_SHA256)throw Error('SES_HEALTH_SOURCE_DRIFT');
 const first=source.indexOf('(EXISTS ( SELECT 1');
 const from=source.indexOf('FROM shrigma_email_dispatch d',first);
 const coverage=source.indexOf("AND (d.brand = 'olivas'::text AND d.configuration_set = 'unconfigured'::text OR",from);
 if(first<0||from<0||coverage<0||source.slice(0,first).indexOf('WITH recent AS (')<0)throw Error('SES_HEALTH_SOURCE_SHAPE');
 // Only the time/test/brand candidate restriction is moved into the CTE. The
 // coverage exception for unconfigured Olivas, event predicates, aggregates,
 // timestamps, collector and queue output remain byte-identical.
 const scan=source.slice(from,coverage).trimEnd();
 const fields='d.dispatch_id, d.brand, d.flow, d.piece, d.configuration_set, d.transport_state, d.started_at';
 let next='WITH candidates AS MATERIALIZED (\n SELECT '+fields+'\n '+scan+'\n), recent AS (\n SELECT d.brand, d.configuration_set, d.transport_state, d.started_at,\n '+
  source.slice(first,from)+'FROM candidates d\n WHERE '+source.slice(coverage+4);
 // A merge join may reorder the three VALUES rows. Keep the observed public
 // array order explicit; every metric and each complete brand object is kept.
 const order='COALESCE(r.reclamacoes_24h, 0::bigint))) AS jsonb_agg';
 if(next.split(order).length!==2)throw Error('SES_HEALTH_SOURCE_SHAPE');
 next=next.replace(order,"COALESCE(r.reclamacoes_24h, 0::bigint)) ORDER BY CASE b.marca WHEN 'fish'::text THEN 0 WHEN 'aristo'::text THEN 1 ELSE 2 END) AS jsonb_agg");
 return Object.freeze({view:VIEW,definition:next,source_sha256:SOURCE_SHA256,patched_sha256:sha(next),transport_changes:false});
}
function buildMigration(source){
 const candidate=patchDefinition(source);
 return `-- Growth read-only health query: no transport, data or permission change.
DO $health_performance$
DECLARE previous text;
BEGIN
 PERFORM pg_catalog.set_config('lock_timeout','500ms',true);
 PERFORM pg_catalog.set_config('search_path','pg_catalog,public',true);
 IF pg_catalog.to_regclass('${VIEW}') IS NULL THEN RAISE EXCEPTION 'SES_HEALTH_VIEW_MISSING'; END IF;
 -- Acquire the view's normal read lock without evaluating its payload. It lasts
 -- through this transaction, preventing DDL drift between hash check and replace;
 -- underlying source tables only receive read locks, compatible with writes.
 PERFORM 1 FROM ${VIEW} LIMIT 0;
 SELECT pg_catalog.pg_get_viewdef('${VIEW}'::regclass,true) INTO previous;
 IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(previous,'UTF8')),'hex') IS DISTINCT FROM '${SOURCE_SHA256}' THEN
  RAISE EXCEPTION 'SES_HEALTH_SOURCE_DRIFT';
 END IF;
 EXECUTE $health_view$CREATE OR REPLACE VIEW ${VIEW} AS ${candidate.definition}$health_view$;
END $health_performance$;\n`;
}
module.exports={SOURCE_SHA256,VIEW,patchDefinition,buildMigration};
