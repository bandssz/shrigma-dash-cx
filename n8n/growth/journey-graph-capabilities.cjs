'use strict';
// Pure, narrowly scoped announcement. Install and verify the draft-only RPC first.
const POLICY='journey_graph_draft_api_v1';
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
function endpointOK(value){try{const u=new URL(value);return typeof value==='string'&&u.href===value&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&/^\/webhook\/[A-Za-z0-9_-]{8,120}$/.test(u.pathname);}catch{return false;}}
function patchWorkflow(fresh,{expectedVersionId,enabled,endpoint}={}){
 if(!fresh||!expectedVersionId||fresh.versionId!==expectedVersionId||!Array.isArray(fresh.nodes)||typeof enabled!=='boolean'||!endpointOK(endpoint))throw Error('Fresh matching version, exact endpoint and explicit enabled flag required');
 const workflow=JSON.parse(JSON.stringify(fresh)),nodes=workflow.nodes.filter(n=>n.name==='Consulta payload');
 if(nodes.length!==1||typeof nodes[0].parameters?.query!=='string')throw Error('Expected one payload query');
 const before=nodes[0].parameters.query,re=/('capabilities',\s*\(CASE WHEN[^\n]+?THEN )'((?:[^']|'')+)'(::json(?:b)? ELSE NULL END\))/g,m=[...before.matchAll(re)];
 if(m.length!==1||m[0][1]!=="'capabilities', (CASE WHEN '{{ $('Busca painel').first().json.efetivo }}' IN ('growth','todos') THEN ")throw Error('Growth capability scope changed');
 const current=JSON.parse(m[0][2].replaceAll("''","'"));
 if(!plain(current)||current.write_key_required!==true||!plain(current.endpoints)||!endpointOK(current.endpoints.templates)||current.templates?.submit_email!==true)throw Error('Existing Growth contract required');
 if(Object.hasOwn(current,'journeys')&&!plain(current.journeys))throw Error('Journey contract changed');
 const hasPolicy=Object.hasOwn(current.journeys||{},'graph_drafts'),hasEndpoint=Object.hasOwn(current.endpoints,'journey_graph');
 if(hasPolicy!==hasEndpoint||hasPolicy&&(current.journeys.graph_drafts!==POLICY||current.endpoints.journey_graph!==endpoint))throw Error('Graph capability collision');
 if(!enabled&&!hasPolicy||enabled&&hasPolicy)return {workflow,changes:[]};
 const next={...current,endpoints:{...current.endpoints},journeys:{...(current.journeys||{})}};
 if(enabled){next.journeys.graph_drafts=POLICY;next.endpoints.journey_graph=endpoint;}
 else{delete next.journeys.graph_drafts;delete next.endpoints.journey_graph;if(!Object.keys(next.journeys).length)delete next.journeys;}
 nodes[0].parameters.query=before.replace(re,()=>m[0][1]+"'"+JSON.stringify(next).replaceAll("'","''")+"'"+m[0][3]);
 return {workflow,changes:[{node:'Consulta payload',field:'query',capability:POLICY,enabled}]};
}
module.exports={POLICY,patchWorkflow};
