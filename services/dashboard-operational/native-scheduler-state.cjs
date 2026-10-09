'use strict';
const crypto=require('node:crypto');
const {isProxy}=require('node:util').types;
const PURPOSE='crm.scheduler-state-read';
const RESOURCE=Object.freeze({project:'comunicacao',service:'postgres',host:'comunicacao_postgres',port:5432,database:'listmonk',network:'easypanel'});
const BEGIN='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',ROLLBACK='ROLLBACK';
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

const PEER="SELECT pg_catalog.current_database() AS database,session_user::text AS \"sessionRole\",current_user::text AS \"currentRole\",pg_catalog.pg_backend_pid() AS pid,pg_catalog.inet_server_port() AS port,pg_catalog.current_setting('server_version_num')::integer AS engine,(SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid()) AS ssl,pg_catalog.current_setting('transaction_read_only') AS read_only";
// Consent binds the complete fixed SQL protocol, not an arbitrary caller query.
const queryHash=sha([PEER,BEGIN,CATALOG_SQL,READ_SQL,DEPENDENCY_SQL,SHAPES_SQL,ACTIVITY_SQL,ROLLBACK].join('\n'));
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
 async function query(t,sql,command,state){valid(t);const s=t.session,seq=s.seq;s.awaiting=true;s.expected=state;let r;try{r=await bounded(Promise.resolve().then(()=>s.raw.query(sql)),12000);}catch{t.fatal=true;throw error('SCHEDULER_STATE_QUERY_FAILED');}valid(t);if(s.seq===seq){await bounded(new Promise(resolve=>s.waiters.add(resolve)),2000);valid(t);}s.awaiting=false;if(s.seq!==seq+1||s.tx!==state||!r||isProxy(r)||Array.isArray(r)||r.command!==command||!Array.isArray(r.rows)||(command==='SELECT'?(!Number.isSafeInteger(r.rowCount)||r.rowCount!==r.rows.length):(r.rowCount!==null||r.rows.length!==0))){t.fatal=true;throw error('SCHEDULER_STATE_ACK_UNKNOWN');}return r.rows;}
 async function inspect(raw={},context){
  if(!ready)throw error('SCHEDULER_STATE_OFF');if(closing||blocked)throw error('SCHEDULER_STATE_UNAVAILABLE');if(active)throw error('SCHEDULER_STATE_BUSY',409);object(raw,[]);const c=object(context,['ownerId']);if(typeof c.ownerId!=='string'||!c.ownerId||c.ownerId.length>256||/[\x00-\x1f]/.test(c.ownerId))throw error('SCHEDULER_STATE_OWNER_REFUSED');
  const t={valid:true,fatal:false,session:null};t.done=new Promise(resolve=>t.finish=resolve);active=t;
  const work=(async()=>{
   let p;try{p=credential(await bounded(Promise.resolve().then(()=>getPrivateCredential({ownerId:c.ownerId})),5000),c.ownerId);}catch{throw error('SCHEDULER_STATE_CREDENTIAL_REFUSED');}valid(t);await admission(t,'connect',p);
   const rawClient=new driver.Client({host:RESOURCE.host,port:RESOURCE.port,database:RESOURCE.database,user:p.username,password:p.password,ssl:false,connectionTimeoutMillis:3000,query_timeout:12000,statement_timeout:8000,lock_timeout:2000,idle_in_transaction_session_timeout:10000,application_name:'shrigma-original-scheduler-state-read',client_encoding:'UTF8',options:'-c search_path=pg_catalog -c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=10000',keepAlive:true,pipeline:false});
   const s={raw:rawClient,ended:false,endRequested:false,endPromise:null,tx:null,seq:0,awaiting:true,expected:'I',waiters:new Set()};t.session=s;
   if(typeof rawClient.on!=='function'||typeof rawClient.connection?.on!=='function'||['connect','query','end'].some(k=>typeof rawClient[k]!=='function'))throw error('SCHEDULER_STATE_DRIVER_REFUSED');
   const wake=()=>{for(const w of s.waiters)w();s.waiters.clear();};rawClient.on('error',()=>{t.fatal=true;wake();end(s).catch(()=>{});});rawClient.on('end',()=>{s.ended=true;if(!s.endRequested)t.fatal=true;wake();});rawClient.connection.on('readyForQuery',m=>{if(!s.awaiting||m?.status!==s.expected){t.fatal=true;end(s).catch(()=>{});}else{s.tx=m.status;s.seq++;}wake();});
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
   await admission(t,'rollback',p,peer);await query(t,ROLLBACK,'ROLLBACK','I');
   await admission(t,'end',p,peer);await end(s);valid(t);await admission(t,'release',p,peer);valid(t);
   const clock=now();if(!Number.isSafeInteger(clock)||clock<0||clock>8640000000000000)throw error('SCHEDULER_STATE_CLOCK_REFUSED');return Object.freeze({...payload,schema:'shrigma-original-scheduler-stored-state-v3',scannerDependencies});
  })();
  let result,failure;try{result=await bounded(work,60000);}catch(e){failure=own.has(e)?e:error('SCHEDULER_STATE_REFUSED');}
  finally{
   // Cleanup has no data read and requires no surviving authorization. Fatal
   // or unacknowledged sessions are ended; PG rolls their transaction back.
   if(failure&&t.valid&&!t.fatal&&t.session?.tx==='T'&&!closing){try{await query(t,ROLLBACK,'ROLLBACK','I');}catch(e){failure=own.has(e)?e:error('SCHEDULER_STATE_REFUSED');}}
   t.valid=false;try{await end(t.session);}catch(e){failure=own.has(e)?e:error('SCHEDULER_STATE_CLOSE_FAILED');}active=null;t.finish();
  }
  if(failure)throw failure;return result;
 }
 function close(){if(closePromise)return closePromise;closing=true;closePromise=(async()=>{if(active){const t=active;t.valid=false;await end(t.session);await bounded(t.done,15000);}if(blocked)throw error('SCHEDULER_STATE_CLOSE_UNCONFIRMED');return Object.freeze({closed:true,operational:false});})();closePromise.catch(()=>{});return closePromise;}
 return Object.freeze({inspect,close});
}
module.exports=Object.freeze({createSchedulerStateRead,PURPOSE,RESOURCE,PEER,BEGIN,ROLLBACK,CATALOG_SQL,READ_SQL,queryHash,resourceHash,EXPECTED_SELECTION_QUERY,COLUMN_TYPES,validateCatalog,validateState,credentialBinding,canonical,DEPENDENCY_SQL,SHAPES_SQL,ACTIVITY_SQL,SCANNER_COLUMNS,SCANNER_FUNCTIONS,SHAPE_LIMIT,JSON_SHAPE_LIMIT,validateDependencies,validateShapes,validateActivity,shapesGate});
