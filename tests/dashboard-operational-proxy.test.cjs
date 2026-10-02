'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {decide,validateUpstreams,forward,rewriteCapabilities,ProxyError,MAX_REQUEST,MAX_CAMPAIGN_REQUEST,MAX_AUDIENCE_REQUEST,MAX_PRINT_RESPONSE,MAX_MEDIA_RESPONSE,FIXED_DESTINATIONS,DYNAMIC_MANIFEST_SCHEMA,REVIEWED_DYNAMIC,audiencePayloadHash,verifiedAudienceScope,verifiedAudienceOperation}=require('../services/dashboard-operational/proxy.cjs');
const AudienceHash=require('../n8n/growth/segment-audience-review.cjs');
const {ENDPOINTS,DYNAMIC_ROUTES}=require('../services/dashboard-operational/build.cjs');
const {PATH:CAMPAIGN_PATH,MEDIA_PATH}=require('../services/crm-campaign/server.cjs');
const params=value=>new URLSearchParams(value);
const denied=fn=>assert.throws(fn,e=>e instanceof ProxyError&&e.status>=400&&e.status<500);
const U='123e4567-e89b-42d3-a456-426614174000',K='a'.repeat(32);
const segmentDefinition=brand=>({schema_version:'crm-audience-v2',brand,name:'Synthetic audience',rule:{op:'in_list',list_id:101}});
const draftDefinition=brand=>({schema_version:'crm-campaign-v1',brand,channel:'email',initiative:{key:'gateway-proof',name:'Gateway proof'},utm_campaign:'gateway-proof',name:'Gateway proof',subject:'Proof subject',from_email:brand==='fish'?'Fish <contato@fishermans.com.br>':'Aristo <contato@oaristocrata.com>',reply_to:brand==='fish'?'contato@fishermans.com.br':'contato@oaristocrata.com',list_ids:[3],template_id:1,html:'<a href="https://fishermans.com.br/products/proof">Proof</a> {{ UnsubscribeURL }}',text:'https://fishermans.com.br/products/proof\n{{ UnsubscribeURL }}',tags:[],send_at:null});
const hostsFor=routes=>[...new Set(Object.values(routes).map(value=>new URL(value).hostname))];
const review=routes=>({schema:DYNAMIC_MANIFEST_SCHEMA,sourceRevision:REVIEWED_DYNAMIC.sourceRevision,routes});

