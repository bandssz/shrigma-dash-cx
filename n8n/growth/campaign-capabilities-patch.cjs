'use strict';
// Publish only after runtime, authentication and zero-recipient technical proof.
// The endpoint is deployment metadata; keys are never accepted or included here.
const FLAGS={contract_version:'crm-campaign-v1',brands:['aristo','fish'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true};
function patchWorkflow(fresh,{expectedVersionId,endpoint}={}){
 if(!fresh||!expectedVersionId||fresh.versionId!==expectedVersionId||!Array.isArray(fresh.nodes))throw Error('Fresh matching workflow version required');
 const u=new URL(endpoint);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!/^\/webhook\/[A-Za-z0-9_-]+$/.test(u.pathname))throw Error('Trusted credential-free campaign endpoint required');
 const workflow=JSON.parse(JSON.stringify(fresh)),nodes=workflow.nodes.filter(n=>n.name==='Consulta payload');
 if(nodes.length!==1||typeof nodes[0].parameters?.query!=='string')throw Error('Expected one payload query');
 const q=nodes[0].parameters.query,re=/('capabilities',\s*\(CASE WHEN[^\n]+?THEN )'((?:[^']|'')+)'(::json(?:b)? ELSE NULL END\))/g,m=[...q.matchAll(re)];
 if(m.length!==1||!m[0][1].includes("IN ('growth','todos')"))throw Error('Capabilities scope changed; review fresh export');
 const current=JSON.parse(m[0][2].replaceAll("''","'"));
 if(!current.templates||!current.endpoints?.templates||current.write_key_required!==true)throw Error('Existing template contract missing');
 if(current.campaigns&&(JSON.stringify(current.campaigns)!==JSON.stringify(FLAGS)||current.endpoints.campaigns!==u.href))throw Error('Existing campaign contract differs; reconcile explicitly');
 const next={...current,campaigns:FLAGS,endpoints:{...current.endpoints,campaigns:u.href}};
 const after=q.replace(re,()=>m[0][1]+"'"+JSON.stringify(next).replaceAll("'","''")+"'"+m[0][3]);nodes[0].parameters.query=after;
 return {workflow,changes:after===q?[]:[{node:'Consulta payload',field:'query'}]};
}
module.exports={patchWorkflow,FLAGS};
