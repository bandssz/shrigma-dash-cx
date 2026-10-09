'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const core=require((process.env.SCHEDULER_BINDING_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational'))+'/native-scheduler-diagnostic-transport.cjs');
const {createNativeSchedulerDiagnosticTransport:create,MAX_BYTES,TIMEOUT_MS,CURRENT_SCHEMA,CREDENTIAL_SCHEMA}=core;
const URL='http://comunicacao_listmonk:9000/api/internal/campaign-scan-diagnostic';
const SECRET='synthetic-private-token-never-a-real-credential';
const AUTH='token synthetic-reader:'+SECRET;
const dto=()=>({data:{phase:'SelectContext',sqlstate:'42501',timestamp:'2026-10-08T14:00:00.123456789Z'}});
const proof=()=>({schema:CURRENT_SCHEMA,service:'comunicacao/listmonk',serviceBinding:'1'.repeat(64),runtimeBinding:'2'.repeat(64),identityBinding:'3'.repeat(64),credentialBinding:'4'.repeat(64),authorizationBinding:'5'.repeat(64)});
const cred=()=>({schema:CREDENTIAL_SCHEMA,identityBinding:proof().identityBinding,credentialBinding:proof().credentialBinding,authorization:AUTH});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function response(body=JSON.stringify(dto()),options={}){
 const stats={reads:0,readerCancel:0,bodyCancel:0,releases:0};
 const chunks=options.chunks||[Buffer.from(body)];
 let index=0;
 const reader={
  read(){stats.reads++;return options.read?options.read(stats):Promise.resolve(index<chunks.length?{done:false,value:chunks[index++]}:{done:true});},
  cancel(){stats.readerCancel++;return options.cancel?options.cancel():Promise.resolve();},
  releaseLock(){stats.releases++;}
 };
 const bodyObject={getReader:()=>reader,cancel:()=>{stats.bodyCancel++;return Promise.resolve();}};
 const result={
  url:options.url===undefined?URL:options.url,redirected:options.redirected===undefined?false:options.redirected,
  status:options.status===undefined?200:options.status,
  headers:{get:name=>name==='content-type'?(options.contentType===undefined?'application/json; charset=utf-8':options.contentType):name==='content-length'?(options.length===undefined?null:options.length):null},
  body:options.body===undefined?bodyObject:options.body
 };
 if(options.headers)result.headers=options.headers;
 return {result,stats,reader};
}
function harness(options={}){
 const calls={fetch:[],current:[],credential:[]};
 const r=options.response||response();
 const transport=create({
  fetchImpl:async(url,init)=>{calls.fetch.push({url,init});return options.fetch?options.fetch(url,init):r.result;},
  authorizeCurrent:async q=>{calls.current.push(q);return options.current?options.current(q,calls.current.length):proof();},
  resolveCredential:async q=>{calls.credential.push(q);return options.credential?options.credential(q,calls.credential.length):cred();}
 });
 return {transport,calls,r};
}
async function refusal(promise,code){
 await assert.rejects(promise,error=>{
  assert.equal(error.code,code);assert.equal(error.message,code);
  assert.equal(error.stack,'ScannerDiagnosticRefusal: '+code);
  assert.ok(core.REFUSAL_CODES.includes(code));
  assert.equal(Object.hasOwn(error,'cause'),false);
  assert.ok(Object.isFrozen(error));
  assert.ok(!JSON.stringify(error).includes(SECRET));
  assert.ok(!String(error.stack).includes(SECRET));
  return true;
 });
}
test('fixed one GET, empty arguments, exact frozen DTO and CURRENT/credential rechecks',async()=>{
 const h=harness(),got=await h.transport({});
 assert.deepEqual(got,dto());assert.ok(Object.isFrozen(got));assert.ok(Object.isFrozen(got.data));
 assert.equal(h.calls.fetch.length,1);
 const {url,init}=h.calls.fetch[0];
 assert.equal(url,URL);
 assert.deepEqual(Object.keys(init).sort(),['cache','credentials','headers','method','redirect','signal']);
 assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');
 assert.deepEqual(init.headers,{Accept:'application/json',Authorization:AUTH});
 assert.equal(Object.hasOwn(init,'body'),false);assert.equal(Object.hasOwn(init.headers,'Cookie'),false);
 assert.ok(init.signal instanceof AbortSignal);assert.ok(Object.isFrozen(init));assert.ok(Object.isFrozen(init.headers));
 assert.deepEqual(h.calls.current.map(q=>q.stage),['before','before','after']);
 assert.equal(h.calls.credential.length,2);
 assert.deepEqual(h.calls.current[0].target,{project:'comunicacao',service:'listmonk'});
 assert.equal(h.calls.current[0].expectedBinding,null);
 assert.ok(Object.isFrozen(h.calls.current[1].expectedBinding));
 assert.equal(h.r.stats.readerCancel,1);assert.equal(h.r.stats.releases,1);
 assert.ok(!JSON.stringify(got).includes(SECRET));assert.ok(!JSON.stringify(got).includes('Binding'));
});
test('null means only no captured failure; repeated explicit reads are not cached',async()=>{
 const h=harness({response:response('{"data":null}')});
 assert.deepEqual(await h.transport({}),{data:null});
 // A new synthetic response per request avoids reusing an exhausted stream.
 const h2=harness({fetch:()=>response('{"data":null}').result});
 assert.deepEqual(await h2.transport({}),{data:null});assert.deepEqual(await h2.transport({}),{data:null});
 assert.equal(h2.calls.fetch.length,2);assert.equal(h2.calls.current.length,6);
});
test('factory requires only private function hooks; no enabled boolean or ambient fetch fallback',t=>{
 const make=()=>({fetchImpl:()=>response().result,authorizeCurrent:()=>proof(),resolveCredential:()=>cred()});
 for(const value of [undefined,{},true,{...make(),enabled:true},{...make(),authorizeCurrent:true},{...make(),resolveCredential:null},{...make(),fetchImpl:null}]){
  assert.throws(()=>create(value),e=>e.code==='SCANNER_DIAGNOSTIC_NOT_CONFIGURED'&&e.message===e.code);
 }
 let accessed=0;const accessor=make();Object.defineProperty(accessor,'authorizeCurrent',{enumerable:true,get(){accessed++;throw Error(SECRET);}});
 assert.throws(()=>create(accessor),e=>e.code==='SCANNER_DIAGNOSTIC_NOT_CONFIGURED');assert.equal(accessed,0);
 t.mock.method(global,'fetch',()=>{throw Error('ambient fetch must not be called');});
 assert.throws(()=>create({authorizeCurrent:()=>proof(),resolveCredential:()=>cred()}),e=>e.code==='SCANNER_DIAGNOSTIC_NOT_CONFIGURED');
});
test('caller selectors, hidden keys, getters, symbols and non-plain arguments are refused before private hooks',async()=>{
 const h=harness();let accessed=0;
 const getter={};Object.defineProperty(getter,'actor',{enumerable:true,get(){accessed++;throw Error(SECRET);}});
 const hidden={};Object.defineProperty(hidden,'enabled',{value:true});
 const proxy=new Proxy({}, {getPrototypeOf(){throw Error(SECRET);}});
 for(const input of [undefined,null,true,[],Object.create(null),{brand:'fish'},{campaign:174},{path:'/api/tx'},{method:'POST'},{identity:'owner'},{admitted:true},getter,hidden,{[Symbol('secret')]:SECRET},proxy]){
  await refusal(h.transport(input),'SCANNER_DIAGNOSTIC_INPUT_REFUSED');
 }
 assert.equal(accessed,0);assert.equal(h.calls.current.length,0);assert.equal(h.calls.credential.length,0);assert.equal(h.calls.fetch.length,0);
});
test('boolean, missing, wrong-service and accessor CURRENT results never become grants',async()=>{
 let accesses=0;
 const accessor=proof();Object.defineProperty(accessor,'runtimeBinding',{enumerable:true,get(){accesses++;throw Error(SECRET);}});
 for(const value of [true,false,undefined,{}, {...proof(),service:'sistema_central/listmonk'},{...proof(),runtimeBinding:'bad'}, {...proof(),actor:SECRET},accessor]){
  const h=harness({current:()=>value});
  await refusal(h.transport({}),'SCANNER_DIAGNOSTIC_AUTHORIZATION_REFUSED');
  assert.equal(h.calls.fetch.length,0);assert.equal(h.calls.credential.length,0);
 }
 assert.equal(accesses,0);
});
test('CURRENT revocation after response withholds every DTO and never retries',async()=>{
 const h=harness({current:q=>q.stage==='after'?false:proof()});
 await refusal(h.transport({}),'SCANNER_DIAGNOSTIC_AUTHORIZATION_REFUSED');
 assert.equal(h.calls.fetch.length,1);assert.deepEqual(h.calls.current.map(q=>q.stage),['before','before','after']);
});
test('every private binding dimension is compared before GET and after streaming',async()=>{
 for(const key of ['serviceBinding','runtimeBinding','identityBinding','credentialBinding','authorizationBinding']){
  for(const stage of ['before','after']){
   const h=harness({current:(q,n)=>stage==='before'&&n===2||stage==='after'&&q.stage==='after'?{...proof(),[key]:'a'.repeat(64)}:proof()});
   await refusal(h.transport({}),'SCANNER_DIAGNOSTIC_BINDING_CHANGED');
   assert.equal(h.calls.fetch.length,stage==='before'?0:1);
  }
 }
});
test('credential syntax and binding are strict; cookies/basic/bearer/injection/extra fields are rejected',async()=>{
 let accesses=0;
 const accessor=cred();Object.defineProperty(accessor,'authorization',{enumerable:true,get(){accesses++;throw Error(SECRET);}});
 const values=[true,AUTH,{}, {...cred(),authorization:'Bearer '+SECRET},{...cred(),authorization:'Basic '+SECRET},
  {...cred(),authorization:'token reader:'+SECRET+'\r\nCookie: fake'},
  {...cred(),authorization:'token :'+SECRET},{...cred(),authorization:'token reader:'},
  {...cred(),identityBinding:'a'.repeat(64)},{...cred(),credentialBinding:'a'.repeat(64)},
  {...cred(),authorization:'token reader:'+ 'a'.repeat(4097)},{...cred(),cookie:SECRET},accessor];
 for(const value of values){
  const h=harness({credential:()=>value});
  await refusal(h.transport({}),'SCANNER_DIAGNOSTIC_CREDENTIAL_REFUSED');
  assert.equal(h.calls.fetch.length,0);
 }
 assert.equal(accesses,0);
});
test('credential changes during response are refused even if hook hashes stayed equal',async()=>{
 const h=harness({credential:(_,n)=>n===2?{...cred(),authorization:'token synthetic-reader:rotated'}:cred()});
 await refusal(h.transport({}),'SCANNER_DIAGNOSTIC_BINDING_CHANGED');
 assert.equal(h.calls.fetch.length,1);assert.equal(h.calls.credential.length,2);
 assert.equal(h.calls.current.filter(q=>q.stage==='after').length,0);
});
test('private hook and fetch exceptions are reduced to finite secret-free refusals',async()=>{
 for(const which of ['current','credential','fetch']){
  const h=harness({[which]:()=>{throw Object.assign(Error(SECRET),{code:SECRET,cause:{token:SECRET}});}});
  await refusal(h.transport({}),which==='current'?'SCANNER_DIAGNOSTIC_AUTHORIZATION_REFUSED':which==='credential'?'SCANNER_DIAGNOSTIC_CREDENTIAL_REFUSED':'SCANNER_DIAGNOSTIC_TRANSPORT_REFUSED');
  assert.equal(h.calls.fetch.length,which==='fetch'?1:0);
 }
 const h=harness({current:q=>{if(q.stage==='after')throw Error(SECRET);return proof();}});
 await refusal(h.transport({}),'SCANNER_DIAGNOSTIC_AUTHORIZATION_REFUSED');assert.equal(h.calls.fetch.length,1);
});
test('exact status, response URL, no redirect and JSON content type are required without reading refusal bodies',async()=>{
 const options=[{status:201},{status:204},{status:301},{status:302},{status:401},{status:403},{status:404},{status:500},
  {url:URL+'?token='+SECRET},{url:URL.replace(':9000',':9001')},{url:''},{redirected:true},{redirected:null},
  {contentType:'text/json'},{contentType:'application/json; charset=latin1'},{contentType:'application/json; token='+SECRET},
  {headers:{get(){throw Error(SECRET);}}}];
 for(const option of options){
  const r=response(JSON.stringify({private:SECRET}),option),h=harness({response:r});
  await refusal(h.transport({}),'SCANNER_DIAGNOSTIC_TRANSPORT_REFUSED');
  assert.equal(h.calls.fetch.length,1);assert.equal(r.stats.reads,0);assert.equal(r.stats.bodyCancel,1);
 }
});
test('Content-Length must be decimal and bounded, and streaming independently enforces 16 KiB',async()=>{
 for(const length of ['', '-1','1.0','+1','01','NaN',' 10',SECRET]){
  const h=harness({response:response(undefined,{length})});
  await refusal(h.transport({}),'SCANNER_DIAGNOSTIC_TRANSPORT_REFUSED');assert.equal(h.calls.fetch.length,1);
 }
 const declared=harness({response:response(undefined,{length:String(MAX_BYTES+1)})});
 await refusal(declared.transport({}),'SCANNER_DIAGNOSTIC_RESPONSE_TOO_LARGE');assert.equal(declared.r.stats.reads,0);
 const text=JSON.stringify(dto()),full=text+' '.repeat(MAX_BYTES-Buffer.byteLength(text));
 const exact=harness({response:response(full,{length:String(MAX_BYTES)})});
 assert.deepEqual(await exact.transport({}),dto());
 const oversized=harness({response:response(undefined,{length:'1',chunks:[Buffer.from(text),Buffer.alloc(MAX_BYTES)]})});
 await refusal(oversized.transport({}),'SCANNER_DIAGNOSTIC_RESPONSE_TOO_LARGE');
 assert.equal(oversized.calls.fetch.length,1);assert.equal(oversized.r.stats.readerCancel,1);
});
test('stream values, stream errors and strict UTF-8 are refused without free payloads',async()=>{
 for(const options of [
  {body:null},{body:{}},{body:{getReader:()=>({})}},
  {read:()=>Promise.resolve({done:'false',value:Buffer.from('x')})},
  {read:()=>Promise.resolve({done:false,value:{byteLength:1,token:SECRET}})},
  {read:()=>Promise.resolve({done:false,value:new Uint8Array(0)})},
  {read:()=>Promise.reject(Error(SECRET))}
 ]){
  const h=harness({response:response(undefined,options)});
  await refusal(h.transport({}),'SCANNER_DIAGNOSTIC_TRANSPORT_REFUSED');assert.equal(h.calls.fetch.length,1);
 }
 for(const chunks of [[Uint8Array.from([255])],[Buffer.from([239,187,191]),Buffer.from('{"data":null}')]]){
  const h=harness({response:response(undefined,{chunks})});
  await refusal(h.transport({}),'SCANNER_DIAGNOSTIC_RESPONSE_REFUSED');
 }
});
test('JSON permits only data:null or exact three string fields and rejects duplicate escaped aliases',async()=>{
 const bodies=['null','[]','{}','true','{"data":null,"extra":"'+SECRET+'"}',
  '{"data":null,"data":null}','{"data":{"phase":"BeginTxx","sqlstate":"42501","timestamp":"2026-10-08T14:00:00Z","secret":"'+SECRET+'"}}',
  '{"data":{"phase":"BeginTxx","phase":"SelectContext","sqlstate":"42501","timestamp":"2026-10-08T14:00:00Z"}}',
  '{"data":{"phase":"BeginTxx","\\u0070hase":"SelectContext","timestamp":"2026-10-08T14:00:00Z"}}',
  '{"data":{"phase":"BeginTxx","sqlstate":42501,"timestamp":"2026-10-08T14:00:00Z"}}',
  '{"data":{"phase":null,"sqlstate":"42501","timestamp":"2026-10-08T14:00:00Z"}}',
  '{"data":{"phase":"BeginTxx","sqlstate":"42501"}}',
  '{"data":{"__proto__":"'+SECRET+'","sqlstate":"42501","timestamp":"2026-10-08T14:00:00Z"}}',
  '{"data":null} trailing','{"data":"'+SECRET+'"}','{"data":null', '{"data":{"phase":"BeginTxx","sqlstate":"42501","timestamp":"bad\nvalue"}}'];
 for(const body of bodies){
  const h=harness({response:response(body)});
  await refusal(h.transport({}),'SCANNER_DIAGNOSTIC_RESPONSE_REFUSED');
  assert.equal(h.calls.fetch.length,1);assert.equal(h.calls.current.filter(q=>q.stage==='after').length,0);
 }
});
test('both original phases and all 31 pinned SQLSTATE codes plus unknown are accepted exactly',async()=>{
 const pinned=['08000','08001','08003','08004','08006','08007','08P01','0A000','25006','25P02','40001','40P01','42501','42601','42703','42804','42883','42P01','53100','53200','53300','55P03','57014','57P01','57P02','57P03','58000','58030','XX000','XX001','XX002','unknown'];
 assert.deepEqual(core.SQLSTATES,pinned);assert.deepEqual(core.PHASES,['BeginTxx','SelectContext']);
 for(const phase of core.PHASES)for(const sqlstate of pinned){
  const value={data:{phase,sqlstate,timestamp:'2026-10-08T14:00:00Z'}};
  assert.deepEqual(await harness({response:response(JSON.stringify(value))}).transport({}),value);
 }
 for(const change of [{phase:'begin'},{phase:'select'},{phase:'BeginTxx '+SECRET},{sqlstate:'ZZZZZ'},{sqlstate:'42p01'},{sqlstate:'55000'},{sqlstate:'42501;'+SECRET}]){
  const value=dto();Object.assign(value.data,change);
  await refusal(harness({response:response(JSON.stringify(value))}).transport({}),'SCANNER_DIAGNOSTIC_RESPONSE_REFUSED');
 }
});
test('UTC RFC3339Nano validates the actual calendar and does not reinterpret stale snapshots as health',async()=>{
 for(const value of ['2024-02-29T23:59:59Z','2026-10-08T14:00:00.1Z','2026-10-08T14:00:00.123456789Z','2000-01-01T00:00:00Z']){
  const body=dto();body.data.timestamp=value;
  assert.deepEqual(await harness({response:response(JSON.stringify(body))}).transport({}),body);
 }
 for(const value of ['2026-02-29T00:00:00Z','2026-04-31T00:00:00Z','2026-00-01T00:00:00Z','2026-13-01T00:00:00Z',
  '2026-10-00T00:00:00Z','2026-10-08T24:00:00Z','2026-10-08T14:60:00Z','2026-10-08T14:00:60Z',
  '2026-10-08T14:00:00.1234567890Z','2026-10-08T14:00:00+00:00','2026-10-08T14:00:00z','2026-10-08',SECRET]){
  const body=dto();body.data.timestamp=value;
  await refusal(harness({response:response(JSON.stringify(body))}).transport({}),'SCANNER_DIAGNOSTIC_RESPONSE_REFUSED');
 }
});
test('chunked JSON and escaped field names are parsed without object key injection',async()=>{
 const text='{ "data": { "timestamp":"2026-10-08T14:00:00Z", "sqlstate":"42501", "\\u0070hase":"BeginTxx" } }\n';
 const bytes=Buffer.from(text),chunks=Array.from(bytes,value=>Uint8Array.of(value));
 assert.deepEqual(await harness({response:response(undefined,{chunks})}).transport({}),{data:{phase:'BeginTxx',sqlstate:'42501',timestamp:'2026-10-08T14:00:00Z'}});
});
test('success does not wait for a cancel promise; cleanup precedes the final CURRENT check',async()=>{
 let revoked=false;
 const r=response(undefined,{cancel:()=>{revoked=true;return new Promise(()=>{});}});
 const h=harness({response:r,current:q=>q.stage==='after'&&revoked?false:proof()});
 await refusal(h.transport({}),'SCANNER_DIAGNOSTIC_AUTHORIZATION_REFUSED');
 assert.equal(r.stats.readerCancel,1);assert.equal(h.calls.fetch.length,1);
 const happy=harness({response:response(undefined,{cancel:()=>new Promise(()=>{})})});
 assert.deepEqual(await happy.transport({}),dto());assert.equal(happy.r.stats.readerCancel,1);
});
test('timeout covers an ignored-signal fetch; late response is canceled and no hooks or retries follow',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let finish;const waiting=new Promise(resolve=>{finish=resolve;});
 const h=harness({fetch:()=>waiting}),pending=h.transport({});
 await flush();assert.equal(h.calls.fetch.length,1);
 t.mock.timers.tick(TIMEOUT_MS);
 await refusal(pending,'SCANNER_DIAGNOSTIC_TIMEOUT');
 assert.equal(h.calls.fetch[0].init.signal.aborted,true);
 const late=response();finish(late.result);await flush();
 assert.equal(late.stats.bodyCancel,1);assert.equal(late.stats.reads,0);
 assert.equal(h.calls.fetch.length,1);assert.equal(h.calls.current.length,2);assert.equal(h.calls.credential.length,1);
});
test('timeout covers a stalled stream even if cancel ignores signal and never settles',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let finish;const r=response(undefined,{read:()=>new Promise(resolve=>{finish=resolve;}),cancel:()=>new Promise(()=>{})});
 const h=harness({response:r}),pending=h.transport({});
 await flush();assert.equal(r.stats.reads,1);
 t.mock.timers.tick(TIMEOUT_MS);
 await refusal(pending,'SCANNER_DIAGNOSTIC_TIMEOUT');assert.equal(r.stats.readerCancel,1);
 finish({done:false,value:Buffer.from(JSON.stringify(dto()))});await flush();
 assert.equal(h.calls.current.length,2);assert.equal(h.calls.credential.length,1);assert.equal(h.calls.fetch.length,1);
});
test('timeout covers CURRENT and credential hooks; their late results cannot start a GET',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const which of ['current','credential']){
  let finish;const pendingHook=new Promise(resolve=>{finish=resolve;});
  const h=harness({[which]:()=>pendingHook}),pending=h.transport({});
  await flush();t.mock.timers.tick(TIMEOUT_MS);
  await refusal(pending,'SCANNER_DIAGNOSTIC_TIMEOUT');
  finish(which==='current'?proof():cred());await flush();assert.equal(h.calls.fetch.length,0);
 }
});
test('timeout covers final CURRENT validation and refuses late output after a fully parsed response',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let finish;
 const h=harness({current:q=>q.stage==='after'?new Promise(resolve=>{finish=resolve;}):proof()}),pending=h.transport({});
 await flush();assert.equal(h.calls.fetch.length,1);assert.equal(h.calls.credential.length,2);
 t.mock.timers.tick(TIMEOUT_MS);await refusal(pending,'SCANNER_DIAGNOSTIC_TIMEOUT');
 finish(proof());await flush();assert.equal(h.calls.fetch.length,1);
});
test('independent concurrent reads retain no secret, snapshot cache or cross-request binding',async()=>{
 const responses=[response('{"data":null}'),response(JSON.stringify(dto()))];let n=0;
 const h=harness({fetch:()=>responses[n++].result});
 const results=await Promise.all([h.transport({}),h.transport({})]);
 assert.deepEqual(results,[{data:null},dto()]);assert.equal(h.calls.fetch.length,2);
 assert.equal(h.calls.current.length,6);assert.equal(h.calls.credential.length,4);
 assert.ok(!JSON.stringify(results).includes(SECRET));
});
test('monotonic deadline refuses late fetch/credential/CURRENT values before timers get an event-loop turn',async t=>{
 const {performance}=require('node:perf_hooks');let clock=0;
 t.mock.method(performance,'now',()=>clock);
 for(const stage of ['fetch','credential-after','current-after']){
  clock=0;const late=response();
  const h=harness({
   response:late,
   fetch:()=>{if(stage==='fetch')clock=TIMEOUT_MS+1;return late.result;},
   credential:(_,n)=>{if(stage==='credential-after'&&n===2)clock=TIMEOUT_MS+1;return cred();},
   current:q=>{if(stage==='current-after'&&q.stage==='after')clock=TIMEOUT_MS+1;return proof();}
  });
  await refusal(h.transport({}),'SCANNER_DIAGNOSTIC_TIMEOUT');
  assert.equal(h.calls.fetch.length,1);
  if(stage==='fetch'){assert.equal(late.stats.bodyCancel,1);assert.equal(late.stats.reads,0);}
 }
});
test('stream getter/cancellation exceptions cannot surface hook credentials in DTO or refusals',async()=>{
 const r=response(undefined,{cancel:()=>{throw Error(SECRET);}});
 assert.deepEqual(await harness({response:r}).transport({}),dto());
 const malformed=response();
 Object.defineProperty(malformed.result,'url',{get(){throw Error(SECRET);}});
 await refusal(harness({response:malformed}).transport({}),'SCANNER_DIAGNOSTIC_TRANSPORT_REFUSED');
 assert.equal(malformed.stats.reads,0);
});
test('read has no automatic fetch retry or logs/SQL/scan fallback on network failure',async()=>{
 let attempts=0;
 const h=harness({fetch:()=>{attempts++;throw Error(SECRET);}});
 await refusal(h.transport({}),'SCANNER_DIAGNOSTIC_TRANSPORT_REFUSED');
 assert.equal(attempts,1);assert.equal(h.calls.fetch.length,1);
 assert.equal(MAX_BYTES,16384);assert.equal(TIMEOUT_MS,12000);
});