test('each area has only its exact read contract and individual credential slot',()=>{
  const cases=[
    ['cx','GET','painel=growth',undefined,'growth','growth-read',false],
    ['cx','GET','painel=organico&access=1',undefined,'organico','organico-read',false],
    ['cache','GET','painel=influs',undefined,'influs','influs-read',false],
    ['crm-read','GET','action=identity&painel=growth',undefined,'growth','growth-read',false],
    ['crm-read','GET','action=cache_growth&painel=growth',undefined,'growth','growth-read',false],
    ['campaigns','GET','acao=campanha_catalogo&brand=fish',undefined,'growth','growth-campaign-read',false],
    ['campaigns','GET','acao=campanha_listar&brand=aristo',undefined,'growth','growth-campaign-read',false],
    ['campaigns','GET','acao=campanha_obter&brand=fish&id=12',undefined,'growth','growth-campaign-read',false],
    ['campaigns_media','GET','brand=fish&page=1&per_page=24',undefined,'growth','growth-campaign-read',false],
    ['campaigns','GET',`acao=campanha_operacao&brand=fish&idempotency_key=${K}`,undefined,'growth','growth-campaign',true],
    ['campaigns','POST','',{acao:'campanha_salvar',brand:'fish',definition:draftDefinition('fish'),idempotency_key:K},'growth','growth-campaign',true],
    ['segments','GET','acao=segmentos_listar&brand=fish&offset=0&limit=50',undefined,'growth','growth-audience-read',false],
    ['segments','GET',`acao=segmento_obter&brand=fish&id=${U}`,undefined,'growth','growth-audience-read',false],
    ['segments','GET',`acao=segmento_operacao&brand=fish&idempotency_key=${U}`,undefined,'growth','growth-audience',true],
    ['segments','GET','acao=segmento_contexto_v2&brand=fish',undefined,'growth','growth-audience',true],
    ['segments','POST','',{acao:'segmento_criar',brand:'fish',definition:segmentDefinition('fish'),expected_catalog_hash:'a'.repeat(64),idempotency_key:U},'growth','growth-audience',true],
    ['segments','POST','',{acao:'segmento_salvar',brand:'fish',id:U,expected_version:1,definition:segmentDefinition('fish'),expected_catalog_hash:'a'.repeat(64),idempotency_key:U},'growth','growth-audience',true],
    ['segments','POST','',{acao:'segmento_arquivar',brand:'fish',id:U,expected_version:1,idempotency_key:U},'growth','growth-audience',true],
    ['campaign_audience','GET','acao=campanha_publico_obter&brand=fish&campaign_id=23',undefined,'growth','growth-audience-read',false],
    ['campaign_audience','GET',`acao=campanha_publico_operacao&brand=fish&idempotency_key=${K}`,undefined,'growth','growth-audience',true],
    ['campaign_audience','GET',`acao=campanha_publico_agendamento_operacao&brand=fish&idempotency_key=${K}`,undefined,'growth','growth-audience',true],
    ['templates','GET','acao=listar&marca=fish&canal=email',undefined,'growth','growth-templates-read',false],
    ['templates','GET','acao=email_capacidades',undefined,'growth','growth-templates-read',false],
    ['templates','GET','acao=historico&draft_id=d_123',undefined,'growth','growth-templates-read',false],
    ['templates','GET','acao=submissao&submission_id=s_123',undefined,'growth','growth-templates-read',false],
    ['templates','GET','acao=fluxos_listar',undefined,'growth','growth-templates-read',false],
    ['templates','GET',`acao=fluxo_operacao&idempotency_key=${K}&operation_action=fluxo_salvar`,undefined,'growth','growth-templates',true],
    ['templates','GET',`acao=operacao&idempotency_key=${K}&operacao=rascunho`,undefined,'growth','growth-templates',true],
    ['templates','GET','acao=email_teste_capacidades_v2',undefined,'growth','growth-templates',true],
    ['templates','GET',`acao=email_teste_operacao_v2&idempotency_key=${U}`,undefined,'growth','growth-templates',true],
    ['templates','GET','acao=email_teste_testadores_v2&brand=fish',undefined,'growth','growth-templates',true],
    ['journey_graph','GET','action=capabilities&brand=fish',undefined,'growth','growth-flows-read',false],
    ['journey_graph','GET',`action=list&brand=fish&after=${U}&limit=25`,undefined,'growth','growth-flows-read',false],
    ['journey_graph','GET',`action=get&brand=fish&journey_id=${U}`,undefined,'growth','growth-flows-read',false],
    ['journey_graph','GET',`action=operation&brand=fish&request_id=${U}`,undefined,'growth','growth-flows',true],
    ['journey_graph_lifecycle','GET',`action=status&brand=fish&journey_id=${U}`,undefined,'growth','growth-flows-read',false],
    ['journey_graph_lifecycle','GET',`action=operation&brand=fish&request_id=${U}`,undefined,'growth','growth-flows',true],
    ['ab_experiment','GET','method=capabilities&brand=fish',undefined,'growth','growth-ab-read',false],
    ['ab_experiment','GET',`method=get&brand=fish&test_id=${U}`,undefined,'growth','growth-ab-read',false],
    ['ab_experiment','GET',`method=operation&brand=fish&operation_id=${U}&action=review`,undefined,'growth','growth-ab-write',true],
    ['ab','GET','acao=capacidades',undefined,'growth','growth-ab-write',true],
    ['ab','GET',`acao=registro&teste_id=${U}`,undefined,'growth','growth-ab-write',true],
    ['ab','GET',`acao=operacao&operation_id=${U}&operacao=criar&teste_id=${U}`,undefined,'growth','growth-ab-write',true],
    ['influ','POST','',{acao:'listar',ini:'2026-09-01',fim:'2026-09-30',pilot:true,marca:'fish'},'influs','influs-read',false],
    ['influ','POST','',{acao:'piloto_operacao',request_id:U},'influs','influs-write',true],
    ['tts','POST','',{ini:'2026-09-01',fim:'2026-09-30'},'influs','tts-read',false],
    ['tts-action','GET','acao=capacidades',undefined,'influs','tts-write',true],
    ['tts-action','GET',`acao=operacao&operation_id=${U}&marca=fish&application_id=123`,undefined,'influs','tts-write',true],
    ['tts-cobranca','POST','',{acao:'ler'},'influs','influs-read',false],
    ['tts-cobranca','POST','',{acao:'produtos'},'influs','influs-read',false],
    ['organico-links','POST','',{acao:'listar'},'organico','organico-links',false],
    ['candidaturas','POST','',{acao:'ler'},'influs','influs-read',false],
    ['candidaturas','POST','',{acao:'print',id:U},'influs','influs-read',false],
    ['aprovacao','POST','',{acao:'ler'},'influs','influs-read',false],
    ['escopo','POST','',{acao:'ler',mes:'2026-09'},'influs','influs-read',false]
  ];
  for(const [route,method,query,body,area,slot,edit]of cases){
    let decision;try{decision=decide(route,method,params(query),body);}catch(e){throw Error(`${route} ${query||JSON.stringify(body)}: ${e.code}`);}
    assert.deepEqual([decision.area,decision.credentialSlot,decision.edit],[area,slot,edit],`${route} ${query||JSON.stringify(body)}`);
  }
});

