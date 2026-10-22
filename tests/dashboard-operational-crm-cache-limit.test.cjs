'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),os=require('node:os');
const {createServer}=require('../services/dashboard-operational/server.cjs');
const {FIXED_DESTINATIONS,MAX_CRM_CACHE_RESPONSE}=require('../services/dashboard-operational/proxy.cjs');
const HOSTS={manager:'gerencial.shrigma.com.br',growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'};
const PATH='/api/crm-read?action=cache_growth&painel=growth';
const BACKEND=FIXED_DESTINATIONS['crm-read'];
const RESPONSE=()=>new Response('{"_escopo":"growth","crm_campanha":[],"crm_fluxo":[],"crm_conversao":[]}',
  {status:200,headers:{'Content-Type':'application/json'}});
function setup(fetchImpl,{master=false}={}){
 const user={id:master?'synthetic-master':'synthetic-manager-fish',role:master?'superadmin':'manager',areas:master?['growth','organico','influs']:['growth'],brand:master?null:'fish',brands:master?['fish','aristo']:['fish'],brandAccess:master?'all':'single'};
 const auth={
  authorize(ctx){assert.equal(ctx.area,'growth');assert.equal(ctx.edit,false);return user;},
  authorizeBrand(ctx,brand){const found=this.authorize(ctx);assert.equal(brand,'fish');assert.equal(ctx.area,'growth');if(ctx.brand!==undefined)assert.equal(ctx.brand,'fish');return found;},
  getUpstreamCredential(ctx){assert.equal(ctx.area,'growth');assert.equal(ctx.slot,'crm-panel-read');if(!master){assert.equal(ctx.brand,'fish');this.authorizeBrand(ctx,ctx.brand);}else assert.equal(ctx.brand,undefined);return 'synthetic-individual-reader-key';}
 };
 return createServer({mode:'operational',managerHost:HOSTS.manager,
  areaHosts:{growth:HOSTS.growth,organico:HOSTS.organico,influs:HOSTS.influs},
  upstreams:{'crm-read':new URL(BACKEND)},allowedUpstreamHosts:[new URL(BACKEND).hostname],publicDir:os.tmpdir()},
  {auth,fetchImpl});
}
function request(port,{master=false}={}){return new Promise((resolve,reject)=>{
 const req=http.request({hostname:'127.0.0.1',port,path:PATH,method:'GET',
  headers:{Host:master?HOSTS.manager:HOSTS.growth,Origin:'https://'+(master?HOSTS.manager:HOSTS.growth),Cookie:'synthetic-session'}},res=>{
  const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,
   headers:res.headers,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));});
 req.on('error',reject);req.end();});}
function requestBytes(port,{master=false}={}){return new Promise((resolve,reject)=>{
 const req=http.request({hostname:'127.0.0.1',port,path:PATH,method:'GET',
  headers:{Host:master?HOSTS.manager:HOSTS.growth,Origin:'https://'+(master?HOSTS.manager:HOSTS.growth),Cookie:'synthetic-session'}},res=>{
  let bytes=0,prefix='';res.on('data',chunk=>{bytes+=chunk.length;if(prefix.length<128)prefix+=chunk.subarray(0,128-prefix.length).toString('utf8');});
  res.on('end',()=>resolve({status:res.statusCode,bytes,prefix}));});
 req.on('error',reject);req.end();});}
async function listen(server,t,settle=()=>{}){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 // Release held test work before closing, including when an assertion fails.
 t.after(async()=>{await settle();await new Promise(resolve=>server.close(resolve));});return server.address().port;}
async function waitStarted(started,reply){await Promise.race([started,reply.then(value=>{assert.fail('request completed before the expected upstream work: '+value.status);})]);}
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

test('master synthetic aggregate Growth cache just below eight MiB completes unchanged through the HTTP gateway',async t=>{
 const cache={_escopo:'growth',crm_campanha:[],crm_fluxo:[],crm_conversao:[],padding:'x'.repeat(MAX_CRM_CACHE_RESPONSE-1024)};
 const json=JSON.stringify(cache);
 assert(Buffer.byteLength(json)>7.5*1024*1024);
 assert(Buffer.byteLength(json)<MAX_CRM_CACHE_RESPONSE);
 const server=setup(async()=>new Response(json,{status:200,headers:{'Content-Type':'application/json'}}),{master:true});
 const port=await listen(server,t);
 const reply=await request(port,{master:true});
 assert.equal(reply.status,200);assert.equal(reply.body.padding.length,cache.padding.length);
});

test('master legacy nested aggregate Growth rows around measured cache size survive parse and serialization unchanged',async t=>{
 let body=syntheticGrowthRows();const bytes=Buffer.byteLength(body);
 assert(Math.abs(bytes-5_624_379)<1024);
 const server=setup(async()=>{const raw=body;body=null;return new Response(raw,{status:200,headers:{'Content-Type':'application/json'}});},{master:true});
 const port=await listen(server,t);
 const reply=await requestBytes(port,{master:true});
 assert.equal(reply.status,200);assert(reply.bytes>=bytes);
 assert(reply.prefix.startsWith('{"_escopo":"growth","_painel":"growth","crm_campanha":['));
});

