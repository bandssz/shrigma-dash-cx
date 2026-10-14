'use strict';
// Dedicated internal TEST API account only. No READ credential fallback.
const fs=require('node:fs'),crypto=require('node:crypto');
const FILE='/dashboard-data/journey-internal-test.json';
function createBindingReader({file=FILE,readFile,env=process.env}={}){
 function load(){
  let descriptor;
  try{
   let text;
   if(readFile)text=readFile();
   // Private Easypanel environment for the dedicated TEST API only. An
   // explicit invalid value fails closed; it never falls back to another key.
   else if(Object.prototype.hasOwnProperty.call(env,'DASHBOARD_JOURNEY_TEST_BINDING')){
    text=env.DASHBOARD_JOURNEY_TEST_BINDING;
    if(typeof text!=='string'||Buffer.byteLength(text)>8192)return null;
   }
   else{
    descriptor=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const stat=fs.fstatSync(descriptor);
    if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size>8192||typeof process.getuid==='function'&&stat.uid!==process.getuid())return null;
    text=fs.readFileSync(descriptor,'utf8');
   }
   const p=JSON.parse(text);
   if(!p||Object.keys(p).sort().join(',')!=='from,purpose,templateId,templateSha256,token,username'||p.purpose!=='crm.journey-internal-test'||typeof p.username!=='string'||!/^[A-Za-z0-9_.@-]{1,100}$/.test(p.username)||typeof p.token!=='string'||!p.token||p.token.length>512||!Number.isSafeInteger(p.templateId)||p.templateId<1||! /^[a-f0-9]{64}$/.test(p.templateSha256)||!p.from||Object.keys(p.from).some(k=>!['fish','aristo'].includes(k))||!Object.keys(p.from).length||Object.values(p.from).some(v=>typeof v!=='string'||v.length>250||/[\r\n]/.test(v)||!v.includes('@')))return null;
   return {...p,revision:crypto.createHash('sha256').update(text).digest('hex')};
  }catch{return null;}finally{if(descriptor!==undefined)fs.closeSync(descriptor);}
 }
 return Object.freeze({getBinding(brand){const p=load();return p&&p.from[brand]?{purpose:p.purpose,brand,active:true,txSend:true,revision:p.revision,templateId:p.templateId}:null;},privateApi(binding){const p=load();return p&&p.revision===binding.revision&&p.from[binding.brand]?{...p,fromEmail:p.from[binding.brand]}:null;}});
}
module.exports={createBindingReader,FILE};
