'use strict';
const {Worker}=require('node:worker_threads'),path=require('node:path'),v8=require('node:v8'),P=require('./protocol.cjs');
class DatabaseSyncPg{
 #worker;#control;#response;#closed=false;#poisoned=false;#transaction=false;#active=false;#timeout;#statements;
 constructor(options,fixtureTransport){
  const r=P.registry();if(!options||typeof options!=='object')throw P.closedError('DASHBOARD_PG_CONFIG_REFUSED');
  this.#timeout=options.requestTimeoutMs??10000;if(!Number.isInteger(this.#timeout)||this.#timeout<1000||this.#timeout>30000)throw P.closedError('DASHBOARD_PG_CONFIG_REFUSED');
  this.#control=new Int32Array(new SharedArrayBuffer(8));this.#response=new Uint8Array(new SharedArrayBuffer(P.CAPACITY));this.#statements=new Map(r.statements.map(s=>[s.api+':'+s.sql,s]));
  this.#worker=new Worker(path.join(__dirname,'worker.cjs'),{workerData:{options,fixtureTransport,control:this.#control.buffer,response:this.#response.buffer}});
  this.#worker.on('error',()=>{this.#poisoned=true;});this.#worker.on('exit',code=>{if(code!==0&&!this.#closed)this.#poisoned=true;});
  try{this.#call({action:'open'});}catch(e){this.#poisoned=true;this.#worker.terminate();throw e;}
 }
 get isTransaction(){return this.#transaction;}
 get isOpen(){return !this.#closed&&!this.#poisoned;}
 #call(request){if(this.#closed||this.#poisoned)throw P.closedError('DASHBOARD_PG_UNAVAILABLE');if(this.#active)throw P.closedError('DASHBOARD_PG_REENTRANT_REFUSED');this.#active=true;
  try{Atomics.store(this.#control,1,0);Atomics.store(this.#control,0,P.PENDING);this.#worker.postMessage(request);const until=Date.now()+this.#timeout;
   while(Atomics.load(this.#control,0)!==P.DONE){const left=until-Date.now();if(left<=0){this.#poisoned=true;this.#worker.terminate();throw P.closedError('DASHBOARD_PG_ACK_UNKNOWN');}Atomics.wait(this.#control,0,P.PENDING,left);}
   const n=Atomics.load(this.#control,1);if(n<1||n>this.#response.length)throw P.closedError('DASHBOARD_PG_RESPONSE_REFUSED');const result=v8.deserialize(Buffer.from(this.#response.subarray(0,n)));this.#response.fill(0,0,n);Atomics.store(this.#control,0,P.IDLE);
   if(!result||typeof result.ok!=='boolean'||typeof result.transaction!=='boolean'||typeof result.poison!=='boolean'||Object.keys(result).sort().join(',')!==(result.ok?'ok,poison,transaction,value':'code,ok,poison,sqlstate,transaction')||!result.ok&&(!/^DASHBOARD_PG_[A-Z_]+$/.test(result.code)||result.sqlstate!==null&&!/^[0-9A-Z]{5}$/.test(result.sqlstate)))throw P.closedError('DASHBOARD_PG_RESPONSE_REFUSED');this.#transaction=result.transaction;
   if(result.poison){this.#poisoned=true;this.#worker.terminate();}if(!result.ok)throw P.closedError(result.code,result.sqlstate);return result.value;
  }catch(e){if(e?.code==='DASHBOARD_PG_RESPONSE_REFUSED'||!e?.code?.startsWith('DASHBOARD_PG_')){this.#poisoned=true;this.#worker.terminate();throw P.closedError('DASHBOARD_PG_RESPONSE_REFUSED');}throw e;}finally{this.#active=false;}
 }
 prepare(sql){const s=this.#statements.get('prepare:'+sql);if(!s)throw P.closedError('DASHBOARD_PG_SQL_NOT_ADMITTED');let big=false;const run=(method,params)=>{
   if(params.length!==s.parameterCount||params.some(v=>v===undefined||!['string','number','bigint'].includes(typeof v)&&v!==null||typeof v==='number'&&!Number.isFinite(v)||typeof v==='string'&&v.includes('\0')))throw P.closedError('DASHBOARD_PG_BIND_REFUSED');
   if(s.writes&&method!=='run'||!s.writes&&method==='run')throw P.closedError('DASHBOARD_PG_METHOD_REFUSED');
   const value=this.#call({action:'statement',id:s.id,method,params,readBigInts:big});if(method==='run')return Object.freeze({changes:big?BigInt(value.changes):value.changes,get lastInsertRowid(){throw P.closedError('DASHBOARD_PG_LAST_ROWID_UNSUPPORTED');}});
   const rows=value.map(r=>Object.assign(Object.create(null),r));return method==='get'?rows[0]:rows;
  };
  return Object.freeze({get:(...p)=>run('get',p),all:(...p)=>run('all',p),run:(...p)=>run('run',p),iterate:(...p)=>run('all',p)[Symbol.iterator](),setReadBigInts:value=>{if(typeof value!=='boolean')throw P.closedError('DASHBOARD_PG_BIGINT_REFUSED');big=value;},columns:()=>s.columns.map(name=>({name}))});
 }
 exec(sql){const s=this.#statements.get('exec:'+sql);if(!s)throw P.closedError('DASHBOARD_PG_SQL_NOT_ADMITTED');this.#call({action:'exec',id:s.id});}
 close(){if(this.#closed)return;try{if(!this.#poisoned)this.#call({action:'close'});}finally{this.#closed=true;this.#worker.terminate();}}
}
function createDatabaseSyncPg(options){return new DatabaseSyncPg(options);}
module.exports={createDatabaseSyncPg,DatabaseSyncPg};
