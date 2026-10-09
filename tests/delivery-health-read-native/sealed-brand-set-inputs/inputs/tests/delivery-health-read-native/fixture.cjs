'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events');
const runtime=process.env.DELIVERY_HEALTH_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational'),file=path.join(runtime,'native-delivery-health.cjs'),D=require(file);
const inputRoot=process.env.DELIVERY_HEALTH_SOURCE||path.resolve(__dirname,'../../..');
const id='c83ab812-d6d8-467e-97b3-02046bbbdcf5',other='66666666-6666-4666-8666-666666666666',raw={brand:'aristo'},context={ownerId:'original-master'},password='SyntheticOnly.Password.NeverReturn',timestamp=Date.parse('2026-10-08T20:00:00Z');
const canonical=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const baseEvidence=()=>({schema_version:1,checked_at:'2026-10-08T19:00:00.123456+00:00',collector:{last_poll_ok_at:null,last_poll_count:null,last_error_at:null,last_error_code:null},queue:{checked_at:null,visible:null,inflight:null,delayed:null,error_at:null},pending_ingest_15min:0,conflicts:0,brands:['fish','aristo'].map(marca=>({marca,finalizacao_pendente:marca==='fish'?73:0,entregue_sem_gravacao:0,resultado_incerto:0,sem_confirmacao_15min:0,falhas_24h:0,reclamacoes_24h:0}))});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function accelerated(closeBranch=false){const exports={},module={exports},delays=[];new Function('require','module','exports','setTimeout','clearTimeout',fs.readFileSync(file,'utf8'))(require,module,exports,(fn,ms)=>{delays.push(ms);return setTimeout(fn,closeBranch?(ms===60000?200:ms===15000?65:ms===12000?60:ms===5000?30:10):(ms===60000?100:ms===15000?60:10));},clearTimeout);return{D:module.exports,delays};}
function fixture(opts={}){
 const X=opts.D||D,clients=[],calls=[],trace=[],gates=[],profiles=[];let revision=1;
 const profile=()=>({schema:'shrigma-private-database-credential-v1',revision,ownerId:context.ownerId,username:'fixture_reader',password,resource:{...X.RESOURCE},transport:{mode:'admitted-private-network'}});
 class Client extends EventEmitter{
  constructor(config){super();this.config=config;this.connection=new EventEmitter();this.connection.stream={encrypted:opts.encrypted||false};this.processID=1234;this.ends=0;clients.push(this);trace.push('construct');}
  ack(status,sql){if(opts.missingAck===sql)return;this.connection.emit('readyForQuery',{status:opts.wrongAck===sql?'E':status});if(opts.doubleAck===sql)this.connection.emit('readyForQuery',{status});}
  async connect(){trace.push('connect');opts.connectEntered?.resolve();if(opts.connectThrow)throw Error(password);if(opts.connectHook)await opts.connectHook();if(opts.connectWait)await opts.connectWait.promise;this.ack('I','connect');}
  async query(q){const sql=typeof q==='string'?q:q.text;calls.push(q);trace.push(sql===X.PEER?'peer':sql===X.BEGIN?'begin':sql===X.ROLLBACK?'rollback':'read');if(opts.queryHook)await opts.queryHook(q,this);if(opts.queryThrow===sql)throw Error(password);if(opts.holdRead&&sql===X.READ_SQL){opts.entered?.resolve();await opts.holdRead.promise;}if(opts.hang===sql)await new Promise(()=>{});
   let r,status;
   if(sql===X.PEER){status='I';r={command:'SELECT',rowCount:1,rows:[{database:'listmonk',sessionRole:'fixture_reader',currentRole:'fixture_reader',pid:1234,port:5432,engine:170005,ssl:false,read_only:'on',...(opts.peer||{})}]};}
   else if(sql===X.BEGIN){status='T';r={command:'BEGIN',rowCount:null,rows:[]};}
   else if(sql===X.ROLLBACK){status='I';r={command:'ROLLBACK',rowCount:null,rows:[]};}
   else{assert.equal(sql,X.READ_SQL);assert.equal(typeof q,'string');status='T';r={command:'SELECT',rowCount:1,rows:[{payload:{...baseEvidence(),...(opts.evidence||{})},...(opts.rowExtra||{})}]};}
   if(opts.result)r=opts.result(sql,r);this.ack(status,sql);return r;
  }
  async end(){this.ends++;trace.push('end');if(opts.endHook)await opts.endHook();if(opts.endThrow)throw Error(password);if(opts.endHang)await new Promise(()=>{});if(!opts.noEndEvent)this.emit('end');}
 }
 const args={enabled:true,driver:{Client,version:opts.version||'8.23.1',packageSha256:'a'.repeat(64)},getPrivateCredential:async value=>{assert.deepEqual(value,context);profiles.push(value);if(opts.credentialThrow)throw Error(password);return{...profile(),...(opts.credential||{})};},admitHealth:async input=>{gates.push(input);trace.push('gate:'+input.phase);const p=profile(),expected={admitted:true,ownerId:p.ownerId,profileRevision:p.revision,credentialBindingHash:sha(canonical({schema:p.schema,revision:p.revision,ownerId:p.ownerId,username:p.username,resource:p.resource,transport:p.transport})),resourceHash:sha(canonical(X.RESOURCE)),queryHash:X.queryHash,purpose:X.PURPOSE};if(opts.gateHook)await opts.gateHook(input);if(opts.deny===input.phase)throw Error(password);if(opts.badGate===input.phase)return{...expected,purpose:'read-only-migration-inventory'};return opts.gateResult?opts.gateResult(input,expected):expected;},now:()=>opts.clock===undefined?timestamp:opts.clock};
 const service=X.createDeliveryHealthRead(args);return{X,service,args,opts,clients,calls,trace,gates,profiles,changeRevision:()=>revision++};
}
const inspect=f=>f.service.inspect(raw,context);
const refused=async(f,code)=>{await assert.rejects(inspect(f),e=>{assert(!String(e).includes(password));if(code)assert.equal(e.code,code);return true;});assert(f.clients.every(c=>c.ends===1));};
module.exports={D,fixture,inspect,refused,baseEvidence,deferred,accelerated,raw,context,password,canonical,sha,inputRoot};
