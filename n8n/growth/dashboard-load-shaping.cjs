'use strict';
// Offset the two read/aggregate snapshots, retaining cadence and overnight jobs.
const PLANS={
 RvXBh2GKPX91VfRx:{version:'77e5acf1-236b-40f2-b448-9aba8e1d9b40',node:'A cada 10min (6h-23h)',before:'*/10 6-23 * * *',after:'1-59/10 6-23 * * *'},
 SIzi3oTMH39LTbDj:{version:'a4143498-0ccd-4ae5-950e-6b37e28fbe93',node:'Cada 10 min (06–23h)',before:'*/10 6-23 * * *',after:'3-59/10 6-23 * * *'}
};
function patch(workflow){
 const plan=PLANS[workflow?.id];
 if(!plan||!workflow.active||workflow.versionId!==plan.version||workflow.activeVersionId!==plan.version)throw Error('SNAPSHOT_SOURCE_DRIFT');
 const out=structuredClone(workflow),nodes=out.nodes.filter(n=>n.name===plan.node);
 if(nodes.length!==1||nodes[0].type!=='n8n-nodes-base.scheduleTrigger')throw Error('SNAPSHOT_TRIGGER_DRIFT');
 const rules=nodes[0].parameters?.rule?.interval;
 if(rules?.length!==1||rules[0].field!=='cronExpression'||rules[0].expression!==plan.before)throw Error('SNAPSHOT_CADENCE_DRIFT');
 rules[0].expression=plan.after;
 out.settings={...out.settings,saveDataSuccessExecution:'none',saveExecutionProgress:false};
 return out;
}
module.exports={PLANS,patch};
