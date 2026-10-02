'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),os=require('node:os');
const {createServer}=require('../services/dashboard-operational/server.cjs');
const {FIXED_DESTINATIONS,MAX_CRM_CACHE_RESPONSE}=require('../services/dashboard-operational/proxy.cjs');
const HOSTS={manager:'gerencial.shrigma.com.br',growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'};
const PATH='/api/crm-read?action=cache_growth&painel=growth';
const BACKEND=FIXED_DESTINATIONS['crm-read'];
const RESPONSE=()=>new Response('{"_escopo":"growth","crm_campanha":[],"crm_fluxo":[],"crm_conversao":[]}',
  {status:200,headers:{'Content-Type':'application/json'}});
function setup(fetchImpl){
 const auth={authorize:()=>({id:'synthetic-manager',role:'manager',areas:['growth']}),
  getUpstreamCredential:()=> 'synthetic-individual-reader-key'};
 return createServer({mode:'operational',managerHost:HOSTS.manager,
  areaHosts:{growth:HOSTS.growth,organico:HOSTS.organico,influs:HOSTS.influs},
  upstreams:{'crm-read':new URL(BACKEND)},allowedUpstreamHosts:[new URL(BACKEND).hostname],publicDir:os.tmpdir()},
  {auth,fetchImpl});
}
function request(port){return new Promise((resolve,reject)=>{
 const req=http.request({hostname:'127.0.0.1',port,path:PATH,method:'GET',
  headers:{Host:HOSTS.growth,Origin:'https://'+HOSTS.growth,Cookie:'synthetic-session'}},res=>{
  const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,
   headers:res.headers,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));});
 req.on('error',reject);req.end();});}
function requestBytes(port){return new Promise((resolve,reject)=>{
 const req=http.request({hostname:'127.0.0.1',port,path:PATH,method:'GET',
  headers:{Host:HOSTS.growth,Origin:'https://'+HOSTS.growth,Cookie:'synthetic-session'}},res=>{
  let bytes=0,prefix='';res.on('data',chunk=>{bytes+=chunk.length;if(prefix.length<128)prefix+=chunk.subarray(0,128-prefix.length).toString('utf8');});
  res.on('end',()=>resolve({status:res.statusCode,bytes,prefix}));});
 req.on('error',reject);req.end();});}
async function listen(server,t){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));return server.address().port;}
function syntheticGrowthRows(){
 const groups=[[],[],[]];let estimated=0;
 for(let i=0;estimated<5_624_379;i++){
  const row=JSON.stringify({id:i+1,marca:i%2?'fish':'aristo',canal:'email',status:'synthetic',
   periodo:{inicio:'2026-10-01',fim:'2026-10-02'},
   indicadores:{pedidos:i%117,receita_brl:(i%991)*1.13,cliques:i%1301},
   origem:{tipo:'synthetic',campanha:'fixture_'+(i%97)},
   etapas:[{nome:'visita',total:i%2001},{nome:'cadastro',total:i%401}]});
  groups[i%3].push(row);estimated+=Buffer.byteLength(row)+1;
 }
 return '{"_escopo":"growth","_painel":"growth","crm_campanha":['+groups[0].join(',')+'],"crm_fluxo":['+groups[1].join(',')+'],"crm_conversao":['+groups[2].join(',')+']}';
}

test('a synthetic Growth cache just below eight MiB completes through the HTTP gateway',async t=>{
 const cache={_escopo:'growth',crm_campanha:[],crm_fluxo:[],crm_conversao:[],padding:'x'.repeat(MAX_CRM_CACHE_RESPONSE-1024)};
 const json=JSON.stringify(cache);
 assert(Buffer.byteLength(json)>7.5*1024*1024);
 assert(Buffer.byteLength(json)<MAX_CRM_CACHE_RESPONSE);
 const server=setup(async()=>new Response(json,{status:200,headers:{'Content-Type':'application/json'}}));
 const port=await listen(server,t);
 const reply=await request(port);
 assert.equal(reply.status,200);assert.equal(reply.body.padding.length,cache.padding.length);
});

test('representative nested Growth rows around the measured cache size survive parse and response serialization',async t=>{
 let body=syntheticGrowthRows();const bytes=Buffer.byteLength(body);
 assert(Math.abs(bytes-5_624_379)<1024);
 const server=setup(async()=>{const raw=body;body=null;return new Response(raw,{status:200,headers:{'Content-Type':'application/json'}});});
 const port=await listen(server,t);
 const reply=await requestBytes(port);
 assert.equal(reply.status,200);assert(reply.bytes>=bytes);
 assert(reply.prefix.startsWith('{"_escopo":"growth","_painel":"growth","crm_campanha":['));
});

