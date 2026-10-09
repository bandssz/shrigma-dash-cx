'use strict';
const crypto=require('node:crypto');
const {isProxy}=require('node:util').types;
const PURPOSE='crm.scheduler-state-read';
const RESOURCE=Object.freeze({project:'comunicacao',service:'postgres',host:'comunicacao_postgres',port:5432,database:'listmonk',network:'easypanel'});
const BEGIN='BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',ROLLBACK='ROLLBACK';
const EXPECTED_SELECTION_QUERY='084a9493713b21b618d24daae98b38db59fb84febf0c367914bea1ed7aa84c2d';
const H=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,NIL_UUID='00000000-0000-0000-0000-000000000000';
const canonical=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const resourceHash=sha(canonical(RESOURCE));
const own=new WeakSet();
function error(code,status=503){const e=Object.assign(Error(code),{code,status});own.add(e);return e;}
function object(v,keys){
 if(!v||isProxy(v)||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');
 const names=Reflect.ownKeys(v);if(names.length!==keys.length||names.some(k=>typeof k!=='string'||!keys.includes(k)))throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');
 const copy={};for(const k of names){const d=Object.getOwnPropertyDescriptor(v,k);if(!d?.enumerable||!Object.hasOwn(d,'value'))throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');copy[k]=d.value;}return copy;
}
// Compare PostgreSQL JSON timestamps at microsecond precision. Date.parse
// alone truncates fractions and can misclassify an exact lease deadline.
function timestamp(x){
 if(typeof x!=='string')return null;const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(x);if(!m)return null;
 const year=+m[1],month=+m[2],day=+m[3],hour=+m[4],minute=+m[5],second=+m[6],offsetHour=+(m[10]||0),offsetMinute=+(m[11]||0);
 if(month<1||month>12||day<1||day>31||hour>23||minute>59||second>59||offsetHour>23||offsetMinute>59)return null;
 const d=new Date(0);d.setUTCFullYear(year,month-1,day);d.setUTCHours(hour,minute,second,0);if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day)return null;
 const offset=(offsetHour*60+offsetMinute)*(m[9]==='-'?-1:1);return BigInt(d.getTime()-offset*60000)*1000n+BigInt((m[7]||'').padEnd(6,'0'));
}
const iso=x=>timestamp(x)!==null;
function bounded(p,ms,code='SCHEDULER_STATE_TIMEOUT'){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(error(code)),ms);})]).finally(()=>clearTimeout(timer));}
// Metadata is inspected before references to private relations are executed.
// Only pg_catalog and the closed three-relation set are used here.
const CATALOG_SQL=`WITH expected(relation,name) AS (VALUES
 ('deployment','regular_worker_deployment'),('lease','regular_worker_lease'),('selection','selection_runtime'))
SELECT e.relation,c.relkind::text AS kind,
 CASE WHEN c.oid IS NULL THEN false ELSE pg_catalog.has_schema_privilege(n.oid,'USAGE') AND pg_catalog.has_table_privilege(c.oid,'SELECT') END AS readable,
 COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',a.attname,'oid',a.atttypid::integer,'typmod',a.atttypmod) ORDER BY a.attnum)
 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 AND ((e.relation='deployment' AND a.attname IN ('singleton','enabled','worker_sha256','runtime_sha256','query_sha256','database_role','approved_at','approved_by','topology_receipt_sha256'))
  OR (e.relation='lease' AND a.attname IN ('singleton','instance_id','worker_sha256','runtime_sha256','database_role','heartbeat_at','expires_at','suspended','suspension_reason'))
  OR (e.relation='selection' AND a.attname IN ('singleton','enabled','candidate_query_sha256','verified_at')))),'[]'::jsonb) AS columns
FROM expected e LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='crm_audience_v2'
LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=e.name
WHERE pg_catalog.current_database()='listmonk' ORDER BY e.relation`;
const READ_SQL=`WITH at AS (SELECT pg_catalog.statement_timestamp() AS at)
SELECT pg_catalog.jsonb_build_object(
 'checkedAt',at.at,
 'deployment',pg_catalog.jsonb_build_object('present',d.singleton IS NOT NULL,'enabled',d.enabled,
  'approvalPresent',d.worker_sha256 IS NOT NULL AND d.runtime_sha256 IS NOT NULL AND d.query_sha256 IS NOT NULL AND d.database_role IS NOT NULL AND d.approved_at IS NOT NULL AND pg_catalog.isfinite(d.approved_at) AND d.approved_by IS NOT NULL AND pg_catalog.length(d.approved_by)>0 AND d.topology_receipt_sha256 IS NOT NULL,
  'approvalTiming',CASE WHEN d.approved_at IS NULL THEN 'missing' WHEN d.approved_at>at.at THEN 'future' ELSE 'effective' END,
  'queryExpected',d.query_sha256='${EXPECTED_SELECTION_QUERY}'),
 'storedIdentity',CASE WHEN l.singleton IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object('instanceId',l.instance_id,'workerSha256',l.worker_sha256,'runtimeSha256',l.runtime_sha256,'heartbeatAt',l.heartbeat_at,'expiresAt',l.expires_at) END,
 'lease',pg_catalog.jsonb_build_object('present',l.singleton IS NOT NULL,
  'live',CASE WHEN l.singleton IS NULL THEN NULL ELSE l.heartbeat_at<=at.at AND l.expires_at>at.at END,
  'suspended',l.suspended,'reason',l.suspension_reason),
 'deploymentLeaseMatch',pg_catalog.jsonb_build_object('worker',d.worker_sha256=l.worker_sha256,'runtime',d.runtime_sha256=l.runtime_sha256,'databaseRole',d.database_role=l.database_role),
 'selection',pg_catalog.jsonb_build_object('present',s.singleton IS NOT NULL,'enabled',s.enabled,'queryExpected',s.candidate_query_sha256='${EXPECTED_SELECTION_QUERY}','verifiedAt',s.verified_at)) AS payload
FROM at LEFT JOIN crm_audience_v2.regular_worker_deployment d ON d.singleton
LEFT JOIN crm_audience_v2.regular_worker_lease l ON l.singleton
LEFT JOIN crm_audience_v2.selection_runtime s ON s.singleton
WHERE pg_catalog.current_database()='listmonk'`;

