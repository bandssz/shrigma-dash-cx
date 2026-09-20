'use strict';
// Pure patch: fresh version + exact anchors. No network, credentials or send.
const {RULE_HASHES,observePixPresentation,observationEligible,QUERY}=require('./pix-presentation-observation.cjs');
const MARKER='PIX_PRESENTATION_OBSERVATION_V1';
const OBSERVE='Observa apresentação PIX (PG)',GATE='Pode observar apresentação PIX?';
const RETURN='return { sql, saida };';
const OUTPUT_ERROR="if (j.error) s.aviso_pg = 'fechamento no banco falhou: ' + String(j.error.message || j.error).slice(0, 300);";
const PRELUDE=`// ${MARKER}: inspect only the exact body handed to Meta; never return its values.\nconst RULE_HASHES=${JSON.stringify(RULE_HASHES)};\n${observePixPresentation.toString()}\n`;
const OUTPUT_REPLACEMENT=`// ${MARKER}: keep the original receipt outcome and warning even when optional observation fails.
let finalization=j;
try { finalization=$('Finaliza (PG)').item.json; } catch {}
if (finalization.error) s.aviso_pg = 'fechamento no banco falhou: ' + String(finalization.error.message || finalization.error).slice(0, 300);
let observation=false;
try { observation=(${observationEligible.toString()})(finalization,$('Interpreta resposta').item.json); } catch {}
if (observation) s.pix_card_observation=j.pix_presentation_recorded===true?'recorded':'not_recorded';`;
function node(workflow,name,type){const found=workflow.nodes.filter(n=>n.name===name);if(found.length!==1||found[0].type!==type)throw Error('PIX_OBSERVATION_NODE_CHANGED: '+name);return found[0];}
function patchWorkflow(fresh,{expectedVersionId}={}){
 if(!fresh||!Array.isArray(fresh.nodes)||!expectedVersionId||fresh.versionId!==expectedVersionId)throw Error('PIX_OBSERVATION_FRESH_VERSION_REQUIRED');
 if(fresh.active===true&&fresh.activeVersionId!==fresh.versionId)throw Error('PIX_OBSERVATION_ACTIVE_VERSION_DIFFERS');
 if(fresh.activeVersion?.nodes&&JSON.stringify(fresh.activeVersion.nodes)!==JSON.stringify(fresh.nodes))throw Error('PIX_OBSERVATION_ACTIVE_NODES_DIFFER');
 if(fresh.activeVersion?.connections&&JSON.stringify(fresh.activeVersion.connections)!==JSON.stringify(fresh.connections))throw Error('PIX_OBSERVATION_ACTIVE_CONNECTIONS_DIFFER');
 const w=structuredClone(fresh),interpreter=node(w,'Interpreta resposta','n8n-nodes-base.code'),out=node(w,'Saída','n8n-nodes-base.code'),final=node(w,'Finaliza (PG)','n8n-nodes-base.postgres');
 if(w.nodes.some(n=>[OBSERVE,GATE].includes(n.name))||interpreter.parameters.jsCode.includes(MARKER)||out.parameters.jsCode.includes(MARKER))throw Error('PIX_OBSERVATION_ALREADY_PRESENT_REVIEW_FRESH');
 const c=interpreter.parameters.jsCode;
 if(c.split(RETURN).length!==2||!c.includes("const d = $('Decide envio').item.json;")||!c.includes('WA_UNCERTAIN_RESERVATION_V1')||/delete\s+from\s+shrigma_send_log/i.test(c))throw Error('PIX_OBSERVATION_INTERPRETER_CHANGED');
 if(out.parameters.jsCode.split(OUTPUT_ERROR).length!==2||!out.parameters.jsCode.includes('if (j.saida) return j.saida;'))throw Error('PIX_OBSERVATION_OUTPUT_CHANGED');
 const end={main:[[{node:'Saída',type:'main',index:0}]]};
 if(JSON.stringify(w.connections['Finaliza (PG)'])!==JSON.stringify(end)||final.parameters.query!=='={{ $json.sql }}'||final.retryOnFail===true)throw Error('PIX_OBSERVATION_FINALIZATION_CHANGED');
 const send=node(w,'Meta /messages','n8n-nodes-base.httpRequest');
 if(send.retryOnFail===true||send.parameters.jsonBody!=='={{ JSON.stringify($json.meta_body) }}')throw Error('PIX_OBSERVATION_TRANSPORT_CHANGED');
 interpreter.parameters.jsCode=PRELUDE+c.replace(RETURN,"return { sql, saida, pix_presentation_observation: observePixPresentation(d) };");
 out.parameters.jsCode=out.parameters.jsCode.replace(OUTPUT_ERROR,OUTPUT_REPLACEMENT);
 const gateExpr=`={{ (${observationEligible.toString()})($json,$('Interpreta resposta').item.json) }}`;
 const gate={name:GATE,type:'n8n-nodes-base.if',typeVersion:2.2,id:'637c2c8b-e2dd-4c4b-bac4-930a225ee393',position:[3080,-200],parameters:{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{id:'0a028873-d5f3-4a8c-abfa-07be3d3c1123',leftValue:gateExpr,rightValue:'',operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}}};
 const pg={name:OBSERVE,type:final.type,typeVersion:final.typeVersion,id:'9d1e2f18-a274-4bfa-a309-eb73823480a4',position:[3300,-200],credentials:structuredClone(final.credentials),onError:'continueRegularOutput',retryOnFail:false,parameters:{operation:'executeQuery',query:QUERY,options:{queryBatching:'independently',connectionTimeout:2,queryReplacement:"={{ [ $('Interpreta resposta').item.json.saida.log_id, $('Interpreta resposta').item.json.pix_presentation_observation.variant, $('Interpreta resposta').item.json.pix_presentation_observation.item_count, $('Interpreta resposta').item.json.pix_presentation_observation.version_sha256 ] }}"}}};
 w.nodes.push(gate,pg);
 w.connections['Finaliza (PG)']={main:[[{node:GATE,type:'main',index:0}]]};
 w.connections[GATE]={main:[[{node:OBSERVE,type:'main',index:0}],[{node:'Saída',type:'main',index:0}]]};
 w.connections[OBSERVE]=end;
 return {workflow:w,changes:[{node:interpreter.name,field:'jsCode'},{node:out.name,field:'jsCode'},{node:GATE,added:true},{node:OBSERVE,added:true},{node:'Finaliza (PG)',field:'connections'}]};
}
module.exports={MARKER,OBSERVE,GATE,RETURN,OUTPUT_ERROR,OUTPUT_REPLACEMENT,patchWorkflow};
