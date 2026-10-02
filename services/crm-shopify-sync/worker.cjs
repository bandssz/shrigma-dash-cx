'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),Evidence=require('../../n8n/growth/segment-shopify-product-evidence.cjs');
const SELF_SHA256=crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
function createWorker({readFile=fs.promises.readFile,readStream=fs.createReadStream,productSemantics='v1',rfmRevision=null}={}){
 if(!['v1','v2'].includes(productSemantics))throw Error('CRM_SHOPIFY_WORKER_MODE');
 if(rfmRevision!==null&&(typeof rfmRevision!=='string'||!/^[a-f0-9]{7,64}$/.test(rfmRevision)))throw Error('CRM_SHOPIFY_WORKER_MODE');
 const build=productSemantics==='v2'?Evidence.buildCustomerProductEvidenceV2:Evidence.buildCustomerProductEvidence;
 return Object.freeze({productSemantics,async parse({file,input}){if(typeof file!=='string'||!input||typeof input!=='object')throw Error('CRM_SHOPIFY_WORKER_INPUT');const jsonl=await readFile(file,'utf8'),evidence=build({...input,jsonl}),{customers,...meta}=evidence,chunks=[];if(customers.length===0)chunks.push([]);else for(let i=0;i<customers.length;i+=5000)chunks.push(customers.slice(i,i+5000));return {meta,chunks};},
  // Candidate consumer only. Existing runtime/HTTP routes never invoke this.
  // Stream both exports in bounded chunks. Customer rows are reduced to GID,
  // transient identity digest and R/F/M accumulators before paid orders start.
  async parseRfm({customerFile,paidOrdersFile,input}){if(rfmRevision===null)throw Error('CRM_SHOPIFY_RFM_DISABLED');if(typeof customerFile!=='string'||typeof paidOrdersFile!=='string'||customerFile===paidOrdersFile||!input||typeof input!=='object'||input.producerRevision!==rfmRevision)throw Error('CRM_SHOPIFY_WORKER_INPUT');if(crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')!==SELF_SHA256)throw Error('RFM_EXPORT_SOURCE_DRIFT');const E=require('../../n8n/growth/segment-shopify-rfm-evidence.cjs');let state=E.prepareCustomerStream(input);state=await E.consumeCustomerStream(state,readStream(customerFile,{highWaterMark:64*1024}));const result=await E.consumePaidOrdersStream(state,readStream(paidOrdersFile,{highWaterMark:64*1024}));if(crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')!==SELF_SHA256)throw Error('RFM_EXPORT_SOURCE_DRIFT');return result;}
 });
}
module.exports={createWorker};
