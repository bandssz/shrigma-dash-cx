/* Growth segment definition + aggregate query only. No I/O, native campaign payload or transport. */
'use strict';
const VERSION='crm-segment-v1',LIMITS=Object.freeze({depth:4,nodes:32,children:16,bytes:12000}),TRANSPORT_SUPPORTED=false;
const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);
const fail=code=>{throw Object.assign(new Error(code),{code});};
function object(v,keys){
 if(!v||typeof v!=='object'||Array.isArray(v))fail('SEGMENT_SHAPE');
 const names=Reflect.ownKeys(v);if(names.length!==keys.length||names.some(k=>typeof k!=='string'||!keys.includes(k))||keys.some(k=>!own(v,k)))fail('SEGMENT_FIELDS');
 if(names.some(k=>!Object.getOwnPropertyDescriptor(v,k)?.enumerable||!own(Object.getOwnPropertyDescriptor(v,k),'value')))fail('SEGMENT_FIELDS');
}
const id=n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647;
function normalize(input){
 object(input,['schema_version','brand','name','rule']);
 if(input.schema_version!==VERSION)fail('SEGMENT_VERSION');
 if(!['fish','aristo'].includes(input.brand))fail('SEGMENT_BRAND');
 if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>160||/[\u0000-\u001f\u007f]/.test(input.name))fail('SEGMENT_NAME');
 let nodes=0;const active=new Set();
 function walk(r,depth){
  if(depth>LIMITS.depth||++nodes>LIMITS.nodes)fail('SEGMENT_LIMIT');
  if(active.has(r))fail('SEGMENT_CYCLE');
  if(!r||typeof r!=='object'||Array.isArray(r))fail('SEGMENT_RULE');
  const descriptor=Object.getOwnPropertyDescriptor(r,'op');if(!descriptor||!own(descriptor,'value'))fail('SEGMENT_RULE');
  if(r.op==='in_list'){object(r,['op','list_id']);if(!id(r.list_id))fail('SEGMENT_LIST_ID');return {op:'in_list',list_id:r.list_id};}
  object(r,['op','rules']);if(!['and','or'].includes(r.op)||!Array.isArray(r.rules)||r.rules.length<1||r.rules.length>LIMITS.children)fail('SEGMENT_RULE');
  active.add(r);const children=r.rules.map(x=>walk(x,depth+1));active.delete(r);
  // Sorting and deduplicating preserve E/OU. Depth/node limits apply to the input.
  const rules=[...new Map(children.map(x=>[JSON.stringify(x),x])).entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,x])=>x);
  return rules.length===1?rules[0]:{op:r.op,rules};
 }
 const definition={schema_version:VERSION,brand:input.brand,name:input.name.trim(),rule:walk(input.rule,1)};
 if(JSON.stringify(definition).length>LIMITS.bytes)fail('SEGMENT_LIMIT');return definition;
}
function listIds(definition){const found=new Set();const visit=r=>r.op==='in_list'?found.add(r.list_id):r.rules.forEach(visit);visit(definition.rule);return [...found].sort((a,b)=>a-b);}
function compileCount(input,{catalog,baseListId}={}){
 const definition=normalize(input);
 if(!id(baseListId))fail('SEGMENT_BASE_UNCONFIRMED');
 if(catalog?.brand!==definition.brand||catalog.current!==true||!Array.isArray(catalog.lists))fail('SEGMENT_CATALOG_UNCONFIRMED');
 const ids=[...new Set([baseListId,...listIds(definition)])].sort((a,b)=>a-b);
 for(const required of ids){const rows=catalog.lists.filter(l=>l?.id===required);if(rows.length!==1||rows[0].brand!==definition.brand||rows[0].available!==true)fail('SEGMENT_LIST_UNAVAILABLE');}
 const values=[definition.brand,ids,...ids],parameter=new Map(ids.map((n,i)=>[n,'$'+(i+3)+'::integer']));
 const membership=listId=>`EXISTS (SELECT 1 FROM public.subscriber_lists sl JOIN valid_lists l ON l.id=sl.list_id WHERE sl.subscriber_id=s.id AND l.id=${parameter.get(listId)} AND ((l.optin='double' AND sl.status::text='confirmed') OR (l.optin='single' AND sl.status::text IN ('confirmed','unconfirmed'))))`;
 const rule=r=>r.op==='in_list'?membership(r.list_id):'('+r.rules.map(rule).join(r.op==='and'?' AND ':' OR ')+')';
 const predicate=`s.status::text='enabled' AND ${membership(baseListId)} AND ${rule(definition.rule)}`;
 const text=`WITH valid_lists AS MATERIALIZED (
 SELECT l.id,l.optin::text AS optin FROM public.lists l WHERE l.id=ANY($2::integer[])
 AND l.status::text='active' AND public.shrigma_campaign_list_brand(l)=$1::text AND l.optin::text IN ('single','double')
), scope AS (SELECT count(*)=cardinality($2::integer[]) AS confirmed FROM valid_lists)
SELECT scope.confirmed AS source_confirmed,
 CASE WHEN scope.confirmed THEN (SELECT count(*) FROM public.subscribers s WHERE ${predicate}) ELSE NULL END AS eligible_count,
 statement_timestamp() AS checked_at FROM scope`;
 return {definition,canonical:JSON.stringify(definition),list_ids:ids,base_list_id:baseListId,text,values,transport_supported:false};
}
module.exports={VERSION,LIMITS,TRANSPORT_SUPPORTED,normalize,compileCount};
