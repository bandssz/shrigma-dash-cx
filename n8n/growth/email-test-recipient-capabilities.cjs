'use strict';
// Change only the Growth capability declaration in the shared read helper.
// Install the reviewed backend and client before enabling the announcement.
const POLICY='crm_email_test_recipient_v2';
function patchWorkflow(fresh,{expectedVersionId,enabled}={}){
 if(!fresh||!expectedVersionId||fresh.versionId!==expectedVersionId||!Array.isArray(fresh.nodes)||typeof enabled!=='boolean')throw Error('Fresh matching version and explicit enabled flag required');
 const workflow=JSON.parse(JSON.stringify(fresh)),nodes=workflow.nodes.filter(n=>n.name==='Consulta payload');
 if(nodes.length!==1||typeof nodes[0].parameters?.query!=='string')throw Error('Expected one payload query');
 const before=nodes[0].parameters.query,re=/('capabilities',\s*\(CASE WHEN[^\n]+?THEN )'((?:[^']|'')+)'(::json(?:b)? ELSE NULL END\))/g,m=[...before.matchAll(re)];
 if(m.length!==1||!m[0][1].includes("IN ('growth','todos')"))throw Error('Growth capability scope changed');
 const current=JSON.parse(m[0][2].replaceAll("''","'"));
 if(current.templates?.submit_email!==true||typeof current.endpoints?.templates!=='string'||current.write_key_required!==true)throw Error('Existing template contract required');
 if(Object.hasOwn(current.templates,'email_test_recipient')&&current.templates.email_test_recipient!==POLICY)throw Error('Recipient capability changed');
 const next={...current,templates:{...current.templates}};
 if(enabled)next.templates.email_test_recipient=POLICY;else delete next.templates.email_test_recipient;
 const after=before.replace(re,()=>m[0][1]+"'"+JSON.stringify(next).replaceAll("'","''")+"'"+m[0][3]);nodes[0].parameters.query=after;
 return {workflow,changes:after===before?[]:[{node:'Consulta payload',field:'query',capability:POLICY,enabled}]};
}
module.exports={POLICY,patchWorkflow};
