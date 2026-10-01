'use strict';
// Pure candidate builder. It performs no n8n, Shopify or network operation.
const crypto=require('node:crypto');

const WORKFLOW_ID='JkQ4xbNZFjqaWQbY';
const VERSION_ID='4a5eb5d2-b807-4d54-ab94-b9b7562c0af2';
const SOURCE_SHA256='f5ab689ebc2ef0b6dcd63f868295ff0147882060eeb656fb302217c7d0251af7';
const QUERY_SHA256='fdef3e40cd824e14bb7df19d3fb81dbe5668f00d97bbac956a3819148c873e17';
const PROJECTION_SHA256='82cc34eeb8a273776991b05a59237b6214ced6c20d7c5ab91e4408ba31290821';
const LEGACY_CODE_SHA256='324afa3894bebb933e6a82550076821ae8fa4aacc441e74d426906672f5d5a87';
const LEGACY_PROJECTION_PREFIX_SHA256='f8ccd01653df9fe3dc2ad8bb8a342b60e197f2a080a34f740ade5b95afd5b154';
const FOOTER_SHA256='b87aefbd5f2f9a696b57d945a6f975cf9bc6b33bc746d62f8e3c807777914db1';
const OLD_QUERY_BODY_SHA256='80ab30def752992250a9615635b00a43519ba2bfa9c7e03f5fbca42fae38d78c';
const NODE_HASHES={
 'Atribuição lê aristo':'56e6a4d8e7c9a9035840c4624ac29270fdfc4bb5e0a04c37cf9a3bb7fa94ac38',
 'Atribuição lê fish':'dc205a628773aa95e7cbf00d5d003de95792cd653e9bf78642762efacde53efc',
 'Atribuição por pedido':'2de6ff76da4170ec6d5c52c6392649a2c0cc53d82c84d429ec7eb0db559a02b1',
 'Atribuição lê olivas':'8978835a213dbe1dd3a10dadd79284572667ac857d4a6142f6ab4b347adfed07'
};
const MODULE_FOOTER="if(typeof module!=='undefined')module.exports=CRMAttribution;\n";

const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function stable(value){
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
 return JSON.stringify(value);
}
const clone=value=>JSON.parse(JSON.stringify(value));
function need(ok,code){if(!ok)throw Error(code);}
function one(nodes,name){const matches=nodes.filter(n=>n?.name===name);need(matches.length===1,'ATTRIBUTION_PATCH_NODE_'+name);return matches[0];}

function extractQuery(body){
 const prefix='={{ JSON.stringify({query:"',delimiter='",variables:';
 need(typeof body==='string'&&body.startsWith(prefix),'ATTRIBUTION_PATCH_QUERY_PREFIX');
 const at=body.indexOf(delimiter,prefix.length);need(at>prefix.length&&body.indexOf(delimiter,at+1)<0,'ATTRIBUTION_PATCH_QUERY_DELIMITER');
 return body.slice(prefix.length,at).replaceAll('\\n','\n').replaceAll('\\"','"').replaceAll('\\\\','\\');
}
function embedQuery(body,query){
 const prefix='={{ JSON.stringify({query:"',delimiter='",variables:',at=body.indexOf(delimiter,prefix.length);
 const encoded=query.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\n');
 return prefix+encoded+body.slice(at);
}
function composeCode(legacyCode,projection){
 need(sha(legacyCode)===LEGACY_CODE_SHA256,'ATTRIBUTION_PATCH_CODE_DRIFT');
 need(projection.endsWith(MODULE_FOOTER)&&sha(projection)===PROJECTION_SHA256,'ATTRIBUTION_PATCH_PROJECTION_DRIFT');
 const marker='\nconst raw=$input.all().map(i=>i.json);',at=legacyCode.indexOf(marker);
 need(at>0&&legacyCode.indexOf(marker,at+1)<0,'ATTRIBUTION_PATCH_FOOTER_BOUNDARY');
 const prefix=legacyCode.slice(0,at),footer=legacyCode.slice(at);
 need(sha(prefix)===LEGACY_PROJECTION_PREFIX_SHA256&&sha(footer)===FOOTER_SHA256,'ATTRIBUTION_PATCH_FOOTER_DRIFT');
 return projection.slice(0,-MODULE_FOOTER.length)+footer;
}

