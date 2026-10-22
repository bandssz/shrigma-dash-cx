'use strict';
// Single literal GET, no retries; OFF/import creates no I/O or credential path.
const M=require('./manual-disable.cjs');
function createObserver({enabled=false,plan}={},transport){
 if(enabled!==true)return Object.freeze({observe:async()=>{throw Error('MANUAL_DISABLE_OBSERVER_OFF');}});
 M.admitPlan(plan);const http=transport||require('node:https');
 return Object.freeze({observe(kind='supervisor'){
  if(!['supervisor','public'].includes(kind))return Promise.reject(Error('MANUAL_DISABLE_OBSERVER_REFUSED'));
  return new Promise((resolve,reject)=>{let done=false,bytes=0,raw='',decoder=new TextDecoder('utf-8',{fatal:true}),timer,req;
   const finish=(error,v)=>{if(done)return;done=true;clearTimeout(timer);if(error)reject(Error('MANUAL_DISABLE_OBSERVER_REFUSED'));else resolve(v);};
   try{req=http.request({hostname:plan.host,port:443,path:'/status',method:'GET',servername:plan.host,rejectUnauthorized:true,minVersion:'TLSv1.2',agent:false,headers:{accept:'application/json',connection:'close'}},res=>{
    if(res.statusCode!==200||!/^application\/json(?:\s*;|$)/i.test(res.headers['content-type']||'')){res.destroy();return finish(true);}
    res.on('data',chunk=>{try{bytes+=Buffer.byteLength(chunk);if(bytes>2048)throw 0;raw+=decoder.decode(chunk,{stream:true});}catch{res.destroy();finish(true);}});
    res.on('error',()=>finish(true));res.on('aborted',()=>finish(true));res.on('end',()=>{try{if(res.complete===false)throw 0;raw+=decoder.decode();finish(false,kind==='public'?M.acceptPublic(raw,plan):M.acceptStatus(raw));}catch{finish(true);}});
   });timer=setTimeout(()=>{req.destroy();finish(true);},35000);req.on('error',()=>finish(true));req.end();}catch{finish(true);}
  });
 }});
}
module.exports=Object.freeze({createObserver});
