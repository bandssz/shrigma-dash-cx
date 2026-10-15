'use strict';
// Pure preparation only. No HTTP, n8n credential, activation or database writer.
const crypto=require('node:crypto'),WORKFLOW='nFlCQOnI86ixZj7v';
function envelopeRuntime(){
 const raw=$input.first().json,body=raw.result||raw;
 if(!Number.isInteger(body._http)||body._http<200||body._http>599||!body._body||typeof body._body!=='object')return [{json:{_http:502,_body:{erro:'test_receipt_unconfirmed'}}}];
 let result={_http:body._http,_body:body._body},native,claim,gate;
 try{native=$('TEST nativo').first().json;claim=$('Confere claim').first().json;gate=$('Gate').first().json;}catch{}
 const op=body._body.operation;
 if(gate?.action==='send'&&claim?._route==='send'&&native&&op&&op.idempotency_key===claim.operation_id&&op.actor===claim.who&&op.brand===gate.brand){
  let truncated=false;const key=typeof gate.key==='string'?gate.key:'',seen=new Set();
  function clean(value,depth=0){
   if(depth>30){truncated=true;return '[DEPTH_LIMIT]';}
   if(typeof value==='string'){
    if(value.length>2*1024*1024){truncated=true;value=value.slice(0,2*1024*1024);}
    if(key.length>=8)value=value.split(key).join('[PRIVATE_CREDENTIAL]');
    return value.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_~.-]+/gi,'[PRIVATE_AUTH]').replace(/\b(password|secret|access_token|refresh_token|api_key)\s*[:=]\s*["']?[^\s,"'<>}]+/gi,'$1=[PRIVATE_CREDENTIAL]');
   }
   if(value===null||typeof value==='boolean'||typeof value==='number')return value;
   if(value===undefined)return null;
   if(typeof value!=='object')return String(value);
   if(seen.has(value)){truncated=true;return '[CYCLE]';}seen.add(value);
   let output;if(Array.isArray(value))output=value.map(x=>clean(x,depth+1));else{output=Object.create(null);for(const k of Object.getOwnPropertyNames(value)){if(/^(authorization|auth|cookie|set-cookie|password|secret|token|api_?key|access_token|refresh_token|preview_token|claim_token|credentials|headers|request|request_options|config)$/i.test(k))output[k]='[PRIVATE_FIELD]';else output[k]=clean(value[k],depth+1);}}
   seen.delete(value);return output;
  }
  const exception=native.error?clean(native.error):null;
  const captured=clean(native.body??null),available=native.body!==undefined||exception!==null,status=Number.isInteger(native.statusCode)&&native.statusCode>=200&&native.statusCode<=599?native.statusCode:null;
  // Bound the entire UTF8 response, including JSON escaping and the old receipt.
  function bytes(s){let n=0;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c<128)n++;else if(c<2048)n+=2;else if(c>=55296&&c<=56319&&s.charCodeAt(i+1)>=56320&&s.charCodeAt(i+1)<=57343){n+=4;i++;}else n+=3;}return n;}
  const budget=Math.max(0,Math.min(256*1024,2*1024*1024-bytes(JSON.stringify(result))-8192));
  let diagnostic={schema:'crm-native-campaign-test-diagnostic-v1',operation_id:claim.operation_id,brand:gate.brand,native_status:status,body:captured,error:exception,available,capture_complete:available&&!truncated};
  const encoded=JSON.stringify(diagnostic),originalBytes=bytes(encoded);
  if(originalBytes>budget){
   diagnostic={...diagnostic,body:null,error:null,capture_complete:false,truncated:true,original_bytes:originalBytes};
   const room=Math.max(0,Math.floor((budget-bytes(JSON.stringify(diagnostic))-256)/6));
   diagnostic.body={format:'sanitized-json-prefix',prefix:encoded.slice(0,room)};
  }
  if(bytes(JSON.stringify(diagnostic))<=budget)result={...result,_body:{...body._body,native_diagnostic:diagnostic}};
 }
 return [{json:result}];
}
const CODE='return ('+envelopeRuntime.toString()+')();';
const sha=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function prepare(workflow,{expectedVersion}={}){
 if(workflow?.id!==WORKFLOW||typeof expectedVersion!=='string'||workflow.activeVersionId!==expectedVersion||workflow.active!==true)throw Error('TEST_ERROR_SOURCE_VERSION_REQUIRED');
 const graph=workflow.activeVersion?.nodes?workflow.activeVersion:workflow;
 if(!Array.isArray(graph.nodes)||graph.nodes.length!==20||graph.nodes.filter(n=>n.name==='Envelope'&&n.type==='n8n-nodes-base.code').length!==1||graph.nodes.filter(n=>n.name==='TEST nativo'&&n.type==='n8n-nodes-base.httpRequest').length!==1)throw Error('TEST_ERROR_SOURCE_GRAPH_REQUIRED');
 const before=structuredClone(graph.nodes),nodes=structuredClone(graph.nodes),envelope=nodes.find(n=>n.name==='Envelope');
 if(typeof envelope.parameters?.jsCode!=='string'||!envelope.parameters.jsCode.includes('test_receipt_unconfirmed')||envelope.parameters.jsCode.includes('native_diagnostic'))throw Error('TEST_ERROR_ORIGINAL_ENVELOPE_REQUIRED');
 envelope.parameters.jsCode=CODE;
 if(nodes.some((n,i)=>n.name!=='Envelope'&&sha(n)!==sha(before[i])))throw Error('TEST_ERROR_OTHER_NODE_CHANGED');
 return {body:{name:workflow.name,nodes,connections:structuredClone(graph.connections),settings:structuredClone(workflow.settings||{})},diff:{workflowId:WORKFLOW,sourceVersion:expectedVersion,changedNodes:['Envelope'],nodeCount:20,otherNodesPreserved:true,connectionsPreserved:true,settingsPreserved:true,credentialReferencesPreserved:true,nativePostPreserved:true,sqlPreserved:true,remoteApplied:false,beforeSha256:sha(before.find(n=>n.name==='Envelope')),afterSha256:sha(envelope)}};
}
module.exports={WORKFLOW,CODE,prepare};
