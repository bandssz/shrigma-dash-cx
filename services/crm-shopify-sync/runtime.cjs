'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const safeCode=e=>{for(const value of [e?.message,e?.code])if(/^[A-Z0-9_]{3,80}$/.test(value||''))return value;return 'CRM_SHOPIFY_SYNC_FAILED';};
const publicOperation=op=>({operation_id:op.operation_id,idempotency_key:op.idempotency_key,brand:op.brand,state:op.state,query_sha256:op.query_sha256,bulk_operation_id:op.bulk_operation_id||null,next_chunk:op.next_chunk??0,chunks:op.chunks??null,error_code:op.error_code||null});
function createRuntime({store,shopify,worker,brands,producerRevision,leaseSeconds=90,pollMs=5000,clock=()=>new Date(),pause=ms=>new Promise(r=>setTimeout(r,ms)),tempRoot=os.tmpdir(),maxPolls=20000}={}){
 if(!store||!shopify||!worker||!brands||!producerRevision)throw Error('CRM_SHOPIFY_RUNTIME_CONFIG');let chain=Promise.resolve(),closing=false;
 const renew=op=>store.renew(op.operation_id,op.lease,leaseSeconds);
 async function reconcileStart(op){const matches=await shopify.reconcileStart(op.brand),floor=Date.parse(op.intent_at||op.created_at)-5000,ceiling=clock().getTime()+5000,candidates=matches.filter(x=>{const at=Date.parse(x.createdAt);return Number.isFinite(at)&&at>=floor&&at<=ceiling;});if(candidates.length!==1){try{await store.startUncertain(op.operation_id,op.lease);}catch{}throw Object.assign(Error('CRM_SHOPIFY_START_AMBIGUOUS'),{uncertain:true});}return candidates[0].id;}
 const uncertainStore=async(code,fn)=>{try{return await fn();}catch(cause){if(cause?.code==='P0001'||/^(22|23|28|42)/.test(cause?.code||''))throw cause;throw Object.assign(Error(code),{uncertain:true,cause});}};
 async function runOperation(initial){let op=initial,file;
  try{
   if(op.state==='claimed'&&op.kind==='run'){
    const intent=crypto.createHash('sha256').update(op.brand+'\0'+op.idempotency_key+'\0'+shopify.querySha256).digest('hex'),permit=await uncertainStore('CRM_SHOPIFY_START_INTENT_UNKNOWN',()=>store.startIntent(op.operation_id,op.lease,intent));op={...op,...permit,state:'start_intent'};
    if(Date.parse(permit.permit_until)-clock().getTime()<1000)throw Error('CRM_SHOPIFY_LEASE_LOST');let id;
    try{id=await shopify.start(op.brand);}catch(e){if(!e?.uncertain)throw e;await uncertainStore('CRM_SHOPIFY_START_STATE_UNKNOWN',()=>store.startUncertain(op.operation_id,op.lease));op.state='start_uncertain';id=await reconcileStart(op);}
    if(!id)throw Error('CRM_SHOPIFY_START_UNKNOWN');await uncertainStore('CRM_SHOPIFY_BIND_UNKNOWN',()=>store.bindBulk(op.operation_id,op.lease,id));op.bulk_operation_id=id;op.state='bulk_running';
   }else if(['start_intent','start_uncertain'].includes(op.state)){const id=await reconcileStart(op);await uncertainStore('CRM_SHOPIFY_BIND_UNKNOWN',()=>store.bindBulk(op.operation_id,op.lease,id));op.bulk_operation_id=id;op.state='bulk_running';}
   if(op.kind==='recover'&&op.state==='claimed'){if(!op.bulk_operation_id)throw Error('CRM_SHOPIFY_RECOVERY_INPUT');await uncertainStore('CRM_SHOPIFY_BIND_UNKNOWN',()=>store.bindBulk(op.operation_id,op.lease,op.bulk_operation_id));op.state='bulk_running';}
   if(!op.bulk_operation_id)throw Error('CRM_SHOPIFY_BULK_MISSING');let polled;
   for(let count=0;count<maxPolls;count++){await renew(op);polled=await shopify.poll(op.brand,op.bulk_operation_id);if(polled.node.status==='COMPLETED')break;if(['FAILED','CANCELED','EXPIRED'].includes(polled.node.status)||polled.node.errorCode)throw Error('CRM_SHOPIFY_BULK_FAILED');await pause(pollMs);}
   if(polled?.node?.status!=='COMPLETED'||polled.node.errorCode!==null||polled.node.partialDataUrl!==null||typeof polled.node.url!=='string')throw Error('CRM_SHOPIFY_BULK_INCOMPLETE');
   await renew(op);const dir=await fs.promises.mkdtemp(path.join(tempRoot,'crm-shopify-sync-'));file=path.join(dir,'bulk.jsonl');const download=await shopify.download(polled.node.url,file);if(String(download.bytes)!==String(polled.node.fileSize))throw Error('CRM_SHOPIFY_DOWNLOAD_SIZE');
   const operation=structuredClone(polled.operation);delete operation.data.node.query;const observedAt=op.evidence_meta?.observed_at||clock().toISOString(),parsed=await worker.parse({file,input:{brand:op.brand,shop:brands[op.brand].shop,operation,observedAt,querySha256:shopify.querySha256,workflowId:brands[op.brand].workflowId,workflowVersion:producerRevision}});if(parsed.meta.source_sha256!==download.sha256)throw Error('CRM_SHOPIFY_DOWNLOAD_HASH');
   const staged=await uncertainStore('CRM_SHOPIFY_EVIDENCE_UNKNOWN',()=>store.evidence(op.operation_id,op.lease,parsed.meta,parsed.chunks.length));op={...op,...staged,state:'ingesting'};
   for(let part=Number(op.next_chunk||0);part<parsed.chunks.length;part++){
    await renew(op);const customers=parsed.chunks[part],status=await uncertainStore('CRM_SHOPIFY_CHUNK_STATUS_UNKNOWN',()=>store.chunkStatus(op.operation_id,op.lease,part,customers));if(status.status==='committed')continue;if(status.status!=='absent')throw Error('CRM_SHOPIFY_CHUNK_CONFLICT');
    try{await store.ingest(op.operation_id,op.lease,part,customers);}catch(e){let after;try{after=await store.chunkStatus(op.operation_id,op.lease,part,customers);}catch{throw Object.assign(Error('CRM_SHOPIFY_CHUNK_RESPONSE_UNKNOWN'),{uncertain:true,cause:e});}if(after.status==='committed')continue;try{await store.chunkUncertain(op.operation_id,op.lease,part,after.chunk_sha256);}catch{}throw Object.assign(Error('CRM_SHOPIFY_CHUNK_RESPONSE_UNKNOWN'),{uncertain:true,cause:e});}
   }
   return publicOperation(await uncertainStore('CRM_SHOPIFY_FINISH_UNKNOWN',()=>store.finish(op.operation_id,op.lease)));
  }catch(e){if(!e?.uncertain&&op?.operation_id&&op?.lease){try{await store.fail(op.operation_id,op.lease,safeCode(e));}catch{}}throw e;
  }finally{if(file){try{await fs.promises.rm(path.dirname(file),{recursive:true,force:true});}catch{}}}
 }
 function enqueue(op){chain=chain.catch(()=>{}).then(()=>closing?undefined:runOperation(op)).catch(()=>{});return chain;}
 async function request(command){const op=await store.claim({...command,lease_seconds:leaseSeconds,query_sha256:shopify.querySha256});if(op.owned===true&&!['completed','blocked'].includes(op.state))enqueue(op);return publicOperation(op);}
 async function recoverPending(){const pending=await store.pending();for(const item of pending.operations||[]){const op=await store.claim({idempotency_key:item.idempotency_key,brand:item.brand,kind:item.kind,scheduled_for:item.scheduled_for,bulk_operation_id:item.bulk_operation_id,lease_seconds:leaseSeconds,query_sha256:shopify.querySha256});if(op.owned===true)enqueue(op);}}
 const stop=async()=>{closing=true;await chain.catch(()=>{});};return Object.freeze({request,inspect:store.inspect,runOperation,recoverPending,stop});
}
module.exports={createRuntime,publicOperation};
