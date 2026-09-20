'use strict';
const IDS={campaign:'tHER2Ecq2VHcBHOQ',templates:'y6qJRcWcSfEZzwgZ'};
function patchWorkflow(fresh,{expectedVersionId,area}={}){
 if(fresh?.id!==IDS[area]||!expectedVersionId||fresh.versionId!==expectedVersionId)throw Error('Fresh auxiliary workflow/version required');
 const w=structuredClone(fresh),n=w.nodes.find(n=>n.name===(area==='campaign'?'Entrada':'Autenticação entrada'));
 if(!n||n.type!=='n8n-nodes-base.code')throw Error('Auth entry changed');
 let before,after;
 if(area==='campaign'){
  before='const key=commandSource.k;';
  after="const authHeader=req.headers?.authorization;\nconst key=method==='GET'&&authHeader!==undefined?(typeof authHeader==='string'&&authHeader.startsWith('Bearer ')?authHeader.slice(7):''):commandSource.k;";
 }else{
  before="(req.body?.k||req.query?.k||'')";
  after="(req.headers?.authorization!==undefined?(typeof req.headers.authorization==='string'&&req.headers.authorization.startsWith('Bearer ')?req.headers.authorization.slice(7):''):(req.body?.k||req.query?.k||''))";
 }
 if(!n.parameters.jsCode.includes(before))throw Error('Expected auth anchor absent');
 n.parameters.jsCode=n.parameters.jsCode.replace(before,after);
 if(area==='templates')n.parameters.jsCode=n.parameters.jsCode.replace('const k=String(',"const k=String(req.headers?.origin&&req.headers.origin!=='https://bandssz.github.io'?'':");
 for(const node of w.nodes){
  if(node.type!=='n8n-nodes-base.respondToWebhook')continue;
  const entries=node.parameters.options?.responseHeaders?.entries;
  if(!Array.isArray(entries))continue;
  for(const h of entries)if(h.name.toLowerCase()==='access-control-allow-origin')h.value='https://bandssz.github.io';
  for(const h of entries)if(h.name.toLowerCase()==='access-control-allow-headers'&&!h.value.toLowerCase().includes('authorization'))h.value+=', Authorization';
 }
 w.settings={...w.settings,saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveExecutionProgress:false,saveManualExecutions:false};
 return w;
}
module.exports={IDS,patchWorkflow};
