'use strict';
// Narrow wire contract for this installer's four-field projection, not a GET export.
// n8n@2.0.2 public-api/index.ts validates requests before operationHandlers;
// workflowSettings.yml forbids extra keys, including GET-only timeSavedMode.
// WorkflowService.update:296–302 merges stored settings before persistence.
// https://github.com/n8n-io/n8n/blob/n8n%402.0.2/packages/cli/src/workflows/workflow.service.ts#L296-L302
const CONTRACT='n8n-public-workflow-write-2.0.2';
const SETTINGS=Object.freeze({
 saveExecutionProgress:'boolean',saveManualExecutions:'boolean',
 saveDataErrorExecution:['all','none'],saveDataSuccessExecution:['all','none'],
 executionTimeout:'number',errorWorkflow:'string',timezone:'string',executionOrder:'string',
 callerPolicy:['any','none','workflowsFromAList','workflowsFromSameOwner'],
 callerIds:'string',timeSavedPerExecution:'number',availableInMCP:'boolean'
});
const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
function check(ok,code){if(!ok)throw Error('TX_N8N_202_'+code);}
function serialize(body,method){
 check(record(body)&&Object.keys(body).length===4&&['name','nodes','connections','settings'].every(k=>own(body,k)),'BODY');
 check(typeof body.name==='string'&&Array.isArray(body.nodes)&&record(body.connections)&&record(body.settings),'BODY');
 for(const key of Object.keys(body.settings)){
  const value=body.settings[key];
  if(key==='timeSavedMode'){
   check(method==='PUT','CREATE_TIME_SAVED_MODE');
   check(value==='fixed'||value==='dynamic','TIME_SAVED_MODE');
   continue;
  }
  check(own(SETTINGS,key),'UNKNOWN_SETTING');
  const type=SETTINGS[key];
  check(Array.isArray(type)?type.includes(value):typeof value===type&&(type!=='number'||Number.isFinite(value)),'SETTING_TYPE');
 }
 let wire;try{wire=JSON.parse(JSON.stringify(body));}catch{throw Error('TX_N8N_202_JSON');}
 // Omit only this known field from PUT. Keep the reviewed full object unchanged
 // for readback: server merge must restore the exact existing mode and settings.
 if(method==='PUT')delete wire.settings.timeSavedMode;
 return wire;
}
module.exports={CONTRACT,forPut:body=>serialize(body,'PUT'),forCreate:body=>serialize(body,'POST')};
