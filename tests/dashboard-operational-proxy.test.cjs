'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {decide,validateUpstreams,forward,ProxyError,MAX_PRINT_RESPONSE}=require('../services/dashboard-operational/proxy.cjs');
const params=value=>new URLSearchParams(value);
const denied=fn=>assert.throws(fn,e=>e instanceof ProxyError&&e.status>=400&&e.status<500);
const U='123e4567-e89b-42d3-a456-426614174000',K='a'.repeat(32);

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

test('upstream configuration allows only exact trusted HTTPS hosts and routes',()=>{
  const hosts=['read.internal.example'];
  assert.equal(validateUpstreams({'crm-read':'https://read.internal.example/read'},hosts)['crm-read'].pathname,'/read');
  for(const bad of [
    {'crm-read':'http://read.internal.example/read'},
    {'crm-read':'https://evil.invalid/read'},
    {'crm-read':'https://read.internal.example@evil.invalid/read'},
    {'crm-read':'https://read.internal.example/read?to=evil'},
    {unknown:'https://read.internal.example/read'}
  ])assert.throws(()=>validateUpstreams(bad,hosts));
});

test('the gateway sends only the selected backend credential and rewrites trusted capabilities',async()=>{
  const upstreams=validateUpstreams({'crm-read':'https://read.internal.example/read'},['read.internal.example']);
  let called=0;
  const fetchImpl=async(url,options)=>{
    called++;
    assert.equal(url.href,'https://read.internal.example/read?action=cache_growth&painel=growth');
    assert.equal(options.headers.Authorization,'Bearer backend-individual-key');
    assert.equal(Object.hasOwn(options.headers,'Origin'),false);
    assert.equal(options.redirect,'manual');
    return new Response(JSON.stringify({capabilities:{endpoints:{read:'https://read.internal.example/read',evil:'https://evil.invalid'}}}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const result=await forward({route:'crm-read',method:'GET',query:params('action=cache_growth&painel=growth'),user:{role:'manager',areas:['growth']},credential:'backend-individual-key',upstreams,origin:'https://crm.shrigma.com.br',fetchImpl});
  assert.equal(called,1);
  assert.equal(result.body.capabilities.endpoints.read,'https://crm.shrigma.com.br/api/crm-read');
  assert.equal(Object.hasOwn(result.body.capabilities.endpoints,'evil'),false);
});

test('all seven dynamic CRM capabilities resolve to the same origin and unknown endpoints disappear',async()=>{
  const paths={templates:'/templates',campaigns:'/campaigns',segments:'/segments',campaign_audience:'/campaign-audience',ab_experiment:'/ab-experiments',journey_graph:'/journey-graph',journey_graph_lifecycle:'/journey-graph-lifecycle'};
  const source=Object.fromEntries(Object.entries(paths).map(([route,pathname])=>[route,'https://read.internal.example'+pathname]));
  const upstreams=validateUpstreams({'crm-read':'https://read.internal.example/read',...source},['read.internal.example']);
  const fetchImpl=async()=>new Response(JSON.stringify({capabilities:{endpoints:{...source,unrecognized:'https://unknown.invalid/private'}}}),{status:200,headers:{'Content-Type':'application/json'}});
  const result=await forward({route:'crm-read',method:'GET',query:params('action=cache_growth&painel=growth'),user:{role:'manager',areas:['growth']},credential:'backend-individual-key',upstreams,origin:'https://crm.shrigma.com.br',fetchImpl});
  assert.equal(result.status,200);
  assert.deepEqual(result.body.capabilities.endpoints,Object.fromEntries(Object.keys(paths).map(route=>[route,'https://crm.shrigma.com.br/api/'+route])));
});

test('body-key reads receive only their private key in the body, without browser credential or Origin',async()=>{
  const upstreams=validateUpstreams({'organico-links':'https://read.internal.example/links'},['read.internal.example']);
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
  const upstreams=validateUpstreams({ab:'https://read.internal.example/ab','tts-action':'https://read.internal.example/tts',templates:'https://read.internal.example/templates'},['read.internal.example']);
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
  const upstreams=validateUpstreams({ab_experiment:'https://comunicacao-crm-audience.tazdb8.easypanel.host/ab-experiments'},['comunicacao-crm-audience.tazdb8.easypanel.host']);
  const legacy=validateUpstreams({ab_experiment:'https://legacy.internal.example/ab-experiments'},['legacy.internal.example']);
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
  const upstreams=validateUpstreams({'candidaturas':'https://read.internal.example/candidates','crm-read':'https://read.internal.example/read'},['read.internal.example']);
  let called=0;
  const fetchImpl=async()=>{called++;return new Response('redirect',{status:302,headers:{Location:'https://evil.invalid'}});};
  await assert.rejects(forward({route:'crm-read',method:'GET',query:params('action=cache_growth&painel=growth'),user:{role:'manager',areas:['organico']},credential:'backend-individual-key',upstreams,origin:'https://crm.shrigma.com.br',fetchImpl}),e=>e.status===403);
  assert.equal(called,0);
  await assert.rejects(forward({route:'crm-read',method:'GET',query:params('action=cache_growth&painel=growth'),user:{role:'manager',areas:['growth']},credential:'backend-individual-key',upstreams,origin:'https://crm.shrigma.com.br',fetchImpl}),e=>e.code==='UPSTREAM_REDIRECT_DENIED');
});