test('audience BFF request hash matches backend canonical payload for every draft action',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../n8n/growth/segment-audience-contract.js'),'utf8');
 assert.equal(fs.readFileSync(path.join(__dirname,'../services/dashboard-operational/segment-audience-contract.js'),'utf8'),source);
 const operations=[
  {acao:'segmento_criar',brand:'fish',definition:segmentDefinition('fish'),expected_catalog_hash:'a'.repeat(64),idempotency_key:U},
  {idempotency_key:U,expected_catalog_hash:'a'.repeat(64),definition:segmentDefinition('fish'),expected_version:1,id:U,brand:'fish',acao:'segmento_salvar'},
  {expected_version:2,id:U,brand:'fish',acao:'segmento_arquivar',idempotency_key:U}
 ];
 for(const body of operations){
  assert.equal(decide('segments','POST',params(''),body).credentialSlot,'growth-audience');
  assert.equal(audiencePayloadHash(body),AudienceHash.digest(body));
  assert.equal(audiencePayloadHash(body),AudienceHash.digest(require('../n8n/growth/segment-audience-store.cjs').request(body)));
 }
 assert.equal(MAX_AUDIENCE_REQUEST,16000);
 for(const bad of [{...operations[0],k:'ui-'+'a'.repeat(32)},{...operations[0],acao:'segmento_contar'},{...operations[0],definition:{...segmentDefinition('fish'),brand:'aristo'}},{...operations[1],expected_version:0},{...operations[1],id:U.toUpperCase()},{...operations[2],extra:'x'},{...operations[0],idempotency_key:'free-form-key-001'}])denied(()=>decide('segments','POST',params(''),bad));
 const actor='b'.repeat(64),hash=audiencePayloadHash(operations[0]);
 assert.equal(verifiedAudienceScope({scope:{schema:'crm-audience-writer-scope-v2',brand:'fish',actor_sha256:actor}},'fish'),actor);
 const segment={id:U,brand:'fish',name:'Synthetic audience',definition:segmentDefinition('fish'),version:1,archived:false};
 const receipt={operation:{schema:'crm-audience-operation-v2',idempotency_key:U,brand:'fish',action:'segmento_criar',actor_sha256:actor,payload_sha256:hash,receipt:{status:201,body:{segment,transport_supported:false}}}};
 assert.equal(verifiedAudienceOperation(receipt,{brand:'fish',key:U,action:'segmento_criar',payloadMatches:x=>x===hash,actorMatches:x=>x===actor}).phase,'succeeded');
 assert.throws(()=>verifiedAudienceOperation({operation:{...receipt.operation,action:'segmento_salvar'}},{brand:'fish',key:U,action:'segmento_criar',payloadMatches:()=>true,actorMatches:()=>true}),e=>e.code==='UPSTREAM_RECEIPT_UNCONFIRMED');
});

test('unknown, writable, malformed and widened read requests fail before network',()=>{
  const cases=[
    ['cx','GET','painel=cx'],['cache','GET','painel=todos'],['cx','GET','painel=growth&access=2'],
    ['crm-read','GET','painel=growth'],['crm-read','GET','action=identity&painel=organico'],
    ['crm-read','GET','action=identity&painel=growth&action=cache_growth'],
    ['crm-read','GET','action=identity&painel=growth&acao=cache_growth'],
    ['campaigns','GET','acao=campanha_salvar&brand=fish'],
    ['campaigns/media','GET','brand=fish&page=1'],
    ['campaigns_media','GET','brand=fish&filename=crm-fish-test.png'],
    ['campaigns_media','GET','brand=fish&operation_id=123'],
    ['campaigns_media','GET','brand=fish&page=0'],
    ['campaigns_media','GET','brand=aristo&per_page=51'],
    ['campaigns_media','GET','brand=fish&k=secret'],
    ['campaigns_media','GET','brand=fish&brand=aristo'],
    ['campaigns','GET','acao=campanha_obter&brand=fish&id=1&confirm=agendar'],
    ['segments','GET','acao=segmento_contar&brand=fish'],
    ['segments','GET','acao=segmentos_listar&brand=fish&offset=-1&limit=50'],
    ['campaign_audience','GET','acao=campanha_publico_conferir&brand=fish&campaign_id=1'],
    ['templates','GET','acao=email_teste_previa&draft_id=d_1'],
    ['templates','GET','acao=historico&key=a&draft_id=d_1'],
    ['journey_graph_lifecycle','GET',`action=review&brand=fish&journey_id=${U}`],
    ['ab_experiment','GET',`method=mutate&brand=fish&operation_id=${U}`],
    ['tts-action','GET','acao=revisar'],['ab','GET','acao=criar'],
    ['crm-read','GET','action=identity&painel=growth&url=https%3A%2F%2Fevil.invalid'],
    ['crm-read','GET','action=identity&painel=growth&k=secret']
  ];
  for(const [route,method,query]of cases)denied(()=>decide(route,method,params(query),undefined));
  for(const [route,body]of [
    ['campaign_audience',{acao:'campanha_publico_desvincular',brand:'fish',campaign_id:1}],
    ['campaigns/media',{brand:'fish',file:'synthetic'}],
    ['campaigns_media',{brand:'fish',page:'1'}],
    ['influ',{acao:'salvar_influ'}],['influ',{acao:'listar',ini:'2026-02-30',fim:'2026-09-30'}],
    ['organico-links',{acao:'salvar'}],['organico-links',{acao:'listar',data:{url:'https://evil.invalid'}}],
    ['candidaturas',{acao:'enviar'}],['aprovacao',{acao:'aprovar'}],
    ['escopo',{acao:'ler',mes:'2026-13'}],['tts',{acao:'listar',ini:'2026-09-01',fim:'2026-09-30'}]
  ])denied(()=>decide(route,'POST',params(''),body));
  denied(()=>decide('unknown','GET',params(''),undefined));
  denied(()=>decide('tts','PUT',params(''),{}));
  denied(()=>decide('organico-links','POST',params(''),{acao:'listar',k:'real-secret'}));
  assert.equal(decide('organico-links','POST',params(''),{acao:'listar',k:'ui-'+'a'.repeat(32)}).credentialSlot,'organico-links');
});

