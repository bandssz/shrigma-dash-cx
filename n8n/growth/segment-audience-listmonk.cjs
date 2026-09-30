'use strict';
// Shadow count provider. Only aggregate SELECTs; no recipient enumeration,
// campaign binding, audience materialization, selection or transport authority.
const A=require('./segment-audience-contract.js');
const S=require('./segment-contract.js');
const R=require('./segment-audience-review.cjs');
const Shopify=require('./segment-shopify-facts.cjs');
const ENABLED=false,VERSION='crm-audience-listmonk-count-v1';
const deepFreeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;};
const ENGAGEMENT_SOURCE_SEMANTICS=deepFreeze({
 version:'listmonk-panel-campaign-engagement-v1',
 identity:'subscriber_id',
 campaign_scope:{policy:'crm-campaign-v1',brand:'campaigns.attribs.crm.brand',messenger:'email',type:'regular'},
 events:{'email.opened':{relation:'campaign_views',time:'created_at'},'email.clicked':{relation:'link_clicks',time:'created_at'}},
 window:'statement_timestamp inclusive trailing exact 86400-second days',
 negative:'no registered event in this scoped snapshot; no claim of human action or other transports'
});
function engagementSourceHash(brand,field){
 if(!['fish','aristo'].includes(brand)||!['email.opened','email.clicked'].includes(field))throw fail('AUDIENCE_COUNT_SOURCE');
 return R.digest({semantics:ENGAGEMENT_SOURCE_SEMANTICS,brand,field});
}
const fail=code=>Object.assign(new Error(code),{code});
const positive=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const UNKNOWN_SQL='SELECT false AS source_confirmed, NULL::bigint AS eligible_count, statement_timestamp() AS checked_at';

