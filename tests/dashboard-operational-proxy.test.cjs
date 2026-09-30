'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {decide,validateUpstreams,forward,ProxyError,MAX_PRINT_RESPONSE,FIXED_DESTINATIONS,DYNAMIC_MANIFEST_SCHEMA,REVIEWED_DYNAMIC}=require('../services/dashboard-operational/proxy.cjs');
const {ENDPOINTS,DYNAMIC_ROUTES}=require('../services/dashboard-operational/build.cjs');
const params=value=>new URLSearchParams(value);
const denied=fn=>assert.throws(fn,e=>e instanceof ProxyError&&e.status>=400&&e.status<500);
const U='123e4567-e89b-42d3-a456-426614174000',K='a'.repeat(32);
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
    ['campaigns','GET',`acao=campanha_operacao&brand=fish&idempotency_key=${K}`,undefined,'growth','growth-campaign',true],
    ['segments','GET','acao=segmentos_listar&brand=fish&offset=0&limit=50',undefined,'growth','growth-audience-read',false],
    ['segments','GET',`acao=segmento_obter&brand=fish&id=${U}`,undefined,'growth','growth-audience-read',false],
    ['segments','GET',`acao=segmento_operacao&brand=fish&idempotency_key=${K}`,undefined,'growth','growth-audience',true],
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

test('unknown, writable, malformed and widened read requests fail before network',()=>{
  const cases=[
    ['cx','GET','painel=cx'],['cache','GET','painel=todos'],['cx','GET','painel=growth&access=2'],
    ['crm-read','GET','painel=growth'],['crm-read','GET','action=identity&painel=organico'],
    ['crm-read','GET','action=identity&painel=growth&action=cache_growth'],
    ['crm-read','GET','action=identity&painel=growth&acao=cache_growth'],
    ['campaigns','GET','acao=campanha_salvar&brand=fish'],
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

test('fixed destinations match the frontend build and reject wrong paths on an approved host',()=>{
  assert.deepEqual(FIXED_DESTINATIONS,Object.fromEntries(Object.entries(ENDPOINTS).map(([url,route])=>[route,url])));
  assert.deepEqual(Object.keys(REVIEWED_DYNAMIC.routes).filter(route=>!DYNAMIC_ROUTES.includes(route)),[]);
  for(const [source,expected]of Object.entries(REVIEWED_DYNAMIC.sourceSha256))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'..',source))).digest('hex'),expected,source);
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

test('receipt lookups preserve their dedicated authentication transport',async()=>{
  const upstreams={...validateUpstreams({ab:FIXED_DESTINATIONS.ab,'tts-action':FIXED_DESTINATIONS['tts-action']},hostsFor(FIXED_DESTINATIONS)),templates:new URL('https://unconfigured.test/templates')};
  const headers=[];
  const fetchImpl=async(_url,options)=>{headers.push(options.headers);return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});};
  const user={role:'superadmin',areas:['growth','organico','influs']};
  await forward({route:'ab',method:'GET',query:params('acao=capacidades'),user,credential:'backend-ab-write-key',upstreams,origin:'https://gerencial.shrigma.com.br',fetchImpl});
  await forward({route:'tts-action',method:'GET',query:params('acao=capacidades'),user,credential:'backend-tts-write-key',upstreams,origin:'https://gerencial.shrigma.com.br',fetchImpl});
  await forward({route:'templates',method:'GET',query:params(`acao=operacao&idempotency_key=${K}&operacao=rascunho`),user,credential:'backend-template-key',upstreams,origin:'https://gerencial.shrigma.com.br',fetchImpl});
  assert.equal(headers[0]['X-AB-Write-Key'],'backend-ab-write-key');
  assert.equal(Object.hasOwn(headers[0],'Authorization'),false);
  assert.equal(headers[1]['X-TTS-Write-Key'],'backend-tts-write-key');
  assert.equal(Object.hasOwn(headers[1],'Authorization'),false);
  assert.equal(headers[2]['X-Template-Key'],'backend-template-key');
  assert.equal(headers[2].Authorization,'Bearer backend-template-key');
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
