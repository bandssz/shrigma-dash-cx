'use strict';
// Ponte READ do portal para públicos (agente K). Sem rede: auth e fetch injetados.
const {test}=require('node:test'),assert=require('node:assert/strict');
const M=require('../services/dashboard-operational/crm-audience-read-bridge.cjs');
const NOW=Date.UTC(2026,9,3,12),CRED='c'.repeat(64),HOST='dashboard-v24-crm.tazdb8.easypanel.host',ORIGIN='https://'+HOST;
const proof=(over={},brand='fish')=>({userId:brand==='fish'?'11111111-1111-4111-8111-111111111111':'33333333-3333-4333-8333-333333333333',owner:brand+'@oaristocrata.com',lifecycleId:brand==='fish'?'22222222-2222-4222-8222-222222222222':'44444444-4444-4444-8444-444444444444',lifecycleVersion:1,principalId:'dcrm-'+(brand==='fish'?'a':'b').repeat(32),generation:1,expiresAt:NOW+86400000,credentialMac:'d'.repeat(64),slot:'crm-panel-read',caps:['read_content','list_history','submission'],...over});
const credentialFor=brand=>brand==='fish'?CRED:'e'.repeat(64);
function harness({brand='fish',proofs=null,credential=credentialFor(brand),body,status=200,headers={},enabled=true,raw=null,fetchCheck=null}={}){
 const calls={auth:0,cred:0,fetch:[]};let n=0;
 const auth={managedCrmReadAuthorization(ctx){calls.auth++;assert.equal(ctx.brand,brand);assert.equal(ctx.method,'GET');assert.equal(ctx.area,'growth');assert.equal(ctx.edit,false);const p=proofs?proofs[Math.min(n++,proofs.length-1)]:proof({},brand);if(p instanceof Error)throw p;return p;},
  getUpstreamCredential(ctx){calls.cred++;assert.equal(ctx.brand,brand);assert.equal(ctx.slot,'crm-panel-read');assert.equal(ctx.edit,false);return credential;}};
 const fetchImpl=async(url,init)=>{calls.fetch.push({url:String(url),init});fetchCheck?.(url,init);const text=raw??JSON.stringify(body);return new Response(text,{status,headers:{'content-type':'application/json; charset=utf-8',...headers}});};
 const bridge=M.createAudienceReadBridge({auth,upstreams:{'audience-read':new URL(M.DESTINATIONS['audience-read'])},enabled},{fetchImpl,now:()=>NOW});
 const read=(route,query,extra={})=>bridge.read({context:{method:'GET',host:HOST,brand,...extra.context},route,method:extra.method||'GET',query:new URLSearchParams(query),origin:extra.origin||ORIGIN});
 return {calls,read};
}
const fresh={contract:'crm-audience-read-freshness-v1',catalog_refreshed_at:'2026-10-03T11:59:00.000Z',catalog_expires_at:'2026-10-03T12:03:00.000Z',catalog_age_seconds:60,read_at:'2026-10-03T12:00:00.000Z',current:true,stale:false,coverage:'unconfirmed',schedule_proof:false};
const stale={...fresh,catalog_refreshed_at:'2026-10-03T11:00:00.000Z',catalog_expires_at:'2026-10-03T11:04:00.000Z',catalog_age_seconds:3600,current:false,stale:true};
const FLAGS={selector_ready:false,execution_blocked:true,authorizes_selection:false,authorizes_send:false};
const listsBody=brand=>({brand,base_list_id:brand==='fish'?17:16,lists:[{id:brand==='fish'?17:16,brand,name:'Base',available:true}],freshness:fresh});
const ctxBody=(brand,id,over={})=>({contract:'crm-audience-campaign-read-context-v1',brand,campaign_id:id,campaign_version:'e'.repeat(32),status:'draft',list_ids:[brand==='fish'?17:16],lists:[{id:brand==='fish'?17:16,name:'Base',available:true,in_brand:true}],list_only:true,binding_state:'none',binding:null,freshness:fresh,schedule_proof:false,...FLAGS,...over});

test('campanha só-lista nas duas marcas: GET fixo, credencial do principal, query canônica e corpo validado',async()=>{
 for(const [brand,id]of [['fish',300],['aristo',200]]){
  const h=harness({brand,body:ctxBody(brand,id),fetchCheck:(url,init)=>{assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.headers.Authorization,'Bearer '+credentialFor(brand));assert.equal(init.body,undefined);}});
  const r=await h.read('campaign_audience',{campaign_id:String(id),brand,acao:'campanha_publico_contexto'});
  assert.equal(r.status,200);assert.equal(r.body.list_only,true);assert.equal(r.body.binding,null);
  assert.equal(h.calls.fetch[0].url,M.DESTINATIONS['audience-read']+`?acao=campanha_publico_contexto&brand=${brand}&campaign_id=${id}`);
  assert.equal(h.calls.auth,3,'vínculo conferido antes, ao obter a credencial e depois do corpo');
  const lists=harness({brand,body:listsBody(brand)});assert.equal((await lists.read('segments',{acao:'publicos_listas',brand})).status,200);
  const ob=harness({brand,body:{binding:null,campaign_id:id,campaign_version:'e'.repeat(32),...FLAGS}});assert.equal((await ob.read('campaign_audience',{acao:'campanha_publico_obter',brand,campaign_id:String(id)})).body.binding,null);
 }
 const old=harness({body:ctxBody('fish',300,{freshness:stale})});assert.equal((await old.read('campaign_audience',{acao:'campanha_publico_contexto',brand:'fish',campaign_id:'300'})).body.freshness.stale,true,'catálogo velho passa como informação, nunca como prova');
});