function patchAttributionRecipientWorkflow(sourceText,{expectedVersionId,expectedSourceSha256=SOURCE_SHA256,query,projection}={}){
 need(typeof expectedSourceSha256==='string'&&/^[a-f0-9]{64}$/.test(expectedSourceSha256),'ATTRIBUTION_PATCH_SOURCE_PIN');
 need(typeof sourceText==='string'&&sha(sourceText)===expectedSourceSha256,'ATTRIBUTION_PATCH_SOURCE_DRIFT');
 need(expectedVersionId===VERSION_ID,'ATTRIBUTION_PATCH_VERSION_REQUIRED');
 need(typeof query==='string'&&sha(query)===QUERY_SHA256,'ATTRIBUTION_PATCH_QUERY_DRIFT');
 need(typeof projection==='string','ATTRIBUTION_PATCH_PROJECTION_REQUIRED');
 const fresh=JSON.parse(sourceText);
 need(fresh.id===WORKFLOW_ID&&fresh.versionId===VERSION_ID&&fresh.activeVersionId===VERSION_ID&&fresh.active===true,'ATTRIBUTION_PATCH_FRESH_REQUIRED');
 need(Array.isArray(fresh.nodes)&&fresh.nodes.length===30,'ATTRIBUTION_PATCH_NODE_COUNT');
 need(fresh.activeVersion?.versionId===VERSION_ID&&fresh.activeVersion?.nodes?.length===30,'ATTRIBUTION_PATCH_ACTIVE_VERSION');
 need(stable(fresh.nodes)===stable(fresh.activeVersion.nodes)&&stable(fresh.connections)===stable(fresh.activeVersion.connections),'ATTRIBUTION_PATCH_ACTIVE_DRIFT');
 for(const [name,expected] of Object.entries(NODE_HASHES))need(sha(stable(one(fresh.nodes,name)))===expected,'ATTRIBUTION_PATCH_NODE_DRIFT_'+name);
 const oldQueryNode=one(fresh.nodes,'Atribuição lê fish');
 const oldBody=oldQueryNode.parameters?.jsonBody;
 need(sha(oldBody)===OLD_QUERY_BODY_SHA256,'ATTRIBUTION_PATCH_QUERY_BODY_DRIFT');
 const oldQuery=extractQuery(oldBody),candidate=query.replace(/\n$/,'');
 need((candidate.match(/ customer\{id\}/g)||[]).length===1&&candidate.replace(' customer{id}','')===oldQuery,'ATTRIBUTION_PATCH_QUERY_DELTA');
 const result=clone(fresh);
 for(const name of ['Atribuição lê aristo','Atribuição lê fish']){
  const node=one(result.nodes,name);
  need(sha(node.parameters.jsonBody)===OLD_QUERY_BODY_SHA256,'ATTRIBUTION_PATCH_QUERY_BODY_DRIFT');
  node.parameters.jsonBody=embedQuery(node.parameters.jsonBody,candidate);
 }
 one(result.nodes,'Atribuição por pedido').parameters.jsCode=composeCode(one(fresh.nodes,'Atribuição por pedido').parameters.jsCode,projection);
 return {workflow:result,changed_nodes:['Atribuição lê aristo','Atribuição lê fish','Atribuição por pedido']};
}

module.exports={WORKFLOW_ID,VERSION_ID,SOURCE_SHA256,QUERY_SHA256,PROJECTION_SHA256,NODE_HASHES,stable,sha,extractQuery,patchAttributionRecipientWorkflow};