function compileCount({definition,baseListId,catalog}={}){
 const d=A.normalize(definition),c=JSON.parse(R.canonical(catalog));
 if(!positive(baseListId))throw fail('AUDIENCE_COUNT_BASE');
 if(c.brand!==d.brand||!Array.isArray(c.lists)||c.lists.length>1000||!Array.isArray(c.fields)||c.fields.length>Object.keys(A.FIELDS).length||typeof c.current!=='boolean')throw fail('AUDIENCE_COUNT_CATALOG');
 const leaves=A.leaves(d),ids=[...new Set([baseListId,...leaves.filter(x=>x.rule.op==='in_list').map(x=>x.rule.list_id)])];
 const valid=c.current&&ids.every(id=>{const rows=c.lists.filter(x=>x?.id===id);return rows.length===1&&rows[0].brand===d.brand&&rows[0].available===true;});
 const sourceReady=key=>{if(Shopify.FIELDS.includes(key))return Shopify.sourceReady(d.brand,key,c);const rows=c.fields.filter(x=>x?.key===key);return rows.length===1&&rows[0].available===true&&rows[0].source_hash===engagementSourceHash(d.brand,key);};
 const unknownLeaf=leaves.some(({rule})=>rule.op!=='in_list'&&(!['email.opened','email.clicked',...Shopify.FIELDS].includes(rule.field)||!sourceReady(rule.field)));
 const reason=!valid?'list_source_unavailable':unknownLeaf?'external_source_unavailable':null;
 // Reuse the same consent predicate already exercised against native Listmonk:
 // enabled globally; active same-brand base and leaves; confirmed for double
 // opt-in; confirmed/unconfirmed for single. SQL rechecks list ownership/status.
 // Email facts mean native records on panel-owned campaigns for this brand. Other
 // sources remain SQL NULL. PostgreSQL's three-valued AND/OR can still prove a
 // subject true or false; a final count is exposed only when no base subject is
 // left unknown.
 let q;
 if(!valid)q={text:UNKNOWN_SQL,values:[]};
 else if(leaves.every(x=>x.rule.op==='in_list'))q=S.compileCount({...d,schema_version:S.VERSION},{baseListId,catalog:c});
 else if(leaves.some(x=>x.rule.op==='condition'&&Shopify.FIELDS.includes(x.rule.field))&&Shopify.aggregateSourceReady(d.brand,c)&&leaves.every(x=>x.rule.field!=='purchase.product'||c.fields.find(f=>f?.key==='purchase.product').source_hash===Shopify.sourceHash(d.brand,'purchase.product',c))){
  // The product-source migration installs a SECURITY DEFINER aggregate wrapper.
  // The API role submits only a normalized declarative tree and pinned catalog;
  // it never receives EXECUTE on the internal set-returning match helper.
  q={text:'SELECT source_confirmed,eligible_count,checked_at FROM crm_audience_v2.shopify_count_for_rule($1::jsonb,$2::text,$3::integer,$4::jsonb)',values:[JSON.stringify(d.rule),d.brand,baseListId,JSON.stringify(c)]};
 }
 else{
  const sorted=ids.slice().sort((a,b)=>a-b),values=[d.brand,sorted,...sorted],parameter=new Map(sorted.map((n,i)=>[n,'$'+(i+3)+'::integer'])),days=new Map(),sourceChecks=new Map();
  const membership=listId=>`EXISTS (SELECT 1 FROM public.subscriber_lists sl JOIN valid_lists l ON l.id=sl.list_id WHERE sl.subscriber_id=s.id AND l.id=${parameter.get(listId)} AND ((l.optin='double' AND sl.status::text='confirmed') OR (l.optin='single' AND sl.status::text IN ('confirmed','unconfirmed'))))`;
  const engagement=r=>{
   if(!sourceReady(r.field))return 'NULL::boolean';
   const key=JSON.stringify(r);let p=days.get(key);if(!p){values.push(r.value);p='$'+values.length+'::integer';days.set(key,p);}
   const relation=r.field==='email.opened'?'campaign_views':'link_clicks';
   const exists=`EXISTS (SELECT 1 FROM public.${relation} ev JOIN public.campaigns ec ON ec.id=ev.campaign_id WHERE ev.subscriber_id=s.id AND ec.attribs#>>'{crm,policy}'='crm-campaign-v1' AND ec.attribs#>>'{crm,brand}'=$1::text AND ec.messenger::text='email' AND ec.type::text='regular' AND ev.created_at>=pg_catalog.statement_timestamp()-(${p}::double precision*86400*interval '1 second') AND ev.created_at<=pg_catalog.statement_timestamp())`;
   return r.operator==='within_last_days'?exists:`NOT (${exists})`;
  };
  const shopify=r=>{
   if(!sourceReady(r.field))return 'NULL::boolean';
   values.push(JSON.stringify(r));const ruleParam='$'+values.length+'::jsonb';
   values.push(Shopify.sourceHash(d.brand,r.field,c));const pinParam='$'+values.length+'::text';
   if(!sourceChecks.has(r.field))sourceChecks.set(r.field,`crm_audience_v2.shopify_source_current($1::text,'${r.field}',${pinParam})`);
   return `crm_audience_v2.shopify_customer_match(${ruleParam},s.id,$1::text,${pinParam})`;
  };
  let confirmedSourceUnavailable=false;
  const rule=r=>r.op==='in_list'?membership(r.list_id):r.op==='confirmed'?(sourceReady(r.rule.field)?'coalesce('+shopify(r.rule)+',false)':(confirmedSourceUnavailable=true,'NULL::boolean')):r.op==='condition'?(['email.opened','email.clicked'].includes(r.field)?engagement(r):Shopify.FIELDS.includes(r.field)?shopify(r):'NULL::boolean'):'('+r.rules.map(rule).join(r.op==='and'?' AND ':' OR ')+')';
  const expression=rule(d.rule),base=membership(baseListId),sourceCheck=(sourceChecks.size?' AND '+[...sourceChecks.values()].join(' AND '):'')+(confirmedSourceUnavailable?' AND false':'');
  const text=`WITH valid_lists AS MATERIALIZED (
 SELECT l.id,l.optin::text AS optin FROM public.lists l WHERE l.id=ANY($2::integer[])
 AND l.status::text='active' AND public.shrigma_campaign_list_brand(l)=$1::text AND l.optin::text IN ('single','double')
), scope AS (SELECT count(*)=pg_catalog.cardinality($2::integer[])${sourceCheck} AS confirmed FROM valid_lists),
evaluated AS MATERIALIZED (
 SELECT (${expression}) AS matched FROM public.subscribers s CROSS JOIN scope
 WHERE scope.confirmed AND s.status::text='enabled' AND ${base}
), summary AS (
 SELECT count(*) FILTER (WHERE matched IS TRUE)::bigint AS matched_count,
 count(*) FILTER (WHERE matched IS NULL)::bigint AS unknown_count FROM evaluated
)
SELECT scope.confirmed AND summary.unknown_count=0 AS source_confirmed,
 CASE WHEN scope.confirmed AND summary.unknown_count=0 THEN summary.matched_count ELSE NULL END AS eligible_count,
 pg_catalog.statement_timestamp() AS checked_at FROM scope CROSS JOIN summary`;
  q={text,values};
 }
 return Object.freeze({definition:d,definition_hash:R.digest(d),base_list_id:baseListId,text:q.text,values:q.values,unknown_reason:reason,has_external_facts:leaves.some(({rule})=>Shopify.FIELDS.includes(rule.field)),transport_supported:false});
}

