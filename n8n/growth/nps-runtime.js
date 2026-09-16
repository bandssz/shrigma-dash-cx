'use strict';
const copy=v=>JSON.parse(JSON.stringify(v));
const edge=node=>({node,type:'main',index:0});
function prepareNpsRuntime(workflow,kind,uuid){
 if(!['initial','reminder'].includes(kind))throw Error('NPS kind required');
 const w=copy(workflow),prefix=kind==='reminder'?'SES NPS D3':'SES NPS D0';
 const find=name=>{const n=w.nodes.find(n=>n.name===name);if(!n)throw Error('Missing node '+name);return n;};
 const http=find(prefix+' Listmonk'),finish=find(prefix+' finaliza'),reserve=find(prefix+' reserva');
 if(w.nodes.some(n=>n.name===prefix+' evidência'))throw Error('Already patched');
 if(http.parameters.method!=='POST'||http.retryOnFail)throw Error('Unexpected transport');
 const capture=copy(reserve);capture.id=uuid();capture.name=prefix+' evidência';capture.position=[http.position[0]+200,http.position[1]];
 capture.parameters={operation:'executeQuery',query:'SELECT * FROM public.shrigma_email_observe_engagement($1::uuid,$2::uuid,$3::jsonb,$4::jsonb);',options:{queryBatching:'independently',queryReplacement:finish.parameters.options.queryReplacement}};
 finish.parameters.options.queryReplacement='={{ [$json.dispatch_id,$json.claim_token,JSON.stringify($json.response),JSON.stringify($json.context)] }}';
 w.nodes.push(capture);w.connections[http.name]={main:[[edge(capture.name)]]};w.connections[capture.name]={main:[[edge(finish.name)]]};
 if(kind==='reminder'){
  const candidates=find('SES NPS candidatos'),sign=find('SES NPS assina lembrete'),guard=find(prefix+' deve enviar');
  const loop={id:uuid(),name:'NPS · Um contato por vez',type:'n8n-nodes-base.splitInBatches',typeVersion:3,position:[sign.position[0]-200,sign.position[1]],parameters:{batchSize:1,options:{}}};
  const wait={id:uuid(),name:'NPS · Intervalo entre contatos',type:'n8n-nodes-base.wait',typeVersion:1.1,position:[finish.position[0]+200,finish.position[1]],parameters:{resume:'timeInterval',amount:1,unit:'seconds'}};
  w.nodes.push(loop,wait);
  w.connections[candidates.name]={main:[[edge(loop.name)]]};
  w.connections[loop.name]={main:[[],[edge(sign.name)]]};
  w.connections[guard.name]={main:[[edge(http.name)],[edge(wait.name)]]};
  w.connections[finish.name]={main:[[edge(wait.name)]]};
  w.connections[wait.name]={main:[[edge(loop.name)]]};
 }
 return w;
}
module.exports={prepareNpsRuntime};
