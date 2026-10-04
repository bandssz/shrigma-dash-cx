'use strict';
// Read only, literal HTTPS status endpoint. No socket/env/credential on import.
const https=require('node:https');
const R=require('./remote-operator.cjs'),P=require('./public-postcondition.cjs');
const {acceptProof}=require('../crm-manager-read-activation-review/runtime/read-proof.cjs');
const ERROR='READ_STATUS_READER_REFUSED';
function refuse(){throw Error(ERROR);}
function exact(v,keys){
 if(!v||Object.getPrototypeOf(v)!==Object.prototype||Reflect.ownKeys(v).length!==keys.length)refuse();
 for(const k of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,k);if(typeof k!=='string'||!keys.includes(k)||!d.enumerable||!Object.hasOwn(d,'value'))refuse();}
}
function supervisor(raw){
 const v=JSON.parse(raw);exact(v,['schema','action','state','childExitConfirmed','proofBarrierConfirmed','proof']);
 if(v.schema!=='crm-manager-read-supervisor-v1'||v.action!=='stage'||!['pending','verified','outcome_unknown','proof_refused'].includes(v.state)||typeof v.childExitConfirmed!=='boolean'||typeof v.proofBarrierConfirmed!=='boolean')refuse();
 let proof=null;
 if(v.state==='verified'){
  if(!v.childExitConfirmed||!v.proofBarrierConfirmed)refuse();
  proof=acceptProof(JSON.stringify(v.proof),'stage');
 }else if(v.childExitConfirmed||v.proofBarrierConfirmed||v.proof!==null)refuse();
 return Object.freeze({schema:v.schema,action:v.action,state:v.state,childExitConfirmed:v.childExitConfirmed,proofBarrierConfirmed:v.proofBarrierConfirmed,proof});
}
function createStatusReader(config={enabled:false},transport){
 if(!config||Object.getPrototypeOf(config)!==Object.prototype)refuse();const d=Object.getOwnPropertyDescriptor(config,'enabled');if(!d?.enumerable||!Object.hasOwn(d,'value')||typeof d.value!=='boolean')refuse();
 exact(config,d.value===true?['enabled','plan']:['enabled']);
 if(!d.value)return Object.freeze({enabled:false,observe:async()=>{refuse();}});
 const plan=R.assertRemotePlan(config.plan),host=plan.descriptor.domain.host,url='https://'+host+'/status';
 if(transport!==undefined)exact(transport,['request']);const request=transport===undefined?https.request:transport.request;if(typeof request!=='function')refuse();
 async function observe(q){
  exact(q,['schema','planSha256','url','method','maxBytes','timeoutMs']);
  const post=q.schema==='crm-manager-read-public-postcondition-request-v1';
  if(!post&&q.schema!=='crm-manager-read-public-status-request-v1'||q.planSha256!==plan.planSha256||q.url!==url||q.method!=='GET'||q.maxBytes!==(post?4096:2048)||q.timeoutMs!==35000)refuse();
  return new Promise((resolve,reject)=>{
   let req,res,timer,done=false,size=0,chunks=[];
   function finish(failed){
    if(done)return;done=true;clearTimeout(timer);
    try{req?.destroy();}catch{}try{res?.destroy();}catch{}
    if(failed){chunks=[];reject(Error(ERROR));return;}
    try{
     const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size));chunks=[];
     // Return only admitted values, never the raw upstream body (including
     // whitespace or an overwritten duplicate JSON key).
     resolve(post?JSON.stringify(P.acceptPostcondition(raw,plan)):supervisor(raw));
    }catch{chunks=[];reject(Error(ERROR));}
   }
   timer=setTimeout(()=>finish(true),35000);
   try{
    req=request({protocol:'https:',hostname:host,port:443,path:'/status',method:'GET',servername:host,rejectUnauthorized:true,minVersion:'TLSv1.2',agent:false,maxHeaderSize:8192,headers:{Accept:'application/json',Host:host,Connection:'close'}},response=>{
     res=response;res.on('error',()=>finish(true));res.once('aborted',()=>finish(true));
     const type=res.headers?.['content-type'],encoding=res.headers?.['content-encoding'],length=res.headers?.['content-length'];
     if(res.statusCode!==200||typeof type!=='string'||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(type)||encoding!==undefined&&encoding!=='identity'||length!==undefined&&(typeof length!=='string'||!/^\d+$/.test(length)||Number(length)>q.maxBytes)){finish(true);return;}
     res.on('data',chunk=>{if(done)return;if(!(chunk instanceof Uint8Array)){finish(true);return;}size+=chunk.byteLength;if(size>q.maxBytes){finish(true);return;}chunks.push(Buffer.from(chunk));});
     res.once('end',()=>finish(false));res.once('close',()=>{if(!res.complete&&!done)finish(true);});
    });
    if(!req||typeof req.on!=='function'||typeof req.end!=='function'||typeof req.destroy!=='function')refuse();
    req.on('error',()=>finish(true));req.end();
   }catch{finish(true);}
  });
 }
 return Object.freeze({enabled:true,observe});
}
module.exports=Object.freeze({createStatusReader,supervisor});
if(require.main===module){process.stderr.write(ERROR+'\n');process.exitCode=1;}
