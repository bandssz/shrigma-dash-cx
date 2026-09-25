'use strict';
const fs=require('node:fs'),path=require('node:path');
const MARKER='CRM_EMAIL_ENVELOPE_V1';
const DECLARATION=fs.readFileSync(path.join(__dirname,'../../growth-email-contract.js'),'utf8').split("if(typeof module!=='undefined'&&module.exports)")[0];
const START='// Email drafts become new Listmonk templates. Existing production IDs are immutable here.';
const LEGACY_FIELDS="const r=p.rascunho,fields=['canal','marca','idioma','categoria','nome','peca','cabecalho','corpo','rodape','assunto'];";
const NEW_FIELDS=LEGACY_FIELDS.replace("'assunto']","'assunto','from_email','reply_to','preheader']");
function patchWorkflow(fresh,{expectedVersionId}={}){
 if(!fresh||!expectedVersionId||fresh.versionId!==expectedVersionId||!Array.isArray(fresh.nodes))throw Error('Fresh matching workflow required');
 const workflow=JSON.parse(JSON.stringify(fresh)),changes=[];
 const node=name=>{const ns=workflow.nodes.filter(n=>n.name===name&&n.type==='n8n-nodes-base.code');if(ns.length!==1)throw Error('Expected Code node '+name);return ns[0];};
 for(const name of ['Prepara','Decide escrita']){
  const n=node(name),code=n.parameters.jsCode;
  if(code.includes(MARKER)){if(!code.includes(DECLARATION))throw Error('Envelope contract drift');continue;}
  const start=code.indexOf(START),payload=code.indexOf('function emailPayload(r) {',start),end=code.indexOf(name==='Prepara'?'// API de escrita de templates':'// Decide a escrita com o estado',payload);
  if(start<0||payload<=start||end<=payload||code.indexOf(START,start+1)!==-1)throw Error('Email patch anchors changed');
  let errors=code.slice(start,payload);const target='  return errors;\n}';
  if(errors.split(target).length!==2||!errors.includes('function emailErrors(r) {'))throw Error('Email validator changed');
  errors=errors.replace(target,'  if(GEC.hasEnvelope(r))errors.push(...GEC.envelopeErrors(r));\n  errors.push(...GEC.documentErrors(r));\n'+target);
  n.parameters.jsCode=code.slice(0,start)+'// '+MARKER+'\n'+DECLARATION+'\n'+errors+'function emailPayload(r) { return GEC.payload(r); }\n\n'+code.slice(end);
  changes.push({node:name,field:'jsCode',scope:'email-envelope-and-render'});
 }
 const receipt=node('Formata leitura'),source=receipt.parameters.jsCode;
 if(!source.includes(NEW_FIELDS)){
  if(source.split(LEGACY_FIELDS).length!==2)throw Error('Receipt schema anchor changed');
  receipt.parameters.jsCode=source.replace(LEGACY_FIELDS,NEW_FIELDS);changes.push({node:receipt.name,field:'jsCode',scope:'email-envelope-receipt'});
 }
 return {workflow,changes};
}
module.exports={MARKER,DECLARATION,LEGACY_FIELDS,NEW_FIELDS,patchWorkflow};
