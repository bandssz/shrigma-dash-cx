'use strict';
const fs=require('node:fs'),Evidence=require('../../n8n/growth/segment-shopify-product-evidence.cjs');
function createWorker({readFile=fs.promises.readFile,productSemantics='v1'}={}){
 if(!['v1','v2'].includes(productSemantics))throw Error('CRM_SHOPIFY_WORKER_MODE');
 const build=productSemantics==='v2'?Evidence.buildCustomerProductEvidenceV2:Evidence.buildCustomerProductEvidence;
 return Object.freeze({productSemantics,async parse({file,input}){if(typeof file!=='string'||!input||typeof input!=='object')throw Error('CRM_SHOPIFY_WORKER_INPUT');const jsonl=await readFile(file,'utf8'),evidence=build({...input,jsonl}),{customers,...meta}=evidence,chunks=[];if(customers.length===0)chunks.push([]);else for(let i=0;i<customers.length;i+=5000)chunks.push(customers.slice(i,i+5000));return {meta,chunks};}});
}
module.exports={createWorker};
