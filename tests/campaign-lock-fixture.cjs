// Deterministic shared lock manager: one owner per name; contention never queues.
// Two clients share this object to model Web Locks across tabs of one origin.
module.exports=function createLocks(){
 const held=new Set();
 return {async request(name,options,callback){
  if(options.mode!=='exclusive'||options.ifAvailable!==true)throw Error('unexpected lock policy');
  if(held.has(name))return callback(null);
  held.add(name);try{return await callback({name,mode:'exclusive'});}finally{held.delete(name);}
 }};
};
