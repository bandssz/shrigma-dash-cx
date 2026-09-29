'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {gunzipSync}=require('node:zlib');
const {createServer,parse,ORIGIN,PATH}=require('../services/crm-campaign/server.cjs');
const {createExecutor,nativeTransport,AUTH_SQL,EFFECT_SQL,safeError}=require('../services/crm-campaign/transport.cjs');
const {config}=require('../services/crm-campaign/main.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function fixture(t,options={}){const app=createServer({revision:'a'.repeat(40),enabled:true,executor:async()=>({status:200,body:{ok:true}}),...options});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.stop());return app;}
async function request(app,{path=PATH+'?acao=campanha_catalogo&brand=fish',method='GET',headers={Authorization:'Bearer synthetic-key'},body}={}){
 return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:app.server.address().port,path,method,headers},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{try{let raw=Buffer.concat(chunks);if(res.headers['content-encoding']==='gzip')raw=gunzipSync(raw);resolve({status:res.statusCode,headers:res.headers,body:raw.length?JSON.parse(raw):null});}catch(e){reject(e);}});});req.on('error',reject);req.end(body);});
}
test('HTTP preserves GET header precedence, POST body key, current CORS and does not expose credentials',async t=>{
 const calls=[],app=await fixture(t,{executor:async x=>{calls.push(x);return {status:200,body:{campaigns:[]}};}});
 assert.equal((await request(app,{path:PATH+'?acao=campanha_listar&brand=fish&k=legacy-key',headers:{Authorization:'Bearer header-key',Origin:ORIGIN}})).status,200);
 assert.equal(calls[0].key,'header-key');assert.ok(!Object.hasOwn(calls[0].command,'k'));
 assert.equal((await request(app,{path:PATH+'?acao=campanha_listar&brand=aristo&k=legacy-key',headers:{}})).status,200);assert.equal(calls[1].key,'legacy-key');
 assert.equal((await request(app,{path:PATH,method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer ignored-for-legacy-post'},body:JSON.stringify({k:'body-key',acao:'campanha_salvar',brand:'fish'})})).status,200);assert.equal(calls[2].key,'body-key');
 const wrong=await request(app,{headers:{Origin:'https://evil.example',Authorization:'Bearer synthetic-key'}});assert.equal(wrong.status,403);assert.equal(calls.length,3);
 assert.equal((await request(app,{path:PATH+'?acao=campanha_catalogo&brand=fish&k=legacy-key',headers:{Authorization:'Basic invalid'}})).status,401);
 const preflight=await request(app,{method:'OPTIONS',headers:{Origin:ORIGIN}});assert.equal(preflight.status,204);assert.match(preflight.headers['access-control-allow-headers'],/Authorization/);
});
test('HTTP rejects method confusion, untrusted fields, duplicate parameters and body limits before execution',async t=>{
 let calls=0;const app=await fixture(t,{maxBodyBytes:100,executor:async()=>{calls++;return {status:200,body:{ok:true}};}});
 for(const [path,status] of [[PATH+'?acao=campanha_agendar&brand=fish',405],[PATH+'?acao=campanha_obter&brand=fish&id=1&id=2',422],[PATH+'?acao=campanha_obter&brand=fish&id=NaN',422],[PATH+'?acao=campanha_catalogo&brand=fish&actor=admin',422],['/other',404]])assert.equal((await request(app,{path})).status,status);
 assert.equal((await request(app,{path:PATH,method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})).status,415);
 assert.equal((await request(app,{path:PATH,method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(101)})).status,413);
 assert.equal(calls,0);
 assert.throws(()=>parse({method:'GET',headers:{authorization:'Bearer a'},rawHeaders:['Authorization','Bearer a','Authorization','Bearer b']},new URL('https://x'+PATH+'?acao=campanha_catalogo&brand=fish')),e=>e.status===401);
});
test('deadline retains admission until actual work settles, health stays available, then capacity recovers',async t=>{
 const gate=deferred();let interrupted;const app=await fixture(t,{maxPending:1,readDeadlineMs:25,executor:async x=>{interrupted=x.interrupted;await gate.promise;return {status:200,body:{ok:true}};}});
 const first=await request(app);assert.equal(first.status,503);assert.equal(interrupted(),true);assert.equal(app.pending(),1);
 assert.equal((await request(app)).status,503);assert.equal((await request(app,{path:'/healthz'})).status,200);
 gate.resolve();for(let i=0;i<30&&app.pending();i++)await sleep(5);assert.equal(app.pending(),0);
 assert.equal((await request(app)).status,200);
});
test('client disconnect signals cancellation and retains capacity until executor settles',async t=>{
 const gate=deferred(),started=deferred();let interrupted;
 const app=await fixture(t,{executor:async x=>{interrupted=x.interrupted;started.resolve();await gate.promise;return {status:200,body:{ok:true}};}});
 const req=http.get({host:'127.0.0.1',port:app.server.address().port,path:PATH+'?acao=campanha_catalogo&brand=fish',headers:{Authorization:'Bearer synthetic-key'}});req.on('error',()=>{});
 await started.promise;req.destroy();for(let i=0;i<30&&!interrupted();i++)await sleep(5);assert.equal(interrupted(),true);assert.equal(app.pending(),1);gate.resolve();
});
test('bounded gzip response, disabled startup, exact path and health revision',async t=>{
 const app=await fixture(t,{executor:async()=>({status:200,body:{items:'x'.repeat(10000)}})});
 const r=await request(app,{headers:{Authorization:'Bearer synthetic-key','Accept-Encoding':'gzip'}});assert.equal(r.headers['content-encoding'],'gzip');assert.equal(r.body.items.length,10000);assert.equal(r.headers['cache-control'],'no-store, private');
 assert.equal((await request(app,{path:PATH+'/unexpected'})).status,404);
 const disabled=await fixture(t,{enabled:false});assert.equal((await request(disabled)).status,503);assert.equal((await request(disabled,{path:'/healthz'})).body.enabled,false);
});
test('actual runtime reads use only authenticated wrappers with server actor and no key in envelope',async()=>{
 const calls=[],executor=createExecutor({pool:{async query(sql,params){calls.push({sql,params});return sql===AUTH_SQL?{rows:[{auth:{actor:'operator-fixture',caps:['read_content']}}]}:{rows:[{result:{brand:'fish',lists:[],templates:[]}}]};}},native:()=>assert.fail('no native calls')});
 const r=await executor({key:'private-key',command:{acao:'campanha_catalogo',brand:'fish'}});assert.equal(r.status,200);assert.equal(calls.length,2);assert.equal(calls[1].sql,EFFECT_SQL);
 const envelope=JSON.parse(calls[1].params[1]);assert.equal(envelope.actor,'operator-fixture');assert.equal(envelope.operation,null);assert.ok(!calls[1].params[1].includes('private-key'));
});
test('actual runtime refuses invalid identity and capability before any effect',async()=>{
 for(const auth of [null,{actor:'x',caps:['draft']}]){let calls=0;const executor=createExecutor({pool:{async query(){calls++;return {rows:[{auth}]};}},native:()=>assert.fail()});const r=await executor({key:'x',command:{acao:'campanha_catalogo',brand:'fish'}});assert.equal(r.status,auth?403:401);assert.equal(calls,1);}
});
function scriptedRuntime(effects,receipts){let i=0;const step=()=>i<effects.length?{kind:'effect',effect:{id:'effect-'+i,...effects[i]},context:{index:i}}:{kind:'response',response:{status:200,body:{ok:true}}};return {start:async()=>step(),resume:async(_context,receipt)=>{receipts.push(receipt);i++;return step();}};}
test('native effect needs confirmed guard, uses server claim lease and never repeats lost creation',async()=>{
 let creations=0;const receipts=[],envelopes=[],effects=[{kind:'store',action:'claim',payload:{}},{kind:'nativeCreate',payload:{type:'regular',send_at:null}},{kind:'store',action:'finish',payload:{}}];
 const executor=createExecutor({pool:{async query(sql,params){if(sql===AUTH_SQL)return {rows:[{auth:{actor:'x',caps:['draft']}}]};envelopes.push(JSON.parse(params[1]));const e=JSON.parse(params[2]);return {rows:[{result:e.action==='claim'?{acquired:true,id:'op',lease:'lease'}:{ok:true}}]};}},native:async()=>{creations++;throw Error('lost response with private token');},runtimeFactory:()=>scriptedRuntime(effects,receipts)});
 await executor({key:'secret',command:{acao:'campanha_salvar',brand:'fish'}});assert.equal(creations,1);assert.deepEqual(envelopes[1].operation,{id:'op',lease:'lease'});assert.equal(receipts[1].ok,false);assert.ok(!JSON.stringify(receipts).includes('private token'));
 for(const result of [null,{ok:false}]){let nativeCalls=0;const exec=createExecutor({pool:{query:async sql=>sql===AUTH_SQL?{rows:[{auth:{actor:'x',caps:[]}}]}:{rows:[{result}]}},native:async()=>{nativeCalls++;},runtimeFactory:()=>scriptedRuntime([effects[1]],[])});await exec({key:'x',command:{}});assert.equal(nativeCalls,0);}
});
test('after interruption executor permits only durable finish, blocking next preview/update/schedule',async()=>{
 let ended=false;const receipts=[],ran=[],effects=[{kind:'store',action:'claim',payload:{}},{kind:'provider',action:'update',payload:{}},{kind:'preview',idCampaign:1,payload:{}},{kind:'provider',action:'schedule',payload:{}},{kind:'store',action:'finish',payload:{}}];
 const executor=createExecutor({pool:{async query(sql,params){if(sql===AUTH_SQL)return {rows:[{auth:{actor:'x',caps:[]}}]};const e=JSON.parse(params[2]);ran.push(e.action);if(e.action==='claim'){ended=true;return {rows:[{result:{acquired:true,id:'op',lease:'lease'}}]};}return {rows:[{result:{ok:true}}]};}},native:()=>assert.fail(),runtimeFactory:()=>scriptedRuntime(effects,receipts)});
 await executor({key:'x',command:{},interrupted:()=>ended});assert.deepEqual(ran,['claim','finish']);assert.deepEqual(receipts.map(r=>r.ok),[true,false,false,false,true]);
});
test('native transport restricts paths, sends exact form/JSON, refuses redirects and never retries',async()=>{
 const calls=[],native=nativeTransport({origin:'https://listmonk.example',username:'api',token:'token',fetchFn:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({data:{id:10}}),{status:201});}});
 assert.equal((await native({kind:'nativeCreate',payload:{type:'regular',send_at:null,name:'draft'}})).body.data.id,10);assert.equal(calls[0].url,'https://listmonk.example/api/campaigns');assert.equal(calls[0].init.redirect,'manual');
 await assert.rejects(native({kind:'nativeCreate',payload:{type:'regular',send_at:'2026-09-30'}}));await assert.rejects(native({kind:'preview',idCampaign:'../send',payload:{}}));assert.equal(calls.length,1);
 let count=0;const lost=nativeTransport({origin:'https://listmonk.example',username:'api',token:'token',fetchFn:async()=>{count++;throw Error('lost');}});await assert.rejects(lost({kind:'nativeCreate',payload:{type:'regular',send_at:null}}));assert.equal(count,1);
 const form=nativeTransport({origin:'https://listmonk.example',username:'api',token:'token',fetchFn:async(url,init)=>{assert.equal(url,'https://listmonk.example/api/campaigns/10/preview');assert.equal(new URLSearchParams(init.body).get('body'),'café & {{ UnsubscribeURL }}');return new Response('<html>preview</html>');}});assert.equal((await form({kind:'preview',idCampaign:10,payload:{content_type:'html',template_id:'1',body:'café & {{ UnsubscribeURL }}'}})).status,200);
});
test('native response body is bounded and provider errors expose only deterministic allowlist',async()=>{
 const native=nativeTransport({origin:'https://listmonk.example',username:'x',token:'y',maxResponseBytes:10,fetchFn:async()=>new Response('x'.repeat(11))});await assert.rejects(native({kind:'preview',idCampaign:1,payload:{}}));
 assert.deepEqual(safeError({code:'P0001',message:'AB_V2_CAMPAIGN_FROZEN'}),{code:'P0001',message:'AB_V2_CAMPAIGN_FROZEN'});assert.deepEqual(safeError({code:'P0001',message:'secret SQL'}),{message:'Resultado do serviço não confirmado.'});
 const c=config({CRM_CAMPAIGN_REVISION:'a'.repeat(40),PGUSER:'crm_campaign_api',PGDATABASE:'listmonk',PGHOST:'internal',PGPASSWORD:'synthetic'});assert.equal(c.pg.max,4);assert.equal(c.enabled,false);assert.ok(c.pg.statement_timeout<c.pg.query_timeout);
 assert.throws(()=>config({CRM_CAMPAIGN_REVISION:'a'.repeat(40),PGUSER:'postgres',PGDATABASE:'listmonk',PGHOST:'internal',PGPASSWORD:'synthetic'}));
});
test('native timeout aborts the single request and write deadline reports uncertainty',async t=>{
 let calls=0;const native=nativeTransport({origin:'https://listmonk.example',username:'x',token:'y',timeoutMs:15,fetchFn:async(_url,{signal})=>{calls++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}});
 await assert.rejects(native({kind:'nativeCreate',payload:{type:'regular',send_at:null}}));assert.equal(calls,1);
 const gate=deferred(),app=await fixture(t,{writeDeadlineMs:20,executor:async()=>{await gate.promise;return {status:201,body:{ok:true}};}});
 const r=await request(app,{path:PATH,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({k:'synthetic-key',acao:'campanha_salvar',brand:'fish'})});
 assert.equal(r.status,502);assert.equal(r.body.error,'OUTCOME_UNKNOWN');assert.equal(app.pending(),1);gate.resolve();
});
