'use strict';
// Private database primitive. The future authenticated admission owns the
// transaction and all authorization. This module creates no host or write path.
const M=require('./ab-audience-material.cjs');
const VERSION='crm-ab-audience-material-read-v1',ENABLED=false;
const FLAGS=Object.freeze({authorizes_selection:false,authorizes_send:false,execution_blocked:true,external_dependencies_complete:false});
const fail=code=>Object.assign(Error(code),{code});
const positive=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const SQL=Object.freeze({
 boundary:`SELECT pg_catalog.current_setting('transaction_isolation') AS isolation,
 pg_catalog.current_setting('session_replication_role') AS replication_role,
 pg_catalog.current_setting('TimeZone') AS timezone,
 pg_catalog.current_setting('DateStyle') AS date_style,
 (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='statement_timeout') AS timeout_ms,
 (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='lock_timeout') AS lock_ms,
 pg_catalog.pg_backend_pid() AS pid,pg_catalog.pg_current_xact_id()::text AS xid,pg_catalog.clock_timestamp() AS now`,
 foreignKeys:`SELECT child.relname AS child,con.convalidated,con.condeferrable,
 ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.n ORDER BY k.ord) AS child_columns,
 ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.n ORDER BY k.ord) AS parent_columns,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgconstraint=con.oid AND t.tgenabled NOT IN('O','A')) AS triggers_enabled,
 EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgconstraint=con.oid AND t.tgrelid=con.conrelid AND t.tgisinternal AND (t.tgtype & 4)=4 AND t.tgenabled IN('O','A')) AS insert_guard,
 EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgconstraint=con.oid AND t.tgrelid=con.conrelid AND t.tgisinternal AND (t.tgtype & 16)=16 AND t.tgenabled IN('O','A')) AS update_guard
 FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class child ON child.oid=con.conrelid
 WHERE con.contype='f' AND con.confrelid='public.campaigns'::regclass
 AND con.conrelid=ANY(ARRAY['public.campaign_lists'::regclass,'public.campaign_media'::regclass])`,
 campaigns:'SELECT * FROM crm_audience_v2.ab_material_campaigns($1::integer[])',
 listLinks:'SELECT * FROM crm_audience_v2.ab_material_list_links($1::integer[])',
 mediaLinks:'SELECT * FROM crm_audience_v2.ab_material_media_links($1::integer[])',
 lists:'SELECT * FROM crm_audience_v2.ab_material_lists($1::integer[])',
 templates:'SELECT * FROM crm_audience_v2.ab_material_templates($1::integer[])',
 media:'SELECT * FROM crm_audience_v2.ab_material_media($1::integer[])',
 snapshots:`WITH docs AS MATERIALIZED (
 SELECT c.id,jsonb_build_object('campaign',to_jsonb(c),'template',to_jsonb(t),
 'lists',coalesce((SELECT jsonb_agg(jsonb_build_object('relation',to_jsonb(cl),'list',to_jsonb(l)) ORDER BY cl.list_id)
 FROM public.campaign_lists cl LEFT JOIN public.lists l ON l.id=cl.list_id WHERE cl.campaign_id=c.id),'[]'::jsonb),
 'media',coalesce((SELECT jsonb_agg(jsonb_build_object('relation',to_jsonb(cm),'media',to_jsonb(m)) ORDER BY cm.media_id,cm.filename)
 FROM public.campaign_media cm LEFT JOIN public.media m ON m.id=cm.media_id WHERE cm.campaign_id=c.id),'[]'::jsonb)) AS snapshot
 FROM public.campaigns c LEFT JOIN public.templates t ON t.id=c.template_id WHERE c.id=ANY($1::integer[]))
 SELECT id,CASE WHEN pg_catalog.octet_length(snapshot::text)<=8388608 THEN snapshot::text ELSE NULL END AS snapshot_text FROM docs ORDER BY id`
});
function validBoundary(b){return b&&b.isolation==='read committed'&&b.replication_role==='origin'&&b.timezone==='UTC'&&b.date_style==='ISO, YMD'&&Number.isInteger(b.timeout_ms)&&b.timeout_ms>0&&b.timeout_ms<=30000&&Number.isInteger(b.lock_ms)&&b.lock_ms>0&&b.lock_ms<=500&&Number.isInteger(b.pid)&&b.pid>=0&&b.pid<=2147483647&&typeof b.xid==='string'&&/^\d+$/.test(b.xid);}
function validForeignKeys(rows){return ['campaign_lists','campaign_media'].every(name=>rows.some(r=>r.child===name&&r.convalidated===true&&r.condeferrable===false&&r.triggers_enabled===true&&r.insert_guard===true&&r.update_guard===true&&Array.isArray(r.child_columns)&&r.child_columns.length===1&&r.child_columns[0]==='campaign_id'&&Array.isArray(r.parent_columns)&&r.parent_columns.length===1&&r.parent_columns[0]==='id'));}
async function readCampaignMaterials({query,brand,campaignIds,signal,timeoutMs=25000}={}){
 if(typeof query!=='function'||!['fish','aristo'].includes(brand)||!Array.isArray(campaignIds)||campaignIds.length<1||campaignIds.length>2||campaignIds.some(id=>!positive(id))||new Set(campaignIds).size!==campaignIds.length||!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000||signal!==undefined&&!(signal instanceof AbortSignal))throw fail('AB_MATERIAL_READ_INPUT');
 const ids=[...campaignIds].sort((a,b)=>a-b),controller=new AbortController();let timer,abort;
 const active=()=>{if(controller.signal.aborted)throw fail(signal?.aborted?'AB_MATERIAL_READ_ABORTED':'AB_MATERIAL_READ_TIMEOUT');};
 const ask=async(q,v=[])=>{active();const r=await query(q,v,{signal:controller.signal});active();if(!Array.isArray(r?.rows))throw fail('AB_MATERIAL_READ_UNCONFIRMED');return r.rows;};
 const dependencies=async(q,ids)=>{if(ids.some(x=>!positive(x)))throw fail('AB_MATERIAL_READ_UNCONFIRMED');const unique=[...new Set(ids)].sort((a,b)=>a-b),rows=await ask(q,[unique]);if(rows.length!==unique.length||rows.some((r,i)=>r.id!==unique[i]))throw fail('AB_MATERIAL_READ_UNCONFIRMED');};
 const capture=async()=>{const rows=await ask(SQL.snapshots,[ids]);if(rows.length!==ids.length||rows.some((r,i)=>r.id!==ids[i]||typeof r.snapshot_text!=='string'))throw fail('AB_MATERIAL_READ_UNCONFIRMED');return rows.map(r=>M.materialize(M.parseDatabaseSnapshot(r.snapshot_text),{brand,campaignId:r.id}));};
 async function work(){
  const before=(await ask(SQL.boundary))[0];if(!validBoundary(before))throw fail('AB_MATERIAL_READ_BOUNDARY');
  if(!validForeignKeys(await ask(SQL.foreignKeys)))throw fail('AB_MATERIAL_READ_FOREIGN_KEYS');
  const campaigns=await ask(SQL.campaigns,[ids]);if(campaigns.length!==ids.length||campaigns.some((c,i)=>c.id!==ids[i]||!positive(c.template_id)))throw fail('AB_MATERIAL_READ_UNCONFIRMED');
  const listLinks=await ask(SQL.listLinks,[ids]),mediaLinks=await ask(SQL.mediaLinks,[ids]);
  if(listLinks.length+mediaLinks.length>1000||listLinks.some(x=>!ids.includes(x.campaign_id))||mediaLinks.some(x=>!ids.includes(x.campaign_id)))throw fail('AB_MATERIAL_READ_UNCONFIRMED');
  await dependencies(SQL.lists,listLinks.map(x=>x.list_id));await dependencies(SQL.templates,campaigns.map(x=>x.template_id));await dependencies(SQL.media,mediaLinks.map(x=>x.media_id));
  const materials=await capture(),check=await capture();if(materials.some((m,i)=>m.material_hash!==check[i].material_hash))throw fail('AB_MATERIAL_READ_DRIFT');
  if(!validForeignKeys(await ask(SQL.foreignKeys)))throw fail('AB_MATERIAL_READ_FOREIGN_KEYS');
  const after=(await ask(SQL.boundary))[0];if(!validBoundary(after)||after.pid!==before.pid||after.xid!==before.xid)throw fail('AB_MATERIAL_READ_BOUNDARY');
  const time=after.now instanceof Date?after.now.getTime():typeof after.now==='string'?Date.parse(after.now):NaN;if(!Number.isFinite(time))throw fail('AB_MATERIAL_READ_UNCONFIRMED');
  return Object.freeze({contract:VERSION,brand,checked_at:new Date(time).toISOString(),materials:Object.freeze(materials),...FLAGS});
 }
 if(signal?.aborted)throw fail('AB_MATERIAL_READ_ABORTED');
 const cancelled=new Promise((_,reject)=>{abort=()=>{controller.abort();reject(fail('AB_MATERIAL_READ_ABORTED'));};signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>{controller.abort();reject(fail('AB_MATERIAL_READ_TIMEOUT'));},timeoutMs);});
 try{return await Promise.race([work(),cancelled]);}catch(e){throw fail(['AB_MATERIAL_READ_BOUNDARY','AB_MATERIAL_READ_FOREIGN_KEYS','AB_MATERIAL_READ_UNCONFIRMED','AB_MATERIAL_READ_DRIFT','AB_MATERIAL_READ_TIMEOUT','AB_MATERIAL_READ_ABORTED'].includes(e?.code)?e.code:'AB_MATERIAL_READ_UNCONFIRMED');}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}
module.exports={VERSION,ENABLED,FLAGS,SQL,validBoundary,validForeignKeys,readCampaignMaterials};