test('campaign draft request admits only bounded, unscheduled content and paired edit version',()=>{
  const base={acao:'campanha_salvar',brand:'fish',definition:draftDefinition('fish'),idempotency_key:K};
  assert.equal(decide('campaigns','POST',params(''),base).credentialSlot,'growth-campaign');
  assert.equal(decide('campaigns','POST',params(''),{...base,id:12,expected_version:'a'.repeat(32)}).edit,true);
  for(const body of [
    {...base,acao:'campanha_agendar'},
    {...base,confirm:'agendar'},
    {...base,id:12},
    {...base,expected_version:'a'.repeat(32)},
    {...base,id:'12',expected_version:'a'.repeat(32)},
    {...base,id:12,expected_version:'old'},
    {...base,brand:'aristo'},
    {...base,definition:{...base.definition,send_at:'2026-12-01T12:00:00Z'}},
    {...base,definition:{...base.definition,extra:'write'}},
    {...base,definition:{...base.definition,html:'x'.repeat(220001)}},
    {...base,definition:{...base.definition,initiative:{key:'proof',name:'Proof',k:'secret'}}}
  ])denied(()=>decide('campaigns','POST',params(''),body));
  denied(()=>decide('campaigns','POST',params('brand=fish'),base));
  denied(()=>decide('campaigns','GET',params('acao=campanha_salvar&brand=fish'),undefined));
  assert.equal(MAX_REQUEST,128*1024);assert.equal(MAX_CAMPAIGN_REQUEST,256*1024);
  assert.equal(decide('campaigns','POST',params(''),{...base,definition:{...base.definition,html:'x'.repeat(150000)}}).edit,true);
  assert.throws(()=>decide('campaigns','POST',params(''),{...base,definition:{...base.definition,html:'x'.repeat(220000),text:'x'.repeat(50000)}}),e=>e.code==='BODY_TOO_LARGE');
});