// Closed scanner dependency contract. SQL is generated only from these public
// constants; no caller SQL, role, function, campaign or projection is accepted.
const SCANNER_COLUMNS=Object.freeze({
 campaigns:{id:23,uuid:2950,name:25,subject:25,from_email:25,body:25,body_source:25,altbody:25,content_type:'enum',send_at:1184,headers:3802,status:'enum',tags:'string-array',type:'enum',messenger:25,template_id:23,to_send:23,sent:23,max_subscriber_id:23,last_subscriber_id:23,archive:16,archive_slug:25,archive_template_id:23,archive_meta:3802,started_at:1184,created_at:1184,updated_at:1184,attribs:3802},
 templates:{id:23,body:25,is_default:16},campaign_media:{campaign_id:23,media_id:23},campaign_lists:{campaign_id:23,list_id:23},lists:{id:23,optin:'enum'},subscriber_lists:{list_id:23,subscriber_id:23,status:'enum'},subscribers:{id:23,status:'enum'}
});
for(const v of Object.values(SCANNER_COLUMNS))Object.freeze(v);
const UPDATE_COLUMNS=Object.freeze(['sent','to_send','status','max_subscriber_id','started_at']);
const SCANNER_FUNCTIONS=Object.freeze(['selection_worker_context','selection_regular_matches','campaign_binding_effective']);
const SHAPE_LIMIT=1000,JSON_SHAPE_LIMIT=65536;
const quote=x=>"'"+x.replace(/'/g,"''")+"'";
const requiredValues=Object.entries(SCANNER_COLUMNS).flatMap(([r,cols])=>Object.entries(cols).map(([c,t])=>`(${quote(r)},${quote(c)},${quote(String(t))})`)).join(',\n ');
const DEPENDENCY_SQL=`WITH worker AS (
 SELECT r.oid FROM (VALUES(1)) x(v) LEFT JOIN crm_audience_v2.regular_worker_deployment d ON d.singleton
 LEFT JOIN pg_catalog.pg_roles r ON r.rolname=d.database_role),
 required(relation,column_name,expected) AS (VALUES ${requiredValues}),
 rel AS (SELECT DISTINCT relation FROM required),
 columns AS (
 SELECT e.relation,e.column_name,a.attnum IS NOT NULL AS present,
 CASE WHEN a.attnum IS NULL THEN false
 WHEN e.expected='enum' THEN (t.typtype='e' OR a.atttypid IN(25,1043,1042)) AND
 (t.typtype!='e' OR NOT EXISTS (SELECT 1 FROM (VALUES
 ('campaigns','status','running'),('campaigns','status','scheduled'),('campaigns','type','optin'),('lists','optin','double'),
 ('subscriber_lists','status','confirmed'),('subscriber_lists','status','unconfirmed'),('subscriber_lists','status','unsubscribed'),('subscribers','status','blocklisted')) literals(relation,column_name,label)
 WHERE literals.relation=e.relation AND literals.column_name=e.column_name AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_enum en WHERE en.enumtypid=a.atttypid AND en.enumlabel=literals.label)))
 WHEN e.expected='string-array' THEN a.atttypid IN(1009,1015)
 ELSE a.atttypid=e.expected::oid AND a.atttypmod=-1 END AS compatible,
 CASE WHEN a.attnum IS NULL THEN false ELSE pg_catalog.has_schema_privilege(n.oid,'USAGE') AND pg_catalog.has_column_privilege(c.oid,a.attnum,'SELECT') END AS reader_select,
 CASE WHEN worker.oid IS NULL THEN NULL WHEN a.attnum IS NULL THEN false ELSE pg_catalog.has_schema_privilege(worker.oid,n.oid,'USAGE') AND pg_catalog.has_column_privilege(worker.oid,c.oid,a.attnum,'SELECT') END AS worker_select,
 CASE WHEN e.relation='campaigns' AND e.column_name IN('sent','to_send','status','max_subscriber_id','started_at') THEN CASE WHEN worker.oid IS NULL THEN NULL WHEN a.attnum IS NULL THEN false ELSE pg_catalog.has_schema_privilege(worker.oid,n.oid,'USAGE') AND pg_catalog.has_column_privilege(worker.oid,c.oid,a.attnum,'UPDATE') END ELSE NULL END AS worker_update
 FROM required e CROSS JOIN worker LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'
 LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=e.relation
 LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=e.column_name AND a.attnum>0 AND NOT a.attisdropped
 LEFT JOIN pg_catalog.pg_type t ON t.oid=a.atttypid),
 functions(name,args,return_kind) AS (VALUES ('selection_worker_context','23','jsonb'),('selection_regular_matches','3802 23','boolean'),('campaign_binding_effective','23','binding'))
SELECT pg_catalog.jsonb_build_object('workerRoleKnown',worker.oid IS NOT NULL,
 'relations',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',rel.relation,'present',c.oid IS NOT NULL,
 'kind',CASE WHEN c.oid IS NULL THEN 'absent' WHEN c.relkind='r' THEN 'table' ELSE 'other' END,
 'rowSecurity',c.relrowsecurity,'forcedRowSecurity',c.relforcerowsecurity,
 'allCampaignColumnsSelect',CASE WHEN rel.relation!='campaigns' OR worker.oid IS NULL THEN NULL WHEN c.oid IS NULL THEN false ELSE pg_catalog.has_schema_privilege(worker.oid,n.oid,'USAGE') AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND NOT pg_catalog.has_column_privilege(worker.oid,c.oid,a.attnum,'SELECT')) END,
 'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',v.column_name,'present',v.present,'typeCompatible',v.compatible,'readerSelect',v.reader_select,'workerSelect',v.worker_select,'workerUpdate',v.worker_update) ORDER BY v.column_name) FROM columns v WHERE v.relation=rel.relation)) ORDER BY rel.relation)
 FROM rel LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public' LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=rel.relation),
 'functions',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',f.name,'present',p.oid IS NOT NULL,
 'signatureCompatible',COALESCE(CASE WHEN p.oid IS NULL THEN false ELSE p.prokind='f' AND CASE WHEN f.return_kind='jsonb' THEN p.prorettype=3802 AND NOT p.proretset WHEN f.return_kind='boolean' THEN p.prorettype=16 AND NOT p.proretset ELSE p.proretset AND p.prorettype=(SELECT c.reltype FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='crm_audience_v2' AND c.relname='campaign_binding') END END,false),
 'workerExecute',CASE WHEN worker.oid IS NULL THEN NULL WHEN p.oid IS NULL THEN false ELSE pg_catalog.has_schema_privilege(worker.oid,n.oid,'USAGE') AND pg_catalog.has_function_privilege(worker.oid,p.oid,'EXECUTE') END,
 'volatility',CASE p.provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable' WHEN 'v' THEN 'volatile' ELSE NULL END,'securityDefiner',p.prosecdef) ORDER BY f.name)
 FROM functions f LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='crm_audience_v2'
 LEFT JOIN pg_catalog.pg_proc p ON p.pronamespace=n.oid AND p.proname=f.name AND p.proargtypes::text=f.args),
 'activityCapability',pg_catalog.jsonb_build_object('readable',COALESCE((SELECT pg_catalog.has_table_privilege(c.oid,'SELECT') FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pg_catalog' AND c.relname='pg_stat_activity'),false),
 'visible',worker.oid IS NOT NULL AND (worker.oid=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR pg_catalog.pg_has_role(current_user,'pg_read_all_stats','USAGE')))) AS payload
FROM worker WHERE pg_catalog.current_database()='listmonk'`;
// Prospective superset: current manager IDs and helper context are deliberately
// not evaluated. Only shape booleans leave PG, never a JSON or string value.
const SHAPES_SQL=`WITH eligible AS MATERIALIZED (
 SELECT c.id,c.status::text AS state,c.attribs,c.headers,c.tags,
 (c.id IS NOT NULL AND c.uuid IS NOT NULL AND c.type IS NOT NULL AND c.name IS NOT NULL AND c.subject IS NOT NULL AND c.from_email IS NOT NULL AND c.body IS NOT NULL AND c.status IS NOT NULL AND c.content_type IS NOT NULL AND c.messenger IS NOT NULL AND c.archive IS NOT NULL AND c.sent IS NOT NULL AND c.to_send IS NOT NULL) AS scalars,
 ((c.send_at IS NULL OR pg_catalog.isfinite(c.send_at)) AND (c.started_at IS NULL OR pg_catalog.isfinite(c.started_at)) AND (c.created_at IS NULL OR pg_catalog.isfinite(c.created_at)) AND (c.updated_at IS NULL OR pg_catalog.isfinite(c.updated_at))) AS times
 FROM public.campaigns c WHERE c.status::text='running' OR (c.status::text='scheduled' AND pg_catalog.statement_timestamp()>=c.send_at)
 ORDER BY c.id LIMIT ${SHAPE_LIMIT+1}), sample AS MATERIALIZED (SELECT * FROM eligible ORDER BY id LIMIT ${SHAPE_LIMIT}),
 shapes AS (
 SELECT id,state,scalars,times,attribs IS NULL OR pg_catalog.jsonb_typeof(attribs) IN('object','null') AS attrs,
 CASE WHEN headers IS NULL OR pg_catalog.jsonb_typeof(headers)='null' THEN true WHEN pg_catalog.jsonb_typeof(headers)!='array' THEN false
 WHEN pg_catalog.octet_length(headers::text)>${JSON_SHAPE_LIMIT} OR pg_catalog.jsonb_array_length(headers)>256 THEN NULL
 ELSE NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(headers) e(v) WHERE pg_catalog.jsonb_typeof(e.v) NOT IN('object','null') OR
 EXISTS(SELECT 1 FROM pg_catalog.jsonb_each(CASE WHEN pg_catalog.jsonb_typeof(e.v)='object' THEN e.v ELSE '{}'::jsonb END) p(k,v) WHERE pg_catalog.jsonb_typeof(p.v) NOT IN('string','null'))) END AS hdrs,
 (tags IS NULL OR pg_catalog.cardinality(tags)=0 OR (pg_catalog.array_ndims(tags)=1 AND pg_catalog.array_lower(tags,1)=1 AND NOT EXISTS(SELECT 1 FROM pg_catalog.unnest(tags) v WHERE v IS NULL))) AS tags_ok
 FROM sample)
SELECT pg_catalog.jsonb_build_object('observedCount',(SELECT count(*)::integer FROM shapes),'truncated',(SELECT count(*)>${SHAPE_LIMIT} FROM eligible),
 'runningCount',(SELECT count(*)::integer FROM shapes WHERE state='running'),'dueCount',(SELECT count(*)::integer FROM shapes WHERE state='scheduled'),
 'attribsTopLevelIncompatible',(SELECT count(*)::integer FROM shapes WHERE NOT attrs),'headersIncompatible',(SELECT count(*)::integer FROM shapes WHERE hdrs=false),
 'headersUnknown',(SELECT count(*)::integer FROM shapes WHERE hdrs IS NULL),'tagsIncompatible',(SELECT count(*)::integer FROM shapes WHERE NOT tags_ok),
 'scalarNullIncompatible',(SELECT count(*)::integer FROM shapes WHERE NOT scalars),'timestampIncompatible',(SELECT count(*)::integer FROM shapes WHERE NOT times),
 'targets',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',t.id,'observed',s.id IS NOT NULL,'attribsTopLevelCompatible',s.attrs,'headersCompatible',s.hdrs,'tagsCompatible',s.tags_ok,'nonNullableScalarsCompatible',s.scalars,'finiteTimestampsCompatible',s.times) ORDER BY t.id) FROM (VALUES(171),(174)) t(id) LEFT JOIN shapes s ON s.id=t.id)) AS payload
WHERE pg_catalog.current_database()='listmonk'`;
// Prefix matches are evidence of visible fixed scanner text only. They are
// not full-query equality, execution success, attribution or a polling loop.
const ACTIVITY_SQL=`WITH worker AS (SELECT r.oid FROM crm_audience_v2.regular_worker_deployment d JOIN pg_catalog.pg_roles r ON r.rolname=d.database_role WHERE d.singleton),
 activity AS MATERIALIZED (SELECT a.state,a.wait_event_type,a.query_start,
 (pg_catalog.strpos(a.query,'WITH eligibleCamps AS MATERIALIZED (')>0 AND pg_catalog.strpos(a.query,'crm_audience_v2.selection_worker_context(id)')>0) AS prefix_match
 FROM pg_catalog.pg_stat_activity a JOIN worker w ON a.usesysid=w.oid WHERE a.datname=pg_catalog.current_database() AND a.pid!=pg_catalog.pg_backend_pid()),
 states AS (SELECT CASE state WHEN 'active' THEN 'active' WHEN 'idle' THEN 'idle' WHEN 'idle in transaction' THEN 'idle-in-transaction' WHEN 'idle in transaction (aborted)' THEN 'idle-aborted' WHEN 'fastpath function call' THEN 'fastpath' WHEN 'disabled' THEN 'disabled' ELSE 'unknown' END AS name FROM activity),
 waits AS (SELECT CASE wait_event_type WHEN 'Lock' THEN 'Lock' WHEN 'IO' THEN 'IO' WHEN 'LWLock' THEN 'LWLock' WHEN 'Client' THEN 'Client' WHEN 'IPC' THEN 'IPC' WHEN 'Timeout' THEN 'Timeout' WHEN 'Extension' THEN 'Extension' WHEN 'Activity' THEN 'Activity' WHEN 'BufferPin' THEN 'BufferPin' WHEN NULL THEN 'none' ELSE CASE WHEN wait_event_type IS NULL THEN 'none' ELSE 'unknown' END END AS name FROM activity)
SELECT pg_catalog.jsonb_build_object('connectionCount',(SELECT count(*)::integer FROM activity),'activeCount',(SELECT count(*)::integer FROM activity WHERE state='active'),
 'scannerPrefixMatchCount',(SELECT count(*)::integer FROM activity WHERE prefix_match AND state='active'),
 'scannerPrefixWaitingCount',(SELECT count(*)::integer FROM activity WHERE prefix_match AND state='active' AND wait_event_type IS NOT NULL),
 'maxPrefixAgeSeconds',(SELECT CASE WHEN count(*)=0 THEN NULL ELSE LEAST(86400,GREATEST(0,COALESCE(max(EXTRACT(epoch FROM pg_catalog.statement_timestamp()-query_start)),0)))::integer END FROM activity WHERE prefix_match AND state='active'),
 'ageCapped',(SELECT COALESCE(max(EXTRACT(epoch FROM pg_catalog.statement_timestamp()-query_start))>86400,false) FROM activity WHERE prefix_match AND state='active'),
 'states',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',name,'count',n) ORDER BY name),'[]'::jsonb) FROM (SELECT name,count(*)::integer AS n FROM states GROUP BY name) t),
 'waits',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',name,'count',n) ORDER BY name),'[]'::jsonb) FROM (SELECT name,count(*)::integer AS n FROM waits GROUP BY name) t)) AS payload
WHERE pg_catalog.current_database()='listmonk'`;
function validateDependencies(raw){
 const d=object(raw,['workerRoleKnown','relations','functions','activityCapability']),bool=x=>typeof x==='boolean',nb=x=>x===null||bool(x),bad=()=>{throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');};
 if(!bool(d.workerRoleKnown)||!Array.isArray(d.relations)||d.relations.length!==7||!Array.isArray(d.functions)||d.functions.length!==3)bad();const seen=new Set();
 const relations=d.relations.map(raw=>{const r=object(raw,['name','present','kind','rowSecurity','forcedRowSecurity','allCampaignColumnsSelect','columns']);if(!Object.hasOwn(SCANNER_COLUMNS,r.name)||seen.has(r.name)||!bool(r.present)||!['absent','table','other'].includes(r.kind)||r.present!==(r.kind!=='absent')||!nb(r.rowSecurity)||!nb(r.forcedRowSecurity)||!nb(r.allCampaignColumnsSelect)||!r.present&&(r.rowSecurity!==null||r.forcedRowSecurity!==null)||r.present&&(!bool(r.rowSecurity)||!bool(r.forcedRowSecurity))||!r.present&&r.allCampaignColumnsSelect===true||r.name!=='campaigns'&&r.allCampaignColumnsSelect!==null||(!d.workerRoleKnown&&r.allCampaignColumnsSelect!==null)||!Array.isArray(r.columns)||r.columns.length!==Object.keys(SCANNER_COLUMNS[r.name]).length)bad();seen.add(r.name);const cols=new Set();r.columns=Object.freeze(r.columns.map(raw=>{const c=object(raw,['name','present','typeCompatible','readerSelect','workerSelect','workerUpdate']);if(!Object.hasOwn(SCANNER_COLUMNS[r.name],c.name)||cols.has(c.name)||![c.present,c.typeCompatible,c.readerSelect].every(bool)||!nb(c.workerSelect)||!nb(c.workerUpdate)||!c.present&&(c.typeCompatible||c.readerSelect||c.workerSelect===true||c.workerUpdate===true)||!r.present&&c.present||(!d.workerRoleKnown&&(c.workerSelect!==null||c.workerUpdate!==null))||(d.workerRoleKnown&&!bool(c.workerSelect))||(!(r.name==='campaigns'&&UPDATE_COLUMNS.includes(c.name))&&c.workerUpdate!==null)||(d.workerRoleKnown&&r.name==='campaigns'&&UPDATE_COLUMNS.includes(c.name)&&!bool(c.workerUpdate)))bad();cols.add(c.name);return Object.freeze(c);}));return Object.freeze(r);});
 const fs=new Set(),functions=d.functions.map(raw=>{const f=object(raw,['name','present','signatureCompatible','workerExecute','volatility','securityDefiner']);if(!SCANNER_FUNCTIONS.includes(f.name)||fs.has(f.name)||!bool(f.present)||!bool(f.signatureCompatible)||!nb(f.workerExecute)||![null,'immutable','stable','volatile'].includes(f.volatility)||!nb(f.securityDefiner)||!f.present&&(f.signatureCompatible||f.workerExecute===true||f.volatility!==null||f.securityDefiner!==null)||f.present&&(f.volatility===null||!bool(f.securityDefiner))||!d.workerRoleKnown&&f.workerExecute!==null||d.workerRoleKnown&&!bool(f.workerExecute))bad();fs.add(f.name);return Object.freeze(f);});
 const cap=object(d.activityCapability,['readable','visible']);if(!Object.values(cap).every(bool)||!d.workerRoleKnown&&cap.visible)bad();return Object.freeze({workerRoleKnown:d.workerRoleKnown,relations:Object.freeze(relations),functions:Object.freeze(functions),activityCapability:Object.freeze(cap)});
}
function shapesGate(d){const c=d.relations.find(r=>r.name==='campaigns');return !c.present?'relation-missing':c.kind!=='table'||c.columns.some(x=>!x.present||!x.typeCompatible)?'schema-incompatible':c.rowSecurity||c.forcedRowSecurity?'row-security':c.columns.some(x=>!x.readerSelect)?'not-readable':'observed';}
function validateShapes(raw){
 const keys=['observedCount','truncated','runningCount','dueCount','attribsTopLevelIncompatible','headersIncompatible','headersUnknown','tagsIncompatible','scalarNullIncompatible','timestampIncompatible','targets'],s=object(raw,keys),bad=()=>{throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');};
 const count=x=>Number.isSafeInteger(x)&&x>=0&&x<=SHAPE_LIMIT;if(!keys.filter(k=>!['truncated','targets'].includes(k)).every(k=>count(s[k]))||typeof s.truncated!=='boolean'||s.runningCount+s.dueCount!==s.observedCount||s.headersIncompatible+s.headersUnknown>s.observedCount||s.truncated&&s.observedCount!==SHAPE_LIMIT||keys.filter(k=>k.endsWith('Incompatible')||k==='headersUnknown').some(k=>s[k]>s.observedCount)||!Array.isArray(s.targets)||s.targets.length!==2)bad();const seen=new Set();s.targets=Object.freeze(s.targets.map(raw=>{const t=object(raw,['id','observed','attribsTopLevelCompatible','headersCompatible','tagsCompatible','nonNullableScalarsCompatible','finiteTimestampsCompatible']);if(![171,174].includes(t.id)||seen.has(t.id)||typeof t.observed!=='boolean'||Object.entries(t).filter(([k])=>!['id','observed'].includes(k)).some(([k,v])=>t.observed?(k==='headersCompatible'?v!==null&&typeof v!=='boolean':typeof v!=='boolean'):v!==null))bad();seen.add(t.id);return Object.freeze(t);}));if(s.targets.filter(t=>t.observed).length>s.observedCount)bad();for(const [field,countName] of [['attribsTopLevelCompatible','attribsTopLevelIncompatible'],['headersCompatible','headersIncompatible'],['tagsCompatible','tagsIncompatible'],['nonNullableScalarsCompatible','scalarNullIncompatible'],['finiteTimestampsCompatible','timestampIncompatible']])if(s.targets.filter(t=>t.observed&&t[field]===false).length>s[countName])bad();if(s.targets.filter(t=>t.observed&&t.headersCompatible===null).length>s.headersUnknown)bad();return Object.freeze({status:'observed',limit:SHAPE_LIMIT,currentManagerIdsExcluded:false,helperContextEvaluated:false,...s});
}
const ACTIVITY_STATES=Object.freeze(['active','idle','idle-in-transaction','idle-aborted','fastpath','disabled','unknown']);
const ACTIVITY_WAITS=Object.freeze(['Lock','IO','LWLock','Client','IPC','Timeout','Extension','Activity','BufferPin','none','unknown']);
function validateActivity(raw){const a=object(raw,['connectionCount','activeCount','scannerPrefixMatchCount','scannerPrefixWaitingCount','maxPrefixAgeSeconds','ageCapped','states','waits']),bad=()=>{throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');};const count=x=>Number.isSafeInteger(x)&&x>=0&&x<=1000000;if(!['connectionCount','activeCount','scannerPrefixMatchCount','scannerPrefixWaitingCount'].every(k=>count(a[k]))||a.activeCount>a.connectionCount||a.scannerPrefixMatchCount>a.activeCount||a.scannerPrefixWaitingCount>a.scannerPrefixMatchCount||typeof a.ageCapped!=='boolean'||(a.scannerPrefixMatchCount===0?(a.maxPrefixAgeSeconds!==null||a.ageCapped):!Number.isSafeInteger(a.maxPrefixAgeSeconds)||a.maxPrefixAgeSeconds<0||a.maxPrefixAgeSeconds>86400)||a.ageCapped&&a.maxPrefixAgeSeconds!==86400)bad();for(const [k,names] of [['states',ACTIVITY_STATES],['waits',ACTIVITY_WAITS]]){if(!Array.isArray(a[k])||a[k].length>names.length)bad();const seen=new Set();a[k]=Object.freeze(a[k].map(raw=>{const v=object(raw,['name','count']);if(!names.includes(v.name)||seen.has(v.name)||!count(v.count)||v.count===0)bad();seen.add(v.name);return Object.freeze(v);}));if(a[k].reduce((n,v)=>n+v.count,0)!==a.connectionCount)bad();}if(a.states.filter(v=>v.name==='active').reduce((n,v)=>n+v.count,0)!==a.activeCount)bad();return Object.freeze({status:'observed',match:'fixed-prefix-only',snapshotOnly:true,...a});}


// v4: fixed original-selector diagnostic. No inputs control SQL or identity.
const SELECTOR_FUNCTIONS=Object.freeze([{"schema":"crm_audience_v2","name":"selection_worker_context","args":"23","returns":"jsonb","language":"plpgsql","volatility":"s","defaults":null,"searchPath":"pg_catalog","prosrcSha256":"6802a3a8625aced406e2dcddb16e45bb8789ebdd935d36e91910b7a1979d8577"},{"schema":"crm_audience_v2","name":"selection_regular_matches","args":"3802 23","returns":"bool","language":"plpgsql","volatility":"s","defaults":null,"searchPath":"pg_catalog","prosrcSha256":"8dc8935595ab2ae508f060c8a182a612ed15e352ef7c9f40ea323d74fa6ce20e"},{"schema":"crm_audience_v2","name":"campaign_binding_effective","args":"23","returns":"binding","language":"sql","volatility":"s","defaults":null,"searchPath":"pg_catalog","prosrcSha256":"7f248f14271e9c6bddd5b7252f6eacfbc4ca621f92075f001a85dfa209193dea"},{"schema":"crm_audience_v2","name":"selection_context","args":"23 25 16","returns":"jsonb","language":"plpgsql","volatility":"s","defaults":"false","searchPath":"pg_catalog","prosrcSha256":"d49ff9ab47a3a95fa2ba9dd9c4f100c6bb225620ece41068fec7818fff831aee"},{"schema":"crm_audience_v2","name":"selection_hash","args":"3802","returns":"text","language":"sql","volatility":"i","defaults":null,"searchPath":"pg_catalog","prosrcSha256":"089240bb4297eca50e831aa3e799f7d6985625d63b9a760faa2b739205cb2da2"},{"schema":"crm_audience_v2","name":"selection_canonical","args":"3802 23","returns":"text","language":"plpgsql","volatility":"i","defaults":"0","searchPath":"pg_catalog","prosrcSha256":"c4117375149ee494cee8f2c3e04f4325693ba2112e56bec904dab115442aac31"},{"schema":"crm_audience_v2","name":"selection_catalog_valid","args":"3802 25","returns":"bool","language":"plpgsql","volatility":"s","defaults":null,"searchPath":"pg_catalog","prosrcSha256":"b370d50e55a3fa03fe2b5787318b6001d3bc67dd214a4c230609854063745cb9"},{"schema":"crm_audience_v2","name":"selection_lists_valid","args":"25","returns":"bool","language":"sql","volatility":"s","defaults":null,"searchPath":"pg_catalog","prosrcSha256":"4880a6776dc0ea91d00812ab137179935978b4516134ad5e39e91bd281904608"},{"schema":"crm_audience_v2","name":"selection_utf16_length","args":"25","returns":"int","language":"sql","volatility":"i","defaults":null,"searchPath":"pg_catalog","prosrcSha256":"10eb0603c61421438ff34ee16db8c81c7a5bd77dfae031286eb4f69043d4f35e"},{"schema":"crm_audience_v2","name":"selection_rule","args":"3802 23 25 23 3802","returns":"jsonb","language":"plpgsql","volatility":"s","defaults":"1, NULL::jsonb","searchPath":"pg_catalog","prosrcSha256":"ef1d827d9ff90bbef87619d8dd6c32200b41b6a4d801cc8816f09c371dbaa5a0"},{"schema":"crm_audience_v2","name":"selection_engagement_source_hash","args":"25 25","returns":"text","language":"sql","volatility":"i","defaults":null,"searchPath":"pg_catalog","prosrcSha256":"92ecbbf7a7368a23de29a8a6e0018090ce97ee82ff3d889f415aae7926aae0fd"},{"schema":"crm_audience_v2","name":"selection_engagement_match","args":"3802 23 25","returns":"bool","language":"plpgsql","volatility":"s","defaults":null,"searchPath":"pg_catalog","prosrcSha256":"e54a91efee63bc915c4c7510587803ab9d70df35fe6c85e631ba3066e5f7d77f"},{"schema":"crm_audience_v2","name":"selection_regular_rule_match","args":"3802 1007 23 25","returns":"bool","language":"plpgsql","volatility":"s","defaults":null,"searchPath":"pg_catalog","prosrcSha256":"6a978564f49a971675eaa8a60a529aa3e6a175c90c21f81ef249017a09382932"},{"schema":"public","name":"shrigma_campaign_list_brand","args":"lists","returns":"text","language":"sql","volatility":"s","defaults":null,"searchPath":null,"prosrcSha256":"abe40c47221a72e26b885d0f3cd1adb2544320d845de10f22dd05327b0dd4fc6"}].map(Object.freeze));
const SELECTOR_RELATIONS=Object.freeze([{"schema":"public","name":"campaigns"},{"schema":"public","name":"templates"},{"schema":"public","name":"campaign_media"},{"schema":"public","name":"campaign_lists"},{"schema":"public","name":"lists"},{"schema":"public","name":"subscriber_lists"},{"schema":"public","name":"subscribers"},{"schema":"public","name":"campaign_views"},{"schema":"public","name":"link_clicks"},{"schema":"crm_audience_v2","name":"campaign_binding"},{"schema":"crm_audience_v2","name":"campaign_binding_release"},{"schema":"crm_audience_v2","name":"campaign_binding_revision"},{"schema":"crm_audience_v2","name":"revision"},{"schema":"crm_audience_v2","name":"config"},{"schema":"crm_audience_v2","name":"audience"},{"schema":"crm_audience_v2","name":"selection_timezone"},{"schema":"crm_audience_v2","name":"selection_runtime"}].map(Object.freeze));
const SELECTOR_SQL="WITH eligibleCamps AS MATERIALIZED (\n    -- Get all running campaigns and their template bodies (if the template's deleted, the default template body instead)\n    SELECT campaigns.*, COALESCE(templates.body, (SELECT body FROM public.templates WHERE is_default = true LIMIT 1), '') AS template_body\n    FROM public.campaigns\n    LEFT JOIN public.templates ON (templates.id = campaigns.template_id)\n    WHERE (status='running' OR (status='scheduled' AND NOW() >= campaigns.send_at))\n    AND campaigns.id IN (171,174)\n    AND NOT(campaigns.id = ANY(ARRAY[]::INT[]))\n),\naudienceContexts AS MATERIALIZED (\n    SELECT id, crm_audience_v2.selection_worker_context(id) AS context FROM eligibleCamps\n),\ncamps AS MATERIALIZED (\n    SELECT eligibleCamps.* FROM eligibleCamps JOIN audienceContexts USING (id) WHERE context IS NOT NULL\n),\ncampLists AS (\n    -- Get the list_ids and their optin statuses for the campaigns found in the previous step.\n    SELECT lists.id AS list_id, campaign_id, optin FROM public.lists\n    INNER JOIN public.campaign_lists ON (campaign_lists.list_id = lists.id)\n    WHERE campaign_lists.campaign_id = ANY(SELECT id FROM camps)\n),\ncampMedia AS (\n    -- Get the list_ids and their optin statuses for the campaigns found in the previous step.\n    SELECT campaign_id, ARRAY_AGG(campaign_media.media_id)::INT[] AS media_id FROM public.campaign_media\n    WHERE campaign_id = ANY(SELECT id FROM camps) AND media_id IS NOT NULL\n    GROUP BY campaign_id\n),\neligibleCounts AS (\n    SELECT camps.id AS campaign_id, COUNT(DISTINCT sl.subscriber_id) AS to_send, COALESCE(MAX(sl.subscriber_id), 0) AS max_subscriber_id\n    FROM camps\n    JOIN audienceContexts ac ON ac.id = camps.id\n    JOIN campLists cl ON cl.campaign_id = camps.id\n    JOIN public.subscriber_lists sl ON sl.list_id = cl.list_id\n        AND (\n            CASE\n                WHEN camps.type = 'optin' THEN sl.status = 'unconfirmed' AND cl.optin = 'double'\n                WHEN cl.optin = 'double' THEN sl.status = 'confirmed'\n                ELSE sl.status != 'unsubscribed'\n            END\n        )\n    JOIN public.subscribers s ON (s.id = sl.subscriber_id AND s.status != 'blocklisted')\n        AND crm_audience_v2.selection_regular_matches(ac.context, s.id)\n    GROUP BY camps.id\n),\ncounts AS (\n    SELECT * FROM eligibleCounts\n    UNION ALL\n    SELECT camps.id AS campaign_id, 0::bigint AS to_send, 0::integer AS max_subscriber_id\n    FROM camps\n    WHERE EXISTS (SELECT 1 FROM crm_audience_v2.campaign_binding_effective(camps.id))\n        AND NOT EXISTS (SELECT 1 FROM eligibleCounts e WHERE e.campaign_id = camps.id)\n),\nprojections AS MATERIALIZED (\n SELECT camps.id,ac.context->'bound'='true'::jsonb AS bound,\n (camps.template_body IS NOT NULL AND pg_typeof(camps.template_body)='text'::regtype) AS template_ok,\n (cm.media_id IS NULL OR (pg_typeof(cm.media_id)='integer[]'::regtype AND array_ndims(cm.media_id)=1 AND array_lower(cm.media_id,1)=1 AND NOT EXISTS(SELECT 1 FROM unnest(cm.media_id) x WHERE x IS NULL))) AS media_ok,\n co.campaign_id IS NOT NULL AS count_present,co.to_send,\n co.to_send BETWEEN 0 AND 2147483647 AS count_int32,co.max_subscriber_id\n FROM camps JOIN audienceContexts ac USING(id) LEFT JOIN campMedia cm ON cm.campaign_id=camps.id LEFT JOIN counts co ON co.campaign_id=camps.id)\nSELECT pg_catalog.jsonb_build_object('checkedAt',pg_catalog.statement_timestamp(),\n 'targets',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',t.id,'eligible',e.id IS NOT NULL,'contextReady',CASE WHEN e.id IS NULL THEN NULL ELSE ac.context IS NOT NULL END,\n 'bound',p.bound,'templateCompatible',p.template_ok,'mediaCompatible',p.media_ok,'countPresent',p.count_present,\n 'countWithinInt32',p.count_int32,'eligibleCount',CASE WHEN p.count_int32 THEN p.to_send::integer ELSE NULL END,'cursorCompatible',p.max_subscriber_id BETWEEN 0 AND 2147483647) ORDER BY t.id)\n FROM (VALUES(171),(174)) t(id) LEFT JOIN eligibleCamps e ON e.id=t.id LEFT JOIN audienceContexts ac ON ac.id=t.id LEFT JOIN projections p ON p.id=t.id)) AS payload\nWHERE pg_catalog.current_database()='listmonk'";
const SEND_GUARD_HASHES=Object.freeze({"draft-only": "58101464bdbc4114ab77de6ba80a7a9a5d08ef4af0c24a647ef9767b15c4b6f9", "operation": "d5f7824666845e72bc53218a2c332988c2d2001f9c9dd374cf7c1d3e2a835d83"});

const SELECTOR_EXTRA_COLUMNS=Object.freeze({"public.lists":{"name":"25","tags":"1009|1015","status":"enum"},"public.campaign_views":{"subscriber_id":"23","campaign_id":"23","created_at":"1184"},"public.link_clicks":{"subscriber_id":"23","campaign_id":"23","created_at":"1184"},"crm_audience_v2.campaign_binding":{"campaign_id":"23","binding_version":"23","brand":"25","audience_id":"2950","audience_revision":"23","definition_hash":"25","context_hash":"25","base_list_id":"23","catalog_hash":"25","binding":"3802","binding_hash":"25","campaign_version":"25"},"crm_audience_v2.campaign_binding_release":{"campaign_id":"23","binding_version":"23","binding_hash":"25"},"crm_audience_v2.campaign_binding_revision":{"campaign_id":"23","binding_version":"23","binding":"3802","binding_hash":"25"},"crm_audience_v2.revision":{"audience_id":"2950","version":"23","archived":"16","definition":"3802","context":"3802","definition_hash":"25","context_hash":"25"},"crm_audience_v2.config":{"brand":"25","enabled":"16","base_list_id":"23","catalog":"3802","checked_at":"1184","expires_at":"1184"},"crm_audience_v2.audience":{"id":"2950","brand":"25","archived":"16"},"crm_audience_v2.selection_timezone":{"name":"25"},"crm_audience_v2.selection_runtime":{"singleton":"16","enabled":"16","candidate_query_sha256":"25","verified_at":"1184"}});
const selectorColumns=Object.entries(SELECTOR_EXTRA_COLUMNS).flatMap(([relation,cols])=>Object.entries(cols).map(([name,type])=>`(${quote(relation)},${quote(name)},${quote(type)})`)).join(",");
const PURE_PIN_FIELDS=Object.freeze(["kind", "support", "strict", "leakproof", "security", "volatility", "language", "returnSet", "returnType", "defaultCount", "defaultExpression", "searchPath", "singleOverload", "body"]);
const SELECTOR_BODY_BYTES=Object.freeze({"selection_canonical":996,"selection_utf16_length":93,"selection_engagement_source_hash":439,"campaign_binding_effective":267,"shrigma_campaign_list_brand":486,"selection_hash":89,"selection_catalog_valid":3372,"selection_lists_valid":295,"selection_engagement_match":1734,"selection_rule":3128,"selection_context":5118,"selection_regular_rule_match":875,"selection_regular_matches":957,"selection_worker_context":581});
const SEND_GUARD_BODY_BYTES=Object.freeze({"draft-only": 1063, "operation": 5494});
const SELECTOR_FENCE_SQL=`WITH expected(schema_name,name,args,returns,language,volatility,defaults,search_path,body_hash,body_bytes) AS (VALUES ${SELECTOR_FUNCTIONS.map(f=>`(${[f.schema,f.name,f.args,f.returns,f.language,f.volatility,f.defaults,f.searchPath,f.prosrcSha256,String(SELECTOR_BODY_BYTES[f.name])].map(v=>v===null?'NULL':quote(v)).join(',')})`).join(',')}),
 relations(schema_name,name) AS (VALUES ${SELECTOR_RELATIONS.map(r=>`(${quote(r.schema)},${quote(r.name)})`).join(',')}),
 required_columns(relation,name,type) AS (VALUES ${selectorColumns}),
 helper_flags AS (
 SELECT e.name,p.oid IS NOT NULL AS present,
 pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex') AS actual_hash,pg_catalog.octet_length(pg_catalog.convert_to(p.prosrc,'UTF8')) AS actual_bytes,
 COALESCE(p.oid IS NOT NULL AND (p.prokind='f'),false) AS "kind",
 COALESCE(p.oid IS NOT NULL AND (p.prosupport=0),false) AS "support",
 COALESCE(p.oid IS NOT NULL AND (NOT p.proisstrict),false) AS "strict",
 COALESCE(p.oid IS NOT NULL AND (NOT p.proleakproof),false) AS "leakproof",
 COALESCE(p.oid IS NOT NULL AND (NOT p.prosecdef),false) AS "security",
 COALESCE(p.oid IS NOT NULL AND (p.provolatile=e.volatility),false) AS "volatility",
 COALESCE(p.oid IS NOT NULL AND (l.lanname=e.language),false) AS "language",
 COALESCE(p.oid IS NOT NULL AND (p.proretset=(e.returns='binding')),false) AS "returnSet",
 COALESCE(p.oid IS NOT NULL AND (p.prorettype=CASE e.returns WHEN 'jsonb' THEN 3802 WHEN 'bool' THEN 16 WHEN 'text' THEN 25 WHEN 'int' THEN 23 ELSE (SELECT c.reltype FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='crm_audience_v2' AND c.relname='campaign_binding') END),false) AS "returnType",
 COALESCE(p.oid IS NOT NULL AND (p.pronargdefaults=CASE WHEN e.defaults IS NULL THEN 0 WHEN e.name='selection_rule' THEN 2 ELSE 1 END),false) AS "defaultCount",
 COALESCE(p.oid IS NOT NULL AND (pg_catalog.pg_get_expr(p.proargdefaults,0) IS NOT DISTINCT FROM e.defaults),false) AS "defaultExpression",
 COALESCE(p.oid IS NOT NULL AND (p.proconfig IS NOT DISTINCT FROM CASE WHEN e.search_path IS NULL THEN NULL::text[] ELSE ARRAY['search_path='||e.search_path] END),false) AS "searchPath",
 COALESCE(p.oid IS NOT NULL AND ((SELECT count(*)=1 FROM pg_catalog.pg_proc x WHERE x.pronamespace=n.oid AND x.proname=e.name)),false) AS "singleOverload",
 COALESCE(p.oid IS NOT NULL AND (pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex')=e.body_hash AND pg_catalog.octet_length(pg_catalog.convert_to(p.prosrc,'UTF8'))=e.body_bytes::integer),false) AS "body",
 CASE WHEN p.oid IS NULL THEN false ELSE pg_catalog.has_schema_privilege(n.oid,'USAGE') AND pg_catalog.has_function_privilege(p.oid,'EXECUTE') END AS executable
 FROM expected e LEFT JOIN pg_catalog.pg_namespace n ON n.nspname=e.schema_name
 LEFT JOIN pg_catalog.pg_proc p ON p.pronamespace=n.oid AND p.proname=e.name AND p.proargtypes::text=CASE WHEN e.args='lists' THEN (SELECT c.reltype::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='lists') ELSE e.args END
 LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang),
 helper AS (SELECT *,present AND "kind" AND "support" AND "strict" AND "leakproof" AND "security" AND "volatility" AND "language" AND "returnSet" AND "returnType" AND "defaultCount" AND "defaultExpression" AND "searchPath" AND "singleOverload" AND "body" AS pure_pin FROM helper_flags),
 relation_flags AS (
 SELECT e.name,c.oid IS NOT NULL AS present,COALESCE(c.relkind='r' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT EXISTS(SELECT 1 FROM required_columns q LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=q.name AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_catalog.pg_type typ ON typ.oid=a.atttypid WHERE q.relation=e.schema_name||'.'||e.name AND (a.attnum IS NULL OR NOT CASE WHEN q.type='enum' THEN typ.typtype='e' OR a.atttypid=25 WHEN q.type='1009|1015' THEN a.atttypid IN(1009,1015) ELSE a.atttypid=q.type::oid AND a.atttypmod=-1 END)),false) AS compatible,
 CASE WHEN c.oid IS NULL THEN false ELSE pg_catalog.has_schema_privilege(n.oid,'USAGE') AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND NOT pg_catalog.has_column_privilege(c.oid,a.attnum,'SELECT')) END AS readable
 FROM relations e LEFT JOIN pg_catalog.pg_namespace n ON n.nspname=e.schema_name LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=e.name),
 guard AS (SELECT p.oid,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex') AS hash,pg_catalog.octet_length(pg_catalog.convert_to(p.prosrc,'UTF8')) AS bytes,
 p.prokind='f' AND p.prorettype=2279 AND NOT p.proretset AND p.provolatile='v' AND p.prosecdef AND l.lanname='plpgsql' AND p.proconfig=ARRAY['search_path=pg_catalog'] AND p.pronargdefaults=0 AS contract
 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='crm_audience_v2' AND p.proname='campaign_send_guard' AND p.proargtypes::text=''),
 trigger_flags AS (SELECT t.tgenabled,t.tgtype,t.tgfoid,t.tgisinternal FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='campaigns' AND t.tgname='shrigma_audience_campaign_send_guard_v1')
SELECT pg_catalog.jsonb_build_object('sameRole',COALESCE((SELECT count(*)=1 AND bool_and(session_user=current_user AND current_user=d.database_role) FROM crm_audience_v2.regular_worker_deployment d WHERE d.singleton),false),
 'helpers',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',name,'present',present,'purePin',pure_pin,'executable',executable,'actualProsrcSha256',actual_hash,'actualProsrcBytes',actual_bytes,'matches',pg_catalog.jsonb_build_object('kind',"kind",'support',"support",'strict',"strict",'leakproof',"leakproof",'security',"security",'volatility',"volatility",'language',"language",'returnSet',"returnSet",'returnType',"returnType",'defaultCount',"defaultCount",'defaultExpression',"defaultExpression",'searchPath',"searchPath",'singleOverload',"singleOverload",'body',"body")) ORDER BY name) FROM helper),
 'relations',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',name,'present',present,'compatible',compatible,'readable',readable) ORDER BY name) FROM relation_flags),
 'updateGuard',pg_catalog.jsonb_build_object('present',(SELECT count(*)=1 FROM guard),'variant',COALESCE((SELECT CASE hash WHEN '${SEND_GUARD_HASHES['draft-only']}' THEN 'draft-only' WHEN '${SEND_GUARD_HASHES.operation}' THEN 'operation' ELSE 'unknown' END FROM guard),'unknown'),
 'actualProsrcSha256',(SELECT hash FROM guard),'actualProsrcBytes',(SELECT bytes FROM guard),
 'contractMatches',COALESCE((SELECT contract FROM guard),false),'triggerPresent',(SELECT count(*)=1 FROM trigger_flags),
 'triggerEnabled',COALESCE((SELECT tgenabled='O' FROM trigger_flags),false),'triggerMatches',COALESCE((SELECT tgtype=27 AND NOT tgisinternal AND tgfoid=(SELECT oid FROM guard) FROM trigger_flags),false))) AS payload
WHERE pg_catalog.current_database()='listmonk'`;

// Direct boolean observations only. Run after every table/ACL/same-role fence
// passes; never use these observations as an approval or call a helper here.
const CONTEXT_GATES_SQL=`WITH at AS (SELECT pg_catalog.statement_timestamp() AS at), targets(id) AS (VALUES(171),(174))
SELECT pg_catalog.jsonb_build_object('checkedAt',at.at,'targets',pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',t.id,
 'bindingPresent',head.campaign_id IS NOT NULL,'boundEffective',b.campaign_id IS NOT NULL,
 'revisionPresent',CASE WHEN b.campaign_id IS NULL THEN NULL ELSE r.audience_id IS NOT NULL END,
 'revisionActive',CASE WHEN b.campaign_id IS NULL THEN NULL ELSE COALESCE(NOT r.archived,false) END,
 'revisionPinsMatch',CASE WHEN b.campaign_id IS NULL THEN NULL ELSE COALESCE(r.definition_hash=b.definition_hash AND r.context_hash=b.context_hash,false) END,
 'audienceActive',CASE WHEN b.campaign_id IS NULL THEN NULL ELSE COALESCE(a.brand=b.brand AND NOT a.archived,false) END,
 'configEnabled',CASE WHEN b.campaign_id IS NULL THEN NULL ELSE COALESCE(c.enabled,false) END,
 'configCatalogPresent',CASE WHEN b.campaign_id IS NULL THEN NULL ELSE c.catalog IS NOT NULL END,
 'configBaseMatch',CASE WHEN b.campaign_id IS NULL THEN NULL ELSE COALESCE(c.base_list_id=b.base_list_id,false) END,
 'configFresh',CASE WHEN b.campaign_id IS NULL THEN NULL ELSE COALESCE(pg_catalog.isfinite(c.checked_at) AND pg_catalog.isfinite(c.expires_at) AND c.checked_at<=at.at AND c.expires_at>at.at AND c.expires_at<=c.checked_at+interval '5 minutes',false) END,
 'selectionFresh',CASE WHEN b.campaign_id IS NULL THEN NULL ELSE EXISTS(SELECT 1 FROM crm_audience_v2.selection_runtime rt WHERE rt.singleton AND rt.enabled AND rt.candidate_query_sha256='${EXPECTED_SELECTION_QUERY}' AND pg_catalog.isfinite(rt.verified_at) AND rt.verified_at<=at.at AND rt.verified_at>at.at-interval '5 minutes') END,
 'bindingHistoryMatch',CASE WHEN b.campaign_id IS NULL THEN NULL ELSE EXISTS(SELECT 1 FROM crm_audience_v2.campaign_binding_revision h WHERE h.campaign_id=b.campaign_id AND h.binding_version=b.binding_version AND h.binding=b.binding AND h.binding_hash=b.binding_hash) END,
 'listBaseMatch',CASE WHEN b.campaign_id IS NULL THEN NULL ELSE (SELECT array_agg(cl.list_id ORDER BY cl.list_id) FROM public.campaign_lists cl WHERE cl.campaign_id=t.id) IS NOT DISTINCT FROM ARRAY[b.base_list_id] END,
 'campaignContractMatch',CASE WHEN b.campaign_id IS NULL THEN NULL ELSE COALESCE(ca.type::text='regular' AND ca.messenger::text='email' AND ca.attribs#>>'{crm,brand}'=b.brand,false) END) ORDER BY t.id)) AS payload
FROM at CROSS JOIN targets t LEFT JOIN crm_audience_v2.campaign_binding head ON head.campaign_id=t.id
LEFT JOIN crm_audience_v2.campaign_binding b ON b.campaign_id=t.id AND NOT EXISTS(SELECT 1 FROM crm_audience_v2.campaign_binding_release rel WHERE rel.campaign_id=b.campaign_id AND rel.binding_version=b.binding_version AND rel.binding_hash=b.binding_hash)
LEFT JOIN crm_audience_v2.revision r ON r.audience_id=b.audience_id AND r.version=b.audience_revision
LEFT JOIN crm_audience_v2.audience a ON a.id=b.audience_id
LEFT JOIN crm_audience_v2.config c ON c.brand=b.brand LEFT JOIN public.campaigns ca ON ca.id=t.id
WHERE pg_catalog.current_database()='listmonk' GROUP BY at.at`;
const CONTEXT_FLAGS=Object.freeze(['revisionPresent','revisionActive','revisionPinsMatch','audienceActive','configEnabled','configCatalogPresent','configBaseMatch','configFresh','selectionFresh','bindingHistoryMatch','listBaseMatch','campaignContractMatch']);
function validateContextGates(raw){const v=object(raw,['checkedAt','targets']),bad=()=>{throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');};if(!iso(v.checkedAt)||!Array.isArray(v.targets)||v.targets.length!==2)bad();const seen=new Set();v.targets=Object.freeze(v.targets.map(raw=>{const t=object(raw,['id','bindingPresent','boundEffective',...CONTEXT_FLAGS]);if(![171,174].includes(t.id)||seen.has(t.id)||typeof t.bindingPresent!=='boolean'||typeof t.boundEffective!=='boolean'||t.boundEffective&&!t.bindingPresent||CONTEXT_FLAGS.some(k=>t.boundEffective?typeof t[k]!=='boolean':t[k]!==null))bad();seen.add(t.id);return Object.freeze(t);}));return Object.freeze(v);}
function validateSelectorFence(raw){
 const d=object(raw,['sameRole','helpers','relations','updateGuard']),bad=()=>{throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');};if(typeof d.sameRole!=='boolean')bad();
 const bool=x=>typeof x==='boolean',bytes=x=>Number.isSafeInteger(x)&&x>=0&&x<=2147483647;
 if(!Array.isArray(d.helpers)||d.helpers.length!==SELECTOR_FUNCTIONS.length)bad();let seen=new Set();d.helpers=Object.freeze(d.helpers.map(raw=>{const f=object(raw,['name','present','purePin','executable','actualProsrcSha256','actualProsrcBytes','matches']),expected=SELECTOR_FUNCTIONS.find(e=>e.name===f.name);if(!expected||seen.has(f.name)||![f.present,f.purePin,f.executable].every(bool))bad();seen.add(f.name);const m=object(f.matches,PURE_PIN_FIELDS);if(!Object.values(m).every(bool)||f.purePin!==(f.present&&Object.values(m).every(x=>x)))bad();
  if(f.present){if(typeof f.actualProsrcSha256!=='string'||!H.test(f.actualProsrcSha256)||!bytes(f.actualProsrcBytes)||m.body!==(f.actualProsrcSha256===expected.prosrcSha256&&f.actualProsrcBytes===SELECTOR_BODY_BYTES[f.name]))bad();}
  else if(f.actualProsrcSha256!==null||f.actualProsrcBytes!==null||f.executable||Object.values(m).some(x=>x))bad();return Object.freeze({...f,matches:Object.freeze(m)});}));
 if(!Array.isArray(d.relations)||d.relations.length!==SELECTOR_RELATIONS.length)bad();seen=new Set();d.relations=Object.freeze(d.relations.map(raw=>{const r=object(raw,['name','present','compatible','readable']);if(!SELECTOR_RELATIONS.some(e=>e.name===r.name)||seen.has(r.name)||![r.present,r.compatible,r.readable].every(bool)||!r.present&&(r.compatible||r.readable))bad();seen.add(r.name);return Object.freeze(r);}));
 const g=object(d.updateGuard,['present','variant','contractMatches','triggerPresent','triggerEnabled','triggerMatches','actualProsrcSha256','actualProsrcBytes']);if(!['draft-only','operation','unknown'].includes(g.variant)||!['present','contractMatches','triggerPresent','triggerEnabled','triggerMatches'].every(k=>bool(g[k]))||!g.present&&(g.variant!=='unknown'||g.contractMatches||g.triggerMatches||g.actualProsrcSha256!==null||g.actualProsrcBytes!==null)||!g.triggerPresent&&(g.triggerEnabled||g.triggerMatches))bad();
 if(g.present){if(typeof g.actualProsrcSha256!=='string'||!H.test(g.actualProsrcSha256)||!bytes(g.actualProsrcBytes))bad();const variant=Object.keys(SEND_GUARD_HASHES).find(k=>SEND_GUARD_HASHES[k]===g.actualProsrcSha256)||'unknown';if(g.variant!==variant||variant!=='unknown'&&g.actualProsrcBytes!==SEND_GUARD_BODY_BYTES[variant])bad();}d.updateGuard=Object.freeze(g);return Object.freeze(d);
}
// Direct table flags need no user-defined helper permission or pin. Their
// independent fence remains as strict as the relation/column/role gates.
function directContextGate(f,d){
 if(!f.sameRole)return 'same-role-required';
 if(f.relations.some(v=>!v.present))return 'relation-missing';if(f.relations.some(v=>!v.compatible))return 'relation-incompatible';if(f.relations.some(v=>!v.readable))return 'relation-acl';
 if(d.relations.some(v=>v.kind!=='table'||v.rowSecurity||v.forcedRowSecurity||v.columns.some(c=>!c.present||!c.typeCompatible||!c.readerSelect))||d.relations.find(v=>v.name==='campaigns').allCampaignColumnsSelect!==true)return 'projection-schema';return 'ready';
}
function selectorGate(f,d){
 const direct=directContextGate(f,d);if(direct!=='ready')return direct;
 if(f.helpers.some(v=>!v.present))return 'helper-missing';if(f.helpers.some(v=>!v.purePin))return 'helper-pin-mismatch';if(f.helpers.some(v=>!v.executable))return 'helper-acl';return 'ready';
}
function validateSelector(raw){
 const v=object(raw,['checkedAt','targets']),bad=()=>{throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');};if(!iso(v.checkedAt)||!Array.isArray(v.targets)||v.targets.length!==2)bad();const seen=new Set();
 v.targets=Object.freeze(v.targets.map(raw=>{const t=object(raw,['id','eligible','contextReady','bound','templateCompatible','mediaCompatible','countPresent','countWithinInt32','eligibleCount','cursorCompatible']);if(![171,174].includes(t.id)||seen.has(t.id)||typeof t.eligible!=='boolean')bad();seen.add(t.id);
  const flags=['contextReady','bound','templateCompatible','mediaCompatible','countPresent','countWithinInt32','cursorCompatible'];if(!t.eligible){if(flags.some(k=>t[k]!==null)||t.eligibleCount!==null)bad();}else{
   if(t.contextReady!==true||['bound','templateCompatible','mediaCompatible','countPresent'].some(k=>typeof t[k]!=='boolean'))bad();
   if(!t.countPresent){if(['countWithinInt32','cursorCompatible','eligibleCount'].some(k=>t[k]!==null))bad();}
   else if(typeof t.countWithinInt32!=='boolean'||typeof t.cursorCompatible!=='boolean'||(t.countWithinInt32?(!Number.isSafeInteger(t.eligibleCount)||t.eligibleCount<0||t.eligibleCount>2147483647):t.eligibleCount!==null))bad();
  }return Object.freeze(t);}));return Object.freeze(v);
}
const SQLSTATE_WHITELIST=Object.freeze(['55000','57014','55P03','42501','42P01','42703','42883','42804','42846','22P02','22003','22007','22008','22012','22023','23502','23503','23505','23514','40001','40P01','25006','XX000']);
function knownSQLSTATE(e){if(!e||isProxy(e)||typeof e!=='object')return null;const d=Object.getOwnPropertyDescriptor(e,'code');return d&&Object.hasOwn(d,'value')&&SQLSTATE_WHITELIST.includes(d.value)?d.value:null;}

const PEER="SELECT pg_catalog.current_database() AS database,session_user::text AS \"sessionRole\",current_user::text AS \"currentRole\",pg_catalog.pg_backend_pid() AS pid,pg_catalog.inet_server_port() AS port,pg_catalog.current_setting('server_version_num')::integer AS engine,(SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid()) AS ssl,pg_catalog.current_setting('transaction_read_only') AS read_only";
const SELECTOR_PROTOCOL=Object.freeze({schema:'shrigma-selector-read-protocol-v5',metadata:'fixed14-per-comparison-sha256-utf8bytes',directContext:'same-role-relations-columns-acl-types-noRLS-independent-of-helper-pins',statementMs:10000,contextMs:12000,lockMs:500,metadataMs:8000,isolation:'read-committed-read-only',ready:'I-T-(T|E)-I',errorAck:'whitelist-code-and-single-E',rollback:'confirmed-I',end:'confirmed-event',release:'CURRENT-after-end',attempt:'terminal-per-binding',sqlstates:SQLSTATE_WHITELIST});
// Consent binds the complete fixed SQL protocol, not an arbitrary caller query.
const queryHash=sha([PEER,BEGIN,CATALOG_SQL,READ_SQL,DEPENDENCY_SQL,SHAPES_SQL,ACTIVITY_SQL,SELECTOR_FENCE_SQL,CONTEXT_GATES_SQL,SELECTOR_SQL,canonical(SELECTOR_PROTOCOL),ROLLBACK].join('\n'));
const COLUMN_TYPES=Object.freeze({deployment:{singleton:16,enabled:16,worker_sha256:25,runtime_sha256:25,query_sha256:25,database_role:19,approved_at:1184,approved_by:25,topology_receipt_sha256:25},lease:{singleton:16,instance_id:2950,worker_sha256:25,runtime_sha256:25,database_role:19,heartbeat_at:1184,expires_at:1184,suspended:16,suspension_reason:25},selection:{singleton:16,enabled:16,candidate_query_sha256:25,verified_at:1184}});
for(const columns of Object.values(COLUMN_TYPES))Object.freeze(columns);
function validateCatalog(rows){
 if(!Array.isArray(rows)||rows.length!==3)throw error('SCHEDULER_STATE_DEPENDENCY_MISSING');const seen=new Set();
 for(const raw of rows){const r=object(raw,['relation','kind','readable','columns']);if(!Object.hasOwn(COLUMN_TYPES,r.relation)||seen.has(r.relation))throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');seen.add(r.relation);if(r.kind===null)throw error('SCHEDULER_STATE_DEPENDENCY_MISSING');if(r.kind!=='r')throw error('SCHEDULER_STATE_SCHEMA_REFUSED');if(r.readable!==true)throw error('SCHEDULER_STATE_ACL_REFUSED');
  const expected=COLUMN_TYPES[r.relation];if(!Array.isArray(r.columns)||r.columns.length!==Object.keys(expected).length)throw error('SCHEDULER_STATE_SCHEMA_REFUSED');const cols=new Set();
  for(const v of r.columns){const c=object(v,['name','oid','typmod']);if(!Object.hasOwn(expected,c.name)||cols.has(c.name)||c.oid!==expected[c.name]||c.typmod!==-1)throw error('SCHEDULER_STATE_SCHEMA_REFUSED');cols.add(c.name);}
 }
}
function validateState(raw){
 const v=object(raw,['checkedAt','deployment','lease','deploymentLeaseMatch','selection','storedIdentity']),d=object(v.deployment,['present','enabled','approvalPresent','approvalTiming','queryExpected']),l=object(v.lease,['present','live','suspended','reason']),m=object(v.deploymentLeaseMatch,['worker','runtime','databaseRole']),s=object(v.selection,['present','enabled','queryExpected','verifiedAt']);
 const bool=x=>typeof x==='boolean',nullableBool=x=>x===null||bool(x),bad=()=>{throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');};
 if(!iso(v.checkedAt)||!bool(d.present)||!nullableBool(d.enabled)||!bool(d.approvalPresent)||!['missing','future','effective'].includes(d.approvalTiming)||!nullableBool(d.queryExpected)||!bool(l.present)||!nullableBool(l.live)||!nullableBool(l.suspended)||!['competing_instance','identity_changed','deployment_off',null].includes(l.reason)||!Object.values(m).every(nullableBool)||!bool(s.present)||!nullableBool(s.enabled)||!nullableBool(s.queryExpected)||!(s.verifiedAt===null||iso(s.verifiedAt)))bad();
 if(!d.present&&(d.enabled!==null||d.approvalPresent||d.approvalTiming!=='missing'||d.queryExpected!==null)||!l.present&&(l.live!==null||l.suspended!==null||l.reason!==null)||l.present&&(!bool(l.live)||!bool(l.suspended)||l.suspended!==(l.reason!==null))||!s.present&&(s.enabled!==null||s.queryExpected!==null||s.verifiedAt!==null)||d.present&&!bool(d.enabled)||s.present&&!bool(s.enabled)||(!d.present||!l.present)&&Object.values(m).some(x=>x!==null))bad();
 // Stored hashes are the lease record's identity, not a measurement of the
 // current executable and never admission of another binary or a send.
 let identity=null;if(l.present){const i=object(v.storedIdentity,['instanceId','workerSha256','runtimeSha256','heartbeatAt','expiresAt']);if(typeof i.instanceId!=='string'||!UUID.test(i.instanceId)||i.instanceId===NIL_UUID||typeof i.workerSha256!=='string'||!H.test(i.workerSha256)||typeof i.runtimeSha256!=='string'||!H.test(i.runtimeSha256)||!iso(i.heartbeatAt)||!iso(i.expiresAt))bad();const heartbeat=timestamp(i.heartbeatAt),expires=timestamp(i.expiresAt),checked=timestamp(v.checkedAt);if(expires<heartbeat||l.live!==(heartbeat<=checked&&expires>checked))bad();identity=Object.freeze(i);}else if(v.storedIdentity!==null)bad();
 return Object.freeze({schema:'shrigma-original-scheduler-stored-state-v2',checkedAt:v.checkedAt,storedIdentity:identity,deployment:Object.freeze(d),lease:Object.freeze(l),deploymentLeaseMatch:Object.freeze(m),selection:Object.freeze(s),storedStateOnly:true,runtimeMeasured:false,causeEstablished:false,authorizesSend:false,authorizesRecovery:false,operational:false});
}
function credential(raw,ownerId){const p=object(raw,['schema','revision','ownerId','username','password','resource','transport']);object(p.resource,Object.keys(RESOURCE));object(p.transport,['mode']);if(p.schema!=='shrigma-private-database-credential-v1'||p.ownerId!==ownerId||!Number.isSafeInteger(p.revision)||p.revision<1||typeof p.username!=='string'||!p.username||Buffer.byteLength(p.username)>63||/[\x00-\x1f\x7f]/.test(p.username)||typeof p.password!=='string'||!p.password||Buffer.byteLength(p.password)>4096||p.password.includes('\0')||canonical(p.resource)!==canonical(RESOURCE)||p.transport.mode!=='admitted-private-network')throw error('SCHEDULER_STATE_CREDENTIAL_REFUSED');return p;}
function credentialBinding(p){const {password,...pub}=p;return sha(canonical(pub));}
function createSchedulerStateRead({enabled=false,driver,getPrivateCredential,admitState,now=Date.now}={}){
 const ready=enabled===true&&typeof driver?.Client==='function'&&driver.version==='8.23.1'&&H.test(driver.packageSha256||'')&&[getPrivateCredential,admitState,now].every(f=>typeof f==='function');
 let active=null,closing=false,blocked=false,closePromise;
 function valid(t){if(active!==t||!t.valid||t.fatal||closing)throw error('SCHEDULER_STATE_SESSION_REFUSED');}
 async function end(s){if(!s)return;if(!s.endPromise){s.endRequested=true;s.endPromise=(async()=>{try{await bounded(Promise.resolve().then(()=>s.raw.end()),5000);if(!s.ended)throw error('SCHEDULER_STATE_CLOSE_UNCONFIRMED');}catch(e){blocked=true;throw own.has(e)?e:error('SCHEDULER_STATE_CLOSE_FAILED');}})();s.endPromise.catch(()=>{});}return s.endPromise;}
 async function admission(t,phase,p,peer){const expected={admitted:true,ownerId:p.ownerId,credentialRevision:p.revision,credentialBindingHash:credentialBinding(p),resourceHash,queryHash,purpose:PURPOSE};let a;try{a=object(await bounded(Promise.resolve().then(()=>admitState({phase,...Object.fromEntries(Object.entries(expected).filter(([k])=>k!=='admitted')),...(peer?{peer:Object.freeze({...peer})}:{})})),5000),Object.keys(expected));}catch{throw error('SCHEDULER_STATE_ADMISSION_REFUSED');}valid(t);if(canonical(a)!==canonical(expected))throw error('SCHEDULER_STATE_ADMISSION_REFUSED');}
 async function query(t,sql,command,state,allowSQLSTATE=false,contextMs=allowSQLSTATE?12000:8000){
  valid(t);const s=t.session,seq=s.seq,started=performance.now(),deadline=started+contextMs;s.awaiting=true;s.expected=state;s.errorAllowed=allowSQLSTATE;let r,sqlstate;
  const wait=async p=>{const remaining=Math.ceil(deadline-performance.now());if(remaining<=0)throw error('SCHEDULER_STATE_TIMEOUT');return bounded(p,remaining);};
  try{r=await wait(Promise.resolve().then(()=>s.raw.query(sql)));}catch(e){sqlstate=allowSQLSTATE?knownSQLSTATE(e):null;if(!sqlstate){t.fatal=true;throw error('SCHEDULER_STATE_QUERY_FAILED');}}
  valid(t);if(s.seq===seq){try{await wait(new Promise(resolve=>s.waiters.add(resolve)));}catch{t.fatal=true;throw error('SCHEDULER_STATE_ACK_UNKNOWN');}valid(t);}s.awaiting=false;s.errorAllowed=false;
  if(performance.now()>deadline||s.seq!==seq+1||s.tx!==(sqlstate?'E':state)){t.fatal=true;throw error('SCHEDULER_STATE_ACK_UNKNOWN');}
  if(sqlstate)return Object.freeze({sqlstate,durationMs:Math.min(12000,Math.max(0,Math.ceil(performance.now()-started)))});
  if(!r||isProxy(r)||Array.isArray(r)||r.command!==command||!Array.isArray(r.rows)||(command==='SELECT'?(!Number.isSafeInteger(r.rowCount)||r.rowCount!==r.rows.length):(r.rowCount!==null||r.rows.length!==0))){t.fatal=true;throw error('SCHEDULER_STATE_ACK_UNKNOWN');}return allowSQLSTATE?Object.freeze({rows:r.rows,durationMs:Math.min(12000,Math.max(0,Math.ceil(performance.now()-started)))}):r.rows;
 }
 async function inspect(raw={},context){
  if(!ready)throw error('SCHEDULER_STATE_OFF');if(closing||blocked)throw error('SCHEDULER_STATE_UNAVAILABLE');if(active)throw error('SCHEDULER_STATE_BUSY',409);object(raw,[]);const c=object(context,['ownerId']);if(typeof c.ownerId!=='string'||!c.ownerId||c.ownerId.length>256||/[\x00-\x1f]/.test(c.ownerId))throw error('SCHEDULER_STATE_OWNER_REFUSED');
  const t={valid:true,fatal:false,session:null};t.done=new Promise(resolve=>t.finish=resolve);active=t;
  const work=(async()=>{
   let p;try{p=credential(await bounded(Promise.resolve().then(()=>getPrivateCredential({ownerId:c.ownerId})),5000),c.ownerId);}catch{throw error('SCHEDULER_STATE_CREDENTIAL_REFUSED');}valid(t);await admission(t,'connect',p);
   const rawClient=new driver.Client({host:RESOURCE.host,port:RESOURCE.port,database:RESOURCE.database,user:p.username,password:p.password,ssl:false,connectionTimeoutMillis:3000,query_timeout:12000,statement_timeout:10000,lock_timeout:500,idle_in_transaction_session_timeout:30000,application_name:'shrigma-original-scheduler-state-read',client_encoding:'UTF8',options:'-c search_path=pg_catalog -c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=500 -c idle_in_transaction_session_timeout=30000',keepAlive:true,pipeline:false});
   const s={raw:rawClient,ended:false,endRequested:false,endPromise:null,tx:null,seq:0,awaiting:true,expected:'I',waiters:new Set()};t.session=s;
   if(typeof rawClient.on!=='function'||typeof rawClient.connection?.on!=='function'||['connect','query','end'].some(k=>typeof rawClient[k]!=='function'))throw error('SCHEDULER_STATE_DRIVER_REFUSED');
   const wake=()=>{for(const w of s.waiters)w();s.waiters.clear();};rawClient.on('error',()=>{t.fatal=true;wake();end(s).catch(()=>{});});rawClient.on('end',()=>{s.ended=true;if(!s.endRequested)t.fatal=true;wake();});rawClient.connection.on('readyForQuery',m=>{if(!s.awaiting||(m?.status!==s.expected&&!(s.errorAllowed&&m?.status==='E'))){t.fatal=true;end(s).catch(()=>{});}else{s.tx=m.status;s.seq++;}wake();});
   await bounded(Promise.resolve().then(()=>rawClient.connect()),5000);valid(t);s.awaiting=false;if(s.seq!==1||s.tx!=='I'||rawClient.connection.stream?.encrypted===true)throw error('SCHEDULER_STATE_PEER_REFUSED');
   await admission(t,'peer',p);const rows=await query(t,PEER,'SELECT','I');if(rows.length!==1)throw error('SCHEDULER_STATE_PEER_REFUSED');const peer=object(rows[0],['database','sessionRole','currentRole','pid','port','engine','ssl','read_only']);
   if(peer.database!==RESOURCE.database||peer.sessionRole!==p.username||peer.currentRole!==p.username||peer.port!==5432||!Number.isInteger(peer.engine)||Math.floor(peer.engine/10000)!==17||!Number.isSafeInteger(peer.pid)||peer.pid<=0||peer.pid!==rawClient.processID||peer.ssl!==false||peer.read_only!=='on')throw error('SCHEDULER_STATE_PEER_REFUSED');
   await admission(t,'begin',p,peer);await query(t,BEGIN,'BEGIN','T');
   await admission(t,'catalog',p,peer);validateCatalog(await query(t,CATALOG_SQL,'SELECT','T'));
   await admission(t,'read',p,peer);const state=await query(t,READ_SQL,'SELECT','T');if(state.length!==1)throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');const payload=validateState(object(state[0],['payload']).payload);
   await admission(t,'catalog',p,peer);const depsRows=await query(t,DEPENDENCY_SQL,'SELECT','T');if(depsRows.length!==1)throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');const deps=validateDependencies(object(depsRows[0],['payload']).payload);
   let shapes=Object.freeze({status:shapesGate(deps),limit:SHAPE_LIMIT});if(shapes.status==='observed'){await admission(t,'read',p,peer);const rows=await query(t,SHAPES_SQL,'SELECT','T');if(rows.length!==1)throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');shapes=validateShapes(object(rows[0],['payload']).payload);}
   let activity=Object.freeze({status:'unavailable',reason:!deps.workerRoleKnown?'worker-role-unknown':!deps.activityCapability.readable?'not-readable':'not-visible'});if(deps.activityCapability.readable&&deps.activityCapability.visible){await admission(t,'read',p,peer);const rows=await query(t,ACTIVITY_SQL,'SELECT','T');if(rows.length!==1)throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');activity=validateActivity(object(rows[0],['payload']).payload);}
   const scannerDependencies=Object.freeze({...deps,rowShapes:shapes,activity,helperExecutionPerformed:false,nextCampaignsExecuted:false});
   await admission(t,'catalog',p,peer);const fenceRows=await query(t,SELECTOR_FENCE_SQL,'SELECT','T');if(fenceRows.length!==1)throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');const fence=validateSelectorFence(object(fenceRows[0],['payload']).payload),gate=selectorGate(fence,deps),contextGate=directContextGate(fence,deps);
   let selectorDiagnostic=Object.freeze({status:'refused',reason:gate,phase:'fence',sqlstate:null,durationMs:null,checkedAt:payload.checkedAt,targets:null,fence,contextGates:null,updateGuard:fence.updateGuard,executed:false,readOnly:true,rollbackConfirmed:false,endConfirmed:false,originalScannerError:false});
   if(contextGate==='ready'){
    await admission(t,'catalog',p,peer);const contexts=await query(t,CONTEXT_GATES_SQL,'SELECT','T',true,8000);
    if(contexts.sqlstate)selectorDiagnostic=Object.freeze({...selectorDiagnostic,status:'postgres-error',reason:null,phase:'context-gates',sqlstate:contexts.sqlstate,durationMs:contexts.durationMs});
    else{if(contexts.rows.length!==1)throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');selectorDiagnostic=Object.freeze({...selectorDiagnostic,contextGates:validateContextGates(object(contexts.rows[0],['payload']).payload)});
    if(gate==='ready'){await admission(t,'read',p,peer);const selected=await query(t,SELECTOR_SQL,'SELECT','T',true);
    if(selected.sqlstate)selectorDiagnostic=Object.freeze({...selectorDiagnostic,status:'postgres-error',reason:null,phase:'select',sqlstate:selected.sqlstate,durationMs:selected.durationMs,executed:true});
    else{if(selected.rows.length!==1)throw error('SCHEDULER_STATE_PROTOCOL_REFUSED');const v=validateSelector(object(selected.rows[0],['payload']).payload);selectorDiagnostic=Object.freeze({...selectorDiagnostic,status:'observed',reason:null,phase:'select',durationMs:selected.durationMs,checkedAt:v.checkedAt,targets:v.targets,executed:true});}
    }
    }
   }

   await admission(t,'rollback',p,peer);await query(t,ROLLBACK,'ROLLBACK','I');
   await admission(t,'end',p,peer);await end(s);valid(t);await admission(t,'release',p,peer);valid(t);
   const clock=now();if(!Number.isSafeInteger(clock)||clock<0||clock>8640000000000000)throw error('SCHEDULER_STATE_CLOCK_REFUSED');return Object.freeze({...payload,schema:'shrigma-original-scheduler-stored-state-v5',scannerDependencies,selectorDiagnostic:Object.freeze({...selectorDiagnostic,rollbackConfirmed:true,endConfirmed:true})});
  })();
  let result,failure;try{result=await bounded(work,60000);}catch(e){failure=own.has(e)?e:error('SCHEDULER_STATE_REFUSED');}
  finally{
   // Cleanup has no data read and requires no surviving authorization. Fatal
   // or unacknowledged sessions are ended; PG rolls their transaction back.
   if(failure&&t.valid&&!t.fatal&&['T','E'].includes(t.session?.tx)&&!closing){try{await query(t,ROLLBACK,'ROLLBACK','I');}catch(e){failure=own.has(e)?e:error('SCHEDULER_STATE_REFUSED');}}
   t.valid=false;try{await end(t.session);}catch(e){failure=own.has(e)?e:error('SCHEDULER_STATE_CLOSE_FAILED');}active=null;t.finish();
  }
  if(failure)throw failure;return result;
 }
 function close(){if(closePromise)return closePromise;closing=true;closePromise=(async()=>{if(active){const t=active;t.valid=false;await end(t.session);await bounded(t.done,15000);}if(blocked)throw error('SCHEDULER_STATE_CLOSE_UNCONFIRMED');return Object.freeze({closed:true,operational:false});})();closePromise.catch(()=>{});return closePromise;}
 return Object.freeze({inspect,close});
}
module.exports=Object.freeze({createSchedulerStateRead,PURPOSE,RESOURCE,PEER,BEGIN,ROLLBACK,CATALOG_SQL,READ_SQL,queryHash,resourceHash,EXPECTED_SELECTION_QUERY,COLUMN_TYPES,validateCatalog,validateState,credentialBinding,canonical,DEPENDENCY_SQL,SHAPES_SQL,ACTIVITY_SQL,SCANNER_COLUMNS,SCANNER_FUNCTIONS,SHAPE_LIMIT,JSON_SHAPE_LIMIT,validateDependencies,validateShapes,validateActivity,shapesGate,SELECTOR_SQL,SELECTOR_FENCE_SQL,SELECTOR_FUNCTIONS,SELECTOR_RELATIONS,SEND_GUARD_HASHES,validateSelectorFence,selectorGate,validateSelector,SQLSTATE_WHITELIST,SELECTOR_PROTOCOL,CONTEXT_GATES_SQL,CONTEXT_FLAGS,validateContextGates,SELECTOR_EXTRA_COLUMNS,PURE_PIN_FIELDS,SELECTOR_BODY_BYTES,SEND_GUARD_BODY_BYTES,directContextGate});
