'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const sha=s=>createHash('sha256').update(s).digest('hex');
const EXPECTED={query:'903ab7895f8a7b31506344aa393a638ca8e9e3e4d3e127b88a025e2d7265fe54',code:'419f9850988f9706b0ccefc1f9ed7a47ee643256a7004e9896ec9d699e40b06f'};
function patch(workflow,{expectedVersionId}={}) {
  if(workflow?.id!=='3p35uZWGCZJEigiv'||!expectedVersionId||workflow.versionId!==expectedVersionId||workflow.activeVersionId!==expectedVersionId)throw Error('inventory_version_mismatch');
  const out=JSON.parse(JSON.stringify(workflow));
  const find=(name,type)=>{const a=out.nodes.filter(n=>n.name===name&&n.type===type);if(a.length!==1)throw Error('inventory_node_mismatch');return a[0];};
  const q=find('Previous snapshot','n8n-nodes-base.postgres'),b=find('Build snapshot','n8n-nodes-base.code');
  if(sha(q.parameters.query)!==EXPECTED.query||sha(b.parameters.jsCode)!==EXPECTED.code)throw Error('inventory_source_changed');
  const fragment=fs.readFileSync(path.join(__dirname,'email-inventory-query.sql'),'utf8').replace(/^--[^\n]*\n/,'').trim();
  q.parameters.query=q.parameters.query.trim().replace(/;$/,',\n')+fragment+';';
  const core=fs.readFileSync(path.join(__dirname,'email-inventory.cjs'),'utf8').replace(/module.exports=emailInventory;\s*$/,'');
  const needle='return [{json:{snapshot}}];';
  if(b.parameters.jsCode.split(needle).length!==2)throw Error('inventory_footer_changed');
  b.parameters.jsCode=core+'\n'+b.parameters.jsCode.replace(needle,"snapshot.email_steps=emailInventory($('Previous snapshot').first().json.email_steps,$('Previous snapshot').first().json.captured_at); "+needle);
  return out;
}
module.exports={patch,EXPECTED};