test('flag OFF: 503 antes de autorização, credencial ou fetch',async()=>{
 const h=harness({enabled:false,body:listsBody('fish')});
 await assert.rejects(h.read('segments',{acao:'publicos_listas',brand:'fish'}),{status:503,code:'AUDIENCE_READ_DISABLED'});
 assert.deepEqual([h.calls.auth,h.calls.cred,h.calls.fetch.length],[0,0,0]);
});

test('pedido fora do contrato é recusado sem I/O: escrita, operação, marca, método, origem, campos e tamanho',async()=>{
 const cases=[['segments',{acao:'segmento_criar',brand:'fish'}],['segments',{acao:'segmento_operacao',brand:'fish',idempotency_key:'abcdefgh'}],['segments',{acao:'segmento_contexto_v2',brand:'fish'}],
  ['campaign_audience',{acao:'campanha_publico_validar',brand:'fish',campaign_id:'100'}],['campaign_audience',{acao:'campanha_publico_operacao',brand:'fish',idempotency_key:'abcdefgh'}],
  ['segments',{acao:'publicos_listas',brand:'olivas'}],['segments',{acao:'publicos_listas'}],['segments',{acao:'publicos_listas',brand:'fish',k:'ui-'+'a'.repeat(32)}],
  ['segments',{acao:'segmento_obter',brand:'fish',id:'not-a-uuid'}],['segments',{acao:'segmentos_listar',brand:'fish',offset:'0',limit:'101'}],['campaign_audience',{acao:'campanha_publico_obter',brand:'fish',campaign_id:'0'}],
  ['campaigns',{acao:'campanha_listar',brand:'fish'}],['templates',{acao:'listar'}],['segments',{acao:'publicos_listas',brand:'fish',pad:'x'.repeat(600)}]];
 for(const [route,q]of cases){const h=harness({body:listsBody('fish')});await assert.rejects(h.read(route,q),e=>e instanceof M.AudienceReadError&&[403,413].includes(e.status),JSON.stringify(q));assert.equal(h.calls.fetch.length,0);assert.equal(h.calls.cred,0);}
 const scoped=harness({brand:'fish',body:listsBody('aristo')});await assert.rejects(scoped.read('segments',{acao:'publicos_listas',brand:'aristo'}),{status:403});assert.deepEqual([scoped.calls.auth,scoped.calls.cred,scoped.calls.fetch.length],[0,0,0]);
 const dup=harness({body:listsBody('fish')});await assert.rejects(dup.read('segments','acao=publicos_listas&brand=fish&brand=aristo'),{status:403});
 for(const extra of [{method:'POST'},{origin:'https://evil.example'},{context:{method:'POST'}}]){const h=harness({body:listsBody('fish')});await assert.rejects(h.read('segments',{acao:'publicos_listas',brand:'fish'},extra),{status:403});assert.equal(h.calls.fetch.length,0);}
 assert.throws(()=>M.createAudienceReadBridge({auth:{managedCrmReadAuthorization(){},getUpstreamCredential(){}},upstreams:{'audience-read':new URL('https://evil.example/audience-read')},enabled:true}),{status:403},'destino fixo');
 assert.throws(()=>M.createAudienceReadBridge({auth:{managedCrmReadAuthorization(){},getUpstreamCredential(){}},upstreams:{'audience-read':new URL(M.DESTINATIONS['audience-read']),segments:new URL('https://comunicacao-crm-audience.tazdb8.easypanel.host/segments')},enabled:true}),{status:403},'sem rota legada de públicos');
});