test('campaign writer rejects unconfirmed draft state and unrelated operation receipts',async()=>{
 const endpoint=REVIEWED_DYNAMIC.routes.campaigns,upstreams=validateUpstreams({campaigns:endpoint},hostsFor({campaigns:endpoint}),review({campaigns:endpoint}));
 const context={route:'campaigns',user:{role:'manager',areas:['growth']},credential:'individual-campaign-writer',upstreams,origin:'https://crm.shrigma.com.br',crmDraftWrite:true};
 const body={acao:'campanha_salvar',brand:'fish',definition:draftDefinition('fish'),idempotency_key:K};
 let calls=0;
 const fetchImpl=async(_url,options)=>{
  calls++;assert.equal(options.method,'POST');
  assert.equal(Object.hasOwn(options.headers,'Authorization'),false);
  assert.equal(JSON.parse(options.body).k,'individual-campaign-writer');
  return new Response(JSON.stringify({campaign:{status:'scheduled',sent:0,started_at:null,send_at:null,definition:body.definition}}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 await assert.rejects(forward({...context,method:'POST',query:params(''),body,fetchImpl}),e=>e.code==='UPSTREAM_DRAFT_UNCONFIRMED');
 assert.equal(calls,1);
 await assert.rejects(forward({...context,method:'POST',query:params(''),body,crmDraftWrite:false,fetchImpl}),e=>e.code==='EDIT_NOT_READY');
 assert.equal(calls,1);
 const receipt={...context,method:'GET',query:params(`acao=campanha_operacao&brand=fish&idempotency_key=${K}`)};
 await assert.rejects(forward({...receipt,fetchImpl:async(_url,options)=>{
  assert.equal(options.headers.Authorization,'Bearer individual-campaign-writer');
  return new Response(JSON.stringify({operation:{action:'agendar',brand:'fish'}}),{status:200,headers:{'Content-Type':'application/json'}});
 }}),e=>e.code==='UPSTREAM_RECEIPT_UNCONFIRMED');
});

test('graph activation review, activation and receipt lookup are denied before fetch',async()=>{
  const route='journey_graph_lifecycle',configured={[route]:REVIEWED_DYNAMIC.routes[route]};
  const upstreams=validateUpstreams(configured,hostsFor(configured),review(configured));
  const publication={brand:'fish',journey_id:U,expected_version:2,request_id:U,published_revision:2,publication_hash:'b'.repeat(64)};
  let called=0;
  const fetchImpl=async()=>{called++;return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});};
  const context={route,user:{role:'superadmin',areas:['growth']},credential:'synthetic-backend-flows-key',upstreams,origin:'https://crm.shrigma.com.br',fetchImpl};
  const cases=[
    {method:'POST',query:params(''),body:{action:'activation_review',...publication},code:'METHOD_DENIED'},
    {method:'POST',query:params(''),body:{action:'activate',...publication,admission_review_hash:'c'.repeat(64),confirm:'ativar'},code:'METHOD_DENIED'},
    {method:'GET',query:params(`action=activation_operation&brand=fish&request_id=${U}`),code:'ACTION_DENIED'}
  ];
  for(const {code,...request}of cases){
    await assert.rejects(forward({...context,...request}),e=>e instanceof ProxyError&&e.status===403&&e.code===code);
    assert.equal(called,0,request.body?.action||request.query.get('action'));
  }
});

test('fixed destinations match the frontend build and reject wrong paths on an approved host',()=>{
  assert.deepEqual(FIXED_DESTINATIONS,Object.fromEntries(Object.entries(ENDPOINTS).map(([url,route])=>[route,url])));
  assert.deepEqual(Object.keys(REVIEWED_DYNAMIC.routes).filter(route=>!DYNAMIC_ROUTES.includes(route)),[]);
  for(const [source,expected]of Object.entries(REVIEWED_DYNAMIC.sourceSha256))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'..',source))).digest('hex'),expected,source);
  assert.equal(MEDIA_PATH,CAMPAIGN_PATH+'/media');
  assert.equal(new URL(REVIEWED_DYNAMIC.routes.campaigns_media).pathname,MEDIA_PATH);
  const hosts=hostsFor(FIXED_DESTINATIONS),read=FIXED_DESTINATIONS['crm-read'];
  assert.equal(validateUpstreams({'crm-read':read},hosts)['crm-read'].pathname,'/read');
  for(const bad of [
    {'crm-read':read.replace('https:','http:')},
    {'crm-read':'https://evil.invalid/read'},
    {'crm-read':read.replace('/read','/other-read')},
    {'crm-read':read.replace('/read','/read?to=evil')},
    {'crm-read':read.replace('/read','/read#fragment')},
    {'crm-read':read.replace('/read',':443/read')},
    {'crm-read':read.replace('https://','https://user@')},
    {unknown:read},
    {cx:FIXED_DESTINATIONS.cache,cache:FIXED_DESTINATIONS.cx}
  ])assert.throws(()=>validateUpstreams(bad,hosts));
  assert.throws(()=>validateUpstreams({'crm-read':read},[]));
});

test('media library opt-in forwards only bounded JSON GET with the individual read key',async()=>{
  const endpoint=REVIEWED_DYNAMIC.routes.campaigns_media;
  const configured={campaigns_media:endpoint};
  const upstreams=validateUpstreams(configured,hostsFor(configured),review(configured));
  let calls=0;
  const response={contract:'crm-media-v1',brand:'fish',items:[],total:0,page:1,per_page:24,next_page:null};
  const fetchImpl=async(url,options)=>{
    calls++;
    assert.equal(url.href,endpoint+'?brand=fish&page=1&per_page=24');
    assert.equal(options.method,'GET');
    assert.equal(options.headers.Authorization,'Bearer individual-read-content-key');
    assert.equal(options.headers.Accept,'application/json');
    assert.equal(Object.hasOwn(options.headers,'Origin'),false);
    assert.equal(Object.hasOwn(options,'body'),false);
    return new Response(JSON.stringify(response),{status:200,headers:{'Content-Type':'application/json; charset=utf-8'}});
  };
  const context={route:'campaigns_media',method:'GET',query:params('brand=fish&page=1&per_page=24'),
    user:{role:'manager',areas:['growth']},credential:'individual-read-content-key',upstreams,
    origin:'https://crm.shrigma.com.br',fetchImpl};
  const result=await forward(context);
  assert.equal(result.status,200);assert.deepEqual(result.body,response);assert.equal(calls,1);
  for(const change of [
    {user:{role:'manager',areas:['influs']}},
    {credential:null},
    {method:'POST',query:params(''),body:{brand:'fish',file:'synthetic'}},
    {query:params('brand=fish&operation_id=123')},
    {query:params('brand=fish&page=1&page=2')}
  ]){
    await assert.rejects(forward({...context,...change}),e=>e instanceof ProxyError&&e.status>=400);
    assert.equal(calls,1);
  }
  await assert.rejects(forward({...context,upstreams:{}}),e=>e.code==='UPSTREAM_NOT_CONFIGURED');
  assert.equal(calls,1);
  assert.throws(()=>validateUpstreams({campaigns_media:endpoint.replace('/media','/media/')},hostsFor(configured),review({campaigns_media:endpoint.replace('/media','/media/')})));
});