test('one Growth cache read occupies the instance until its response finishes; busy does not fetch',async t=>{
 let releaseFetch,started,calls=0;
 const began=new Promise(resolve=>{started=resolve;});
 const server=setup(async()=>{calls++;if(calls===1){started();return await new Promise(resolve=>{releaseFetch=resolve;});}return RESPONSE();});
 const port=await listen(server,t);
 const first=request(port);await began;
 const busy=await request(port);
 assert.equal(busy.status,503);assert.equal(busy.body.error,'CRM_CACHE_BUSY');assert.equal(busy.headers['retry-after'],'2');assert.equal(calls,1);
 releaseFetch(RESPONSE());assert.equal((await first).status,200);
 assert.equal((await request(port)).status,200);assert.equal(calls,2);
});

test('a serialized cache stays reserved until the response can finish',async t=>{
 let releaseResponse,serialized,calls=0,firstOnly=true;
 const blocked=new Promise(resolve=>{serialized=resolve;});
 const server=setup(async()=>{calls++;return RESPONSE();});
 server.prependListener('request',(req,res)=>{
  if(req.url!==PATH||!firstOnly)return;
  firstOnly=false;
  const end=res.end.bind(res);
  res.end=(...args)=>{releaseResponse=()=>end(...args);serialized();};
 });
 const port=await listen(server,t);
 const first=request(port);await blocked;
 const busy=await request(port);
 assert.equal(busy.status,503);assert.equal(busy.body.error,'CRM_CACHE_BUSY');assert.equal(calls,1);
 releaseResponse();assert.equal((await first).status,200);
 assert.equal((await request(port)).status,200);assert.equal(calls,2);
});

test('a failed upstream releases the cache slot after its sanitized error response',async t=>{
 let calls=0;
 const server=setup(async()=>{calls++;if(calls===1)throw Error('synthetic upstream failure');return RESPONSE();});
 const port=await listen(server,t);
 const failed=await request(port);assert.equal(failed.status,502);assert.equal(failed.body.error,'UPSTREAM_UNAVAILABLE');
 assert.equal((await request(port)).status,200);assert.equal(calls,2);
});

test('an oversized stream holds the cache slot until its cancellation completes',async t=>{
 let releaseCancel,enteredCancel,calls=0,locked=true,reads=0;
 const cancelling=new Promise(resolve=>{enteredCancel=resolve;});
 const oversized={status:200,headers:new Headers({'Content-Type':'application/json'}),body:{getReader:()=>({
  read:async()=>({done:false,value:new Uint8Array(++reads===1?MAX_CRM_CACHE_RESPONSE:1)}),
  cancel:()=>{enteredCancel();return new Promise(resolve=>{releaseCancel=resolve;});},
  releaseLock:()=>{locked=false;}
 })}};
 const server=setup(async()=>{calls++;return calls===1?oversized:RESPONSE();});
 const port=await listen(server,t);
 const first=request(port);await cancelling;
 assert.equal(locked,true);
 const busy=await request(port);assert.equal(busy.status,503);assert.equal(calls,1);
 releaseCancel();
 const oversizedError=await first;assert.equal(oversizedError.status,502);
 assert.equal(oversizedError.body.error,'UPSTREAM_RESPONSE_TOO_LARGE');assert.equal(locked,false);
 assert.equal((await request(port)).status,200);assert.equal(calls,2);
});

test('client close does not release the slot before the upstream work settles',async t=>{
 let releaseFetch,started,calls=0;
 const began=new Promise(resolve=>{started=resolve;});
 const server=setup(async()=>{calls++;if(calls===1){started();return await new Promise(resolve=>{releaseFetch=resolve;});}return RESPONSE();});
 const port=await listen(server,t);
 const first=http.request({hostname:'127.0.0.1',port,path:PATH,method:'GET',
  headers:{Host:HOSTS.growth,Origin:'https://'+HOSTS.growth,Cookie:'synthetic-session'}});
 first.on('error',()=>{});first.end();await began;first.destroy();
 const busy=await request(port);assert.equal(busy.status,503);assert.equal(calls,1);
 releaseFetch(RESPONSE());
 let recovered;
 for(let attempt=0;attempt<100;attempt++){
  recovered=await request(port);
  if(recovered.status===200)break;
  assert.equal(recovered.status,503);
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(recovered.status,200);assert.equal(calls,2);
});
