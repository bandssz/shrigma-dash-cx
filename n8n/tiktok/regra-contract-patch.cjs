'use strict';
// Announce only AFTER the atomic action and its harmless refusal are verified.
// Read-side discovery is not authorization. The action server enforces all guards.
const OLD=') AS payload`;';
const NEW=") || jsonb_build_object('regra_contrato','atomic_v1') AS payload`;";
function patchCode(code){
 if(typeof code!=='string')throw Error('SQL source required');
 if(code.includes(NEW))return code;
 if(code.split(OLD).length!==2||code.includes("'regra_contrato'"))throw Error('Payload boundary drift; review fresh source');
 return code.replace(OLD,NEW);
}
function patchWorkflow(fresh,{expectedVersion,actionVerified=false}={}){
 if(!actionVerified)throw Error('Verified atomic action required before discovery');
 if(!expectedVersion||fresh?.versionId!==expectedVersion)throw Error('Fresh version required');
 const w=JSON.parse(JSON.stringify(fresh));const nodes=w.nodes.filter(n=>n.name==='Monta SQL');
 if(nodes.length!==1)throw Error('Unique Monta SQL required');
 nodes[0].parameters.jsCode=patchCode(nodes[0].parameters.jsCode);return w;
}
module.exports={OLD,NEW,patchCode,patchWorkflow};
