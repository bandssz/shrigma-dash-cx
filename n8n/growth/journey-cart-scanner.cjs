/* Backend-only candidate. Dry run is the default. This scanner has no claim,
   template API, HTTP transport or activation method. */
'use strict';
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const iso=v=>v instanceof Date&&Number.isFinite(v.getTime())?v.toISOString():typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&Number.isFinite(Date.parse(v))?v:null;
function createCartScanner({query,entries}){
 if(typeof query!=='function'||typeof entries?.enroll!=='function'||typeof entries?.check!=='function')throw Error('Bound SQL and entry reconciliation required');
 const rows=async(q,a=[])=>{const r=await query(q,a);if(!r||!Array.isArray(r.rows))throw Error('Scanner read unconfirmed');return r.rows;};
 return {async run({mode='dry_run',sourceIds=[],limit=100,cursor=null}={}){
  if(!['dry_run','capture'].includes(mode)||!Number.isSafeInteger(limit)||limit<1||limit>200||!Array.isArray(sourceIds)||sourceIds.length>200||sourceIds.some(x=>!Number.isSafeInteger(x)||x<=0))throw Error('Bounded source batch and explicit supported mode required');
  if(cursor&&(!iso(cursor.as_of)||!iso(cursor.due_at)||!UUID.test(cursor.entry_id||'')))throw Error('Scanner cursor invalid');
  const ids=[...new Set(sourceIds)].sort((a,b)=>a-b);
  const controls=await rows('SELECT clock_timestamp() AS observed_at,enabled,starts_at,template_cache_target FROM public.shrigma_journey_cart_control_v1 WHERE singleton');
  if(controls.length!==1||typeof controls[0].enabled!=='boolean')throw Error('Cohort read unconfirmed');
  const ctl=controls[0],now=iso(ctl.observed_at),start=iso(ctl.starts_at),asOf=cursor?iso(cursor.as_of):now;
  if(!now||!asOf||Date.parse(asOf)>Date.parse(now))throw Error('Scanner clock unconfirmed');
  if(ctl.enabled&&(!start||!ctl.template_cache_target))throw Error('Enabled cohort configuration unavailable');
  const sources=ids.length?await rows("SELECT id AS subscriber_id,attribs#>>'{fish,cart_abandoned_at}' AS ref FROM public.subscribers WHERE id=ANY($1::integer[]) ORDER BY id",[ids]):[];
  if(sources.some(x=>!ids.includes(x.subscriber_id))||new Set(sources.map(x=>x.subscriber_id)).size!==sources.length)throw Error('Source batch identity unconfirmed');
  const sourceMap=new Map(sources.map(x=>[x.subscriber_id,x]));
  const capture=ids.map(id=>{
   const source=sourceMap.get(id),ref=iso(source?.ref);
   const action=!source?'source_missing':!ref?'source_invalid':!ctl.enabled?'cohort_disabled':Date.parse(ref)<Date.parse(start)||Date.parse(ref)>Date.parse(now)?'outside_cohort':'would_capture';
   return {subscriber_id:id,ref,action};
  });
  // This is an attempt plan, not an eligibility or delivery assertion. Enrollment
  // rechecks current source/config/release in SQL and owns its deterministic key.
  let stopped=false;
  if(mode==='capture')for(const item of capture){
   if(item.action!=='would_capture')continue;
   if(stopped){item.action='not_attempted';continue;}
   try{
    const r=await entries.enroll(item.subscriber_id,item.ref);
    if(!r||typeof r.created!=='boolean'||(r.created&&!UUID.test(r.entry_id||''))||(r.entry_id&&!UUID.test(r.entry_id))||(!r.entry_id&&typeof r.reason!=='string'))throw Error('Enrollment receipt unconfirmed');
    item.action=r.created?'captured':r.entry_id?'already_captured':r.reason;item.entry_id=r.entry_id||null;
   }catch(_){item.action='capture_unconfirmed';stopped=true;}
  }
  const due=await rows("SELECT id AS entry_id,to_jsonb(due_at)#>>'{}' AS due_at,subscriber_id,to_jsonb(ref)#>>'{}' AS ref FROM public.shrigma_journey_cart_entry_v1 WHERE state='waiting' AND due_at<=$2::timestamptz AND ($3::timestamptz IS NULL OR (due_at,id)>($3::timestamptz,$4::uuid)) ORDER BY due_at,id LIMIT $1::integer",[limit+1,asOf,cursor?iso(cursor.due_at):null,cursor?.entry_id||null]);
  if(due.length>limit+1||due.some(x=>!UUID.test(x.entry_id||'')||!iso(x.due_at)))throw Error('Due page unconfirmed');
  const page=due.slice(0,limit).map(x=>({...x,action:'would_check'}));
  if(mode==='capture'&&!stopped)for(const item of page){
   if(stopped){item.action='not_attempted';continue;}
   try{
    const r=await entries.check(item.entry_id);
    if(!r||r.entry_id!==item.entry_id||!['waiting','reserved','cancelled','expired','blocked'].includes(r.state)||typeof r.reason!=='string'||!r.reason)throw Error('Entry check unconfirmed');
    item.action='checked';item.state=r.state;item.reason=r.reason;
   }catch(_){item.action='check_unconfirmed';stopped=true;}
  }
  if(mode==='capture'&&stopped)for(const item of page)if(item.action==='would_check')item.action='not_attempted';
  const last=page.at(-1);
  return {mode,observed_at:now,as_of:asOf,cohort_enabled:ctl.enabled,capture,due:page,stopped,sends:0,
   has_more:due.length>limit,next_cursor:!stopped&&due.length>limit&&last?{as_of:asOf,due_at:iso(last.due_at),entry_id:last.entry_id}:null};
 }};
}
module.exports={createCartScanner};