test('media listing rejects non-JSON, redirects and responses beyond its two MiB limit',async()=>{
  const endpoint=REVIEWED_DYNAMIC.routes.campaigns_media;
  const upstreams=validateUpstreams({campaigns_media:endpoint},hostsFor({campaigns_media:endpoint}),review({campaigns_media:endpoint}));
  const context={route:'campaigns_media',method:'GET',query:params('brand=aristo'),user:{role:'superadmin',areas:['growth']},
    credential:'individual-read-content-key',upstreams,origin:'https://gerencial.shrigma.com.br'};
  assert.equal(MAX_MEDIA_RESPONSE,2*1024*1024);
  for(const [response,code]of [
    [new Response('{}',{status:200,headers:{'Content-Type':'text/html'}}),'UPSTREAM_CONTENT_TYPE_DENIED'],
    [new Response(null,{status:302,headers:{Location:'https://evil.invalid'}}),'UPSTREAM_REDIRECT_DENIED'],
    [new Response(' '.repeat(MAX_MEDIA_RESPONSE+1),{status:200,headers:{'Content-Type':'application/json'}}),'UPSTREAM_RESPONSE_TOO_LARGE']
  ])await assert.rejects(forward({...context,fetchImpl:async()=>response}),e=>e.code===code);
});

test('the gateway sends only the selected backend credential and rewrites trusted capabilities',async()=>{
  const read=FIXED_DESTINATIONS['crm-read'],upstreams=validateUpstreams({'crm-read':read},hostsFor(FIXED_DESTINATIONS));
  let called=0;
  const fetchImpl=async(url,options)=>{
    called++;
    assert.equal(url.href,read+'?action=cache_growth&painel=growth');
    assert.equal(options.headers.Authorization,'Bearer backend-individual-key');
    assert.equal(Object.hasOwn(options.headers,'Origin'),false);
    assert.equal(options.redirect,'manual');
    return new Response(JSON.stringify({capabilities:{endpoints:{read,evil:'https://evil.invalid'}}}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const result=await forward({route:'crm-read',method:'GET',query:params('action=cache_growth&painel=growth'),user:{role:'manager',areas:['growth']},credential:'backend-individual-key',upstreams,origin:'https://crm.shrigma.com.br',fetchImpl});
  assert.equal(called,1);
  assert.equal(result.body.capabilities.endpoints.read,'https://crm.shrigma.com.br/api/crm-read');
  assert.equal(Object.hasOwn(result.body.capabilities.endpoints,'evil'),false);
});

test('published capabilities cannot announce operations the BFF has not enabled',()=>{
  const configured={campaigns:REVIEWED_DYNAMIC.routes.campaigns,segments:REVIEWED_DYNAMIC.routes.segments,ab:FIXED_DESTINATIONS.ab,'tts-action':FIXED_DESTINATIONS['tts-action']};
  const upstreams=validateUpstreams(configured,hostsFor(configured),review({campaigns:configured.campaigns,segments:configured.segments}));
  const payload={pode_escrever:true,capabilities:{
    write:true,write_key_required:true,
    endpoints:{campaigns:configured.campaigns,segments:configured.segments,ab:configured.ab,'tts-action':configured['tts-action'],templates:'https://unreviewed.invalid/templates'},
    campaigns:{contract_version:'crm-campaign-v1',brands:['fish'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true,recover:true,audience_review:'legacy',recovery_policy:'legacy'},
    segments:{contract_version:'crm-audience-v2',brands:['fish'],read:true,save:true,count:true,operation:true},
    templates:{read_content:true,list_history:true,draft:true,submit:true,submit_email:true,email_test_recipient:'legacy'},
    workflows:{set_mode:true,activate:true},
    ab_experiment:{enabled:true,operation:true,read:true},
    journeys:{graph_drafts:'legacy',graph_lifecycle:{prepare:true,publish_paused:true,activate:false}}
  }};
  const actual=rewriteCapabilities(payload,upstreams,'https://crm.shrigma.com.br');
  assert.equal(actual.pode_escrever,false);
  assert.deepEqual(actual.capabilities.endpoints,{campaigns:'https://crm.shrigma.com.br/api/campaigns',segments:'https://crm.shrigma.com.br/api/segments'});
  for(const flag of ['save','validate','schedule','cancel','operation','recover'])assert.equal(actual.capabilities.campaigns[flag],false,flag);
  assert.equal(actual.capabilities.campaigns.read,true);
  for(const flag of ['save','count','operation'])assert.equal(actual.capabilities.segments[flag],false,flag);
  assert.equal(actual.capabilities.segments.read,true);
  for(const flag of ['read_content','list_history','draft','submit','submit_email'])assert.equal(actual.capabilities.templates[flag],false,flag);
  assert.equal(actual.capabilities.workflows.activate,false);
  assert.equal(actual.capabilities.ab_experiment.enabled,false);
  assert.equal(actual.capabilities.ab_experiment.operation,false);
  assert.equal(actual.capabilities.ab_experiment.read,false);
  assert.deepEqual(actual.capabilities.journeys,{});
  for(const policy of ['write_key_required','audience_review','recovery_policy'])assert.equal(JSON.stringify(actual.capabilities).includes(`"${policy}"`),false,policy);
  assert.equal(payload.pode_escrever,true);
  assert.equal(payload.capabilities.campaigns.save,true);
});

test('upstream graph activate true cannot enable activation in published capabilities',()=>{
  const route='journey_graph_lifecycle',configured={[route]:REVIEWED_DYNAMIC.routes[route]};
  const upstreams=validateUpstreams(configured,hostsFor(configured),review(configured));
  const payload={capabilities:{
    activate:true,endpoints:{[route]:configured[route]},
    journeys:{graph_drafts:'journey_graph_draft_api_v1',graph_lifecycle:{contract:'journey_graph_lifecycle_panel_v1',prepare:true,publish_paused:true,activate:true,brands:['fish','aristo']}},
    actions:['status','activation_review','activate','activation_operation']
  }};
  const actual=rewriteCapabilities(payload,upstreams,'https://crm.shrigma.com.br').capabilities;
  assert.equal(actual.activate,false);
  assert.deepEqual(actual.journeys,{});
  assert.deepEqual(actual.actions,['status']);
  assert.deepEqual(actual.endpoints,{[route]:'https://crm.shrigma.com.br/api/'+route});
  assert.equal(payload.capabilities.activate,true);
  assert.equal(payload.capabilities.journeys.graph_lifecycle.activate,true);
});

test('route-local capability flags are downgraded even without an endpoints map',()=>{
  const original={capabilities:{draft:true,count:true,send:false,read:true}};
  const actual=rewriteCapabilities(original,{},'https://crm.shrigma.com.br');
  assert.deepEqual(actual,{capabilities:{draft:false,count:false,send:false,read:true}});
  assert.deepEqual(original,{capabilities:{draft:true,count:true,send:false,read:true}});
});

test('capability action arrays retain only gateway reads and reject a writable endpoint alias',()=>{
  const campaigns=REVIEWED_DYNAMIC.routes.campaigns,upstreams={campaigns:new URL(campaigns)};
  const payload={capabilities:{
    endpoints:{campaigns,write_api:campaigns},
    actions:['read','campanha_listar','campanha_operacao','save','unreviewed'],
    campaigns:{brands:['fish','aristo'],caps:['read','schedule'],permissions:[{action:'list',read:true,save:true},{action:'create',create:true}]}
  }};
  const actual=rewriteCapabilities(payload,upstreams,'https://crm.shrigma.com.br').capabilities;
  assert.deepEqual(actual.endpoints,{campaigns:'https://crm.shrigma.com.br/api/campaigns'});
  assert.deepEqual(actual.actions,['read','campanha_listar']);
  assert.deepEqual(actual.campaigns.brands,['fish','aristo']);
  assert.deepEqual(actual.campaigns.caps,['read']);
  assert.deepEqual(actual.campaigns.permissions,[{action:'list',read:true,save:false}]);
  assert.deepEqual(rewriteCapabilities({capabilities:['read','save','list','delete']},upstreams,'https://crm.shrigma.com.br').capabilities,['read','list']);
});

test('reviewed dynamic CRM URLs resolve to the same origin; unreviewed endpoints disappear',async()=>{
  const source=REVIEWED_DYNAMIC.routes,configured={'crm-read':FIXED_DESTINATIONS['crm-read'],...source};
  const upstreams=validateUpstreams(configured,hostsFor(configured),review(source));
  const fetchImpl=async()=>new Response(JSON.stringify({capabilities:{endpoints:{...source,templates:'https://unknown.invalid/templates',journey_graph:'https://unknown.invalid/graph',unrecognized:'https://unknown.invalid/private'}}}),{status:200,headers:{'Content-Type':'application/json'}});
  const result=await forward({route:'crm-read',method:'GET',query:params('action=cache_growth&painel=growth'),user:{role:'manager',areas:['growth']},credential:'backend-individual-key',upstreams,origin:'https://crm.shrigma.com.br',fetchImpl});
  assert.equal(result.status,200);
  assert.deepEqual(result.body.capabilities.endpoints,Object.fromEntries(Object.keys(source).map(route=>[route,'https://crm.shrigma.com.br/api/'+route])));
});

test('dynamic destinations require a source-pinned exact route manifest',()=>{
  const segments=REVIEWED_DYNAMIC.routes.segments,bindings=REVIEWED_DYNAMIC.routes.campaign_audience,config={segments};
  const hosts=hostsFor(REVIEWED_DYNAMIC.routes);
  assert.equal(validateUpstreams(config,hosts,review(config)).segments.href,segments);
  for(const manifest of [null,review({segments:bindings}),review({segments,extra:segments}),{...review(config),sourceRevision:'0'.repeat(40)}])assert.throws(()=>validateUpstreams(config,hosts,manifest));
  assert.throws(()=>validateUpstreams({segments:bindings},hosts,review({segments:bindings}))); // another approved route on the same host
  assert.throws(()=>validateUpstreams({templates:'https://n8n-n8n.tazdb8.easypanel.host/webhook/templates'},hostsFor(FIXED_DESTINATIONS),review({templates:'https://n8n-n8n.tazdb8.easypanel.host/webhook/templates'})));
  assert.throws(()=>validateUpstreams({journey_graph:'https://comunicacao-crm-audience.tazdb8.easypanel.host/journey-graph'},hosts,review({journey_graph:'https://comunicacao-crm-audience.tazdb8.easypanel.host/journey-graph'})));
});

test('body-key reads receive only their private key in the body, without browser credential or Origin',async()=>{
  const upstreams=validateUpstreams({'organico-links':FIXED_DESTINATIONS['organico-links']},hostsFor(FIXED_DESTINATIONS));
  let payload;
  const fetchImpl=async(_url,options)=>{
    payload=JSON.parse(options.body);
    assert.equal(Object.hasOwn(options.headers,'Authorization'),false);
    assert.equal(Object.hasOwn(options.headers,'Origin'),false);
    return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});
  };
  await forward({route:'organico-links',method:'POST',query:params(''),body:{acao:'listar',k:'ui-'+'b'.repeat(32)},user:{role:'manager',areas:['organico']},credential:'backend-organico-key',upstreams,origin:'https://organico.shrigma.com.br',fetchImpl});
  assert.deepEqual(payload,{acao:'listar',k:'backend-organico-key'});
});

test('all unrelated edit receipts remain closed even if a writer credential exists',async()=>{
  const upstreams={...validateUpstreams({ab:FIXED_DESTINATIONS.ab,'tts-action':FIXED_DESTINATIONS['tts-action']},hostsFor(FIXED_DESTINATIONS)),templates:new URL('https://unconfigured.test/templates')};
  const headers=[];
  const fetchImpl=async(_url,options)=>{headers.push(options.headers);return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});};
  const user={role:'superadmin',areas:['growth','organico','influs']};
  for(const request of [
    {route:'ab',query:params('acao=capacidades')},
    {route:'tts-action',query:params('acao=capacidades')},
    {route:'templates',query:params(`acao=operacao&idempotency_key=${K}&operacao=rascunho`)}
  ])await assert.rejects(forward({...request,method:'GET',user,credential:'backend-individual-writer',upstreams,origin:'https://gerencial.shrigma.com.br',crmDraftWrite:true,fetchImpl}),e=>e.code==='EDIT_NOT_READY');
  assert.equal(headers.length,0);
});

