'use strict';
// Pure, version-bound CRM20 patch; callers own fresh export, review and deployment.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {PLAN}=require('./email-test-workflow-patch.cjs');
const CONTRACT=fs.readFileSync(path.join(__dirname,'../../growth-email-contract.js'),'utf8').split("if(typeof module!=='undefined'&&module.exports)")[0];
const BASE={contract:'b69e8944d82f93e2858294bada96f96f73c0132088fa725688f4db819f4d6394',errors:'36df9c6ae03602c3a44f027d6c747158b685cc45b9b603a7e7393d89a2ea3c5c',plan:'80376f091a3a3aaefd25068cf004a23912205202ff0895ae7d7f4a0d6e0d3191'};
const MARKER='// CRM_EMAIL_ENVELOPE_V1\n',START='// Email drafts become new Listmonk templates. Existing production IDs are immutable here.';
const LEGACY_ACTIVE=String.raw`  if(/<\s*(script|iframe|object|embed|form|input|base|meta)\b|\bon[a-z]+\s*=|javascript\s*:|data\s*:/i.test(r.corpo||''))add('corpo','Remova scripts, formulários e conteúdo interativo do e-mail.');`;
const NEW_ACTIVE='  // CRM20: GEC.documentErrors validates passive metadata and active content.';
const LEGACY_VARIABLES=String.raw`  for(const t of [r.corpo,r.assunto,r.rodape]) {
    const leftovers=String(t||'').replace(/\{\{\s*\.Tx\.Data\.[a-zA-Z][a-zA-Z0-9_]{0,63}\s*\}\}/g,'');
    if(leftovers.includes('{{')||leftovers.includes('}}'))add('corpo','Use variáveis no formato {{ .Tx.Data.first_name }}.');
  }`;
const NEW_VARIABLES=String.raw`  for(const [field,t] of [['corpo',r.corpo],['assunto',r.assunto],['rodape',r.rodape]]) {
    const text=String(t||'');
    if(GEC.templateExpressions(text,field==='corpo'&&/<[a-z][\s\S]*>/i.test(text)).unsupported)add('corpo','Use variáveis no formato {{ .Tx.Data.first_name }}.');
  }`;
const sha=text=>createHash('sha256').update(text).digest('hex');
const once=(source,old,next)=>{if(source.split(old).length!==2)throw Error('CRM20 exact anchor changed');return source.replace(old,next);};
function patchWorkflow(fresh,{expectedVersionId}={}){
 if(!fresh||!expectedVersionId||fresh.versionId!==expectedVersionId||!Array.isArray(fresh.nodes))throw Error('Fresh matching workflow required');
 const workflow=JSON.parse(JSON.stringify(fresh)),changes=[];
 const node=name=>{const rows=workflow.nodes.filter(n=>n.name===name&&n.type==='n8n-nodes-base.code');if(rows.length!==1||typeof rows[0].parameters?.jsCode!=='string')throw Error('Expected Code node '+name);return rows[0];};
 for(const name of ['Prepara','Decide escrita']){
  const n=node(name),code=n.parameters.jsCode,begin=code.indexOf(MARKER)+MARKER.length,anchor=code.indexOf(START,begin),start=code.indexOf('function emailErrors(r) {',anchor),end=code.indexOf('function emailPayload(r)',start);
  if(code.split(MARKER).length!==2||code.split(START).length!==2||anchor<=begin||start<=anchor||end<=start||code[anchor-1]!=='\n')throw Error('CRM20 envelope anchors changed');
  const contract=code.slice(begin,anchor-1),errors=code.slice(start,end);
  if(contract!==CONTRACT&&sha(contract)!==BASE.contract)throw Error('CRM20 envelope baseline drift');
  let updated=errors;
  if(sha(errors)===BASE.errors)updated=once(once(errors,LEGACY_ACTIVE,NEW_ACTIVE),LEGACY_VARIABLES,NEW_VARIABLES);
  else if(sha(once(once(errors,NEW_ACTIVE,LEGACY_ACTIVE),NEW_VARIABLES,LEGACY_VARIABLES))!==BASE.errors)throw Error('CRM20 validator baseline drift');
  const next=code.slice(0,begin)+CONTRACT+code.slice(anchor-1,start)+updated+code.slice(end);
  if(next!==code){n.parameters.jsCode=next;changes.push({node:name,field:'jsCode',scope:'email-html-validation-only'});}
 }
 const plan=node('CRM Email Test plan');
 if(plan.parameters.jsCode!==PLAN){if(sha(plan.parameters.jsCode)!==BASE.plan)throw Error('CRM20 test plan baseline drift');plan.parameters.jsCode=PLAN;changes.push({node:plan.name,field:'jsCode',scope:'email-test-plan-only'});}
 return {workflow,changes};
}
module.exports={BASE,CONTRACT,LEGACY_ACTIVE,NEW_ACTIVE,LEGACY_VARIABLES,NEW_VARIABLES,patchWorkflow};