test('principal revogado, expirado, trocado ou com credencial inválida: 503 sem dado',async()=>{
 const revoked=Object.assign(Error('CRM_ACCESS_NOT_READY'),{status:503});
 const cases=[{proofs:[revoked]},{proofs:[proof({expiresAt:NOW+1000})]},{proofs:[proof({expiresAt:NOW-1})]},{proofs:[proof(),proof({generation:2})]},{proofs:[proof(),proof({slot:'growth-read'})]},{proofs:[proof({caps:['read_content','list_history','submission','draft']})]},{credential:'x'},{credential:null}];
 for(const c of cases){const h=harness({...c,body:listsBody('fish')});await assert.rejects(h.read('segments',{acao:'publicos_listas',brand:'fish'}),{status:503,code:'AUDIENCE_READ_NOT_READY'});assert.equal(h.calls.fetch.length,0,JSON.stringify(c));}
 // Revogação ou troca observadas depois do corpo: o dado já lido não sai.
 for(const late of [[proof(),proof(),revoked],[proof(),proof(),proof({lifecycleVersion:2})],[proof(),proof(),proof({expiresAt:NOW})]]){
  const h=harness({proofs:late,body:listsBody('fish')});await assert.rejects(h.read('segments',{acao:'publicos_listas',brand:'fish'}),{status:503,code:'AUDIENCE_READ_NOT_READY'});assert.equal(h.calls.fetch.length,1);
 }
});

test('resposta malformada, de outra marca, grande demais, com eco de segredo ou alegando prova é recusada',async()=>{
 const deny={status:502,code:'AUDIENCE_READ_RESPONSE_DENIED'},q={acao:'publicos_listas',brand:'fish'},cq={acao:'campanha_publico_contexto',brand:'fish',campaign_id:'300'};
 const bad=[{raw:'{'},{raw:new Uint8Array([0xff])},{raw:'[]'},{raw:JSON.stringify({...listsBody('fish'),extra:1})},{body:listsBody('aristo')},{body:{...listsBody('fish'),lists:[{id:16,brand:'aristo',name:'x',available:true}]}},
  {body:{...listsBody('fish'),freshness:{...fresh,schedule_proof:true}}},{body:{...listsBody('fish'),freshness:{...stale,current:true}}},{body:{...listsBody('fish'),freshness:{...fresh,catalog_expires_at:'2026-10-03T11:00:00.000Z'}}},
  {body:{...listsBody('fish'),lists:[{id:17,brand:'fish',name:CRED,available:true}]}},{raw:JSON.stringify(listsBody('fish')),headers:{'content-type':'text/html'}},{raw:JSON.stringify(listsBody('fish')),headers:{'content-encoding':'gzip'}},
  {raw:JSON.stringify(listsBody('fish')),headers:{'content-length':String(M.MAX_RESPONSE+1)}},{raw:JSON.stringify({...listsBody('fish'),lists:Array.from({length:999},(_,i)=>({id:i+1,brand:'fish',name:'x'.repeat(480),available:true}))}).padEnd(M.MAX_RESPONSE+10,' ')}];
 for(const c of bad){const h=harness(c);await assert.rejects(h.read('segments',q),deny,JSON.stringify(c).slice(0,120));}
 const ctxBad=[ctxBody('aristo',300),ctxBody('fish',301),ctxBody('fish',300,{schedule_proof:true}),ctxBody('fish',300,{execution_blocked:false}),ctxBody('fish',300,{list_only:false}),ctxBody('fish',300,{binding_state:'bound'}),
  ctxBody('fish',300,{lists:[{id:17,name:'Base',available:true,in_brand:false}]}),ctxBody('fish',300,{list_ids:[16]})];
 for(const body of ctxBad){const h=harness({body});await assert.rejects(h.read('campaign_audience',cq),deny);}
 const seg={segments:[],limit:50,offset:0,catalog:{brand:'fish',current:true,coverage:'unconfirmed',catalog_hash:'f'.repeat(64),checked_at:fresh.read_at,lists:[],fields:[],products:[],origins:[]},capabilities:{draft:false,count:false,send:false},freshness:fresh};
 const sq={acao:'segmentos_listar',brand:'fish',offset:'0',limit:'50'};assert.equal((await harness({body:seg}).read('segments',sq)).status,200);
 for(const body of [{...seg,capabilities:{draft:true,count:false,send:false}},{...seg,capabilities:{draft:false,count:true,send:false}},{...seg,limit:100},{...seg,catalog:{...seg.catalog,brand:'aristo'}},{...seg,catalog:{...seg.catalog,current:false}}])
  await assert.rejects(harness({body}).read('segments',sq),deny);
 for(const [status,code,http]of [[404,'AUDIENCE_READ_NOT_FOUND',404],[401,'AUDIENCE_READ_UPSTREAM_DENIED',403],[403,'AUDIENCE_READ_UPSTREAM_DENIED',403],[503,'AUDIENCE_READ_UPSTREAM_UNAVAILABLE',502],[302,'AUDIENCE_READ_UPSTREAM_UNAVAILABLE',502]]){
  const h=harness({status,raw:JSON.stringify({error:'SEGMENT_NOT_FOUND'})});await assert.rejects(h.read('segments',q),{status:http,code});assert.equal(h.calls.auth,2,'sem releitura do vínculo nem repetição');assert.equal(h.calls.fetch.length,1);
 }
});