test('saved-audience and legacy A/B reads use their respective header contracts',async()=>{
  const configured={ab_experiment:REVIEWED_DYNAMIC.routes.ab_experiment};
  const upstreams=validateUpstreams(configured,hostsFor(configured),review(configured));
  assert.throws(()=>validateUpstreams({ab_experiment:'https://legacy.internal.example/ab-experiments'},['legacy.internal.example'],review({ab_experiment:'https://legacy.internal.example/ab-experiments'})));
  const legacy={ab_experiment:new URL('https://legacy.internal.example/ab-experiments')}; // transport-only unit branch, never admitted at startup
  const seen=[];
  const fetchImpl=async(_url,options)=>{seen.push(options.headers);return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});};
  const context={route:'ab_experiment',method:'GET',query:params('method=capabilities&brand=fish'),user:{role:'manager',areas:['growth']},credential:'backend-ab-read-key',origin:'https://crm.shrigma.com.br',fetchImpl};
  await forward({...context,upstreams});
  await forward({...context,upstreams:legacy});
  assert.equal(seen[0].Authorization,'Bearer backend-ab-read-key');
  assert.equal(Object.hasOwn(seen[0],'X-AB-Write-Key'),false);
  assert.equal(seen[1]['X-AB-Write-Key'],'backend-ab-read-key');
  assert.equal(Object.hasOwn(seen[1],'Authorization'),false);
});

test('private print response has a separate 5 MiB cap; scope check precedes network',async()=>{
  assert.equal(MAX_PRINT_RESPONSE,5*1024*1024);
  const upstreams=validateUpstreams({candidaturas:FIXED_DESTINATIONS.candidaturas,'crm-read':FIXED_DESTINATIONS['crm-read']},hostsFor(FIXED_DESTINATIONS));
  let called=0;
  const fetchImpl=async()=>{called++;return new Response('redirect',{status:302,headers:{Location:'https://evil.invalid'}});};
  await assert.rejects(forward({route:'crm-read',method:'GET',query:params('action=cache_growth&painel=growth'),user:{role:'manager',areas:['organico']},credential:'backend-individual-key',upstreams,origin:'https://crm.shrigma.com.br',fetchImpl}),e=>e.status===403);
  assert.equal(called,0);
  await assert.rejects(forward({route:'crm-read',method:'GET',query:params('action=cache_growth&painel=growth'),user:{role:'manager',areas:['growth']},credential:'backend-individual-key',upstreams,origin:'https://crm.shrigma.com.br',fetchImpl}),e=>e.code==='UPSTREAM_REDIRECT_DENIED');
});
