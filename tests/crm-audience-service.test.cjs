'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Readable}=require('node:stream'),{EventEmitter}=require('node:events');
const {createTransaction}=require('../services/crm-audience/transaction.cjs');
const {createServer,MAX_BODY,ORIGIN}=require('../services/crm-audience/server.cjs');
const {config}=require('../services/crm-audience/config.cjs');

function fakePool(control={}){
 const clients=[],pool={async connect(){const log=[],client={log,released:null,async query(input){const text=typeof input==='string'?input:input.text;log.push(text);if(text==='SELECT current_user AS role')return {rows:[{role:control.role||'crm_audience_api'}]};if(text==='COMMIT'&&control.commitFails)throw Error('lost commit ack');if(text==='COMMIT')return {command:control.commitRolledBack?'ROLLBACK':'COMMIT',rows:[]};if(text==='SELECT held'){await control.held;return {rows:[]};}return {rows:[]};},release(destroy){this.released=destroy;}};clients.push(client);return client;}};return {pool,clients};
}
test('config is OFF by default and pins the dedicated role, pool and timeout',()=>{
 const c=config({CRM_AUDIENCE_REVISION:'a'.repeat(40),CRM_PG_HOST:'postgres.internal',CRM_PG_USER:'crm_audience_api',CRM_PG_PASSWORD:'secret',CRM_PG_DATABASE:'listmonk'});
 assert.equal(c.enabled,false);assert.equal(c.regularEnabled,false);assert.equal(c.abEnabled,false);assert.equal(c.pg.user,'crm_audience_api');assert.equal(c.pg.max,4);assert.equal(c.pg.statement_timeout,10000);
 assert.throws(()=>config({...process.env,CRM_AUDIENCE_REVISION:'a'.repeat(40),CRM_PG_HOST:'db',CRM_PG_USER:'postgres',CRM_PG_PASSWORD:'x',CRM_PG_DATABASE:'listmonk'}),/CRM_AUDIENCE_CONFIG/);
});
test('transaction commits once on a dedicated verified connection',async()=>{
 const f=fakePool(),transaction=createTransaction({pool:f.pool});const value=await transaction(async tx=>{await tx.query('SELECT work');return 7;});
 assert.equal(value,7);assert.deepEqual(f.clients[0].log,['BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',"SET LOCAL statement_timeout='10000ms'",'SELECT current_user AS role','SELECT work','COMMIT']);assert.equal(f.clients[0].released,false);assert.equal(transaction.active(),0);
});
test('transaction rolls back and destroys the connection on work or commit uncertainty',async()=>{
 for(const control of [{workFails:true},{commitFails:true},{commitRolledBack:true}]){const f=fakePool(control),transaction=createTransaction({pool:f.pool});await assert.rejects(transaction(async()=>{if(control.workFails)throw Error('work failed');return true;}));assert.ok(f.clients[0].log.includes('ROLLBACK'));assert.equal(f.clients[0].released,true);}
});
test('abort before commit rolls back and destroys the connection',async()=>{
 const f=fakePool(),transaction=createTransaction({pool:f.pool}),controller=new AbortController();
 await assert.rejects(transaction(async tx=>{await tx.query('SELECT work');controller.abort();return true;},{signal:controller.signal}),{code:'CRM_AUDIENCE_TRANSACTION_ABORTED'});
 assert.ok(f.clients[0].log.includes('ROLLBACK'));assert.ok(!f.clients[0].log.includes('COMMIT'));assert.equal(f.clients[0].released,true);
});
test('drain tracks a transaction independently of an HTTP caller',async()=>{
 let release;const held=new Promise(resolve=>{release=resolve;}),f=fakePool({held}),transaction=createTransaction({pool:f.pool});const pending=transaction(tx=>tx.query('SELECT held'));
 while(transaction.active()!==1)await new Promise(resolve=>setImmediate(resolve));let drained=false;const drain=transaction.drain().then(()=>{drained=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);release();await pending;await drain;assert.equal(drained,true);
});
function inject(app,{method='GET',path='/healthz',headers={},body}={}){
 const raw=Array.isArray(headers)?headers:Object.entries(headers).flat(),normalized={};for(let i=0;i<raw.length;i+=2)normalized[String(raw[i]).toLowerCase()]=raw[i+1];
 const req=Readable.from(body===undefined?[]:[Buffer.isBuffer(body)?body:Buffer.from(body)]);Object.assign(req,{method,url:path,headers:normalized,rawHeaders:raw});
 return new Promise(resolve=>{const res=new EventEmitter();Object.assign(res,{destroyed:false,writableEnded:false,writeHead(status,responseHeaders){this.status=status;this.headers=Object.fromEntries(Object.entries(responseHeaders).map(([k,v])=>[k.toLowerCase(),v]));},end(value=''){this.writableEnded=true;const text=String(value);resolve({status:this.status,headers:this.headers,body:text?JSON.parse(text):null});}});app.server.emit('request',req,res);});
}
function serve(options={}){
 const calls=[],api={async handle(value){calls.push(value);return {status:200,headers:{'Cache-Control':'no-store'},body:{ok:true}};}},app=createServer({segments:api,binding:api,revision:'b'.repeat(40),enabled:true,...options});
 return {app,calls};
}
test('HTTP boundary passes one human bearer and exact request to each API',async t=>{
 const x=serve(),headers={Authorization:'Bearer human-key-123',Origin:ORIGIN};
 let r=await inject(x.app,{path:'/segments?acao=segmentos_listar&brand=fish',headers});assert.equal(r.status,200);assert.equal(r.headers['access-control-allow-origin'],ORIGIN);
 r=await inject(x.app,{method:'POST',path:'/campaign-audience',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({acao:'campanha_publico_obter',brand:'fish',campaign_id:1})});assert.equal(r.status,200);
 assert.deepEqual(x.calls,[{method:'GET',request:{headers:{Authorization:headers.Authorization,Origin:ORIGIN},query:{acao:'segmentos_listar',brand:'fish'}}},{method:'POST',request:{headers:{Authorization:headers.Authorization,Origin:ORIGIN},body:{acao:'campanha_publico_obter',brand:'fish',campaign_id:1}}}]);
});
test('HTTP boundary rejects ambiguous or malformed inputs before either API',async t=>{
 const x=serve(),auth={Authorization:'Bearer human-key-123',Origin:ORIGIN};
 const cases=[
  {path:'/segments?a=1&a=2',headers:auth,status:400},
  {method:'POST',path:'/segments',headers:auth,body:'{}',status:415},
  {method:'POST',path:'/segments',headers:{...auth,'Content-Type':'application/json'},body:'{',status:400},
  {method:'POST',path:'/segments',headers:{...auth,'Content-Type':'application/json','Content-Length':String(MAX_BODY+1)},status:413},
  {path:'/segments',headers:['Authorization','Bearer one-key','Authorization','Bearer two-key','Origin',ORIGIN],status:401},
  {path:'/segments',headers:{Authorization:'Bearer human-key-123',Origin:'https://evil.invalid'},status:403}
 ];
 cases.splice(3,0,{method:'POST',path:'/segments',headers:{...auth,'Content-Type':'application/json'},body:Buffer.from([0xc3,0x28]),status:400});
 for(const c of cases){const r=await inject(x.app,c);assert.equal(r.status,c.status,JSON.stringify(c));}assert.equal(x.calls.length,0);
});
test('OFF health has no secret and operations remain unavailable',async t=>{
 const api={async handle(){assert.fail('API must stay off');}},app=createServer({segments:api,binding:api,revision:'c'.repeat(40),enabled:false});
 const health=await inject(app);assert.deepEqual(health.body,{service:'crm-audience',revision:'c'.repeat(40),enabled:false,stopping:false});
 const denied=await inject(app,{path:'/segments',headers:{Authorization:'Bearer human-key-123'}});assert.equal(denied.status,503);assert.deepEqual(denied.body,{error:'CRM_AUDIENCE_DISABLED'});
});
test('enabling audience management does not enable campaign binding',async()=>{
 const x=serve(),request={method:'POST',path:'/campaign-audience',headers:{Authorization:'Bearer human-key-123','Content-Type':'application/json'},body:JSON.stringify({acao:'campanha_publico_vincular'})};
 assert.equal((await inject(x.app,request)).status,503);assert.equal(x.calls.length,0);
 const candidate=serve({bindingEnabled:true});assert.equal((await inject(candidate.app,request)).status,200);assert.equal(candidate.calls.length,1);
});
test('concurrency is bounded without queueing and stop waits for the active handler',async t=>{
 let release;const held=new Promise(resolve=>{release=resolve;}),api={async handle(){await held;return {status:200,body:{ok:true}};}},app=createServer({segments:api,binding:api,revision:'d'.repeat(40),enabled:true,maxInFlight:1}),headers={Authorization:'Bearer human-key-123'};
 const first=inject(app,{path:'/segments?acao=x',headers});while(app.active()!==1)await new Promise(resolve=>setImmediate(resolve));const busy=await inject(app,{path:'/segments?acao=x',headers});assert.equal(busy.status,503);
 let stopped=false;const stopping=app.stop().then(()=>{stopped=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);release();assert.equal((await first).status,200);await stopping;assert.equal(stopped,true);
});

test('regular prepare and schedule require their separate gate; original operation lookup remains reachable while OFF',async()=>{
 for(const options of [{bindingEnabled:true},{regularEnabled:true}]){const x=serve(options),headers={Authorization:'Bearer human-key-123','Content-Type':'application/json'};
  for(const acao of ['campanha_publico_preparar_envio','campanha_publico_agendar'])assert.equal((await inject(x.app,{method:'POST',path:'/campaign-audience',headers,body:JSON.stringify({acao})})).status,503);
  assert.equal(x.calls.length,0);assert.equal((await inject(x.app,{path:'/campaign-audience?acao=campanha_publico_agendamento_operacao&brand=fish&idempotency_key=original-op',headers:{Authorization:'Bearer human-key-123'}})).status,200);
 }
});