test('one Growth cache read occupies the instance until its response finishes; busy does not fetch',async t=>{
 let releaseFetch,started,calls=0;
 const began=new Promise(resolve=>{started=resolve;});
 const server=setup(async()=>{calls++;if(calls===1){started();return await new Promise(resolve=>{releaseFetch=resolve;});}return RESPONSE();});
 const port=await listen(server,t,()=>releaseFetch?.(RESPONSE()));
 const first=request(port);await waitStarted(began,first);
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
  res.end=(...args)=>{releaseResponse=()=>{releaseResponse=undefined;end(...args);};serialized();};
 });
 const port=await listen(server,t,()=>releaseResponse?.());
 const first=request(port);await waitStarted(blocked,first);
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
 const port=await listen(server,t,()=>releaseCancel?.());
 const first=request(port);await waitStarted(cancelling,first);
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
 const port=await listen(server,t,()=>releaseFetch?.(RESPONSE()));
 let earlyResponse;const finished=new Promise(resolve=>{earlyResponse=resolve;});
 const first=http.request({hostname:'127.0.0.1',port,path:PATH,method:'GET',
  headers:{Host:HOSTS.growth,Origin:'https://'+HOSTS.growth,Cookie:'synthetic-session'}});
 first.on('response',res=>{res.resume();res.on('end',()=>earlyResponse({status:res.statusCode}));});
 first.on('error',()=>{});t.after(()=>first.destroy());first.end();await waitStarted(began,finished);first.destroy();
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

function syntheticBrandedGrowthRows(){
 const groups=[[],[],[]],expected={campaigns:0,flows:0,conversions:0,enviados:0,flowRevenue:0,conversionRevenue:0};let estimated=0;
 for(let i=0;estimated<5_624_379;i++){
  const marca=i%2?'fish':'aristo',group=i%3,stamp='2026-10-02T12:00:00.000Z';
  const common={marca,canal:'email',coletado_em:stamp,
   other_brand_secret:'PRIVATE-ARISTO',aristo_revenue:999999,
   nested:{brand:'aristo',private:'PRIVATE-ARISTO',unadmitted:'x'.repeat(160)}};
  const row=group===0?{...common,campanha_id:i+1,nome:'Synthetic campaign '+i,status:'finished',tipo:'enviada',
   enviado_em:stamp,publico:100,enviados:i%117,entregues:i%100,abriram:i%30,clicaram:i%10,hard:0,complaints:0}
   :group===1?{...common,dia:'2026-10-02',flow:'pedido',piece:'pago',enviados:i%117,
    pedidos_ultimo:i%9,receita_ultimo:(i%991)*1.13,pedidos_assistido:i%3,receita_assistida:(i%79)*1.1}
   :{...common,dia:'2026-10-02',utm_source:'listmonk',utm_medium:'campanha',utm_campaign:'fixture_'+i,
    utm_content:'peca',utm_term:'',pedidos_ultimo:i%9,receita_ultimo:(i%991)*1.13,
    pedidos_assistido:i%3,receita_assistida:(i%79)*1.1,clientes_novos:i%3,clientes_recorrentes:i%4};
  if(marca==='fish'){
   if(group===0){expected.campaigns++;expected.enviados+=row.enviados;}
   else if(group===1){expected.flows++;expected.flowRevenue+=row.receita_ultimo;}
   else{expected.conversions++;expected.conversionRevenue+=row.receita_ultimo;}
  }
  const json=JSON.stringify(row);groups[group].push(json);estimated+=Buffer.byteLength(json)+1;
 }
 return{body:'{"_escopo":"growth","_painel":"growth","crm_campanha":['+groups[0].join(',')+'],"crm_fluxo":['+groups[1].join(',')+'],"crm_conversao":['+groups[2].join(',')+']}',expected};
}

test('single-brand manager projects a complete CRM cache above five point six MiB, preserving own metrics and dropping foreign/private data',async t=>{
 let {body,expected}=syntheticBrandedGrowthRows();const bytes=Buffer.byteLength(body);
 assert(Math.abs(bytes-5_624_379)<1024);assert(bytes<MAX_CRM_CACHE_RESPONSE);assert(bytes>5_600_000);
 const server=setup(async()=>{const raw=body;body=null;return new Response(raw,{status:200,headers:{'Content-Type':'application/json'}});});
 const port=await listen(server,t),reply=await request(port);
 assert.equal(reply.status,200);assert.equal(reply.body.brand,'fish');assert.deepEqual(reply.body.brands,['fish']);assert.equal(reply.body.brandAccess,'single');
 assert.equal(reply.body.crm_campanha.length,expected.campaigns);assert.equal(reply.body.crm_fluxo.length,expected.flows);assert.equal(reply.body.crm_conversao.length,expected.conversions);
 assert.equal(reply.body.crm_campanha.reduce((sum,row)=>sum+row.enviados,0),expected.enviados);
 assert.equal(reply.body.crm_fluxo.reduce((sum,row)=>sum+row.receita_ultimo,0),expected.flowRevenue);
 assert.equal(reply.body.crm_conversao.reduce((sum,row)=>sum+row.receita_ultimo,0),expected.conversionRevenue);
 for(const rows of [reply.body.crm_campanha,reply.body.crm_fluxo,reply.body.crm_conversao])for(const row of rows){
  assert.equal(row.marca,'fish');assert.equal(row.canal,'email');assert.equal(Object.hasOwn(row,'nested'),false);assert.equal(Object.hasOwn(row,'other_brand_secret'),false);assert.equal(Object.hasOwn(row,'aristo_revenue'),false);
 }
 const projected=JSON.stringify(reply.body),projectedBytes=Buffer.byteLength(projected);assert(projectedBytes<bytes/2);
 t.diagnostic(JSON.stringify({inputBytes:bytes,projectedBytes,fishCampaigns:expected.campaigns,fishFlows:expected.flows,fishConversions:expected.conversions}));
 assert.equal(projected.includes('PRIVATE-ARISTO'),false);assert.equal(projected.includes('aristo'),false);
});
