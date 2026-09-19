/* Pure patch of a freshly exported shared read workflow. No file/network I/O.
   PostgreSQL json[b]_build_object accepts at most 100 arguments (50 pairs):
   append a separate jsonb object, never another pair to the central call.
   Keep raw exports private. Review changes before publishing the current copy. */
'use strict';
const FIELD='organico_attribution';
const SCOPE_TOKEN="{{ $('Busca painel').first().json.efetivo }}";
const FRAGMENT=" || jsonb_build_object('organico_attribution', CASE WHEN '"+SCOPE_TOKEN+"' IN ('organico','todos') THEN public.crm_organico_attribution_payload_v2((now() AT TIME ZONE 'America/Sao_Paulo')::date - 399,(now() AT TIME ZONE 'America/Sao_Paulo')::date) ELSE NULL END)";
const TOKEN="'organico_attribution',";
const clone=v=>JSON.parse(JSON.stringify(v));
const occurrences=(s,needle)=>s.split(needle).length-1;

function patchQuery(query,{remove=false}={}){
 if(typeof query!=='string')throw Error('Consulta payload must contain a query');
 const aliases=[...query.matchAll(/\bAS\s+payload\s*;/gi)];
 const anchor=/\s+AS\s+payload\s*;\s*$/i.exec(query);
 if(aliases.length!==1||!anchor)throw Error('Expected one final AS payload alias');
 const fields=occurrences(query,"'"+FIELD+"'");
 const index=anchor.index;
 const installed=query.slice(0,index).endsWith(FRAGMENT);
 if(fields){
  if(fields!==1||!installed||occurrences(query,FRAGMENT)!==1)throw Error('Organic field exists outside the recognized final concatenation; review the fresh query');
  return remove?query.slice(0,index-FRAGMENT.length)+query.slice(index):query;
 }
 if(remove)return query;
 return query.slice(0,index)+FRAGMENT+query.slice(index);
}

function patchWhitelist(code,{remove=false}={}){
 if(typeof code!=='string')throw Error('Recorta por painel must contain jsCode');
 const arrays=[...code.matchAll(/\borganico\s*:\s*\[([^\]]*)\]/g)];
 if(arrays.length!==1)throw Error('Expected one organic whitelist array');
 const match=arrays[0],start=match.index+match[0].indexOf('[')+1,body=match[1];
 const keys=[...body.matchAll(/(['"])organico_attribution\1/g)];
 if(keys.length>1)throw Error('Duplicate organic whitelist field');
 if(keys.length){
  if(!remove)return code;
  // Remove only our exact prefix; a later rearrangement must be reviewed, not
  // replaced with an old whitelist from a handoff.
  if(!body.startsWith(TOKEN))throw Error('Organic whitelist prefix changed; review before removing');
  return code.slice(0,start)+code.slice(start+TOKEN.length);
 }
 return remove?code:code.slice(0,start)+TOKEN+code.slice(start);
}

function patchWorkflow(fresh,{remove=false}={}){
 if(!fresh||!Array.isArray(fresh.nodes))throw Error('A fresh workflow export is required');
 const workflow=clone(fresh),changes=[];
 for(const [name,field,transform] of [['Consulta payload','query',patchQuery],['Recorta por painel','jsCode',patchWhitelist]]){
  const found=workflow.nodes.filter(n=>n.name===name);
  if(found.length!==1)throw Error('Expected exactly one node: '+name);
  const node=found[0],before=node.parameters?.[field],after=transform(before,{remove});
  if(before!==after){node.parameters[field]=after;changes.push({node:name,field});}
 }
 return {workflow,changes};
}
module.exports={FIELD,SCOPE_TOKEN,FRAGMENT,patchQuery,patchWhitelist,patchWorkflow};