async function countAudience({definition,baseListId,catalog,query,signal,timeoutMs=10000,clock=Date.now}={}){
 if(typeof query!=='function'||typeof clock!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000||signal!==undefined&&!(signal instanceof AbortSignal))throw fail('AUDIENCE_COUNT_INPUT');
 const plan=compileCount({definition,baseListId,catalog});
 if(signal?.aborted)throw fail('AUDIENCE_COUNT_ABORTED');
 const started=clock();if(!Number.isSafeInteger(started)||started<0)throw fail('AUDIENCE_COUNT_INPUT');
 const controller=new AbortController();let timer,abort;
 const stopped=new Promise((_,reject)=>{
  abort=()=>{controller.abort();reject(fail('AUDIENCE_COUNT_ABORTED'));};signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>{controller.abort();reject(fail('AUDIENCE_COUNT_TIMEOUT'));},timeoutMs);
 });
 try{
  // The dedicated transaction adapter must enforce its DB statement timeout,
  // honor the signal where supported and never retry this query automatically.
  const result=await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)throw fail(signal?.aborted?'AUDIENCE_COUNT_ABORTED':'AUDIENCE_COUNT_TIMEOUT');return query(plan.text,plan.values,{signal:controller.signal});}),stopped]);
  if(controller.signal.aborted)throw fail(signal?.aborted?'AUDIENCE_COUNT_ABORTED':'AUDIENCE_COUNT_TIMEOUT');
  const completed=clock();if(!Number.isSafeInteger(completed)||completed<started||completed-started>=timeoutMs)throw fail('AUDIENCE_COUNT_TIMEOUT');
  if(!result||!Array.isArray(result.rows)||result.rows.length!==1)throw fail('AUDIENCE_COUNT_UNCONFIRMED');
  const row=result.rows[0];
  if(!row||typeof row!=='object'||Object.keys(row).sort().join(',')!=='checked_at,eligible_count,source_confirmed'||typeof row.source_confirmed!=='boolean'||plan.unknown_reason==='list_source_unavailable'&&row.source_confirmed)throw fail('AUDIENCE_COUNT_UNCONFIRMED');
  let eligible=null;
  if(row.source_confirmed){
   const value=row.eligible_count;
   if(!(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)&&!(typeof value==='string'&&/^(0|[1-9]\d*)$/.test(value)&&Number.isSafeInteger(Number(value))))throw fail('AUDIENCE_COUNT_UNCONFIRMED');
   eligible=Number(value);
  }else if(row.eligible_count!==null)throw fail('AUDIENCE_COUNT_UNCONFIRMED');
  const stamp=row.checked_at instanceof Date?row.checked_at.toISOString():row.checked_at;
  if(typeof stamp!=='string'||!Number.isFinite(Date.parse(stamp))||Date.parse(stamp)<started-1000||Date.parse(stamp)>completed+1000)throw fail('AUDIENCE_COUNT_UNCONFIRMED');
  return Object.freeze({source_confirmed:row.source_confirmed,eligible_count:eligible,checked_at:new Date(stamp).toISOString(),definition:plan.definition,definition_hash:plan.definition_hash,base_list_id:baseListId,transport_supported:false,unknown_reason:row.source_confirmed?null:plan.unknown_reason||(plan.has_external_facts?'external_source_unavailable':'list_source_unavailable')});
 }catch(e){throw fail(['AUDIENCE_COUNT_ABORTED','AUDIENCE_COUNT_TIMEOUT','AUDIENCE_COUNT_UNCONFIRMED'].includes(e?.code)?e.code:'AUDIENCE_COUNT_UNCONFIRMED');}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}

module.exports={VERSION,ENABLED,ENGAGEMENT_SOURCE_SEMANTICS,engagementSourceHash,compileCount,countAudience};
